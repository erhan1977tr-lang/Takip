// 3.93.0 regresyon düzeltmeleri (karar 288) — tedarikçi, stok, katalog ve müşteri girişleri, gerçek PostgreSQL ile:
//   O6  kısmi mal kabullü tedarikçi siparişinde iptal yalnızca KALANI iptal eder: kabul edilen mal, stok hareketleri, kabul
//       belgeleri ve o malın borcu aynen kalır (düzeltmeyle birlikte de doğru); tedarikçiye e-posta gitmez
//   D4  yeniden açılan / iptal edilen siparişte, SMTP bağlantı hatası nedeniyle yeniden denemeyi bekleyen sipariş e-postası
//       tedarikçiye gitmez
//   D5  üzerinde stok hareketi olan ürünün birimi değiştirilemez (form ve Excel)
//   D6  elle stok girişi eksi miktar kabul etmez (düşüm yalnızca sayımla — ayrı, yetkili, denetlenen işlem)
//   O3  müşteriye giden stok uyarısı / hesaplayıcı sonucu gerçek stok miktarı taşımaz
//   D2  cam siparişi formu iki kez gönderilse de tek sipariş açılır (tek kullanımlık form anahtarı)
//   D20 profil kataloğu / fiyat tablosu servisleri yetkisiz çağrıyı kendileri reddeder
// Gerçek e-posta YOK (sahte taşıyıcı, .test adresleri), ağ isteği yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-r393-tedarik-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const svc = await import('../../server/suppliers/service.js');
const recv = await import('../../server/suppliers/receipt.js');
const { dispatchSupplierOrderEmails } = await import('../../server/suppliers/dispatch.js');
const { addStockMovement, stockLevels, customerShortages } = await import('../../server/profile/stock.js');
const { saveProduct, applyProductImport, saveCategory, changeProduct } = await import('../../server/profile/catalog.js');
const { saveTablePrices } = await import('../../server/profile/pricing.js');
const { runRailingCalc } = await import('../../server/profile/calc-service.js');
const { localDay } = await import('../../server/profile/dates.js');
const { createGlassOrder, suggestNextNo } = await import('../../server/orders/create.js');

const TZ = 'Europe/Bucharest';
const TODAY = localDay(new Date(), TZ);
let db, sup, firm;
const U = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const key = () => randomUUID().replace(/-/g, '');
const prod = (code) => db.profileProduct.findUniqueOrThrow({ where: { code } });
const level = async (code) => { const p = await prod(code); return (await stockLevels(db, [p.id])).get(p.id) ?? 0; };

/** lines: [kod, adet, birim fiyat] — taslak + onay; sent: e-posta gönderilmiş sayılır */
async function sentOrder(lines, { sent = true } = {}) {
  const c = await svc.createDraftOrder(db, { supplierId: sup.id }, act(U.admin), { timeZone: TZ });
  assert.ok(c.ok, JSON.stringify(c));
  const ids = await Promise.all(lines.map(async ([code]) => (await prod(code)).id));
  let o = await db.supplierOrder.findUniqueOrThrow({ where: { id: c.id } });
  const s = await svc.saveDraft(db, { orderId: c.id, version: o.version, orderDate: TODAY, note: '', lines: lines.map(([, qty, price], i) => ({ productId: ids[i], qty, unitPrice: price ?? '', color: '' })) }, act(U.admin), { timeZone: TZ });
  assert.ok(s.ok, JSON.stringify(s));
  o = await db.supplierOrder.findUniqueOrThrow({ where: { id: c.id } });
  const a = await svc.approveAndSend(db, { orderId: c.id, version: o.version }, act(U.admin));
  assert.ok(a.ok, JSON.stringify(a));
  if (sent) {
    await db.notificationOutbox.updateMany({ where: svc.jobsWhere(c.id), data: { status: 'SENT', sentAt: new Date() } });
    await db.supplierOrder.update({ where: { id: c.id }, data: { status: 'GONDERILDI', sentAt: new Date() } });
  }
  return c.id;
}
async function linesOf(id) {
  const rev = await db.supplierOrderRevision.findFirstOrThrow({ where: { orderId: id, finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
  return Object.fromEntries(rev.lines.map((l) => [l.code, l]));
}
async function receive(id, q) {
  const lines = await linesOf(id);
  const quantities = Object.fromEntries(Object.entries(q).map(([code, n]) => [lines[code].id, String(n)]));
  return recv.receiveGoods(db, { orderId: id, receivedOn: TODAY, reference: 'AVIZ', requestKey: key(), quantities }, act(U.admin), { timeZone: TZ });
}
async function correct(id, receiptId, q) {
  const r = await db.supplierReceipt.findUniqueOrThrow({ where: { id: receiptId }, include: { lines: true } });
  const quantities = Object.fromEntries(Object.entries(q).map(([code, n]) => [r.lines.find((l) => l.code === code).id, String(n)]));
  const v = (await db.supplierOrder.findUniqueOrThrow({ where: { id } })).version;
  return recv.correctReceipt(db, { orderId: id, receiptId, reason: 'Fazla yazılmış', requestKey: key(), expectedVersion: String(v), quantities }, act(U.admin));
}
const debtOf = async () => Number((await svc.supplierAccount(db, sup.id)).balances.EUR?.debt ?? 0);
function transport() {
  const sent = [];
  return { sent, async sendMail(m) { sent.push(m); return { messageId: `<t${sent.length}@test>` }; } };
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA' } });
  const mk = (k, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${k}@r393-tedarik.test`, name: k, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } }).then((u) => { U[k] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  const s = await svc.saveSupplier(db, { name: 'Profil Tedarik R393', email: 'siparis@tedarik-r393.test', currency: 'EUR' }, act(U.admin));
  sup = await db.supplier.findUniqueOrThrow({ where: { id: s.id } });
});
after(async () => {
  await closeDb();
  fs.rmSync(UPLOAD, { recursive: true, force: true });
});

// ================================================================= O6

dbTest('O6: kısmi kabullü siparişin iptali yalnızca KALANI iptal eder — kabul edilen mal, stok, belgeler ve borcu kalır; düzeltme borca yansır; e-posta yok', offline(async () => {
  const d0 = await debtOf();
  const id = await sentOrder([['GK15', 10, '5'], ['AD45', 4, '2.5']]); // borç 60 EUR
  assert.equal(await debtOf(), d0 + 60);
  const s0 = await level('GK15');
  const r = await receive(id, { GK15: 6 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await level('GK15'), s0 + 6);
  const jobs0 = await db.notificationOutbox.count({ where: svc.jobsWhere(id) });
  const c = await svc.cancelOrder(db, { orderId: id, reason: 'Kalanı tedarikçi gönderemiyor' }, act(U.admin));
  assert.equal(c.ok, true, JSON.stringify(c));
  const o = await db.supplierOrder.findUniqueOrThrow({ where: { id } });
  assert.equal(o.status, 'IPTAL');
  // Kabul edilen mal ve belgeleri aynen durur; stok değişmedi
  assert.equal(await db.supplierReceipt.count({ where: { orderId: id } }), 1);
  assert.equal(await level('GK15'), s0 + 6, 'iptal stok yazmaz');
  // Borç: yalnızca teslim alınan 6 × 5 = 30 EUR (sıfırlanmadı, kalan 4 × 5 + 4 × 2,5 iptal)
  assert.equal(await debtOf(), d0 + 30);
  const acc = await svc.supplierAccount(db, sup.id);
  const row = acc.orders.find((x) => x.id === id);
  assert.deepEqual([row.counts, Number(row.total)], [true, 30]);
  // İptal tedarikçiye e-posta yazmaz
  assert.equal(await db.notificationOutbox.count({ where: svc.jobsWhere(id) }), jobs0);
  // Sonradan kabul düzeltmesi (2 adet fazla yazılmış): borç net teslim alınana iner, iptal açılmaz
  const fix = await correct(id, r.receiptId, { GK15: 2 });
  assert.equal(fix.ok, true, JSON.stringify(fix));
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id } })).status, 'IPTAL');
  assert.equal(await debtOf(), d0 + 20);
  // Kabulsüz siparişin iptali eskisi gibi borcu tamamen düşer
  const free = await sentOrder([['AD45', 2, '2.5']]);
  assert.equal(await debtOf(), d0 + 25);
  assert.equal((await svc.cancelOrder(db, { orderId: free, reason: 'İptal' }, act(U.admin))).ok, true);
  assert.equal(await debtOf(), d0 + 20);
}));

dbTest('O6: tam kabul → iptal yok (kapalı); kabul + düzeltmeyle yeniden açılan sipariş iptal edilince yalnızca kalan iptal olur', offline(async () => {
  const d0 = await debtOf();
  const id = await sentOrder([['MC12', 3, '10']]);
  const r = await receive(id, { MC12: 3 });
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id } })).status, 'TESLIM_ALINDI');
  assert.deepEqual(await svc.cancelOrder(db, { orderId: id, reason: 'x' }, act(U.admin)), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal(await debtOf(), d0 + 30);
  const fix = await correct(id, r.receiptId, { MC12: 1 });
  assert.equal(fix.ok, true);
  assert.notEqual((await db.supplierOrder.findUniqueOrThrow({ where: { id } })).status, 'TESLIM_ALINDI', 'düzeltme siparişi yeniden açtı');
  assert.equal((await svc.cancelOrder(db, { orderId: id, reason: 'Kalan gelmeyecek' }, act(U.admin))).ok, true);
  assert.equal(await debtOf(), d0 + 20, 'net teslim alınan 2 × 10');
}));

// ================================================================= D4

dbTest('D4: SMTP bağlantı hatası yüzünden yeniden denemeyi bekleyen sipariş e-postası, sipariş iptal edildiğinde ya da düzeltmeyle yeniden açıldığında tedarikçiye gitmez', offline(async () => {
  const waiting = (id) => db.notificationOutbox.updateMany({ where: svc.jobsWhere(id), data: { attempts: 1, lastError: 'SMTP_CONN', availableAt: new Date(Date.now() - 60_000) } });
  // a) İptal
  const a = await sentOrder([['GK15', 1, '5']], { sent: false });
  await waiting(a);
  assert.equal((await svc.cancelOrder(db, { orderId: a, reason: 'Vazgeçildi' }, act(U.admin))).ok, true);
  // b) Tam kabul (otomatik kapanış) → düzeltme siparişi yeniden açar
  const b = await sentOrder([['AD45', 2, '2.5']], { sent: false });
  await waiting(b);
  const r = await receive(b, { AD45: 2 });
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id: b } })).status, 'TESLIM_ALINDI');
  assert.equal((await correct(b, r.receiptId, { AD45: 1 })).ok, true);
  const t = transport();
  await dispatchSupplierOrderEmails(db, { transport: t, from: 'takip@gkh.test', now: new Date(Date.now() + 3_600_000), log: () => {} });
  assert.deepEqual(t.sent.map((m) => m.to), [], 'tedarikçiye gereksiz / mükerrer sipariş e-postası gitmedi');
  for (const id of [a, b]) {
    const jobs = await db.notificationOutbox.findMany({ where: svc.jobsWhere(id) });
    assert.ok(jobs.every((j) => j.status === 'SKIPPED'), JSON.stringify(jobs.map((j) => [j.status, j.lastError])));
  }
}));

// ================================================================= D5 / D6

dbTest('D5: stok hareketi olan ürünün birimi değiştirilemez (form + Excel); hareketsiz ürünün birimi değişir', offline(async () => {
  const p = await db.profileProduct.findUniqueOrThrow({ where: { code: 'PANA-90-16' }, include: { category: true } });
  await addStockMovement(db, { productId: p.id, kind: 'GIRIS', qty: 3 }, act(U.admin));
  const value = { code: p.code, categoryCode: p.category.code, nameRo: p.nameRo, nameTr: p.nameTr, unitCode: p.unitCode === 'BUCATI' ? 'PUNGI' : 'BUCATI', listPrice: null, isActive: true };
  assert.deepEqual(await saveProduct(db, p.id, value, act(U.admin)), { ok: false, code: 'UNIT_LOCKED' });
  assert.equal((await prod('PANA-90-16')).unitCode, p.unitCode);
  const imp = await applyProductImport(db, [{ ...value }], act(U.admin));
  assert.equal(imp.ok, false);
  assert.equal(imp.code, 'UNIT_LOCKED');
  assert.deepEqual(imp.codes, ['PANA-90-16']);
  assert.equal((await prod('PANA-90-16')).unitCode, p.unitCode, 'Excel de birimi değiştirmedi');
  // Hareketsiz (yeni) ürün: birim değişebilir
  const created = await saveProduct(db, null, { code: 'R393-X', categoryCode: p.category.code, nameRo: 'X', nameTr: 'X', unitCode: 'BUCATI', listPrice: null, isActive: true }, act(U.admin));
  assert.equal(created.ok, true);
  assert.equal((await saveProduct(db, created.id, { code: 'R393-X', categoryCode: p.category.code, nameRo: 'X', nameTr: 'X', unitCode: 'PUNGI', listPrice: null, isActive: true }, act(U.admin))).ok, true);
}));

dbTest('D6: elle stok girişi eksi miktar kabul etmez; düşüm sayımla (yetkili, denetlenen) yapılır; mevcut hareketler değişmez', offline(async () => {
  const p = await prod('PANA-115-12');
  const moves = await db.stockMovement.count({ where: { productId: p.id } });
  assert.deepEqual(await addStockMovement(db, { productId: p.id, kind: 'GIRIS', qty: -4 }, act(U.admin)), { ok: false, code: 'BAD_QTY' });
  assert.equal(await db.stockMovement.count({ where: { productId: p.id } }), moves);
  assert.equal((await addStockMovement(db, { productId: p.id, kind: 'GIRIS', qty: 10 }, act(U.admin))).ok, true);
  assert.equal((await addStockMovement(db, { productId: p.id, kind: 'SAYIM', qty: 6 }, act(U.admin))).ok, true);
  assert.equal(await level('PANA-115-12'), 6);
  assert.deepEqual(await addStockMovement(db, { productId: p.id, kind: 'SAYIM', qty: 1 }, act(U.sales)), { ok: false, code: 'FORBIDDEN' });
}));

// ================================================================= O3

dbTest('O3: müşterinin stok ön kontrolü ve korkuluk hesabı gerçek stok miktarını döndürmez (yüksek adetle stok öğrenilemez)', offline(async () => {
  const p = await prod('AD45');
  await addStockMovement(db, { productId: p.id, kind: 'SAYIM', qty: 37 }, act(U.admin));
  const lines = await customerShortages(db, [{ productId: p.id, qty: 100_000 }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].short, true);
  for (const k of ['available', 'missing', 'stock']) assert.ok(!(k in lines[0]), k);
  // Kayıt kimliği (cuid) rastgele / sayaca bağlı "37" içerebilir: yalnızca kimlik dışındaki alanlara bakılır
  assert.ok(!JSON.stringify(lines.map(({ productId: _id, ...rest }) => rest)).includes('37'), 'stok miktarı yanıtta yok');
  // Korkuluk hesabı (müşteri): stok bilgisi yalnızca "yetersiz" işareti
  const sys = await db.profileSystem.findFirst({ where: { isActive: true, kind: 'PROFILE' } });
  const t = await db.profileGlassThickness.findFirst();
  if (sys && t) {
    const res = await runRailingCalc(db, { profileId: sys.id, color: 'RAL7016', thicknessId: t.id, meters: '9000' });
    if (res.ok) for (const l of res.lines) if (l.stock) assert.deepEqual(Object.keys(l.stock), ['short']);
  }
}));

// ================================================================= D2

dbTest('D2: cam siparişi formu (aynı form anahtarı) iki kez / eşzamanlı gönderilirse tek sipariş açılır; ikinci istek ilk siparişi döndürür', offline(async () => {
  const before = await db.order.count({ where: { customerId: firm.id } });
  const requestKey = key();
  const mk = (n) => createGlassOrder(db, {
    actor: act(U.cust), firm, title: 'Çift gönderim', requestedNo: '501', suggestedNo: '501', requestKey,
    items: [{ glassName: '8mm Temperli', camAdedi: 0 }],
    files: [{ storageKey: `2026/10/r393-d2-${n}.pdf`, name: `d2-${n}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
  const res = await Promise.all([mk(1), mk(2), mk(3)]);
  assert.equal(new Set(res.map((r) => r.id)).size, 1, 'tek sipariş');
  assert.equal(res.filter((r) => r.duplicate).length, 2);
  assert.equal(await db.order.count({ where: { customerId: firm.id } }), before + 1);
  assert.equal(await db.orderFile.count({ where: { orderId: res[0].id } }), 1, 'ikinci isteğin dosyası siparişe eklenmedi');
  // Farklı anahtar = yeni sipariş (olağan)
  const other = await createGlassOrder(db, {
    actor: act(U.cust), firm, title: 'Yeni', requestedNo: await suggestNextNo(db, firm.id), suggestedNo: null, requestKey: key(),
    items: [{ glassName: '8mm Temperli', camAdedi: 0 }],
    files: [{ storageKey: '2026/10/r393-d2-x.pdf', name: 'x.pdf', size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
  assert.notEqual(other.id, res[0].id);
}));

// ================================================================= D20

dbTest('D20: profil kataloğu ve fiyat tablosu servisleri yetkisiz çağrıyı reddeder (hiçbir şey yazılmaz)', offline(async () => {
  const p = await db.profileProduct.findUniqueOrThrow({ where: { code: 'GK15' }, include: { category: true } });
  const audits = await db.auditLog.count();
  for (const u of [U.sales, U.inspector, U.cust]) {
    assert.deepEqual(await saveCategory(db, null, { code: 'R393', nameRo: 'X', nameTr: 'X', isActive: true }, act(u)), { ok: false, code: 'FORBIDDEN' });
    assert.equal(await changeProduct(db, p.id, 'toggle', act(u)), false);
    assert.deepEqual(await saveProduct(db, p.id, { code: p.code, categoryCode: p.category.code, nameRo: 'Y', nameTr: 'Y', unitCode: p.unitCode, listPrice: null, isActive: true }, act(u)), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await saveTablePrices(db, 'yok', { [p.id]: '1' }, act(u)), { ok: false, code: 'FORBIDDEN' });
  }
  assert.equal((await db.profileProduct.findUniqueOrThrow({ where: { id: p.id } })).isActive, p.isActive);
  assert.equal(await db.auditLog.count(), audits);
}));
