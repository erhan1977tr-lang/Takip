// 3.93.0 regresyon düzeltmeleri (karar 288) — iptal ve yükleme tutarlılığı, gerçek PostgreSQL ile:
//   Y1  cam "İptal et" mali / yükleme kilitlerini atlamaz (belge, bekleyen iş, onaylı yükleme, elle ödeme; sipariş değişmez)
//   Y2  profil iptali: teslimden önce; proforma tek başına engel değil; teslim / tahsilat / avans / bekleyen FGO işi engeller;
//       stok bir kez ve net düşüm kadar geri eklenir; iptal edilen siparişin proforması alacağa borç olarak girmez
//   D3  bekleyen telafi kararı iptal / silinmiş kaynak siparişte onaylanmaz
//   O1  "Yüklendi" onaylı yükleme gününün sandıklarını taşımaz, misafir yerleşimini silmez, yanıltıcı bildirim göndermez
//   D1  tahmini yükleme tarihi değişikliği ile yükleme onayı aynı kilidi kullanır (ikisi birden geçmez)
//   D15 onay yetkisi olmayan müşteri kullanıcısı teslim bilgisini değiştiremez
// Gerçek dış istek YOK (offline: her ağ çağrısı testi düşürür); FGO kapalı, belgeler doğrudan kayıt olarak yazılır.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-r393-iptal-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const { createGlassOrder, suggestNextNo } = await import('../../server/orders/create.js');
const { runOrderAction } = await import('../../server/orders/transitions.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction } = await import('../../server/profile/transitions.js');
const { stockLevels, addStockMovement } = await import('../../server/profile/stock.js');
const { earliestPickup } = await import('../../server/profile/dates.js');
const { confirmLoading, previewLoading } = await import('../../server/loading/confirmation.js');
const { listDocuments, receivables } = await import('../../server/accounting/receivables.js');
const { decideCompensation } = await import('../../server/orders/compensation.js');

let db, firm, other;
const people = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(people[who]), payload });
const prun = (orderId, action, who, payload = {}) => runProfileAction(db, { orderId, action, actor: actor(people[who]), payload });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const errOf = async (p) => p.then(() => null, (e) => e);
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const pickDay = () => earliestPickup({ now: new Date(Date.now() + 5 * 60_000) });
let fileNo = 0;

// ---------- cam ----------
const glass = (extra = {}) => ({ description: 'Cam', poz: null, enMm: 1000, boyMm: 500, adet: 2, unit: 'm2', unitPrice: '40.00', kind: 'CAM', free: false, ...extra });
const latest = async (orderId) => db.offer.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
const adminForm = (lines, price) => lines.map((l) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  crateFee: l.crateFee, unitPrice: Number(l.unitPrice).toFixed(2), offerPrice: price,
}));
async function sentOrder(f = firm, title = 'Cam') {
  const next = await suggestNextNo(db, f.id);
  fileNo += 1;
  const o = await createGlassOrder(db, {
    actor: actor(f.id === firm.id ? people.cust : people.other), firm: f, title, requestedNo: next, suggestedNo: next,
    items: [{ glassName: '8mm Temperli', camAdedi: 2 }],
    files: [{ storageKey: `2026/10/r393-${fileNo}.pdf`, name: `r393-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
  await run(o.id, 'no_drawing', 'sales');
  await run(o.id, 'submit_offer', 'sales', { lines: [glass()] });
  await run(o.id, 'approve_offer', 'admin', { lines: adminForm((await latest(o.id)).lines, '50') });
  return db.order.findUniqueOrThrow({ where: { id: o.id } });
}
const unchanged = async (o) => {
  const fresh = await db.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.deepEqual([fresh.status, fresh.version], [o.status, o.version], 'sipariş değişmedi');
  assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'CANCELLED' } }), 0);
};

// ---------- profil ----------
async function profileOrder(lines) {
  const products = await db.profileProduct.findMany({ where: { code: { in: lines.map((l) => l[0]) } }, include: { category: true } });
  const byCode = new Map(products.map((p) => [p.code, p.id]));
  const items = profileOrderItems(lines.map(([code, qty]) => ({ productId: byCode.get(code), qty })), products);
  assert.ok(items.ok);
  const next = await suggestNextNo(db, firm.id, 'PROFILE_ORDER');
  const { id } = await createProfileOrder(db, { actor: actor(people.cust), firm, title: null, requestedNo: next, suggestedNo: next, items: items.items });
  let o = await db.order.findUniqueOrThrow({ where: { id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });
  await prun(id, 'send_profile_offer', 'admin', { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '10' })) });
  o = await db.order.findUniqueOrThrow({ where: { id }, include: { offers: { orderBy: { createdAt: 'desc' } } } });
  await prun(id, 'approve_profile_offer', 'cust', { offerId: o.offers[0].id, pickupDate: pickDay(), phone: '0723000000', plate: 'B 1 ABC' });
  return id;
}
const prod = (code) => db.profileProduct.findUniqueOrThrow({ where: { code } });
const level = async (code) => { const p = await prod(code); return (await stockLevels(db, [p.id])).get(p.id) ?? 0; };

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA' } });
  other = await db.customer.create({ data: { name: 'Alegrad', prefix: 'ALE' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@r393.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('assistant', 'YONETICI_YARDIMCISI', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  await mk('viewer', 'MUSTERI', firm.id, { canApprove: false });
  await mk('other', 'MUSTERI', other.id, { canApprove: true });
});
after(async () => {
  await closeDb();
  fs.rmSync(UPLOAD, { recursive: true, force: true });
});

// ================================================================= Y1

dbTest('Y1: cam siparişi FGO belgesi, bekleyen belge isteği, onaylı yükleme ya da elle ödeme varken iptal edilemez (CANCEL_LOCKED + gerekçe); sipariş değişmez', offline(async () => {
  // a) Siparişin kendi FGO belgesi
  const a = await sentOrder();
  await db.fgoDocument.create({ data: { orderId: a.id, kind: 'PROFORMA', series: 'PRF', number: '9301', issuedAt: new Date() } });
  let e = await errOf(run(a.id, 'cancel', 'admin', { note: 'Vazgeçildi' }));
  assert.deepEqual([e?.code, e?.details?.reasons], ['CANCEL_LOCKED', [{ code: 'FGO_DOCUMENT', kind: 'PROFORMA', ref: 'PRF9301' }]]);
  await unchanged(a);
  // b) Kuyrukta bekleyen belge isteği: iş kalıcı FAILED'e düşürülmez, sipariş değişmez
  const b = await sentOrder();
  const job = await db.notificationOutbox.create({ data: { type: 'FGO_GLASS', orderId: b.id, payload: { kind: 'PROFORMA' } } });
  e = await errOf(run(b.id, 'cancel', 'assistant', { note: 'x' }));
  assert.deepEqual([e?.code, e?.details?.reasons], ['CANCEL_LOCKED', [{ code: 'PENDING_DOCUMENT', kind: null, ref: null }]]);
  await unchanged(b);
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } })).status, 'PENDING');
  // c) Onaylı yükleme (yüklenmiş mal faturalanabilir kalmalı)
  const c = await sentOrder();
  const day = dayOf(-6);
  await db.order.update({ where: { id: c.id }, data: { estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
  assert.equal((await confirmLoading(db, { day, key: (await previewLoading(db, day)).key, actor: actor(people.admin) })).ok, true);
  const cc = await db.order.findUniqueOrThrow({ where: { id: c.id } });
  e = await errOf(run(c.id, 'cancel', 'admin', { note: 'x' }));
  assert.deepEqual([e?.code, e?.details?.reasons], ['CANCEL_LOCKED', [{ code: 'CONFIRMED_LOADING', ref: day }]]);
  await unchanged(cc);
  // d) Elle ödeme kaydı (proforması FGO'da kesilmiş — iki neden de görünür)
  const d = await sentOrder();
  await db.fgoDocument.create({ data: { orderId: d.id, kind: 'PROFORMA', series: 'PRF', number: '9302', issuedAt: new Date() } });
  await db.manualPayment.create({ data: { orderId: d.id, customerId: firm.id, proformaRef: 'PRF9302', paidOn: new Date(), amount: '10', currency: 'EUR', method: 'BANK_TRANSFER', ron: '50', rate: '5', requestKey: 'r393-pay-000000001', createdById: people.admin.id } });
  e = await errOf(run(d.id, 'cancel', 'admin', { note: 'x' }));
  assert.equal(e?.code, 'CANCEL_LOCKED');
  assert.deepEqual(e.details.reasons.map((r) => r.code), ['FGO_DOCUMENT', 'MANUAL_PAYMENT']);
  // e) Temiz sipariş: iptal olağan; satış iptal edemez (karar 3)
  const ok = await sentOrder();
  assert.equal(await codeOf(run(ok.id, 'cancel', 'sales', { note: 'x' })), 'NOT_ALLOWED');
  await run(ok.id, 'cancel', 'admin', { note: 'Müşteri vazgeçti' });
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: ok.id } })).status, 'IPTAL');
  // Engellenen denemeler hiçbir sipariş olayı / iptal denetimi yazmadı
  assert.equal(await db.auditLog.count({ where: { action: 'ORDER_TRANSITION', entityId: { in: [a.id, b.id, c.id, d.id] }, details: { path: ['action'], equals: 'cancel' } } }), 0);
}));

dbTest('Y1: iptal ile belge isteği / yükleme onayı aynı anda — biri kazanır, ikisi birden geçmez (kilitlenme yok)', offline(async () => {
  for (let i = 0; i < 3; i++) {
    const o = await sentOrder();
    const day = dayOf(-10 - i);
    await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
    const key = (await previewLoading(db, day)).key;
    const [cancel, conf] = await Promise.all([
      codeOf(run(o.id, 'cancel', 'admin', { note: 'yarış' })),
      confirmLoading(db, { day, key, actor: actor(people.admin) }),
    ]);
    const status = (await db.order.findUniqueOrThrow({ where: { id: o.id } })).status;
    const items = await db.loadingConfirmationItem.count({ where: { orderId: o.id } });
    assert.ok(!(status === 'IPTAL' && items > 0), `iptal edilmiş siparişin onaylı yüklemesi olamaz (iptal ${cancel}, onay ${conf.ok ? 'ok' : conf.code})`);
  }
}));

// ================================================================= Y2

dbTest('Y2: teslim edilmiş profil siparişi iptal edilemez; teslim edilen mal stoğa geri yazılmaz', offline(async () => {
  const id = await profileOrder([['AD45', 4]]);
  await prun(id, 'mark_proforma', 'admin', { proformaNo: 'PF-Y2' });
  await prun(id, 'send_to_warehouse', 'admin');
  await prun(id, 'mark_delivered', 'admin');
  const before = await level('AD45');
  const code = await codeOf(prun(id, 'cancel', 'admin', { note: 'geç iptal' }));
  assert.ok(['NOT_ALLOWED', 'CANCEL_LOCKED'].includes(code), code);
  assert.equal(await level('AD45'), before, 'sahte stok iadesi yok');
  assert.equal(await db.stockMovement.count({ where: { orderId: id, kind: 'IADE' } }), 0);
  assert.notEqual((await db.order.findUniqueOrThrow({ where: { id } })).status, 'IPTAL');
}));

dbTest('Y2: tahsilat (ödeme alındı / FGO tahsilatı / elle ödeme), avans faturası ya da bekleyen FGO işi profil iptalini engeller (gerekçe gösterilir)', offline(async () => {
  // Ödeme alındı → sipariş depoya gitti, stok düştü
  const paid = await profileOrder([['GK15', 2]]);
  await prun(paid, 'mark_proforma', 'admin', { proformaNo: 'PF-P' });
  await prun(paid, 'mark_paid', 'admin', { paidDate: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) });
  const before = await level('GK15');
  let e = await errOf(prun(paid, 'cancel', 'admin', { note: 'x' }));
  assert.deepEqual([e?.code, e?.details?.reasons?.map((r) => r.code)], ['CANCEL_LOCKED', ['PAYMENT']]);
  assert.equal(await level('GK15'), before);
  // FGO'nun gösterdiği tahsilat (proforma kısmen ödenmiş)
  const fgoPaid = await profileOrder([['GK15', 1]]);
  await db.fgoDocument.create({ data: { orderId: fgoPaid, kind: 'PROFORMA', series: 'PRF', number: '9311', issuedAt: new Date(), total: '100', paid: '20' } });
  e = await errOf(prun(fgoPaid, 'cancel', 'admin', { note: 'x' }));
  assert.deepEqual([e?.code, e?.details?.reasons?.map((r) => r.code)], ['CANCEL_LOCKED', ['PAYMENT']]);
  // Elle ödeme kaydı (iptal edilmemiş)
  const manual = await profileOrder([['GK15', 1]]);
  await db.fgoDocument.create({ data: { orderId: manual, kind: 'PROFORMA', series: 'PRF', number: '9312', issuedAt: new Date(), total: '100', paid: '0' } });
  const pay = await db.manualPayment.create({ data: { orderId: manual, customerId: firm.id, proformaRef: 'PRF9312', paidOn: new Date(), amount: '5', currency: 'EUR', method: 'CASH', ron: '25', rate: '5', requestKey: 'r393-pay-000000002', createdById: people.admin.id } });
  e = await errOf(prun(manual, 'cancel', 'admin', { note: 'x' }));
  assert.deepEqual([e?.code, e?.details?.reasons?.map((r) => r.code)], ['CANCEL_LOCKED', ['MANUAL_PAYMENT']]);
  // Elle ödeme iptal edildiyse tahsilat yoktur → iptal olur (proforma tek başına engel değil)
  await db.manualPayment.update({ where: { id: pay.id }, data: { voidedAt: new Date(), voidedById: people.admin.id, voidReason: 'yanlış kayıt' } });
  await prun(manual, 'cancel', 'admin', { note: 'Vazgeçildi' });
  // Avans faturası
  const adv = await profileOrder([['GK15', 1]]);
  await db.fgoDocument.create({ data: { orderId: adv, kind: 'ADVANCE', series: 'GKH', number: '9313', issuedAt: new Date(), total: '20', paid: '0', advanced: '20' } });
  e = await errOf(prun(adv, 'cancel', 'admin', { note: 'x' }));
  assert.equal(e?.code, 'CANCEL_LOCKED');
  assert.ok(e.details.reasons.some((r) => r.code === 'FGO_DOCUMENT' && r.kind === 'ADVANCE'));
  // Bekleyen FGO işi (proforma kuyrukta): sonuçlanmadan iptal yok
  const busy = await profileOrder([['GK15', 1]]);
  await db.notificationOutbox.create({ data: { type: 'FGO_PROFORMA', orderId: busy, payload: {} } });
  e = await errOf(prun(busy, 'cancel', 'admin', { note: 'x' }));
  assert.deepEqual([e?.code, e?.details?.reasons?.map((r) => r.code)], ['CANCEL_LOCKED', ['PENDING_DOCUMENT']]);
}));

dbTest('Y2: proforması kesilmiş, depoya gitmiş, ödenmemiş profil siparişi iptal edilir: stok net düşüm kadar BİR kez geri eklenir, FGO belgesi değişmez, alacağa borç olarak girmez', offline(async () => {
  const p = await prod('PANA-90-12');
  await addStockMovement(db, { productId: p.id, kind: 'GIRIS', qty: 30 }, actor(people.admin));
  const s0 = await level('PANA-90-12');
  const id = await profileOrder([['PANA-90-12', 7]]);
  const doc = await db.fgoDocument.create({ data: { orderId: id, kind: 'PROFORMA', series: 'PRF', number: '9321', issuedAt: new Date(), total: '84.70', paid: '0' } });
  await db.profileOrder.update({ where: { orderId: id }, data: { stage: 'PROFORMA', proformaNo: 'PRF9321', proformaAt: new Date() } });
  await prun(id, 'send_to_warehouse', 'admin');
  assert.equal(await level('PANA-90-12'), s0 - 7);
  // Eşzamanlı iki iptal: biri geçer, öbürü reddedilir; tek iade
  const r = await Promise.allSettled([prun(id, 'cancel', 'admin', { note: 'Vazgeçildi' }), prun(id, 'cancel', 'assistant', { note: 'Vazgeçildi' })]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(await level('PANA-90-12'), s0, 'stok tam geri geldi');
  assert.equal(await db.stockMovement.count({ where: { orderId: id, kind: 'IADE' } }), 1);
  assert.equal(await codeOf(prun(id, 'cancel', 'admin', { note: 'tekrar' })), 'NOT_ALLOWED');
  assert.equal(await level('PANA-90-12'), s0, 'ikinci iade yok');
  // FGO belgesi silinmez / değişmez (FGO'ya hiçbir istek gitmedi — offline)
  assert.deepEqual(await db.fgoDocument.findUniqueOrThrow({ where: { id: doc.id } }), doc);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_TRANSITION', entityId: id, details: { path: ['action'], equals: 'cancel' } } });
  assert.equal(audit.userId === people.admin.id || audit.userId === people.assistant.id, true);
  // Alacak: iptal edilen siparişin (tahsilatsız) proforması borç sayılmaz
  const docs = await listDocuments(db, 'PROFILE_ORDER');
  const share = receivables(docs).shares.get(doc.id);
  assert.deepEqual([share.debt, share.rest], [0, 0]);
}));

// ================================================================= D3

dbTest('D3: bekleyen telafi kararı, kaynak sipariş sonradan iptal / silinmişse onaylanmaz (ret serbest)', offline(async () => {
  const src = await sentOrder(firm, 'Kaynak');
  const dest = await sentOrder(firm, 'Hedef');
  const offer = await latest(src.id);
  const line = offer.lines[0];
  const mk = (key) => db.compensation.create({
    data: {
      requestKey: key, status: 'PENDING', sourceOrderId: src.id, sourceOfferId: offer.id, sourceLineId: line.id, customerId: firm.id, description: 'Cam', quantity: 1, currency: 'EUR',
      priceMode: 'CUSTOM', priceTier: 'SALES', normalCost: '40', normalPrice: null, unitCost: '40', offerPrice: null, destType: 'EXISTING', destOrderId: dest.id, createdById: people.sales.id,
    },
  });
  const c1 = await mk('r393-comp-000000001');
  await db.order.update({ where: { id: src.id }, data: { status: 'IPTAL' } });
  assert.deepEqual(await decideCompensation(db, { id: c1.id, approve: true, price: '55', actor: actor(people.admin) }), { ok: false, code: 'ORDER_CANCELLED' });
  assert.equal((await db.compensation.findUniqueOrThrow({ where: { id: c1.id } })).status, 'PENDING');
  assert.equal(await db.offer.count({ where: { orderId: dest.id } }), 1, 'hedefin teklifi değişmedi');
  const rej = await decideCompensation(db, { id: c1.id, approve: false, actor: actor(people.admin) });
  assert.equal(rej.ok, true);
}));

// ================================================================= O1 / D1

dbTest('O1: onaylı yüklemesi olan siparişte "Yüklendi" sandıkları başka güne taşımaz, misafir yerleşimini silmez, sandık bildirimi göndermez', offline(async () => {
  const o = await sentOrder(firm, 'Onaylı yükleme');
  const day = dayOf(-3);
  await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
  // Kendi sandığı + başka firmanın sandığında fiziksel yerleşim (karar 124)
  const own = await db.crate.create({ data: { shipDay: new Date(`${day}T00:00:00Z`), customerId: firm.id, crateNo: 31, orders: { create: { orderId: o.id } } } });
  const host = await db.crate.create({ data: { shipDay: new Date(`${day}T00:00:00Z`), customerId: other.id, crateNo: 32, orders: { create: { orderId: o.id } } } });
  await db.order.update({ where: { id: o.id }, data: { guestHostId: other.id } });
  assert.equal((await confirmLoading(db, { day, key: (await previewLoading(db, day)).key, actor: actor(people.admin) })).ok, true);
  const outbox = await db.notificationOutbox.count();
  await run(o.id, 'mark_shipped', 'sales');
  const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.equal(after.status, 'YUKLENDI');
  assert.equal(after.actualShipDate.toISOString().slice(0, 10), day, 'fiili gün = onaylı yükleme günü');
  assert.equal(after.guestHostId, other.id, 'misafir ev sahibi korunur');
  for (const c of [own, host]) {
    const x = await db.crate.findUniqueOrThrow({ where: { id: c.id }, include: { orders: true } });
    assert.deepEqual([x.shipDay.toISOString().slice(0, 10), x.crateNo, x.orders.map((r) => r.orderId)], [day, c.crateNo, [o.id]], `sandık #${c.crateNo}`);
  }
  assert.equal(await db.notificationOutbox.count({ where: { type: { in: ['GUEST_CRATE_REMOVED', 'GUEST_CRATE_ASSIGNED'] }, orderId: o.id } }), 0, 'yanıltıcı sandık bildirimi yok');
  assert.ok((await db.notificationOutbox.count()) >= outbox);
}));

dbTest('D1: tahmini yükleme tarihi değişikliği ile yükleme onayı aynı anda — ikisi birden geçmez (onaylı yükleme kalemi varken tarih değişmez)', offline(async () => {
  for (let i = 0; i < 4; i++) {
    const o = await sentOrder();
    const day = dayOf(-20 - i);
    await db.order.update({ where: { id: o.id }, data: { estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
    const fresh = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    const key = (await previewLoading(db, day)).key;
    const [moved, conf] = await Promise.all([
      codeOf(run(o.id, 'set_ship_date', 'sales', { date: new Date(`${dayOf(5)}T12:00:00Z`), expectedVersion: fresh.version })),
      confirmLoading(db, { day, key, actor: actor(people.admin) }),
    ]);
    const items = await db.loadingConfirmationItem.count({ where: { orderId: o.id } });
    assert.ok(!(moved === 'OK' && items > 0), `ikisi birden geçti (tarih ${moved}, onay ${conf.ok ? 'ok' : conf.code})`);
  }
}));

// ================================================================= D15

dbTest('D15: onay yetkisi olmayan müşteri kullanıcısı teslim bilgisini değiştiremez (sunucu); yetkili kullanıcı değiştirir', offline(async () => {
  const id = await profileOrder([['GK15', 1]]);
  assert.equal(await codeOf(prun(id, 'update_pickup', 'viewer', { pickupDate: pickDay(), phone: '0700111222', plate: 'B 9 XYZ' })), 'NOT_ALLOWED');
  const p = await db.profileOrder.findUniqueOrThrow({ where: { orderId: id } });
  assert.equal(p.plate, 'B 1 ABC');
  assert.equal(await codeOf(prun(id, 'update_pickup', 'cust', { pickupDate: pickDay(), phone: '0700111222', plate: 'B 9 XYZ' })), 'OK');
}));
