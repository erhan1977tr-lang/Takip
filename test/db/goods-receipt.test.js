// 3.87.0 (karar 282) — tedarikçi mal kabulü, gerçek PostgreSQL ile: tam / çoklu kısmi teslimat, kalanı aşan miktar, aynı
// isteğin tekrarı, eşzamanlı kabuller, işlem ortasında hata → tam geri alma, yetki, stok hareketi ↔ kullanılabilir stok
// tutarlılığı, belgede maliyet yok, e-posta hatasında stok korunur (alıcı başına, mükerrer yok), değişmezlik, 3.86.1 profil
// siparişi silme / stok iadesi ile birlikte çalışma. Gerçek e-posta YOK (sahte taşıyıcı, .test adresleri), ağ isteği yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-mal-kabul-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const svc = await import('../../server/suppliers/service.js');
const recv = await import('../../server/suppliers/receipt.js');
const { buildReceiptPdf, dispatchReceiptEmails } = await import('../../server/suppliers/receipt-mail.js');
const { RECEIPT_EMAIL } = await import('../../server/suppliers/receipt-rules.js');
const { stockLevels } = await import('../../server/profile/stock.js');
const { saveWarehouseSettings } = await import('../../server/profile/warehouse.js');
const { localDay } = await import('../../server/profile/dates.js');
const { FONTS } = await import('../../server/pdf/fonts.js');
const { suggestNextNo } = await import('../../server/orders/create.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction } = await import('../../server/profile/transitions.js');
const { earliestPickup } = await import('../../server/profile/dates.js');
const { removeOrder } = await import('../../server/orders/removal.js');
const { dispatchWarehouseEmails } = await import('../../server/profile/warehouse.js');

const TZ = 'Europe/Bucharest';
const TODAY = localDay(new Date(), TZ);
let db, sup, firm;
const U = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const key = () => randomUUID().replace(/-/g, '');
const prod = (code) => db.profileProduct.findUniqueOrThrow({ where: { code } });
const RECIPIENTS = ['depo1@depo.test', 'depo2@depo.test'];

/** Taslak + onay (e-posta kuyruğa yazılır, gönderilmez) → GONDERIM_BEKLIYOR. lines: [kod, adet, birim?, fiyat?] */
async function sentOrder(lines) {
  const c = await svc.createDraftOrder(db, { supplierId: sup.id }, act(U.admin), { timeZone: TZ });
  assert.ok(c.ok, JSON.stringify(c));
  const ids = await Promise.all(lines.map(async ([code]) => (await prod(code)).id));
  let o = await db.supplierOrder.findUniqueOrThrow({ where: { id: c.id } });
  const s = await svc.saveDraft(db, {
    orderId: c.id, version: o.version, orderDate: TODAY, note: '',
    lines: lines.map(([, qty, unitCode, price], i) => ({ productId: ids[i], qty, unitPrice: price ?? '', color: i === 0 ? 'RAL 7016' : '', ...(unitCode ? { unitCode } : {}) })),
  }, act(U.admin), { timeZone: TZ });
  assert.ok(s.ok, JSON.stringify(s));
  o = await db.supplierOrder.findUniqueOrThrow({ where: { id: c.id } });
  const a = await svc.approveAndSend(db, { orderId: c.id, version: o.version }, act(U.admin));
  assert.ok(a.ok, JSON.stringify(a));
  return c.id;
}
/** Kesin revizyonun satırları: kod → satır */
async function linesOf(id) {
  const rev = await db.supplierOrderRevision.findFirstOrThrow({ where: { orderId: id, finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
  return Object.fromEntries(rev.lines.map((l) => [l.code, l]));
}
/** Mal kabulü: q = { kod: adet } */
async function receive(id, q, { who = 'admin', requestKey = key(), receivedOn = TODAY, reference = null, dbx = db } = {}) {
  const lines = await linesOf(id);
  const quantities = Object.fromEntries(Object.entries(q).map(([code, n]) => [lines[code].id, String(n)]));
  return recv.receiveGoods(dbx, { orderId: id, receivedOn, reference, requestKey, quantities }, act(U[who]), { timeZone: TZ });
}
const level = async (code) => (await stockLevels(db, [(await prod(code)).id])).get((await prod(code)).id) ?? 0;
const receiptJobs = (orderId) => db.notificationOutbox.findMany({ where: { type: RECEIPT_EMAIL, payload: { path: ['supplierOrderId'], equals: orderId } }, orderBy: { createdAt: 'asc' } });
const counts = async (id) => ({
  receipts: await db.supplierReceipt.count({ where: { orderId: id } }),
  lines: await db.supplierReceiptLine.count({ where: { receipt: { orderId: id } } }),
  moves: await db.stockMovement.count({ where: { supplierReceipt: { orderId: id } } }),
  jobs: (await receiptJobs(id)).length,
});

/** Sahte e-posta taşıyıcısı: fail(adres) → hata nesnesi ya da null */
function transport(fail = () => null) {
  const sent = [];
  return { sent, async sendMail(m) { const e = fail(m.to); if (e) throw e; sent.push(m); return { messageId: `<r${sent.length}@test>` }; } };
}
const dispatch = (t, now = new Date()) => dispatchReceiptEmails(db, { transport: t, from: 'takip@gkh.test', now, log: () => {} });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db); // roller, profil kataloğu (korkuluk paket içerikleri: profiller 6 m / bar)
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA' } });
  const mk = (k, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${k}@mal-kabul.test`, name: k, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } }).then((u) => { U[k] = u; });
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

dbTest('1) tam mal kabulü: tek işlemde kabul + kopya satırlar + GIRIS hareketleri + TESLIM_ALINDI + tek e-posta işi + denetim; sipariş / onay stoğu değiştirmez', offline(async () => {
  const s0 = [await level('RM12-7016'), await level('GK15')];
  const id = await sentOrder([['RM12-7016', 40], ['GK15', 5]]);
  // Sipariş oluşturma + onay / gönderim kuyruğu stoğu değiştirmedi
  assert.deepEqual([await level('RM12-7016'), await level('GK15')], s0);
  const r = await receive(id, { 'RM12-7016': 40, GK15: 5 }, { reference: 'AVIZ 77' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.complete, true);
  assert.equal(r.seq, 1);
  assert.deepEqual([await level('RM12-7016'), await level('GK15')], [s0[0] + 40, s0[1] + 5]);
  const o = await db.supplierOrder.findUniqueOrThrow({ where: { id } });
  assert.equal(o.status, 'TESLIM_ALINDI');
  assert.ok(o.receivedAt);
  const rec = await db.supplierReceipt.findUniqueOrThrow({ where: { id: r.receiptId }, include: { lines: { orderBy: { sortOrder: 'asc' } }, stockMoves: true } });
  assert.equal(rec.reference, 'AVIZ 77');
  assert.equal(rec.complete, true);
  assert.deepEqual(rec.lines.map((l) => [l.code, l.qty, l.unitCode, l.color, l.lengthM?.toString() ?? null]), [['RM12-7016', 40, 'BARA', 'RAL 7016', '6'], ['GK15', 5, 'CUTII', null, null]]);
  assert.deepEqual(rec.stockMoves.map((m) => [m.kind, m.qty, m.orderId]).sort(), [['GIRIS', 40, null], ['GIRIS', 5, null]].sort());
  assert.ok(rec.stockMoves.every((m) => m.note === `${o.orderNo} — mal kabul #1` && m.createdById === U.admin.id));
  assert.deepEqual(await counts(id), { receipts: 1, lines: 2, moves: 2, jobs: 1 });
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SUPPLIER_GOODS_RECEIVED', entityId: id } });
  assert.equal(audit.details.complete, true);
  assert.equal(audit.details.stockMoves, 2);
  // Kapanan siparişte yeni kabul yok; beklenen tedarik boş
  assert.equal((await receive(id, { GK15: 1 })).code, 'NOT_ALLOWED');
  const exp = await svc.expectedSupplyMap(db);
  assert.equal(exp.get((await prod('GK15')).id)?.qty ?? 0, 0);
}));

dbTest('2) çoklu kısmi teslimat (farklı günler): her teslimat ayrı kayıt; önceki / kalan doğru; beklenen tedarik kalan kadar; son teslimat siparişi kapatır', offline(async () => {
  const s0 = await level('FBL90-7016');
  const id = await sentOrder([['FBL90-7016', 100]]);
  const pid = (await prod('FBL90-7016')).id;
  assert.equal((await svc.expectedSupplyMap(db)).get(pid).qty, 100);
  const day = (n) => { const d = new Date(`${TODAY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const a = await receive(id, { 'FBL90-7016': 30 }, { receivedOn: day(2) });
  const b = await receive(id, { 'FBL90-7016': 50 }, { receivedOn: day(1) });
  assert.deepEqual([a.seq, a.complete, b.seq, b.complete], [1, false, 2, false]);
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id } })).status, 'GONDERIM_BEKLIYOR');
  const view = await recv.loadReceipts(db, id);
  assert.deepEqual(view.lines.map((l) => [l.code, l.ordered, l.received, l.remaining]), [['FBL90-7016', 100, 80, 20]]);
  assert.equal((await svc.expectedSupplyMap(db)).get(pid).qty, 20, 'teslim alınan kısım beklenen tedarikte ikinci kez sayılmaz');
  assert.equal(await level('FBL90-7016'), s0 + 80);
  const c = await receive(id, { 'FBL90-7016': 20 });
  assert.deepEqual([c.seq, c.complete], [3, true]);
  assert.equal(await level('FBL90-7016'), s0 + 100);
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id } })).status, 'TESLIM_ALINDI');
  assert.deepEqual(await counts(id), { receipts: 3, lines: 3, moves: 3, jobs: 3 });
  const recs = await db.supplierReceipt.findMany({ where: { orderId: id }, orderBy: { seq: 'asc' } });
  assert.deepEqual(recs.map((r) => r.receivedOn.toISOString().slice(0, 10)), [day(2), day(1), TODAY]);
}));

dbTest('3) kalanı aşan miktar reddedilir; hiçbir şey yazılmaz (kabul, stok, e-posta işi, sürüm)', offline(async () => {
  const id = await sentOrder([['RM16-7016', 100], ['GK15', 10]]);
  assert.ok((await receive(id, { 'RM16-7016': 30 })).ok);
  const s = await level('RM16-7016');
  const before = await counts(id);
  const v = (await db.supplierOrder.findUniqueOrThrow({ where: { id } })).version;
  const r = await receive(id, { 'RM16-7016': 71, GK15: 1 });
  assert.deepEqual(r, { ok: false, code: 'OVER_REMAINING', line: 'RM16-7016', remaining: 70 });
  assert.deepEqual(await counts(id), before);
  assert.equal(await level('RM16-7016'), s);
  assert.equal((await db.supplierOrder.findUniqueOrThrow({ where: { id } })).version, v);
  // Tam kalan kabul edilir
  assert.ok((await receive(id, { 'RM16-7016': 70 })).ok);
  // Boş kabul, geçersiz miktar, gelecek tarih
  assert.equal((await receive(id, { GK15: 0 })).code, 'EMPTY');
  assert.equal((await receive(id, { GK15: 1 }, { receivedOn: '2999-01-01' })).code, 'DATE_FUTURE');
}));

dbTest('4) aynı isteğin tekrarı (çift tıklama / yeniden gönderilen form): ilk kabul döner, ikinci kabul ve ikinci stok girişi yok', offline(async () => {
  const id = await sentOrder([['RM12-ELX', 20]]);
  const s = await level('RM12-ELX');
  const k = key();
  const a = await receive(id, { 'RM12-ELX': 10 }, { requestKey: k });
  const b = await receive(id, { 'RM12-ELX': 10 }, { requestKey: k });
  assert.equal(a.ok, true);
  assert.deepEqual(b, { ok: true, duplicate: true, receiptId: a.receiptId, seq: 1, complete: false });
  // Aynı anahtar eşzamanlı da bir kez yazılır
  const k2 = key();
  const [c, d] = await Promise.all([receive(id, { 'RM12-ELX': 5 }, { requestKey: k2 }), receive(id, { 'RM12-ELX': 5 }, { requestKey: k2 })]);
  assert.equal(c.receiptId, d.receiptId);
  assert.equal([c, d].filter((x) => x.duplicate).length, 1);
  assert.equal(await level('RM12-ELX'), s + 15);
  assert.deepEqual(await counts(id), { receipts: 2, lines: 2, moves: 2, jobs: 2 });
  // Başka siparişte aynı anahtar → reddedilir
  const other = await sentOrder([['RM12-ELX', 3]]);
  assert.deepEqual(await receive(other, { 'RM12-ELX': 1 }, { requestKey: k }), { ok: false, code: 'CONFLICT' });
}));

dbTest('5) eşzamanlı iki farklı kabul: toplam sipariş edileni asla geçmez — biri kabul edilir, öbürü kalanı aşar', offline(async () => {
  const id = await sentOrder([['MR23-7016', 100]]);
  const s = await level('MR23-7016');
  const res = await Promise.all([receive(id, { 'MR23-7016': 60 }), receive(id, { 'MR23-7016': 60 })]);
  assert.equal(res.filter((r) => r.ok).length, 1, JSON.stringify(res));
  assert.equal(res.find((r) => !r.ok).code, 'OVER_REMAINING');
  assert.equal(res.find((r) => !r.ok).remaining, 40);
  assert.equal(await level('MR23-7016'), s + 60);
  // Kalanı tam dolduran iki eşzamanlı kabul (40 + 40): yine yalnızca biri
  const res2 = await Promise.all([receive(id, { 'MR23-7016': 40 }), receive(id, { 'MR23-7016': 40 })]);
  assert.equal(res2.filter((r) => r.ok).length, 1);
  assert.equal(await level('MR23-7016'), s + 100);
  const got = await db.supplierReceiptLine.aggregate({ where: { receipt: { orderId: id } }, _sum: { qty: true } });
  assert.equal(got._sum.qty, 100);
  assert.deepEqual(await counts(id), { receipts: 2, lines: 2, moves: 2, jobs: 2 });
}));

dbTest('6) işlem ortasında hata (stok yazıldıktan sonra): her şey geri alınır — kabul, satır, stok hareketi, sipariş durumu / sürümü, e-posta işi yok', offline(async () => {
  const id = await sentOrder([['MR23-ELX', 12]]);
  const s = await level('MR23-ELX');
  const o0 = await db.supplierOrder.findUniqueOrThrow({ where: { id } });
  const before = await counts(id);
  // Kuyruk yazımı (stok hareketlerinden SONRA) hata verir
  const wrap = (tx) => new Proxy(tx, {
    get(t, k) {
      if (k === 'notificationOutbox') return { create: async () => { throw new Error('test: kuyruk yazılamadı'); } };
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const failing = new Proxy(db, {
    get(t, k) {
      if (k === '$transaction') return (fn, o) => t.$transaction((tx) => fn(wrap(tx)), o);
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  await assert.rejects(receive(id, { 'MR23-ELX': 12 }, { dbx: failing }), /kuyruk yazılamadı/);
  assert.deepEqual(await counts(id), before);
  assert.equal(await level('MR23-ELX'), s);
  const o1 = await db.supplierOrder.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([o1.status, o1.version, o1.receivedAt], [o0.status, o0.version, null]);
  assert.equal(await db.auditLog.count({ where: { action: 'SUPPLIER_GOODS_RECEIVED', entityId: id } }), 0);
  // Aynı kabul sonra sorunsuz yapılabilir
  assert.ok((await receive(id, { 'MR23-ELX': 12 })).ok);
  assert.equal(await level('MR23-ELX'), s + 12);
}));

dbTest('7) yetki: satış, çizim, denetimci, müşteri reddedilir (hiçbir şey yazılmaz); yönetici yardımcısı kabul yapabilir', offline(async () => {
  const id = await sentOrder([['FBL115-7016', 10]]);
  const s = await level('FBL115-7016');
  for (const who of ['sales', 'drawer', 'inspector', 'cust']) assert.deepEqual(await receive(id, { 'FBL115-7016': 1 }, { who }), { ok: false, code: 'FORBIDDEN' }, who);
  assert.deepEqual(await counts(id), { receipts: 0, lines: 0, moves: 0, jobs: 0 });
  assert.equal(await level('FBL115-7016'), s);
  assert.ok((await receive(id, { 'FBL115-7016': 4 }, { who: 'assistant' })).ok);
  assert.equal(await level('FBL115-7016'), s + 4);
}));

dbTest('8) stok tutarlılığı ve kurallar: hareket = kabul satırı; birim uyumsuzsa reddedilir (dönüşüm yok); taslak revizyon / iptal / kabulden sonra revizyon; kabul değişmez', offline(async () => {
  const id = await sentOrder([['FBL115-ELX', 30], ['SPIGOTI', 8]]);
  const ids = [(await prod('FBL115-ELX')).id, (await prod('SPIGOTI')).id];
  const before = await stockLevels(db, ids);
  await receive(id, { 'FBL115-ELX': 10 });
  await receive(id, { 'FBL115-ELX': 5, SPIGOTI: 8 });
  const after = await stockLevels(db, ids);
  const moves = await db.stockMovement.findMany({ where: { supplierReceipt: { orderId: id } } });
  const lines = await db.supplierReceiptLine.findMany({ where: { receipt: { orderId: id } } });
  assert.equal(moves.length, lines.length);
  for (const pid of ids) {
    const m = moves.filter((x) => x.productId === pid).reduce((a, x) => a + x.qty, 0);
    const l = lines.filter((x) => x.productId === pid).reduce((a, x) => a + x.qty, 0);
    assert.equal(m, l);
    assert.equal((after.get(pid) ?? 0) - (before.get(pid) ?? 0), l, 'kullanılabilir stok = önceki + fiilen teslim alınan');
  }
  assert.ok(moves.every((m) => m.kind === 'GIRIS' && m.qty > 0));
  // Kabulden sonra yeni revizyon açılamaz
  const o = await db.supplierOrder.findUniqueOrThrow({ where: { id } });
  assert.deepEqual(await svc.startRevision(db, { orderId: id, version: o.version }, act(U.admin)), { ok: false, code: 'HAS_RECEIPTS' });
  // Kabul ve satırları değişmez / silinmez (tetikleyici)
  await assert.rejects(db.supplierReceipt.updateMany({ where: { orderId: id }, data: { reference: 'x' } }), /immutable/);
  await assert.rejects(db.supplierReceiptLine.deleteMany({ where: { receipt: { orderId: id } } }), /immutable/);
  // Birim stok birimiyle aynı değil → o satır alınmaz (tahmini dönüşüm yok)
  const mis = await sentOrder([['GK15', 3, 'BUCATI']]);
  assert.deepEqual(await receive(mis, { GK15: 1 }), { ok: false, code: 'UNIT_MISMATCH', line: 'GK15' });
  // Açık revizyon taslağı varken kabul yok; iptal edilmiş siparişte kabul yok
  const dr = await sentOrder([['AD45', 4]]);
  const v = (await db.supplierOrder.findUniqueOrThrow({ where: { id: dr } })).version;
  assert.ok((await svc.startRevision(db, { orderId: dr, version: v }, act(U.admin))).ok);
  assert.equal((await receive(dr, { AD45: 1 })).code, 'HAS_DRAFT');
  assert.ok((await svc.cancelOrder(db, { orderId: dr, reason: 'test' }, act(U.admin))).ok);
  assert.equal((await receive(dr, { AD45: 1 })).code, 'NOT_ALLOWED');
  // "Kalanı beklemeden kapat" stoğu değiştirmez
  const cl = await sentOrder([['AD45', 6]]);
  await receive(cl, { AD45: 2 });
  const sAd = await level('AD45');
  assert.ok((await svc.markReceived(db, { orderId: cl }, act(U.admin))).ok);
  assert.equal(await level('AD45'), sAd);
  assert.equal((await receive(cl, { AD45: 1 })).code, 'NOT_ALLOWED');
}));

/** PDF içerik akışlarındaki metinler (test/commercial.test.js ile aynı okuyucu) */
const REVERSE = Object.fromEntries(['Regular', 'Bold'].map((k) => [k, new Map(FONTS[k].map.map(([cp, gid]) => [gid, cp]))]));
function pdfText(pdf) {
  const out = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  const s = pdf.toString('latin1');
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length;
    let ops;
    try { ops = zlib.inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1'); } catch { continue; }
    for (const t of ops.matchAll(/\/(F1|F2) [\d.]+ Tf [\d.-]+ [\d.-]+ Td <([0-9a-f]*)> Tj/g)) {
      const map = REVERSE[t[1] === 'F2' ? 'Bold' : 'Regular'];
      out.push((t[2].match(/.{4}/g) ?? []).map((h) => String.fromCodePoint(map.get(parseInt(h, 16)) ?? 63)).join(''));
    }
  }
  return out;
}

dbTest('9) INTRAREA MARFĂ belgesi: yalnızca teslim alınan miktarlar; alış fiyatı / tutar / para birimi yok; yeniden üretilince aynı', offline(async () => {
  const id = await sentOrder([['RM12-7016', 50, null, '12.3456'], ['GK15', 9, null, '987.65']]);
  const r = await receive(id, { 'RM12-7016': 20 }, { reference: 'AVZ-9' });
  const a = await buildReceiptPdf(db, r.receiptId);
  const text = pdfText(a.buf).join('\n');
  for (const s of ['INTRAREA MARFĂ', 'Profil Tedarik', a.orderNo, 'AVZ-9', 'RM12-7016', 'Culoare: RAL 7016', 'Lungime: 6 m', '20 bare']) assert.ok(text.includes(s), s);
  for (const s of ['12,3456', '12.3456', '246', '987', 'EUR', 'GK15']) assert.ok(!text.includes(s), s);
  const b = await buildReceiptPdf(db, r.receiptId);
  assert.deepEqual(pdfText(b.buf), pdfText(a.buf));
  assert.equal(await buildReceiptPdf(db, 'yok'), null);
}));

dbTest('10) e-posta: hata stoğu geri almaz; alıcı başına bir ileti; bir alıcının hatası öbürünü engellemez; yarıda kalan alıcıya yeniden gönderilmez; mükerrer yok', offline(async () => {
  const id = await sentOrder([['RM16-ELX', 10]]);
  const s0 = await level('RM16-ELX');
  const r = await receive(id, { 'RM16-ELX': 10 });
  const s1 = await level('RM16-ELX');
  assert.equal(s1, s0 + 10);
  const [job] = await receiptJobs(id);
  // Başka kabullerin işleri bu testten önce gönderilir (yalnızca bu işi izleriz)
  const only = async (t, now) => {
    await db.notificationOutbox.updateMany({ where: { type: RECEIPT_EMAIL, status: 'PENDING', NOT: { id: job.id } }, data: { status: 'SKIPPED' } });
    return dispatch(t, now);
  };
  // SMTP yok → hiçbir şey olmaz
  assert.deepEqual(await dispatchReceiptEmails(db, { transport: null, from: 'x@test' }), { sent: 0, failed: 0, retried: 0, skipped: 0 });
  // 1. tur: depo1 bağlanılamadı (kesin gitmedi), depo2 gönderildi
  const t1 = transport((to) => (to === RECIPIENTS[0] ? Object.assign(new Error('connect ECONNREFUSED'), { command: 'CONN' }) : null));
  const now = new Date();
  assert.deepEqual(await only(t1, now), { sent: 0, failed: 0, retried: 1, skipped: 0 });
  assert.deepEqual(t1.sent.map((m) => m.to), [RECIPIENTS[1]]);
  assert.equal(t1.sent[0].attachments[0].filename, `Intrare-Marfa-${(await db.supplierOrder.findUniqueOrThrow({ where: { id } })).orderNo.replace(/[^A-Za-z0-9_]+/g, '-')}-1.pdf`);
  assert.equal(t1.sent[0].attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  assert.match(t1.sent[0].subject, /Intrare marfă/);
  assert.equal(await level('RM16-ELX'), s1, 'e-posta hatası stoğu geri almaz');
  let j = await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } });
  assert.deepEqual([j.status, j.lastError, j.payload.sentTo], ['PENDING', 'SMTP', [RECIPIENTS[1]]]);
  // 2. tur (bekleme süresi doldu): yalnızca depo1'e gider; depo2'ye ikinci ileti YOK
  const t2 = transport();
  assert.deepEqual(await only(t2, new Date(now.getTime() + 3_600_000)), { sent: 1, failed: 0, retried: 0, skipped: 0 });
  assert.deepEqual(t2.sent.map((m) => m.to), [RECIPIENTS[0]]);
  j = await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(j.status, 'SENT');
  assert.deepEqual(j.payload.sentTo.sort(), [...RECIPIENTS].sort());
  // 3. tur: gönderilmiş iş yeniden gönderilmez
  const t3 = transport();
  await only(t3, new Date(now.getTime() + 7_200_000));
  assert.equal(t3.sent.length, 0);
  // Yarıda kalan gönderim (işçi çöktü): o alıcı "belirsiz" sayılır, ona yeniden gönderilmez; öbürüne gider
  const r2 = await receive(await sentOrder([['RM16-ELX', 2]]), { 'RM16-ELX': 2 });
  assert.ok(r2.ok);
  const job2 = (await db.notificationOutbox.findMany({ where: { type: RECEIPT_EMAIL, payload: { path: ['receiptId'], equals: r2.receiptId } } }))[0];
  await db.notificationOutbox.update({ where: { id: job2.id }, data: { payload: { ...job2.payload, sending: RECIPIENTS[0] } } });
  await db.notificationOutbox.updateMany({ where: { type: RECEIPT_EMAIL, status: 'PENDING', NOT: { id: job2.id } }, data: { status: 'SKIPPED' } });
  const t4 = transport();
  await dispatch(t4, new Date(now.getTime() + 7_200_000));
  assert.deepEqual(t4.sent.map((m) => m.to), [RECIPIENTS[1]]);
  const j2 = await db.notificationOutbox.findUniqueOrThrow({ where: { id: job2.id } });
  assert.deepEqual([j2.status, j2.lastError, j2.payload.unknown, j2.payload.sentTo], ['SENT', 'UNKNOWN', [RECIPIENTS[0]], [RECIPIENTS[1]]]);
  // Kalıcı ret (550) tekrar tekrar: en çok 8 tur, sonra FAILED; stok hiç değişmez
  const r3 = await receive(await sentOrder([['RM16-ELX', 1]]), { 'RM16-ELX': 1 });
  const job3 = (await db.notificationOutbox.findMany({ where: { type: RECEIPT_EMAIL, payload: { path: ['receiptId'], equals: r3.receiptId } } }))[0];
  const s3 = await level('RM16-ELX');
  const t5 = transport(() => Object.assign(new Error('550 rejected'), { responseCode: 550, command: 'RCPT TO' }));
  for (let i = 1; i <= 8; i++) {
    await db.notificationOutbox.updateMany({ where: { type: RECEIPT_EMAIL, status: 'PENDING', NOT: { id: job3.id } }, data: { status: 'SKIPPED' } });
    await dispatch(t5, new Date(now.getTime() + i * 86_400_000));
  }
  const j3 = await db.notificationOutbox.findUniqueOrThrow({ where: { id: job3.id } });
  assert.deepEqual([j3.status, j3.lastError, j3.attempts], ['FAILED', 'SMTP', 8]);
  assert.equal(await level('RM16-ELX'), s3);
  assert.equal(await db.supplierReceipt.count({ where: { id: r3.receiptId } }), 1);
}));

dbTest('11) 3.86.1 regresyonu: profil siparişi silinince yalnızca o siparişten düşülen miktar iade edilir; mal kabulü girişleri iadeye karışmaz', offline(async () => {
  // Depoya gönderilmiş profil siparişi (GK15 × 3 stoktan düşüldü)
  const products = await db.profileProduct.findMany({ where: { code: { in: ['GK15'] } }, include: { category: true } });
  const items = profileOrderItems([{ productId: products[0].id, qty: 3 }], products);
  const next = await suggestNextNo(db, firm.id, 'PROFILE_ORDER');
  const created = await createProfileOrder(db, { actor: act(U.cust), firm, title: null, requestedNo: next, suggestedNo: next, items: items.items });
  const run = (action, who, payload = {}) => runProfileAction(db, { orderId: created.id, action, actor: act(U[who]), payload });
  let o = await db.order.findUniqueOrThrow({ where: { id: created.id }, include: { offers: { include: { lines: true } } } });
  await run('send_profile_offer', 'admin', { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '10' })) });
  o = await db.order.findUniqueOrThrow({ where: { id: created.id }, include: { offers: { orderBy: { createdAt: 'desc' } } } });
  await run('approve_profile_offer', 'cust', { offerId: o.offers[0].id, pickupDate: earliestPickup({ now: new Date(Date.now() + 5 * 60_000) }), phone: '0723000000', plate: 'B 1 ABC' });
  await run('send_to_warehouse', 'admin');
  // Depo e-postası gönderilir (kuyrukta depo işi varken silme BUSY olur — karar 281); sahte taşıyıcı, .test alıcılar
  await dispatchWarehouseEmails(db, { transport: { sendMail: async () => ({}) }, from: 'x@test', appUrl: 'https://takip.test' });
  const sDeducted = await level('GK15');
  // Sonra tedarikçiden GK15 × 5 teslim alınır
  const sid = await sentOrder([['GK15', 5]]);
  assert.ok((await receive(sid, { GK15: 5 })).ok);
  assert.equal(await level('GK15'), sDeducted + 5);
  // Profil siparişi silinir (FGO doğrulaması sahte): yalnızca 3 iade edilir
  const order = await db.order.findUniqueOrThrow({ where: { id: created.id } });
  const rm = await removeOrder(db, { orderId: created.id, confirmNo: order.orderNo, actor: act(U.admin), fgoCheck: async () => ({ ok: true, at: new Date() }) });
  assert.equal(rm.ok, true, JSON.stringify(rm));
  assert.deepEqual(rm.stockReturned.map((x) => [x.code, x.qty]), [['GK15', 3]]);
  assert.equal(await level('GK15'), sDeducted + 5 + 3);
  // Mal kabulü hareketleri silinmedi / değişmedi
  assert.equal(await db.stockMovement.count({ where: { supplierReceipt: { orderId: sid } } }), 1);
}));
