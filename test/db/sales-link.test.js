// Geçmiş veri bağlama (karar 300, 4.3.15; 4.3.17 D-1 — karar 302) — canlıdaki geçmişin provası, veritabanıyla:
//   - sorumlusu boş cam siparişleri TARİHSEL satışçısına (çizime gönderen / çizimsiz devam ettiren / teklifi gönderen satış
//     olayı ya da teklifi hazırlayan satış kullanıcısı) dağıtılır; belirlenemeyen, çelişkili, sahibi pasif siparişler kimseye
//     verilmez (yönetici kararı: --assign ya da panelde atama);
//   - uygulama yalnızca önizlemenin onay koduyla; dağılım değiştiyse hiçbir şey yazılmaz;
//   - sandık yalnızca içindeki bütün siparişler aynı satışçıya gidiyorsa; fabrika ödemesi yalnızca açık kararla;
//   - otomatik yönlendirme kuralı yazılmaz (ilk durum: yönetici seçer);
//   - updatedAt korunur (K-2); işlem sınırı yalnızca bu işlemde (K-1); hata / süre aşımı → kısmi değişiklik yok;
//   - eşzamanlı ve ikinci çalıştırma engellenir; toplamlar ve ticari kayıtlar değişmez.
// Hiçbir dış servise gidilmez (offline). Bağlanacak geçmiş, bağlama işareti olmadan (canlıdaki gibi) kurulur.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';
import { createGlassOrder, suggestNextNo } from '../../server/orders/create.js';
import { LINK_SETTING, routingLinked, routingState } from '../../server/orders/sales-routing.js';
import { orderScope } from '../../server/orders/scope.js';
import { runOrderAction } from '../../server/orders/transitions.js';
import { LINK_PG, LINK_TX, applyLink, previewLink, totalsSnapshot, sameTotals } from '../../server/orders/sales-link.js';
import { pricingForUser } from '../../server/pricing/tables.js';

let db, factory, firm, glass, table;
const U = {};
const act = (u) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayAgo = (n) => new Date(Date.now() - n * 86_400_000);
/** Fabrika ödemeleri için açık karar (D-1: ödeme hesabı tahmin edilmez) + açık yönetici kararı (TSF5 → Hamza) */
const LINK = { paymentEmail: 'satis@tek.test', decisions: [{ orderNo: 'TSF5', email: 'hamza@tek.test' }] };
/** Önizlemenin onay koduyla uygulama (kullanıcının onayladığı dağılım) */
const approved = async (extra = {}) => ({ ...LINK, ...extra, approval: (await previewLink(db, { ...LINK, ...extra })).approval });

/**
 * Canlıdaki gibi bağlanmamış geçmiş: işaret ve kural yok, sahipsiz siparişler / sandıklar / ödemeler, eski updatedAt değerleri.
 * Tarihsel izler:  TSF1, 3, 4, 6 → Murat (teklif / gönderim) · TSF7, 8 → Hamza · TSF2 → çelişkili (Murat teklif, Hamza çizime
 * gönderdi) · TSF5 → pasif eski satışçı · TSF9 → iz yok (teklifi yönetici açtı). Sandık 1 → TSF1 (tek sahip), sandık 2 → TSF2
 * (belirsiz), sandık 3 → TSF3 + TSF7 (iki satışçı).
 */
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
  await mk('sales', 'satis@tek.test', 'SATIS', factory.id, { priceTableId: table.id, defaultDrawerId: U.drawer.id });
  await mk('hamza', 'hamza@tek.test', 'SATIS', factory.id, { defaultDrawerId: U.drawer.id });
  await mk('oldSales', 'eski-satis@tek.test', 'SATIS', factory.id, { isActive: false });
  await mk('cust', 'musteri@tsf.test', 'MUSTERI', firm.id, { canApprove: true });
  await db.integrationSetting.deleteMany({ where: { key: LINK_SETTING } });
  assert.equal(await routingLinked(db), false);

  const offerBy = { 5: U.oldSales.id, 7: U.hamza.id, 8: U.hamza.id, 9: U.admin.id };
  const rows = [];
  for (let i = 1; i <= 9; i += 1) {
    const drawer = i % 3 === 0 ? U.drawer.id : i === 4 ? U.oldDrawer.id : null;
    const o = await db.order.create({
      data: {
        orderNo: `TSF${i}`, customerId: firm.id, customerOrderNo: String(i), createdById: U.cust.id, orderTypeCode: 'GLASS_ORDER', title: `eski ${i}`,
        status: i <= 4 ? 'YUKLENDI' : 'HAZIRLANIYOR', drawingTrack: i % 2 ? 'ONAYLANDI' : 'YOK', assignedDrawerId: drawer,
        estimatedShipDate: dayAgo(30 - i), actualShipDate: i <= 4 ? dayAgo(30 - i) : null,
      },
    });
    await db.offer.create({
      data: {
        orderId: o.id, createdById: offerBy[i] ?? U.sales.id, status: 'GONDERILDI', sentAt: dayAgo(40 - i), currency: 'EUR', amount: 62 * i, offerAmount: 80 * i, priceTableId: table.id,
        lines: { create: [{ sortOrder: 0, description: '8mm Temperli', enMm: 1000, boyMm: 1000, adet: 2 * i, unit: 'm2', kind: 'CAM', unitPrice: 31, offerPrice: 40, glassProductId: glass.id }] },
      },
    });
    rows.push(o);
  }
  await db.orderEvent.create({ data: { orderId: rows[1].id, event: 'SENT_TO_DRAWING', userId: U.hamza.id, fromStatus: 'YENI', toStatus: 'HAZIRLANIYOR' } });
  await db.orderEvent.create({ data: { orderId: rows[5].id, event: 'OFFER_SUBMITTED', userId: U.sales.id } });
  // Profil siparişi: bağlamanın dışında kalmalı
  U.profile = await db.order.create({ data: { orderNo: 'TSFP1', customerId: firm.id, customerOrderNo: 'P1', createdById: U.cust.id, orderTypeCode: 'PROFILE_ORDER', title: 'profil' } });
  const crateOrders = [[rows[0].id], [rows[1].id], [rows[2].id, rows[6].id]];
  for (let i = 1; i <= 3; i += 1) {
    await db.crate.create({ data: { shipDay: dayAgo(25), customerId: firm.id, crateNo: i, netAgirlik: 100 + i, brutAgirlik: 130 + i, orders: { create: crateOrders[i - 1].map((orderId) => ({ orderId })) } } });
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
  const [orders, crates, payments, offers, lines, users, events] = await Promise.all([
    db.order.findMany({ orderBy: { id: 'asc' } }),
    db.crate.findMany({ orderBy: { id: 'asc' }, include: { orders: true } }),
    db.factoryPayment.findMany({ orderBy: { id: 'asc' } }),
    db.offer.findMany({ orderBy: { id: 'asc' } }),
    db.offerLine.findMany({ orderBy: { id: 'asc' } }),
    db.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, priceTableId: true, isActive: true, appRole: true, defaultDrawerId: true } }),
    db.orderEvent.findMany({ orderBy: { id: 'asc' } }),
  ]);
  const strip = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  return JSON.stringify({
    orders: orders.map((o) => strip(o, ['salesUserId', 'salesAssignedVia', 'assignedDrawerId'])),
    crates: crates.map((c) => strip(c, ['salesUserId'])),
    payments: payments.map((p) => strip(p, ['salesUserId'])),
    offers, lines, users, events,
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
// TSF2 (çelişkili) ve TSF9 (iz yok) sahipsiz kalır; sandık 2 (belirsiz) ve 3 (karışık) eski kayıt olarak kalır
const LINKED = { orders: 2, crates: 2, payments: 0, marker: true, rules: 0, audit: 1 };
const ownerOf = async () => new Map((await db.order.findMany({ where: { orderTypeCode: 'GLASS_ORDER' }, select: { orderNo: true, salesUserId: true } })).map((o) => [o.orderNo, o.salesUserId]));

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
});
after(closeDb);

dbTest('D-1 önizleme: tarihsel satışçıya dağılım; çelişkili / pasif / izsiz sipariş sahipsiz; sandık yalnızca tek sahipliyse; ödeme kararı zorunlu; hiçbir şey yazmaz', offline(async () => {
  await legacy();
  const snap = await untouched();
  const noPay = await previewLink(db, {});
  assert.equal(noPay.ok, false);
  assert.deepEqual(noPay.problems.map((p) => p.code), ['PAYMENTS_NEED_DECISION'], 'ödeme hesabı tahmin edilmez');
  const plain = await previewLink(db, { paymentEmail: 'satis@tek.test' });
  assert.ok(plain.ok, JSON.stringify(plain.problems));
  const by = Object.fromEntries(plain.summary.byOwner.map((o) => [o.email, o.orders]));
  assert.deepEqual(by, { 'satis@tek.test': 4, 'hamza@tek.test': 2 });
  assert.deepEqual(plain.summary.unresolved.map((u) => [u.orderNo, u.reason]).sort(), [['TSF2', 'CONFLICT'], ['TSF5', 'INACTIVE_OWNER'], ['TSF9', 'UNKNOWN']]);
  assert.deepEqual(plain.summary.crates.kept.map((c) => [c.crateNo, c.reason]).sort(), [[2, 'UNRESOLVED'], [3, 'MIXED']]);
  assert.equal(plain.summary.crates.linked, 1);
  assert.match(plain.approval, /^[0-9A-F]{12}$/);
  // Karar dağılımı değiştirir → onay kodu değişir; aynı girdi → aynı kod
  const withDecision = await previewLink(db, LINK);
  assert.ok(withDecision.ok);
  assert.notEqual(withDecision.approval, plain.approval);
  assert.equal((await previewLink(db, LINK)).approval, withDecision.approval);
  assert.deepEqual(withDecision.summary.decisions, [{ orderNo: 'TSF5', owner: 'hamza@tek.test', override: false }]);
  // Hatalı kararlar engeldir
  const bad = await previewLink(db, { paymentEmail: 'satis@tek.test', decisions: [{ orderNo: 'YOK1', email: 'hamza@tek.test' }, { orderNo: 'TSF9', email: 'eski-satis@tek.test' }] });
  assert.deepEqual(bad.problems.map((p) => p.code), ['DECISION_UNKNOWN_ORDER', 'DECISION_NOT_SALES']);
  assert.deepEqual(await owners(), NOTHING_LINKED, 'önizleme yazmaz');
  assert.equal(await untouched(), snap);
}));

dbTest('D-1 uygulama yalnızca onaylı dağılımla: kodsuz / yanlış kod / önizlemeden sonra değişen veri → hiçbir şey yazılmaz', offline(async () => {
  const rows = await legacy();
  const snap = await untouched();
  assert.equal((await applyLink(db, LINK)).code, 'APPROVAL_REQUIRED');
  assert.equal((await applyLink(db, { ...LINK, approval: '000000000000' })).code, 'APPROVAL_MISMATCH');
  const code = (await previewLink(db, LINK)).approval;
  // Önizlemeden sonra yeni bir tarihsel iz: TSF9'u Hamza çizime gönderdi → dağılım değişti
  await db.orderEvent.create({ data: { orderId: rows[8].id, event: 'SENT_TO_DRAWING', userId: U.hamza.id } });
  assert.equal((await applyLink(db, { ...LINK, approval: code })).code, 'APPROVAL_MISMATCH');
  assert.deepEqual(await owners(), NOTHING_LINKED);
  assert.notEqual(await untouched(), snap, 'yalnızca test olayı eklendi');
}));

dbTest('D-1 bağlama: tarihsel satışçılar, açık karar, updatedAt ve Teklifler sırası korunur; toplamlar ve ticari kayıtlar değişmez; kural YAZILMAZ (yönetici seçer); ikinci çalıştırma reddedilir', offline(async () => {
  const rows = await legacy();
  const beforeData = await untouched();
  const beforeOrder = await customerOffersOrder();
  const beforeTotals = await totalsSnapshot(db);
  assert.ok(beforeTotals.perCur.EUR.cost > 0 && beforeTotals.perCur.EUR.paid > 0, 'sınanan toplamlar sıfır değil');
  const updatedAt = new Map((await db.order.findMany({ select: { id: true, updatedAt: true } })).map((o) => [o.id, o.updatedAt.toISOString()]));
  const crateUpdatedAt = new Map((await db.crate.findMany({ select: { id: true, updatedAt: true } })).map((c) => [c.id, c.updatedAt.toISOString()]));
  const outbox = await db.notificationOutbox.count();

  const r = await applyLink(db, { ...(await approved()), operator: 'test' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.counts.orders, r.counts.unresolved, r.counts.crates, r.counts.cratesKept, r.counts.payments, r.counts.decisions], [7, 2, 1, 2, 2, 1]);
  assert.ok(Number.isFinite(r.timing.previewMs) && Number.isFinite(r.timing.applyMs) && r.timing.totalMs >= r.timing.applyMs);
  assert.equal(r.timing.limitMs, LINK_TX.timeout);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SALES_LINK_APPLIED' } });
  assert.ok(Number.isFinite(audit.details.timing.inTxMs), 'denetim kaydı süreyi taşır');
  assert.match(audit.details.approval, /^[0-9A-F]{12}$/);
  assert.deepEqual(audit.details.decisions.map((d) => d.ownerId), [U.hamza.id]);

  // Sahiplik: tarihsel satışçı; açık karar; çelişkili / izsiz sahipsiz
  const own = await ownerOf();
  assert.deepEqual(Object.fromEntries([...own].sort()), {
    TSF1: U.sales.id, TSF2: null, TSF3: U.sales.id, TSF4: U.sales.id, TSF5: U.hamza.id, TSF6: U.sales.id, TSF7: U.hamza.id, TSF8: U.hamza.id, TSF9: null,
  });
  // K-2: updatedAt korunur — sipariş ve sandık, tek tek
  for (const o of await db.order.findMany({ select: { id: true, updatedAt: true } })) assert.equal(o.updatedAt.toISOString(), updatedAt.get(o.id), 'sipariş updatedAt değişmedi');
  for (const c of await db.crate.findMany({ select: { id: true, updatedAt: true } })) assert.equal(c.updatedAt.toISOString(), crateUpdatedAt.get(c.id), 'sandık updatedAt değişmedi');
  assert.deepEqual(await customerOffersOrder(), beforeOrder, 'müşterinin Teklifler sırası aynı');
  assert.equal(await untouched(), beforeData, 'teklif, satır, olay, sipariş, sandık, ödeme, kullanıcı alanları (sahiplik hariç) aynı');
  assert.ok(sameTotals(beforeTotals, await totalsSnapshot(db)), 'para birimi başına maliyet / ödeme / bakiye aynı');
  assert.equal(await db.notificationOutbox.count(), outbox, 'bildirim yok');
  assert.deepEqual(await owners(), LINKED);
  assert.equal((await routingState(db)).current, null, 'otomatik kural yok: yeni siparişlerde yönetici seçer');
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: U.profile.id } })).salesUserId, null, 'profil siparişine satışçı yazılmaz');
  // Sandık: yalnızca tek sahipli sandık bağlandı
  assert.deepEqual((await db.crate.findMany({ orderBy: { crateNo: 'asc' }, select: { salesUserId: true } })).map((c) => c.salesUserId), [U.sales.id, null, null]);
  // Çizimci: dolu olanlar aynen (pasif çizimci dahil), boş olanlara sahibin varsayılan çizimcisi; sahipsizlerin çizimcisi boş kalır
  const drawers = new Map((await db.order.findMany({ where: { orderTypeCode: 'GLASS_ORDER' } })).map((o) => [o.orderNo, o.assignedDrawerId]));
  assert.equal(drawers.get('TSF4'), U.oldDrawer.id);
  for (const n of ['TSF1', 'TSF5', 'TSF7', 'TSF8']) assert.equal(drawers.get(n), U.drawer.id, n);
  assert.equal(drawers.get('TSF2'), null);
  // Fiyat tablosu ilişkisi korunur
  assert.equal((await pricingForUser(db, U.sales.id)).prices.get(glass.id), 31);

  // İkinci çalıştırma reddedilir
  const snap = await untouched();
  // (TSF5 artık sahipli: karar listesi boş verilir)
  assert.deepEqual((await previewLink(db, {})).problems.map((p) => p.code), ['ALREADY_LINKED']);
  const again = await applyLink(db, { ...LINK, approval: '000000000000' });
  assert.deepEqual([again.ok, again.code], [false, 'ALREADY_LINKED']);
  assert.equal(await untouched(), snap);

  // Yönetici kararı (panel): izsiz açık sipariş TSF9 → Murat; çizimci Murat'ın varsayılanı
  const v9 = (await db.order.findUniqueOrThrow({ where: { id: rows[8].id } })).version;
  await runOrderAction(db, { orderId: rows[8].id, action: 'assign_sales', actor: act(U.admin), payload: { salesUserId: U.sales.id, expectedVersion: v9 } });
  const o9 = await db.order.findUniqueOrThrow({ where: { id: rows[8].id } });
  assert.deepEqual([o9.salesUserId, o9.salesAssignedVia, o9.assignedDrawerId], [U.sales.id, 'MANUAL', U.drawer.id]);
  // Yetki ayrımı: her satışçı yalnızca kendi tarihsel siparişlerini yazma kapsamında görür
  const sees = async (u) => (await db.order.findMany({ where: orderScope(u), select: { orderNo: true } })).map((o) => o.orderNo).sort();
  assert.deepEqual(await sees(U.sales), ['TSF1', 'TSF3', 'TSF4', 'TSF6', 'TSF9']);
  assert.deepEqual(await sees(U.hamza), ['TSF5', 'TSF7', 'TSF8']);
  // Yeni sipariş: kural yok → atama bekler (yönetici seçer)
  const next = await suggestNextNo(db, firm.id);
  const n = await createGlassOrder(db, {
    actor: act(U.cust), firm, title: 'bağlama sonrası', requestedNo: next, suggestedNo: next,
    items: [{ glassProductId: glass.id, glassName: '8mm Temperli', glassNameRo: 'Sticlă 8', glassWeightKgM2: 20, camAdedi: 1 }],
    files: [{ storageKey: '2026/10/tsf-n.pdf', name: 'n.pdf', size: 10, mime: 'application/pdf', checksum: 'x', scanStatus: 'CLEAN' }],
  });
  const created = await db.order.findUniqueOrThrow({ where: { id: n.id } });
  assert.deepEqual([created.salesUserId, created.assignedDrawerId], [null, null], 'yeni sipariş yöneticinin seçimini bekler');
}));

dbTest('K-1: işlem 5 sn\'yi aşsa da tamamlanır (sınır yalnızca bu işlemde 120 sn); PostgreSQL sınırları işlem içinde, istemci sınırından kısa ve işlem dışında etkisiz', offline(async () => {
  await legacy();
  assert.ok(LINK_PG.statementTimeoutMs < LINK_TX.timeout && LINK_PG.lockTimeoutMs < LINK_TX.timeout);
  let inside = null;
  const r = await applyLink(db, {
    ...(await approved()),
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
  const outside = (await db.$queryRaw`SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l`)[0];
  assert.deepEqual(outside, { s: '0', l: '0' });
  assert.deepEqual(await owners(), LINKED);
}));

dbTest('başarısızlıkta kısmi değişiklik yok: istemci süre aşımı, işlem içi hata ve PostgreSQL zaman aşımı → her şey olduğu gibi', offline(async () => {
  await legacy();
  const snap = await untouched();
  const ok = await approved();
  const check = async (label) => {
    assert.deepEqual(await owners(), NOTHING_LINKED, `${label}: hiçbir şey yazılmadı`);
    assert.equal(await untouched(), snap, `${label}: updatedAt dahil aynı`);
  };
  await assert.rejects(applyLink(db, { ...ok, txOptions: { timeout: 1000, maxWait: 5000 }, hooks: { afterWrites: () => sleep(2500) } }));
  await sleep(200);
  await check('istemci süre aşımı');
  await assert.rejects(applyLink(db, { ...ok, hooks: { afterWrites: () => { throw new Error('YAPAY_HATA'); } } }), /YAPAY_HATA/);
  await check('işlem içi hata');
  await assert.rejects(applyLink(db, { ...ok, pg: { statementTimeoutMs: 300, lockTimeoutMs: 300 }, hooks: { afterWrites: (tx) => tx.$queryRaw`SELECT pg_sleep(1)` } }), /statement timeout|canceling statement/i);
  await check('PostgreSQL zaman aşımı');
  const r = await applyLink(db, ok);
  assert.ok(r.ok, JSON.stringify(r));
}));

dbTest('eşzamanlı iki uygulama: biri bağlar, diğeri ALREADY_LINKED; bağlama bir kez yazılır', offline(async () => {
  await legacy();
  const ok = await approved();
  const results = await Promise.all([applyLink(db, ok), applyLink(db, ok)]);
  assert.deepEqual(results.map((x) => x.ok).sort(), [false, true]);
  assert.equal(results.find((x) => !x.ok).code, 'ALREADY_LINKED');
  assert.deepEqual(await owners(), LINKED);
}));
