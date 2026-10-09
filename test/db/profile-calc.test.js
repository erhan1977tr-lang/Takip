// Paket 5 (karar 175–177) — veritabanıyla: kesin paket içerikleri (seed), hesaplayıcı ayarları ve hesap, forma aktarılan
// adetlerin siparişe girmesi, stok yetersizliği (engellemez, tek kayıt), kritik eşik (ürün başına tek açık kayıt), rezerve,
// denetimcinin salt okunurluğu ve sayım ↔ depo çıkışı eşzamanlılığı (aynı ürün kilidi). Ağ isteği yok.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { runBaseSeed } = await import('../../prisma/seed/base.mjs');
const { PACK_SEED_ACTION } = await import('../../prisma/seed/steps/profile-calc.mjs');
const calc = await import('../../server/profile/calc-service.js');
const { applyCalc } = await import('../../server/profile/calculator.js');
const stock = await import('../../server/profile/stock.js');
const { saveProduct } = await import('../../server/profile/catalog.js');
const { createProfileOrder } = await import('../../server/profile/create.js');
const { profileOrderItems, readQuantities } = await import('../../server/profile/rules.js');
const { runProfileAction } = await import('../../server/profile/transitions.js');
const { suggestNextNo } = await import('../../server/orders/create.js');
const { earliestPickup } = await import('../../server/profile/dates.js');
const { resolveAlert } = await import('../../server/pricing/alerts.js');

let db, factory, firm;
const U = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const prod = (code) => db.profileProduct.findUniqueOrThrow({ where: { code } });
const levelOf = async (p) => (await stock.stockLevels(db, [p.id])).get(p.id) ?? 0;
const openCritical = (p) => db.adminAlert.findMany({ where: { type: 'STOCK_CRITICAL', resolvedAt: null, details: { path: ['productId'], equals: p.id } } });
const allCritical = (p) => db.adminAlert.findMany({ where: { type: 'STOCK_CRITICAL', details: { path: ['productId'], equals: p.id } }, orderBy: { createdAt: 'asc' } });
const counts = async () => [
  await db.stockMovement.count(), await db.profileSystem.count(), await db.profileCalcItem.count(), await db.profileGlassThickness.count(),
  await db.adminAlert.count(), JSON.stringify(await db.profileProduct.findMany({ select: { code: true, criticalStock: true, packContent: true }, orderBy: { code: 'asc' } })),
];
/** Ürünün stoğunu kesin bir değere getirir (yönetici sayımı) */
async function setStock(p, qty) {
  const r = await stock.addStockMovement(db, { productId: p.id, kind: 'SAYIM', qty }, act(U.admin));
  assert.ok(r.ok || r.code === 'NO_CHANGE', JSON.stringify(r));
}
/** Yöneticinin ürün formu: yalnızca paket içeriği değişir */
async function setPack(code, content, measure = 'M') {
  const p = await db.profileProduct.findUniqueOrThrow({ where: { code }, include: { category: true } });
  const value = { code: p.code, categoryCode: p.category.code, nameRo: p.nameRo, nameTr: p.nameTr, unitCode: p.unitCode, listPrice: p.listPrice == null ? null : Number(p.listPrice), isActive: p.isActive };
  assert.deepEqual(await saveProduct(db, p.id, value, act(U.admin), { packContent: content, packMeasure: content == null ? null : measure }), { ok: true, id: p.id });
}
/** Müşterinin profil siparişi (kod → adet) */
async function newOrder(lines) {
  const products = await db.profileProduct.findMany({ where: { code: { in: lines.map((l) => l[0]) } }, include: { category: true } });
  const byCode = new Map(products.map((p) => [p.code, p.id]));
  const items = profileOrderItems(lines.map(([code, qty]) => ({ productId: byCode.get(code), qty })), products);
  assert.ok(items.ok);
  const next = await suggestNextNo(db, firm.id, 'PROFILE_ORDER');
  return createProfileOrder(db, { actor: act(U.cust), firm, title: null, requestedNo: next, suggestedNo: next, items: items.items });
}
const run = (orderId, action, who, payload = {}) => runProfileAction(db, { orderId, action, actor: act(U[who]), payload });
/** Onaylanmış (depoya gitmemiş) profil siparişi */
async function approvedOrder(lines) {
  const o = await newOrder(lines);
  const offer = await db.offer.findFirstOrThrow({ where: { orderId: o.id }, include: { lines: true } });
  await run(o.id, 'send_profile_offer', 'admin', { lines: offer.lines.map((l) => ({ id: l.id, offerPrice: '5' })) });
  const sent = await db.offer.findFirstOrThrow({ where: { orderId: o.id, status: 'GONDERILDI' } });
  await run(o.id, 'approve_profile_offer', 'cust', { offerId: sent.id, pickupDate: earliestPickup({ now: new Date(Date.now() + 5 * 60_000) }), phone: '+40 723 000 000', plate: 'B 1 ABC' });
  return o;
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  // roller, sipariş tipleri, profil kataloğu (27 ürün) ve kesin paket içerikleri — korkuluk varsayılanları (karar 203) OLMADAN:
  // bu dosya yöneticinin kendi ayarını sıfırdan kurar (varsayılanlar: test/db/railing-calc.test.js)
  await resetDb(db, { calcDefaults: false });
  factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Hesap Cam', prefix: 'HES' } });
  const mk = (key, appRole, customerId, extra = {}) =>
    db.user.create({ data: { email: `${key}@hesap.test`, name: key, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } })
      .then((u) => { U[key] = u; });
  await mk('admin', 'ADMIN', factory.id);
  await mk('inspector', 'DENETIMCI', factory.id);
  await mk('sales', 'SATIS', factory.id);
  await mk('drawer', 'CIZIM', factory.id);
  await mk('cust', 'MUSTERI', firm.id, { canApprove: true });
});
after(closeDb);

dbTest('seed (karar 175): kesin paket içerikleri bir kez yazılır — GK15 137, AD45 24, MC12 27, MC16 43 m / kutu; sistem, kalınlık, katsayı, RM29 yok; yöneticinin değişikliği korunur', offline(async () => {
  const packs = await db.profileProduct.findMany({ where: { code: { in: ['GK15', 'AD45', 'MC12', 'MC16'] } }, orderBy: { code: 'asc' } });
  assert.deepEqual(packs.map((p) => [p.code, p.packContent?.toString(), p.packMeasure]), [['AD45', '24', 'M'], ['GK15', '137', 'M'], ['MC12', '27', 'M'], ['MC16', '43', 'M']]);
  assert.equal(await db.profileProduct.count({ where: { packContent: { not: null } } }), 4, 'başka hiçbir ürüne (bar boyu, torba içeriği) değer yazılmaz');
  assert.deepEqual([await db.profileSystem.count(), await db.profileGlassThickness.count(), await db.profileCalcItem.count()], [0, 0, 0]);
  assert.equal(await db.profileProduct.count({ where: { code: { startsWith: 'RM29' } } }), 0, 'RM29 kendiliğinden eklenmez');
  assert.equal(await db.auditLog.count({ where: { action: PACK_SEED_ACTION } }), 1);
  // Yönetici değiştirir ya da siler → seed yeniden çalışsa da dokunmaz
  await setPack('GK15', '150');
  await setPack('AD45', null);
  await runBaseSeed(db, { log: () => {}, skip: ['profile-calc-defaults'] });
  await runBaseSeed(db, { log: () => {}, skip: ['profile-calc-defaults'] });
  assert.deepEqual([(await prod('GK15')).packContent?.toString(), (await prod('AD45')).packContent], ['150', null]);
  assert.equal(await db.auditLog.count({ where: { action: PACK_SEED_ACTION } }), 1);
  const audit = await db.auditLog.findMany({ where: { action: 'PROFILE_PRODUCT_UPDATE', entityId: (await prod('GK15')).id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(audit.at(-1)?.details.fields, ['packContent']);
  await setPack('GK15', '137');
  await setPack('AD45', '24');
}));

dbTest('ayarlar (karar 175): kalınlık, sistem, satır — aynı kalemde çakışan koşul reddedilir; her değişiklik denetimde; denetimci / satış / müşteri hiçbir şey yazamaz', offline(async () => {
  const A = act(U.admin);
  assert.equal((await calc.addThickness(db, { mm: '12,76' }, A)).ok, true);
  assert.equal((await calc.addThickness(db, { mm: '16.76' }, A)).ok, true);
  assert.deepEqual(await calc.addThickness(db, { mm: '12.760' }, A), { ok: false, code: 'EXISTS' });
  assert.deepEqual(await calc.addThickness(db, { mm: '0' }, A), { ok: false, code: 'BAD_MM' });
  const sys = await calc.saveSystem(db, { code: 'mr23', nameRo: 'MR23 mână curentă', nameTr: '' }, A);
  assert.ok(sys.ok);
  assert.deepEqual(await calc.saveSystem(db, { code: 'MR23', nameRo: 'x' }, A), { ok: false, code: 'EXISTS' });
  assert.deepEqual(await calc.saveSystem(db, { code: 'MR 23!', nameRo: 'x' }, A), { ok: false, code: 'CODE' });
  const s = await db.profileSystem.findUniqueOrThrow({ where: { id: sys.id } });
  assert.deepEqual([s.code, s.nameTr, s.isActive], ['MR23', 'MR23 mână curentă', true]);
  const [t12, t16] = await db.profileGlassThickness.findMany({ orderBy: { mm: 'asc' } });
  const [mr7016, mrElx, mc12, mc16] = await Promise.all(['MR23-7016', 'MR23-ELX', 'MC12', 'MC16'].map(prod));
  const add = (v) => calc.addCalcItem(db, { systemId: sys.id, perMeter: '1', ...v }, A);
  assert.ok((await add({ slot: 'Profil', productId: mr7016.id, color: 'RAL7016' })).ok);
  assert.ok((await add({ slot: 'profil', productId: mrElx.id, color: 'ELOXAT' })).ok, 'büyük / küçük harf aynı kalem');
  assert.deepEqual(await add({ slot: 'PROFIL', productId: mrElx.id }), { ok: false, code: 'OVERLAP' }, 'renksiz satır iki renkle çakışır');
  assert.ok((await add({ slot: 'El tutamağı contası', productId: mc12.id, thicknessId: t12.id })).ok);
  assert.ok((await add({ slot: 'El tutamağı contası', productId: mc16.id, thicknessId: t16.id })).ok);
  assert.deepEqual(await add({ slot: 'El tutamağı contası', productId: mc16.id, thicknessId: t16.id, color: 'RAL7016' }), { ok: false, code: 'OVERLAP' });
  assert.deepEqual(await add({ slot: 'X', productId: 'yok' }), { ok: false, code: 'PRODUCT' });
  assert.deepEqual(await add({ slot: '', productId: mc12.id }), { ok: false, code: 'SLOT' });
  assert.deepEqual(await add({ slot: 'X', productId: mc12.id, color: 'RED' }), { ok: false, code: 'COLOR' });
  assert.deepEqual(await add({ slot: 'X', productId: mc12.id, perMeter: '-1' }), { ok: false, code: 'PER_METER' });
  const items = await db.profileCalcItem.findMany({ where: { systemId: sys.id }, orderBy: { sortOrder: 'asc' } });
  assert.deepEqual(items.map((i) => i.slot), ['Profil', 'Profil', 'El tutamağı contası', 'El tutamağı contası'], 'kalemin adı ilk yazımıyla');
  // Katsayı değişir, satır silinir — denetimde
  assert.deepEqual(await calc.updateCalcItem(db, { id: items[2].id, perMeter: '1,5' }, A), { ok: true });
  assert.equal((await db.profileCalcItem.findUniqueOrThrow({ where: { id: items[2].id } })).perMeter.toString(), '1.5');
  await calc.updateCalcItem(db, { id: items[2].id, perMeter: '1' }, A);
  const tmp = await add({ slot: 'Geçici', productId: mc12.id });
  assert.deepEqual(await calc.removeCalcItem(db, { id: tmp.id }, A), { ok: true });
  assert.equal(await db.profileCalcItem.count({ where: { id: tmp.id } }), 0);
  const ops = (await db.auditLog.findMany({ where: { action: 'PROFILE_CALC_ITEM', entityId: sys.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.details.op);
  assert.deepEqual(ops, ['create', 'create', 'create', 'create', 'update', 'update', 'create', 'delete']);
  assert.equal(await db.auditLog.count({ where: { action: 'PROFILE_CALC_SYSTEM', entityId: sys.id } }), 1);
  assert.equal(await db.auditLog.count({ where: { action: 'PROFILE_CALC_THICKNESS' } }), 2);
  // Yetkisiz roller: hiçbir şey değişmez
  const before = await counts();
  for (const who of ['inspector', 'sales', 'drawer', 'cust']) {
    const X = act(U[who]);
    assert.deepEqual(await calc.addThickness(db, { mm: '8' }, X), { ok: false, code: 'FORBIDDEN' }, who);
    assert.deepEqual(await calc.saveSystem(db, { id: sys.id, nameRo: 'değişti', isActive: false }, X), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await calc.addCalcItem(db, { systemId: sys.id, slot: 'Y', productId: mc12.id, perMeter: '1' }, X), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await calc.updateCalcItem(db, { id: items[0].id, perMeter: '9' }, X), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await calc.removeCalcItem(db, { id: items[0].id }, X), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await calc.setThicknessActive(db, { id: t12.id, active: false }, X), { ok: false, code: 'FORBIDDEN' });
  }
  assert.deepEqual(await counts(), before);
}));

dbTest('hesap (karar 175–176): bar boyu girilmeden hesap yok (eksik adıyla); girilince MR23 kalınlığa göre MC12 / MC16; RM29 yöneticinin açtığı ürün ve sistemle, MC olmadan; yetmeyen ürünün stoğu yalnızca o ürün için', offline(async () => {
  const sys = await db.profileSystem.findUniqueOrThrow({ where: { code: 'MR23' } });
  const [t12, t16] = await db.profileGlassThickness.findMany({ orderBy: { mm: 'asc' } });
  // Bar boyu (paket içeriği) girilmemiş: miktar üretilmez, hangi ürünün hangi değeri eksik söylenir
  let r = await calc.runCalc(db, { systemId: sys.id, color: 'RAL7016', thicknessId: t12.id, meters: '30' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [{ code: 'NO_PACK', product: 'MR23-7016' }]);
  assert.equal('lines' in r, false);
  const problems = (await calc.loadCalcAdmin(db)).systems.find((s) => s.code === 'MR23').problems;
  assert.deepEqual(problems.map((e) => [e.code, e.product]), [['NO_PACK', 'MR23-7016'], ['NO_PACK', 'MR23-ELX']]);
  await setPack('MR23-7016', '6');
  await setPack('MR23-ELX', '6');
  assert.deepEqual((await calc.loadCalcAdmin(db)).systems.find((s) => s.code === 'MR23').problems, []);
  // Stok: MR23-7016 0, MC12 10, MC16 −4 (eksi bakiye müşteriye 0 olarak gider)
  const [mr7016, mc12, mc16] = await Promise.all(['MR23-7016', 'MC12', 'MC16'].map(prod));
  await setStock(mc12, 10);
  await db.stockMovement.create({ data: { productId: mc16.id, qty: -4, kind: 'SAYIM', note: 'test: eksi bakiye' } });
  r = await calc.runCalc(db, { systemId: sys.id, color: 'RAL7016', thicknessId: t12.id, meters: '30' });
  assert.ok(r.ok);
  assert.deepEqual(r.lines.map((l) => [l.code, l.qty, l.stock]), [['MR23-7016', 5, { available: 0, missing: 5 }], ['MC12', 2, null]]);
  r = await calc.runCalc(db, { systemId: sys.id, color: 'ELOXAT', thicknessId: t16.id, meters: '30' });
  assert.deepEqual(r.lines.map((l) => [l.code, l.qty, l.stock]), [['MR23-ELX', 5, { available: 0, missing: 5 }], ['MC16', 1, { available: 0, missing: 1 }]]);
  assert.equal(await levelOf(mr7016), 0, 'hesap stoğa yazmaz');
  // Pasif sistem hesaplanmaz; müşterinin seçenek listesinde yok
  await calc.saveSystem(db, { id: sys.id, nameRo: sys.nameRo, nameTr: sys.nameTr, isActive: false }, act(U.admin));
  assert.deepEqual((await calc.runCalc(db, { systemId: sys.id, color: 'RAL7016', thicknessId: t12.id, meters: '30' })).errors, [{ code: 'SYSTEM_INACTIVE' }]);
  const off = await calc.loadCalcOptions(db);
  assert.equal(off.profiles.length + off.handrails.length, 0);
  await calc.saveSystem(db, { id: sys.id, nameRo: sys.nameRo, nameTr: sys.nameTr, isActive: true }, act(U.admin));
  // RM29: katalogda yok → yönetici ürünü (paket içeriğiyle) ve sistemi açar; MR23'ün MC kuralı uygulanmaz
  const cat = await db.profileCategory.findUniqueOrThrow({ where: { code: 'PROFILE_ALUMINIU' } });
  for (const code of ['RM29-7016', 'RM29-ELX']) {
    const c = await saveProduct(db, null, { code, categoryCode: cat.code, nameRo: code, nameTr: code, unitCode: 'BARA', listPrice: null, isActive: true }, act(U.admin), { packContent: '6', packMeasure: 'M' });
    assert.ok(c.ok);
  }
  const rm = await calc.saveSystem(db, { code: 'RM29', nameRo: 'RM29', nameTr: 'RM29' }, act(U.admin));
  for (const [code, color] of [['RM29-7016', 'RAL7016'], ['RM29-ELX', 'ELOXAT']]) {
    assert.ok((await calc.addCalcItem(db, { systemId: rm.id, slot: 'Profil', productId: (await prod(code)).id, color, perMeter: '1' }, act(U.admin))).ok);
  }
  // Türü seçilmemiş sistem müşteri hesaplayıcısında görünmez (karar 203); küpeşte olarak işaretlenince görünür
  assert.deepEqual(await calc.loadCalcOptions(db).then((o) => [o.profiles, o.handrails]), [[], []]);
  for (const s of [sys, await db.profileSystem.findUniqueOrThrow({ where: { id: rm.id } })]) {
    assert.ok((await calc.saveSystem(db, { id: s.id, nameRo: s.nameRo, nameTr: s.nameTr, isActive: true, kind: 'HANDRAIL' }, act(U.admin))).ok);
  }
  assert.deepEqual((await calc.saveSystem(db, { id: rm.id, nameRo: 'RM29', nameTr: 'RM29', kind: 'BOGUS' }, act(U.admin))), { ok: false, code: 'KIND' });
  const opts = await calc.loadCalcOptions(db);
  assert.deepEqual([opts.profiles.map((s) => s.code), opts.handrails.map((s) => s.code)], [[], ['MR23', 'RM29']]);
  for (const thicknessId of [t12.id, t16.id, '']) {
    const x = await calc.runCalc(db, { systemId: rm.id, color: 'RAL7016', thicknessId, meters: '30' });
    assert.deepEqual(x.lines.map((l) => [l.code, l.qty]), [['RM29-7016', 5]], 'MC12 / MC16 yok');
  }
}));

dbTest('form → sipariş (karar 175, 177): aktarılan ve müşterinin değiştirdiği adetler siparişe aynen girer; gönderim öncesi stok uyarısı hiçbir şey yazmaz; sipariş engellenmez, TEK yetersizlik kaydı', offline(async () => {
  const sys = await db.profileSystem.findUniqueOrThrow({ where: { code: 'MR23' } });
  const [, t16] = await db.profileGlassThickness.findMany({ orderBy: { mm: 'asc' } });
  const r = await calc.runCalc(db, { systemId: sys.id, color: 'RAL7016', thicknessId: t16.id, meters: '40' });
  assert.ok(r.ok);
  const spigot = await prod('SPIGOTI');
  // Formda elle seçilmiş adetli aksesuar (spigot) + hesaplananlar; müşteri MC16'yı 3'e çıkarır
  const { next } = applyCalc({ [spigot.id]: '12' }, r.lines);
  const mc16 = await prod('MC16');
  next[mc16.id] = '3';
  const read = readQuantities(Object.entries(next).map(([id, qty]) => ({ id, qty })));
  assert.ok(read.ok);
  // Gönderim öncesi uyarı: yalnızca formdaki eksik ürünler, kayıt yok
  const before = [await db.adminAlert.count(), await db.auditLog.count(), await db.stockMovement.count()];
  const shortList = await stock.customerShortages(db, read.lines);
  assert.ok(shortList.length >= 1 && shortList.every((l) => read.lines.some((x) => x.productId === l.productId)));
  assert.ok(shortList.every((l) => l.available >= 0 && l.missing === l.needed - l.available && l.missing > 0));
  assert.equal(shortList.find((l) => l.code === 'MC16')?.available, 0, 'eksi bakiye müşteriye 0');
  assert.deepEqual([await db.adminAlert.count(), await db.auditLog.count(), await db.stockMovement.count()], before);
  // Sipariş: hesaplanan + değiştirilen + elle eklenen adetler aynen
  const products = await db.profileProduct.findMany({ where: { id: { in: read.lines.map((l) => l.productId) } }, include: { category: true } });
  const items = profileOrderItems(read.lines, products);
  assert.ok(items.ok);
  const next2 = await suggestNextNo(db, firm.id, 'PROFILE_ORDER');
  const o = await createProfileOrder(db, { actor: act(U.cust), firm, title: null, requestedNo: next2, suggestedNo: next2, items: items.items });
  const saved = await db.profileOrderItem.findMany({ where: { orderId: o.id } });
  assert.deepEqual(Object.fromEntries(saved.map((i) => [i.code, i.qty])), { 'MR23-7016': 7, MC16: 3, SPIGOTI: 12 });
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status, 'YENI', 'sipariş engellenmedi');
  assert.equal(await db.adminAlert.count({ where: { orderId: o.id, type: 'STOCK_SHORTAGE' } }), 1, 'tek kayıt');
  assert.equal(await db.adminAlert.count({ where: { orderId: o.id } }), 1, 'mükerrer / başka tür kayıt yok');
}));

dbTest('kritik eşik (karar 177): eşik ürünü kritik yapınca TEK kayıt; kritikken süren düşüş yeni kayıt açmaz; "Gördüm" sonrası eşiğin üstüne çıkıp yeniden inince yeni kayıt; denetim', offline(async () => {
  const A = act(U.admin);
  const ad = await prod('AD45');
  await setStock(ad, 10);
  assert.deepEqual(await stock.setCriticalStock(db, { productId: ad.id, threshold: '5' }, A), { ok: true, alertId: null }, '10 > 5');
  assert.deepEqual(await stock.setCriticalStock(db, { productId: ad.id, threshold: '5' }, A), { ok: false, code: 'NO_CHANGE' });
  assert.deepEqual(await stock.setCriticalStock(db, { productId: ad.id, threshold: '-1' }, A), { ok: false, code: 'BAD_THRESHOLD' });
  await setStock(ad, 5); // eşiğe eşit → kritik
  let open = await openCritical(ad);
  assert.equal(open.length, 1);
  assert.deepEqual([open[0].details.level, open[0].details.threshold, open[0].details.cause, open[0].details.code, open[0].orderId], [5, 5, 'SAYIM', 'AD45', null]);
  await setStock(ad, 3);
  await stock.addStockMovement(db, { productId: ad.id, kind: 'GIRIS', qty: -1 }, A);
  assert.equal((await allCritical(ad)).length, 1, 'zaten kritikti: yeni kayıt yok');
  assert.equal(await resolveAlert(db, open[0].id, A), true);
  await setStock(ad, 1);
  assert.equal((await openCritical(ad)).length, 0, 'kapandıktan sonra süren düşüş yeni kayıt açmaz');
  await stock.addStockMovement(db, { productId: ad.id, kind: 'GIRIS', qty: 20 }, A); // 21 > 5
  // Depo çıkışı eşiğin altına indirir → kayıt (sipariş numarasıyla)
  const o = await approvedOrder([['AD45', 18]]);
  await run(o.id, 'send_to_warehouse', 'admin');
  open = await openCritical(ad);
  assert.equal(open.length, 1);
  assert.deepEqual([open[0].details.level, open[0].details.cause, open[0].details.orderNo], [3, 'CIKIS', o.orderNo]);
  // Eşik değişikliği ürünü yeniden "kritik" yapsa da açık kayıt varken ikincisi açılmaz
  await stock.setCriticalStock(db, { productId: ad.id, threshold: '' }, A);
  assert.deepEqual(await stock.setCriticalStock(db, { productId: ad.id, threshold: '4' }, A), { ok: true, alertId: null });
  assert.equal((await openCritical(ad)).length, 1);
  assert.equal(await resolveAlert(db, open[0].id, A), true);
  // Kayıt yokken eşik değişikliği kritik yaparsa kayıt açılır
  await stock.setCriticalStock(db, { productId: ad.id, threshold: '' }, A);
  const t = await stock.setCriticalStock(db, { productId: ad.id, threshold: '3' }, A);
  assert.ok(t.ok && t.alertId);
  assert.equal((await db.adminAlert.findUniqueOrThrow({ where: { id: t.alertId } })).details.cause, 'THRESHOLD');
  const audits = await db.auditLog.findMany({ where: { action: 'STOCK_THRESHOLD', entityId: ad.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(audits.map((a) => [a.details.before, a.details.after]), [[null, 5], [5, null], [null, 4], [4, null], [null, 3]]);
  assert.equal(await db.auditLog.count({ where: { action: 'STOCK_CRITICAL', entityId: ad.id } }), (await allCritical(ad)).length);
  await resolveAlert(db, t.alertId, A);
  await stock.setCriticalStock(db, { productId: ad.id, threshold: '' }, A);
}));

dbTest('kritik eşik: aynı ürüne eşzamanlı 8 hareket — eşiğin altına inen tam bir tanesi tek kayıt açar (ürün kilidi)', offline(async () => {
  const A = act(U.admin);
  const p = await prod('PANA-90-12');
  await setStock(p, 40);
  await stock.setCriticalStock(db, { productId: p.id, threshold: '20' }, A);
  // 8 × (−4): 40 → 8; 20'nin altına ilk inen hareket kaydı açar, öbürleri açmaz
  const res = await Promise.all(Array.from({ length: 8 }, () => stock.addStockMovement(db, { productId: p.id, kind: 'GIRIS', qty: -4 }, A)));
  assert.ok(res.every((r) => r.ok));
  assert.equal(await levelOf(p), 8);
  const alerts = await allCritical(p);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].details.level, 20, 'eşiğe inen hareketin anındaki stok');
  // Her hareketin denetimdeki "önce / sonra"sı sıralı ve kesintisiz (kayıp güncelleme yok)
  const moves = (await db.auditLog.findMany({ where: { action: 'STOCK_MOVEMENT', entityId: p.id, details: { path: ['kind'], equals: 'GIRIS' } } }))
    .map((a) => [a.details.before, a.details.after]).sort((x, y) => y[0] - x[0]);
  assert.deepEqual(moves.slice(-8), [[40, 36], [36, 32], [32, 28], [28, 24], [24, 20], [20, 16], [16, 12], [12, 8]]);
  await resolveAlert(db, alerts[0].id, A);
  await stock.setCriticalStock(db, { productId: p.id, threshold: '' }, A);
}));

dbTest('eşzamanlılık (karar 177): sayım ile depo çıkışı aynı ürün kilidini sırayla alır — çıkış sayımı bekler, sayım çıkışı bekler; sayımın "önce / sonra"sı gerçek stok', offline(async () => {
  const spig = await prod('SPIGOTI');
  const key = `stock:${spig.id}`;
  const waiting = async () => (await db.$queryRaw`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`)[0].n;
  /** Kilidi tutan işlem (yavaş bir sayım / çıkış gibi) — `gate` açılınca `work` çalışır ve işlem biter */
  function holder(work) {
    let release, locked;
    const gate = new Promise((r) => { release = r; });
    const isLocked = new Promise((r) => { locked = r; });
    const done = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      locked();
      await gate;
      await work(tx);
    }, { timeout: 30_000 });
    return { isLocked, release, done };
  }
  async function seeWaiting(isDone) {
    for (let i = 0; i < 200; i++) {
      if (isDone()) return 0;
      const n = await waiting();
      if (n) return n;
      await new Promise((r) => setTimeout(r, 50));
    }
    return 0;
  }

  // 1) Sayım kilidi tutarken depo çıkışı bekler; sayım biter, çıkış sayılan stoktan düşer
  await setStock(spig, 100);
  const o1 = await approvedOrder([['SPIGOTI', 30]]);
  const h1 = holder(async (tx) => {
    const cur = (await stock.stockLevels(tx, [spig.id])).get(spig.id) ?? 0;
    await tx.stockMovement.create({ data: { productId: spig.id, qty: 90 - cur, kind: 'SAYIM', note: 'test: kilit altında sayım' } });
  });
  await h1.isLocked;
  let exitDone = false;
  const exit = run(o1.id, 'send_to_warehouse', 'admin').then((r) => { exitDone = true; return r; });
  assert.equal(await seeWaiting(() => exitDone), 1, 'depo çıkışı ürün kilidinde bekliyor');
  assert.equal(await db.stockMovement.count({ where: { orderId: o1.id } }), 0, 'beklerken çıkış yazılmadı');
  h1.release();
  await h1.done;
  await exit;
  assert.equal(await levelOf(spig), 60, 'sayım (90) − çıkış (30)');
  assert.equal((await db.profileOrder.findUniqueOrThrow({ where: { orderId: o1.id } })).stockDeducted, true);

  // 2) Depo çıkışı kilidi tutarken (aynı işlemde) sayım bekler; sonra çıkışı GÖRÜR: önce = 30, sonra = sayılan
  const h2 = holder(async (tx) => {
    await tx.stockMovement.create({ data: { productId: spig.id, qty: -30, kind: 'CIKIS', note: 'test: kilit altında çıkış' } });
  });
  await h2.isLocked;
  let countDone = false;
  const count = stock.addStockMovement(db, { productId: spig.id, kind: 'SAYIM', qty: 25 }, act(U.admin)).then((r) => { countDone = true; return r; });
  assert.equal(await seeWaiting(() => countDone), 1, 'sayım ürün kilidinde bekliyor');
  h2.release();
  await h2.done;
  assert.deepEqual(await count, { ok: true, delta: -5 });
  assert.equal(await levelOf(spig), 25);
  const last = await db.auditLog.findFirst({ where: { action: 'STOCK_MOVEMENT', entityId: spig.id }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual([last.details.kind, last.details.before, last.details.after], ['SAYIM', 30, 25], 'sayımın önce / sonra kaydı gerçek stok');

  // 3) Gerçekten paralel: iki siparişin depo çıkışı + Excel sayımı + elle giriş — kilitlenme yok, toplam tutarlı
  await setStock(spig, 50);
  const [a, b] = [await approvedOrder([['SPIGOTI', 7], ['PANA-90-16', 2]]), await approvedOrder([['PANA-90-16', 3], ['SPIGOTI', 5]])];
  const pana = await prod('PANA-90-16');
  await setStock(pana, 10);
  const [ra, rb, rx, rg] = await Promise.all([
    run(a.id, 'send_to_warehouse', 'admin'),
    run(b.id, 'send_to_warehouse', 'admin'),
    stock.applyStockImport(db, [{ code: 'PANA-90-16', qty: 4 }], 'GIRIS', act(U.admin)),
    stock.addStockMovement(db, { productId: spig.id, kind: 'GIRIS', qty: 10 }, act(U.admin)),
  ]);
  assert.ok(ra && rb && rx.ok && rg.ok);
  assert.equal(await levelOf(spig), 50 - 7 - 5 + 10);
  assert.equal(await levelOf(pana), 10 - 2 - 3 + 4);
  // Çift düşüm yok: her sipariş bir kez; iptal bir kez geri ekler
  assert.equal(await db.stockMovement.count({ where: { orderId: a.id, kind: 'CIKIS' } }), 2);
  await run(a.id, 'cancel', 'admin', { note: 'test iptali' });
  assert.equal(await db.stockMovement.count({ where: { orderId: a.id, kind: 'IADE' } }), 2);
  assert.equal(await levelOf(spig), 50 - 5 + 10);
}));

dbTest('rezerve (karar 177): onaylı ama depoya gitmemiş siparişlerin adedi — fiyat bekleyen, depodaki, iptal ve silinmiş sayılmaz; stok hareketi değildir', offline(async () => {
  const p = await prod('PANA-115-12');
  await setStock(p, 50);
  const moves = await db.stockMovement.count();
  await approvedOrder([['PANA-115-12', 3]]); // onaylı
  const proforma = await approvedOrder([['PANA-115-12', 2]]);
  await run(proforma.id, 'mark_proforma', 'admin', { proformaNo: 'PF-REZ' });
  await newOrder([['PANA-115-12', 9]]); // fiyat bekliyor
  const sent = await approvedOrder([['PANA-115-12', 5]]);
  await run(sent.id, 'send_to_warehouse', 'admin'); // depoda (stoktan düştü)
  const cancelled = await approvedOrder([['PANA-115-12', 7]]);
  await run(cancelled.id, 'cancel', 'admin', { note: 'iptal' });
  const removed = await approvedOrder([['PANA-115-12', 11]]);
  await db.order.update({ where: { id: removed.id }, data: { removedAt: new Date(), status: 'IPTAL' } });
  assert.equal((await stock.reservedLevels(db, [p.id])).get(p.id), 3 + 2);
  assert.equal((await stock.reservedLevels(db)).get(p.id), 5);
  assert.equal(await levelOf(p), 50 - 5, 'yalnızca depoya giden düştü');
  assert.equal(await db.stockMovement.count(), moves + 1, 'rezerve hareket yazmaz (tek hareket: depo çıkışı)');
  assert.deepEqual(stock.stockRowStatus({ stock: await levelOf(p), reserved: 5, threshold: null }).shortForOrders, 0);
}));

dbTest('denetimci yalnızca görür (karar 177): stok, eşik, Excel ve hesaplayıcı servisleri reddeder; veritabanı değişmez', offline(async () => {
  const p = await prod('GK15');
  const before = await counts();
  for (const who of ['inspector', 'sales', 'drawer', 'cust']) {
    const X = act(U[who]);
    assert.deepEqual(await stock.addStockMovement(db, { productId: p.id, kind: 'SAYIM', qty: 999 }, X), { ok: false, code: 'FORBIDDEN' }, who);
    assert.deepEqual(await stock.applyStockImport(db, [{ code: 'GK15', qty: 999 }], 'SAYIM', X), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await stock.setCriticalStock(db, { productId: p.id, threshold: '1' }, X), { ok: false, code: 'FORBIDDEN' });
  }
  assert.deepEqual(await counts(), before);
}));
