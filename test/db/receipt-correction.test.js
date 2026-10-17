// 3.91.0 (karar 286) — hatalı mal kabulünün düzeltmesi, gerçek PostgreSQL ile: tam geri alma, kısmi düzeltme, birden çok
// düzeltme (toplam kabulü aşamaz), yetersiz stok (eksi stok yok), yetkisiz kullanıcı, aynı isteğin tekrarı, eşzamanlı
// düzeltme / eski ekran, işlem ortasında hata → tam geri alma, kalan miktar ve sonraki gerçek teslimat, otomatik kapanmış
// siparişin yeniden açılması (elle kapatılmış / iptal açılmaz), belge ve depo e-postası (düzeltme olarak işaretli, orijinal
// değişmez, mükerrer yok), değişmezlik, beklenen tedarik ve rapor / Telegram tutarlılığı. Gerçek e-posta YOK (sahte taşıyıcı,
// .test adresleri), ağ isteği yok, FGO / ANAF yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-kabul-duzeltme-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const svc = await import('../../server/suppliers/service.js');
const recv = await import('../../server/suppliers/receipt.js');
const { buildCorrectionPdf, buildReceiptPdf, dispatchReceiptEmails } = await import('../../server/suppliers/receipt-mail.js');
const { dispatchSupplierOrderEmails } = await import('../../server/suppliers/dispatch.js');
const { RECEIPT_EMAIL } = await import('../../server/suppliers/receipt-rules.js');
const { addStockMovement, stockLevels } = await import('../../server/profile/stock.js');
const { saveWarehouseSettings } = await import('../../server/profile/warehouse.js');
const { localDay } = await import('../../server/profile/dates.js');
const { runReport } = await import('../../server/reports/service.js');
const { readOnly } = await import('../../server/assistant/readonly.js');
const { runTool } = await import('../../server/assistant/tools.js');

const TZ = 'Europe/Bucharest';
const TODAY = localDay(new Date(), TZ);
let db, sup;
const U = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const key = () => randomUUID().replace(/-/g, '');
const prod = (code) => db.profileProduct.findUniqueOrThrow({ where: { code } });
const RECIPIENTS = ['depo1@duzeltme.test', 'depo2@duzeltme.test'];

/** Taslak + onay; e-posta gönderilmiş sayılır (sentAt, GONDERILDI) — gerçek gönderim yok. lines: [kod, adet] */
async function sentOrder(lines, { sent = true } = {}) {
  const c = await svc.createDraftOrder(db, { supplierId: sup.id }, act(U.admin), { timeZone: TZ });
  assert.ok(c.ok, JSON.stringify(c));
  const ids = await Promise.all(lines.map(async ([code]) => (await prod(code)).id));
  let o = await db.supplierOrder.findUniqueOrThrow({ where: { id: c.id } });
  const s = await svc.saveDraft(db, { orderId: c.id, version: o.version, orderDate: TODAY, note: '', lines: lines.map(([, qty], i) => ({ productId: ids[i], qty, unitPrice: '', color: '' })) }, act(U.admin), { timeZone: TZ });
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
async function receive(id, q, who = 'admin') {
  const lines = await linesOf(id);
  const quantities = Object.fromEntries(Object.entries(q).map(([code, n]) => [lines[code].id, String(n)]));
  return recv.receiveGoods(db, { orderId: id, receivedOn: TODAY, reference: 'AVIZ 1', requestKey: key(), quantities }, act(U[who]), { timeZone: TZ });
}
/** Düzeltme: q = { kod: adet } (kabulün satırları); expectedVersion verilmezse güncel sipariş sürümü */
async function correct(id, receiptId, q, { who = 'admin', requestKey = key(), reason = 'Avizde fazla yazılmış', version = null, dbx = db } = {}) {
  const r = await db.supplierReceipt.findUniqueOrThrow({ where: { id: receiptId }, include: { lines: true } });
  const quantities = Object.fromEntries(Object.entries(q).map(([code, n]) => [r.lines.find((l) => l.code === code).id, String(n)]));
  const v = version ?? (await db.supplierOrder.findUniqueOrThrow({ where: { id } })).version;
  return recv.correctReceipt(dbx, { orderId: id, receiptId, reason, requestKey, expectedVersion: String(v), quantities }, act(U[who]));
}
const level = async (code) => { const p = await prod(code); return (await stockLevels(db, [p.id])).get(p.id) ?? 0; };
const balance = async (id) => Object.fromEntries((await recv.loadReceipts(db, id)).lines.map((l) => [l.code, [l.ordered, l.received, l.remaining]]));
const snap = async (id) => ({
  order: await db.supplierOrder.findUniqueOrThrow({ where: { id }, select: { status: true, version: true, receivedAt: true } }),
  receipts: await db.supplierReceipt.count({ where: { orderId: id } }),
  receiptLines: (await db.supplierReceiptLine.findMany({ where: { receipt: { orderId: id } }, orderBy: { id: 'asc' } })).map((l) => [l.id, l.qty]),
  corrections: await db.supplierReceiptCorrection.count({ where: { orderId: id } }),
  correctionLines: await db.supplierReceiptCorrectionLine.count({ where: { correction: { orderId: id } } }),
  moves: await db.stockMovement.count({ where: { OR: [{ supplierReceipt: { orderId: id } }, { supplierCorrection: { orderId: id } }] } }),
  jobs: await db.notificationOutbox.count({ where: { type: RECEIPT_EMAIL, payload: { path: ['supplierOrderId'], equals: id } } }),
  audit: await db.auditLog.count({ where: { action: 'SUPPLIER_RECEIPT_CORRECTED', entityId: id } }),
});
function transport(fail = () => null) {
  const sent = [];
  return { sent, async sendMail(m) { const e = fail(m.to); if (e) throw e; sent.push(m); return { messageId: `<c${sent.length}@test>` }; } };
}
const dispatch = (t) => dispatchReceiptEmails(db, { transport: t, from: 'takip@gkh.test', log: () => {} });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  const firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA' } });
  const mk = (k, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${k}@kabul-duzeltme.test`, name: k, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } }).then((u) => { U[k] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('assistant', 'YONETICI_YARDIMCISI', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  const s = await svc.saveSupplier(db, { name: 'Profil Tedarik', email: 'siparis@tedarik.test', currency: 'EUR' }, act(U.admin));
  sup = await db.supplier.findUniqueOrThrow({ where: { id: s.id } });
  await saveWarehouseSettings(db, { recipients: RECIPIENTS }, act(U.admin));
});
after(async () => {
  await closeDb();
  fs.rmSync(UPLOAD, { recursive: true, force: true });
});

dbTest('1) kısmi düzeltme (100 kabul, gerçekte 80): stok 20 azalır, net 80, kalan 20; orijinal kabul / hareket / belge değişmez; ayrı kayıt, ters hareket, denetim, tek e-posta işi; sonraki teslimat normal', offline(async () => {
  const s0 = await level('RM12-7016');
  const id = await sentOrder([['RM12-7016', 100]]);
  const r = await receive(id, { 'RM12-7016': 100 });
  assert.ok(r.ok && r.complete, JSON.stringify(r));
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id } })).status, 'TESLIM_ALINDI');
  const pdfBefore = (await buildReceiptPdf(db, r.receiptId)).buf.length;
  const receiptLinesBefore = await db.supplierReceiptLine.findMany({ where: { receiptId: r.receiptId } });
  const girisBefore = await db.stockMovement.findMany({ where: { supplierReceiptId: r.receiptId } });
  const jobBefore = await db.notificationOutbox.findFirstOrThrow({ where: { type: RECEIPT_EMAIL, payload: { path: ['receiptId'], equals: r.receiptId } } });

  const c = await correct(id, r.receiptId, { 'RM12-7016': 20 }, { reason: 'Avizde 100, gerçekte 80 adet geldi' });
  assert.ok(c.ok, JSON.stringify(c));
  assert.deepEqual([c.seq, c.reopened], [1, true]);
  assert.equal(await level('RM12-7016'), s0 + 80);
  assert.deepEqual((await balance(id))['RM12-7016'], [100, 80, 20]);
  // Otomatik kapanmış sipariş kalan oluştuğu için yeniden açıldı (e-posta gönderilmişti → GONDERILDI)
  const o = await db.supplierOrder.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([o.status, o.receivedAt], ['GONDERILDI', null]);
  // Orijinal kabul, satırları, GIRIS hareketi ve kabulün e-posta işi aynen
  assert.deepEqual(await db.supplierReceiptLine.findMany({ where: { receiptId: r.receiptId } }), receiptLinesBefore);
  assert.deepEqual(await db.stockMovement.findMany({ where: { supplierReceiptId: r.receiptId } }), girisBefore);
  assert.deepEqual(await db.notificationOutbox.findUniqueOrThrow({ where: { id: jobBefore.id } }), jobBefore);
  assert.equal((await buildReceiptPdf(db, r.receiptId)).buf.length, pdfBefore, 'orijinal belge aynı');
  // Düzeltme kaydı: kullanıcı, zaman, ürün, adet, önceki / yeni stok
  const fix = await db.supplierReceiptCorrection.findUniqueOrThrow({ where: { id: c.correctionId }, include: { lines: true, stockMoves: true } });
  assert.deepEqual([fix.receiptId, fix.reason, fix.createdById, fix.reopened], [r.receiptId, 'Avizde 100, gerçekte 80 adet geldi', U.admin.id, true]);
  assert.deepEqual(fix.lines.map((l) => [l.code, l.qty, l.stockBefore, l.stockAfter]), [['RM12-7016', 20, s0 + 100, s0 + 80]]);
  assert.deepEqual(fix.stockMoves.map((m) => [m.kind, m.qty]), [['KABUL_DUZELTME', -20]]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SUPPLIER_RECEIPT_CORRECTED', entityId: id } });
  assert.equal(audit.userId, U.admin.id);
  assert.deepEqual(audit.details.lines, [{ code: 'RM12-7016', productId: (await prod('RM12-7016')).id, qty: 20, unitCode: 'BARA', stockBefore: s0 + 100, stockAfter: s0 + 80 }]);
  assert.deepEqual([audit.details.reason, audit.details.receiptSeq, audit.details.reopened], ['Avizde 100, gerçekte 80 adet geldi', 1, { from: 'TESLIM_ALINDI', to: 'GONDERILDI', skippedSupplierJobs: 0 }]);
  const jobs = await db.notificationOutbox.findMany({ where: { type: RECEIPT_EMAIL, payload: { path: ['correctionId'], equals: c.correctionId } } });
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0].payload.correctionOf, jobs[0].payload.receiptId], [r.receiptId, undefined]);
  // Ekran verisi: kabul satırında kabul / düzeltilen / net; düzeltme listesi
  const view = (await recv.loadReceipts(db, id)).receipts[0];
  assert.deepEqual(view.lines.map((l) => [l.qty, l.corrected, l.net, l.correctable]), [[100, 20, 80, 80]]);
  assert.deepEqual(view.corrections.map((x) => [x.seq, x.reopened, x.lines[0].stockBefore, x.lines[0].stockAfter]), [[1, true, s0 + 100, s0 + 80]]);
  assert.equal(view.mail.status, 'PENDING', 'kabulün kendi işi (düzeltme işi karışmaz)');
  // Sonraki gerçek teslimat (kalan 20) normal kabul edilir ve siparişi yeniden kapatır
  const r2 = await receive(id, { 'RM12-7016': 20 });
  assert.ok(r2.ok && r2.complete, JSON.stringify(r2));
  assert.equal(await level('RM12-7016'), s0 + 100);
  assert.deepEqual((await balance(id))['RM12-7016'], [100, 100, 0]);
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id } })).status, 'TESLIM_ALINDI');
  assert.deepEqual(await receive(id, { 'RM12-7016': 1 }), { ok: false, code: 'NOT_ALLOWED', status: 'TESLIM_ALINDI' });
}));

dbTest('2) tam geri alma ve birden çok kısmi düzeltme: toplam kabulü asla aşamaz; aşan istek hiçbir şey yazmaz', offline(async () => {
  const id = await sentOrder([['GK15', 50], ['MC12', 10]]);
  const s0 = [await level('GK15'), await level('MC12')];
  const r = await receive(id, { GK15: 30, MC12: 10 });
  assert.ok(r.ok && !r.complete);
  assert.ok((await correct(id, r.receiptId, { GK15: 10 })).ok);
  assert.ok((await correct(id, r.receiptId, { GK15: 15, MC12: 4 })).ok);
  const before = await snap(id);
  assert.deepEqual(await correct(id, r.receiptId, { GK15: 6 }), { ok: false, code: 'OVER_CORRECTABLE', line: 'GK15', correctable: 5 });
  assert.deepEqual(await correct(id, r.receiptId, { GK15: 5, MC12: 7 }), { ok: false, code: 'OVER_CORRECTABLE', line: 'MC12', correctable: 6 });
  assert.deepEqual(await snap(id), before, 'reddedilen düzeltme hiçbir şey yazmaz');
  // Tam geri alma (kalanın tamamı)
  const all = await correct(id, r.receiptId, { GK15: 5, MC12: 6 });
  assert.ok(all.ok);
  assert.equal(all.seq, 3);
  assert.deepEqual([await level('GK15'), await level('MC12')], s0);
  assert.deepEqual(await balance(id), { GK15: [50, 0, 50], MC12: [10, 0, 10] });
  assert.equal((await db.supplierReceiptCorrectionLine.aggregate({ where: { correction: { receiptId: r.receiptId } }, _sum: { qty: true } }))._sum.qty, 40);
  assert.deepEqual(await correct(id, r.receiptId, { GK15: 1 }), { ok: false, code: 'OVER_CORRECTABLE', line: 'GK15', correctable: 0 });
  // Açık sipariş (kısmi kabul) yeniden açılmaz — zaten açık; tekrar teslimat kabul edilir
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id } })).status, 'GONDERILDI');
  assert.ok((await receive(id, { GK15: 50, MC12: 10 })).complete);
  // Stok = hareketlerin toplamı; düzeltmelerin toplamı kabulleri aşmadı
  const moves = await db.stockMovement.groupBy({ by: ['kind'], where: { OR: [{ supplierReceipt: { orderId: id } }, { supplierCorrection: { orderId: id } }] }, _sum: { qty: true } });
  assert.deepEqual(Object.fromEntries(moves.map((m) => [m.kind, m._sum.qty])), { GIRIS: 100, KABUL_DUZELTME: -40 });
}));

dbTest('3) yetersiz stok: düzeltme stoğu eksiye düşüreceği için reddedilir — hiçbir şey yazılmaz; stok yeterliyse kabul edilir', offline(async () => {
  const id = await sentOrder([['MR23-7016', 10]]);
  const r = await receive(id, { 'MR23-7016': 10 });
  assert.ok(r.ok);
  const now = await level('MR23-7016');
  // Bu arada mal depoya çıktı (sayım): stok 3'e indi
  assert.ok((await addStockMovement(db, { productId: (await prod('MR23-7016')).id, kind: 'SAYIM', qty: 3, note: 'test sayım' }, act(U.admin))).ok);
  assert.equal(await level('MR23-7016'), 3);
  const before = await snap(id);
  assert.deepEqual(await correct(id, r.receiptId, { 'MR23-7016': 5 }), { ok: false, code: 'INSUFFICIENT_STOCK', line: 'MR23-7016', stock: 3 });
  assert.deepEqual(await snap(id), before);
  assert.equal(await level('MR23-7016'), 3);
  // Stok tam yetiyorsa (3) düzeltilir, stok 0 olur (eksi değil)
  assert.ok((await correct(id, r.receiptId, { 'MR23-7016': 3 })).ok);
  assert.equal(await level('MR23-7016'), 0);
  assert.ok(now >= 10);
  // Stok zaten eksi / sıfırken hiçbir düzeltme yapılamaz
  assert.deepEqual(await correct(id, r.receiptId, { 'MR23-7016': 1 }), { ok: false, code: 'INSUFFICIENT_STOCK', line: 'MR23-7016', stock: 0 });
}));

dbTest('4) yetki: satış, çizim, denetimci, müşteri reddedilir (hiçbir şey yazılmaz); yönetici yardımcısı düzeltebilir', offline(async () => {
  const id = await sentOrder([['FBL115-7016', 10]]);
  const r = await receive(id, { 'FBL115-7016': 10 });
  const before = await snap(id);
  for (const who of ['sales', 'drawer', 'inspector', 'cust']) assert.deepEqual(await correct(id, r.receiptId, { 'FBL115-7016': 1 }, { who }), { ok: false, code: 'FORBIDDEN' }, who);
  assert.deepEqual(await snap(id), before);
  const ok = await correct(id, r.receiptId, { 'FBL115-7016': 2 }, { who: 'assistant' });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal((await db.supplierReceiptCorrection.findUniqueOrThrow({ where: { id: ok.correctionId } })).createdById, U.assistant.id);
  // Başka siparişin kabulü / gerekçesiz / boş form
  const other = await sentOrder([['FBL115-ELX', 5]]);
  assert.deepEqual(await recv.correctReceipt(db, { orderId: other, receiptId: r.receiptId, reason: 'x', requestKey: key(), expectedVersion: '0', quantities: { a: '1' } }, act(U.admin)), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await correct(id, r.receiptId, { 'FBL115-7016': 1 }, { reason: '  ' }), { ok: false, code: 'REASON' });
}));

dbTest('5) çift tıklama / tekrarlanan istek: ilk düzeltme döner, ikinci düzeltme ve ikinci stok hareketi yok (eşzamanlı aynı anahtar dahil)', offline(async () => {
  const id = await sentOrder([['FBL90-7016', 40]]);
  const r = await receive(id, { 'FBL90-7016': 40 });
  const s = await level('FBL90-7016');
  const k = key();
  const v = (await db.supplierOrder.findUniqueOrThrow({ where: { id } })).version;
  const first = await correct(id, r.receiptId, { 'FBL90-7016': 5 }, { requestKey: k, version: v });
  assert.ok(first.ok);
  const again = await correct(id, r.receiptId, { 'FBL90-7016': 5 }, { requestKey: k, version: v });
  assert.deepEqual(again, { ok: true, duplicate: true, correctionId: first.correctionId, seq: first.seq, reopened: first.reopened });
  assert.equal(await level('FBL90-7016'), s - 5);
  // Eşzamanlı aynı anahtar
  const k2 = key();
  const v2 = (await db.supplierOrder.findUniqueOrThrow({ where: { id } })).version;
  const res = await Promise.all([1, 2, 3].map(() => correct(id, r.receiptId, { 'FBL90-7016': 3 }, { requestKey: k2, version: v2 })));
  assert.ok(res.every((x) => x.ok), JSON.stringify(res));
  assert.equal(new Set(res.map((x) => x.correctionId)).size, 1);
  assert.equal(res.filter((x) => !x.duplicate).length, 1);
  assert.equal(await level('FBL90-7016'), s - 8);
  assert.equal(await db.supplierReceiptCorrection.count({ where: { orderId: id } }), 2);
  // Aynı anahtar başka kabul için → CONFLICT
  const r2 = await receive(await sentOrder([['FBL90-ELX', 2]]), { 'FBL90-ELX': 2 });
  const o2 = (await db.supplierReceipt.findUniqueOrThrow({ where: { id: r2.receiptId } })).orderId;
  assert.deepEqual(await correct(o2, r2.receiptId, { 'FBL90-ELX': 1 }, { requestKey: k }), { ok: false, code: 'CONFLICT' });
}));

dbTest('6) yarış ve eski ekran: aynı ekrandan iki farklı düzeltme → biri kaydedilir, öbürü STALE; kabulden sonra eski ekran STALE; düzeltme + kabul eşzamanlı tutarlı', offline(async () => {
  const id = await sentOrder([['MR23-ELX', 60]]);
  const r = await receive(id, { 'MR23-ELX': 50 });
  const s = await level('MR23-ELX');
  const v = (await db.supplierOrder.findUniqueOrThrow({ where: { id } })).version;
  const res = await Promise.all([correct(id, r.receiptId, { 'MR23-ELX': 30 }, { version: v }), correct(id, r.receiptId, { 'MR23-ELX': 30 }, { version: v })]);
  assert.equal(res.filter((x) => x.ok).length, 1, JSON.stringify(res));
  assert.deepEqual(res.find((x) => !x.ok), { ok: false, code: 'STALE' });
  assert.equal(await level('MR23-ELX'), s - 30);
  // Eski ekran: araya yeni bir kabul girdi
  const old = (await db.supplierOrder.findUniqueOrThrow({ where: { id } })).version;
  assert.ok((await receive(id, { 'MR23-ELX': 5 })).ok);
  const before = await snap(id);
  assert.deepEqual(await correct(id, r.receiptId, { 'MR23-ELX': 1 }, { version: old }), { ok: false, code: 'STALE' });
  assert.deepEqual(await snap(id), before);
  // Düzeltme ile yeni kabul aynı anda (her biri kendi güncel sürümüyle): kilit sırası tutarlı, toplamlar doğru
  const v3 = (await db.supplierOrder.findUniqueOrThrow({ where: { id } })).version;
  const both = await Promise.all([correct(id, r.receiptId, { 'MR23-ELX': 10 }, { version: v3 }), receive(id, { 'MR23-ELX': 5 })]);
  assert.ok(both[1].ok, JSON.stringify(both));
  assert.ok(both[0].ok || both[0].code === 'STALE', JSON.stringify(both[0]));
  const net = (await balance(id))['MR23-ELX'];
  const fixed = (await db.supplierReceiptCorrectionLine.aggregate({ where: { correction: { orderId: id } }, _sum: { qty: true } }))._sum.qty;
  assert.deepEqual(net, [60, 60 - fixed, fixed]);
  assert.equal(await level('MR23-ELX'), s + 10 - fixed + 30 - 30, 'stok = kabuller − düzeltmeler');
}));

dbTest('7) işlem ortasında hata (stok hareketinden sonra): her şey geri alınır — düzeltme, satır, stok, sipariş durumu / sürümü, e-posta işi, denetim yok', offline(async () => {
  const id = await sentOrder([['SPIGOTI', 8]]);
  const r = await receive(id, { SPIGOTI: 8 });
  const s = await level('SPIGOTI');
  const before = await snap(id);
  const wrap = (tx) => new Proxy(tx, {
    get(t, k) {
      if (k === 'notificationOutbox') return { updateMany: (...x) => t.notificationOutbox.updateMany(...x), create: async () => { throw new Error('test: kuyruk yazılamadı'); } };
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const failing = new Proxy(db, { get(t, k) { if (k === '$transaction') return (fn, o) => t.$transaction((tx) => fn(wrap(tx)), o); const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
  await assert.rejects(correct(id, r.receiptId, { SPIGOTI: 8 }, { dbx: failing }), /kuyruk yazılamadı/);
  assert.deepEqual(await snap(id), before);
  assert.equal(await level('SPIGOTI'), s);
  assert.ok((await correct(id, r.receiptId, { SPIGOTI: 8 })).ok, 'aynı düzeltme sonra yapılabilir');
  assert.equal(await level('SPIGOTI'), s - 8);
}));

dbTest('8) elle kapatılmış ya da iptal edilmiş sipariş yeniden açılmaz; düzeltme yine yapılır; düzeltme kayıtları değişmez (tetikleyici)', offline(async () => {
  const a = await sentOrder([['GK15', 20]]);
  const ra = await receive(a, { GK15: 10 });
  assert.ok((await svc.markReceived(db, { orderId: a }, act(U.admin))).ok);
  const fa = await correct(a, ra.receiptId, { GK15: 4 });
  assert.deepEqual([fa.ok, fa.reopened], [true, false]);
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id: a } })).status, 'TESLIM_ALINDI');
  const b = await sentOrder([['GK15', 20]]);
  const rb = await receive(b, { GK15: 5 });
  assert.ok((await svc.cancelOrder(db, { orderId: b, reason: 'test' }, act(U.admin))).ok);
  const fb = await correct(b, rb.receiptId, { GK15: 5 });
  assert.deepEqual([fb.ok, fb.reopened], [true, false]);
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id: b } })).status, 'IPTAL');
  // Değişmezlik
  await assert.rejects(db.supplierReceiptCorrection.update({ where: { id: fa.correctionId }, data: { reason: 'değiştir' } }), /immutable/);
  await assert.rejects(db.supplierReceiptCorrectionLine.deleteMany({ where: { correctionId: fa.correctionId } }), /immutable/);
  await assert.rejects(db.supplierReceiptLine.updateMany({ where: { receiptId: ra.receiptId }, data: { qty: 1 } }), /immutable/);
}));

dbTest('9) belge ve depo e-postası: düzeltme belgesi açıkça düzeltme, orijinal kabule referans; alıcı başına bir ileti, ikinci turda mükerrer yok; orijinal kabulün e-postası yeniden gitmez', offline(async () => {
  // Önceki testlerin kuyruktaki işleri bu testin gönderimlerine karışmasın
  await db.notificationOutbox.updateMany({ where: { type: RECEIPT_EMAIL, status: 'PENDING' }, data: { status: 'SKIPPED', lastError: 'TEST' } });
  const id = await sentOrder([['MC16', 12]]);
  const r = await receive(id, { MC16: 12 });
  const t1 = transport();
  await dispatch(t1); // kabulün e-postası
  assert.equal(t1.sent.length, RECIPIENTS.length);
  const fix = await correct(id, r.receiptId, { MC16: 2 }, { reason: 'İki kutu hasarlı geldi' });
  const built = await buildCorrectionPdf(db, fix.correctionId);
  assert.equal(built.buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(built.receipt.id, r.receiptId);
  const t2 = transport();
  const out = await dispatch(t2);
  assert.equal(out.sent, 1);
  assert.equal(t2.sent.length, RECIPIENTS.length);
  for (const m of t2.sent) {
    assert.match(m.subject, /CORECȚIE recepție – .* – recepția nr\. 1 – corecția nr\. 1 – Profil Tedarik$/);
    assert.ok(m.text.includes('-2 ') && m.text.includes('Motiv: İki kutu hasarlı geldi'));
    assert.match(m.attachments[0].filename, /^Corectie-Receptie-.+-1-1\.pdf$/);
    assert.ok(!/EUR|RON|Preț/.test(m.text));
  }
  assert.deepEqual(t2.sent.map((m) => m.to).sort(), RECIPIENTS);
  const t3 = transport();
  await dispatch(t3);
  assert.equal(t3.sent.length, 0, 'mükerrer gönderim yok; orijinal kabul e-postası yeniden gitmez');
  const job = await db.notificationOutbox.findFirstOrThrow({ where: { type: RECEIPT_EMAIL, payload: { path: ['correctionId'], equals: fix.correctionId } } });
  assert.equal(job.status, 'SENT');
  assert.ok(await db.auditLog.findFirst({ where: { action: 'SUPPLIER_RECEIPT_CORRECTION_EMAIL_SENT', entityId: id } }));
  // E-posta hatası düzeltmeyi / stoğu geri almaz
  const s = await level('MC16');
  await correct(id, r.receiptId, { MC16: 1 });
  await dispatch(transport(() => Object.assign(new Error('bağlanamadı'), { command: 'CONN' })));
  assert.equal(await level('MC16'), s - 1);
}));

dbTest('10) beklenen tedarik, profil raporu ve Telegram raporu düzeltilmiş net miktarı kullanır; stok = hareketlerin toplamı', offline(async () => {
  const p = await db.profileCategory.findFirstOrThrow();
  const fb = await db.profileProduct.create({ data: { code: 'RCF-FBL90', categoryId: p.id, nameRo: 'Profil RCF', nameTr: 'RCF profil', unitCode: 'BARA', packContent: '6', packMeasure: 'M', supplierCode: 'TED-RCF-FBL90' } });
  const id = await sentOrder([['RCF-FBL90', 100]]);
  const r = await receive(id, { 'RCF-FBL90': 100 });
  const exp0 = (await svc.expectedSupplyMap(db)).get(fb.id);
  assert.equal(exp0, undefined, 'tamamı teslim alındı: beklenen yok');
  assert.ok((await correct(id, r.receiptId, { 'RCF-FBL90': 20 })).ok);
  assert.equal((await svc.expectedSupplyMap(db)).get(fb.id).qty, 20, 'düzeltilen miktar yeniden beklenir');
  const input = { kind: 'profile', from: TODAY, to: TODAY, product: 'RCF-' };
  const rep = await runReport(db, input, { actor: act(U.admin), now: new Date(), timeZone: TZ });
  assert.ok(rep.ok, JSON.stringify(rep));
  const tbl = (key) => { const tb = rep.report.tables.find((x) => x.key === key); return tb.rows.map((row) => Object.fromEntries(tb.columns.map((c, i) => [c.key, row[i]]))); };
  assert.deepEqual(tbl('movements').map((x) => [x.code, x.inReceipt, x.receiptFix, x.net]), [['RCF-FBL90', 100, -20, 80]]);
  assert.deepEqual(tbl('supplierOrders').map((x) => [x.code, x.ordered, x.received, x.remaining]), [['RCF-FBL90', 100, 80, 20]]);
  assert.deepEqual(tbl('receipts').map((x) => [x.entry, x.code, x.qty]), [['RECEIPT', 'RCF-FBL90', 100], ['CORRECTION', 'RCF-FBL90', -20]]);
  assert.deepEqual(rep.report.tables.find((x) => x.key === 'receipts').totals.map((t) => [t[7], t[8]]), [['BARA', 80]]);
  assert.equal(tbl('stock')[0].stock, 80);
  assert.equal(await level('RCF-FBL90'), 80);
  // Telegram: aynı servis, salt okunur; aynı net miktar
  const bot = await runTool(readOnly(db), 'rapor', JSON.stringify({ tur: 'profil_stok', baslangic: TODAY, bitis: TODAY, urun: 'RCF-' }), { tz: TZ, now: new Date() });
  assert.equal(bot.hata, undefined, JSON.stringify(bot));
  const so = bot.tablolar.find((x) => x.ad === 'supplierOrders');
  assert.deepEqual(so.satirlar.map((x) => [x.code, x.received, x.remaining]), [['RCF-FBL90', 80, 20]]);
  const mv = bot.tablolar.find((x) => x.ad === 'movements');
  assert.deepEqual(mv.satirlar.map((x) => [x.receiptFix, x.net]), [[-20, 80]]);
}));

dbTest('11) yeniden açılan siparişin e-posta gönderim durumu değişmez: gönderildi / gerçek hata / hiç gönderilmedi aynen; düzeltme tedarikçiye e-posta göndermez', offline(async () => {
  // Tedarikçi sipariş e-postalarının işçisi: düzeltmeden sonra çalıştırılınca hiçbir ileti göndermemeli
  const supplierMail = transport();
  const sendSupplier = () => dispatchSupplierOrderEmails(db, { transport: supplierMail, from: 'takip@gkh.test', log: () => {} });
  // Önceki testlerin kuyrukta kalmış sipariş e-postaları bu testin sayımına karışmasın
  await db.notificationOutbox.updateMany({ where: { type: svc.SUPPLIER_EMAIL, status: 'PENDING' }, data: { status: 'SKIPPED', lastError: 'TEST' } });
  const sendInfo = (id) => db.supplierOrder.findUniqueOrThrow({ where: { id }, select: { status: true, sentAt: true, sendError: true } });

  // a) Gönderilmiş: GONDERILDI, sentAt aynen
  const a = await sentOrder([['GK15', 4]]);
  const ra = await receive(a, { GK15: 4 });
  const sa = await sendInfo(a);
  assert.ok((await correct(a, ra.receiptId, { GK15: 1 })).reopened);
  assert.deepEqual(await sendInfo(a), { ...sa, status: 'GONDERILDI' });

  // b) Gerçek gönderim hatası kaydı: GONDERIM_HATASI, hata kodu aynen
  const b = await sentOrder([['GK15', 4]], { sent: false });
  await db.notificationOutbox.updateMany({ where: svc.jobsWhere(b), data: { status: 'FAILED', lastError: 'SMTP', attempts: 1 } });
  await db.supplierOrder.update({ where: { id: b }, data: { status: 'GONDERIM_HATASI', sendError: 'SMTP' } });
  const rb = await receive(b, { GK15: 4 });
  assert.ok(rb.complete);
  assert.ok((await correct(b, rb.receiptId, { GK15: 2 })).reopened);
  assert.deepEqual(await sendInfo(b), { status: 'GONDERIM_HATASI', sentAt: null, sendError: 'SMTP' });

  // c) Hiç gönderilmedi (iş kuyrukta, işçi henüz çalışmadı): gönderim hatası DEĞİL → GONDERIM_BEKLIYOR; sentAt / sendError boş
  const c = await sentOrder([['GK15', 3]], { sent: false });
  const rc = await receive(c, { GK15: 3 });
  assert.ok(rc.complete);
  const job = await db.notificationOutbox.findFirstOrThrow({ where: { ...svc.jobsWhere(c), status: 'PENDING' } });
  const fc = await correct(c, rc.receiptId, { GK15: 1 });
  assert.ok(fc.reopened);
  assert.deepEqual(await sendInfo(c), { status: 'GONDERIM_BEKLIYOR', sentAt: null, sendError: null });
  // Kuyrukta kalmış sipariş e-postası düzeltme yüzünden gönderilmez ("teslim alındı" diye kapandı); yeni sipariş e-postası işi yazılmadı
  assert.deepEqual(await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, lastError: true } }), { status: 'SKIPPED', lastError: 'TESLIM_ALINDI' });
  assert.equal(await db.notificationOutbox.count({ where: svc.jobsWhere(c) }), 1);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SUPPLIER_RECEIPT_CORRECTED', entityId: c } });
  assert.deepEqual(audit.details.reopened, { from: 'TESLIM_ALINDI', to: 'GONDERIM_BEKLIYOR', skippedSupplierJobs: 1 });

  // Tedarikçi e-postası işçisi çalışır: düzeltmeler hiçbir tedarikçiye ileti göndermez
  await sendSupplier();
  assert.equal(supplierMail.sent.length, 0, 'tedarikçiye otomatik e-posta yok');
  for (const id of [a, b, c]) assert.equal(await db.notificationOutbox.count({ where: { ...svc.jobsWhere(id), createdAt: { gte: (await db.supplierReceiptCorrection.findFirstOrThrow({ where: { orderId: id } })).createdAt } } }), 0, 'düzeltmeden sonra sipariş e-postası işi yok');
  // Sonraki teslimat sipariş durumu kurallarını bozmaz: kalan gelince yeniden "Teslim alındı"
  assert.ok((await receive(c, { GK15: 1 })).complete);
  assert.equal((await sendInfo(c)).status, 'TESLIM_ALINDI');
}));

dbTest('12) gerekçe yalnızca düzeltme belgesinde ve depo personelinin e-postasında: alıcılar yalnızca depo alıcıları; müşteriye / tedarikçiye bildirim yok', offline(async () => {
  await db.notificationOutbox.updateMany({ where: { type: RECEIPT_EMAIL, status: 'PENDING' }, data: { status: 'SKIPPED', lastError: 'TEST' } });
  const id = await sentOrder([['MC12', 6]]);
  const r = await receive(id, { MC12: 6 });
  await dispatch(transport());
  const outboxBefore = await db.notificationOutbox.count();
  const notesBefore = await db.notification.count();
  const reason = 'Gizli iç gerekçe: kutular ıslak geldi';
  const fix = await correct(id, r.receiptId, { MC12: 2 }, { reason });
  assert.ok(fix.ok);
  // Yalnızca bir yeni kuyruk işi (depo e-postası); uygulama içi bildirim yok
  assert.equal(await db.notificationOutbox.count(), outboxBefore + 1);
  assert.equal(await db.notification.count(), notesBefore);
  const t = transport();
  await dispatch(t);
  assert.deepEqual(t.sent.map((m) => m.to).sort(), RECIPIENTS, 'yalnızca depo alıcıları');
  assert.ok(!t.sent.some((m) => /tedarik\.test|siparis@/.test(String(m.to))), 'tedarikçi adresi yok');
  for (const m of t.sent) assert.ok(m.text.includes(`Motiv: ${reason}`) && m.html.includes('Gizli iç gerekçe'));
  // Belgede de gerekçe var (belge yalnızca yetkili yoldan ve depo e-postasının ekinde)
  const built = await buildCorrectionPdf(db, fix.correctionId);
  assert.equal(built.correction.reason, reason);
  // Müşteri kullanıcıları ve tedarikçi için hiçbir iş / bildirim yazılmadı
  assert.equal(await db.notification.count({ where: { userId: U.cust.id } }), 0);
  assert.equal(await db.notificationOutbox.count({ where: { type: svc.SUPPLIER_EMAIL, payload: { path: ['supplierOrderId'], equals: id }, createdAt: { gte: built.correction.createdAt } } }), 0);
}));
