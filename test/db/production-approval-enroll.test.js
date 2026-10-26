// Müşteri üretim onayı — mevcut siparişlerin kapsama alınması (karar 305, 26.10.2026 kapsam kararı), veritabanıyla:
// ön izleme salt okunur; kategoriler (talep / yalnızca bayrak / yüklenmiş / kısmi yüklenmiş / nihai faturalı / telafi /
// kesim öncesi); SQL kapsam raporu aynı sonucu verir; yanlış / eski onay kodu hiçbir şey yazmaz; uygulama durum, teklif,
// fiyat, yükleme tarihi, proforma ve yükleme kayıtlarına dokunmaz; süre geçiş anından başlar; ikinci çalıştırma ikinci talep
// açmaz; üretimdeki (URETIMDE) siparişte onay ve değişiklik talebi (yönetici "Teklifi güncelle" yolu). Ağ isteği yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { applyEnrollment, planEnrollment } from '../../server/orders/production-approval-enroll.js';
import { approvalDeadline } from '../../server/orders/production-approval.js';
import { saveApprovalSetting } from '../../server/orders/production-approval-service.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { snapshotLine } from '../../server/loading/confirmation.js';

let db, firm, admin, cust, sales;
const actor = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, u, payload = {}) => runOrderAction(db, { orderId, action, actor: actor(u), payload });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const day = (s) => new Date(`${s}T12:00:00Z`);
let no = 100;
const ids = {};

async function order(key, { status = 'URETIMDE', ship = '2026-11-20', offer = 'GONDERILDI', drawing = 'YOK', extra = {} } = {}) {
  no += 1;
  const o = await db.order.create({
    data: {
      orderNo: `GLA${no}`, customerOrderNo: String(no), title: key, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: cust.id,
      status, drawingTrack: drawing, estimatedShipDate: day(ship), ...extra,
      ...(offer ? {
        offers: { create: { status: offer, currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: sales.id, ...(offer === 'GONDERILDI' ? { sentAt: new Date('2026-10-01T09:00:00Z') } : {}),
          lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
      } : {}),
    },
  });
  ids[key] = o.id;
  return o;
}
async function confirmPart(o, shipDay) {
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${shipDay}T00:00:00Z`), confirmedById: admin.id, confirmedAt: new Date() } });
  const full = await db.order.findUnique({ where: { id: o.id }, include: { offers: { include: { lines: true } } } });
  const offer = full.offers.find((x) => x.status === 'GONDERILDI');
  const rows = offer.lines.map((l) => snapshotLine(full, offer, l, { quantity: 1 })); // kısmi: 2 camdan 1'i
  await db.loadingConfirmationItem.createMany({
    data: rows.map((i) => ({ ...i, confirmationId: conf.id, scopeKey: `l:${i.offerLineId}`, m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2), costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4) })),
  });
}
const snapshot = async (id) => {
  const o = await db.order.findUnique({ where: { id }, include: { offers: { orderBy: { createdAt: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  return JSON.stringify({
    status: o.status, ship: o.estimatedShipDate, drawing: o.drawingTrack, onHold: o.onHold,
    offers: o.offers.map((f) => ({ id: f.id, status: f.status, amount: String(f.amount), offerAmount: String(f.offerAmount), sentAt: f.sentAt, lines: f.lines.map((l) => [l.description, l.enMm, l.boyMm, l.adet, String(l.unitPrice), String(l.offerPrice)]) })),
  });
};

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA', email: 'office@gla-enr.test' } });
  admin = await db.user.create({ data: { email: 'admin@enr.test', name: 'Admin', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id } });
  sales = await db.user.create({ data: { email: 'sales@enr.test', name: 'Satış', type: 'INTERNAL', appRole: 'SATIS', customerId: factory.id } });
  cust = await db.user.create({ data: { email: 'cust@enr.test', name: 'Müşteri', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firm.id, canApprove: true } });

  await order('prodSent'); // URETIMDE, teklif müşteride → talep
  await order('prepSent', { status: 'HAZIRLANIYOR', drawing: 'YAPILIYOR' }); // çizim sürüyor → talep (üretime geçmez)
  await order('prodProforma');
  await db.fgoDocument.create({ data: { orderId: ids.prodProforma, kind: 'PROFORMA', series: 'PRF', number: '501', total: '100', issuedAt: new Date() } });
  await order('prodOnHold', { extra: { onHold: true } });
  await order('newNoOffer', { status: 'YENI', offer: null }); // yalnızca bayrak
  await order('prepDraft', { status: 'HAZIRLANIYOR', offer: 'YONETIMDE' }); // yalnızca bayrak
  await order('loaded', { status: 'YUKLENDI' });
  const partial = await order('partial');
  await confirmPart(partial, '2026-10-20');
  await order('invoiced');
  await db.fgoDocument.create({ data: { orderId: ids.invoiced, kind: 'INVOICE', series: 'GKH', number: '9001', total: '100', issuedAt: new Date() } });
  const root = await order('compRoot', { ship: '2026-10-10' });
  await order('comp', { extra: { compOfId: root.id, compSeq: 1, customerOrderNo: root.customerOrderNo } });
  await order('before', { ship: '2026-11-05' }); // kesimden önce — kapsam dışı
  await order('onCutoff', { ship: '2026-11-06' }); // kesim günü — kapsamda
});
after(closeDb);

const categoryOf = (plan, key) => plan.rows.find((r) => r.id === ids[key])?.category ?? null;

dbTest('ön izleme: kategoriler, kesim günü, kısmi yükleme; salt okunur; SQL kapsam raporu aynı sonucu verir', offline(async () => {
  const plan = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return planEnrollment(tx, { cutoff: '2026-11-06' });
  });
  const expected = {
    prodSent: 'REQUEST', prepSent: 'REQUEST', prodProforma: 'REQUEST', prodOnHold: 'REQUEST', onCutoff: 'REQUEST',
    newNoOffer: 'FLAG_ONLY', prepDraft: 'FLAG_ONLY', loaded: 'LOADED', partial: 'LOADED', invoiced: 'FINAL_INVOICED', comp: 'COMPENSATION',
    before: null, compRoot: null,
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(categoryOf(plan, k), v, k);
  const pr = plan.rows.find((r) => r.id === ids.prodProforma);
  assert.equal(pr.proforma, true);
  assert.equal(plan.rows.find((r) => r.id === ids.partial).confirmationItems, 1);
  assert.match(plan.code, /^[0-9A-F]{10}$/);

  // SQL raporu (canlıda 4.2.0 şemasıyla çalışır): ayrıntı sorgusu aynı kategorileri verir
  const text = fs.readFileSync(new URL('../../deploy/canliya-gecis/uretim-onayi-kapsam.sql', import.meta.url), 'utf8');
  const stmts = text.split('\n').filter((l) => !/^\s*(--|\\echo)/.test(l)).join('\n').split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !/^(BEGIN|ROLLBACK)\b/i.test(s));
  const detail = stmts.find((s) => /kategori\s*\nFROM k ORDER BY kategori, yukleme/.test(s)) ?? stmts[1];
  const rows = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return tx.$queryRawUnsafe(detail);
  });
  const sqlMap = Object.fromEntries(rows.map((r) => [r.siparis, r.kategori]));
  for (const r of plan.rows) assert.equal(sqlMap[r.orderNo], r.category, r.orderNo);
  assert.equal(rows.length, plan.rows.length);
}));

dbTest('uygulama: yanlış kod / ayar sonrası değişiklik hiçbir şey yazmaz; doğru kodla yalnızca bayrak + talep; kayıtlar korunur; ikinci kez talep yok', offline(async () => {
  await saveApprovalSetting(db, { enabled: true, actor: actor(admin) });
  const before = Object.fromEntries(await Promise.all(Object.keys(ids).map(async (k) => [k, await snapshot(ids[k])])));
  const outboxBefore = await db.notificationOutbox.count();
  assert.deepEqual(await applyEnrollment(db, { cutoff: '2026-11-06', code: 'ABC', operator: 't' }), { ok: false, code: 'CODE_REQUIRED' });
  let plan = await planEnrollment(db, { cutoff: '2026-11-06' });
  // Ön izlemeden sonra bir siparişte işlem yapıldı → kod tutmaz, hiçbir şey yazılmaz
  await db.order.update({ where: { id: ids.prodSent }, data: { version: { increment: 1 } } });
  const stale = await applyEnrollment(db, { cutoff: '2026-11-06', code: plan.code, operator: 't' });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'APPROVAL_MISMATCH');
  assert.equal(await db.order.count({ where: { productionApprovalRequired: true } }), 0);
  assert.equal(await db.offer.count({ where: { approvalRequestedAt: { not: null } } }), 0);

  plan = await planEnrollment(db, { cutoff: '2026-11-06' });
  const now = new Date();
  const res = await applyEnrollment(db, { cutoff: '2026-11-06', code: plan.code, operator: 'test', now });
  assert.equal(res.ok, true);
  assert.equal(res.requested, 5);
  assert.equal(res.flagged, 2);
  assert.deepEqual(res.skipped, { COMPENSATION: 1, FINAL_INVOICED: 1, LOADED: 2 });

  const due = approvalDeadline(now).due;
  for (const k of ['prodSent', 'prepSent', 'prodProforma', 'prodOnHold', 'onCutoff']) {
    const o = await db.order.findUnique({ where: { id: ids[k] }, include: { offers: true } });
    assert.equal(o.productionApprovalRequired, true, k);
    assert.equal(o.offers[0].approvalRequestedAt.toISOString(), now.toISOString(), `${k}: süre geçiş anından`);
    assert.equal(o.offers[0].approvalDueAt?.toISOString(), due?.toISOString(), k);
    assert.equal(await db.orderEvent.count({ where: { orderId: o.id, event: 'PRODUCTION_APPROVAL_REQUESTED' } }), 1, k);
    const ev = await db.notificationOutbox.findFirst({ where: { orderId: o.id, type: 'ORDER_PRODUCTION_APPROVAL_REQUESTED' } });
    assert.equal(ev.payload.approval.due, due ? due.toISOString() : null, k);
  }
  for (const k of ['newNoOffer', 'prepDraft']) {
    assert.equal((await db.order.findUnique({ where: { id: ids[k] } })).productionApprovalRequired, true, k);
    assert.equal(await db.orderEvent.count({ where: { orderId: ids[k], event: 'PRODUCTION_APPROVAL_REQUESTED' } }), 0, `${k}: müşteriye bir şey sorulmadı`);
  }
  for (const k of ['loaded', 'partial', 'invoiced', 'comp', 'before', 'compRoot']) {
    assert.equal((await db.order.findUnique({ where: { id: ids[k] } })).productionApprovalRequired, false, `${k}: dokunulmadı`);
    assert.equal(await snapshot(ids[k]), before[k], `${k}: kayıt aynı`);
  }
  // Durum, yükleme tarihi, teklif sürümleri, fiyat ve ölçüler değişmez
  for (const k of Object.keys(ids)) assert.equal(await snapshot(ids[k]), before[k], k);
  assert.equal(await db.notificationOutbox.count() - outboxBefore, 5, 'yalnızca talep açılan siparişlere bildirim');
  assert.equal(await db.fgoDocument.count(), 2, 'belgelere dokunulmadı');
  assert.equal(await db.loadingConfirmationItem.count(), 1, 'yükleme kayıtlarına dokunulmadı');
  const audit = await db.auditLog.findFirst({ where: { action: 'PRODUCTION_APPROVAL_ENROLL' } });
  assert.equal(audit.details.requested, 5);
  assert.equal(audit.details.orders.length, 7);

  // İkinci çalıştırma: hepsi "zaten kapsamda"; yeni talep / bildirim yok
  const again = await planEnrollment(db, { cutoff: '2026-11-06' });
  assert.equal(again.counts.REQUEST ?? 0, 0);
  assert.equal(again.counts.FLAG_ONLY ?? 0, 0);
  const second = await applyEnrollment(db, { cutoff: '2026-11-06', code: again.code, operator: 'test' });
  assert.deepEqual([second.ok, second.requested, second.flagged], [true, 0, 0]);
  assert.equal(await db.notificationOutbox.count() - outboxBefore, 5);
  for (const k of ['prodSent', 'prepSent']) assert.equal(await db.orderEvent.count({ where: { orderId: ids[k], event: 'PRODUCTION_APPROVAL_REQUESTED' } }), 1);
}));

dbTest('üretimdeki sipariş: onay durumu değiştirmez; değişiklik talebinde taslak açılmaz, yönetici "Teklifi güncelle" ile yeni sürüm gönderir, yeniden onay', offline(async () => {
  const o = ids.prodSent;
  const sent = (await db.offer.findMany({ where: { orderId: o } }))[0];
  // Değişiklik talebi (proforma yok → mali kilit yok)
  await run(o, 'request_offer_change', cust, { offerId: sent.id, note: '2. cam 1200 mm olmalı' });
  let ord = await db.order.findUnique({ where: { id: o }, include: { offers: { orderBy: { createdAt: 'asc' } } } });
  assert.equal(ord.status, 'URETIMDE', 'durum değişmez');
  assert.equal(ord.offers.length, 1, 'üretimde taslak açılmaz');
  assert.ok(ord.offers[0].changeRequestedAt);
  assert.equal(await codeOf(run(o, 'approve_production', cust, { offerId: sent.id })), 'NOT_ALLOWED');
  // Yönetici mevcut "Teklifi güncelle" ile yeni sürüm → yeniden onay; durum yine URETIMDE
  const lines = ord.offers[0].lines ?? (await db.offerLine.findMany({ where: { offerId: sent.id } }));
  await run(o, 'update_offer', admin, { lines: lines.map((l) => ({ id: l.id, description: l.description, poz: l.poz, enMm: 1200, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free, unitPrice: Number(l.unitPrice).toFixed(2), offerPrice: '50' })) });
  ord = await db.order.findUnique({ where: { id: o }, include: { offers: { orderBy: { createdAt: 'asc' } } } });
  assert.equal(ord.status, 'URETIMDE');
  const v2 = ord.offers.at(-1);
  assert.ok(v2.approvalRequestedAt && v2.approvalDueAt, 'yeni sürüm için yeni talep ve süre');
  assert.equal(await codeOf(run(o, 'approve_production', cust, { offerId: sent.id })), 'OFFER_VERSION_STALE');
  await run(o, 'approve_production', cust, { offerId: v2.id });
  ord = await db.order.findUnique({ where: { id: o }, include: { offers: { orderBy: { createdAt: 'asc' } } } });
  assert.equal(ord.status, 'URETIMDE', 'onay durumu ayrı: sipariş durumu değişmez');
  assert.ok(ord.offers.at(-1).approvedAt);

  // Proformalı üretim siparişi: onay verilir; değişiklik talebi mevcut mali kilit nedeniyle alınmaz
  const p = ids.prodProforma;
  const ps = (await db.offer.findMany({ where: { orderId: p } }))[0];
  assert.equal(await codeOf(run(p, 'request_offer_change', cust, { offerId: ps.id, note: 'ölçü' })), 'PRICE_LOCKED');
  await run(p, 'approve_production', cust, { offerId: ps.id });
  assert.equal((await db.order.findUnique({ where: { id: p } })).status, 'URETIMDE');
  assert.equal(await db.fgoDocument.count({ where: { orderId: p } }), 1, 'proforma aynı');

  // Hazırlıktaki (çizim sürüyor) sipariş: onay üretime geçirmez; çizim bitince olağan kuralla geçer
  const h = ids.prepSent;
  const hs = (await db.offer.findMany({ where: { orderId: h } }))[0];
  await run(h, 'approve_production', cust, { offerId: hs.id });
  assert.equal((await db.order.findUnique({ where: { id: h } })).status, 'HAZIRLANIYOR');
  await db.order.update({ where: { id: h }, data: { drawingTrack: 'ONAYLANDI' } });
  await run(h, 'hold', sales);
  await run(h, 'unhold', sales);
  assert.equal((await db.order.findUnique({ where: { id: h } })).status, 'URETIMDE');
}));

dbTest('bildirimsiz prova: talep ve süre yazılır, müşteriye bildirim kuyruğa yazılmaz', offline(async () => {
  const o = await order('silent', { ship: '2026-12-01' });
  const plan = await planEnrollment(db, { cutoff: '2026-11-06' });
  assert.equal(plan.rows.find((r) => r.id === o.id).category, 'REQUEST');
  const res = await applyEnrollment(db, { cutoff: '2026-11-06', code: plan.code, operator: 'test', notify: false });
  assert.equal(res.requested, 1);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: o.id } }), 0);
  assert.ok((await db.offer.findFirst({ where: { orderId: o.id } })).approvalRequestedAt);
  const audit = await db.auditLog.findFirst({ where: { action: 'PRODUCTION_APPROVAL_ENROLL' }, orderBy: { createdAt: 'desc' } });
  assert.equal(audit.details.notify, false);
}));
