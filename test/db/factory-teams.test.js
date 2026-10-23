// Fabrika Ekipleri (4.3.19, karar 304) — veritabanıyla: ekip = satışçı + ad + aktiflik; çizimci / fiyat tablosu / finansal
// hesap var olan alanlar. Ekip oluşturma ve eşleştirme, aktif ekipler arasında tekillik, satışçı değişince çizimcinin
// birlikte değişmesi, bağımsız çizimci değiştirmenin olmaması, ilk atamada çizim geçmişi koruması, pasif ekibe yönlendirme
// / atama engeli, pasifleştirmenin geçmişe dokunmaması, nakliye listesinde ekip adı, ekip izolasyonu.
// Çok ekipli: resetDb(db, { singleTeam: false }). Hiçbir dış servise gidilmez (offline).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { availableActions } from '../../server/orders/rules.js';
import { saveRoutingRule, setDefaultDrawer } from '../../server/orders/sales-routing.js';
import { orderScope } from '../../server/orders/scope.js';
import { assignTable, pricingForUser, savePrices, saveTable } from '../../server/pricing/tables.js';
import { loadTeamsAdmin, saveTeam, setTeamActive } from '../../server/teams/service.js';
import { teamNames } from '../../server/teams/state.js';
import { transportList } from '../../server/loading/transport.js';
import { addFactoryPayment } from '../../server/accounting/factory-accounts.js';
import { can } from '../../server/auth/permissions.js';

let db, factory, firm, glass, tables;
const U = {};
const T = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const run = (orderId, action, who, payload = {}) => runOrderAction(db, { orderId, action, actor: act(U[who]), payload });
const codeOf = async (p) => p.then(() => 'OK', (e) => e.code ?? e.message);
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
let fileNo = 0;
const newOrder = async (title) => {
  const next = await suggestNextNo(db, firm.id);
  fileNo += 1;
  return createGlassOrder(db, {
    actor: act(U.cust), firm, title, requestedNo: next, suggestedNo: next,
    items: [{ glassProductId: glass.id, glassName: '8mm Temperli', glassNameRo: 'Sticlă 8', glassWeightKgM2: 20, camAdedi: 2 }],
    files: [{ storageKey: `2026/10/ft-${fileNo}.pdf`, name: `ft-${fileNo}.pdf`, size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
};
const order = (id) => db.order.findUniqueOrThrow({ where: { id } });
const visible = (who, orderId) => db.order.findFirst({ where: { id: orderId, ...orderScope(U[who]) }, select: { id: true } }).then((r) => !!r);
const version = async (id) => (await order(id)).version;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db, { singleTeam: false });
  factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Glass and More', prefix: 'GLA', email: 'office@gla-ft.test' } });
  glass = await db.glassProduct.create({ data: { nameTr: '8mm Temperli', colorTr: '', nameRo: 'Sticlă 8', colorRo: '', weightKgM2: 20 } });
  const mk = async (k, appRole, customerId, extra = {}) => { U[k] = await db.user.create({ data: { email: `${k}@ft.test`, name: k, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } }); };
  await mk('admin', 'ADMIN', factory.id);
  await mk('assistant', 'YONETICI_YARDIMCISI', factory.id);
  await mk('murat', 'SATIS', factory.id);
  await mk('hamza', 'SATIS', factory.id);
  await mk('third', 'SATIS', factory.id);
  await mk('meltem', 'CIZIM', factory.id);
  await mk('erhan', 'CIZIM', factory.id);
  await mk('drawer3', 'CIZIM', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
  const a = await saveTable(db, null, { name: 'Trakya', currency: 'EUR', holePrice: 3, cncPrice: 12 }, act(U.admin));
  const b = await saveTable(db, null, { name: 'GlassWorld', currency: 'EUR', holePrice: 4, cncPrice: 14 }, act(U.admin));
  tables = { a: a.id, b: b.id };
  await savePrices(db, tables.a, { [glass.id]: 30 }, act(U.admin));
  await savePrices(db, tables.b, { [glass.id]: 35 }, act(U.admin));
});
after(closeDb);

dbTest('1–2: yönetici ekip oluşturur, var olan hesapları eşleştirir; yalnızca yönetici; ikinci eşleştirme yok (alanlar kullanıcıda)', offline(async () => {
  const input = { name: 'Trakya Cam', salesUserId: U.murat.id, drawerId: U.meltem.id, priceTableId: tables.a };
  assert.deepEqual(await saveTeam(db, { input, actor: act(U.murat) }), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(await saveTeam(db, { input, actor: act(U.assistant) }), { ok: false, code: 'FORBIDDEN' }, 'yönetici yardımcısında USER_MANAGE yok');
  assert.equal(await db.factoryTeam.count(), 0);
  assert.deepEqual((await saveTeam(db, { input: { ...input, name: 'x' }, actor: act(U.admin) })).code, 'NAME');
  assert.deepEqual((await saveTeam(db, { input: { ...input, drawerId: '' }, actor: act(U.admin) })).code, 'DRAWER');
  assert.deepEqual((await saveTeam(db, { input: { ...input, drawerId: U.hamza.id }, actor: act(U.admin) })).code, 'DRAWER');
  assert.deepEqual((await saveTeam(db, { input: { ...input, salesUserId: U.meltem.id }, actor: act(U.admin) })).code, 'SALES');
  const t1 = await saveTeam(db, { input, actor: act(U.admin) });
  assert.ok(t1.ok && t1.created, JSON.stringify(t1));
  T.trakya = t1.id;
  const murat = await db.user.findUniqueOrThrow({ where: { id: U.murat.id } });
  assert.deepEqual([murat.defaultDrawerId, murat.priceTableId], [U.meltem.id, tables.a], 'çizimci ve tablo satışçının var olan alanlarında');
  assert.deepEqual((await saveTeam(db, { input: { ...input, name: 'Başka ad' }, actor: act(U.admin) })).code, 'SALES_IN_TEAM');
  assert.deepEqual((await saveTeam(db, { input: { name: 'trakya CAM', salesUserId: U.hamza.id, drawerId: U.erhan.id }, actor: act(U.admin) })).code, 'NAME_TAKEN', 'ad büyük / küçük harf duyarsız tekil');
  // Aynı çizimci / aynı tablo ikinci aktif ekibe bağlanamaz
  assert.deepEqual((await saveTeam(db, { input: { name: 'GlassWorld', salesUserId: U.hamza.id, drawerId: U.meltem.id, priceTableId: tables.b }, actor: act(U.admin) })).code, 'DRAWER_IN_TEAM');
  assert.deepEqual((await saveTeam(db, { input: { name: 'GlassWorld', salesUserId: U.hamza.id, drawerId: U.erhan.id, priceTableId: tables.a }, actor: act(U.admin) })).code, 'TABLE_IN_TEAM');
  const t2 = await saveTeam(db, { input: { name: 'GlassWorld', salesUserId: U.hamza.id, drawerId: U.erhan.id, priceTableId: tables.b }, actor: act(U.admin) });
  assert.ok(t2.ok);
  T.gw = t2.id;
  // Düzenleme: satışçı değişmez (girdi yok sayılır), ad değişir
  const e = await saveTeam(db, { input: { id: T.gw, name: 'Glass World', salesUserId: U.third.id, drawerId: U.erhan.id, priceTableId: tables.b }, actor: act(U.admin) });
  assert.deepEqual([e.ok, e.created], [true, false]);
  const gw = await db.factoryTeam.findUniqueOrThrow({ where: { id: T.gw } });
  assert.deepEqual([gw.name, gw.salesUserId], ['Glass World', U.hamza.id]);
  assert.equal(await db.auditLog.count({ where: { action: 'FACTORY_TEAM_CREATED' } }), 2);
  assert.equal(await db.auditLog.count({ where: { action: 'FACTORY_TEAM_UPDATED' } }), 1);
  // Eski ekranlar da kuralı uygular: Kullanıcılar (varsayılan çizimci) ve Fiyat Tabloları (atama)
  assert.deepEqual(await setDefaultDrawer(db, { salesUserId: U.hamza.id, drawerId: U.meltem.id, actor: act(U.admin) }), { ok: false, code: 'DRAWER_IN_TEAM' });
  const prep = (r) => can(r, 'OFFER_PREPARE');
  assert.deepEqual(await assignTable(db, U.hamza.id, tables.a, act(U.admin), prep), { ok: false, code: 'TABLE_IN_TEAM' });
  // Ekibi olmayan satışçı serbest (geriye uyum): tekillik yalnızca aktif ekipler arasında
  assert.deepEqual(await setDefaultDrawer(db, { salesUserId: U.third.id, drawerId: U.meltem.id, actor: act(U.admin) }), { ok: true, changed: true });
  await setDefaultDrawer(db, { salesUserId: U.third.id, drawerId: U.drawer3.id, actor: act(U.admin) });
  const admin = await loadTeamsAdmin(db);
  assert.deepEqual(admin.teams.map((x) => x.name).sort(), ['Glass World', 'Trakya Cam']);
  assert.deepEqual(admin.freeSales.map((x) => x.id), [U.third.id]);
  // 8: fiyatlar ekip başına
  assert.equal((await pricingForUser(db, U.murat.id)).prices.get(glass.id), 30);
  assert.equal((await pricingForUser(db, U.hamza.id)).prices.get(glass.id), 35);
}));

dbTest('3–7: yeni sipariş doğru satışçı + çizimciye; satışçı değişince çizimci birlikte değişir; bağımsız çizimci değiştirme yok; ekipler birbirini görmez', offline(async () => {
  const rule = await saveRoutingRule(db, { input: { mode: 'AUTO', targetUserId: U.murat.id }, actor: act(U.admin) });
  assert.ok(rule.ok);
  const o = await newOrder('Trakya siparişi');
  const r = await order(o.id);
  assert.deepEqual([r.salesUserId, r.assignedDrawerId, r.salesAssignedVia], [U.murat.id, U.meltem.id, 'AUTO']);
  // Bağımsız çizimci değiştirme yok: işlem listede yok, doğrudan gönderilse de reddedilir
  const acts = availableActions({ role: 'ADMIN', status: r.status, offer: null, drawing: r.drawingTrack, orderType: 'GLASS_ORDER' });
  assert.ok(acts.includes('assign_sales'));
  assert.ok(!acts.includes('assign_drawer'), 'bağımsız çizimci değiştirme işlemi yok');
  assert.notEqual(await codeOf(run(o.id, 'assign_drawer', 'admin', { drawerId: U.erhan.id, expectedVersion: r.version })), 'OK');
  assert.equal((await order(o.id)).assignedDrawerId, U.meltem.id);
  // Satışçı değişince çizimci yeni satışçının varsayılanı olur (tek işlem)
  await run(o.id, 'assign_sales', 'admin', { salesUserId: U.hamza.id, expectedVersion: await version(o.id) });
  const r2 = await order(o.id);
  assert.deepEqual([r2.salesUserId, r2.assignedDrawerId, r2.salesAssignedVia], [U.hamza.id, U.erhan.id, 'REASSIGN']);
  const audit = await db.auditLog.findFirst({ where: { action: 'ORDER_TRANSITION', entityId: o.id, details: { path: ['action'], equals: 'assign_sales' } }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual([audit.details.drawerFrom, audit.details.drawerTo], [U.meltem.id, U.erhan.id]);
  // İzolasyon (sunucu kapsamı): yalnızca sorumlu satışçı; diğer ekibin satışçısı ve çizimcisi görmez
  assert.equal(await visible('hamza', o.id), true);
  assert.equal(await visible('murat', o.id), false);
  await run(o.id, 'send_to_drawing', 'hamza');
  assert.equal(await visible('erhan', o.id), true);
  assert.equal(await visible('meltem', o.id), false, 'diğer ekibin çizimcisi erişemez');
  // Çizim başladıktan sonra satışçı (ve dolayısıyla çizimci) değişemez — çizimler korunur
  assert.equal(await codeOf(run(o.id, 'assign_sales', 'admin', { salesUserId: U.murat.id, expectedVersion: await version(o.id) })), 'REASSIGN_BLOCKED');
  await db.glassRoutingRule.deleteMany({});
}));

dbTest('ilk atama: çizimci satışçının varsayılanı; başka çizimcide çizim geçmişi varsa atama engellenir, kayıtlar değişmez', offline(async () => {
  // Sahipsiz eski sipariş, çizimcisi meltem, çizim geçmişi yok → Hamza'ya atanır, çizimci Erhan olur
  const a = await newOrder('Eski A');
  await db.order.update({ where: { id: a.id }, data: { salesUserId: null, assignedDrawerId: U.meltem.id } });
  await run(a.id, 'assign_sales', 'admin', { salesUserId: U.hamza.id, expectedVersion: await version(a.id) });
  assert.deepEqual([(await order(a.id)).salesUserId, (await order(a.id)).assignedDrawerId], [U.hamza.id, U.erhan.id]);
  // Sahipsiz eski sipariş, meltem'de çizim sürümü var → Hamza'ya atanamaz (DRAWER_HISTORY); Murat'a atanabilir
  const b = await newOrder('Eski B');
  await db.order.update({ where: { id: b.id }, data: { salesUserId: null, assignedDrawerId: U.meltem.id, status: 'HAZIRLANIYOR', drawingTrack: 'ONAY_BEKLIYOR' } });
  const d = await db.drawing.create({ data: { orderId: b.id, version: 1, status: 'ONAYLANDI', uploadedById: U.meltem.id } });
  const before = await order(b.id);
  assert.equal(await codeOf(run(b.id, 'assign_sales', 'admin', { salesUserId: U.hamza.id, expectedVersion: before.version })), 'DRAWER_HISTORY');
  const still = await order(b.id);
  assert.deepEqual([still.salesUserId, still.assignedDrawerId, still.version], [null, U.meltem.id, before.version], 'hiçbir şey yazılmadı');
  assert.equal((await db.drawing.findUniqueOrThrow({ where: { id: d.id } })).status, 'ONAYLANDI');
  await run(b.id, 'assign_sales', 'admin', { salesUserId: U.murat.id, expectedVersion: before.version });
  assert.deepEqual([(await order(b.id)).salesUserId, (await order(b.id)).assignedDrawerId], [U.murat.id, U.meltem.id]);
}));

dbTest('pasif ekip: geçmiş ve hesaplar değişmez; yeni yönlendirme / atama engellenir; kural pasif ekibi gösteriyorsa açık uyarı', offline(async () => {
  const rule = await saveRoutingRule(db, { input: { mode: 'AUTO', targetUserId: U.hamza.id }, actor: act(U.admin) });
  assert.ok(rule.ok);
  const old = await newOrder('Pasiften önce');
  assert.equal((await order(old.id)).salesUserId, U.hamza.id);
  const hamzaBefore = await db.user.findUniqueOrThrow({ where: { id: U.hamza.id } });
  assert.deepEqual(await setTeamActive(db, { id: T.gw, active: false, actor: act(U.assistant) }), { ok: false, code: 'FORBIDDEN' });
  const off = await setTeamActive(db, { id: T.gw, active: false, actor: act(U.admin) });
  assert.deepEqual(off, { ok: true, changed: true, routingWarning: true }, 'kural bu satışçıyı gösteriyor: uyarı');
  const hamzaAfter = await db.user.findUniqueOrThrow({ where: { id: U.hamza.id } });
  assert.deepEqual([hamzaAfter.isActive, hamzaAfter.defaultDrawerId, hamzaAfter.priceTableId], [hamzaBefore.isActive, hamzaBefore.defaultDrawerId, hamzaBefore.priceTableId], 'kullanıcı hesabı ve bağlantılar değişmedi');
  const oldAfter = await order(old.id);
  assert.deepEqual([oldAfter.salesUserId, oldAfter.assignedDrawerId], [U.hamza.id, U.erhan.id], 'geçmiş sipariş değişmedi');
  assert.equal(await visible('hamza', old.id), true, 'satışçı kendi geçmiş siparişini görmeye devam eder');
  // Kural pasif ekibi gösteriyor → sipariş atama bekler, yöneticiye uyarı (sebep TEAM_INACTIVE)
  const n = await newOrder('Pasif ekibe yönlendirme');
  assert.equal((await order(n.id)).salesUserId, null);
  const alert = await db.adminAlert.findFirst({ where: { type: 'ROUTING_TARGET_INVALID', dedupeKey: `routing-invalid:${rule.id}` } });
  assert.equal(alert?.details?.reason, 'TEAM_INACTIVE');
  assert.equal((await loadTeamsAdmin(db)).routingToInactive, true);
  // Yeni kural ve elle atama pasif ekibe yapılamaz
  assert.deepEqual(await saveRoutingRule(db, { input: { mode: 'AUTO', targetUserId: U.hamza.id }, actor: act(U.admin) }), { ok: false, code: 'TEAM_INACTIVE' });
  assert.equal(await codeOf(run(n.id, 'assign_sales', 'admin', { salesUserId: U.hamza.id, expectedVersion: await version(n.id) })), 'TEAM_INACTIVE');
  // Pasif ekibin çizimcisi / tablosu başka aktif ekipte kullanılabilir; aktifleştirmede çakışma reddedilir
  assert.deepEqual(await setDefaultDrawer(db, { salesUserId: U.third.id, drawerId: U.erhan.id, actor: act(U.admin) }), { ok: true, changed: true });
  const t3 = await saveTeam(db, { input: { name: 'Üçüncü', salesUserId: U.third.id, drawerId: U.erhan.id }, actor: act(U.admin) });
  assert.ok(t3.ok);
  assert.deepEqual((await setTeamActive(db, { id: T.gw, active: true, actor: act(U.admin) })).code, 'DRAWER_IN_TEAM');
  await setTeamActive(db, { id: t3.id, active: false, actor: act(U.admin) });
  assert.deepEqual(await setTeamActive(db, { id: T.gw, active: true, actor: act(U.admin) }), { ok: true, changed: true, routingWarning: false });
  assert.equal(await db.auditLog.count({ where: { action: 'FACTORY_TEAM_DEACTIVATED' } }), 2);
  await db.glassRoutingRule.deleteMany({});
}));

dbTest('10: nakliye listesi bölüm başlığı ekip adı; ekip ara toplamları ve genel toplam; finansal hesaplar ayrı', offline(async () => {
  const day = dayOf(3);
  const mkOrder = (no, sales) => db.order.create({ data: { orderNo: `GLA${no}`, customerOrderNo: String(no), title: 't', customerId: firm.id, createdById: U.cust.id, status: 'URETIMDE', salesUserId: sales, estimatedShipDate: new Date(`${day}T12:00:00Z`) } });
  const oa = await mkOrder(901, U.murat.id);
  const ob = await mkOrder(902, U.hamza.id);
  const crate = (no, sales, orderId, kg) => db.crate.create({ data: { shipDay: new Date(`${day}T00:00:00Z`), customerId: firm.id, crateNo: no, salesUserId: sales, netAgirlik: kg - 50, brutAgirlik: kg, orders: { create: [{ orderId }] } } });
  await crate(1, U.murat.id, oa.id, 400);
  await crate(2, U.murat.id, oa.id, 300);
  await crate(3, U.hamza.id, ob.id, 500);
  const names = await teamNames(db);
  const teamName = (id) => (id ? names.get(id) ?? '—' : '—');
  const all = await transportList(db, day, { teamName });
  assert.deepEqual(all.sections.map((s) => [s.name, s.crateCount, s.totalKg]), [['Glass World', 1, 500], ['Trakya Cam', 2, 700]]);
  assert.deepEqual([all.crateCount, all.totalKg], [3, 1200]);
  const own = await transportList(db, day, { salesUserId: U.murat.id, teamName });
  assert.deepEqual(own.sections.map((s) => s.name), ['Trakya Cam'], 'satış yalnızca kendi bölümünü alır');
  // Finansal hesap: ödeme seçilen satışçı (ekip) hesabına; diğerine karışmaz
  const p = await addFactoryPayment(db, { paidOn: new Date(), amount: 100, currency: 'EUR', note: null, salesUserId: U.murat.id, actor: act(U.admin) });
  assert.ok(p.ok);
  assert.deepEqual((await db.factoryPayment.findMany({ select: { salesUserId: true } })).map((x) => x.salesUserId), [U.murat.id]);
}));
