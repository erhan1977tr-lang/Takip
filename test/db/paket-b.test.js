// Paket B (karar 229) — fiyat listesiyle doğrudan profil siparişi, teslim bilgisi ve depo formu öncesi denetim; gerçek
// PostgreSQL. FGO'ya gerçek istek gitmez: sahte fetch + ağ koruması (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-paketb-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const { suggestNextNo } = await import('../../server/orders/create.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction } = await import('../../server/profile/transitions.js');
const { reservedLevels } = await import('../../server/profile/stock.js');
const { dayDate, earliestPickup, localDay } = await import('../../server/profile/dates.js');
const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { dispatchFgoJobs } = await import('../../server/profile/fgo-jobs.js');

let db;
const people = {};
let firm, plain, table;
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const run = (orderId, action, who, payload = {}) => runProfileAction(db, { orderId, action, actor: actor(people[who]), payload });
const pickDay = () => earliestPickup({ now: new Date(Date.now() + 5 * 60_000) });
const today = () => dayDate(localDay(new Date(), 'Europe/Bucharest'));
const FGO_SECRET = 'b'.repeat(40);

async function itemsOf(lines) {
  const products = await db.profileProduct.findMany({ where: { code: { in: lines.map((l) => l[0]) } }, include: { category: true } });
  const byCode = new Map(products.map((p) => [p.code, p.id]));
  const items = profileOrderItems(lines.map(([code, qty]) => ({ productId: byCode.get(code), qty })), products);
  assert.ok(items.ok);
  return items.items;
}
async function order(lines, { f = firm, who = 'cust', pickup = undefined, requestKey = null } = {}) {
  const next = await suggestNextNo(db, f.id, 'PROFILE_ORDER');
  return createProfileOrder(db, {
    actor: actor(people[who]), firm: f, title: null, requestedNo: next, suggestedNo: next, items: await itemsOf(lines),
    pickup: pickup === undefined ? { pickupDate: pickDay() } : pickup, requestKey,
  });
}
const load = (id) => db.order.findUniqueOrThrow({
  where: { id },
  include: { profile: true, price: true, events: { orderBy: { createdAt: 'asc' } }, offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
});

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Listeli Firma', prefix: 'LIS' } });
  plain = await db.customer.create({ data: { name: 'Listesiz Firma', prefix: 'NOL' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@paketb.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  await mk('plainCust', 'MUSTERI', plain.id, { canApprove: true });
  // Firmaya bağlı etkin fiyat tablosu: GK15 tablodan 9,90; SPIGOTI tabloda yok → katalog liste fiyatı 3,25
  await db.profileProduct.update({ where: { code: 'GK15' }, data: { listPrice: '12.50' } });
  await db.profileProduct.update({ where: { code: 'SPIGOTI' }, data: { listPrice: '3.25' } });
  const gk = await db.profileProduct.findUniqueOrThrow({ where: { code: 'GK15' } });
  table = await db.profilePriceTable.create({ data: { name: 'Listeli 2026', items: { create: [{ productId: gk.id, unitPrice: '9.90' }] } } });
  await db.customer.update({ where: { id: firm.id }, data: { profilePriceTableId: table.id } });
});
after(async () => {
  await closeDb();
  fs.rmSync(UPLOAD, { recursive: true, force: true });
});

dbTest('fiyat listesi yok: olağan akış (yönetici fiyatlandırması) — alış günü yok sayılır, doğrudan değil', offline(async () => {
  const r = await order([['GK15', 2]], { f: plain, who: 'plainCust' });
  assert.equal(r.direct, false);
  const o = await load(r.id);
  assert.deepEqual([o.status, o.profile.stage, o.profile.direct, o.profile.pickupDate, o.offers[0].status, o.price], ['YENI', 'FIYAT_BEKLIYOR', false, null, 'YONETIMDE', null]);
}));

dbTest('fiyat listesi var: sipariş DOĞRUDAN onaylı açılır — fiyatlar listeden (yoksa katalog), gönderilmiş teklif kopyası, tutar, alış günü; telefon / plaka boş; FGO açıksa tek proforma işi; stok rezervesine girer', offline(async () => {
  await saveFgoSettings(db, { enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 },
    { key: 'GIZLI', secret: FGO_SECRET }, actor(people.admin));
  const gk = await db.profileProduct.findUniqueOrThrow({ where: { code: 'GK15' } });
  const before = (await reservedLevels(db, [gk.id])).get(gk.id) ?? 0;
  const r = await order([['GK15', 4], ['SPIGOTI', 10]]);
  assert.equal(r.direct, true);
  const o = await load(r.id);
  assert.deepEqual([o.status, o.profile.stage, o.profile.direct, o.profile.contactPhone, o.profile.vehiclePlate], ['HAZIRLANIYOR', 'ONAYLANDI', true, null, null]);
  assert.equal(o.profile.pickupDate.toISOString().slice(0, 10), pickDay().toISOString().slice(0, 10));
  assert.equal(o.offers.length, 1);
  assert.deepEqual([o.offers[0].status, !!o.offers[0].sentAt, o.profile.approvedOfferId], ['GONDERILDI', true, o.offers[0].id]);
  assert.deepEqual(o.offers[0].lines.map((l) => [l.poz, Number(l.offerPrice)]), [['GK15', 9.9], ['SPIGOTI', 3.25]]);
  // 4 × 9,90 + 10 × 3,25 = 39,60 + 32,50 = 72,10
  assert.equal(String(o.offers[0].offerAmount), '72.1');
  assert.equal(String(o.price.amount), '72.1');
  assert.deepEqual(o.events.map((e) => e.event), ['CREATED', 'PROFILE_DIRECT']);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: r.id, type: 'FGO_PROFORMA', status: 'PENDING' } }), 1);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: r.id, type: 'ORDER_CREATED' } }), 1);
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: r.id, action: 'ORDER_CREATE' } });
  assert.equal(audit.details.direct, true);
  assert.equal(audit.details.priceTable, 'Listeli 2026');
  assert.equal((await reservedLevels(db, [gk.id])).get(gk.id), before + 4, 'doğrudan sipariş stok rezervesine girer');
  // FGO işçisi (sahte FGO): tek proforma; ikinci tur yeni belge kesmez
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    const form = Object.fromEntries(new URLSearchParams(init.body));
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: '7', Serie: form.Serie, Link: `https://fgo.example/${form.Serie}7.pdf` } }));
  };
  await db.customer.update({ where: { id: firm.id }, data: { taxId: '998877', regCom: 'J40/1/2020', county: 'Ilfov', city: 'Voluntari', address: 'Str. X 1', fxPolicy: 'BNR', fxMarkupPercent: null } });
  const ctx = { secret: FGO_SECRET, appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest', fetchImpl, bnrImpl: async () => ({ ok: true, rate: '4.9765', date: '2026-10-02', url: 'https://curs.bnr.ro/nbrfxrates.xml' }) };
  await dispatchFgoJobs(db, ctx);
  await dispatchFgoJobs(db, ctx);
  assert.equal(calls.filter((u) => u.endsWith('/factura/emitere')).length, 1, 'tek proforma');
  assert.equal(await db.fgoDocument.count({ where: { orderId: r.id, kind: 'PROFORMA' } }), 1);
  assert.equal(await db.fgoDocument.count({ where: { orderId: r.id, kind: 'INVOICE' } }), 0, 'proforma ile fatura karışmaz');
  assert.equal((await load(r.id)).profile.stage, 'PROFORMA');
  await saveFgoSettings(db, { enabled: false, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 }, {}, actor(people.admin));
}));

dbTest('aynı form anahtarı: çift tıklama / eşzamanlı gönderim ikinci sipariş ve ikinci proforma işi açmaz', offline(async () => {
  const key = 'paketb-anahtar-0123456789';
  const count = () => db.order.count({ where: { customerId: firm.id } });
  const n0 = await count();
  const [a, b] = await Promise.all([order([['GK15', 1]], { requestKey: key }), order([['GK15', 1]], { requestKey: key })]);
  assert.equal(a.id, b.id);
  assert.equal([a, b].filter((x) => x.duplicate).length, 1);
  const c = await order([['GK15', 1]], { requestKey: key });
  assert.equal(c.id, a.id);
  assert.equal(await count(), n0 + 1);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: a.id, type: 'ORDER_CREATED' } }), 1);
  // Başka firmanın anahtarı kullanılamaz (başka firmanın siparişi dönmez)
  assert.equal(await codeOf(order([['GK15', 1]], { f: plain, who: 'plainCust', requestKey: key })), 'NOT_ALLOWED');
}));

dbTest('doğrudan sipariş: alış günü zorunlu ve depo kuralına uymalı; geçersiz telefon reddedilir; hiçbir şey yazılmaz', offline(async () => {
  const n0 = await db.order.count({ where: { customerId: firm.id } });
  assert.equal(await codeOf(order([['GK15', 1]], { pickup: {} })), 'PICKUP_MISSING');
  assert.notEqual(await codeOf(order([['GK15', 1]], { pickup: { pickupDate: today() } })), 'OK', 'bugün depo kuralından erken');
  assert.equal(await codeOf(order([['GK15', 1]], { pickup: { pickupDate: pickDay(), phone: 'abc' } })), 'BAD_PHONE');
  assert.equal(await db.order.count({ where: { customerId: firm.id } }), n0);
}));

dbTest('fiyatı olmayan ürün ya da pasif liste: sipariş olağan akışa gider (fiyat uydurulmaz)', offline(async () => {
  await db.profileProduct.update({ where: { code: 'SPIGOTI' }, data: { listPrice: null } });
  const r = await order([['GK15', 1], ['SPIGOTI', 1]]);
  assert.equal(r.direct, false);
  assert.equal((await load(r.id)).profile.stage, 'FIYAT_BEKLIYOR');
  await db.profileProduct.update({ where: { code: 'SPIGOTI' }, data: { listPrice: '3.25' } });
  await db.profilePriceTable.update({ where: { id: table.id }, data: { isActive: false } });
  const r2 = await order([['GK15', 1]]);
  assert.equal(r2.direct, false);
  await db.profilePriceTable.update({ where: { id: table.id }, data: { isActive: true } });
}));

dbTest('teslim bilgisi eksik: ödeme kaydedilir ama depoya GİTMEZ (e-posta yok, stok düşülmez); elle gönderim reddedilir; müşteri tamamlayınca bir kez iletilir', offline(async () => {
  const r = await order([['GK15', 2]]);
  const day = today();
  const paid = await run(r.id, 'mark_paid', 'admin', { paidDate: day });
  assert.deepEqual(paid.result.pickupMissing, ['contactPhone', 'vehiclePlate']);
  let o = await load(r.id);
  assert.deepEqual([o.profile.stage, !!o.profile.paidAt, o.profile.stockDeducted], ['ONAYLANDI', true, false]);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: r.id, type: 'WAREHOUSE_EMAIL' } }), 0);
  const err = await run(r.id, 'send_to_warehouse', 'admin').catch((e) => e);
  assert.deepEqual([err.code, err.details?.fields], ['PICKUP_INFO_MISSING', ['contactPhone', 'vehiclePlate']]);
  // Müşteri yalnızca telefonu ekler: hâlâ eksik → gitmez
  await run(r.id, 'update_pickup', 'cust', { phone: '0723 000 000', plate: '' });
  assert.equal((await load(r.id)).profile.stage, 'ONAYLANDI');
  // Plaka da eklenince ödemesi alınmış sipariş depoya iletilir (tek depo e-postası, stok bir kez düşülür)
  const fwd = await run(r.id, 'update_pickup', 'cust', { plate: 'b 12 abc' });
  assert.equal(fwd.result.forwarded, true);
  o = await load(r.id);
  assert.deepEqual([o.profile.stage, o.profile.vehiclePlate, o.profile.stockDeducted], ['DEPODA', 'B 12 ABC', true]);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: r.id, type: 'WAREHOUSE_EMAIL' } }), 1);
  assert.equal(await db.stockMovement.count({ where: { orderId: r.id } }), 1);
  // Depodaki siparişte müşteri artık değiştiremez
  assert.equal(await codeOf(run(r.id, 'update_pickup', 'cust', { phone: '0723 111 111' })), 'NOT_ALLOWED');
}));

dbTest('son gün kuralı: müşteri alış gününden bir gün öncesine kadar değiştirir; alış günü geldiyse değiştiremez (yönetici değiştirebilir); başka firma hiç erişemez', offline(async () => {
  const r = await order([['GK15', 1]]);
  await db.profileOrder.update({ where: { orderId: r.id }, data: { pickupDate: today() } });
  assert.equal(await codeOf(run(r.id, 'update_pickup', 'cust', { phone: '0723 222 222' })), 'PICKUP_DEADLINE');
  assert.equal((await load(r.id)).profile.contactPhone, null);
  await run(r.id, 'update_pickup', 'admin', { phone: '0723 222 222' });
  assert.equal((await load(r.id)).profile.contactPhone, '0723 222 222');
  assert.equal(await codeOf(run(r.id, 'update_pickup', 'plainCust', { phone: '0723 333 333' })), 'NOT_FOUND');
}));
