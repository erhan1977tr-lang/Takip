// Kırık / telafi camı, özel durum sandığı ve siparişi silme / geri yükleme (Aşama 9, karar 108–110; fiyat kuralı 112,
// işlemlerin tek cama ait olması 113) — veritabanıyla.
// FGO'ya GERÇEK istek yapılmaz: bu dosyada FGO'ya hiç gidilmez; ağ çağrısı (fetch) yapılırsa test düşer. BNR sahtedir.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { saveFgoSettings } = await import('../../server/integrations/fgo.js');
const { supplierData } = await import('../../server/accounting/supplier.js');
const c = await import('../../server/loading/confirmation.js');
const rp = await import('../../server/loading/replan.js');
const cr = await import('../../server/loading/crates.js');
const b = await import('../../server/glass/batch.js');
const inv = await import('../../server/glass/invoice-batch.js');
const comp = await import('../../server/orders/compensation.js');
const rm = await import('../../server/orders/removal.js');
const { runOrderAction } = await import('../../server/orders/transitions.js');
const { orderScope } = await import('../../server/orders/scope.js');
const n = await import('../../server/notifications/inapp.js');

const SECRET = 't'.repeat(40);
const U = {};
let db, A, B, S, S2, NL, D1, F, R, R2, BF, L, lineG1, lineOp, lineG2;
let net = 0;
const realFetch = globalThis.fetch;
const act = (u) => ({ id: u.id, role: u.appRole, ip: '127.0.0.1', customerId: u.customerId });
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (key) => new Date(`${key}T12:00:00Z`);
const date = (key) => new Date(`${key}T00:00:00Z`);
const dmy = (key) => key.split('-').reverse().join('.');
const [OLD, X, Y, P, N1, F1, F2] = [-8, -6, -4, -2, 9, 20, 27].map(dayOf);
const bnr = async () => ({ ok: true, rate: '5.0000', date: dayOf(0), url: 'https://curs.bnr.ro/nbrfxrates.xml' });
let k = 0;
const key = () => `istek-${++k}-${'x'.repeat(16)}`;

const glassLine = (adet, extra = {}) => ({ description: 'Temper Lamine 44.2', descriptionRo: 'Sticlă laminată 44.2', enMm: 1000, boyMm: 2000, adet, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '66.96', listPrice: '30', weightKgM2: '20.8', ...extra });
const cncLine = (adet) => ({ description: 'CNC', adet, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '8' });
const holeLine = (adet) => ({ description: 'Delik', adet, unit: 'adet', kind: 'DELIK', unitPrice: '2', offerPrice: '3' });
const crateFee = () => ({ description: 'Sandık parası', descriptionRo: 'Ambalaj (ladă)', adet: 1, unit: 'adet', kind: 'CAM', unitPrice: '25', offerPrice: '30' });
const FULL = { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } }, items: true };
async function order(firm, no, day, lines, { offer = 'GONDERILDI', currency = 'EUR', ...extra } = {}) {
  return db.order.create({
    data: {
      orderNo: `${firm.prefix}${no}`, customerOrderNo: no, title: `Proje ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: U.admin.id, status: 'URETIMDE', estimatedShipDate: at(day), ...extra,
      ...(offer ? { offers: { create: { status: offer, currency, amount: '0', offerAmount: '0', createdById: U.admin.id, ...(offer === 'GONDERILDI' ? { sentAt: new Date() } : {}), lines: { create: lines.map((l, i) => ({ sortOrder: i, ...l })) } } } } : {}),
    },
    include: FULL,
  });
}
const load = (id) => db.order.findUniqueOrThrow({ where: { id }, include: FULL });
const lineRow = (l) => [l.kind, l.adet, l.unitPrice.toString(), l.offerPrice == null ? null : l.offerPrice.toString(), l.free, !!l.compensationId];
/** Telafi isteği (varsayılan: onaylı, yeni anahtarla) */
const create = (p) => comp.createCompensation(db, { requestKey: key(), confirm: true, mode: 'NORMAL', ...p });
const newOn = (day) => ({ type: 'NEW', day });
const into = (o) => ({ type: 'EXISTING', orderId: o.id });
const compOf = (id) => db.compensation.findUniqueOrThrow({ where: { id } });
const alerts = (type) => db.adminAlert.findMany({ where: { type }, orderBy: { createdAt: 'asc' } });
const events = async (orderId) => (await db.orderEvent.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((e) => e.event);
/** Teklif formunun gönderdiği satırlar (bedelsiz satırın fiyatı formdan 0 gelir) */
const formLines = (lines, withOffer) => lines.map((l) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  unitPrice: l.free ? '0.00' : Number(l.unitPrice).toFixed(2),
  ...(withOffer ? { offerPrice: l.free ? '0.00' : l.offerPrice == null ? null : Number(l.offerPrice).toFixed(2) } : {}),
}));
const visibleTo = (u, id) => db.order.count({ where: { id, ...orderScope({ appRole: u.appRole, customerId: u.customerId }) } });

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  // Bu dosyada hiçbir ağ çağrısı olmamalı (FGO gerçek bir sistemdir)
  globalThis.fetch = async () => { net += 1; throw new Error('test: ağ çağrısı yapılmamalı'); };
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  const firm = (name, prefix) => db.customer.create({ data: { name, prefix, email: `${prefix.toLowerCase()}@telafi.test`, taxId: '556677', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. 2', fxPolicy: 'BNR' } });
  A = await firm('ABC Glass SRL', 'ABC');
  B = await firm('Other SRL', 'OTH');
  const user = (keyName, appRole, customerId, extra = {}) => db.user.create({ data: { email: `${keyName}@telafi.test`, name: keyName, type: appRole === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', appRole, customerId, ...extra } }).then((u) => { U[keyName] = u; });
  await user('admin', 'ADMIN', factory.id);
  await user('admin2', 'ADMIN', factory.id);
  await user('sales', 'SATIS', factory.id);
  await user('drawer', 'CIZIM', factory.id);
  await user('inspector', 'DENETIMCI', factory.id);
  await user('custA', 'MUSTERI', A.id, { canApprove: true });
  await user('custB', 'MUSTERI', B.id, { canApprove: true });
  await saveFgoSettings(db, { enabled: true, dailyLimit: 0, env: 'test', cui: '123456', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 }, { key: 'K', secret: SECRET }, act(U.admin));

  // Kaynak: ABC124 — 9 işlemsiz cam, AYNI camdan işlemli TEK cam (1 CNC, 2 delik — işlem tek bir cama aittir, karar 113),
  // 4 küçük cam, sandık parası. Yükleme günü geçmişte (X).
  S = await order(A, 124, X, [glassLine(9), glassLine(1), cncLine(1), holeLine(2), glassLine(4, { description: 'Temper 8mm', descriptionRo: 'Securizat 8mm', enMm: 500, boyMm: 500, unitPrice: '20', offerPrice: '40', listPrice: '20' }), crateFee()]);
  [lineG1, lineOp, , , lineG2] = S.offers[0].lines;
  // Eski kayıt: işlemler adedi 10 olan cam satırına bağlı (hangi camda olduğu belli değil) — onaysız eski bir günde
  L = await order(A, 125, OLD, [glassLine(10), cncLine(10), holeLine(20)]);
  S2 = await order(A, 200, X, [glassLine(6)]);
  R = await order(A, 400, X, [glassLine(2)]);
  NL = await order(A, 300, Y, [glassLine(10)]);
  // Müşterinin ileri tarihli siparişleri: teklifi satışta (taslak) ve teklifi müşteride
  D1 = await order(A, 131, F1, [glassLine(5)], { offer: 'HAZIRLANIYOR', status: 'HAZIRLANIYOR' });
  F = await order(A, 138, F2, [glassLine(5)]);
  R2 = await order(A, 401, F1, [glassLine(1)]);
  // Başka müşteri: N1 gününde siparişi ve sandığı var (özel durum sandığı için); ileri tarihli başka siparişi yok
  BF = await order(B, 7, N1, [glassLine(1)]);
});
after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

dbTest('yüklenip teslim edilmiş siparişten telafi (satış, bedelsiz, yeni sipariş): ABC124-T; kaynak ve onaylı yükleme değişmez; maliyet durur', async () => {
  // Kaynak sipariş X gününde EKSİKSİZ yüklendi (10 LOADED): telafi yüklenmeme kaydına bağlı değildir
  assert.equal((await c.confirmLoading(db, { day: X, key: (await c.previewLoading(db, X)).key, actor: act(U.admin) })).ok, true);
  const confBefore = JSON.stringify(await db.loadingConfirmationItem.findMany({ where: { orderId: S.id }, orderBy: { id: 'asc' } }));
  const before = JSON.stringify((await load(S.id)).offers);
  const version = (await load(S.id)).version;

  // Yetki sunucuda: müşteri, çizim, denetimci açamaz — hiçbir kayıt oluşmaz
  for (const u of [U.custA, U.drawer, U.inspector]) {
    assert.deepEqual(await create({ orderId: S.id, lineId: lineG1.id, quantity: 3, mode: 'FREE', dest: newOn(N1), actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, u.appRole);
  }
  // Geçersiz istekler
  const bad = async (p, code) => assert.deepEqual(await create({ orderId: S.id, lineId: lineG1.id, quantity: 3, mode: 'FREE', dest: newOn(N1), actor: act(U.sales), ...p }), { ok: false, code }, code);
  await bad({ quantity: 0 }, 'BAD_QUANTITY');
  await bad({ quantity: 10 }, 'BAD_QUANTITY'); // işlemsiz satırda 9 cam var
  await bad({ lineId: lineOp.id, quantity: 2 }, 'BAD_QUANTITY'); // işlemli satır TEK camdır
  await bad({ quantity: '2.5' }, 'BAD_QUANTITY');
  await bad({ lineId: S.offers[0].lines[2].id }, 'BAD_LINE'); // CNC satırı
  await bad({ lineId: S.offers[0].lines[5].id }, 'BAD_LINE'); // sandık parası
  await bad({ dest: newOn(dayOf(0)) }, 'NOT_FUTURE');
  await bad({ dest: newOn('2026-13-45') }, 'BAD_DAY');
  await bad({ dest: { type: 'BASKA' } }, 'BAD_DEST');
  await bad({ confirm: false }, 'CONFIRM_REQUIRED');
  await bad({ requestKey: 'kısa' }, 'BAD_REQUEST');
  // Satış telafi için yeni bir müşteri fiyatı belirleyemez (karar 112); yöneticinin girdiği fiyat pozitif olmalı
  await bad({ mode: 'CUSTOM', price: '25,00' }, 'PRICE_FORBIDDEN');
  await bad({ mode: 'CUSTOM', price: '0', actor: act(U.admin) }, 'BAD_PRICE');
  await bad({ mode: 'BASKA' }, 'BAD_MODE');
  await bad({ dest: into(BF) }, 'DEST_OTHER_CUSTOMER'); // başka müşterinin siparişi hedef olamaz
  assert.equal(await db.compensation.count(), 0);
  assert.equal(await db.order.count({ where: { compOfId: { not: null } } }), 0);

  // --- Satış: işlemli TEK cam, bedelsiz, yeni telafi siparişi (müşterinin ileri tarihli siparişleri VAR; yine de yeni sipariş seçilebilir)
  const r = await create({ orderId: S.id, lineId: lineOp.id, quantity: 1, mode: 'FREE', dest: newOn(N1), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.destOrderNo, r.created, r.duplicate], [true, 'APPLIED', 'ABC124-T', true, false]);
  const T = await load(r.destOrderId);
  assert.deepEqual(
    [T.orderNo, T.customerOrderNo, T.compSeq, T.compOfId, T.customerId, T.orderTypeCode, T.status, T.drawingTrack, T.estimatedShipDate.toISOString().slice(0, 10), T.title, T.offers.length],
    ['ABC124-T', 124, 1, S.id, A.id, 'GLASS_ORDER', 'HAZIRLANIYOR', 'YOK', N1, S.title, 1],
  );
  assert.ok(T.slaDeadline instanceof Date, 'teklif yöneticinin fiyat onayında: SLA işler');
  const offer = T.offers[0];
  assert.deepEqual([offer.status, offer.currency, offer.amount.toString(), offer.offerAmount.toString()], ['YONETIMDE', 'EUR', '0', '0']);
  // Bedelsiz: müşteri fiyatı 0, FABRİKA MALİYETİ durur (30 / 5 / 2); o cama ait işlemler AYNEN kopyalanır (1 CNC, 2 delik) — oran / yuvarlama yok
  assert.deepEqual(offer.lines.map(lineRow), [['CAM', 1, '30', '0', true, true], ['CNC', 1, '5', '0', true, true], ['DELIK', 2, '2', '0', true, true]]);
  assert.deepEqual(offer.lines.slice(1).map((l) => [l.description, l.unit]), [['CNC', 'adet'], ['Delik', 'adet']]);
  const g1 = offer.lines[0];
  assert.deepEqual([g1.description, g1.descriptionRo, g1.enMm, g1.boyMm, g1.unit, g1.weightKgM2.toString(), g1.listPrice.toString()], ['Temper Lamine 44.2', 'Sticlă laminată 44.2', 1000, 2000, 'm2', '20.8', '30']);
  assert.deepEqual(T.items.map((i) => [i.glassName, i.camAdedi]), [['Temper Lamine 44.2', 1]]);

  // Karar kaydı: kaynak sipariş / satır, adet, fiyat kararı (konusu MÜŞTERİ fiyatı: önceki 66,96 → 0), hedef
  const row = await compOf(r.compensationId);
  assert.deepEqual(
    [row.status, row.sourceOrderId, row.sourceOfferId, row.sourceLineId, row.customerId, row.quantity, row.priceMode, row.priceTier, row.free, row.normalCost.toString(), row.normalPrice.toString(), row.unitCost.toString(), row.offerPrice.toString(), row.destType, row.destOrderId, row.loadingDay.toISOString().slice(0, 10), row.createdById, row.sourceItemId],
    ['APPLIED', S.id, S.offers[0].id, lineOp.id, A.id, 1, 'FREE', 'CUSTOMER', true, '30', '66.96', '30', '0', 'NEW', T.id, N1, U.sales.id, null],
  );
  // "Önemli kararlar": bedelsiz önemli karardır — kaynak sipariş, cam, adet, ÖNCEKİ MÜŞTERİ FİYATI (66,96) → 0, kim, ne zaman, hedef sipariş / gün
  const [alert] = await alerts('COMPENSATION_PRICE');
  assert.deepEqual(
    [alert.orderId, alert.createdById, alert.details.orderNo, alert.details.glass, alert.details.quantity, alert.details.tier, alert.details.mode, alert.details.normal, alert.details.price, alert.details.currency, alert.details.destOrderNo, alert.details.day],
    [S.id, U.sales.id, 'ABC124', '1 × Temper Lamine 44.2 1000×2000', 1, 'CUSTOMER', 'FREE', 66.96, 0, 'EUR', 'ABC124-T', N1],
  );
  assert.ok(alert.createdAt instanceof Date);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'COMPENSATION_CREATED', entityId: S.id } });
  assert.deepEqual(
    [audit.userId, audit.actorRole, audit.details.sourceOrderNo, audit.details.sourceLineId, audit.details.quantity, audit.details.normalPrice, audit.details.offerPrice, audit.details.unitCost, audit.details.free, audit.details.priceChanged, audit.details.destType, audit.details.destOrderNo, audit.details.loadingDay],
    [U.sales.id, 'SATIS', 'ABC124', lineOp.id, 1, 66.96, 0, 30, true, true, 'NEW', 'ABC124-T', N1],
  );
  assert.deepEqual(audit.details.operations, [{ kind: 'CNC', adet: 1 }, { kind: 'DELIK', adet: 2 }]);
  // Geçmiş: kaynakta ve hedefte; notta tutar yok
  const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: S.id, event: 'COMPENSATION' } });
  assert.equal(ev.note, `1 × Temper Lamine 44.2 1000×2000 → ABC124-T / ${dmy(N1)}`);
  assert.deepEqual((await events(T.id)).sort(), ['COMPENSATION_ADDED', 'CREATED']);

  // Kaynak teklif satırı, kaynak sipariş ve ONAYLI YÜKLEME değişmedi (tamamı LOADED; NOT_LOADED kaydı yok)
  const after = await load(S.id);
  assert.equal(JSON.stringify(after.offers), before, 'kaynak teklif değişmez');
  assert.deepEqual([after.version, after.status], [version, 'URETIMDE']);
  assert.equal(JSON.stringify(await db.loadingConfirmationItem.findMany({ where: { orderId: S.id }, orderBy: { id: 'asc' } })), confBefore, 'onaylı yükleme değişmez');
  assert.equal(await db.loadingConfirmationItem.count({ where: { orderId: S.id, status: 'NOT_LOADED' } }), 0);

  // Bildirim: yeni sipariş yöneticinin fiyat onayında → olağan "teklif yöneticide" olayı, BİR kez; ayrı "yeni sipariş" olayı yok
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: T.id } })).map((o) => o.type), ['ORDER_OFFER_SUBMITTED']);
  await n.dispatchInApp(db);
  await n.dispatchInApp(db);
  const notes = await db.notification.findMany({ where: { orderId: T.id } });
  assert.deepEqual(notes.map((x) => [x.type, x.userId]).sort(), [['ORDER_OFFER_SUBMITTED', U.admin.id], ['ORDER_OFFER_SUBMITTED', U.admin2.id]].sort(), 'yalnızca yöneticiler, kişi başına tek bildirim');
});

dbTest('fiyat: satış yalnızca "aynı fiyat" (yöneticinin müşteri fiyatı aynen, uyarı yok) ya da bedelsiz seçer; yeni müşteri fiyatını yalnızca yönetici belirler; işlemler aynen kopyalanır; numara -T2, -T3 …', async () => {
  const priceAlerts = (await alerts('COMPENSATION_PRICE')).length;
  // Satış, aynı fiyat — İŞLEMSİZ cam satırından 2 cam: müşteri fiyatı kaynaktan AYNEN (66,96; sunucuda kopyalanır, satış görmez),
  // maliyet 30. Aynı camın işlemli kardeşi (lineOp) var ama işlemsiz cam İŞLEM MİRAS ALMAZ.
  let r = await create({ orderId: S.id, lineId: lineG1.id, quantity: 2, dest: newOn(N1), actor: act(U.sales) });
  assert.equal(r.destOrderNo, 'ABC124-T2');
  const T2 = await load(r.destOrderId);
  assert.deepEqual(T2.offers[0].lines.map(lineRow), [['CAM', 2, '30', '66.96', false, true]]);
  // 2 cam × 2 m² = 4 m²: satış 4×30 = 120; müşteri 4×66,96 = 267,84 — yönetici yeniden fiyat girmek zorunda değil
  assert.deepEqual([T2.offers[0].amount.toString(), T2.offers[0].offerAmount.toString()], ['120', '267.84']);
  assert.equal((await alerts('COMPENSATION_PRICE')).length, priceAlerts, 'aynı fiyat: "fiyat değişti" uyarısı yok');
  const row = await compOf(r.compensationId);
  assert.deepEqual([row.priceMode, row.priceTier, row.free, row.normalPrice.toString(), row.offerPrice.toString(), row.unitCost.toString()], ['NORMAL', 'CUSTOMER', false, '66.96', '66.96', '30']);
  // Olağan denetim kaydı ve geçmiş yine yazılır
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'COMPENSATION_CREATED', details: { path: ['compensationId'], equals: r.compensationId } } });
  assert.deepEqual([audit.details.priceMode, audit.details.priceChanged, audit.details.offerPrice, audit.details.operations], ['NORMAL', false, 66.96, []]);

  // Satış, aynı fiyat — İŞLEMLİ tek cam: işlemler AYNEN (1 CNC, 2 delik), kendi kayıtlı fiyatlarıyla
  r = await create({ orderId: S.id, lineId: lineOp.id, quantity: 1, dest: newOn(N1), actor: act(U.sales) });
  assert.equal(r.destOrderNo, 'ABC124-T3');
  const T3 = await load(r.destOrderId);
  assert.deepEqual(T3.offers[0].lines.map(lineRow), [['CAM', 1, '30', '66.96', false, true], ['CNC', 1, '5', '8', false, true], ['DELIK', 2, '2', '3', false, true]]);
  // 1 cam × 2 m²: satış 60 + 5 + 4 = 69; müşteri 133,92 + 8 + 6 = 147,92
  assert.deepEqual([T3.offers[0].amount.toString(), T3.offers[0].offerAmount.toString()], ['69', '147.92']);
  assert.equal((await alerts('COMPENSATION_PRICE')).length, priceAlerts);

  // Satış yeni bir müşteri fiyatı (ya da satış fiyatı) belirleyemez: istek reddedilir, hiçbir kayıt / sipariş oluşmaz
  const [comps, orders] = [await db.compensation.count(), await db.order.count()];
  assert.deepEqual(await create({ orderId: S.id, lineId: lineG1.id, quantity: 1, mode: 'CUSTOM', price: '25,00', dest: newOn(N1), actor: act(U.sales) }), { ok: false, code: 'PRICE_FORBIDDEN' });
  assert.deepEqual(await create({ orderId: S.id, lineId: lineG1.id, quantity: 1, mode: 'CUSTOM', price: '25,00', dest: into(F), actor: act(U.sales) }), { ok: false, code: 'PRICE_FORBIDDEN' });
  assert.deepEqual([await db.compensation.count(), await db.order.count(), (await alerts('COMPENSATION_PRICE')).length], [comps, orders, priceAlerts]);

  // Eski kayıt: işlemler adedi 10 olan satıra bağlı — hangi camda olduğu belli değil → telafi açılmaz (oran / tahmin yok)
  for (const u of [U.sales, U.admin]) {
    assert.deepEqual(await create({ orderId: L.id, lineId: L.offers[0].lines[0].id, quantity: 1, mode: 'FREE', dest: newOn(N1), actor: act(u) }), { ok: false, code: 'AMBIGUOUS_OPS' }, u.appRole);
  }
  assert.equal(await db.compensation.count(), comps);

  // Yönetici, müşteri fiyatı 50 (normal 40): fabrika maliyeti (20) değişmez
  r = await create({ orderId: S.id, lineId: lineG2.id, quantity: 1, mode: 'CUSTOM', price: 50, dest: newOn(N1), actor: act(U.admin) });
  assert.equal(r.destOrderNo, 'ABC124-T4');
  assert.deepEqual((await load(r.destOrderId)).offers[0].lines.map(lineRow), [['CAM', 1, '20', '50', false, true]]);
  const a = (await alerts('COMPENSATION_PRICE')).at(-1);
  assert.deepEqual([a.details.tier, a.details.mode, a.details.normal, a.details.price, a.createdById], ['CUSTOMER', 'CUSTOM', 40, 50, U.admin.id]);
  const c4 = await compOf(r.compensationId);
  assert.deepEqual([c4.priceTier, c4.priceMode, c4.unitCost.toString(), c4.offerPrice.toString(), c4.normalPrice.toString()], ['CUSTOMER', 'CUSTOM', '20', '50', '40']);
  // Yönetici bedelsiz ve yönetici normal
  r = await create({ orderId: S.id, lineId: lineG2.id, quantity: 4, mode: 'FREE', dest: newOn(N1), actor: act(U.admin) });
  assert.deepEqual([(await load(r.destOrderId)).orderNo, (await load(r.destOrderId)).offers[0].lines.map(lineRow)], ['ABC124-T5', [['CAM', 4, '20', '0', true, true]]]);
  const before = (await alerts('COMPENSATION_PRICE')).length;
  r = await create({ orderId: S.id, lineId: lineG2.id, quantity: 1, mode: 'NORMAL', dest: newOn(N1), actor: act(U.admin) });
  assert.deepEqual([(await load(r.destOrderId)).orderNo, (await load(r.destOrderId)).offers[0].lines.map(lineRow)], ['ABC124-T6', [['CAM', 1, '20', '40', false, true]]]);
  assert.equal((await alerts('COMPENSATION_PRICE')).length, before);

  // Olağan akış: yönetici T2'nin teklifini müşteriye gönderir → sipariş kendiliğinden üretime geçer; TELAFİ işareti satırda kalır
  const sent = await runOrderAction(db, { orderId: T2.id, action: 'approve_offer', actor: act(U.admin), payload: { lines: formLines(T2.offers[0].lines, true) } });
  assert.equal(sent.result.produced, true);
  const T2b = await load(T2.id);
  assert.deepEqual([T2b.status, T2b.offers[0].status, T2b.offers[0].lines.every((l) => l.compensationId)], ['URETIMDE', 'GONDERILDI', true]);
  // Telafinin telafisi: kaynak ABC124-T2, yeni sipariş numarası KÖK siparişten (ABC124-T7), kök ilişkisiyle
  r = await create({ orderId: T2.id, lineId: T2b.offers[0].lines[0].id, quantity: 1, mode: 'FREE', dest: newOn(N1), actor: act(U.sales) });
  const T7 = await load(r.destOrderId);
  assert.deepEqual([T7.orderNo, T7.compSeq, T7.compOfId, T7.customerOrderNo, (await compOf(r.compensationId)).sourceOrderId], ['ABC124-T7', 7, S.id, 124, T2.id]);
  // Olağan sipariş numarası sırası değişmedi: telafi siparişleri kökün numarasını paylaşır
  const { suggestNextNo } = await import('../../server/orders/create.js');
  assert.equal(await suggestNextNo(db, A.id), 402);
});

dbTest('aynı anda / çift tıklama: telafi numarası ve kaydı çoğalmaz', async () => {
  const line = S2.offers[0].lines[0];
  // Farklı dört istek aynı anda: dört ayrı sipariş, numaralar benzersiz ve sıralı
  const rs = await Promise.all([1, 2, 3, 4].map(() => create({ orderId: S2.id, lineId: line.id, quantity: 1, dest: newOn(N1), actor: act(U.sales) })));
  assert.deepEqual(rs.map((r) => r.ok), [true, true, true, true]);
  assert.deepEqual(rs.map((r) => r.destOrderNo).sort(), ['ABC200-T', 'ABC200-T2', 'ABC200-T3', 'ABC200-T4']);
  // Aynı formun üç kez gönderilmesi (çift tıklama): tek telafi, tek sipariş; sonrakiler ilk sonucu döndürür
  const same = key();
  const dup = await Promise.all([1, 2, 3].map(() => comp.createCompensation(db, { orderId: S2.id, lineId: line.id, quantity: 2, mode: 'FREE', dest: newOn(N1), requestKey: same, confirm: true, actor: act(U.sales) })));
  assert.deepEqual(dup.map((r) => r.ok), [true, true, true]);
  assert.deepEqual(dup.map((r) => r.duplicate).sort(), [false, true, true]);
  assert.equal(new Set(dup.map((r) => r.compensationId)).size, 1);
  assert.equal(new Set(dup.map((r) => r.destOrderNo)).size, 1);
  assert.equal(await db.compensation.count({ where: { requestKey: same } }), 1);
  assert.equal(await db.order.count({ where: { compOfId: S2.id } }), 5);
  assert.equal(await db.compensation.count({ where: { sourceOrderId: S2.id } }), 5);
  // Veritabanı da engeller: aynı kök + sıra ikinci kez yazılamaz
  await assert.rejects(db.order.create({ data: { orderNo: 'ABC200-X', customerOrderNo: 200, compSeq: 1, customerId: A.id, createdById: U.admin.id } }), /Unique constraint/);
  // Yinelenen istek bildirim de çoğaltmaz: her telafi siparişi için tek olay
  const outbox = await db.notificationOutbox.groupBy({ by: ['orderId'], where: { order: { compOfId: S2.id } }, _count: true });
  assert.deepEqual(outbox.map((o) => o._count), [1, 1, 1, 1, 1]);
});

dbTest('hedef: müşterinin ileri tarihli siparişi — taslak teklife eklenir; müşterideki teklifte yönetici yeni sürüm açar, satışın kararı yöneticinin onayını bekler', async () => {
  // Hedef seçenekleri: yalnızca aynı müşterinin ileri tarihli siparişleri (sipariş numarası + yükleme günü)
  const onHold = await order(A, 150, F1, [glassLine(1)], { onHold: true });
  const fresh = await order(A, 151, F1, [], { offer: null, status: 'YENI' });
  const ron = await order(A, 152, F1, [glassLine(1)], { currency: 'RON' });
  const billed = await order(A, 153, F1, [glassLine(1)]);
  await db.fgoDocument.create({ data: { orderId: billed.id, kind: 'PROFORMA', series: 'PRF', number: '9001', issuedAt: new Date() } });
  const today = await order(A, 154, dayOf(0), [glassLine(1)]);
  const list = await comp.compensationDestinations(db, { source: { id: S.id, customerId: A.id, currency: 'EUR' } });
  const of = (o) => list.find((x) => x.id === o.id);
  assert.deepEqual([of(D1).via, of(D1).day, of(D1).orderNo], ['DRAFT', F1, 'ABC131']);
  assert.deepEqual([of(F).via, of(F).day, of(F).reason], ['SENT', F2, null]);
  assert.deepEqual([of(onHold).reason, of(fresh).reason, of(ron).reason, of(billed).reason], ['ON_HOLD', 'NO_OFFER', 'CURRENCY', 'BILLING']);
  assert.equal(of(today), undefined, 'bugünün siparişi ileri tarihli değil');
  assert.ok(!list.some((x) => x.id === BF.id || x.id === S.id), 'başka müşterinin siparişi ve kaynağın kendisi listede yok');
  assert.ok(list.some((x) => x.orderNo === 'ABC124-T'), 'telafi siparişi de olağan bir sipariştir');
  // Başka müşterinin ileri tarihli siparişi yok: liste boş; yeni telafi siparişi yine açılır (OTH7-T)
  assert.deepEqual(await comp.compensationDestinations(db, { source: { id: BF.id, customerId: B.id, currency: 'EUR' } }), []);
  for (const [o, code] of [[onHold, 'DEST_ON_HOLD'], [fresh, 'DEST_NO_OFFER'], [ron, 'DEST_CURRENCY'], [billed, 'DEST_BILLING'], [today, 'DEST_NOT_FUTURE'], [S, 'DEST_SAME_ORDER']]) {
    assert.deepEqual(await create({ orderId: S.id, lineId: lineG1.id, quantity: 1, dest: into(o), actor: act(U.admin) }), { ok: false, code }, code);
  }

  // --- Taslak teklif (satışta): satış bedelsiz telafi ekler → satırlar taslağa eklenir, sürüm artar, müşteriye hiçbir şey gitmez
  let r = await create({ orderId: S.id, lineId: lineOp.id, quantity: 1, mode: 'FREE', dest: into(D1), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.destOrderNo, r.created], [true, 'APPLIED', 'ABC131', false]);
  let d = await load(D1.id);
  assert.deepEqual([d.offers.length, d.offers[0].status, d.version], [1, 'HAZIRLANIYOR', D1.version + 1]);
  assert.deepEqual(d.offers[0].lines.map(lineRow), [['CAM', 5, '30', '66.96', false, false], ['CAM', 1, '30', '0', true, true], ['CNC', 1, '5', '0', true, true], ['DELIK', 2, '2', '0', true, true]]);
  assert.equal(d.offers[0].amount.toString(), '300', 'taslağın satış tutarı yeniden hesaplanır (5 cam × 2 m² × 30; bedelsiz satırlar 0)');
  assert.equal(await db.notificationOutbox.count({ where: { orderId: D1.id } }), 0);
  assert.deepEqual([(await compOf(r.compensationId)).destType, (await compOf(r.compensationId)).loadingDay.toISOString().slice(0, 10)], ['EXISTING', F1]);
  assert.ok((await events(D1.id)).includes('COMPENSATION_ADDED'));
  // Olağan akış: satış taslağı kaydeder (form bedelsiz satırın fiyatını 0 gönderir) → TELAFİ işareti ve fabrika maliyeti korunur
  await runOrderAction(db, { orderId: D1.id, action: 'save_offer', actor: act(U.sales), payload: { lines: formLines(d.offers[0].lines, false) } });
  d = await load(D1.id);
  assert.deepEqual(d.offers[0].lines.map(lineRow), [['CAM', 5, '30', '66.96', false, false], ['CAM', 1, '30', '0', true, true], ['CNC', 1, '5', '0', true, true], ['DELIK', 2, '2', '0', true, true]]);

  // --- Müşterideki teklif + YÖNETİCİ: teklifin yeni sürümü (eski sürüm değişmez), müşteri "teklif güncellendi" görür
  const prev = JSON.stringify(F.offers[0]);
  r = await create({ orderId: S.id, lineId: lineG2.id, quantity: 2, dest: into(F), actor: act(U.admin) });
  assert.deepEqual([r.ok, r.status], [true, 'APPLIED']);
  let f = await load(F.id);
  assert.deepEqual([f.offers.length, f.offers[0].status, f.offers[1].status, f.version, f.status], [2, 'GONDERILDI', 'GONDERILDI', F.version + 1, 'URETIMDE']);
  assert.equal(JSON.stringify(f.offers[1]), prev, 'müşteriye gitmiş eski sürüm değişmez');
  assert.deepEqual(f.offers[0].lines.map(lineRow), [['CAM', 5, '30', '66.96', false, false], ['CAM', 2, '20', '40', false, true]]);
  // müşteri tutarı: 10 m² × 66,96 + 0,5 m² × 40 = 689,60
  assert.deepEqual([f.offers[0].offerAmount.toString(), (await db.price.findUniqueOrThrow({ where: { orderId: F.id } })).amount.toString()], ['689.6', '689.6']);
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: F.id } })).map((o) => o.type), ['ORDER_OFFER_UPDATED']);
  assert.ok((await events(F.id)).includes('OFFER_UPDATED'));
  // Yönetici teklifi sonradan günceller: TELAFİ işareti yeni sürüme taşınır
  await runOrderAction(db, { orderId: F.id, action: 'update_offer', actor: act(U.admin), payload: { lines: formLines(f.offers[0].lines, true) } });
  f = await load(F.id);
  assert.deepEqual([f.offers.length, f.offers[0].lines.map((l) => !!l.compensationId)], [3, [false, true]]);

  // --- Müşterideki teklif + SATIŞ: müşteriye giden teklifi satış değiştiremez → karar yöneticinin onayını bekler
  r = await create({ orderId: S.id, lineId: lineG1.id, quantity: 1, mode: 'FREE', dest: into(F), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.destOrderNo], [true, 'PENDING', 'ABC138']);
  assert.equal((await load(F.id)).offers.length, 3, 'onay beklerken teklif değişmez');
  assert.equal(await db.offerLine.count({ where: { compensationId: r.compensationId } }), 0);
  let [pend] = await alerts('COMPENSATION_PENDING');
  assert.deepEqual([pend.orderId, pend.details.compensationId, pend.resolvedAt], [F.id, r.compensationId, null]);
  const pn = await db.notification.findMany({ where: { type: 'COMPENSATION_PENDING' } });
  assert.deepEqual(pn.map((x) => x.userId).sort(), [U.admin.id, U.admin2.id].sort(), 'yalnızca yöneticilere');
  assert.deepEqual([pn[0].link, pn[0].params.qty, pn[0].params.ref], [`/siparisler/${F.id}#kararlar`, 1, 'ABC124']);
  assert.ok((await events(F.id)).includes('COMPENSATION_PENDING'));
  // Kararı yalnızca yönetici verir
  for (const u of [U.sales, U.custA, U.drawer, U.inspector]) assert.deepEqual(await comp.decideCompensation(db, { id: r.compensationId, approve: true, actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, u.appRole);
  assert.deepEqual(await comp.decideCompensation(db, { id: r.compensationId, approve: false, note: 'Müşteri hatası', actor: act(U.admin2) }), { ok: true, status: 'REJECTED', destOrderId: F.id });
  const rej = await compOf(r.compensationId);
  assert.deepEqual([rej.status, rej.decidedById, rej.decisionNote], ['REJECTED', U.admin2.id, 'Müşteri hatası']);
  [pend] = await alerts('COMPENSATION_PENDING');
  assert.ok(pend.resolvedAt instanceof Date);
  assert.equal((await load(F.id)).offers.length, 3, 'ret: teklif değişmez');
  assert.deepEqual(await comp.decideCompensation(db, { id: r.compensationId, approve: true, actor: act(U.admin) }), { ok: false, code: 'NOT_PENDING' });

  // Satış "aynı fiyat" seçti (işlemli tek cam): karar yöneticinin onayını bekler; yönetici YENİ FİYAT GİRMEDEN onaylar —
  // müşteri fiyatı kaynaktaki yönetici fiyatıdır (66,96), işlemler aynen; yeni sürüm müşteriye gider
  const noAlerts = (await alerts('COMPENSATION_PRICE')).length;
  r = await create({ orderId: S.id, lineId: lineOp.id, quantity: 1, dest: into(F), actor: act(U.sales) });
  assert.equal(r.status, 'PENDING');
  assert.equal((await alerts('COMPENSATION_PRICE')).length, noAlerts, 'aynı fiyat: fiyat uyarısı yok (yalnızca onay bekliyor)');
  assert.deepEqual(await comp.decideCompensation(db, { id: r.compensationId, approve: true, actor: act(U.admin) }), { ok: true, status: 'APPLIED', destOrderId: F.id });
  f = await load(F.id);
  assert.equal(f.offers.length, 4);
  assert.deepEqual(f.offers[0].lines.map(lineRow).slice(2), [['CAM', 1, '30', '66.96', false, true], ['CNC', 1, '5', '8', false, true], ['DELIK', 2, '2', '3', false, true]]);
  const done = await compOf(r.compensationId);
  assert.deepEqual([done.status, done.priceMode, done.offerPrice.toString(), done.unitCost.toString(), done.decidedById], ['APPLIED', 'NORMAL', '66.96', '30', U.admin.id]);
  // Farklı müşteri fiyatı gerekiyorsa onu YÖNETİCİ, kararı onaylarken girer (ayrı bir fiyat sistemi yok); maliyet değişmez
  r = await create({ orderId: S.id, lineId: lineG1.id, quantity: 1, dest: into(F), actor: act(U.sales) });
  assert.deepEqual(await comp.decideCompensation(db, { id: r.compensationId, approve: true, price: '45', actor: act(U.admin) }), { ok: true, status: 'APPLIED', destOrderId: F.id });
  f = await load(F.id);
  assert.deepEqual([f.offers.length, f.offers[0].lines.map(lineRow).at(-1)], [5, ['CAM', 1, '30', '45', false, true]]);
  assert.equal((await compOf(r.compensationId)).offerPrice.toString(), '45');
  assert.equal((await alerts('COMPENSATION_PENDING')).filter((x) => !x.resolvedAt).length, 0);
  assert.ok(await db.auditLog.findFirst({ where: { action: 'COMPENSATION_APPLIED', entityId: S.id } }));
  assert.ok(await db.auditLog.findFirst({ where: { action: 'COMPENSATION_REJECTED', entityId: S.id } }));

  // İleri tarihli siparişi olmayan müşteri: yeni ileri gün seçilir → OTH7-T
  r = await create({ orderId: BF.id, lineId: BF.offers[0].lines[0].id, quantity: 1, mode: 'FREE', dest: newOn(F2), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.destOrderNo], [true, 'OTH7-T']);
  assert.equal((await load(r.destOrderId)).customerId, B.id);
});

dbTest('yüklenmeyen camla ilişki: telafisi açılan adet ayrıca aktarılamaz (aynı cam iki kez üretilmez); onay kaydı değişmez', async () => {
  const line = NL.offers[0].lines[0];
  // Y günü: 10 camdan 2'si kırık (8 LOADED + 2 NOT_LOADED)
  assert.equal((await c.confirmLoading(db, { day: Y, key: (await c.previewLoading(db, Y)).key, notLoaded: [{ key: `l:${line.id}`, quantity: 2, reason: 'BROKEN' }], actor: act(U.admin) })).ok, true);
  const snapshot = JSON.stringify(await db.loadingConfirmationItem.findMany({ where: { orderId: NL.id }, orderBy: { id: 'asc' } }));
  const [link] = await comp.notLoadedLinks(db, NL.id);
  assert.deepEqual([link.lineId, link.day, link.free], [line.id, Y, 2]);
  const loaded = await db.loadingConfirmationItem.findFirstOrThrow({ where: { orderId: NL.id, status: 'LOADED' } });
  const req = (p) => create({ orderId: NL.id, lineId: line.id, quantity: 1, mode: 'FREE', dest: newOn(N1), actor: act(U.sales), ...p });
  assert.deepEqual(await req({ quantity: 3, notLoadedItemId: link.itemId }), { ok: false, code: 'NOT_LOADED_CAPACITY' });
  assert.deepEqual(await req({ notLoadedItemId: loaded.id }), { ok: false, code: 'BAD_LINK' }, 'yüklenen kalem telafi ilişkisi olamaz');
  assert.deepEqual(await req({ notLoadedItemId: 'yok' }), { ok: false, code: 'BAD_LINK' });
  // 1 adet, yüklenmeyen camın yerine
  const r = await req({ notLoadedItemId: link.itemId });
  assert.equal(r.ok, true);
  const row = await compOf(r.compensationId);
  assert.deepEqual([row.sourceItemId, row.notLoadedScope], [link.itemId, `${(await db.loadingConfirmation.findUniqueOrThrow({ where: { shipDay: date(Y) } })).id}|l:${line.id}`]);
  // Aktarım kapasitesi telafi adedi kadar azaldı: 2 yüklenmeyen − 1 telafi = 1 serbest
  const [nl] = await rp.notLoadedOfDay(db, Y);
  assert.deepEqual([nl.remaining, nl.compensated, nl.free], [2, 1, 1]);
  assert.deepEqual(await rp.replanNotLoaded(db, { itemId: link.itemId, day: F1, quantity: 2, actor: act(U.admin) }), { ok: false, code: 'BAD_QUANTITY' });
  assert.equal((await rp.replanNotLoaded(db, { itemId: link.itemId, day: F1, quantity: 1, actor: act(U.admin) })).ok, true);
  // Artık serbest adet yok: ne ikinci ilişkili telafi ne ikinci aktarım
  assert.deepEqual(await req({ notLoadedItemId: link.itemId }), { ok: false, code: 'NOT_LOADED_CAPACITY' });
  assert.deepEqual(await rp.replanNotLoaded(db, { itemId: link.itemId, day: F2, actor: act(U.admin) }), { ok: false, code: 'NO_REMAINDER' });
  assert.deepEqual(await comp.notLoadedLinks(db, NL.id), []);
  // Yükleme kaydından bağımsız (ilişkisiz) telafi her zaman açılabilir — meşru ikinci telafi engellenmez
  assert.equal((await req({ quantity: 5 })).ok, true);
  assert.equal(JSON.stringify(await db.loadingConfirmationItem.findMany({ where: { orderId: NL.id }, orderBy: { id: 'asc' } })), snapshot, 'onaylı yükleme (8 yüklendi / 2 yüklenmedi) değişmez');
});

dbTest('olağan akış: bedelsiz telafi siparişi yüklenir; kârlılıkta satış 0, fabrika maliyeti gerçek; müşteri faturası önizlemesi bozulmaz', async () => {
  const T = await db.order.findUniqueOrThrow({ where: { orderNo: 'ABC124-T' }, include: FULL });
  // Yönetici teklifi müşteriye gönderir (form bedelsiz satırın fiyatını 0 gönderir): maliyet korunur, sipariş üretime geçer
  const res = await runOrderAction(db, { orderId: T.id, action: 'approve_offer', actor: act(U.admin), payload: { lines: formLines(T.offers[0].lines, true) } });
  assert.equal(res.result.produced, true);
  const sent = await load(T.id);
  assert.deepEqual(sent.offers[0].lines.map(lineRow), [['CAM', 1, '30', '0', true, true], ['CNC', 1, '5', '0', true, true], ['DELIK', 2, '2', '0', true, true]]);
  // Yükleme: sipariş P gününde yüklenir (olağan yükleme planı ve onayı)
  await db.order.update({ where: { id: T.id }, data: { estimatedShipDate: at(P) } });
  const preview = await c.previewLoading(db, P);
  assert.deepEqual(preview.orders.map((o) => o.orderNo), ['ABC124-T']);
  assert.deepEqual(preview.items.map((i) => [i.kind, i.quantity, i.free, i.unitCost, i.unitSale, i.saleAmount, i.costAmount]), [['CAM', 1, true, 30, 0, 0, 60], ['CNC', 1, true, 5, 0, 0, 5], ['DELIK', 2, true, 2, 0, 0, 4]]);
  assert.equal((await c.confirmLoading(db, { day: P, key: preview.key, actor: act(U.admin) })).ok, true);
  // Kârlılık: bedelsiz telafi satış 0, maliyet 2 m² × 30 + 1 × 5 + 2 × 2 = 69 → katkı −69 (fabrika maliyeti sıfırlanmaz)
  const profit = (await supplierData(db, date(dayOf(1)))).days.find((x) => x.day === P);
  assert.deepEqual([profit.confirmed, profit.byCur.EUR.sale, profit.byCur.EUR.cost, profit.byCur.EUR.profit], [true, 0, 69, -69]);
  // Müşteri faturası önizlemesi: fiyatlı satırı olmayan sipariş faturaya girmez (mevcut kural), hata vermez
  const bill = await inv.loadingBilling(db, { day: P, bnrImpl: bnr });
  assert.equal(bill.ok, true);
  const cust = bill.customers.find((x) => x.customerId === A.id);
  assert.deepEqual([cust.groups.length, cust.excluded.map((x) => [x.orderNo, x.reason])], [0, [['ABC124-T', 'NO_LINES']]]);
});

dbTest('özel durum sandığı: yalnızca yönetici; telafi siparişi başka müşterinin sandığında gider, ticari sahiplik değişmez', async () => {
  const T2 = await db.order.findUniqueOrThrow({ where: { orderNo: 'ABC124-T2' } });
  await cr.saveDayCrates(db, { day: N1, customerId: B.id, rows: [{ crateNo: 15, lengthMm: 2400, widthMm: 1600, heightMm: 900, netKg: 190, grossKg: 260, note: null, orderIds: [BF.id] }], actor: act(U.sales) });
  const crate = await db.crate.findFirstOrThrow({ where: { shipDay: date(N1), customerId: B.id } });
  // Satış (ve diğer roller) başka müşterinin sandığına yerleştiremez / çıkaramaz
  for (const u of [U.sales, U.drawer, U.inspector, U.custA, U.custB]) {
    assert.deepEqual(await cr.assignGuestCrate(db, { day: N1, orderId: T2.id, crateId: crate.id, actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, u.appRole);
  }
  assert.equal(await db.crateOrder.count({ where: { orderId: T2.id } }), 0);
  assert.deepEqual(await cr.assignGuestCrate(db, { day: N1, orderId: T2.id, crateId: crate.id, actor: act(U.admin) }), { ok: true, crateNo: 15 });
  assert.deepEqual(await cr.removeGuestCrate(db, { orderId: T2.id, crateId: crate.id, actor: act(U.sales) }), { ok: false, code: 'FORBIDDEN' });
  // Yalnızca fiziksel yerleşim: sipariş, telafi kaydı ve teklif gerçek müşteride (ABC); sandık ev sahibinde (OTH)
  const o = await load(T2.id);
  assert.deepEqual([o.customerId, o.compOfId, o.offers[0].currency, (await db.crate.findUniqueOrThrow({ where: { id: crate.id } })).customerId], [A.id, S.id, 'EUR', B.id]);
  assert.equal((await db.compensation.findFirstOrThrow({ where: { destOrderId: T2.id } })).customerId, A.id);
  // Müşteri proforması gerçek müşteride: ABC'nin N1 gününde sayılır, OTH'ninkinde yalnızca kendi siparişi
  const dayOfA = (await b.customerLoadingDays(db, { customerId: A.id })).find((x) => x.day === N1);
  assert.ok(dayOfA.eligible >= 1);
  const pb = await b.previewBatch(db, { customerId: B.id, days: [N1], bnrImpl: bnr });
  assert.ok(!pb.included.some((x) => x.orderNo.startsWith('ABC')) && !pb.excluded.some((x) => x.orderNo.startsWith('ABC')), 'ev sahibi müşterinin belgesine misafir sipariş girmez');
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'CROSS_CUSTOMER_CRATE_ASSIGNED', entityId: T2.id } });
  assert.deepEqual([audit.details.ownerCustomerId, audit.details.hostCustomerId, audit.userId], [A.id, B.id, U.admin.id]);
  // Ev sahibi müşteri misafir siparişi göremez (müşteri yalıtımı)
  assert.deepEqual([await visibleTo(U.custB, T2.id), await visibleTo(U.custA, T2.id)], [0, 1]);
});

dbTest('siparişi sil / geri yükle: yalnızca yönetici, çift onaylı; olağan ekranlardan kalkar, FGO / yükleme / denetim kayıtları durur; geri yükleme hiçbir şeyi çoğaltmaz', async () => {
  // R: X gününde yüklendi (onaylı yükleme kalemleri var), FGO belgesi ve çizimi var
  await db.fgoDocument.create({ data: { orderId: R.id, kind: 'PROFORMA', series: 'PRF', number: '9100', issuedAt: new Date() } });
  await db.drawing.create({ data: { orderId: R.id, version: 1, status: 'ONAYLANDI', uploadedById: U.drawer.id, scanStatus: 'SKIPPED' } });
  const counts = async (id) => ({
    docs: await db.fgoDocument.count({ where: { orderId: id } }), items: await db.loadingConfirmationItem.count({ where: { orderId: id } }),
    drawings: await db.drawing.count({ where: { orderId: id } }), offers: await db.offer.count({ where: { orderId: id } }), lines: await db.offerLine.count({ where: { offer: { orderId: id } } }),
    outbox: await db.notificationOutbox.count({ where: { orderId: id } }), notes: await db.notification.count({ where: { orderId: id } }), comps: await db.compensation.count(), orders: await db.order.count(),
  });
  const before = await counts(R.id);
  assert.deepEqual([before.docs, before.drawings, before.items > 0], [1, 1, true]);
  const audits = await db.auditLog.count();

  // Yalnızca yönetici (satış dahil hiçbir rol silemez / geri yükleyemez); onay kutusu olmadan yönetici de silemez
  for (const u of [U.sales, U.drawer, U.inspector, U.custA]) {
    assert.deepEqual(await rm.removeOrder(db, { orderId: R.id, confirm: true, actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, u.appRole);
  }
  assert.deepEqual(await rm.removeOrder(db, { orderId: R.id, confirm: false, actor: act(U.admin) }), { ok: false, code: 'CONFIRM_REQUIRED' });
  assert.deepEqual(await rm.removeOrder(db, { orderId: 'yok', confirm: true, actor: act(U.admin) }), { ok: false, code: 'NOT_FOUND' });
  // Kuyrukta bekleyen FGO belgesi varken silinmez (silme FGO'da hiçbir işlem yapmaz / işi düşürmez)
  const job = await db.notificationOutbox.create({ data: { type: 'FGO_GLASS', orderId: R2.id, payload: { kind: 'PROFORMA' } } });
  assert.deepEqual(await rm.removeOrder(db, { orderId: R2.id, confirm: true, actor: act(U.admin) }), { ok: false, code: 'BUSY' });
  await db.notificationOutbox.delete({ where: { id: job.id } });
  assert.equal((await load(R.id)).removedAt, null);

  // --- Sil
  const daysBefore = (await b.customerLoadingDays(db, { customerId: A.id })).find((x) => x.day === F1);
  assert.deepEqual(await rm.removeOrder(db, { orderId: R.id, confirm: true, actor: act(U.admin) }), { ok: true, orderNo: 'ABC400' });
  assert.deepEqual(await rm.removeOrder(db, { orderId: R2.id, confirm: true, actor: act(U.admin) }), { ok: true, orderNo: 'ABC401' });
  const gone = await load(R.id);
  assert.deepEqual([gone.removedAt instanceof Date, gone.removedById, gone.removedStatus, gone.status, gone.version], [true, U.admin.id, 'URETIMDE', 'IPTAL', R.version + 1]);
  assert.deepEqual(await rm.removeOrder(db, { orderId: R.id, confirm: true, actor: act(U.admin) }), { ok: false, code: 'ALREADY_REMOVED' });
  // Olağan ekranlardan kalkar: hiçbir rolün sipariş kapsamında yok (liste, arama, sipariş sayfası, dosyalar, işlemler)
  for (const u of Object.values(U)) assert.equal(await visibleTo(u, R.id), 0, u.appRole);
  await assert.rejects(runOrderAction(db, { orderId: R.id, action: 'set_ship_date', actor: act(U.admin), payload: { date: at(F2) } }), /NOT_FOUND/);
  assert.deepEqual(await create({ orderId: R.id, lineId: R.offers[0].lines[0].id, quantity: 1, dest: newOn(N1), actor: act(U.admin) }), { ok: false, code: 'NOT_FOUND' });
  // Yükleme planı, müşteri proforması ve telafi hedefleri: silinen ileri tarihli sipariş (ABC401) hiçbirinde yok
  const daysAfter = (await b.customerLoadingDays(db, { customerId: A.id })).find((x) => x.day === F1);
  assert.equal(daysAfter.eligible + daysAfter.excluded, daysBefore.eligible + daysBefore.excluded - 1);
  const pb = await b.previewBatch(db, { customerId: A.id, days: [F1], bnrImpl: bnr });
  assert.ok(![...pb.included, ...pb.excluded].some((x) => x.orderNo === 'ABC401'));
  assert.ok(!(await comp.compensationDestinations(db, { source: { id: S.id, customerId: A.id, currency: 'EUR' } })).some((x) => x.orderNo === 'ABC401'));
  assert.deepEqual(await create({ orderId: S.id, lineId: lineG1.id, quantity: 1, dest: into(R2), actor: act(U.admin) }), { ok: false, code: 'DEST_CLOSED' });
  assert.deepEqual((await rm.removedOrders(db)).map((o) => o.orderNo).sort(), ['ABC400', 'ABC401']);
  // Kayıtlar durur: FGO belgesi, onaylı yükleme kalemleri, çizim, teklif — hiçbiri silinmedi / değişmedi; denetim + geçmiş yazıldı
  assert.deepEqual(await counts(R.id), before);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_REMOVED', entityId: R.id } });
  assert.deepEqual([audit.userId, audit.details.orderNo, audit.details.statusBefore, audit.details.kept.fgoDocuments, audit.details.kept.loadingItems > 0, audit.details.kept.drawings], [U.admin.id, 'ABC400', 'URETIMDE', 1, true, 1]);
  assert.ok((await events(R.id)).includes('REMOVED'));
  // Onaylı günün kârlılığı (tarihsel kayıt) silinen siparişin yüklenmiş camını saymaya devam eder
  const day = (await supplierData(db, date(dayOf(1)))).days.find((x) => x.day === X);
  assert.equal(day.orders, 3, 'X gününde onaylanan üç sipariş (ABC124, ABC200, ABC400)');

  // --- Geri yükle: yalnızca yönetici; önceki durumuna döner; hiçbir kayıt çoğalmaz
  for (const u of [U.sales, U.drawer, U.inspector, U.custA]) assert.deepEqual(await rm.restoreOrder(db, { orderId: R.id, actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, u.appRole);
  assert.deepEqual(await rm.restoreOrder(db, { orderId: R.id, actor: act(U.admin) }), { ok: true, orderNo: 'ABC400', status: 'URETIMDE' });
  const back = await load(R.id);
  assert.deepEqual([back.removedAt, back.removedById, back.removedStatus, back.status, back.version], [null, null, null, 'URETIMDE', R.version + 2]);
  assert.deepEqual(await counts(R.id), before, 'geri yükleme belge / yükleme / teklif / bildirim / telafi / sipariş çoğaltmaz');
  assert.deepEqual(await rm.restoreOrder(db, { orderId: R.id, actor: act(U.admin) }), { ok: false, code: 'NOT_REMOVED' });
  assert.deepEqual([await visibleTo(U.admin, R.id), await visibleTo(U.custA, R.id), await visibleTo(U.sales, R.id)], [1, 1, 1]);
  assert.ok((await events(R.id)).includes('RESTORED'));
  assert.equal(await db.auditLog.count({ where: { action: { in: ['ORDER_REMOVED', 'ORDER_RESTORED'] } } }), 3);
  assert.ok(await db.auditLog.count() >= audits + 3);
  assert.deepEqual((await rm.removedOrders(db)).map((o) => o.orderNo), ['ABC401']);
});

dbTest('hiçbir ağ çağrısı yapılmadı (FGO gerçek bir sistemdir; bu dosya FGO belgesi kesmez)', async () => {
  assert.equal(net, 0);
  // Belge kayıtları yalnızca testin doğrudan yazdığı iki satırdır; telafi / silme belge üretmez
  assert.deepEqual((await db.fgoDocument.findMany({ orderBy: { number: 'asc' } })).map((d) => d.number), ['9001', '9100']);
  assert.equal(await db.notificationOutbox.count({ where: { type: { in: ['FGO_GLASS', 'FGO_BATCH', 'FGO_PROFORMA', 'FGO_INVOICE'] } } }), 0);
});
