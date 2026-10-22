// Geçmiş veri bağlama (karar 300, 4.3.15) — canlıdaki TEK SATIŞÇILI düzenin provası, veritabanıyla:
//   - updatedAt korunur (sipariş, sandık) — müşterinin Teklifler sırası değişmez (K-2);
//   - işlem 5 sn'yi aşsa da tamamlanır; işlem sınırı yalnızca bu işlemde (K-1);
//   - süre / hata / PostgreSQL zaman aşımı → kısmi değişiklik yok;
//   - eşzamanlı ve ikinci çalıştırma engellenir;
//   - toplamlar, ticari kayıtlar, çizimci ilişkileri, fiyat tablosu, profil siparişleri değişmez;
//   - bağlamadan sonra yetki ayrımı: satışçı / çizimci kapsamı; yeni sipariş otomatik tek satışçıya.
// Hiçbir dış servise gidilmez (offline). Bağlanacak geçmiş, bağlama işareti olmadan (canlıdaki gibi) kurulur.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { LINK_SETTING, routingLinked } from '../../server/orders/sales-routing.js';
import { orderScope } from '../../server/orders/scope.js';
import { LINK_PG, LINK_TX, applyLink, previewLink, totalsSnapshot, sameTotals } from '../../server/orders/sales-link.js';
import { pricingForUser } from '../../server/pricing/tables.js';

let db, factory, firm, glass, table;
const U = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayAgo = (n) => new Date(Date.now() - n * 86_400_000);
const LINK = { targetEmail: 'satis@tek.test', drawerEmail: 'cizim@tek.test' };

/** Canlıdaki gibi bağlanmamış geçmiş: işaret ve kural yok, sahipsiz siparişler / sandıklar / ödemeler, eski updatedAt değerleri */
async function legacy() {
  await resetDb(db, { singleTeam: false });
  factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Tek Satis Firma', prefix: 'TSF', email: 'office@tsf.test' } });
  glass = await db.glassProduct.create({ data: { nameTr: '8mm Temperli', colorTr: '', nameRo: 'Sticlă 8', colorRo: '', weightKgM2: 20 } });
  const mk = async (k, email, appRole, customerId, extra = {}) => { U[k] = await db.user.create({ data: { email, name: k, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } }); };
  await mk('admin', 'admin@tek.test', 'ADMIN', factory.id);
  await mk('drawer', 'cizim@tek.test', 'CIZIM', factory.id);
  await mk('oldDrawer', 'eski-cizim@tek.test', 'CIZIM', factory.id, { isActive: false });
  table = await db.priceTable.create({ data: { name: 'Satis Tablosu', kind: 'SALES', currency: 'EUR', isActive: true, isDefault: true, items: { create: [{ glassProductId: glass.id, unitPrice: 31 }] } } });
  await mk('sales', 'satis@tek.test', 'SATIS', factory.id, { priceTableId: table.id });
  await mk('cust', 'musteri@tsf.test', 'MUSTERI', firm.id, { canApprove: true });
  await db.integrationSetting.deleteMany({ where: { key: LINK_SETTING } });
  assert.equal(await routingLinked(db), false);

  const rows = [];
  for (let i = 1; i <= 9; i += 1) {
    const drawer = i % 3 === 0 ? U.drawer.id : i === 4 ? U.oldDrawer.id : null;
    const o = await db.order.create({
      data: {
        orderNo: `TSF${i}`, customerId: firm.id, customerOrderNo: String(i), createdById: U.cust.id, orderTypeCode: 'GLASS_ORDER', title: `eski ${i}`,
        status: i <= 6 ? 'YUKLENDI' : 'HAZIRLANIYOR', drawingTrack: i % 2 ? 'ONAYLANDI' : 'YOK', assignedDrawerId: drawer,
        estimatedShipDate: dayAgo(30 - i), actualShipDate: i <= 6 ? dayAgo(30 - i) : null,
      },
    });
    await db.offer.create({
      data: {
        orderId: o.id, createdById: U.sales.id, status: 'GONDERILDI', sentAt: dayAgo(40 - i), currency: 'EUR', amount: 62 * i, offerAmount: 80 * i, priceTableId: table.id,
        lines: { create: [{ sortOrder: 0, description: '8mm Temperli', enMm: 1000, boyMm: 1000, adet: 2 * i, unit: 'm2', kind: 'CAM', unitPrice: 31, offerPrice: 40, glassProductId: glass.id }] },
      },
    });
    rows.push(o);
  }
  // Profil siparişi: bağlamanın dışında kalmalı
  U.profile = await db.order.create({ data: { orderNo: 'TSFP1', customerId: firm.id, customerOrderNo: 'P1', createdById: U.cust.id, orderTypeCode: 'PROFILE_ORDER', title: 'profil' } });
  const crates = [];
  for (let i = 1; i <= 3; i += 1) {
    crates.push(await db.crate.create({ data: { shipDay: dayAgo(25), customerId: firm.id, crateNo: i, netAgirlik: 100 + i, brutAgirlik: 130 + i, orders: { create: [{ orderId: rows[i - 1].id }] } } }));
  }
  await db.factoryPayment.create({ data: { paidOn: dayAgo(10), amount: '1250.50', currency: 'EUR', createdById: U.admin.id } });
  await db.factoryPayment.create({ data: { paidOn: dayAgo(5), amount: '410.25', currency: 'RON', createdById: U.admin.id } });
  // Eski, birbirinden farklı updatedAt değerleri (düz SQL: Prisma'nın kendiliğinden yazmasını atlar)
  await db.$executeRaw`UPDATE "Order" SET "updatedAt" = TIMESTAMP '2026-09-01 08:00' + (substring("orderNo" from '[0-9]+')::int * INTERVAL '1 hour')`;
  await db.$executeRaw`UPDATE "Crate" SET "updatedAt" = TIMESTAMP '2026-09-05 10:00' + ("crateNo" * INTERVAL '1 minute')`;
  return rows;
}

/** Bağlamanın dokunmaması gereken her şey (updatedAt dahil) */
async function untouched() {
  const [orders, crates, payments, offers, lines, users] = await Promise.all([
    db.order.findMany({ orderBy: { id: 'asc' } }),
    db.crate.findMany({ orderBy: { id: 'asc' }, include: { orders: true } }),
    db.factoryPayment.findMany({ orderBy: { id: 'asc' } }),
    db.offer.findMany({ orderBy: { id: 'asc' } }),
    db.offerLine.findMany({ orderBy: { id: 'asc' } }),
    db.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, priceTableId: true, isActive: true, appRole: true } }),
  ]);
  const strip = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  return JSON.stringify({
    orders: orders.map((o) => strip(o, ['salesUserId', 'salesAssignedVia', 'assignedDrawerId'])),
    crates: crates.map((c) => strip(c, ['salesUserId'])),
    payments: payments.map((p) => strip(p, ['salesUserId'])),
    offers, lines, users,
  });
}
/** Müşterinin Teklifler sayfasının sorgusuyla aynı sıra (app/(panel)/teklifler → CustomerOffers) */
const customerOffersOrder = () => db.order.findMany({
  where: { ...orderScope({ appRole: 'MUSTERI', customerId: firm.id }), offers: { some: { status: 'GONDERILDI' } } },
  orderBy: { updatedAt: 'desc' }, select: { id: true },
}).then((r) => r.map((x) => x.id));
const owners = async () => ({
  orders: await db.order.count({ where: { orderTypeCode: 'GLASS_ORDER', salesUserId: null } }),
  crates: await db.crate.count({ where: { salesUserId: null } }),
  payments: await db.factoryPayment.count({ where: { salesUserId: null } }),
  marker: await routingLinked(db),
  rules: await db.glassRoutingRule.count(),
  audit: await db.auditLog.count({ where: { action: 'SALES_LINK_APPLIED' } }),
});
const NOTHING_LINKED = { orders: 9, crates: 3, payments: 2, marker: false, rules: 0, audit: 0 };

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
});
after(closeDb);

dbTest('tek satışçı bağlaması: updatedAt ve Teklifler sırası korunur; toplamlar, ticari kayıtlar, çizimci ilişkileri, fiyat tablosu, profil siparişi değişmez; süre raporlanır; ikinci çalıştırma reddedilir', offline(async () => {
  const rows = await legacy();
  const beforeData = await untouched();
  const beforeOrder = await customerOffersOrder();
  const beforeTotals = await totalsSnapshot(db);
  assert.ok(beforeTotals.perCur.EUR.cost > 0 && beforeTotals.perCur.EUR.paid > 0, 'sınanan toplamlar sıfır değil');
  const updatedAt = new Map((await db.order.findMany({ select: { id: true, updatedAt: true } })).map((o) => [o.id, o.updatedAt.toISOString()]));
  const crateUpdatedAt = new Map((await db.crate.findMany({ select: { id: true, updatedAt: true } })).map((c) => [c.id, c.updatedAt.toISOString()]));
  const outbox = await db.notificationOutbox.count();
  const events = await db.orderEvent.count();

  const pre = await previewLink(db, LINK);
  assert.ok(pre.ok, JSON.stringify(pre.problems));
  assert.deepEqual([pre.plan.orders, pre.plan.crates, pre.plan.payments, pre.plan.setDefaultDrawer], [9, 3, 2, true]);
  assert.equal(await routingLinked(db), false, 'önizleme yazmaz');

  const r = await applyLink(db, { ...LINK, operator: 'test' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.counts.orders, r.counts.crates, r.counts.payments], [9, 3, 2]);
  // Süre ölçülür ve raporlanır
  assert.ok(Number.isFinite(r.timing.previewMs) && Number.isFinite(r.timing.applyMs) && r.timing.totalMs >= r.timing.applyMs);
  assert.equal(r.timing.limitMs, LINK_TX.timeout);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SALES_LINK_APPLIED' } });
  assert.ok(Number.isFinite(audit.details.timing.inTxMs), 'denetim kaydı süreyi taşır');

  // K-2: updatedAt korunur — sipariş ve sandık, tek tek
  for (const o of await db.order.findMany({ select: { id: true, updatedAt: true } })) assert.equal(o.updatedAt.toISOString(), updatedAt.get(o.id), 'sipariş updatedAt değişmedi');
  for (const c of await db.crate.findMany({ select: { id: true, updatedAt: true } })) assert.equal(c.updatedAt.toISOString(), crateUpdatedAt.get(c.id), 'sandık updatedAt değişmedi');
  assert.deepEqual(await customerOffersOrder(), beforeOrder, 'müşterinin Teklifler sırası aynı');
  // Ticari kayıtlar ve toplamlar
  assert.equal(await untouched(), beforeData, 'teklif, satır, sipariş, sandık, ödeme, kullanıcı alanları (sahiplik hariç) aynı');
  const afterTotals = await totalsSnapshot(db);
  assert.ok(sameTotals(beforeTotals, afterTotals), 'para birimi başına maliyet / ödeme / bakiye aynı');
  assert.deepEqual([await db.notificationOutbox.count(), await db.orderEvent.count()], [outbox, events], 'bildirim / olay yok');

  // Sahiplik: hepsi tek satışçıda; profil siparişi dışarıda
  assert.deepEqual(await owners(), { orders: 0, crates: 0, payments: 0, marker: true, rules: 1, audit: 1 });
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: U.profile.id } })).salesUserId, null, 'profil siparişine satışçı yazılmaz');
  // Çizimci ilişkileri: dolu olanlar aynen (pasif çizimci dahil), boş olanlara hedef çizimci
  const after = new Map((await db.order.findMany({ where: { orderTypeCode: 'GLASS_ORDER' } })).map((o) => [o.orderNo, o.assignedDrawerId]));
  for (const o of rows) {
    const i = Number(o.orderNo.slice(3));
    assert.equal(after.get(o.orderNo), i === 4 ? U.oldDrawer.id : U.drawer.id, `${o.orderNo} çizimcisi`);
  }
  // Fiyat tablosu ilişkisi korunur; satışçının fiyatı kendi tablosundan
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: U.sales.id } })).priceTableId, table.id);
  assert.equal((await pricingForUser(db, U.sales.id)).prices.get(glass.id), 31);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: U.sales.id } })).defaultDrawerId, U.drawer.id);

  // İkinci çalıştırma: önizleme ve uygulama reddeder, hiçbir şey değişmez
  const snap = await untouched();
  assert.deepEqual((await previewLink(db, LINK)).problems, ['ALREADY_LINKED']);
  const again = await applyLink(db, LINK);
  assert.deepEqual([again.ok, again.code], [false, 'ALREADY_LINKED']);
  assert.equal(await untouched(), snap);
  assert.equal(await db.auditLog.count({ where: { action: 'SALES_LINK_APPLIED' } }), 1);

  // Yetki ayrımı bağlamadan sonra: satışçı bütün eski cam siparişlerini görür, profil siparişini görmez
  const salesSees = await db.order.findMany({ where: orderScope(U.sales), select: { orderNo: true } });
  assert.deepEqual(salesSees.map((o) => o.orderNo).sort(), rows.map((o) => o.orderNo).sort());
  // Çizimci yalnızca kendisine atanmış ve çizim hattı açık siparişleri görür (pasif çizimcinin siparişi görünmez — karar V-2)
  const drawerSees = (await db.order.findMany({ where: orderScope(U.drawer), select: { orderNo: true } })).map((o) => o.orderNo).sort();
  assert.deepEqual(drawerSees, rows.filter((o) => Number(o.orderNo.slice(3)) % 2 === 1 && o.orderNo !== 'TSF4').map((o) => o.orderNo).sort());
  assert.equal(drawerSees.includes('TSF4'), false);
  // Kimliksiz satış / çizim aktörü hiçbir şey görmez (kapsam gevşemez)
  assert.equal(await db.order.count({ where: orderScope({ appRole: 'SATIS' }) }), 0);
  assert.equal(await db.order.count({ where: orderScope({ appRole: 'CIZIM' }) }), 0);

  // Yeni sipariş otomatik tek satışçıya ve onun çizimcisine
  const next = await suggestNextNo(db, firm.id);
  const n = await createGlassOrder(db, {
    actor: act(U.cust), firm, title: 'bağlama sonrası', requestedNo: next, suggestedNo: next,
    items: [{ glassProductId: glass.id, glassName: '8mm Temperli', glassNameRo: 'Sticlă 8', glassWeightKgM2: 20, camAdedi: 1 }],
    files: [{ storageKey: '2026/10/tsf-n.pdf', name: 'n.pdf', size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
  const created = await db.order.findUniqueOrThrow({ where: { id: n.id } });
  assert.deepEqual([created.salesUserId, created.assignedDrawerId, created.salesAssignedVia], [U.sales.id, U.drawer.id, 'AUTO']);
}));

dbTest('K-1: işlem 5 sn\'yi aşsa da tamamlanır (sınır yalnızca bu işlemde 120 sn); PostgreSQL sınırları işlem içinde, istemci sınırından kısa ve işlem dışında etkisiz', offline(async () => {
  await legacy();
  assert.ok(LINK_PG.statementTimeoutMs < LINK_TX.timeout && LINK_PG.lockTimeoutMs < LINK_TX.timeout);
  let inside = null;
  const r = await applyLink(db, {
    ...LINK,
    hooks: {
      afterWrites: async (tx) => {
        inside = (await tx.$queryRaw`SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l`)[0];
        await sleep(6000); // Prisma'nın varsayılan 5 sn sınırını aşar
      },
    },
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.timing.applyMs >= 6000, `süre ölçüldü: ${r.timing.applyMs} ms`);
  assert.deepEqual(inside, { s: `${LINK_PG.statementTimeoutMs / 1000}s`, l: `${LINK_PG.lockTimeoutMs / 1000}s` });
  // İşlem dışında (havuzdaki bağlantılar) varsayılan değişmedi
  const outside = (await db.$queryRaw`SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l`)[0];
  assert.deepEqual(outside, { s: '0', l: '0' });
  assert.deepEqual(await owners(), { orders: 0, crates: 0, payments: 0, marker: true, rules: 1, audit: 1 });
}));

dbTest('başarısızlıkta kısmi değişiklik yok: istemci süre aşımı, işlem içi hata ve PostgreSQL zaman aşımı → her şey olduğu gibi', offline(async () => {
  await legacy();
  const snap = await untouched();
  const check = async (label) => {
    assert.deepEqual(await owners(), NOTHING_LINKED, `${label}: hiçbir şey yazılmadı`);
    assert.equal(await untouched(), snap, `${label}: updatedAt dahil aynı`);
  };
  // 1) Prisma işlem süresi aşımı (yazımlardan SONRA)
  await assert.rejects(applyLink(db, { ...LINK, txOptions: { timeout: 1000, maxWait: 5000 }, hooks: { afterWrites: () => sleep(2500) } }));
  await sleep(200);
  await check('istemci süre aşımı');
  // 2) İşlem içinde beklenmeyen hata
  await assert.rejects(applyLink(db, { ...LINK, hooks: { afterWrites: () => { throw new Error('YAPAY_HATA'); } } }), /YAPAY_HATA/);
  await check('işlem içi hata');
  // 3) PostgreSQL deyim zaman aşımı
  await assert.rejects(applyLink(db, { ...LINK, pg: { statementTimeoutMs: 300, lockTimeoutMs: 300 }, hooks: { afterWrites: (tx) => tx.$queryRaw`SELECT pg_sleep(1)` } }), /statement timeout|canceling statement/i);
  await check('PostgreSQL zaman aşımı');
  // Ardından normal çalıştırma başarılı
  const r = await applyLink(db, LINK);
  assert.ok(r.ok, JSON.stringify(r));
}));

dbTest('eşzamanlı iki uygulama: biri bağlar, diğeri ALREADY_LINKED; bağlama bir kez yazılır', offline(async () => {
  await legacy();
  const results = await Promise.all([applyLink(db, LINK), applyLink(db, LINK)]);
  assert.deepEqual(results.map((x) => x.ok).sort(), [false, true]);
  assert.equal(results.find((x) => !x.ok).code, 'ALREADY_LINKED');
  assert.deepEqual(await owners(), { orders: 0, crates: 0, payments: 0, marker: true, rules: 1, audit: 1 });
}));
