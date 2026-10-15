// Profil siparişi silme ve otomatik stok iadesi (3.86.0, karar 281) — gerçek PostgreSQL ile: yetki (yalnızca yönetici ve
// yönetici yardımcısı), FGO doğrulaması (yoksa / başarısızsa silinmez, hiçbir şey değişmez), mali engel (proforma, FGO belgesi,
// kuyrukta belge, teslim), stok iadesi (gerçek hareketlerden NET düşüm; düşülmemiş miktar iade edilmez), tekrar ve eşzamanlı
// silme (ikinci iade yok), hata → tümü geri alınır, geri yükleme kuralı. FGO'ya gerçek istek YOK (sahte doğrulama / fetchImpl).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-profil-sil-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const { suggestNextNo } = await import('../../server/orders/create.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction } = await import('../../server/profile/transitions.js');
const { dispatchWarehouseEmails } = await import('../../server/profile/warehouse.js');
const { reservedLevels, stockLevels } = await import('../../server/profile/stock.js');
const { earliestPickup } = await import('../../server/profile/dates.js');
const { orderScope } = await import('../../server/orders/scope.js');
const { removalPreview, removeOrder, restoreOrder, verifyFgoForRemoval } = await import('../../server/orders/removal.js');
const { saveFgoSettings } = await import('../../server/integrations/fgo.js');

const SECRET = 'test-secret-profil-silme-0123456789abcdef';
const pickDay = () => earliestPickup({ now: new Date(Date.now() + 5 * 60_000) });
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runProfileAction(db, { orderId, action, actor: actor(people[who]), payload });
const FGO_OK = async () => ({ ok: true, at: new Date() });
let db, firm, GK, AD;
const people = {};

async function newOrder(lines) {
  const products = await db.profileProduct.findMany({ where: { code: { in: lines.map((l) => l[0]) } }, include: { category: true } });
  const byCode = new Map(products.map((p) => [p.code, p.id]));
  const items = profileOrderItems(lines.map(([code, qty]) => ({ productId: byCode.get(code), qty })), products);
  assert.ok(items.ok);
  const next = await suggestNextNo(db, firm.id, 'PROFILE_ORDER');
  return createProfileOrder(db, { actor: actor(people.cust), firm, title: null, requestedNo: next, suggestedNo: next, items: items.items });
}
const load = (id) => db.order.findUniqueOrThrow({ where: { id }, include: { profile: true, offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });
/** Teklif → müşteri onayı (alış bilgisiyle) */
async function approved(lines) {
  const { id } = await newOrder(lines);
  let o = await load(id);
  await run(id, 'send_profile_offer', 'admin', { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '10' })) });
  o = await load(id);
  await run(id, 'approve_profile_offer', 'cust', { offerId: o.offers[0].id, pickupDate: pickDay(), phone: '0723000000', plate: 'B 1 ABC' });
  return id;
}
/** Depoya gönderilmiş (stoktan düşülmüş, ödeme / proforma yok) sipariş; depo e-postası gönderilmiş */
async function inWarehouse(lines) {
  const id = await approved(lines);
  await run(id, 'send_to_warehouse', 'admin');
  await dispatchWarehouseEmails(db, { transport: { sendMail: async () => ({}) }, from: 'x@test', appUrl: 'https://takip.test' });
  return id;
}
const levels = async () => { const m = await stockLevels(db, [GK.id, AD.id]); return [m.get(GK.id) ?? 0, m.get(AD.id) ?? 0]; };
const moves = (orderId, kind) => db.stockMovement.count({ where: { orderId, ...(kind ? { kind } : {}) } });
const remove = (id, who, extra = {}) => load(id).then((o) => removeOrder(db, { orderId: id, confirmNo: o.orderNo, actor: actor(people[who]), fgoCheck: FGO_OK, ...extra }));

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@profil-sil.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } }).then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('assistant', 'YONETICI_YARDIMCISI', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  GK = await db.profileProduct.findUniqueOrThrow({ where: { code: 'GK15' } });
  AD = await db.profileProduct.findUniqueOrThrow({ where: { code: 'AD45' } });
  // Başlangıç stoğu (test veritabanı): 100 + 100
  await db.stockMovement.createMany({ data: [{ productId: GK.id, qty: 100, kind: 'GIRIS', createdById: people.admin.id }, { productId: AD.id, qty: 100, kind: 'GIRIS', createdById: people.admin.id }] });
});
after(async () => {
  await closeDb();
  fs.rmSync(UPLOAD, { recursive: true, force: true });
});

dbTest('profil silme: yalnızca yönetici ve yönetici yardımcısı; diğer roller sunucuda reddedilir, hiçbir şey değişmez', offline(async () => {
  const id = await inWarehouse([['GK15', 3]]);
  const before = await levels();
  let calls = 0;
  for (const who of ['sales', 'drawer', 'inspector', 'cust']) {
    const r = await remove(id, who, { fgoCheck: async () => { calls++; return { ok: true }; } });
    assert.deepEqual(r, { ok: false, code: 'FORBIDDEN' }, who);
  }
  assert.equal(calls, 0, 'yetkisiz istekte FGO bile sorulmaz');
  assert.deepEqual(await levels(), before);
  assert.equal((await load(id)).removedAt, null);
  // Yanlış numara: FGO sorulmadan reddedilir
  const r = await removeOrder(db, { orderId: id, confirmNo: 'YANLIS', actor: actor(people.admin), fgoCheck: async () => { calls++; return { ok: true }; } });
  assert.deepEqual(r, { ok: false, code: 'CONFIRM_REQUIRED' });
  assert.equal(calls, 0);
}));

dbTest('profil silme: FGO doğrulanamazsa (yok / başarısız / hata) silinmez; stok ve sipariş değişmez; denemeler denetimde', offline(async () => {
  const id = await inWarehouse([['GK15', 2], ['AD45', 1]]);
  const before = await levels();
  for (const fgoCheck of [null, async () => ({ ok: false, code: 'FGO_UNREACHABLE' }), async () => { throw new Error('ağ'); }]) {
    const r = await remove(id, 'admin', { fgoCheck });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'FGO_UNVERIFIED');
  }
  assert.deepEqual(await levels(), before);
  const o = await load(id);
  assert.equal(o.removedAt, null);
  assert.equal(o.profile.stockDeducted, true);
  assert.equal(await moves(id, 'IADE'), 0);
  const blocked = await db.auditLog.findMany({ where: { entityId: id, action: 'ORDER_REMOVE_BLOCKED' } });
  assert.equal(blocked.length, 3);
  assert.equal(blocked[0].details.reasons[0].code, 'FGO_UNVERIFIED');
}));

dbTest('profil silme: depoya gitmiş sipariş — gerçekten düşülen stok aynı işlemde geri eklenir; geçmiş, hareketler ve denetim korunur', offline(async () => {
  const s0 = await levels();
  const id = await inWarehouse([['GK15', 3], ['AD45', 2]]);
  assert.deepEqual(await levels(), [s0[0] - 3, s0[1] - 2], 'depoya gönderilince düşüldü');
  const statusBefore = (await load(id)).status;
  const preview = await removalPreview(db, id);
  assert.equal(preview.profile, true);
  assert.deepEqual(preview.reasons, []);
  assert.deepEqual(preview.stockReturn.map((s) => [s.code, s.qty]).sort(), [['AD45', 2], ['GK15', 3]]);
  const r = await remove(id, 'assistant');
  assert.equal(r.ok, true, r.code);
  assert.deepEqual(r.stockReturned.map((s) => [s.code, s.qty]).sort(), [['AD45', 2], ['GK15', 3]]);
  assert.deepEqual(await levels(), s0, 'stok eski hâline döndü');
  // Hareketler silinmez: 2 çıkış + 2 iade
  assert.equal(await moves(id, 'CIKIS'), 2);
  assert.equal(await moves(id, 'IADE'), 2);
  const o = await load(id);
  assert.ok(o.removedAt);
  assert.equal(o.status, 'IPTAL');
  assert.equal(o.removedStatus, statusBefore);
  assert.equal(o.profile.stockDeducted, false);
  assert.equal(o.profile.depotTokenHash, null);
  assert.equal(o.offers.length, 1, 'teklif korunur');
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: id, action: 'ORDER_REMOVED' } });
  assert.equal(audit.userId, people.assistant.id);
  assert.ok(audit.details.fgoVerifiedAt);
  assert.deepEqual(audit.details.stockReturned.map((s) => [s.code, s.qty]).sort(), [['AD45', 2], ['GK15', 3]]);
  assert.equal(await db.orderEvent.count({ where: { orderId: id, event: 'REMOVED' } }), 1);
  // Olağan listelerden ve rezerveden çıkar
  assert.equal(await db.order.count({ where: { id, ...orderScope(people.admin) } }), 0);
  assert.equal((await reservedLevels(db, [GK.id])).get(GK.id) ?? 0, 0);
  // Tekrar: ikinci kez silinmez, ikinci iade yok
  assert.deepEqual(await remove(id, 'admin'), { ok: false, code: 'ALREADY_REMOVED' });
  assert.equal(await moves(id, 'IADE'), 2);
  // Stoğu iade edilmiş silinmiş sipariş geri yüklenmez (stok yeniden düşülmeden açılmaz)
  assert.equal((await restoreOrder(db, { orderId: id, actor: actor(people.admin) })).code, 'STOCK_RETURNED');
  assert.ok((await load(id)).removedAt);
}));

dbTest('profil silme: stoktan düşülmemiş sipariş — iade yok, stok değişmez; geri yüklenebilir', offline(async () => {
  const id = await approved([['GK15', 4]]);
  const before = await levels();
  assert.deepEqual((await removalPreview(db, id)).stockReturn, []);
  const r = await remove(id, 'admin');
  assert.equal(r.ok, true, r.code);
  assert.deepEqual(r.stockReturned, []);
  assert.deepEqual(await levels(), before);
  assert.equal(await moves(id), 0);
  const back = await restoreOrder(db, { orderId: id, actor: actor(people.admin) });
  assert.equal(back.ok, true, back.code);
}));

dbTest('profil silme: iptal edilip stoğu zaten iade edilmiş sipariş silinince ikinci iade oluşmaz', offline(async () => {
  const s0 = await levels();
  const id = await inWarehouse([['AD45', 5]]);
  await run(id, 'cancel', 'admin', { note: 'Vazgeçildi' });
  assert.deepEqual(await levels(), s0);
  const r = await remove(id, 'admin');
  assert.equal(r.ok, true, r.code);
  assert.deepEqual(r.stockReturned, []);
  assert.deepEqual(await levels(), s0);
  assert.equal(await moves(id, 'IADE'), 1, 'yalnızca iptalin iadesi');
}));

dbTest('profil silme: eşzamanlı iki istek — biri siler, diğeri reddedilir; tek iade', offline(async () => {
  const s0 = await levels();
  const id = await inWarehouse([['GK15', 6]]);
  const results = await Promise.all([remove(id, 'admin'), remove(id, 'assistant'), remove(id, 'admin')]);
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'ALREADY_REMOVED'));
  assert.equal(await moves(id, 'IADE'), 1);
  assert.deepEqual(await levels(), s0);
  assert.equal(await db.auditLog.count({ where: { entityId: id, action: 'ORDER_REMOVED' } }), 1);
}));

dbTest('profil silme: işlem içinde hata → tümü geri alınır (iade, silme işareti, denetim yok)', offline(async () => {
  const id = await inWarehouse([['GK15', 2]]);
  const before = await levels();
  // Var olmayan kullanıcı kimliği: sipariş satırındaki "silen" yabancı anahtarı işlemin sonunda hata verir (iade yazıldıktan sonra)
  const o = await load(id);
  await assert.rejects(removeOrder(db, { orderId: id, confirmNo: o.orderNo, actor: { id: 'yok-kullanici', role: 'ADMIN', ip: '127.0.0.1' }, fgoCheck: FGO_OK }));
  assert.deepEqual(await levels(), before, 'iade geri alındı');
  assert.equal(await moves(id, 'IADE'), 0);
  const after = await load(id);
  assert.equal(after.removedAt, null);
  assert.equal(after.profile.stockDeducted, true);
  assert.equal(await db.auditLog.count({ where: { entityId: id, action: 'ORDER_REMOVED' } }), 0);
  // Sonra olağan silme çalışır
  assert.equal((await remove(id, 'admin')).ok, true);
  assert.deepEqual(await levels(), [before[0] + 2, before[1]]);
}));

dbTest('profil silme: mali geçmiş (proforma, FGO belgesi, kuyrukta belge) ve teslim silmeyi engeller; stok değişmez', offline(async () => {
  // Proforma (elle)
  const a = await approved([['GK15', 1]]);
  await run(a, 'mark_proforma', 'admin');
  const before = await levels();
  const ra = await remove(a, 'admin');
  assert.equal(ra.code, 'LOCKED');
  assert.ok(ra.reasons.some((x) => x.code === 'PROFILE_FINANCE'));
  // FGO belgesi
  const b = await approved([['AD45', 1]]);
  await db.fgoDocument.create({ data: { orderId: b, kind: 'PROFORMA', series: 'PRF', number: '901', issuedAt: new Date(), currency: 'RON', total: 100, paid: 0 } });
  const rb = await remove(b, 'admin');
  assert.equal(rb.code, 'LOCKED');
  assert.ok(rb.reasons.some((x) => x.code === 'FGO_DOCUMENT'));
  // Kuyrukta FGO belge işi (ör. avans) → BUSY
  const c = await approved([['AD45', 1]]);
  await db.notificationOutbox.create({ data: { type: 'FGO_PROFILE_ADVANCE', orderId: c, payload: {} } });
  assert.equal((await remove(c, 'admin')).code, 'BUSY');
  // Teslim edilmiş (mal depodan çıktı)
  const d = await inWarehouse([['GK15', 1]]);
  await run(d, 'mark_delivered', 'admin');
  const rd = await remove(d, 'admin');
  assert.equal(rd.code, 'LOCKED');
  assert.ok(rd.reasons.some((x) => x.code === 'PROFILE_WAREHOUSE'));
  for (const id of [a, b, c, d]) {
    assert.equal((await load(id)).removedAt, null);
    assert.equal(await moves(id, 'IADE'), 0);
  }
  assert.deepEqual(await levels(), [before[0] - 1, before[1]], 'yalnızca d\'nin depoya gönderilmesi düştü; hiçbir iade yok');
}));

dbTest('FGO doğrulaması (yalnızca okur): kapalı → FGO_DISABLED; "belge yok" yanıtı → doğrulandı; ağ / kimlik / firma hatası → FGO_UNREACHABLE', offline(async () => {
  assert.deepEqual(await verifyFgoForRemoval(db, { secret: SECRET, fetchImpl: async () => { throw new Error('çağrılmamalı'); } }), { ok: false, code: 'FGO_DISABLED' });
  await saveFgoSettings(db, { enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 }, { key: 'K', secret: SECRET }, actor(people.admin));
  const seen = [];
  const reply = (status, body) => async (url, init) => {
    seen.push({ url: String(url), body: String(init?.body ?? '') });
    return { ok: status < 300, status, text: async () => JSON.stringify(body) };
  };
  const ok = await verifyFgoForRemoval(db, { secret: SECRET, fetchImpl: reply(200, { Success: false, Message: 'Factura nu exista' }) });
  assert.equal(ok.ok, true);
  assert.ok(seen.every((s) => s.url.endsWith('/factura/getstatus')), 'yalnızca durum sorgusu');
  assert.ok(seen.every((s) => !/emitere|anulare|stergere/.test(s.url)));
  for (const fetchImpl of [
    async () => { throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }); },
    reply(200, { Success: false, Message: 'Hash invalid' }),
    reply(200, { Success: false, Message: 'Firma nu exista' }),
    reply(503, { Message: 'down' }),
  ]) {
    assert.deepEqual(await verifyFgoForRemoval(db, { secret: SECRET, fetchImpl }), { ok: false, code: 'FGO_UNREACHABLE' });
  }
  assert.deepEqual(await verifyFgoForRemoval(db, { secret: 'yanlis-sir-0123456789abcdef0123456789', fetchImpl: reply(200, {}) }), { ok: false, code: 'NO_KEY' });
}));
