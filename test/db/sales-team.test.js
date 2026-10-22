// Satışçı–çizimci ayrımı (4.3.0, karar 300) — veritabanıyla: iki ekip + aynı müşteri + ortak yükleme günü; yönlendirme;
// yönetici ataması / yönlendirmesi; teklif / onay zinciri; çizim / revizyon bildirimleri; telafi; üç satışçılı fabrika
// hesapları; ödeme hesabı değişikliği; geçmiş veri bağlama (önizleme / uygulama, toplamlar değişmez).
// Çok ekipli: resetDb(db, { singleTeam: false }) — tek ekip tetikleyicileri yok; sahip / çizimci açıkça verilir.
// Hiçbir dış servise gidilmez (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { LINK_SETTING, routingLinked, routingState, saveRoutingRule, setDefaultDrawer } from '../../server/orders/sales-routing.js';
import { orderScope } from '../../server/orders/scope.js';
import { orderSalesUsers, recipientsFor } from '../../server/notifications/email.js';
import { dispatchInApp, recipientsOf } from '../../server/notifications/inapp.js';
import { addNote } from '../../server/notes/translation.js';
import { findDrawingFile } from '../../server/orders/drawing-access.js';
import { assignGuestCrate, saveDayCrates, setGuestHost } from '../../server/loading/crates.js';
import { transportList } from '../../server/loading/transport.js';
import { previewLoading, confirmLoading } from '../../server/loading/confirmation.js';
import { supplierData } from '../../server/accounting/supplier.js';
import { addFactoryPayment, changePaymentAccount } from '../../server/accounting/factory-accounts.js';
import { applyLink, previewLink, totalsSnapshot, sameTotals, accountsMatchSummary } from '../../server/orders/sales-link.js';
import { createCompensation } from '../../server/orders/compensation.js';
import { assignTable, pricingForUser, savePrices, saveTable } from '../../server/pricing/tables.js';
import { can } from '../../server/auth/permissions.js';

let db, factory, firm, glass, tables;
const U = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: act(U[who]), payload });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
let fileNo = 0;
let keyNo = 0;
const key = () => `istek-${++keyNo}-${'x'.repeat(16)}`;
const newOrder = async (title) => {
  const next = await suggestNextNo(db, firm.id);
  fileNo += 1;
  return createGlassOrder(db, {
    actor: act(U.cust), firm, title, requestedNo: next, suggestedNo: next,
    items: [{ glassProductId: glass.id, glassName: '8mm Temperli', glassNameRo: 'Sticlă 8', glassWeightKgM2: 20, camAdedi: 2 }],
    files: [{ storageKey: `2026/10/st-${fileNo}.pdf`, name: `st-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
};
const full = (id) => db.order.findUniqueOrThrow({ where: { id }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } }, salesUser: true, assignedDrawer: true } });
// Ön doldurulmuş satırın ölçüsü yoktur: form 1000 × 1000 yazar (2 adet = 2 m²)
const form = (l, extra = {}) => ({ id: l.id, description: l.description, poz: l.poz, enMm: l.enMm ?? 1000, boyMm: l.boyMm ?? 1000, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free, glassProductId: l.glassProductId, unitPrice: Number(l.unitPrice).toFixed(2), ...extra });
const visible = (who, orderId) => db.order.findFirst({ where: { id: orderId, ...orderScope(U[who]) }, select: { id: true } }).then((r) => !!r);
/** Teklif zinciri: satış → yönetici → müşteri (müşteri fiyatı yöneticiden) */
async function sendOffer(orderId, sales, price = '60.00') {
  const o = await full(orderId);
  const offer = o.offers[0];
  const v = (await db.order.findUniqueOrThrow({ where: { id: orderId } })).version;
  await run(orderId, 'submit_offer', sales, { lines: offer.lines.map((l) => form(l)), expectedVersion: v });
  const after = await full(orderId);
  await run(orderId, 'approve_offer', 'admin', { lines: after.offers[0].lines.map((l) => form(l, { offerPrice: price })), expectedVersion: after.version });
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db, { singleTeam: false });
  factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA', email: 'office@gla-team.test' } });
  glass = await db.glassProduct.create({ data: { nameTr: '8mm Temperli', colorTr: '', nameRo: 'Sticlă 8', colorRo: '', weightKgM2: 20 } });
  const mk = async (k, appRole, customerId, extra = {}) => { U[k] = await db.user.create({ data: { email: `${k}@team.test`, name: k, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } }); };
  await mk('admin', 'ADMIN', factory.id);
  await mk('drawerA', 'CIZIM', factory.id);
  await mk('drawerB', 'CIZIM', factory.id);
  await mk('salesA', 'SATIS', factory.id, { defaultDrawerId: null });
  await mk('salesB', 'SATIS', factory.id);
  await mk('salesC', 'SATIS', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  const a = await saveTable(db, null, { name: 'Tablo A', currency: 'EUR', holePrice: 3, cncPrice: 12 }, act(U.admin));
  const b = await saveTable(db, null, { name: 'Tablo B', currency: 'EUR', holePrice: 4, cncPrice: 14 }, act(U.admin));
  tables = { a: a.id, b: b.id };
  await savePrices(db, tables.a, { [glass.id]: 30 }, act(U.admin));
  await savePrices(db, tables.b, { [glass.id]: 35 }, act(U.admin));
  const prep = (r) => can(r, 'OFFER_PREPARE');
  await assignTable(db, U.salesA.id, tables.a, act(U.admin), prep);
  await assignTable(db, U.salesB.id, tables.b, act(U.admin), prep);
});
after(closeDb);

dbTest('varsayılan çizimci: yalnızca USER_MANAGE; geçerli çizimci; eski siparişler değişmez', offline(async () => {
  assert.deepEqual(await setDefaultDrawer(db, { salesUserId: U.salesA.id, drawerId: U.drawerA.id, actor: act(U.salesA) }), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(await setDefaultDrawer(db, { salesUserId: U.salesA.id, drawerId: U.salesB.id, actor: act(U.admin) }), { ok: false, code: 'DRAWER' });
  assert.deepEqual(await setDefaultDrawer(db, { salesUserId: U.drawerA.id, drawerId: U.drawerA.id, actor: act(U.admin) }), { ok: false, code: 'SALES' });
  assert.deepEqual(await setDefaultDrawer(db, { salesUserId: U.salesA.id, drawerId: U.drawerA.id, actor: act(U.admin) }), { ok: true, changed: true });
  assert.deepEqual(await setDefaultDrawer(db, { salesUserId: U.salesA.id, drawerId: U.drawerA.id, actor: act(U.admin) }), { ok: true, changed: false });
  assert.deepEqual(await setDefaultDrawer(db, { salesUserId: U.salesB.id, drawerId: U.drawerB.id, actor: act(U.admin) }), { ok: true, changed: true });
  assert.equal(await db.auditLog.count({ where: { action: 'SALES_DEFAULT_DRAWER' } }), 2);
}));

dbTest('yönlendirme: boş veritabanı bağlı sayılır; kural yoksa yeni sipariş atama bekler; AUTO kural ileriye etkili; satış / çizim ekibine erişim ve bildirim yok', offline(async () => {
  assert.equal(await routingLinked(db), true, 'boş veritabanı: seed işareti');
  const o1 = await newOrder('Atamasız');
  const r1 = await full(o1.id);
  assert.deepEqual([r1.salesUserId, r1.assignedDrawerId, r1.slaDeadline], [null, null, null], 'kural yok: sahip yok, SLA yok');
  assert.equal(await visible('salesA', o1.id), false);
  assert.equal(await visible('salesB', o1.id), false);
  assert.equal(await visible('drawerA', o1.id), false);
  assert.equal(await visible('admin', o1.id), true);
  assert.equal(await visible('inspector', o1.id), true);
  assert.equal(await visible('cust', o1.id), true);
  assert.deepEqual((await recipientsFor(db, 'ORDER_CREATED', { ...r1, customer: firm, createdBy: { ...U.cust }, salesUsers: await orderSalesUsers(db, o1.id) })).map((r) => r.email), ['admin@team.test'], 'yalnızca yönetici');
  assert.deepEqual(await recipientsOf(db, ['orderSales', 'drawer'], r1), []);
  // Atamasız sipariş satışın kararını alamaz; çizime gidemez
  assert.equal(await codeOf(run(o1.id, 'no_drawing', 'admin')), 'SALES_UNASSIGNED');
  assert.equal(await codeOf(run(o1.id, 'send_to_drawing', 'admin')), 'SALES_UNASSIGNED');
  // Kural: yalnızca SETTINGS_MANAGE; hedef etkin satışçı
  assert.deepEqual(await saveRoutingRule(db, { input: { mode: 'AUTO', targetUserId: U.salesA.id }, actor: act(U.salesA) }), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(await saveRoutingRule(db, { input: { mode: 'AUTO', targetUserId: U.drawerA.id }, actor: act(U.admin) }), { ok: false, code: 'TARGET' });
  const rule = await saveRoutingRule(db, { input: { mode: 'AUTO', targetUserId: U.salesA.id }, actor: act(U.admin) });
  assert.ok(rule.ok);
  // Önceden oluşmuş atamasız sipariş değişmez
  assert.equal((await full(o1.id)).salesUserId, null);
  const o2 = await newOrder('Otomatik A');
  const r2 = await full(o2.id);
  assert.deepEqual([r2.salesUserId, r2.assignedDrawerId, r2.salesAssignedVia, r2.routingRuleId, !!r2.slaDeadline], [U.salesA.id, U.drawerA.id, 'AUTO', rule.id, true]);
  assert.equal(await visible('salesA', o2.id), true);
  assert.equal(await visible('salesB', o2.id), false);
  assert.equal(await visible('drawerA', o2.id), false, 'çizim hattı açılmadan çizimci siparişi görmez (DRAWING_SCOPE); çizimci yine de kopyalandı');
  assert.deepEqual((await orderSalesUsers(db, o2.id)).map((u) => u.id), [U.salesA.id]);
  // Gelecekteki kural şimdi etkisiz; MANUAL kural yeni siparişleri atamasız bırakır
  const future = await saveRoutingRule(db, { input: { mode: 'AUTO', targetUserId: U.salesB.id, startsAt: '2030-01-01T09:00' }, actor: act(U.admin) });
  assert.ok(future.ok);
  const st = await routingState(db);
  assert.deepEqual([st.current.id, st.upcoming.map((r) => r.id)], [rule.id, [future.id]]);
  const o3 = await newOrder('Hâlâ A');
  assert.equal((await full(o3.id)).salesUserId, U.salesA.id);
  // Geçersiz hedef (pasif): sessiz atama yok — bekler + yönetici uyarısı
  await db.user.update({ where: { id: U.salesC.id }, data: { isActive: false } });
  const bad = await db.glassRoutingRule.create({ data: { mode: 'AUTO', targetUserId: U.salesC.id, startsAt: new Date(), createdById: U.admin.id } });
  const o4 = await newOrder('Pasif hedef');
  assert.equal((await full(o4.id)).salesUserId, null);
  assert.equal(await db.adminAlert.count({ where: { type: 'ROUTING_TARGET_INVALID', dedupeKey: `routing-invalid:${bad.id}` } }), 1);
  await db.user.update({ where: { id: U.salesC.id }, data: { isActive: true } });
  await db.glassRoutingRule.delete({ where: { id: bad.id } });
  await db.order.deleteMany({ where: { id: o4.id } });
  // Bağlama işareti yokken kural ve atama kapalı
  const link = await db.integrationSetting.findUnique({ where: { key: LINK_SETTING } });
  await db.integrationSetting.delete({ where: { key: LINK_SETTING } });
  assert.deepEqual(await saveRoutingRule(db, { input: { mode: 'MANUAL' }, actor: act(U.admin) }), { ok: false, code: 'NOT_LINKED' });
  assert.equal(await codeOf(run(o1.id, 'assign_sales', 'admin', { salesUserId: U.salesA.id })), 'NOT_LINKED');
  await db.integrationSetting.create({ data: { key: LINK_SETTING, value: link.value } });
}));

dbTest('yönetici ataması ve yönlendirmesi: atomik; çizimci kopyalanır; taslak fiyatlar yeni tabloyla sıfırlanır; ilk gönderimden sonra kapalı; geri çekme sıfırlamaz; yönetici işlem yapınca sahip değişmez', offline(async () => {
  const o = await newOrder('Yönlendirme');
  await db.order.update({ where: { id: o.id }, data: { salesUserId: null, assignedDrawerId: null, routingRuleId: null, salesAssignedVia: null } });
  assert.equal(await codeOf(run(o.id, 'assign_sales', 'salesA', { salesUserId: U.salesA.id })), 'NOT_ALLOWED');
  assert.equal(await codeOf(run(o.id, 'assign_sales', 'admin', { salesUserId: U.drawerA.id })), 'SALES_TARGET');
  await run(o.id, 'assign_sales', 'admin', { salesUserId: U.salesA.id });
  let r = await full(o.id);
  assert.deepEqual([r.salesUserId, r.assignedDrawerId, r.salesAssignedVia, r.salesAssignedById, !!r.slaDeadline], [U.salesA.id, U.drawerA.id, 'MANUAL', U.admin.id, true]);
  assert.equal(await codeOf(run(o.id, 'assign_sales', 'admin', { salesUserId: U.salesA.id })), 'SALES_SAME');
  assert.ok((await db.orderEvent.findMany({ where: { orderId: o.id, event: 'SALES_ASSIGNED' } })).length === 1);
  // Satış A fiyatlar: tablo A (30)
  await run(o.id, 'no_drawing', 'salesA');
  r = await full(o.id);
  assert.deepEqual([r.offers[0].priceTableId, Number(r.offers[0].lines[0].listPrice)], [tables.a, 30]);
  assert.equal(await visible('salesA', o.id), true);
  // Yönetici işlem yapınca sahip değişmez
  await run(o.id, 'hold', 'admin', { note: 'bekle' });
  await run(o.id, 'unhold', 'admin', { note: '' });
  assert.equal((await full(o.id)).salesUserId, U.salesA.id);
  // A'nın taslak fiyatı: 25 (liste 30'dan farklı)
  await run(o.id, 'save_offer', 'salesA', { lines: r.offers[0].lines.map((l) => form(l, { unitPrice: '25.00' })), expectedVersion: (await full(o.id)).version });
  // Satış A'nın iç notu varsa yönlendirme kapalı (önceki ekibin gizli notu açılmasın)
  const note = await addNote(db, { orderId: o.id, actor: act(U.salesA), text: 'gizli', internal: true });
  assert.ok(note.ok);
  assert.equal(await codeOf(run(o.id, 'assign_sales', 'admin', { salesUserId: U.salesB.id })), 'REASSIGN_BLOCKED');
  await db.orderNote.deleteMany({ where: { orderId: o.id } });
  // Yönlendirme B'ye: A'nın erişimi kapanır, B + çizimci B; taslak fiyatlar B'nin tablosundan (35), A'nın 25'i denetim kaydında
  const v = (await full(o.id)).version;
  await run(o.id, 'assign_sales', 'admin', { salesUserId: U.salesB.id, expectedVersion: v });
  r = await full(o.id);
  assert.deepEqual([r.salesUserId, r.assignedDrawerId, r.salesAssignedVia], [U.salesB.id, U.drawerB.id, 'REASSIGN']);
  assert.deepEqual([r.offers[0].priceTableId, Number(r.offers[0].lines[0].unitPrice), Number(r.offers[0].lines[0].listPrice)], [tables.b, 35, 35]);
  assert.equal(await visible('salesA', o.id), false);
  assert.equal(await visible('drawerA', o.id), false);
  assert.equal(await visible('salesB', o.id), true);
  const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_TRANSITION', entityId: o.id, details: { path: ['action'], equals: 'assign_sales' } }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual([audit.details.salesFrom, audit.details.salesTo, audit.details.priceReset.lines[0].unitPrice], [U.salesA.id, U.salesB.id, '25']);
  // A artık işlem yapamaz; B gönderir; geri çeker; artık yönlendirilemez (ilk gönderim kalıcı)
  assert.equal(await codeOf(run(o.id, 'save_offer', 'salesA', { lines: r.offers[0].lines.map((l) => form(l)) })), 'NOT_FOUND');
  await run(o.id, 'submit_offer', 'salesB', { lines: r.offers[0].lines.map((l) => form(l)), expectedVersion: r.version });
  await run(o.id, 'withdraw_offer', 'salesB', { expectedVersion: (await full(o.id)).version });
  assert.equal(await codeOf(run(o.id, 'assign_sales', 'admin', { salesUserId: U.salesA.id })), 'REASSIGN_BLOCKED');
  // Eşleşme değişikliği eski siparişi değiştirmez
  await setDefaultDrawer(db, { salesUserId: U.salesB.id, drawerId: U.drawerA.id, actor: act(U.admin) });
  assert.equal((await full(o.id)).assignedDrawerId, U.drawerB.id);
  await setDefaultDrawer(db, { salesUserId: U.salesB.id, drawerId: U.drawerB.id, actor: act(U.admin) });
}));

dbTest('fiyat: satışçının tablosu yoksa varsayılana düşmez; teklif sürümsüz işlem reddedilmez (servis) ama satır kimliği değişince müşteri fiyatı düşer', offline(async () => {
  assert.equal(await pricingForUser(db, U.salesC.id), null);
  const o = await newOrder('Sürüm');
  await db.order.update({ where: { id: o.id }, data: { salesUserId: U.salesB.id, assignedDrawerId: U.drawerB.id, salesAssignedVia: 'MANUAL' } });
  await run(o.id, 'no_drawing', 'salesB');
  await sendOffer(o.id, 'salesB', '60.00');
  let r = await full(o.id);
  assert.deepEqual([r.offers[0].status, Number(r.offers[0].lines[0].offerPrice)], ['GONDERILDI', 60]);
  // Yönetici geri gönderir; satış ölçüyü değiştirir → o satırın eski müşteri fiyatı geçersiz (null)
  await run(o.id, 'return_offer', 'admin', { lines: r.offers[0].lines.map((l) => form(l, { offerPrice: '60.00' })), returnNote: 'ölçü', expectedVersion: r.version });
  r = await full(o.id);
  await run(o.id, 'save_offer', 'salesB', { lines: r.offers[0].lines.map((l) => form(l, { enMm: 1200 })), expectedVersion: r.version });
  r = await full(o.id);
  assert.equal(r.offers[0].lines[0].offerPrice, null, 'satır kimliği değişti: yönetici fiyatı düştü');
  await run(o.id, 'save_offer', 'salesB', { lines: r.offers[0].lines.map((l) => form(l, { unitPrice: '41.00' })), expectedVersion: r.version });
  // Eski sürümle işlem reddedilir
  assert.equal(await codeOf(run(o.id, 'save_offer', 'salesB', { lines: r.offers[0].lines.map((l) => form(l)), expectedVersion: r.version })), 'CONFLICT');
}));

dbTest('iki ekip + aynı müşteri + ortak yükleme günü: liste / dosya / not / çizim ayrımı; bildirimler doğru ekibe; sandıklar ekip başına; misafir yük ekip aşmaz; nakliye bölümleri', offline(async () => {
  const day = dayOf(-3);
  const oa = await newOrder('Ekip A');
  const ob = await newOrder('Ekip B');
  await db.order.update({ where: { id: oa.id }, data: { salesUserId: U.salesA.id, assignedDrawerId: U.drawerA.id, salesAssignedVia: 'MANUAL', estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
  await db.order.update({ where: { id: ob.id }, data: { salesUserId: U.salesB.id, assignedDrawerId: U.drawerB.id, salesAssignedVia: 'MANUAL', estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
  // Kapsam
  assert.deepEqual([await visible('salesA', oa.id), await visible('salesA', ob.id), await visible('salesB', ob.id), await visible('salesB', oa.id)], [true, false, true, false]);
  // Not: başka ekibin siparişine not eklenemez (kapsam)
  assert.deepEqual((await addNote(db, { orderId: oa.id, actor: act(U.salesB), text: 'x' })).code, 'NOT_FOUND');
  // Çizim: A çizime gider; çizimci B göremez ve işlem yapamaz; çizim dosyası B'ye kapalı; müşteriye nötr ad
  await run(oa.id, 'send_to_drawing', 'salesA');
  assert.equal(await visible('drawerA', oa.id), true);
  assert.equal(await visible('drawerB', oa.id), false);
  assert.equal(await codeOf(run(oa.id, 'start_drawing', 'drawerB')), 'NOT_FOUND');
  await run(oa.id, 'start_drawing', 'drawerA');
  const dr = await db.drawing.create({ data: { orderId: oa.id, version: 1, status: 'ONAY_BEKLIYOR', uploadedById: U.drawerA.id, sentAt: new Date(), files: { create: [{ storageKey: '2026/10/d1.pdf', fileName: 'ali-cizim.pdf', mime: 'application/pdf', size: 10, checksum: 'y', scanStatus: 'CLEAN', uploadedById: U.drawerA.id }] } }, include: { files: true } });
  const fid = dr.files[0].id;
  assert.ok(await findDrawingFile(db, { id: fid, scope: orderScope(U.drawerA), role: 'CIZIM' }));
  assert.equal(await findDrawingFile(db, { id: fid, scope: orderScope(U.drawerB), role: 'CIZIM' }), null, 'başka ekibin çizimcisi dosyayı alamaz');
  assert.equal(await findDrawingFile(db, { id: fid, scope: orderScope(U.salesB), role: 'SATIS' }), null);
  const custFile = await findDrawingFile(db, { id: fid, scope: orderScope(U.cust), role: 'MUSTERI' });
  assert.equal(custFile.name, `${oa.orderNo}-cizim-v1.pdf`, 'müşteriye nötr ad');
  // Revizyon / onay bildirimi: yalnızca atanmış çizimci A + sorumlu satışçı A
  const ro = await db.order.findUniqueOrThrow({ where: { id: oa.id }, include: { assignedDrawer: true, customer: true, createdBy: true } });
  const rev = await recipientsFor(db, 'ORDER_REVISION_REQUESTED', { ...ro, salesUsers: await orderSalesUsers(db, oa.id) });
  assert.deepEqual(rev.map((r) => r.email).sort(), ['drawerA@team.test', 'salesA@team.test']);
  assert.deepEqual((await recipientsOf(db, ['drawer', 'orderSales'], ro)).map((r) => r.id).sort(), [U.drawerA.id, U.salesA.id].sort());
  // Teklifler: her ekip kendi siparişini fiyatlar; yönetici ikisini de gönderir
  await run(ob.id, 'no_drawing', 'salesB');
  await sendOffer(ob.id, 'salesB', '70.00');
  const oaFull = await full(oa.id);
  await run(oa.id, 'submit_offer', 'salesA', { lines: oaFull.offers[0].lines.map((l) => form(l)), expectedVersion: oaFull.version });
  const oaSub = await full(oa.id);
  await run(oa.id, 'approve_offer', 'admin', { lines: oaSub.offers[0].lines.map((l) => form(l, { offerPrice: '50.00' })), expectedVersion: oaSub.version });
  // Sandıklar: satış A yalnızca kendi bölümü; aynı firma aynı gün iki bölüm; numara günde tek
  const row = (n) => ({ crateNo: n, lengthMm: 1000, widthMm: 500, heightMm: 500, netKg: 100, grossKg: 150, note: null, orderIds: [] });
  assert.deepEqual(await saveDayCrates(db, { day, customerId: firm.id, rows: [row(1)], actor: act(U.salesA), links: 'auto', team: U.salesB.id }), { ok: false, code: 'TEAM_FORBIDDEN' });
  const sa = await saveDayCrates(db, { day, customerId: firm.id, rows: [row(1)], actor: act(U.salesA), links: 'auto' });
  assert.deepEqual(sa, { ok: true, count: 1 });
  assert.deepEqual(await saveDayCrates(db, { day, customerId: firm.id, rows: [row(1)], actor: act(U.salesB), links: 'auto' }), { ok: false, code: 'NUMBER_TAKEN', numbers: [1] });
  assert.deepEqual(await saveDayCrates(db, { day, customerId: firm.id, rows: [row(2)], actor: act(U.salesB), links: 'auto' }), { ok: true, count: 1 });
  assert.deepEqual(await saveDayCrates(db, { day, customerId: firm.id, rows: [row(3)], actor: act(U.admin), links: 'auto' }), { ok: false, code: 'TEAM_REQUIRED' }, 'yönetici bölüm seçer');
  const crates = await db.crate.findMany({ where: { customerId: firm.id }, include: { orders: true }, orderBy: { crateNo: 'asc' } });
  assert.deepEqual(crates.map((c) => [c.crateNo, c.salesUserId, c.orders.map((x) => x.orderId)]), [[1, U.salesA.id, [oa.id]], [2, U.salesB.id, [ob.id]]], 'sandık yalnızca kendi satışçısının siparişine bağlı; A\'nın kaydı B\'ninkini silmedi');
  // Misafir yük: başka ekibin sandığına konamaz (host firma seçimi aynı satışçının yüklemesini ister)
  const firm2 = await db.customer.create({ data: { name: 'Baska', prefix: 'BAS', email: 'o@bas-team.test' } });
  const og = await db.order.create({ data: { orderNo: 'BAS1', customerOrderNo: '1', title: 'g', customerId: firm2.id, createdById: U.cust.id, status: 'HAZIRLANIYOR', salesUserId: U.salesB.id, estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
  // Ev sahibi firma (GLA) aynı gün satış B'nin siparişiyle yüklüyor → seçilebilir; satış A'nın siparişi olsaydı seçilemezdi
  assert.equal((await setGuestHost(db, { orderId: og.id, hostId: firm.id, actor: act(U.admin) })).ok, true);
  const crateA = crates.find((c) => c.crateNo === 1), crateB = crates.find((c) => c.crateNo === 2);
  assert.deepEqual(await assignGuestCrate(db, { day, orderId: og.id, crateId: crateA.id, actor: act(U.salesB) }), { ok: false, code: 'OTHER_TEAM' });
  assert.deepEqual(await assignGuestCrate(db, { day, orderId: og.id, crateId: crateB.id, actor: act(U.salesA) }), { ok: false, code: 'NOT_FOUND' }, 'satış A başkasının siparişini yerleştiremez');
  assert.deepEqual(await assignGuestCrate(db, { day, orderId: og.id, crateId: crateB.id, actor: act(U.salesB) }), { ok: true, crateNo: 2 });
  // Nakliye: satış A yalnızca kendi bölümü; yönetici iki bölüm + genel toplam
  const names = (id) => ({ [U.salesA.id]: 'A', [U.salesB.id]: 'B' })[id] ?? '-';
  const la = await transportList(db, day, { salesUserId: U.salesA.id, teamName: names });
  assert.deepEqual([la.sections.map((s) => s.name), la.crateCount, la.totalKg], [['A'], 1, 150]);
  const all = await transportList(db, day, { teamName: names });
  assert.deepEqual([all.sections.map((s) => [s.name, s.crateCount]), all.crateCount, all.totalKg], [[['A', 1], ['B', 1]], 2, 300]);
  // Yükleme onayı (ortak gün, iki ekip) → muhasebe hesapları ekip başına
  const plan = await previewLoading(db, day);
  const conf = await confirmLoading(db, { day, key: plan.key, actor: act(U.admin) });
  assert.ok(conf.ok, JSON.stringify(conf));
  const data = await supplierData(db, new Date(Date.now() + 86_400_000));
  const acc = Object.fromEntries(data.accounts.accounts.map((a) => [a.account ?? 'none', a.byCur.EUR?.cost ?? 0]));
  assert.equal(acc[U.salesA.id], 60, 'A: 2 m² × 30 (A tablosu; onaylı yükleme kopyası)');
  assert.equal(acc[U.salesB.id], 70, 'B: 2 m² × 35 (B tablosu)');
  assert.equal(data.accounts.overview.EUR.cost, data.summary.EUR.cost, 'hesapların toplamı genel özete eşit');
}));

dbTest('telafi: kaynağın satışçısı / çizimcisi -T siparişine kopyalanır; başka ekibin siparişi hedef olamaz; satış başka ekibin siparişinde telafi açamaz', offline(async () => {
  const src = await newOrder('Telafi kaynak');
  const other = await newOrder('Başka ekip hedef');
  const future = dayOf(12);
  for (const [o, s, d] of [[src, U.salesA, U.drawerA], [other, U.salesB, U.drawerB]]) {
    await db.order.update({ where: { id: o.id }, data: { salesUserId: s.id, assignedDrawerId: d.id, salesAssignedVia: 'MANUAL', estimatedShipDate: new Date(`${future}T12:00:00Z`) } });
    await run(o.id, 'no_drawing', s === U.salesA ? 'salesA' : 'salesB');
    await sendOffer(o.id, s === U.salesA ? 'salesA' : 'salesB', '60.00');
  }
  const line = (await full(src.id)).offers[0].lines[0];
  assert.deepEqual(await createCompensation(db, { orderId: src.id, lineId: line.id, quantity: 1, mode: 'FREE', dest: { type: 'NEW', day: dayOf(20) }, requestKey: key(), confirm: true, actor: act(U.salesB) }), { ok: false, code: 'NOT_FOUND' }, 'B kendi olmayan siparişte telafi açamaz');
  const bad = await createCompensation(db, { orderId: src.id, lineId: line.id, quantity: 1, mode: 'FREE', dest: { type: 'EXISTING', orderId: other.id }, requestKey: key(), confirm: true, actor: act(U.salesA) });
  assert.deepEqual([bad.ok, bad.code], [false, 'DEST_OTHER_SALES']);
  const ok = await createCompensation(db, { orderId: src.id, lineId: line.id, quantity: 1, mode: 'FREE', dest: { type: 'NEW', day: dayOf(20) }, requestKey: key(), confirm: true, actor: act(U.salesA) });
  assert.ok(ok.ok, JSON.stringify(ok));
  const t = await full(ok.destOrderId);
  assert.deepEqual([t.salesUserId, t.assignedDrawerId, t.orderNo.endsWith('-T')], [U.salesA.id, U.drawerA.id, true]);
  assert.equal(await visible('salesB', t.id), false);
}));

dbTest('fabrika ödemeleri: hesap zorunlu; hesap değişikliği aynı kayıt, A azalır B artar, genel toplam değişmez, denetim; para birimleri ayrı', offline(async () => {
  assert.deepEqual(await addFactoryPayment(db, { paidOn: new Date(), amount: 10, currency: 'EUR', note: null, salesUserId: U.salesA.id, actor: act(U.salesA) }), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(await addFactoryPayment(db, { paidOn: new Date(), amount: 10, currency: 'EUR', note: null, salesUserId: '', actor: act(U.admin) }), { ok: false, code: 'ACCOUNT' });
  assert.deepEqual(await addFactoryPayment(db, { paidOn: new Date(), amount: 10, currency: 'EUR', note: null, salesUserId: U.drawerA.id, actor: act(U.admin) }), { ok: false, code: 'ACCOUNT' });
  const p1 = await addFactoryPayment(db, { paidOn: new Date(), amount: 100, currency: 'EUR', note: 'a', salesUserId: U.salesA.id, actor: act(U.admin) });
  const p2 = await addFactoryPayment(db, { paidOn: new Date(), amount: 30, currency: 'EUR', note: 'b', salesUserId: U.salesB.id, actor: act(U.admin) });
  const p3 = await addFactoryPayment(db, { paidOn: new Date(), amount: 500, currency: 'RON', note: 'c', salesUserId: U.salesC.id, actor: act(U.admin) });
  assert.ok(p1.ok && p2.ok && p3.ok);
  const before = await supplierData(db, new Date(Date.now() + 86_400_000));
  const cell = (d, id, cur) => d.accounts.accounts.find((a) => a.account === id)?.byCur[cur] ?? { cost: 0, paid: 0, balance: 0 };
  const a0 = cell(before, U.salesA.id, 'EUR'), b0 = cell(before, U.salesB.id, 'EUR');
  assert.deepEqual([a0.paid, b0.paid, cell(before, U.salesC.id, 'RON').paid], [100, 30, 500]);
  assert.equal(before.accounts.overview.EUR.paid, before.summary.EUR.paid);
  // Değişiklik: yalnızca yönetici; hedef geçerli; ekrandaki hesap eskiyse STALE
  assert.deepEqual(await changePaymentAccount(db, { paymentId: p1.id, salesUserId: U.salesB.id, expected: U.salesA.id, actor: act(U.salesA) }), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(await changePaymentAccount(db, { paymentId: p1.id, salesUserId: U.salesB.id, expected: U.salesB.id, actor: act(U.admin) }), { ok: false, code: 'STALE' });
  assert.deepEqual(await changePaymentAccount(db, { paymentId: p1.id, salesUserId: U.drawerA.id, expected: U.salesA.id, actor: act(U.admin) }), { ok: false, code: 'ACCOUNT' });
  assert.deepEqual(await changePaymentAccount(db, { paymentId: 'yok', salesUserId: U.salesB.id, expected: null, actor: act(U.admin) }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await changePaymentAccount(db, { paymentId: p1.id, salesUserId: U.salesB.id, expected: U.salesA.id, actor: act(U.admin) }), { ok: true, changed: true });
  const after = await supplierData(db, new Date(Date.now() + 86_400_000));
  const a1 = cell(after, U.salesA.id, 'EUR'), b1 = cell(after, U.salesB.id, 'EUR');
  assert.deepEqual([a1.paid, b1.paid], [a0.paid - 100, b0.paid + 100]);
  assert.deepEqual([a1.cost, b1.cost], [a0.cost, b0.cost], 'maliyetler değişmez');
  assert.deepEqual([after.summary.EUR.paid, after.summary.EUR.cost, after.summary.EUR.balance], [before.summary.EUR.paid, before.summary.EUR.cost, before.summary.EUR.balance], 'genel toplam değişmez');
  assert.equal(await db.factoryPayment.count(), 3, 'aynı kayıt: silinip yeniden girilmedi');
  const p = await db.factoryPayment.findUniqueOrThrow({ where: { id: p1.id } });
  assert.deepEqual([p.salesUserId, p.amount.toString(), p.note], [U.salesB.id, '100', 'a']);
  const audit = await db.auditLog.findFirst({ where: { action: 'FACTORY_PAYMENT_ACCOUNT_CHANGED', entityId: p1.id } });
  assert.deepEqual([audit.details.from, audit.details.to, audit.details.amount], [U.salesA.id, U.salesB.id, '100']);
  // Borçlu / avanslı toplamlar ayrı ve net bakiyeye eşit
  const ov = after.accounts.overview.EUR;
  assert.equal(Math.round((ov.debt - ov.advance) * 100) / 100, ov.balance);
  // Eski "sil" davranışı korunur (sadece servis dışı; burada satır sayısı)
}));

dbTest('geçmiş veri bağlama: açık hedef; önizleme yazmaz; uygulama toplamları değiştirmez; işaret ve varsayılan kural; ikinci uygulama reddedilir', offline(async () => {
  // Tek ekip geçmişini taklit: satışçısız siparişler, sandık, ödeme; işaret kaldırılır
  await db.integrationSetting.delete({ where: { key: LINK_SETTING } });
  const legacyDay = dayOf(-40);
  const l1 = await newOrder('Eski 1');
  const l2 = await newOrder('Eski 2');
  for (const o of [l1, l2]) {
    await db.order.update({ where: { id: o.id }, data: { salesUserId: null, assignedDrawerId: null, routingRuleId: null, salesAssignedVia: null, estimatedShipDate: new Date(`${legacyDay}T12:00:00Z`) } });
  }
  await db.crate.create({ data: { shipDay: new Date(`${legacyDay}T00:00:00Z`), customerId: firm.id, crateNo: 9, netAgirlik: 10, brutAgirlik: 20, orders: { create: [{ orderId: l1.id }] } } });
  await db.factoryPayment.create({ data: { paidOn: new Date(), amount: '7', currency: 'EUR', createdById: U.admin.id } });
  await db.user.update({ where: { id: U.salesC.id }, data: { defaultDrawerId: null } });
  const snap = await totalsSnapshot(db);
  const nullOrders = await db.order.count({ where: { orderTypeCode: 'GLASS_ORDER', salesUserId: null } });
  assert.ok(nullOrders >= 2);
  // Hedef hesap tahmin edilmez: verilmeyen / geçersiz hedef engeldir
  const pr0 = await previewLink(db, { targetEmail: 'yok@team.test' });
  assert.deepEqual([pr0.ok, pr0.problems.includes('TARGET_NOT_SALES')], [false, true]);
  const prNoDrawer = await previewLink(db, { targetEmail: 'salesC@team.test' });
  assert.ok(prNoDrawer.problems.includes('NO_DRAWER'), 'varsayılan çizimcisi olmayan hedef: çizimci açıkça verilmeli');
  const pre = await previewLink(db, { targetEmail: 'salesC@team.test', drawerEmail: 'drawerA@team.test' });
  assert.ok(pre.ok, JSON.stringify(pre.problems));
  assert.deepEqual([pre.plan.orders, pre.plan.crates, pre.plan.payments, pre.plan.setDefaultDrawer], [nullOrders, 1, 1, true]);
  assert.ok(pre.ambiguities.some((a) => a.code === 'OTHER_SALES_ACCOUNTS'), 'başka satış hesapları raporlanır');
  assert.ok(pre.ambiguities.some((a) => a.code === 'ALREADY_OWNED_ORDERS'));
  assert.equal(await routingLinked(db), false, 'önizleme hiçbir şey yazmadı');
  assert.equal((await full(l1.id)).salesUserId, null);
  const outboxBefore = await db.notificationOutbox.count();
  const eventsBefore = await db.orderEvent.count();
  const r = await applyLink(db, { targetEmail: 'salesC@team.test', drawerEmail: 'drawerA@team.test', operator: 'test' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.counts.orders, r.counts.crates, r.counts.payments, r.counts.drawers], [nullOrders, 1, 1, nullOrders]);
  assert.ok(sameTotals(snap, r.after) && accountsMatchSummary(r.after), 'para birimi başına toplamlar ve sayımlar değişmedi');
  const l1a = await full(l1.id);
  assert.deepEqual([l1a.salesUserId, l1a.assignedDrawerId, l1a.salesAssignedVia, l1a.salesAssignedAt], [U.salesC.id, U.drawerA.id, 'MIGRATION', null]);
  assert.equal((await db.crate.findFirst({ where: { crateNo: 9 } })).salesUserId, U.salesC.id);
  assert.equal(await db.factoryPayment.count({ where: { salesUserId: null } }), 0);
  assert.equal((await db.user.findUnique({ where: { id: U.salesC.id } })).defaultDrawerId, U.drawerA.id);
  assert.equal(await routingLinked(db), true);
  assert.equal((await routingState(db)).current.targetUserId, U.salesC.id, 'ilk etkinleştirme: yeni siparişler mevcut satışçıya');
  assert.deepEqual([await db.notificationOutbox.count(), await db.orderEvent.count()], [outboxBefore, eventsBefore], 'bildirim / olay üretmez');
  assert.equal(await db.auditLog.count({ where: { action: 'SALES_LINK_APPLIED' } }), 1);
  const again = await applyLink(db, { targetEmail: 'salesC@team.test', drawerEmail: 'drawerA@team.test' });
  assert.deepEqual([again.ok, again.code], [false, 'ALREADY_LINKED']);
  // Bağlamadan sonra yeni sipariş otomatik C'ye
  const n = await newOrder('Bağlama sonrası');
  assert.equal((await full(n.id)).salesUserId, U.salesC.id);
}));

dbTest('tek ekip regresyonu: tek ekip varsayılanlı veritabanında (resetDb) sipariş akışı eskisi gibi — sahip ilk satışçı, çizimci ilk çizimci, bildirimler aynı', offline(async () => {
  await resetDb(db);
  const f = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  const c = await db.customer.create({ data: { name: 'Tek Ekip', prefix: 'TEK', email: 'o@tek.test' } });
  const admin = await db.user.create({ data: { email: 'a@tek.test', name: 'a', type: 'INTERNAL', appRole: 'ADMIN', customerId: f.id } });
  const sales = await db.user.create({ data: { email: 's@tek.test', name: 's', type: 'INTERNAL', appRole: 'SATIS', customerId: f.id } });
  const drawer = await db.user.create({ data: { email: 'd@tek.test', name: 'd', type: 'INTERNAL', appRole: 'CIZIM', customerId: f.id } });
  const cust = await db.user.create({ data: { email: 'm@tek.test', name: 'm', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: c.id, canApprove: true } });
  assert.equal((await db.user.findUnique({ where: { id: sales.id } })).defaultDrawerId, drawer.id, 'tek ekip tetikleyicisi: çizimci sonradan eklenince eşleşir');
  const next = await suggestNextNo(db, c.id);
  const o = await createGlassOrder(db, { actor: act(cust), firm: c, title: 'tek', requestedNo: next, suggestedNo: next, items: [{ glassName: 'x', camAdedi: 1 }], files: [] });
  const r = await db.order.findUniqueOrThrow({ where: { id: o.id } });
  assert.deepEqual([r.salesUserId, r.assignedDrawerId], [sales.id, drawer.id]);
  await runOrderAction(db, { orderId: o.id, action: 'send_to_drawing', actor: act(sales), payload: {} });
  const recipients = await recipientsOf(db, ['drawer', 'orderSales', 'admin'], await db.order.findUniqueOrThrow({ where: { id: o.id } }));
  assert.deepEqual(recipients.map((x) => x.id).sort(), [admin.id, drawer.id, sales.id].sort());
  await dispatchInApp(db);
}));
