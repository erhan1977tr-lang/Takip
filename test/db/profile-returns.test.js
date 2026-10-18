// DÜZELTME 10 M8 (3.99.0) — profil iadesi, gerçek PostgreSQL ile: yalnızca yönetici; teslimden önce açılmaz; kısmi + tam iade,
// aynı mal iki kez iade edilmez (eşzamanlı istek dahil); iade açılınca stok DEĞİŞMEZ; depo bağlantısıyla teslim → sağlam stoğa,
// hasarlı bloke stoğa (bir kez); depo e-postaları (açılış + teslim, alıcı başına bir kez, bağlantı yalnızca özetle saklanır);
// mali karşılık yalnızca niyet (ödeme yoksa seçilmez, ödeme varsa zorunlu), gerçek iade ayrı işaret; FGO çağrısı YOK.
// Gerçek e-posta yok (sahte taşıyıcı, .test adresleri), ağ yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-iade-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const { suggestNextNo } = await import('../../server/orders/create.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction } = await import('../../server/profile/transitions.js');
const { addStockMovement, stockLevels, blockedLevels } = await import('../../server/profile/stock.js');
const { earliestPickup, depotToday, dayKeyOf } = await import('../../server/profile/dates.js');
const { saveWarehouseSettings } = await import('../../server/profile/warehouse.js');
const ret = await import('../../server/profile/returns.js');
const { dispatchReturnEmails } = await import('../../server/profile/returns-mail.js');

let db, firm;
const people = {};
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runProfileAction(db, { orderId, action, actor: actor(people[who]), payload });
const load = (id) => db.order.findUniqueOrThrow({ where: { id }, include: { profile: true, offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });
const key = () => crypto.randomUUID().replace(/-/g, '');
const A = () => actor(people.admin);
const DEPOT = ['depo1@iade.test', 'depo2@iade.test'];
function transport() {
  const sent = [];
  return { sent, async sendMail(m) { sent.push(m); return { messageId: `<i${sent.length}@test>` }; } };
}
const dispatch = (t) => dispatchReturnEmails(db, { transport: t, from: 'takip@gkh.test', appUrl: 'https://takip.test', log: () => {} });
const level = async (code) => {
  const p = await db.profileProduct.findUniqueOrThrow({ where: { code } });
  return { stock: (await stockLevels(db, [p.id])).get(p.id) ?? 0, blocked: (await blockedLevels(db, [p.id])).get(p.id) ?? 0 };
};

/** Teslim edilmiş profil siparişi: [kod, adet][] · paid: ödeme günü işaretli */
async function deliveredOrder(lines, { paid = false } = {}) {
  const products = await db.profileProduct.findMany({ where: { code: { in: lines.map((l) => l[0]) } }, include: { category: true } });
  const byCode = new Map(products.map((p) => [p.code, p.id]));
  const items = profileOrderItems(lines.map(([code, qty]) => ({ productId: byCode.get(code), qty })), products);
  assert.ok(items.ok);
  const next = await suggestNextNo(db, firm.id, 'PROFILE_ORDER');
  const { id } = await createProfileOrder(db, { actor: actor(people.cust), firm, title: null, requestedNo: next, suggestedNo: next, items: items.items });
  let o = await load(id);
  await run(id, 'send_profile_offer', 'admin', { lines: o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: '10' })) });
  o = await load(id);
  await run(id, 'approve_profile_offer', 'cust', { offerId: o.offers[0].id, pickupDate: earliestPickup({ now: new Date(Date.now() + 5 * 60_000) }), phone: '0723000000', plate: 'B 1 ABC' });
  await run(id, 'mark_proforma', 'admin', { proformaNo: 'PF-1' });
  if (paid) await run(id, 'mark_paid', 'admin', { paidDate: depotToday() });
  else await run(id, 'send_to_warehouse', 'admin');
  await run(id, 'mark_delivered', 'admin');
  return id;
}
const lineIds = async (orderId) => {
  const o = await load(orderId);
  const offer = o.offers.find((x) => x.id === o.profile.approvedOfferId);
  return Object.fromEntries(await Promise.all(offer.lines.map(async (l) => [(await db.profileProduct.findUniqueOrThrow({ where: { id: l.profileProductId } })).code, l.id])));
};

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'İade Cam', prefix: 'IAD' } });
  const mk = (k, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${k}@iade.test`, name: k, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } }).then((u) => { people[k] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('assist', 'YONETICI_YARDIMCISI', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  for (const code of ['GK15', 'MC12']) {
    const p = await db.profileProduct.findUniqueOrThrow({ where: { code } });
    await addStockMovement(db, { productId: p.id, kind: 'GIRIS', qty: 100 }, A());
  }
  await saveWarehouseSettings(db, { recipients: DEPOT }, A());
});
after(async () => {
  await closeDb();
  fs.rmSync(UPLOAD, { recursive: true, force: true });
});

dbTest('iade: yalnızca yönetici; teslimden önce açılmaz; kısmi iade stoğu DEĞİŞTİRMEZ; aynı mal iki kez iade edilmez; form anahtarı', offline(async () => {
  const id = await deliveredOrder([['GK15', 5], ['MC12', 2]]);
  const L = await lineIds(id);
  for (const who of ['assist', 'sales', 'cust']) {
    assert.deepEqual(await ret.createReturn(db, { orderId: id, reason: 'x', quantities: { [L.GK15]: '1' }, requestKey: key() }, actor(people[who])), { ok: false, code: 'FORBIDDEN' }, who);
  }
  const before = await level('GK15');
  const k = key();
  const r1 = await ret.createReturn(db, { orderId: id, reason: 'hatalı renk', quantities: { [L.GK15]: '2' }, requestKey: k }, A());
  assert.deepEqual([r1.ok, r1.seq, r1.duplicate], [true, 1, false]);
  assert.deepEqual((await ret.createReturn(db, { orderId: id, reason: 'hatalı renk', quantities: { [L.GK15]: '2' }, requestKey: k }, A())).duplicate, true);
  assert.deepEqual(await level('GK15'), before, 'iade açılınca stok değişmez');
  const r = await db.profileReturn.findUniqueOrThrow({ where: { id: r1.id }, include: { lines: true } });
  assert.deepEqual([r.amount.toString(), r.currency, r.paid, r.financeAction, r.lines[0].unitPrice.toString()], ['20', 'EUR', false, null, '10']);
  // Kalan 3 → 4 istenemez; 3 olur
  assert.deepEqual(await ret.createReturn(db, { orderId: id, reason: 'x', quantities: { [L.GK15]: '4' }, requestKey: key() }, A()), { ok: false, code: 'OVER_RETURNABLE', index: 0 });
  // Eşzamanlı iki istek (2 + 2 > 3): yalnızca biri yazılır
  const both = await Promise.all([1, 2].map(() => ret.createReturn(db, { orderId: id, reason: 'yarış', quantities: { [L.GK15]: '2' }, requestKey: key() }, A())));
  assert.deepEqual(both.map((x) => (x.ok ? 'ok' : x.code)).sort(), ['OVER_RETURNABLE', 'ok']);
  const ov = await ret.returnOverview(db, id, A());
  assert.equal(ov.lines.find((l) => l.offerLineId === L.GK15).remaining, 1);
  // Ödeme yoksa mali karşılık seçilmez (gönderilse de yok sayılır); gerekçe zorunlu
  assert.equal((await ret.createReturn(db, { orderId: id, reason: '', quantities: { [L.MC12]: '1' }, requestKey: key() }, A())).code, 'REASON');
  const r3 = await ret.createReturn(db, { orderId: id, reason: 'tam', quantities: { [L.MC12]: '2' }, financeAction: 'REFUND', requestKey: key() }, A());
  assert.equal((await db.profileReturn.findUniqueOrThrow({ where: { id: r3.id } })).financeAction, null);
  // Geçmiş + denetim
  assert.ok(await db.orderEvent.findFirst({ where: { orderId: id, event: 'PROFILE_RETURN_OPENED', note: '#1' } }));
  assert.ok(await db.auditLog.findFirst({ where: { action: 'PROFILE_RETURN_OPENED', entityId: id } }));
  // Teslim edilmemiş sipariş
  const products = await db.profileProduct.findMany({ where: { code: 'GK15' }, include: { category: true } });
  const items = profileOrderItems([{ productId: products[0].id, qty: 1 }], products);
  const next = await suggestNextNo(db, firm.id, 'PROFILE_ORDER');
  const { id: fresh } = await createProfileOrder(db, { actor: actor(people.cust), firm, title: null, requestedNo: next, suggestedNo: next, items: items.items });
  assert.equal((await ret.createReturn(db, { orderId: fresh, reason: 'x', quantities: {}, requestKey: key() }, A())).code, 'NOT_DELIVERED');
}));

dbTest('iade: depo e-postası (alıcı başına bir kez, bağlantı yalnızca özet) → bağlantıyla teslim: sağlam stoğa, hasarlı bloke stoğa, bir kez; ikinci bildirim', offline(async () => {
  await dispatch(transport()); // önceki testin işleri
  const id = await deliveredOrder([['GK15', 4]]);
  const L = await lineIds(id);
  const r1 = await ret.createReturn(db, { orderId: id, reason: 'kırık', quantities: { [L.GK15]: '4' }, requestKey: key() }, A());
  const t = transport();
  const d1 = await dispatch(t);
  assert.equal(d1.sent, 1);
  assert.deepEqual(t.sent.map((m) => m.to).sort(), DEPOT);
  const link = /https:\/\/takip\.test\/depo-iade\/([A-Za-z0-9_-]+)/.exec(t.sent[0].text)?.[1];
  assert.ok(link, 'bağlantı');
  assert.match(t.sent[0].subject, /Retur deschis/);
  assert.doesNotMatch(t.sent[0].text, /10[.,]00|EUR|RON/, 'fiyat / tutar yok');
  const job = await db.notificationOutbox.findFirstOrThrow({ where: { type: ret.RETURN_EMAIL, payload: { path: ['returnId'], equals: r1.id } } });
  assert.equal(job.payload.token, null, 'bağlantının kendisi işten silindi');
  const row = await db.profileReturn.findUniqueOrThrow({ where: { id: r1.id } });
  assert.ok(row.depotTokenHash && row.depotTokenHash !== link);
  // İkinci tur: yeniden gönderim yok
  assert.equal((await dispatch(transport())).sent, 0);
  const before = await level('GK15');
  const r = await db.profileReturn.findUniqueOrThrow({ where: { id: r1.id }, include: { lines: true } });
  const lid = r.lines[0].id;
  // Fazla miktar reddedilir
  assert.equal((await ret.confirmReturnByToken(db, { token: link, quantities: { [lid]: { good: '3', damaged: '2' } } })).code, 'OVER');
  // Eşzamanlı iki onay: biri yazılır
  const both = await Promise.all([1, 2].map(() => ret.confirmReturnByToken(db, { token: link, quantities: { [lid]: { good: '3', damaged: '1' } } })));
  const codes = both.map((x) => (x.ok ? 'ok' : x.code)).sort();
  assert.ok(codes[1] === 'ok' && ['INVALID', 'NOT_OPEN'].includes(codes[0]), codes.join(','));
  const after = await level('GK15');
  assert.deepEqual([after.stock - before.stock, after.blocked - before.blocked], [3, 1]);
  assert.equal((await db.stockMovement.count({ where: { profileReturnId: r1.id } })), 1);
  assert.equal((await db.blockedStockMovement.count({ where: { profileReturnId: r1.id } })), 1);
  assert.equal((await ret.findDepotReturn(db, link)), null, 'bağlantı kapandı');
  assert.equal((await ret.confirmReturnByToken(db, { token: link, quantities: { [lid]: { good: '1', damaged: '0' } } })).code, 'INVALID');
  const t2 = transport();
  assert.equal((await dispatch(t2)).sent, 1);
  assert.match(t2.sent[0].subject, /Retur recepționat/);
  assert.match(t2.sent[0].text, /bună: 3, deteriorată: 1/);
  assert.ok(await db.auditLog.findFirst({ where: { action: 'PROFILE_RETURN_RECEIVED', entityId: id } }));
}));

dbTest('iade: müşteri ödediyse mali karşılık zorunlu (niyet); gerçek iade ayrı işaret; iptal yalnızca depo teslimi olmadan; FGO çağrısı yok', offline(async () => {
  const id = await deliveredOrder([['MC12', 3]], { paid: true });
  const L = await lineIds(id);
  assert.equal((await ret.createReturn(db, { orderId: id, reason: 'x', quantities: { [L.MC12]: '1' }, requestKey: key() }, A())).code, 'FINANCE_ACTION');
  const r = await ret.createReturn(db, { orderId: id, reason: 'fazla', quantities: { [L.MC12]: '1' }, financeAction: 'REFUND', requestKey: key() }, A());
  assert.ok(r.ok);
  const row = await db.profileReturn.findUniqueOrThrow({ where: { id: r.id } });
  assert.deepEqual([row.paid, row.financeAction, row.refundDoneAt], [true, 'REFUND', null]);
  assert.equal((await ret.markRefundDone(db, { returnId: r.id, doneOn: dayKeyOf(depotToday()), reference: '' }, A())).code, 'REFERENCE');
  assert.ok((await ret.markRefundDone(db, { returnId: r.id, doneOn: dayKeyOf(depotToday()), reference: 'OP-123' }, A())).ok);
  assert.equal((await ret.markRefundDone(db, { returnId: r.id, doneOn: dayKeyOf(depotToday()), reference: 'OP-124' }, A())).code, 'ALREADY_DONE');
  // Mahsup niyeti: gerçek iade işareti yok
  const r2 = await ret.createReturn(db, { orderId: id, reason: 'mahsup', quantities: { [L.MC12]: '1' }, financeAction: 'OFFSET', requestKey: key() }, A());
  assert.equal((await ret.markRefundDone(db, { returnId: r2.id, doneOn: dayKeyOf(depotToday()), reference: 'X' }, A())).code, 'NOT_ALLOWED');
  // İptal: açıkken; sonra iade edilebilir miktar geri gelir
  assert.ok((await ret.cancelReturn(db, { returnId: r2.id, reason: 'yanlış' }, A())).ok);
  assert.equal((await ret.cancelReturn(db, { returnId: r2.id, reason: 'yanlış' }, A())).code, 'NOT_OPEN');
  const ov = await ret.returnOverview(db, id, A());
  assert.equal(ov.lines[0].remaining, 2);
  // Yönetici panelden teslim
  const full = await db.profileReturn.findUniqueOrThrow({ where: { id: r.id }, include: { lines: true } });
  assert.ok((await ret.confirmReturnReceipt(db, { returnId: r.id, quantities: { [full.lines[0].id]: { good: '1', damaged: '0' } } }, A())).ok);
  assert.equal((await db.profileReturn.findUniqueOrThrow({ where: { id: r.id } })).receivedVia, 'ADMIN');
  assert.equal(await db.notificationOutbox.count({ where: { type: { startsWith: 'FGO' }, orderId: id, createdAt: { gte: row.createdAt } } }), 0, 'FGO işi yazılmadı');
}));

dbTest('iade kayıtları değişmez (tetikleyici): silinmez, açılış verisi / teslim miktarı / bloke stok düzenlenmez, kapanış bir kez', offline(async () => {
  const id = await deliveredOrder([['MC12', 2]]);
  const L = await lineIds(id);
  const r = await ret.createReturn(db, { orderId: id, reason: 'koruma', quantities: { [L.MC12]: '2' }, requestKey: key() }, A());
  assert.ok(r.ok);
  const denied = (p) => assert.rejects(p, /immutable|once|only|append-only|closing|depot link|needs/);
  await denied(db.profileReturn.update({ where: { id: r.id }, data: { amount: '1' } }));
  await denied(db.profileReturn.delete({ where: { id: r.id } }));
  const line = await db.profileReturnLine.findFirstOrThrow({ where: { returnId: r.id } });
  await denied(db.profileReturnLine.update({ where: { id: line.id }, data: { qty: 1 } }));
  await denied(db.profileReturn.update({ where: { id: r.id }, data: { status: 'TESLIM_ALINDI' } }));
  assert.ok((await ret.confirmReturnReceipt(db, { returnId: r.id, quantities: { [line.id]: { good: '1', damaged: '1' } } }, A())).ok);
  await denied(db.profileReturnLine.update({ where: { id: line.id }, data: { goodQty: 2, damagedQty: 0 } }));
  await denied(db.profileReturn.update({ where: { id: r.id }, data: { status: 'IPTAL', cancelledAt: new Date(), cancelReason: 'x' } }));
  await denied(db.profileReturn.update({ where: { id: r.id }, data: { receivedNote: 'değişti' } }));
  const b = await db.blockedStockMovement.findFirstOrThrow({ where: { profileReturnId: r.id } });
  await denied(db.blockedStockMovement.update({ where: { id: b.id }, data: { qty: 5 } }));
  await denied(db.blockedStockMovement.delete({ where: { id: b.id } }));
  assert.equal((await db.profileReturnLine.findUniqueOrThrow({ where: { id: line.id } })).goodQty, 1);
}));

dbTest('iade: eksik teslim (2D son kural) — gelmeyen miktar stoğa girmez, yalnızca eksik kısım yeniden iade edilebilir; bağlantı tekrar kullanılamaz; iptal bağlantıyı kapatır; e-postada müşteri, sipariş, iade no, kod, ad, miktar, eksik', offline(async () => {
  await dispatch(transport()); // önceki testlerin işleri
  const id = await deliveredOrder([['AD45', 5]]);
  const L = await lineIds(id);
  const order = await db.order.findUniqueOrThrow({ where: { id } });
  const r1 = await ret.createReturn(db, { orderId: id, reason: 'fazla', quantities: { [L.AD45]: '5' }, requestKey: key() }, A());
  assert.ok(r1.ok);
  // Açık iade beklenen miktarla sayılır: ikinci iade açılamaz
  assert.equal((await ret.createReturn(db, { orderId: id, reason: 'x', quantities: { [L.AD45]: '1' }, requestKey: key() }, A())).code, 'OVER_RETURNABLE');
  const t = transport();
  await dispatch(t);
  const mail = t.sent[0];
  for (const s of [order.orderNo, 'İade Cam', `retur nr. ${r1.seq}`, 'AD45', '5 ']) assert.ok(`${mail.subject}\n${mail.text}`.includes(s), s);
  const link = /https:\/\/takip\.test\/depo-iade\/([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  assert.ok(link && link.length >= 32, 'tahmin edilemez bağlantı');
  const lid = (await db.profileReturnLine.findFirstOrThrow({ where: { returnId: r1.id } })).id;
  const before = await level('AD45');
  // Depo: 2 sağlam + 1 hasarlı geldi, 2 eksik
  assert.ok((await ret.confirmReturnByToken(db, { token: link, quantities: { [lid]: { good: '2', damaged: '1' } } })).ok);
  const after = await level('AD45');
  assert.deepEqual([after.stock - before.stock, after.blocked - before.blocked], [2, 1], 'eksik 2 stoğa girmez');
  // Aynı bağlantı tekrar: ikinci hareket yok
  assert.equal((await ret.confirmReturnByToken(db, { token: link, quantities: { [lid]: { good: '2', damaged: '0' } } })).code, 'INVALID');
  assert.deepEqual([await db.stockMovement.count({ where: { profileReturnId: r1.id } }), await db.blockedStockMovement.count({ where: { profileReturnId: r1.id } })], [1, 1]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'PROFILE_RETURN_RECEIVED', entityId: id }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual(audit.details.lines.map((l) => [l.good, l.damaged, l.missing]), [[2, 1, 2]]);
  // Teslim alınan iade gelen miktarla sayılır → yalnızca eksik 2 yeniden iade edilebilir
  const ov = await ret.returnOverview(db, id, A());
  assert.deepEqual([ov.lines[0].returned, ov.lines[0].remaining], [3, 2]);
  assert.equal((await ret.createReturn(db, { orderId: id, reason: 'kalan', quantities: { [L.AD45]: '3' }, requestKey: key() }, A())).code, 'OVER_RETURNABLE');
  const r2 = await ret.createReturn(db, { orderId: id, reason: 'kalan geldi', quantities: { [L.AD45]: '2' }, requestKey: key() }, A());
  assert.ok(r2.ok);
  // "Teslim alındı" e-postası eksik miktarı gösterir
  const t2 = transport();
  await dispatch(t2);
  const received = t2.sent.find((m) => /Retur recepționat/.test(m.subject));
  assert.match(received.text, /bună: 2, deteriorată: 1, lipsă: 2/);
  const opened2 = t2.sent.find((m) => /Retur deschis/.test(m.subject) && m.subject.includes(`retur nr. ${r2.seq}`));
  const link2 = /https:\/\/takip\.test\/depo-iade\/([A-Za-z0-9_-]+)/.exec(opened2.text)?.[1];
  assert.ok(await ret.findDepotReturn(db, link2));
  // İptal → bağlantı geçersiz, stok hiç değişmedi
  assert.ok((await ret.cancelReturn(db, { returnId: r2.id, reason: 'gelmeyecek' }, A())).ok);
  assert.equal(await ret.findDepotReturn(db, link2), null);
  const l2 = (await db.profileReturnLine.findFirstOrThrow({ where: { returnId: r2.id } })).id;
  assert.equal((await ret.confirmReturnByToken(db, { token: link2, quantities: { [l2]: { good: '2', damaged: '0' } } })).code, 'INVALID');
  assert.deepEqual(await level('AD45'), after);
  // Süresi dolan bağlantı geçersiz
  const r3 = await ret.createReturn(db, { orderId: id, reason: 'son', quantities: { [L.AD45]: '1' }, requestKey: key() }, A());
  const t3 = transport();
  await dispatch(t3);
  const link3 = /https:\/\/takip\.test\/depo-iade\/([A-Za-z0-9_-]+)/.exec(t3.sent.find((m) => m.subject.includes(`retur nr. ${r3.seq}`)).text)?.[1];
  assert.equal(await ret.findDepotReturn(db, link3, new Date(Date.now() + (ret.RETURN_LINK_DAYS + 1) * 86_400_000)), null);
}));
