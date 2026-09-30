// Profil siparişi (Aşama 6) — veritabanıyla uçtan uca iş kuralları.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';
import { resetEnvCache } from '../../server/env.js';

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-profil-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const { suggestNextNo } = await import('../../server/orders/create.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems } = await import('../../server/profile/rules.js');
const { runProfileAction, depotActor } = await import('../../server/profile/transitions.js');
const { runOrderAction } = await import('../../server/orders/transitions.js');
const { dispatchWarehouseEmails, findDepotOrder, hashToken } = await import('../../server/profile/warehouse.js');
const { stockLevels, addStockMovement } = await import('../../server/profile/stock.js');
const { dayDate, earliestPickup, localDay, nextWorkingDay } = await import('../../server/profile/dates.js');
const { orderScope } = await import('../../server/orders/scope.js');

let db;
const people = {};
let firm, otherFirm;
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const run = (orderId, action, who, payload = {}) => runProfileAction(db, { orderId, action, actor: actor(people[who]), payload });
const today = () => dayDate(localDay(new Date(), 'Europe/Bucharest'));

async function newProfileOrder(lines, f = firm) {
  const products = await db.profileProduct.findMany({ where: { code: { in: lines.map((l) => l[0]) } }, include: { category: true } });
  const byCode = new Map(products.map((p) => [p.code, p.id]));
  const items = profileOrderItems(lines.map(([code, qty]) => ({ productId: byCode.get(code), qty })), products);
  assert.ok(items.ok);
  const next = await suggestNextNo(db, f.id, 'PROFILE_ORDER');
  return createProfileOrder(db, { actor: actor(f.id === firm.id ? people.cust : people.other), firm: f, title: null, requestedNo: next, suggestedNo: next, items: items.items });
}
const load = (id) => db.order.findUniqueOrThrow({ where: { id }, include: { profile: true, offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
const pricesOf = (o, price = '10') => o.offers[0].lines.map((l) => ({ id: l.id, offerPrice: price }));

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db); // katalog seed'i: 4 kategori, 27 ürün
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA' } });
  otherFirm = await db.customer.create({ data: { name: 'Alegrad', prefix: 'ALE' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@profil.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { people[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  await mk('viewer', 'MUSTERI', firm.id, { canApprove: false });
  await mk('other', 'MUSTERI', otherFirm.id, { canApprove: true });
  await db.profileProduct.update({ where: { code: 'GK15' }, data: { listPrice: '12.50' } });
});
after(async () => {
  await closeDb();
  fs.rmSync(UPLOAD, { recursive: true, force: true });
});

dbTest('profil kataloğu seed: 4 kategori, 27 ürün, görseller veritabanında', async () => {
  assert.equal(await db.profileCategory.count(), 4);
  assert.equal(await db.profileProduct.count(), 27);
  assert.ok((await db.profileProduct.count({ where: { imageId: { not: null } } })) >= 25);
  assert.equal((await db.orderType.findUnique({ where: { code: 'PROFILE_ORDER' } })).active, true);
});

dbTest('numara: profil siparişi GLAP1, GLAP2 … cam numaralarından ayrı sıra; eşzamanlı 5 sipariş benzersiz', async () => {
  await db.order.create({ data: { orderNo: 'GLA1', customerOrderNo: 1, customerId: firm.id, createdById: people.cust.id } });
  const a = await newProfileOrder([['GK15', 3]]);
  assert.equal(a.orderNo, 'GLAP1');
  const results = await Promise.all(Array.from({ length: 5 }, () => newProfileOrder([['AD45', 1]])));
  assert.deepEqual(results.map((r) => r.customerOrderNo).sort((x, y) => x - y), [2, 3, 4, 5, 6]);
  assert.ok(results.every((r) => r.orderNo === `GLAP${r.customerOrderNo}`));
});

dbTest('profil: satış ve çizim görmez, işlem yapamaz; teklif dolu ve yönetimde açılır', async () => {
  const { id } = await newProfileOrder([['GK15', 3], ['AD45', 2]]);
  const o = await load(id);
  assert.equal(o.status, 'YENI');
  assert.equal(o.profile.stage, 'FIYAT_BEKLIYOR');
  assert.equal(o.offers[0].status, 'YONETIMDE');
  assert.deepEqual(o.offers[0].lines.map((l) => [l.poz, l.adet, l.offerPrice?.toString() ?? null]), [['GK15', 3, '12.5'], ['AD45', 2, null]]);
  for (const who of ['sales', 'drawer']) {
    assert.equal(await db.order.count({ where: { id, ...orderScope(people[who]) } }), 0, `${who} görmemeli`);
    assert.equal(await codeOf(run(id, 'save_profile_prices', who, { lines: [] })), 'NOT_FOUND');
  }
  assert.equal(await codeOf(run(id, 'send_profile_offer', 'inspector', { lines: [] })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(id, 'send_profile_offer', 'cust', { lines: [] })), 'NOT_ALLOWED');
  // Cam iş akışı profil siparişinde çalışmaz
  assert.equal(await codeOf(runOrderAction(db, { orderId: id, action: 'no_drawing', actor: actor(people.admin) })), 'WRONG_ORDER_TYPE');
});

dbTest('profil: fiyat eksikken gönderilemez; gönderilince müşteri görür; güncellenince eski sürüm onaylanamaz', async () => {
  const { id } = await newProfileOrder([['GK15', 3], ['AD45', 2]]);
  let o = await load(id);
  assert.equal(await codeOf(run(id, 'send_profile_offer', 'admin', { lines: [] })), 'PROFILE_PRICE_MISSING');
  assert.equal(await codeOf(run(id, 'save_profile_prices', 'admin', { lines: [{ id: o.offers[0].lines[1].id, offerPrice: 'abc' }] })), 'BAD_PRICE');
  await run(id, 'send_profile_offer', 'admin', { lines: [{ id: o.offers[0].lines[1].id, offerPrice: '4,5' }] });
  o = await load(id);
  assert.equal(o.profile.stage, 'TEKLIF_GONDERILDI');
  assert.equal(o.status, 'HAZIRLANIYOR');
  assert.equal(o.offers[0].status, 'GONDERILDI');
  assert.equal(o.offers[0].offerAmount.toString(), '46.5'); // 3×12,50 + 2×4,50
  const firstOffer = o.offers[0].id;
  await run(id, 'update_profile_offer', 'admin', { lines: pricesOf(o, '11') });
  o = await load(id);
  assert.equal(o.offers.length, 2, 'eski sürüm kalır');
  assert.equal(o.offers[1].offerAmount.toString(), '46.5', 'gönderilmiş teklif değişmez');
  const pickupDate = earliestPickup({ today: today() });
  assert.equal(await codeOf(run(id, 'approve_profile_offer', 'cust', { offerId: firstOffer, pickupDate, phone: '+40 723 000 000', plate: 'B 1 ABC' })), 'STALE_OFFER');
  assert.equal(await codeOf(run(id, 'approve_profile_offer', 'viewer', { offerId: o.offers[0].id, pickupDate, phone: '+40 723 000 000', plate: 'B 1 ABC' })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(id, 'approve_profile_offer', 'other', { offerId: o.offers[0].id, pickupDate, phone: '+40 723 000 000', plate: 'B 1 ABC' })), 'NOT_FOUND');
});

dbTest('profil: tam akış — onay, proforma, ödeme, depo (stok, e-posta, PDF, bağlantı), teslim, fatura', async () => {
  await addStockMovement(db, { productId: (await db.profileProduct.findUnique({ where: { code: 'GK15' } })).id, kind: 'GIRIS', qty: 10 }, actor(people.admin));
  const { id, orderNo } = await newProfileOrder([['GK15', 4], ['SPIGOTI', 20]]);
  let o = await load(id);
  await run(id, 'send_profile_offer', 'admin', { lines: pricesOf(o, '5') });
  o = await load(id);
  const sentId = o.offers[0].id;
  // Teslim bilgileri: hafta sonu ve erken gün reddedilir
  const sat = (() => { const d = today(); while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1); return d; })();
  assert.equal(await codeOf(run(id, 'approve_profile_offer', 'cust', { offerId: sentId, pickupDate: sat, phone: '+40 723 000 000', plate: 'B 1 ABC' })), 'PICKUP_WEEKEND');
  assert.equal(await codeOf(run(id, 'approve_profile_offer', 'cust', { offerId: sentId, pickupDate: today(), phone: '+40 723 000 000', plate: 'B 1 ABC' })), 'PICKUP_TOO_EARLY');
  assert.equal(await codeOf(run(id, 'approve_profile_offer', 'cust', { offerId: sentId, pickupDate: earliestPickup({ today: today() }), phone: 'x', plate: 'B 1 ABC' })), 'BAD_PHONE');
  await run(id, 'approve_profile_offer', 'cust', { offerId: sentId, pickupDate: earliestPickup({ today: today() }), phone: '+40 723 000 000', plate: 'b 1 abc' });
  o = await load(id);
  assert.equal(o.profile.stage, 'ONAYLANDI');
  assert.equal(o.profile.vehiclePlate, 'B 1 ABC');
  assert.equal(o.profile.approvedOfferId, sentId);
  await run(id, 'update_pickup', 'cust', { plate: 'IF 22 XYZ' });
  assert.equal(await codeOf(run(id, 'mark_paid', 'admin', { paidDate: new Date(Date.now() + 3 * 86_400_000) })), 'PAID_IN_FUTURE');
  await run(id, 'mark_proforma', 'admin', { proformaNo: 'PF-123' });
  // Ödeme teyidi → sipariş hemen depoya; alış günü ödemeden önceki bir güne ayarlanmışsa ilk iş gününe kayar
  await db.profileOrder.update({ where: { orderId: id }, data: { pickupDate: today() } });
  const paid = await run(id, 'mark_paid', 'admin', { paidDate: today() });
  assert.equal(paid.result.moved, true);
  o = await load(id);
  assert.equal(o.profile.stage, 'DEPODA');
  assert.equal(o.profile.paidAt.toISOString().slice(0, 10), today().toISOString().slice(0, 10));
  assert.ok(o.profile.warehouseSentAt);
  assert.equal(o.profile.pickupDate.toISOString().slice(0, 10), nextWorkingDay(today()).toISOString().slice(0, 10));
  assert.equal(await db.notificationOutbox.count({ where: { orderId: id, type: 'WAREHOUSE_EMAIL', status: 'PENDING' } }), 1);
  assert.equal(o.profile.stockDeducted, true);
  const gk = await db.profileProduct.findUnique({ where: { code: 'GK15' } });
  assert.equal((await stockLevels(db, [gk.id])).get(gk.id), 6, '10 − 4');
  assert.equal(await codeOf(run(id, 'update_pickup', 'cust', { plate: 'X 1 Y' })), 'NOT_ALLOWED', 'depoya gidince değişmez');
  const events = (await db.orderEvent.findMany({ where: { orderId: id } })).map((e) => e.event);
  assert.ok(events.includes('WAREHOUSE_SENT') && events.includes('PICKUP_MOVED') && events.includes('PAID'));
  assert.ok((await db.auditLog.count({ where: { entityId: id, action: 'ORDER_TRANSITION' } })) >= 6);

  // E-posta: sahte taşıyıcı; PDF üretilir ve iç dosya olur, bağlantı oluşur
  const sent = [];
  const transport = { sendMail: async (m) => { sent.push(m); return { messageId: 'x' }; } };
  const r = await dispatchWarehouseEmails(db, { transport, from: 'info@gkh.ro', appUrl: 'https://takip.test' });
  assert.deepEqual(r, { sent: 1, failed: 0 });
  assert.equal(sent[0].to, 'adrian@partnertrans.ro, enis@gkh.ro');
  assert.match(sent[0].subject, new RegExp(`Comanda depozit ${orderNo}`));
  assert.equal(sent[0].attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  const token = /\/depo\/([A-Za-z0-9_-]+)/.exec(sent[0].text)[1];
  const pdf = await db.orderFile.findFirst({ where: { orderId: id, source: 'WAREHOUSE_FORM' } });
  assert.equal(pdf.kind, 'INTERNAL');
  assert.equal(pdf.uploadedById, null);
  assert.equal((await db.notificationOutbox.findFirst({ where: { orderId: id, type: 'WAREHOUSE_EMAIL' } })).status, 'SENT');
  assert.ok(await findDepotOrder(db, token));
  assert.equal(await findDepotOrder(db, 'x'.repeat(43)), null);
  assert.equal((await db.profileOrder.findUnique({ where: { orderId: id } })).depotTokenHash, hashToken(token));

  // Depo bağlantısı: belge olmadan teslim onaylanmaz; belgeyle onaylanır
  const doc = { storageKey: '2026/10/imza.pdf', name: 'imza.pdf', size: 10, mime: 'application/pdf', checksum: 'c', scanStatus: 'CLEAN' };
  assert.equal(await codeOf(runProfileAction(db, { orderId: id, action: 'mark_delivered', actor: depotActor('1.2.3.4') })), 'DELIVERY_FILE');
  assert.equal(await codeOf(runProfileAction(db, { orderId: id, action: 'mark_invoiced', actor: depotActor('1.2.3.4') })), 'NOT_ALLOWED');
  await runProfileAction(db, { orderId: id, action: 'mark_delivered', actor: depotActor('1.2.3.4'), payload: { files: [doc] } });
  o = await load(id);
  assert.equal(o.profile.stage, 'TESLIM_EDILDI');
  assert.equal(o.profile.deliveredVia, 'DEPOT_LINK');
  assert.equal(await db.orderFile.count({ where: { orderId: id, source: 'DEPOT_LINK' } }), 1);
  await run(id, 'mark_invoiced', 'admin', { invoiceNo: 'F-9' });
  o = await load(id);
  assert.equal(o.profile.stage, 'FATURALANDI');
  assert.equal(o.status, 'ARSIVLENDI');
});

dbTest('profil: depoya gitmiş sipariş iptal edilince stok geri eklenir; bağlantı geçersiz olur', async () => {
  const { id } = await newProfileOrder([['AD45', 7]]);
  let o = await load(id);
  await run(id, 'send_profile_offer', 'admin', { lines: pricesOf(o) });
  o = await load(id);
  await run(id, 'approve_profile_offer', 'cust', { offerId: o.offers[0].id, pickupDate: earliestPickup({ today: today() }), phone: '0723000000', plate: 'B 2 ABC' });
  await run(id, 'mark_proforma', 'admin');
  // Ödeme beklemeden "Siparişi depoya gönder"; ödeme sonradan girilir, depoya ikinci kez gitmez
  const res = await run(id, 'send_to_warehouse', 'admin');
  assert.equal(res.result.shortages.length, 1, 'stok yok → uyarı, engel yok');
  assert.equal(await codeOf(run(id, 'send_to_warehouse', 'admin')), 'NOT_ALLOWED');
  await run(id, 'mark_paid', 'admin', { paidDate: today() });
  o = await load(id);
  assert.equal(o.profile.stage, 'DEPODA');
  assert.ok(o.profile.paidAt);
  assert.equal(await codeOf(run(id, 'mark_paid', 'admin', { paidDate: today() })), 'NOT_ALLOWED', 'ödeme bir kez');
  assert.equal(await db.notificationOutbox.count({ where: { orderId: id, type: 'WAREHOUSE_EMAIL' } }), 1);
  const ad = await db.profileProduct.findUnique({ where: { code: 'AD45' } });
  assert.equal((await stockLevels(db, [ad.id])).get(ad.id), -7);
  assert.equal(await codeOf(run(id, 'cancel', 'admin')), 'CANCEL_REASON');
  assert.equal(await codeOf(run(id, 'cancel', 'cust', { note: 'x' })), 'NOT_ALLOWED');
  await run(id, 'cancel', 'admin', { note: 'Müşteri vazgeçti' });
  assert.equal((await stockLevels(db, [ad.id])).get(ad.id), 0);
  o = await load(id);
  assert.equal(o.status, 'IPTAL');
  assert.equal(o.profile.depotTokenHash, null);
  // Kuyruktaki e-posta gönderilmez
  const r = await dispatchWarehouseEmails(db, { transport: { sendMail: async () => ({}) }, from: 'x', appUrl: 'y' });
  assert.equal(r.sent, 0);
  assert.equal((await db.notificationOutbox.findFirst({ where: { orderId: id, type: 'WAREHOUSE_EMAIL' } })).status, 'SKIPPED');
});

dbTest('profil: e-posta gönderilemezse yeniden denenir; 8. denemede yöneticiye uyarı', async () => {
  const { id } = await newProfileOrder([['SPIGOTI', 1]]);
  let o = await load(id);
  await run(id, 'send_profile_offer', 'admin', { lines: pricesOf(o) });
  o = await load(id);
  await run(id, 'approve_profile_offer', 'cust', { offerId: o.offers[0].id, pickupDate: earliestPickup({ today: today() }), phone: '0723000000', plate: 'B 3 ABC' });
  await run(id, 'mark_proforma', 'admin');
  await run(id, 'mark_paid', 'admin', { paidDate: today() });
  const failing = { sendMail: async () => { throw new Error('SMTP down'); } };
  let now = new Date();
  for (let i = 0; i < 8; i++) {
    await dispatchWarehouseEmails(db, { transport: failing, from: 'x', appUrl: 'y', now });
    now = new Date(now.getTime() + 24 * 3_600_000);
  }
  const row = await db.notificationOutbox.findFirst({ where: { orderId: id, type: 'WAREHOUSE_EMAIL' } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.attempts, 8);
  assert.equal(await db.adminAlert.count({ where: { orderId: id, type: 'WAREHOUSE_EMAIL_FAILED' } }), 1);
  // Yeniden gönder: yeni kuyruk kaydı
  await run(id, 'resend_warehouse', 'admin');
  assert.equal(await db.notificationOutbox.count({ where: { orderId: id, type: 'WAREHOUSE_EMAIL', status: 'PENDING' } }), 1);
});
