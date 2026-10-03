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
  // "Erken gün": bugün ya da (test hafta sonu çalışıyorsa) bugünden önceki son iş günü — hafta sonu ayrı hata verir
  const early = (() => { const d = today(); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1); return d; })();
  assert.equal(await codeOf(run(id, 'approve_profile_offer', 'cust', { offerId: sentId, pickupDate: early, phone: '+40 723 000 000', plate: 'B 1 ABC' })), 'PICKUP_TOO_EARLY');
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
  const audited = (await db.auditLog.findMany({ where: { entityId: id, action: 'ORDER_TRANSITION' } })).map((a) => a.details?.action);
  for (const a of ['send_profile_offer', 'approve_profile_offer', 'update_pickup', 'mark_proforma', 'mark_paid']) assert.ok(audited.includes(a), `denetim kaydı: ${a}`);

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
  const mails = [];
  await dispatchWarehouseEmails(db, { transport: { sendMail: async (m) => { mails.push(m); return {}; } }, from: 'x', appUrl: 'y' });
  assert.ok(!mails.some((m) => String(m.subject).includes(o.orderNo)), 'iptal edilen siparişin e-postası gitmez');
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

// ---------- FGO (Aşama 6b) ----------
const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { dispatchFgoJobs } = await import('../../server/profile/fgo-jobs.js');
const FGO_SECRET = 'f'.repeat(40);
const fgoOn = (enabled = true, fxMode = 'auto', dailyLimit = 0) => saveFgoSettings(db, {
  enabled, fxMode, dailyLimit, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21, fxUrl: 'https://bt.example/curs',
}, { key: 'GIZLI', secret: FGO_SECRET }, actor(people.admin));
function fakeFgo(numbers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    // Belge durumu (muhasebe): tutar ve ödenen
    if (String(url).endsWith('/factura/getstatus')) return new Response(JSON.stringify({ Success: true, Factura: { Numar: form.Numar, Serie: form.Serie, Valoare: '100.00', ValoareAchitata: '40.00' } }));
    calls.push({ url, form });
    const n = numbers.shift();
    return new Response(JSON.stringify({ Success: true, Factura: { Numar: String(n), Serie: form.Serie, Link: `https://fgo.example/${form.Serie}${n}.pdf` } }));
  };
  return { calls, fetchImpl };
}
const fgoCtx = (extra) => ({ secret: FGO_SECRET, appUrl: 'https://takip.test', timeZone: 'Europe/Bucharest', ...extra });

dbTest('FGO: onayda proforma (BT kuru, RON), teslimde aynı kurla fatura; anahtar düz metin saklanmaz', async () => {
  await fgoOn();
  const row = await db.integrationSetting.findUnique({ where: { key: 'fgo' } });
  assert.ok(!JSON.stringify(row.value).includes('GIZLI'), 'anahtar şifreli');
  await db.customer.update({ where: { id: firm.id }, data: { taxId: '998877', regCom: 'J40/1/2020', county: 'Ilfov', city: 'Voluntari', address: 'Str. X 1' } });
  const { id, orderNo } = await newProfileOrder([['GK15', 4], ['SPIGOTI', 20]]);
  let o = await load(id);
  await run(id, 'send_profile_offer', 'admin', { lines: pricesOf(o, '12.5') });
  o = await load(id);
  await run(id, 'approve_profile_offer', 'cust', { offerId: o.offers[0].id, pickupDate: earliestPickup({ today: today() }), phone: '0723000000', plate: 'B 9 FGO' });
  assert.equal(await db.notificationOutbox.count({ where: { orderId: id, type: 'FGO_PROFORMA', status: 'PENDING' } }), 1);

  const fgo = fakeFgo([552, 684]);
  let rates = 0;
  const rateImpl = async () => { rates++; return { ok: true, rate: 4.9765, source: 'https://bt.example/curs' }; };
  const r1 = await dispatchFgoJobs(db, fgoCtx({ fetchImpl: fgo.fetchImpl, rateImpl }));
  assert.deepEqual(r1, { done: 1, failed: 0 });
  o = await load(id);
  assert.equal(o.profile.stage, 'PROFORMA');
  assert.equal(o.profile.proformaNo, 'PRF552');
  assert.equal(o.profile.proformaLink, 'https://fgo.example/PRF552.pdf');
  const pdoc = await db.fgoDocument.findUnique({ where: { series_number: { series: 'PRF', number: '552' } } });
  assert.equal(pdoc.kind, 'PROFORMA');
  assert.equal(pdoc.total.toString(), '100', 'tutar FGO\'dan hemen okunur');
  assert.equal(pdoc.paid.toString(), '40');
  assert.equal(Number(o.profile.fxRate), 4.9765);
  assert.equal(o.profile.fxSource, 'https://bt.example/curs');
  assert.equal(o.profile.proformaAmount.toString(), '1493.04'); // 24 × 62,21 RON
  const pf = fgo.calls[0].form;
  assert.match(fgo.calls[0].url, /api-testuat\.fgo\.ro\/v1\/factura\/emitere$/);
  assert.equal(pf.Serie, 'PRF');
  assert.equal(pf.Valuta, 'RON');
  assert.equal(pf.IdExtern, `${orderNo}-P`);
  assert.equal(pf['Client[CodUnic]'], '998877');
  assert.equal(pf['Continut[0][PretUnitar]'], '62.21');
  // Ölçü birimi FGO eşlemesinden (en çok 5 karakter): CUTII → cutii, BUCATI ("bucăți") → buc
  assert.deepEqual([pf['Continut[0][UM]'], pf['Continut[1][UM]']].sort(), ['buc', 'cutii']);

  await run(id, 'mark_paid', 'admin', { paidDate: today() });
  await run(id, 'mark_delivered', 'admin');
  assert.equal(await db.notificationOutbox.count({ where: { orderId: id, type: 'FGO_INVOICE', status: 'PENDING' } }), 1);
  await dispatchFgoJobs(db, fgoCtx({ fetchImpl: fgo.fetchImpl, rateImpl }));
  o = await load(id);
  assert.equal(o.profile.stage, 'FATURALANDI');
  assert.equal(o.status, 'ARSIVLENDI');
  assert.equal(o.profile.invoiceNo, 'GKH684');
  assert.equal(rates, 1, 'fatura için kur yeniden alınmaz');
  const inv = fgo.calls[1].form;
  assert.equal(inv.Serie, 'GKH');
  assert.equal(inv.IdExtern, `${orderNo}-F`);
  assert.ok(!('Numar' in inv), 'fatura numarasını FGO verir (karar 87); kaydedilen numara FGO\'nun döndürdüğü (GKH684)');
  assert.equal(inv['Continut[0][PretUnitar]'], pf['Continut[0][PretUnitar]'], 'aynı kur');
  const audited = (await db.auditLog.findMany({ where: { entityId: id, action: 'ORDER_TRANSITION' } })).map((a) => a.details?.action);
  assert.ok(audited.includes('fgo_proforma') && audited.includes('fgo_invoice'));
});

dbTest('FGO: fatura bilgisi eksik firma → yeniden denenmez, uyarı; elle kur ile yeniden dene; elle proformada kur zorunlu', async () => {
  await fgoOn();
  const { id } = await newProfileOrder([['AD45', 2]], otherFirm);
  let o = await load(id);
  await run(id, 'send_profile_offer', 'admin', { lines: pricesOf(o) });
  o = await load(id);
  await run(id, 'approve_profile_offer', 'other', { offerId: o.offers[0].id, pickupDate: earliestPickup({ today: today() }), phone: '0723000000', plate: 'B 8 FGO' });
  const fgo = fakeFgo([553]);
  const r = await dispatchFgoJobs(db, fgoCtx({ fetchImpl: fgo.fetchImpl, rateImpl: async () => ({ ok: true, rate: 5, source: 'x' }) }));
  assert.deepEqual(r, { done: 0, failed: 1 });
  assert.equal(fgo.calls.length, 0, "FGO'ya gidilmedi");
  assert.equal((await db.notificationOutbox.findFirst({ where: { orderId: id, type: 'FGO_PROFORMA' } })).status, 'FAILED');
  assert.equal(await db.adminAlert.count({ where: { orderId: id, type: 'FGO_FAILED' } }), 1);
  assert.equal(await codeOf(run(id, 'retry_fgo', 'admin', { fxRate: '99' })), 'BAD_FX_RATE');
  await run(id, 'retry_fgo', 'admin', { fxRate: '4,9800' });
  o = await load(id);
  assert.equal(Number(o.profile.fxRate), 4.98);
  assert.equal(o.profile.fxSource, 'MANUAL');
  assert.equal(await db.notificationOutbox.count({ where: { orderId: id, type: 'FGO_PROFORMA', status: 'PENDING' } }), 1);
  // Elle proforma: kuyruktaki iş atlanır
  await run(id, 'mark_proforma', 'admin', { proformaNo: 'PRF999' });
  await dispatchFgoJobs(db, fgoCtx({ fetchImpl: fgo.fetchImpl }));
  assert.equal(await db.notificationOutbox.count({ where: { orderId: id, type: 'FGO_PROFORMA', status: 'SKIPPED' } }), 1);
  assert.equal(fgo.calls.length, 0);

  // Yeni sipariş: kur yokken elle proforma reddedilir
  const second = await newProfileOrder([['AD45', 1]], otherFirm);
  o = await load(second.id);
  await run(second.id, 'send_profile_offer', 'admin', { lines: pricesOf(o) });
  o = await load(second.id);
  await run(second.id, 'approve_profile_offer', 'other', { offerId: o.offers[0].id, pickupDate: earliestPickup({ today: today() }), phone: '0723000000', plate: 'B 8 FGO' });
  assert.equal(await codeOf(run(second.id, 'mark_proforma', 'admin', { proformaNo: 'X' })), 'FX_RATE_REQUIRED');
  await run(second.id, 'mark_proforma', 'admin', { proformaNo: 'X', fxRate: '5,01' });
  await fgoOn(false);
  assert.equal(await codeOf(run(second.id, 'retry_fgo', 'admin')), 'NOT_ALLOWED', 'proforma adımında yeniden deneme yok');
});

dbTest('FGO: elle modda günün kuru kullanılır; girilmemişse beklenir, girilince hemen kesilir', async () => {
  const { saveDailyRate } = await import('../../server/fx/bt.js');
  const { writeAudit } = await import('../../server/orders/journal.js');
  await fgoOn(true, 'manual');
  const { id } = await newProfileOrder([['GK15', 1]]);
  let o = await load(id);
  await run(id, 'send_profile_offer', 'admin', { lines: pricesOf(o, '10') });
  o = await load(id);
  await run(id, 'approve_profile_offer', 'cust', { offerId: o.offers[0].id, pickupDate: earliestPickup({ today: today() }), phone: '0723000000', plate: 'B 7 FGO' });
  const fgo = fakeFgo([560]);
  let asked = 0;
  const blocked = async () => { asked++; return { ok: false, error: 'HTTP 403' }; };
  const now = new Date();
  const r1 = await dispatchFgoJobs(db, fgoCtx({ fetchImpl: fgo.fetchImpl, rateImpl: blocked, now }));
  assert.deepEqual(r1, { done: 0, failed: 1 });
  const job = await db.notificationOutbox.findFirst({ where: { orderId: id, type: 'FGO_PROFORMA' } });
  assert.equal(job.status, 'PENDING', 'geçici hata: yeniden denenir');
  assert.match(job.lastError, /Günün BT kuru girilmedi/);
  await saveDailyRate(db, { day: localDay(now, 'Europe/Bucharest'), rate: 5.345 }, actor(people.admin), writeAudit);
  await dispatchFgoJobs(db, fgoCtx({ fetchImpl: fgo.fetchImpl, rateImpl: blocked, now: new Date(now.getTime() + 60_000) })); // kur girilince bekleyen iş hemen denenir
  o = await load(id);
  assert.equal(o.profile.proformaNo, 'PRF560');
  assert.equal(Number(o.profile.fxRate), 5.345);
  assert.equal(o.profile.fxSource, 'MANUAL_DAY');
  assert.equal(asked, 0, 'elle modda BT\'ye gidilmez');
  assert.equal(fgo.calls[0].form['Continut[0][PretUnitar]'], '53.45');
  await fgoOn(false);
});

dbTest('Muhasebe: FGO belgeleri sipariş tipine göre listelenir, "FGO ile güncelle" ödeneni yeniler (ödenmişler atlanır)', async () => {
  const { listDocuments, refreshDocuments, paymentStatus } = await import('../../server/accounting/receivables.js');
  await fgoOn();
  const docs = await listDocuments(db, 'PROFILE_ORDER');
  assert.ok(docs.length >= 2, 'proforma + fatura');
  assert.equal((await listDocuments(db, 'GLASS_ORDER')).length, 0);
  const seen = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    seen.push(`${form.Serie}${form.Numar}`);
    const paid = form.Numar === '552' ? '100.00' : '0';
    return new Response(JSON.stringify({ Success: true, Factura: { Valoare: '100.00', ValoareAchitata: paid } }));
  };
  const r = await refreshDocuments(db, { orderType: 'PROFILE_ORDER', secret: FGO_SECRET, fetchImpl, sleep: async () => {} });
  assert.equal(r.ok, true);
  const prf = await db.fgoDocument.findUnique({ where: { series_number: { series: 'PRF', number: '552' } } });
  assert.equal(paymentStatus(prf.total, prf.paid), 'PAID');
  seen.length = 0;
  await refreshDocuments(db, { orderType: 'PROFILE_ORDER', secret: FGO_SECRET, fetchImpl, sleep: async () => {} });
  assert.ok(!seen.includes('PRF552'), 'ödenmiş belge yeniden sorulmaz');

  const inv = await db.fgoDocument.findUnique({ where: { series_number: { series: 'GKH', number: '684' } } });
  let o = await load(inv.orderId);
  assert.equal(o.profile.stage, 'FATURALANDI');

  // Otomatik eşitleme (işçi, saatte bir — karar 90): yalnızca açık belgeleri sorar; FGO "belge yok" dese bile kaydı
  // silmez, siparişi geri almaz (bunu yalnızca yöneticinin "FGO ile Güncelle"si yapar); saat dolmadan yeniden çalışmaz
  const { syncFgoDocuments, syncStatus } = await import('../../server/accounting/receivables.js');
  const allGone = [];
  const goneAll = async (url, init) => {
    allGone.push(Object.fromEntries(new URLSearchParams(init.body)).Numar);
    return new Response(JSON.stringify({ Success: false, Message: 'Factura nu exista' }));
  };
  const docCount = await db.fgoDocument.count();
  const auto = await syncFgoDocuments(db, { secret: FGO_SECRET, fetchImpl: goneAll, sleep: async () => {} });
  assert.equal(auto.ran, true);
  assert.ok(allGone.includes('684') && !allGone.includes('552'), 'açık fatura soruldu; ödenmiş proforma sorulmadı');
  assert.equal(await db.fgoDocument.count(), docCount, 'otomatik tur kayıt silmez');
  assert.match((await db.fgoDocument.findUnique({ where: { id: inv.id } })).checkError, /nu exista/);
  assert.equal((await load(inv.orderId)).profile.stage, 'FATURALANDI', 'otomatik tur sipariş adımını değiştirmez');
  assert.equal(await db.adminAlert.count({ where: { orderId: inv.orderId, type: 'FGO_FAILED' } }), 0, 'otomatik tur yönetici uyarısı üretmez');
  assert.deepEqual(await syncFgoDocuments(db, { secret: FGO_SECRET, fetchImpl: goneAll, sleep: async () => {} }), { ran: false });
  assert.equal((await syncStatus(db)).leaseUntil, null, 'tur bitince kilit bırakılır');

  // Fatura FGO'da silinmiş (karar 65): elle güncellemede kayıt kalkar, sipariş teslim adımına döner, "FGO'da yeniden dene" çıkar
  const gone = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    if (form.Numar === '684') return new Response(JSON.stringify({ Success: false, Message: 'Factura nu exista' }));
    return new Response(JSON.stringify({ Success: true, Factura: { Valoare: '100.00', ValoareAchitata: '0' } }));
  };
  await refreshDocuments(db, { orderType: 'PROFILE_ORDER', secret: FGO_SECRET, fetchImpl: gone, sleep: async () => {} });
  assert.equal(await db.fgoDocument.count({ where: { id: inv.id } }), 0, 'silinmiş faturanın kaydı kalktı');
  o = await load(inv.orderId);
  assert.equal(o.profile.stage, 'TESLIM_EDILDI');
  assert.equal(o.status, 'HAZIRLANIYOR', 'arşivden çıktı');
  assert.equal(o.profile.invoiceNo, null);
  assert.equal(o.profile.proformaNo, 'PRF552', 'proforma yerinde');
  assert.ok(await db.orderEvent.findFirst({ where: { orderId: inv.orderId, event: 'FGO_DOC_DELETED', note: 'GKH684' } }));
  assert.ok(await db.auditLog.findFirst({ where: { entityId: inv.orderId, action: 'ORDER_TRANSITION' } }));
  assert.equal(await codeOf(run(inv.orderId, 'retry_fgo', 'admin')), 'OK', 'yeni fatura FGO\'da yeniden dene ile kesilir');
  assert.equal(await db.notificationOutbox.count({ where: { orderId: inv.orderId, type: 'FGO_INVOICE', status: 'PENDING' } }), 1);
  await fgoOn(false);
  assert.deepEqual(await refreshDocuments(db, { orderType: 'PROFILE_ORDER', secret: FGO_SECRET, fetchImpl }), { ok: false, code: 'FGO_DISABLED' });
});

dbTest('Muhasebe: yükleme kârı ve fabrika bakiyesi; ödemeler yüklemeye bağlı değil, para birimleri ayrı', async () => {
  const { supplierData } = await import('../../server/accounting/supplier.js');
  const glass = await db.order.create({
    data: {
      orderNo: 'GLA900', customerOrderNo: 900, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: people.admin.id, status: 'YUKLENDI',
      estimatedShipDate: new Date('2026-09-15T00:00:00Z'), actualShipDate: new Date('2026-09-15T00:00:00Z'),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '600.00', offerAmount: '1000.00', createdById: people.admin.id, lines: { create: [{ sortOrder: 0, description: 'Cam', enMm: 1000, boyMm: 2000, adet: 5, unit: 'm2', unitPrice: '60.00', offerPrice: '100.00', kind: 'CAM' }] } } },
    },
  });
  await db.loadingCost.create({ data: { shipDay: new Date('2026-09-15'), amount: '150.00', currency: 'EUR', note: 'TIR' } });
  await db.loadingCost.create({ data: { shipDay: new Date('2026-09-15'), amount: '200.00', currency: 'RON', note: 'vama' } });
  await db.factoryPayment.create({ data: { paidOn: new Date('2026-09-20'), amount: '450.00', currency: 'EUR' } });
  const d = await supplierData(db, new Date('2026-10-02T00:00:00Z'));
  const day = d.days.find((x) => x.day === '2026-09-15');
  assert.equal(day.m2, 10);
  assert.deepEqual(day.byCur.EUR, { sale: 1000, cost: 600, transport: 150, profit: 250 });
  assert.deepEqual(day.byCur.RON, { sale: 0, cost: 0, transport: 200, profit: -200 }, 'RON nakliye EUR\'ya eklenmez');
  assert.equal(d.summary.EUR.paid, 450);
  assert.equal(d.summary.EUR.balance, 150, '600 maliyet − 450 ödeme');
  await db.offer.deleteMany({ where: { orderId: glass.id } });
  await db.order.delete({ where: { id: glass.id } });
});
