// Kırık / telafi camı, özel durum sandığı ve siparişi silme / geri yükleme (Aşama 9, karar 108–110; fiyat kuralı 112,
// işlemlerin tek cama ait olması 113; fonksiyonel paket 1 — karar 157: kaynak adedi, işlemlerin müşteri fiyatı 0, üç fiyat
// kararı ve doğrudan müşteriye giden teklif) — veritabanıyla.
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
const { atOfferPrice, offerTotals } = await import('../../server/orders/rules.js');
const n = await import('../../server/notifications/inapp.js');

const SECRET = 't'.repeat(40);
const U = {};
let db, A, B, S, S2, NL, D1, F, R, R2, BF, L, lineG1, lineOp, lineG2;
let net = 0;
const realFetch = globalThis.fetch;
const act = (u) => ({ id: u.id, role: u.appRole, ip: '127.0.0.1', customerId: u.customerId });
// Yöneticinin telafi fiyatı e-postası (karar 218): müşteriye giden olaylardan ayrı sayılır
const ADMIN_MAIL = 'ORDER_COMPENSATION_PRICE';
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
/** Bir telafinin "Önemli kararlar" kaydı ve yönetici bildirimleri (telafi başına BİR kayıt, yönetici başına BİR bildirim) */
const alertOf = (compensationId) => db.adminAlert.findMany({ where: { details: { path: ['compensationId'], equals: compensationId } } });
const noticesOf = (compensationId) => db.notification.findMany({ where: { dedupeKey: { in: [`comp:${compensationId}`, `comp-pending:${compensationId}`] } }, orderBy: { userId: 'asc' } });
const NOT_REDUCED = (reason) => ({ reduced: false, reason, before: null, after: null });
const REDUCED = (before, after) => ({ reduced: true, reason: null, before, after });
/** Teklif satırlarının toplamı: cam adedi, m², müşteri tutarı ve satış (maliyet) tutarı — uygulamanın kendi hesabıyla */
const totals = (lines) => {
  const plain = lines.map((l) => ({ ...l, unitPrice: String(l.unitPrice ?? 0), offerPrice: l.offerPrice == null ? null : String(l.offerPrice) }));
  const glass = plain.filter((l) => l.kind === 'CAM' && l.unit === 'm2');
  return { adet: glass.reduce((a, l) => a + l.adet, 0), m2: offerTotals(plain).metraj, sale: offerTotals(atOfferPrice(plain)).amount, cost: offerTotals(plain).amount };
};
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
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
  BF = await order(B, 7, N1, [glassLine(3)]);
});
after(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
});

dbTest('yüklenip teslim edilmiş siparişten telafi (satış, bedelsiz, yeni sipariş): ABC124-T; teklif doğrudan müşteride; kaynak ve onaylı yükleme değişmez; maliyet durur', async () => {
  // Kaynak sipariş X gününde EKSİKSİZ yüklendi (10 LOADED): telafi yüklenmeme kaydına bağlı değildir
  assert.equal((await c.confirmLoading(db, { day: X, key: (await c.previewLoading(db, X)).key, actor: act(U.admin) })).ok, true);
  const confBefore = JSON.stringify(await db.loadingConfirmationItem.findMany({ where: { orderId: S.id }, orderBy: { id: 'asc' } }));
  const before = JSON.stringify((await load(S.id)).offers);
  const version = (await load(S.id)).version;
  // Yüklenmiş siparişin adedi düşürülmez (form bunu kayıttan ÖNCE gösterir)
  assert.deepEqual(await comp.sourceState(db, S.id), { ok: false, reason: 'LOADED' });
  const alerts0 = await db.adminAlert.count();

  // Yetki sunucuda: müşteri, çizim, denetimci açamaz — hiçbir kayıt oluşmaz (fiyat kararını da seçemezler)
  for (const u of [U.custA, U.drawer, U.inspector]) {
    for (const mode of ['FREE', 'NORMAL', 'CUSTOM']) {
      assert.deepEqual(await create({ orderId: S.id, lineId: lineG1.id, quantity: 3, mode, dest: newOn(N1), actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, `${u.appRole} ${mode}`);
    }
  }
  // Geçersiz istekler
  const bad = async (p, code) => assert.deepEqual(await create({ orderId: S.id, lineId: lineG1.id, quantity: 3, mode: 'FREE', dest: newOn(N1), actor: act(U.sales), ...p }), { ok: false, code }, code);
  await bad({ quantity: 0 }, 'BAD_QUANTITY');
  await bad({ quantity: 10 }, 'BAD_QUANTITY'); // işlemsiz satırda 9 cam var
  await bad({ lineId: lineOp.id, quantity: 2 }, 'BAD_QUANTITY'); // işlemli satır TEK camdır
  await bad({ quantity: '2.5' }, 'BAD_QUANTITY');
  await bad({ lineId: S.offers[0].lines[2].id }, 'BAD_LINE'); // CNC satırı
  await bad({ lineId: S.offers[0].lines[5].id }, 'BAD_LINE'); // sandık parası
  await bad({ lineId: 'yok' }, 'BAD_LINE');
  await bad({ dest: newOn(dayOf(0)) }, 'NOT_FUTURE');
  await bad({ dest: newOn('2026-13-45') }, 'BAD_DAY');
  await bad({ dest: { type: 'BASKA' } }, 'BAD_DEST');
  await bad({ confirm: false }, 'CONFIRM_REQUIRED');
  await bad({ requestKey: 'kısa' }, 'BAD_REQUEST');
  // Farklı fiyat (karar 251): satış kendi satış fiyatını, yönetici müşteri fiyatını girer — fiyat zorunlu ve pozitif
  await bad({ mode: 'CUSTOM' }, 'BAD_PRICE');
  await bad({ mode: 'CUSTOM', price: '0' }, 'BAD_PRICE');
  await bad({ mode: 'CUSTOM', price: '0', actor: act(U.admin) }, 'BAD_PRICE');
  await bad({ mode: 'CUSTOM', actor: act(U.admin) }, 'BAD_PRICE');
  await bad({ mode: 'BASKA' }, 'BAD_MODE');
  await bad({ dest: into(BF) }, 'DEST_OTHER_CUSTOMER'); // başka müşterinin siparişi hedef olamaz
  assert.equal(await db.compensation.count(), 0);
  assert.equal(await db.order.count({ where: { compOfId: { not: null } } }), 0);
  assert.equal(await db.adminAlert.count(), alerts0);

  // --- Satış: işlemli TEK cam, BEDELSİZ, yeni telafi siparişi (müşterinin ileri tarihli siparişleri VAR; yine de yeni sipariş seçilebilir)
  const r = await create({ orderId: S.id, lineId: lineOp.id, quantity: 1, mode: 'FREE', dest: newOn(N1), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.destOrderNo, r.created, r.duplicate, r.via, r.direct], [true, 'APPLIED', 'ABC124-T', true, false, 'NEW', true]);
  // Bedelsiz telafi (karar 256): kaynak adedi HİÇ değişmez (yüklenmiş olsa da olmasa da) — nedeni FREE
  assert.deepEqual(r.source, NOT_REDUCED('FREE'), 'bedelsiz: kaynak adedi değişmez, telafi ayrı ek üretimdir');
  const T = await load(r.destOrderId);
  // Bedelsiz: teklif yöneticiye uğramadan müşteriye gönderilmiş açılır; çizim gerekmediği için sipariş kendiliğinden üretime geçer
  assert.deepEqual(
    [T.orderNo, T.customerOrderNo, T.compSeq, T.compOfId, T.customerId, T.orderTypeCode, T.status, T.drawingTrack, T.estimatedShipDate.toISOString().slice(0, 10), T.title, T.offers.length, T.slaDeadline],
    ['ABC124-T', 124, 1, S.id, A.id, 'GLASS_ORDER', 'URETIMDE', 'YOK', N1, S.title, 1, null],
  );
  const offer = T.offers[0];
  assert.deepEqual([offer.status, offer.currency, offer.amount.toString(), offer.offerAmount.toString(), offer.sentAt instanceof Date, offer.createdById], ['GONDERILDI', 'EUR', '0', '0', true, U.sales.id]);
  assert.equal((await db.price.findUniqueOrThrow({ where: { orderId: T.id } })).amount.toString(), '0');
  // Bedelsiz: müşteri fiyatı 0, FABRİKA MALİYETİ durur (30 / 5 / 2); o cama ait işlemler telafiye taşınır (1 CNC, 2 delik) — oran / yuvarlama yok
  assert.deepEqual(offer.lines.map(lineRow), [['CAM', 1, '30', '0', true, true], ['CNC', 1, '5', '0', true, true], ['DELIK', 2, '2', '0', true, true]]);
  assert.deepEqual(offer.lines.slice(1).map((l) => [l.description, l.unit]), [['CNC', 'adet'], ['Delik', 'adet']]);
  assert.equal(new Set(offer.lines.map((l) => l.compensationId)).size, 1, 'işlem satırları aynı telafinin camına bağlı');
  const g1 = offer.lines[0];
  assert.deepEqual([g1.description, g1.descriptionRo, g1.enMm, g1.boyMm, g1.unit, g1.weightKgM2.toString(), g1.listPrice.toString()], ['Temper Lamine 44.2', 'Sticlă laminată 44.2', 1000, 2000, 'm2', '20.8', '30']);
  assert.deepEqual(T.items.map((i) => [i.glassName, i.camAdedi]), [['Temper Lamine 44.2', 1]]);

  // Karar kaydı: kaynak sipariş / satır, adet, fiyat kararı (konusu MÜŞTERİ fiyatı: önceki 66,96 → 0), hedef
  const row = await compOf(r.compensationId);
  assert.deepEqual(
    [row.status, row.sourceOrderId, row.sourceOfferId, row.sourceLineId, row.customerId, row.quantity, row.priceMode, row.priceTier, row.free, row.normalCost.toString(), row.normalPrice.toString(), row.unitCost.toString(), row.offerPrice.toString(), row.destType, row.destOrderId, row.loadingDay.toISOString().slice(0, 10), row.createdById, row.sourceItemId],
    ['APPLIED', S.id, S.offers[0].id, lineOp.id, A.id, 1, 'FREE', 'CUSTOMER', true, '30', '66.96', '30', '0', 'NEW', T.id, N1, U.sales.id, null],
  );
  assert.ok(row.createdAt instanceof Date);
  // "Önemli kararlar": telafi başına BİR kayıt — kaynak sipariş, cam, adet, karar, ÖNCEKİ MÜŞTERİ FİYATI (66,96) → 0, kim, ne zaman, hedef, kaynak adedi
  const priceAlerts = await alerts('COMPENSATION_PRICE');
  assert.equal(priceAlerts.length, 1);
  const [alert] = priceAlerts;
  assert.deepEqual(
    [alert.orderId, alert.createdById, alert.details.orderNo, alert.details.glass, alert.details.quantity, alert.details.tier, alert.details.mode, alert.details.normal, alert.details.price, alert.details.currency, alert.details.destOrderNo, alert.details.day, alert.details.direct],
    [S.id, U.sales.id, 'ABC124', '1 × Temper Lamine 44.2 1000×2000', 1, 'CUSTOMER', 'FREE', 66.96, 0, 'EUR', 'ABC124-T', N1, true],
  );
  assert.deepEqual([alert.details.compensationId, alert.details.source], [r.compensationId, NOT_REDUCED('FREE')]);
  assert.ok(alert.createdAt instanceof Date);
  assert.equal(await db.adminAlert.count(), alerts0 + 1, 'ikinci bir kayıt (bekleyen karar vb.) açılmaz');
  // Denetim kaydı: kim, kaynak sipariş / satır, telafi, adet, karar, önceki ve uygulanan fiyat, hedef, kaynak adedi
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'COMPENSATION_CREATED', entityId: S.id } });
  assert.deepEqual(
    [audit.userId, audit.actorRole, audit.details.compensationId, audit.details.sourceOrderNo, audit.details.sourceLineId, audit.details.quantity, audit.details.priceMode, audit.details.normalPrice, audit.details.offerPrice, audit.details.unitCost, audit.details.free, audit.details.priceChanged, audit.details.destType, audit.details.destOrderNo, audit.details.loadingDay, audit.details.direct],
    [U.sales.id, 'SATIS', r.compensationId, 'ABC124', lineOp.id, 1, 'FREE', 66.96, 0, 30, true, true, 'NEW', 'ABC124-T', N1, true],
  );
  assert.ok(audit.createdAt instanceof Date);
  assert.deepEqual(audit.details.operations, [{ kind: 'CNC', adet: 1, unitPrice: 5, offerPrice: 0, free: true }, { kind: 'DELIK', adet: 2, unitPrice: 2, offerPrice: 0, free: true }], 'bedelsiz: taşınan işlemlerin müşteri fiyatı 0, maliyet durur');
  assert.deepEqual(audit.details.source, { ...NOT_REDUCED('FREE'), offerId: null });
  // Geçmiş: kaynakta ve hedefte; notta tutar yok
  const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: S.id, event: 'COMPENSATION' } });
  assert.equal(ev.note, `1 × Temper Lamine 44.2 1000×2000 → ABC124-T / ${dmy(N1)}`);
  assert.deepEqual((await events(T.id)).sort(), ['COMPENSATION_ADDED', 'CREATED', 'OFFER_SENT', 'PRODUCTION']);

  // Kaynak teklif satırı, kaynak sipariş ve ONAYLI YÜKLEME değişmedi (tamamı LOADED; NOT_LOADED kaydı yok)
  const after = await load(S.id);
  assert.equal(JSON.stringify(after.offers), before, 'yüklenmiş kaynağın teklifi değişmez');
  assert.deepEqual([after.version, after.status], [version, 'URETIMDE']);
  assert.equal(JSON.stringify(await db.loadingConfirmationItem.findMany({ where: { orderId: S.id }, orderBy: { id: 'asc' } })), confBefore, 'onaylı yükleme değişmez');
  assert.equal(await db.loadingConfirmationItem.count({ where: { orderId: S.id, status: 'NOT_LOADED' } }), 0);

  // Bildirimler: müşteriye olağan "teklif hazır" olayı; yöneticiye telafi başına BİR bildirim (karar başlıkta). Yöneticinin
  // fiyat onayı sırasına düşmediği için "teklif yöneticide" olayı YOK.
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: T.id, type: { not: ADMIN_MAIL } } })).map((o) => o.type).sort(), ['ORDER_OFFER_SENT', 'ORDER_PRODUCTION']);
  // Yöneticiye e-posta (karar 218): bedelsiz = müşteri fiyatı değişti → telafi başına BİR olay (tutar yok; işlemi yapan hariç)
  const mail = await db.notificationOutbox.findMany({ where: { type: ADMIN_MAIL, payload: { path: ['compensationId'], equals: r.compensationId } } });
  assert.deepEqual(mail.map((m) => [m.orderId, m.payload.mode, m.payload.qty, m.payload.sourceOrderNo, m.payload.pending, m.payload.actorId]), [[T.id, 'FREE', 1, 'ABC124', false, U.sales.id]]);
  let notes = await noticesOf(r.compensationId);
  assert.deepEqual(notes.map((x) => [x.type, x.userId]).sort(), [['COMPENSATION_FREE', U.admin.id], ['COMPENSATION_FREE', U.admin2.id]].sort(), 'yalnızca yöneticiler, kişi başına tek bildirim');
  assert.deepEqual([notes[0].link, notes[0].orderId, notes[0].params.qty, notes[0].params.ref, notes[0].params.orderNo], [`/siparisler/${T.id}#kararlar`, T.id, 1, 'ABC124', 'ABC124-T']);
  await n.dispatchInApp(db);
  await n.dispatchInApp(db);
  notes = await db.notification.findMany({ where: { orderId: T.id } });
  assert.equal(notes.filter((x) => x.type === 'COMPENSATION_FREE').length, 2, 'bildirim çoğalmaz');
  assert.equal(notes.filter((x) => x.type === 'ORDER_OFFER_SUBMITTED').length, 0);
  assert.ok(notes.some((x) => x.type === 'ORDER_OFFER_SENT' && x.userId === U.custA.id), 'müşteri teklifini panelinde görür');
  assert.ok(!notes.some((x) => x.userId === U.custB.id || x.userId === U.drawer.id || x.userId === U.inspector.id));
});

dbTest('fiyat kararı (karar 251): bedelsiz / aynı fiyat / farklı fiyat doğrudan müşteriye; satışın farklı fiyatı satış kademesinde, yönetici onayı yok; işlem fiyatları aynı / farklı fiyatta korunur; numara -T2, -T3 …', async () => {
  const priceAlerts = (await alerts('COMPENSATION_PRICE')).length;
  // --- AYNI FİYAT (satış) — İŞLEMSİZ cam satırından 2 cam: müşteri fiyatı kaynaktan AYNEN (66,96; sunucuda kopyalanır, satış
  // görmez), maliyet 30. Aynı camın işlemli kardeşi (lineOp) var ama işlemsiz cam İŞLEM MİRAS ALMAZ.
  let r = await create({ orderId: S.id, lineId: lineG1.id, quantity: 2, dest: newOn(N1), actor: act(U.sales) });
  assert.deepEqual([r.destOrderNo, r.status, r.via, r.direct], ['ABC124-T2', 'APPLIED', 'NEW', true]);
  assert.ok(!JSON.stringify(r).includes('66.96'), 'servisin döndürdüğü sonuçta müşteri fiyatı yok (satış tutarı görmez)');
  const T2 = await load(r.destOrderId);
  assert.deepEqual([T2.status, T2.offers[0].status], ['URETIMDE', 'GONDERILDI'], 'yönetici yeniden fiyatlandırmaz: teklif müşteride, sipariş üretimde');
  assert.deepEqual(T2.offers[0].lines.map(lineRow), [['CAM', 2, '30', '66.96', false, true]]);
  // 2 cam × 2 m² = 4 m²: satış 4×30 = 120; müşteri 4×66,96 = 267,84
  assert.deepEqual([T2.offers[0].amount.toString(), T2.offers[0].offerAmount.toString()], ['120', '267.84']);
  assert.equal((await db.price.findUniqueOrThrow({ where: { orderId: T2.id } })).amount.toString(), '267.84');
  let row = await compOf(r.compensationId);
  assert.deepEqual([row.priceMode, row.priceTier, row.free, row.normalPrice.toString(), row.offerPrice.toString(), row.unitCost.toString()], ['NORMAL', 'CUSTOMER', false, '66.96', '66.96', '30']);
  // Her telafi "Önemli kararlar"a BİR kayıt düşürür (aynı fiyatta da): karar, önceki → uygulanan müşteri fiyatı
  let found = await alertOf(r.compensationId);
  let [a] = found;
  assert.deepEqual([found.length, a.type, a.orderId, a.details.mode, a.details.normal, a.details.price, a.details.direct, a.resolvedAt], [1, 'COMPENSATION_PRICE', S.id, 'NORMAL', 66.96, 66.96, true, null]);
  assert.equal((await alerts('COMPENSATION_PRICE')).length, priceAlerts + 1);
  assert.deepEqual((await noticesOf(r.compensationId)).map((x) => x.type), ['COMPENSATION_SAME', 'COMPENSATION_SAME']);
  let audit = await db.auditLog.findFirstOrThrow({ where: { action: 'COMPENSATION_CREATED', details: { path: ['compensationId'], equals: r.compensationId } } });
  assert.deepEqual([audit.details.priceMode, audit.details.priceChanged, audit.details.normalPrice, audit.details.offerPrice, audit.details.operations, audit.details.direct], ['NORMAL', false, 66.96, 66.96, [], true]);

  // --- AYNI FİYAT (satış) — İŞLEMLİ tek cam (karar 251): işlemler telafiye taşınır (1 CNC, 2 delik) ve İKİ fiyatı da kaynaktaki
  // gibi kalır (satış 5 / 2, müşteri 8 / 3) — camda işlem var diye hiçbir fiyat 0'a düşmez
  r = await create({ orderId: S.id, lineId: lineOp.id, quantity: 1, dest: newOn(N1), actor: act(U.sales) });
  assert.equal(r.destOrderNo, 'ABC124-T3');
  const T3 = await load(r.destOrderId);
  assert.deepEqual(T3.offers[0].lines.map(lineRow), [['CAM', 1, '30', '66.96', false, true], ['CNC', 1, '5', '8', false, true], ['DELIK', 2, '2', '3', false, true]]);
  // 1 cam × 2 m² + işlemler: satış 60 + 5 + 4 = 69; müşteri 133,92 + 8 + 6 = 147,92
  assert.deepEqual([T3.offers[0].status, T3.offers[0].amount.toString(), T3.offers[0].offerAmount.toString()], ['GONDERILDI', '69', '147.92']);
  assert.equal((await db.price.findUniqueOrThrow({ where: { orderId: T3.id } })).amount.toString(), '147.92');
  audit = await db.auditLog.findFirstOrThrow({ where: { action: 'COMPENSATION_CREATED', details: { path: ['compensationId'], equals: r.compensationId } } });
  assert.deepEqual(audit.details.operations, [{ kind: 'CNC', adet: 1, unitPrice: 5, offerPrice: 8, free: false }, { kind: 'DELIK', adet: 2, unitPrice: 2, offerPrice: 3, free: false }]);

  // --- FARKLI FİYAT (satış, karar 251) — işlemli tek cam: satışın girdiği fiyat camın SATIŞ fiyatıdır; müşteri fiyatı kaynağınki
  // (66,96 — satış görmez); işlem fiyatları sıfırlanmaz. Yönetici onayı BEKLENMEZ: teklif doğrudan müşteriye, sipariş üretime.
  const stable = async () => [await db.compensation.count(), await db.order.count(), await db.offer.count(), await db.adminAlert.count(), await db.notification.count()];
  let counts = await stable();
  // Fiyatsız ya da geçersiz fiyatla istek reddedilir — hiçbir kayıt / sipariş / uyarı oluşmaz
  for (const price of [null, '', '0', '-1', 'abc']) assert.deepEqual(await create({ orderId: S.id, lineId: lineOp.id, quantity: 1, mode: 'CUSTOM', price, dest: newOn(N1), actor: act(U.sales) }), { ok: false, code: 'BAD_PRICE' }, String(price));
  assert.deepEqual(await stable(), counts);
  r = await create({ orderId: S.id, lineId: lineOp.id, quantity: 1, mode: 'CUSTOM', price: '35,00', dest: newOn(N1), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.destOrderNo, r.via, r.direct], [true, 'APPLIED', 'ABC124-T4', 'NEW', true]);
  assert.ok(!JSON.stringify(r).includes('66.96'), 'satışa müşteri fiyatı dönmez');
  const T4 = await load(r.destOrderId);
  assert.deepEqual([T4.status, T4.offers.length, T4.offers[0].status, T4.offers[0].sentAt instanceof Date], ['URETIMDE', 1, 'GONDERILDI', true]);
  assert.deepEqual(T4.offers[0].lines.map(lineRow), [['CAM', 1, '35', '66.96', false, true], ['CNC', 1, '5', '8', false, true], ['DELIK', 2, '2', '3', false, true]]);
  // Satış tutarı girilen fiyatla (70 + 9); müşteri tutarı aynı fiyattaki gibi (147,92)
  assert.deepEqual([T4.offers[0].amount.toString(), T4.offers[0].offerAmount.toString(), (await db.price.findUniqueOrThrow({ where: { orderId: T4.id } })).amount.toString()], ['79', '147.92', '147.92']);
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: T4.id, type: { not: ADMIN_MAIL } } })).map((o) => o.type).sort(), ['ORDER_OFFER_SENT', 'ORDER_PRODUCTION']);
  // Yöneticiye: e-posta (bekleyen fiyat YOK), "Önemli kararlar" kaydı (satış kademesinde önceki 30 → 35) ve uygulama içi bildirim
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: T4.id, type: ADMIN_MAIL } })).map((o) => [o.payload.mode, o.payload.pending]), [['CUSTOM', false]]);
  row = await compOf(r.compensationId);
  assert.deepEqual([row.status, row.priceMode, row.priceTier, row.free, row.unitCost.toString(), row.offerPrice.toString(), row.normalCost.toString(), row.normalPrice.toString()], ['APPLIED', 'CUSTOM', 'SALES', false, '35', '66.96', '30', '66.96']);
  found = await alertOf(r.compensationId);
  [a] = found;
  assert.deepEqual([found.length, a.type, a.details.mode, a.details.tier, a.details.normal, a.details.price, a.details.direct, a.resolvedAt], [1, 'COMPENSATION_PRICE', 'CUSTOM', 'SALES', 30, 35, true, null]);
  const cn = await noticesOf(r.compensationId);
  assert.deepEqual(cn.map((x) => [x.type, x.userId]).sort(), [['COMPENSATION_CUSTOM', U.admin.id], ['COMPENSATION_CUSTOM', U.admin2.id]].sort());
  assert.equal(cn[0].link, `/siparisler/${T4.id}#kararlar`);
  // Yönetici isterse müşteri fiyatını OLAĞAN "teklifi güncelle" ile değiştirir; değiştirmezse fiyat korunur
  const upd = formLines(T4.offers[0].lines, true).map((l) => (l.kind === 'CAM' ? { ...l, offerPrice: '60.00' } : l));
  await runOrderAction(db, { orderId: T4.id, action: 'update_offer', actor: act(U.admin), payload: { lines: upd } });
  const T4b = await load(T4.id);
  assert.deepEqual([T4b.offers.length, T4b.offers[0].lines.map(lineRow)[0]], [2, ['CAM', 1, '35', '60', false, true]]);
  // Satış teklifi güncelleyemez (müşteri fiyatını değiştiremez)
  await assert.rejects(runOrderAction(db, { orderId: T4.id, action: 'update_offer', actor: act(U.sales), payload: { lines: upd } }), /NOT_ALLOWED/);

  // --- Kaynakta müşteri fiyatı YOK (eski kayıt): satışın farklı fiyatında da kesin müşteri fiyatı yoktur → yeni telafi siparişi
  // YÖNETİCİNİN fiyatlandırmasına gider; fiyatlandırılmadan müşteriye gitmez
  const SU = await order(A, 126, OLD, [glassLine(2, { offerPrice: null })], { status: 'YUKLENDI' });
  r = await create({ orderId: SU.id, lineId: SU.offers[0].lines[0].id, quantity: 1, mode: 'CUSTOM', price: '35', dest: newOn(N1), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.destOrderNo, r.via, r.direct], [true, 'APPLIED', 'ABC126-T', 'NEW', false]);
  let TU = await load(r.destOrderId);
  assert.deepEqual([TU.status, TU.offers.length, TU.offers[0].status, TU.offers[0].sentAt, TU.slaDeadline instanceof Date], ['HAZIRLANIYOR', 1, 'YONETIMDE', null, true]);
  assert.deepEqual(TU.offers[0].lines.map(lineRow), [['CAM', 1, '35', null, false, true]]);
  assert.equal(await db.price.count({ where: { orderId: TU.id } }), 0);
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: TU.id, type: { not: ADMIN_MAIL } } })).map((o) => o.type), [], 'müşteriye hiçbir şey gitmedi');
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: TU.id, type: ADMIN_MAIL } })).map((o) => [o.payload.mode, o.payload.pending]), [['CUSTOM', true]]);
  assert.equal((await noticesOf(r.compensationId))[0].link, `/siparisler/${TU.id}#teklif`, 'yönetici fiyat onayına gider');
  // Fiyatı yalnızca yönetici belirler: satış, çizim, denetimci ve müşteri teklifi fiyatlandıramaz / gönderemez
  const priced = (price) => formLines(TU.offers[0].lines, true).map((l) => (l.kind === 'CAM' ? { ...l, offerPrice: price } : l));
  for (const u of [U.sales, U.drawer, U.inspector, U.custA]) {
    await assert.rejects(runOrderAction(db, { orderId: TU.id, action: 'approve_offer', actor: act(u), payload: { lines: priced('1.00') } }), /NOT_ALLOWED|NOT_FOUND/, u.appRole);
  }
  await assert.rejects(runOrderAction(db, { orderId: TU.id, action: 'approve_offer', actor: act(U.admin), payload: { lines: formLines(TU.offers[0].lines, true) } }), /OFFER_PRICE_MISSING/);
  const sent = await runOrderAction(db, { orderId: TU.id, action: 'approve_offer', actor: act(U.admin), payload: { lines: priced('55.00') } });
  assert.equal(sent.result.produced, true);
  TU = await load(TU.id);
  assert.deepEqual([TU.status, TU.offers[0].status, TU.offers[0].lines.map(lineRow)], ['URETIMDE', 'GONDERILDI', [['CAM', 1, '35', '55', false, true]]]);
  row = await compOf(r.compensationId);
  assert.deepEqual([row.offerPrice.toString(), row.free, row.priceMode, row.priceTier], ['55', false, 'CUSTOM', 'SALES']);
  const priceAudit = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_TRANSITION', entityId: TU.id, details: { path: ['action'], equals: 'approve_offer' } } });
  assert.deepEqual([priceAudit.userId, priceAudit.details.compensationPrices], [U.admin.id, [{ compensationId: r.compensationId, offerPrice: 55, free: false }]]);

  // Eski kayıt: işlemler adedi 10 olan satıra bağlı — hangi camda olduğu belli değil → telafi açılmaz (oran / tahmin yok)
  counts = await stable();
  for (const u of [U.sales, U.admin]) {
    assert.deepEqual(await create({ orderId: L.id, lineId: L.offers[0].lines[0].id, quantity: 1, mode: 'FREE', dest: newOn(N1), actor: act(u) }), { ok: false, code: 'AMBIGUOUS_OPS' }, u.appRole);
  }
  assert.deepEqual(await stable(), counts);

  // --- Yönetici: farklı fiyat 50 (önceki 40) — MÜŞTERİ fiyatını kendisi girer; fabrika maliyeti (20) değişmez. Fiyat kesindir:
  // ek onay yok, teklif doğrudan müşteriye (karar 251)
  r = await create({ orderId: S.id, lineId: lineG2.id, quantity: 1, mode: 'CUSTOM', price: 50, dest: newOn(N1), actor: act(U.admin) });
  assert.deepEqual([r.destOrderNo, r.direct], ['ABC124-T5', true]);
  const T5 = await load(r.destOrderId);
  assert.deepEqual([T5.status, T5.offers[0].status, T5.offers[0].lines.map(lineRow)], ['URETIMDE', 'GONDERILDI', [['CAM', 1, '20', '50', false, true]]]);
  [a] = await alertOf(r.compensationId);
  assert.deepEqual([a.details.tier, a.details.mode, a.details.normal, a.details.price, a.createdById], ['CUSTOMER', 'CUSTOM', 40, 50, U.admin.id]);
  const c5 = await compOf(r.compensationId);
  assert.deepEqual([c5.priceTier, c5.priceMode, c5.unitCost.toString(), c5.offerPrice.toString(), c5.normalPrice.toString()], ['CUSTOMER', 'CUSTOM', '20', '50', '40']);
  // İşlemi yapan yöneticiye kendi işlemi bildirilmez; öteki yöneticiye BİR bildirim
  assert.deepEqual((await noticesOf(r.compensationId)).map((x) => [x.type, x.userId]), [['COMPENSATION_CUSTOM', U.admin2.id]]);
  // Yönetici bedelsiz ve yönetici aynı fiyat: doğrudan müşteriye
  r = await create({ orderId: S.id, lineId: lineG2.id, quantity: 4, mode: 'FREE', dest: newOn(N1), actor: act(U.admin) });
  let t = await load(r.destOrderId);
  assert.deepEqual([t.orderNo, t.status, t.offers[0].status, t.offers[0].lines.map(lineRow)], ['ABC124-T6', 'URETIMDE', 'GONDERILDI', [['CAM', 4, '20', '0', true, true]]]);
  r = await create({ orderId: S.id, lineId: lineG2.id, quantity: 1, mode: 'NORMAL', dest: newOn(N1), actor: act(U.admin) });
  t = await load(r.destOrderId);
  assert.deepEqual([t.orderNo, t.status, t.offers[0].status, t.offers[0].lines.map(lineRow)], ['ABC124-T7', 'URETIMDE', 'GONDERILDI', [['CAM', 1, '20', '40', false, true]]]);
  // Bu testte açılan yedi telafinin her biri "Önemli kararlar"a tam BİR kayıt düşürdü
  assert.equal((await alerts('COMPENSATION_PRICE')).length, priceAlerts + 7);
  assert.equal(await db.adminAlert.count({ where: { type: 'COMPENSATION_PENDING' } }), 0);

  // --- Telafinin telafisi + KAYNAK ADEDİ (karar 157): kaynak ABC124-T2 TEMİZ bir sipariştir (yüklenmedi, belgesi yok) →
  // 2 camından 1'i BEDELLİ (aynı fiyat) telafi edilince ana siparişte 1 cam kalır (teklifin yeni sürümü; eski sürüm
  // değişmez). Yeni sipariş numarası KÖK siparişten (ABC124-T8), kök ilişkisiyle.
  const t2Before = await load(T2.id);
  assert.deepEqual(await comp.sourceState(db, T2.id), { ok: true });
  r = await create({ orderId: T2.id, lineId: t2Before.offers[0].lines[0].id, quantity: 1, mode: 'NORMAL', dest: newOn(N1), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.source], [true, REDUCED(2, 1)]);
  const T8 = await load(r.destOrderId);
  assert.deepEqual([T8.orderNo, T8.compSeq, T8.compOfId, T8.customerOrderNo, (await compOf(r.compensationId)).sourceOrderId], ['ABC124-T8', 8, S.id, 124, T2.id]);
  const t2After = await load(T2.id);
  assert.deepEqual([t2After.offers.length, t2After.offers[0].status, t2After.version, t2After.status], [2, 'GONDERILDI', t2Before.version + 1, 'URETIMDE']);
  assert.equal(JSON.stringify(t2After.offers[1]), JSON.stringify(t2Before.offers[0]), 'müşteriye gitmiş eski sürüm değişmez');
  // TELAFİ işareti ve fiyatlar yeni sürüme taşınır; müşteri tutarı kalan 1 cam: 2 m² × 66,96
  assert.deepEqual(t2After.offers[0].lines.map(lineRow), [['CAM', 1, '30', '66.96', false, true]]);
  assert.deepEqual([t2After.offers[0].offerAmount.toString(), (await db.price.findUniqueOrThrow({ where: { orderId: T2.id } })).amount.toString()], ['133.92', '133.92']);
  // Bedelli telafide kaynakta cam kalmayacaksa telafi açılmaz (siparişin bütün camı telafi edilemez) — hiçbir kayıt oluşmaz
  counts = await stable();
  assert.deepEqual(await create({ orderId: T2.id, lineId: t2After.offers[0].lines[0].id, quantity: 1, mode: 'NORMAL', dest: newOn(N1), actor: act(U.sales) }), { ok: false, code: 'SOURCE_EMPTY' });
  // Bayat form: eski sürümün satırıyla gelen istek aynı camı ikinci kez düşemez
  assert.deepEqual(await create({ orderId: T2.id, lineId: t2Before.offers[0].lines[0].id, quantity: 1, mode: 'FREE', dest: newOn(N1), actor: act(U.sales) }), { ok: false, code: 'CONFLICT' });
  assert.deepEqual(await stable(), counts);
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
  // Yinelenen istek bildirim de çoğaltmaz: her telafi siparişi için olağan iki olay (teklif müşteride, üretime geçti) BİR kez
  const outbox = await db.notificationOutbox.groupBy({ by: ['orderId', 'type'], where: { order: { compOfId: S2.id } }, _count: true });
  // (+ yönetici e-postası olayı yalnızca müşteri fiyatı değişen telafide — karar 218: dört "aynı fiyat" telafisinde yok,
  // bedelsiz telafide BİR tane; üç kez gönderilen form ikinci olay yazmaz)
  assert.deepEqual(outbox.map((o) => [o.type, o._count]).sort(), [[ADMIN_MAIL, 1], ...Array(5).fill(['ORDER_OFFER_SENT', 1]), ...Array(5).fill(['ORDER_PRODUCTION', 1])]);
  assert.deepEqual(outbox.filter((o) => o.type === ADMIN_MAIL).map((o) => o.orderId), [dup[0].destOrderId]);
  // "Önemli kararlar": telafi başına BİR kayıt; yöneticiye telafi başına, kişi başına BİR bildirim (yinelenen istek çoğaltmaz)
  assert.equal(await db.adminAlert.count({ where: { orderId: S2.id, type: 'COMPENSATION_PRICE' } }), 5);
  const ids = [...new Set([...rs, ...dup].map((r) => r.compensationId))];
  assert.equal(ids.length, 5);
  for (const id of ids) {
    assert.equal((await alertOf(id)).length, 1, 'telafi başına tek karar kaydı');
    assert.deepEqual((await noticesOf(id)).map((x) => x.userId).sort(), [U.admin.id, U.admin2.id].sort(), 'telafi başına, yönetici başına tek bildirim');
  }
  // Yüklenmiş kaynağın (ABC200) teklifi hiçbir telafide değişmedi
  assert.equal((await load(S2.id)).offers.length, 1);
});

dbTest('hedef: müşterinin ileri tarihli siparişi — taslak teklife eklenir; müşterideki teklifte bedelsiz / aynı fiyat yeni sürümle hemen gider (satış da); satışın "farklı fiyat" kararı yöneticinin onayını bekler', async () => {
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
  // Proformalı sipariş hedef OLABİLİR (karar 256: yalnızca nihai fatura engeldir); nihai faturalı sipariş olamaz
  const invoiced = await order(A, 155, F1, [glassLine(1)]);
  await db.fgoDocument.create({ data: { orderId: invoiced.id, kind: 'INVOICE', series: 'GKH', number: '9010', issuedAt: new Date() } });
  const list2 = await comp.compensationDestinations(db, { source: { id: S.id, customerId: A.id, currency: 'EUR' } });
  const of2 = (o) => list2.find((x) => x.id === o.id);
  assert.deepEqual([of(onHold).reason, of(fresh).reason, of(ron).reason, of(billed).reason, of(billed).via], ['ON_HOLD', 'NO_OFFER', 'CURRENCY', null, 'SENT']);
  assert.deepEqual([of2(invoiced).reason, of2(invoiced).via], ['FINAL_INVOICE', null]);
  assert.equal(of(today), undefined, 'bugünün siparişi ileri tarihli değil');
  assert.ok(!list.some((x) => x.id === BF.id || x.id === S.id), 'başka müşterinin siparişi ve kaynağın kendisi listede yok');
  assert.ok(list.some((x) => x.orderNo === 'ABC124-T'), 'telafi siparişi de olağan bir sipariştir');
  // Başka müşterinin ileri tarihli siparişi yok: liste boş; yeni telafi siparişi yine açılır (OTH7-T)
  assert.deepEqual(await comp.compensationDestinations(db, { source: { id: BF.id, customerId: B.id, currency: 'EUR' } }), []);
  for (const [o, code] of [[onHold, 'DEST_ON_HOLD'], [fresh, 'DEST_NO_OFFER'], [ron, 'DEST_CURRENCY'], [invoiced, 'DEST_FINAL_INVOICE'], [today, 'DEST_NOT_FUTURE'], [S, 'DEST_SAME_ORDER']]) {
    assert.deepEqual(await create({ orderId: S.id, lineId: lineG1.id, quantity: 1, dest: into(o), actor: act(U.admin) }), { ok: false, code }, code);
  }
  // Proformalı hedefe bedelsiz telafi eklenir (teklifin yeni sürümü müşteride); kesilmiş proforma DEĞİŞMEZ
  const billedDoc = JSON.stringify(await db.fgoDocument.findMany({ where: { orderId: billed.id } }));
  const intoBilled = await create({ orderId: S.id, lineId: lineG1.id, quantity: 1, mode: 'FREE', dest: into(billed), actor: act(U.admin) });
  assert.deepEqual([intoBilled.ok, intoBilled.status, intoBilled.via, intoBilled.direct, intoBilled.source], [true, 'APPLIED', 'SENT', true, NOT_REDUCED('FREE')]);
  assert.deepEqual((await load(billed.id)).offers[0].lines.map(lineRow), [['CAM', 1, '30', '66.96', false, false], ['CAM', 1, '30', '0', true, true]]);
  assert.equal(JSON.stringify(await db.fgoDocument.findMany({ where: { orderId: billed.id } })), billedDoc, 'proforma kaydı değişmez');

  // --- Taslak teklif (satışta): satış bedelsiz telafi ekler → satırlar taslağa eklenir, sürüm artar, müşteriye hiçbir şey gitmez
  let r = await create({ orderId: S.id, lineId: lineOp.id, quantity: 1, mode: 'FREE', dest: into(D1), actor: act(U.sales) });
  // direct false: satırlar henüz gönderilmemiş teklife eklendi — müşteriye teklifin olağan akışıyla (yönetici onayı) gider
  assert.deepEqual([r.ok, r.status, r.destOrderNo, r.created, r.via, r.direct, r.source], [true, 'APPLIED', 'ABC131', false, 'DRAFT', false, NOT_REDUCED('FREE')]);
  assert.deepEqual((await alertOf(r.compensationId)).map((a) => [a.type, a.details.mode, a.details.direct]), [['COMPENSATION_PRICE', 'FREE', false]]);
  let d = await load(D1.id);
  assert.deepEqual([d.offers.length, d.offers[0].status, d.version], [1, 'HAZIRLANIYOR', D1.version + 1]);
  assert.deepEqual(d.offers[0].lines.map(lineRow), [['CAM', 5, '30', '66.96', false, false], ['CAM', 1, '30', '0', true, true], ['CNC', 1, '5', '0', true, true], ['DELIK', 2, '2', '0', true, true]]);
  assert.equal(d.offers[0].amount.toString(), '300', 'taslağın satış tutarı yeniden hesaplanır (5 cam × 2 m² × 30; bedelsiz satırlar 0)');
  assert.equal(await db.notificationOutbox.count({ where: { orderId: D1.id, type: { not: ADMIN_MAIL } } }), 0);
  assert.equal(await db.notificationOutbox.count({ where: { orderId: D1.id, type: ADMIN_MAIL } }), 1, 'bedelsiz: yöneticiye bir e-posta olayı (karar 218)');
  assert.deepEqual([(await compOf(r.compensationId)).destType, (await compOf(r.compensationId)).loadingDay.toISOString().slice(0, 10)], ['EXISTING', F1]);
  assert.ok((await events(D1.id)).includes('COMPENSATION_ADDED'));
  // Olağan akış: satış taslağı kaydeder (form bedelsiz satırın fiyatını 0 gönderir) → TELAFİ işareti ve fabrika maliyeti korunur
  await runOrderAction(db, { orderId: D1.id, action: 'save_offer', actor: act(U.sales), payload: { lines: formLines(d.offers[0].lines, false) } });
  d = await load(D1.id);
  assert.deepEqual(d.offers[0].lines.map(lineRow), [['CAM', 5, '30', '66.96', false, false], ['CAM', 1, '30', '0', true, true], ['CNC', 1, '5', '0', true, true], ['DELIK', 2, '2', '0', true, true]]);

  // --- Müşterideki teklif + YÖNETİCİ: teklifin yeni sürümü (eski sürüm değişmez), müşteri "teklif güncellendi" görür
  const prev = JSON.stringify(F.offers[0]);
  r = await create({ orderId: S.id, lineId: lineG2.id, quantity: 2, dest: into(F), actor: act(U.admin) });
  assert.deepEqual([r.ok, r.status, r.via], [true, 'APPLIED', 'SENT']);
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

  // --- Müşterideki teklif + SATIŞ, BEDELSİZ: teklifin yeni sürümü yöneticiye uğramadan müşteriye gider (karar 157)
  const pendingAlerts = (await alerts('COMPENSATION_PENDING')).length;
  r = await create({ orderId: S.id, lineId: lineG1.id, quantity: 1, mode: 'FREE', dest: into(F), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.destOrderNo, r.via, r.direct], [true, 'APPLIED', 'ABC138', 'SENT', true]);
  f = await load(F.id);
  assert.deepEqual([f.offers.length, f.offers[0].status, f.offers[0].createdById, f.offers[0].lines.map(lineRow).at(-1)], [4, 'GONDERILDI', U.sales.id, ['CAM', 1, '30', '0', true, true]]);
  // Bedelsiz satır müşteri tutarını değiştirmez: 689,60 (önceki sürümle aynı)
  assert.deepEqual([f.offers[0].offerAmount.toString(), (await db.price.findUniqueOrThrow({ where: { orderId: F.id } })).amount.toString()], ['689.6', '689.6']);
  let found = await alertOf(r.compensationId);
  assert.deepEqual([found.length, found[0].type, found[0].orderId, found[0].details.mode, found[0].details.direct], [1, 'COMPENSATION_PRICE', S.id, 'FREE', true]);
  assert.deepEqual((await noticesOf(r.compensationId)).map((x) => x.link), [`/siparisler/${F.id}#kararlar`, `/siparisler/${F.id}#kararlar`]);
  // --- SATIŞ, AYNI FİYAT (işlemli tek cam): kaynaktaki fiyatlarla hemen gider; işlem fiyatları da kaynaktaki gibi (karar 251)
  r = await create({ orderId: S.id, lineId: lineOp.id, quantity: 1, dest: into(F), actor: act(U.sales) });
  assert.deepEqual([r.status, r.via, r.direct], ['APPLIED', 'SENT', true]);
  f = await load(F.id);
  assert.equal(f.offers.length, 5);
  assert.deepEqual(f.offers[0].lines.map(lineRow).slice(-3), [['CAM', 1, '30', '66.96', false, true], ['CNC', 1, '5', '8', false, true], ['DELIK', 2, '2', '3', false, true]]);
  // müşteri tutarı: 689,60 + 2 m² × 66,96 + 8 + 2 × 3 = 837,52
  assert.equal(f.offers[0].offerAmount.toString(), '837.52');
  // --- SATIŞ, FARKLI FİYAT (karar 251): satış fiyatı girilir, müşteri fiyatı kaynağınki — teklifin yeni sürümü hemen gider
  r = await create({ orderId: S.id, lineId: lineOp.id, quantity: 1, mode: 'CUSTOM', price: '35', dest: into(F), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.destOrderNo, r.via, r.direct], [true, 'APPLIED', 'ABC138', 'SENT', true]);
  f = await load(F.id);
  assert.equal(f.offers.length, 6);
  assert.deepEqual(f.offers[0].lines.map(lineRow).slice(-3), [['CAM', 1, '35', '66.96', false, true], ['CNC', 1, '5', '8', false, true], ['DELIK', 2, '2', '3', false, true]]);
  assert.equal(f.offers[0].offerAmount.toString(), '985.44');
  found = await alertOf(r.compensationId);
  assert.deepEqual([found.length, found[0].type, found[0].details.mode, found[0].details.tier, found[0].details.direct], [1, 'COMPENSATION_PRICE', 'CUSTOM', 'SALES', true]);
  assert.equal((await alerts('COMPENSATION_PENDING')).length, pendingAlerts, 'bedelsiz / aynı fiyat / farklı fiyat yönetici onayı beklemez');

  // --- Müşterideki teklif + SATIŞ + kaynakta müşteri fiyatı YOK (eski kayıt): kesin müşteri fiyatı yoktur → karar yöneticinin
  // onayını bekler (yönetici müşteri fiyatını girer)
  const SU = await order(A, 127, OLD, [glassLine(3, { offerPrice: null }), glassLine(1, { offerPrice: null }), cncLine(1), holeLine(2)], { status: 'YUKLENDI' });
  const [lineU, lineUOp] = SU.offers[0].lines;
  r = await create({ orderId: SU.id, lineId: lineU.id, quantity: 1, mode: 'CUSTOM', price: '35', dest: into(F), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.destOrderNo, r.via, r.direct], [true, 'PENDING', 'ABC138', 'SENT', false]);
  assert.equal((await load(F.id)).offers.length, 6, 'onay beklerken teklif değişmez');
  assert.equal(await db.offerLine.count({ where: { compensationId: r.compensationId } }), 0);
  // Bekleyen karar TEK kayıttır ("fiyat kararı" kaydı ayrıca açılmaz); yöneticiye tek bildirim
  found = await alertOf(r.compensationId);
  let [pend] = found;
  assert.deepEqual([found.length, pend.type, pend.orderId, pend.details.compensationId, pend.details.mode, pend.details.tier, pend.details.price, pend.resolvedAt], [1, 'COMPENSATION_PENDING', F.id, r.compensationId, 'CUSTOM', 'SALES', 35, null]);
  const pn = await noticesOf(r.compensationId);
  assert.deepEqual(pn.map((x) => [x.type, x.userId]).sort(), [['COMPENSATION_PENDING', U.admin.id], ['COMPENSATION_PENDING', U.admin2.id]].sort(), 'yalnızca yöneticilere');
  assert.deepEqual([pn[0].link, pn[0].params.qty, pn[0].params.ref], [`/siparisler/${F.id}#kararlar`, 1, 'ABC127']);
  assert.ok((await events(F.id)).includes('COMPENSATION_PENDING'));
  // Kararı yalnızca yönetici verir (müşteri, çizim, denetimci ve satış fiyat kararını değiştiremez)
  for (const u of [U.sales, U.custA, U.drawer, U.inspector]) assert.deepEqual(await comp.decideCompensation(db, { id: r.compensationId, approve: true, price: '10', actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, u.appRole);
  assert.deepEqual(await comp.decideCompensation(db, { id: r.compensationId, approve: false, note: 'Müşteri hatası', actor: act(U.admin2) }), { ok: true, status: 'REJECTED', destOrderId: F.id, sourceOrderId: SU.id });
  const rej = await compOf(r.compensationId);
  assert.deepEqual([rej.status, rej.decidedById, rej.decisionNote], ['REJECTED', U.admin2.id, 'Müşteri hatası']);
  [pend] = await alertOf(r.compensationId);
  assert.ok(pend.resolvedAt instanceof Date);
  assert.equal((await load(F.id)).offers.length, 6, 'ret: teklif değişmez');
  assert.deepEqual(await comp.decideCompensation(db, { id: r.compensationId, approve: true, actor: act(U.admin) }), { ok: false, code: 'NOT_PENDING' });

  // Yönetici onaylarken MÜŞTERİ FİYATINI girer (ayrı bir fiyat sistemi yok); fiyatsız onaylanamaz; satışın satış fiyatı durur
  r = await create({ orderId: SU.id, lineId: lineU.id, quantity: 1, mode: 'CUSTOM', price: '35', dest: into(F), actor: act(U.sales) });
  assert.equal(r.status, 'PENDING');
  assert.deepEqual(await comp.decideCompensation(db, { id: r.compensationId, approve: true, actor: act(U.admin) }), { ok: false, code: 'PRICE_REQUIRED' });
  assert.deepEqual([(await compOf(r.compensationId)).status, (await load(F.id)).offers.length], ['PENDING', 6]);
  assert.deepEqual(await comp.decideCompensation(db, { id: r.compensationId, approve: true, price: '45', actor: act(U.admin) }), { ok: true, status: 'APPLIED', destOrderId: F.id, sourceOrderId: SU.id, source: NOT_REDUCED('CLOSED') });
  f = await load(F.id);
  assert.deepEqual([f.offers.length, f.offers[0].lines.map(lineRow).at(-1)], [7, ['CAM', 1, '35', '45', false, true]]);
  let done = await compOf(r.compensationId);
  assert.deepEqual([done.status, done.priceMode, done.free, done.offerPrice.toString(), done.unitCost.toString(), done.decidedById], ['APPLIED', 'CUSTOM', false, '45', '35', U.admin.id]);
  // Yönetici bekleyen kararı bedelsiz de yapabilir (işlemli tek cam): cam 0, işlemler 0, maliyetler durur
  r = await create({ orderId: SU.id, lineId: lineUOp.id, quantity: 1, mode: 'CUSTOM', price: '36', dest: into(F), actor: act(U.sales) });
  assert.equal(r.status, 'PENDING');
  assert.equal((await comp.decideCompensation(db, { id: r.compensationId, approve: true, free: true, actor: act(U.admin) })).status, 'APPLIED');
  f = await load(F.id);
  assert.deepEqual([f.offers.length, f.offers[0].lines.map(lineRow).slice(-3)], [8, [['CAM', 1, '36', '0', true, true], ['CNC', 1, '5', '0', true, true], ['DELIK', 2, '2', '0', true, true]]]);
  done = await compOf(r.compensationId);
  assert.deepEqual([done.status, done.free, done.offerPrice.toString()], ['APPLIED', true, '0']);
  assert.equal((await alerts('COMPENSATION_PENDING')).filter((x) => !x.resolvedAt).length, 0);
  const applied = await db.auditLog.findFirstOrThrow({ where: { action: 'COMPENSATION_APPLIED', details: { path: ['compensationId'], equals: r.compensationId } } });
  // Yönetici kararı bedelsiz yaptı: kaynak adedi değişmez (karar 256 — nedeni FREE)
  assert.deepEqual([applied.userId, applied.entityId, applied.details.quantity, applied.details.priceMode, applied.details.free, applied.details.offerPrice, applied.details.normalPrice, applied.details.source], [U.admin.id, SU.id, 1, 'CUSTOM', true, 0, null, { ...NOT_REDUCED('FREE'), offerId: null }]);
  assert.ok(await db.auditLog.findFirst({ where: { action: 'COMPENSATION_REJECTED', entityId: SU.id } }));

  // İleri tarihli siparişi olmayan müşteri: yeni ileri gün seçilir → OTH7-T. Kaynak (OTH7) temiz ama telafi BEDELSİZ:
  // 3 camı aynen kalır (karar 256 — bedelsiz telafi ayrı ek üretimdir)
  r = await create({ orderId: BF.id, lineId: BF.offers[0].lines[0].id, quantity: 1, mode: 'FREE', dest: newOn(F2), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.destOrderNo, r.source], [true, 'OTH7-T', NOT_REDUCED('FREE')]);
  assert.equal((await load(r.destOrderId)).customerId, B.id);
  assert.deepEqual((await load(BF.id)).offers.map((o) => o.lines.map((l) => [l.kind, l.adet])), [[['CAM', 3]]], 'kaynak teklifin yeni sürümü açılmadı');
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

dbTest('olağan akış: bedelsiz telafi siparişi yüklenir; kârlılıkta satış 0, fabrika maliyeti gerçek; bedelsiz telafi ve telafi işlemleri proformaya / faturaya girmez', async () => {
  const T = await db.order.findUniqueOrThrow({ where: { orderNo: 'ABC124-T' }, include: FULL });
  // Bedelsiz telafinin teklifi zaten müşteride ve sipariş üretimde (yönetici yeniden fiyatlandırmadı); maliyet satırlarda durur
  const sent = await load(T.id);
  assert.deepEqual([sent.status, sent.offers.length, sent.offers[0].status], ['URETIMDE', 1, 'GONDERILDI']);
  assert.deepEqual(sent.offers[0].lines.map(lineRow), [['CAM', 1, '30', '0', true, true], ['CNC', 1, '5', '0', true, true], ['DELIK', 2, '2', '0', true, true]]);
  // Müşteri proforması önizlemesi (FGO'ya gidecek satırların hesabı — hiçbir şey yazmaz, FGO'ya istek atmaz), N1 günü:
  //   · bedelsiz telafi siparişleri belgeye GİRMEZ (yazılacak satırı yok)
  //   · aynı fiyatlı telafide taşınan işlemler kaynaktaki fiyatlarıyla belgeye girer (karar 251; proformada ayrı satır)
  const pa = await b.previewBatch(db, { customerId: A.id, days: [N1], bnrImpl: bnr });
  const inc = (no) => pa.included.find((x) => x.orderNo === no);
  const exc = (no) => pa.excluded.find((x) => x.orderNo === no);
  assert.deepEqual([inc('ABC124-T'), exc('ABC124-T').reason], [undefined, 'NO_PRICES'], 'bedelsiz telafi (işlemli) proformaya girmez');
  assert.deepEqual([inc('ABC124-T6'), exc('ABC124-T6').reason], [undefined, 'NO_PRICES'], 'bedelsiz telafi proformaya girmez');
  assert.deepEqual(inc('ABC124-T3').lines.map((l) => [l.name, l.qty, l.price, l.amount]), [
    ['Comanda ABC124-T3 — Sticlă laminată 44.2', 2, 66.96, 133.92], ['Comanda ABC124-T3 — Prelucrare CNC', 1, 8, 8], ['Comanda ABC124-T3 — Gaură', 2, 3, 6],
  ]);
  assert.deepEqual([inc('ABC124-T3').subtotal, exc('ABC124-T3')], [147.92, undefined]);
  // Satışın farklı fiyatı (satış kademesi): müşteri belgesi müşteri fiyatıyla — yönetici sonradan 60'a güncelledi; işlemler kaynak fiyatıyla
  assert.deepEqual(inc('ABC124-T4').lines.map((l) => [l.qty, l.price, l.amount]), [[2, 60, 120], [1, 8, 8], [2, 3, 6]]);
  // Kaynakta müşteri fiyatı olmayan telafiyi yönetici fiyat onayında fiyatlandırdı (55)
  assert.deepEqual(inc('ABC126-T').lines.map((l) => [l.qty, l.price, l.amount]), [[2, 55, 110]]);
  // Yöneticinin farklı fiyatı (50) doğrudan müşteride: belgeye girer
  assert.deepEqual(inc('ABC124-T5').lines.map((l) => [l.qty, l.price, l.amount]), [[0.25, 50, 12.5]]);
  // Belgeye giren hiçbir satır 0 fiyatlı değil (bedelsiz satır yazılmaz)
  const allLines = pa.included.flatMap((o) => o.lines);
  assert.ok(allLines.length > 0 && allLines.every((l) => l.price > 0 && l.amount > 0));
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

dbTest('özel durum sandığı: firmayı yalnızca yönetici seçer, sandığı satış; telafi siparişi başka müşterinin sandığında gider, ticari sahiplik değişmez', async () => {
  const T2 = await db.order.findUniqueOrThrow({ where: { orderNo: 'ABC124-T2' } });
  await cr.saveDayCrates(db, { day: N1, customerId: B.id, rows: [{ crateNo: 15, lengthMm: 2400, widthMm: 1600, heightMm: 900, netKg: 190, grossKg: 260, note: null, orderIds: [BF.id] }], actor: act(U.sales) });
  const crate = await db.crate.findFirstOrThrow({ where: { shipDay: date(N1), customerId: B.id } });
  // Karar 124: ev sahibi FİRMAYI yalnızca yönetici seçer; firma seçilmeden kimse sandık seçemez
  for (const u of [U.drawer, U.inspector, U.custA, U.custB]) {
    assert.deepEqual(await cr.assignGuestCrate(db, { day: N1, orderId: T2.id, crateId: crate.id, actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, u.appRole);
  }
  for (const u of [U.sales, U.admin]) assert.deepEqual(await cr.assignGuestCrate(db, { day: N1, orderId: T2.id, crateId: crate.id, actor: act(u) }), { ok: false, code: 'NO_HOST' }, u.appRole);
  for (const u of [U.sales, U.drawer, U.inspector, U.custA, U.custB]) {
    assert.deepEqual(await cr.setGuestHost(db, { orderId: T2.id, hostId: B.id, actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, u.appRole);
  }
  assert.equal(await db.crateOrder.count({ where: { orderId: T2.id } }), 0);
  assert.deepEqual(await cr.setGuestHost(db, { orderId: T2.id, hostId: B.id, actor: act(U.admin) }), { ok: true, changed: true, hostId: B.id });
  // Sandığı satış seçer (yöneticinin seçtiği firmanın, aynı günün sandığı); sandık seçimini çizim / denetimci / müşteri kaldıramaz
  assert.deepEqual(await cr.assignGuestCrate(db, { day: N1, orderId: T2.id, crateId: crate.id, actor: act(U.sales) }), { ok: true, crateNo: 15 });
  for (const u of [U.drawer, U.inspector, U.custA, U.custB]) assert.deepEqual(await cr.removeGuestCrate(db, { orderId: T2.id, crateId: crate.id, actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, u.appRole);
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
  assert.deepEqual([audit.details.ownerCustomerId, audit.details.hostCustomerId, audit.userId], [A.id, B.id, U.sales.id]);
  const hostAudit = await db.auditLog.findFirstOrThrow({ where: { action: 'CROSS_CUSTOMER_HOST_SET', entityId: T2.id } });
  assert.deepEqual([hostAudit.details.ownerCustomerId, hostAudit.details.hostCustomerId, hostAudit.userId], [A.id, B.id, U.admin.id]);
  // Ev sahibi müşteri misafir siparişi göremez (müşteri yalıtımı)
  assert.deepEqual([await visibleTo(U.custB, T2.id), await visibleTo(U.custA, T2.id)], [0, 1]);
});

dbTest('siparişi sil / geri yükle (iki aşamalı — fonksiyonel paket 4): yalnızca yönetici; mali / operasyonel geçmişi olan sipariş silinmez; silinen sipariş olağan ekranlardan kalkar, kayıtlar durur; geri yükleme hiçbir şeyi çoğaltmaz', async () => {
  // R: X gününde yüklendi (onaylı yükleme kalemleri var), FGO belgesi ve çizimi var — silinemez
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

  // Yalnızca yönetici (satış dahil hiçbir rol silemez / geri yükleyemez); ikinci adımın onayı sipariş numarasıdır
  for (const u of [U.sales, U.drawer, U.inspector, U.custA]) {
    assert.deepEqual(await rm.removeOrder(db, { orderId: R.id, confirmNo: 'ABC400', actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, u.appRole);
  }
  for (const confirmNo of ['', null, 'ABC401']) assert.deepEqual(await rm.removeOrder(db, { orderId: R.id, confirmNo, actor: act(U.admin) }), { ok: false, code: 'CONFIRM_REQUIRED' }, String(confirmNo));
  assert.deepEqual(await rm.removeOrder(db, { orderId: 'yok', confirmNo: 'ABC400', actor: act(U.admin) }), { ok: false, code: 'NOT_FOUND' });
  // Mali / operasyonel geçmiş (FGO belgesi, onaylı yükleme): silinmez — nedenler döner, deneme denetime yazılır
  const reasons = [{ code: 'FGO_DOCUMENT', kind: 'PROFORMA', ref: 'PRF9100' }, { code: 'CONFIRMED_LOADING', ref: X }];
  assert.deepEqual((await rm.removalPreview(db, R.id)).reasons, reasons);
  assert.deepEqual(await rm.removeOrder(db, { orderId: R.id, confirmNo: 'ABC400', actor: act(U.admin) }), { ok: false, code: 'LOCKED', reasons });
  assert.equal((await load(R.id)).removedAt, null);
  assert.deepEqual(await counts(R.id), before);
  const blocked = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_REMOVE_BLOCKED', entityId: R.id } });
  assert.deepEqual([blocked.userId, blocked.details.orderNo, blocked.details.reasons], [U.admin.id, 'ABC400', reasons]);
  // Kuyrukta bekleyen FGO belgesi varken silinmez (silme FGO'da hiçbir işlem yapmaz / işi düşürmez)
  const job = await db.notificationOutbox.create({ data: { type: 'FGO_GLASS', orderId: R2.id, payload: { kind: 'PROFORMA' } } });
  assert.deepEqual(await rm.removeOrder(db, { orderId: R2.id, confirmNo: 'ABC401', actor: act(U.admin) }), { ok: false, code: 'BUSY' });
  await db.notificationOutbox.delete({ where: { id: job.id } });

  // --- Sil (R2: ileri tarihli, belgesi / onaylı yüklemesi yok): önizlemedeki sürüm + yazılan numara (harf farkı yok sayılır)
  const before2 = await counts(R2.id);
  const preview = await rm.removalPreview(db, R2.id);
  assert.deepEqual([preview.orderNo, preview.busy, preview.reasons], ['ABC401', false, []]);
  assert.deepEqual(await rm.removeOrder(db, { orderId: R2.id, confirmNo: 'ABC401', expectedVersion: preview.version + 1, actor: act(U.admin) }), { ok: false, code: 'STALE' });
  const daysBefore = (await b.customerLoadingDays(db, { customerId: A.id })).find((x) => x.day === F1);
  assert.deepEqual(await rm.removeOrder(db, { orderId: R2.id, confirmNo: ' abc401 ', expectedVersion: preview.version, actor: act(U.admin) }), { ok: true, orderNo: 'ABC401' });
  const gone = await load(R2.id);
  assert.deepEqual([gone.removedAt instanceof Date, gone.removedById, gone.removedStatus, gone.status, gone.version], [true, U.admin.id, 'URETIMDE', 'IPTAL', preview.version + 1]);
  assert.deepEqual(await rm.removeOrder(db, { orderId: R2.id, confirmNo: 'ABC401', actor: act(U.admin) }), { ok: false, code: 'ALREADY_REMOVED' });
  // Olağan ekranlardan kalkar: hiçbir rolün sipariş kapsamında yok (liste, arama, sipariş sayfası, dosyalar, işlemler)
  for (const u of Object.values(U)) assert.equal(await visibleTo(u, R2.id), 0, u.appRole);
  await assert.rejects(runOrderAction(db, { orderId: R2.id, action: 'set_ship_date', actor: act(U.admin), payload: { date: at(F2) } }), /NOT_FOUND/);
  assert.deepEqual(await create({ orderId: R2.id, lineId: R2.offers[0].lines[0].id, quantity: 1, dest: newOn(N1), actor: act(U.admin) }), { ok: false, code: 'NOT_FOUND' });
  // Yükleme planı, müşteri proforması ve telafi hedefleri: silinen ileri tarihli sipariş (ABC401) hiçbirinde yok
  const daysAfter = (await b.customerLoadingDays(db, { customerId: A.id })).find((x) => x.day === F1);
  assert.equal(daysAfter.eligible + daysAfter.excluded, daysBefore.eligible + daysBefore.excluded - 1);
  const pb = await b.previewBatch(db, { customerId: A.id, days: [F1], bnrImpl: bnr });
  assert.ok(![...pb.included, ...pb.excluded].some((x) => x.orderNo === 'ABC401'));
  assert.ok(!(await comp.compensationDestinations(db, { source: { id: S.id, customerId: A.id, currency: 'EUR' } })).some((x) => x.orderNo === 'ABC401'));
  assert.deepEqual(await create({ orderId: S.id, lineId: lineG1.id, quantity: 1, dest: into(R2), actor: act(U.admin) }), { ok: false, code: 'DEST_CLOSED' });
  assert.deepEqual((await rm.removedOrders(db)).map((o) => o.orderNo), ['ABC401']);
  // Kayıtlar durur: teklif, satırlar, bildirimler — hiçbiri silinmedi / değişmedi; denetim + geçmiş yazıldı
  assert.deepEqual(await counts(R2.id), before2);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'ORDER_REMOVED', entityId: R2.id } });
  assert.deepEqual([audit.userId, audit.details.orderNo, audit.details.statusBefore, audit.details.kept.offers], [U.admin.id, 'ABC401', 'URETIMDE', 1]);
  assert.ok((await events(R2.id)).includes('REMOVED'));
  // Onaylı günün kârlılığı (tarihsel kayıt) değişmez: silinemeyen R dahil X gününde onaylanan üç sipariş
  const day = (await supplierData(db, date(dayOf(1)))).days.find((x) => x.day === X);
  assert.equal(day.orders, 3, 'X gününde onaylanan üç sipariş (ABC124, ABC200, ABC400)');

  // --- Geri yükle: yalnızca yönetici; önceki durumuna döner; hiçbir kayıt çoğalmaz
  for (const u of [U.sales, U.drawer, U.inspector, U.custA]) assert.deepEqual(await rm.restoreOrder(db, { orderId: R2.id, actor: act(u) }), { ok: false, code: 'FORBIDDEN' }, u.appRole);
  assert.deepEqual(await rm.restoreOrder(db, { orderId: R2.id, actor: act(U.admin) }), { ok: true, orderNo: 'ABC401', status: 'URETIMDE' });
  const back = await load(R2.id);
  assert.deepEqual([back.removedAt, back.removedById, back.removedStatus, back.status, back.version], [null, null, null, 'URETIMDE', preview.version + 2]);
  assert.deepEqual(await counts(R2.id), before2, 'geri yükleme belge / yükleme / teklif / bildirim / telafi / sipariş çoğaltmaz');
  assert.deepEqual(await rm.restoreOrder(db, { orderId: R2.id, actor: act(U.admin) }), { ok: false, code: 'NOT_REMOVED' });
  assert.deepEqual([await visibleTo(U.admin, R2.id), await visibleTo(U.custA, R2.id), await visibleTo(U.sales, R2.id)], [1, 1, 1]);
  assert.ok((await events(R2.id)).includes('RESTORED'));
  // Yeniden silinir (sonraki testler için silinmiş kalır): geri yüklenen sipariş yine iki aşamayla silinir
  assert.deepEqual(await rm.removeOrder(db, { orderId: R2.id, confirmNo: 'ABC401', expectedVersion: back.version, actor: act(U.admin) }), { ok: true, orderNo: 'ABC401' });
  assert.equal(await db.auditLog.count({ where: { action: { in: ['ORDER_REMOVED', 'ORDER_RESTORED'] } } }), 3);
  assert.ok(await db.auditLog.count() >= audits + 4);
  assert.deepEqual((await rm.removedOrders(db)).map((o) => o.orderNo), ['ABC401']);
  assert.equal((await load(R.id)).removedAt, null, 'belgesi olan sipariş hâlâ yerinde');
});

dbTest('kaynak adedi (karar 157): temiz siparişte 20 cam → 3 telafi → ana siparişte 17; adet, m² ve tutar iki kez sayılmaz; eski teklif sürümü değişmez', async () => {
  // Temiz kaynak: açık (üretimde), yüklemesi onaylanmamış, belgesi yok. 20 işlemsiz cam, AYNI camdan işlemli TEK cam
  // (1 CNC, 2 delik), 4 küçük cam ve sandık parası.
  const C = await order(A, 160, F1, [glassLine(20), glassLine(1), cncLine(1), holeLine(2), glassLine(4, { description: 'Temper 8mm', descriptionRo: 'Securizat 8mm', enMm: 500, boyMm: 500, unitPrice: '20', offerPrice: '40', listPrice: '20' }), crateFee()]);
  const v1 = C.offers[0];
  const start = totals(v1.lines);
  // 20×2 + 1×2 + 4×0,25 = 43 m²; müşteri: 40×66,96 + 133,92 + 8 + 6 + 40 + 30 = 2896,32; satış (maliyet): 1200 + 60 + 5 + 4 + 20 + 25 = 1314
  assert.deepEqual(start, { adet: 25, m2: 43, sale: 2896.32, cost: 1314 });
  assert.deepEqual(await comp.sourceState(db, C.id), { ok: true });

  // --- Satış, AYNI FİYAT: 20 camdan 3'ü yeni telafi siparişine
  let r = await create({ orderId: C.id, lineId: v1.lines[0].id, quantity: 3, dest: newOn(F2), actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.destOrderNo, r.via, r.direct, r.source], [true, 'APPLIED', 'ABC160-T', 'NEW', true, REDUCED(20, 17)]);
  const c1 = await load(C.id);
  // Kaynağın müşterideki teklifinin YENİ sürümü: yalnızca seçilen camın adedi düştü; eski sürüm aynen duruyor
  assert.deepEqual([c1.offers.length, c1.offers[0].status, c1.offers[0].createdById, c1.version, c1.status], [2, 'GONDERILDI', U.sales.id, C.version + 1, 'URETIMDE']);
  assert.equal(JSON.stringify(c1.offers[1]), JSON.stringify(v1), 'müşteriye gitmiş eski sürüm değişmez');
  assert.deepEqual(c1.offers[0].lines.map(lineRow), [
    ['CAM', 17, '30', '66.96', false, false], ['CAM', 1, '30', '66.96', false, false], ['CNC', 1, '5', '8', false, false], ['DELIK', 2, '2', '3', false, false],
    ['CAM', 4, '20', '40', false, false], ['CAM', 1, '25', '30', false, false],
  ]);
  // Yeni sürümün tutarları sunucuda yeniden hesaplandı: müşteri 34×66,96 + 133,92 + 8 + 6 + 40 + 30 = 2494,56; satış 1020 + 114 = 1134
  assert.deepEqual([c1.offers[0].offerAmount.toString(), c1.offers[0].amount.toString(), (await db.price.findUniqueOrThrow({ where: { orderId: C.id } })).amount.toString()], ['2494.56', '1134', '2494.56']);
  const T1 = await load(r.destOrderId);
  assert.deepEqual([T1.status, T1.offers[0].status, T1.offers[0].lines.map(lineRow)], ['URETIMDE', 'GONDERILDI', [['CAM', 3, '30', '66.96', false, true]]]);
  assert.deepEqual([T1.offers[0].offerAmount.toString(), T1.offers[0].amount.toString()], ['401.76', '180']);
  // İKİ KEZ SAYILMAZ: kaynak (sonra) + telafi = kaynak (önce) — cam adedi, m², müşteri tutarı ve satış tutarı
  const [after, tel] = [totals(c1.offers[0].lines), totals(T1.offers[0].lines)];
  assert.deepEqual([after.adet + tel.adet, round2(after.m2 + tel.m2), round2(after.sale + tel.sale), round2(after.cost + tel.cost)], [start.adet, start.m2, start.sale, start.cost]);
  assert.deepEqual([after.adet, tel.adet, after.m2, tel.m2], [22, 3, 37, 6]);
  assert.equal(round2(Number(c1.offers[0].offerAmount) + Number(T1.offers[0].offerAmount)), 2896.32);
  // Müşteri kaynak teklifin güncellendiğini görür (olağan olay); geçmişte adet değişimi yazılıdır (tutar yok)
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: C.id } })).map((o) => o.type), ['ORDER_OFFER_UPDATED']);
  assert.ok((await events(C.id)).includes('OFFER_UPDATED'));
  const ev = await db.orderEvent.findFirstOrThrow({ where: { orderId: C.id, event: 'COMPENSATION' } });
  assert.equal(ev.note, `3 × Temper Lamine 44.2 1000×2000 → ABC160-T / ${dmy(F2)} · 20 → 17`);
  // Telafi kaydı kaynağın karar anındaki sürümünü ve satırını gösterir (değişmez kayıt)
  const row = await compOf(r.compensationId);
  assert.deepEqual([row.sourceOrderId, row.sourceOfferId, row.sourceLineId, row.quantity, row.priceMode, row.offerPrice.toString()], [C.id, v1.id, v1.lines[0].id, 3, 'NORMAL', '66.96']);
  // Denetim kaydı ve "Önemli kararlar": kaynak adedi önce → sonra
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'COMPENSATION_CREATED', details: { path: ['compensationId'], equals: r.compensationId } } });
  assert.deepEqual(
    [audit.userId, audit.entityId, audit.details.sourceOrderNo, audit.details.sourceLineId, audit.details.quantity, audit.details.priceMode, audit.details.normalPrice, audit.details.offerPrice, audit.details.destOrderNo, audit.details.direct, audit.details.source],
    [U.sales.id, C.id, 'ABC160', v1.lines[0].id, 3, 'NORMAL', 66.96, 66.96, 'ABC160-T', true, { ...REDUCED(20, 17), offerId: c1.offers[0].id }],
  );
  const [alert] = await alertOf(r.compensationId);
  assert.deepEqual([alert.type, alert.orderId, alert.details.mode, alert.details.quantity, alert.details.source], ['COMPENSATION_PRICE', C.id, 'NORMAL', 3, REDUCED(20, 17)]);

  // --- Satış, BEDELSİZ (karar 256): işlemli TEK cam. Kaynak teklif DEĞİŞMEZ (yeni sürüm yok, cam ve işlemleri yerinde kalır);
  // telafi ayrı ek üretimdir: cam ve işlemleri telafiye kopyalanır, müşteri fiyatları 0, fabrika maliyeti durur
  const opLine = c1.offers[0].lines[1];
  r = await create({ orderId: C.id, lineId: opLine.id, quantity: 1, mode: 'FREE', dest: newOn(F2), actor: act(U.sales) });
  assert.deepEqual([r.destOrderNo, r.source], ['ABC160-T2', NOT_REDUCED('FREE')]);
  const c2 = await load(C.id);
  assert.equal(JSON.stringify(c2.offers), JSON.stringify(c1.offers), 'bedelsiz telafi kaynak teklifi değiştirmez');
  assert.deepEqual([c2.version, c2.offers.length], [c1.version, 2]);
  assert.deepEqual((await db.notificationOutbox.findMany({ where: { orderId: C.id } })).map((o) => o.type), ['ORDER_OFFER_UPDATED'], 'kaynak için yeni "teklif güncellendi" olayı yok');
  const T2 = await load(r.destOrderId);
  assert.deepEqual(T2.offers[0].lines.map(lineRow), [['CAM', 1, '30', '0', true, true], ['CNC', 1, '5', '0', true, true], ['DELIK', 2, '2', '0', true, true]]);
  assert.deepEqual([T2.offers[0].lines.map((l) => l.sortOrder), new Set(T2.offers[0].lines.map((l) => l.compensationId)).size, T2.offers[0].offerAmount.toString()], [[0, 1, 2], 1, '0']);
  // Ücretli kapsam iki kez sayılmaz (kaynak + bedelli telafi = başlangıç); bedelsiz telafi bunun ÜSTÜNE ayrı, izlenebilir
  // fiziksel üretimdir: 1 cam, 2 m², müşteri tutarı 0, fabrika maliyeti 69
  assert.deepEqual([totals(c2.offers[0].lines).adet + tel.adet, round2(totals(c2.offers[0].lines).m2 + tel.m2), round2(totals(c2.offers[0].lines).sale + tel.sale)], [start.adet, start.m2, start.sale]);
  const costOf = (lines) => totals(lines.map((l) => ({ ...l, free: false }))).cost;
  assert.deepEqual([totals(T2.offers[0].lines).adet, totals(T2.offers[0].lines).m2, totals(T2.offers[0].lines).sale, costOf(T2.offers[0].lines)], [1, 2, 0, 69]);
  assert.equal((await compOf(r.compensationId)).sourceLineId, opLine.id, 'telafi kaydı kaynak satırı izler');
  // Aynı form iki kez gönderilse de (çift tıklama) ikinci telafi / miktar hareketi yok
  const freeKey = key();
  const twice = await Promise.all([1, 2].map(() => comp.createCompensation(db, { orderId: C.id, lineId: c2.offers[0].lines[0].id, quantity: 2, mode: 'FREE', dest: newOn(F2), requestKey: freeKey, confirm: true, actor: act(U.sales) })));
  assert.deepEqual([twice.map((x) => x.duplicate).sort(), new Set(twice.map((x) => x.compensationId)).size], [[false, true], 1]);
  assert.equal(await db.compensation.count({ where: { requestKey: freeKey } }), 1);
  assert.equal(JSON.stringify((await load(C.id)).offers), JSON.stringify(c1.offers), 'kaynak adedi hâlâ 17');

  // --- Bayat form (aynı anda dört istek, hepsi teklifin AYNI sürümündeki satırla): yalnızca biri uygulanır; adet bir kez düşer
  const line17 = c2.offers[0].lines[0];
  const rs = await Promise.all([1, 2, 3, 4].map(() => create({ orderId: C.id, lineId: line17.id, quantity: 1, dest: newOn(F2), actor: act(U.sales) })));
  assert.deepEqual(rs.map((x) => (x.ok ? 'ok' : x.code)).sort(), ['CONFLICT', 'CONFLICT', 'CONFLICT', 'ok']);
  const c3 = await load(C.id);
  assert.deepEqual([c3.offers.length, c3.offers[0].lines[0].adet], [3, 16]);
  assert.equal(await db.compensation.count({ where: { sourceOrderId: C.id } }), 4);

  // --- Var olan siparişe (teklifi müşteride) — yönetici, farklı fiyat 50: hedefin yeni sürümü hemen gider; kaynak 16 → 14
  const E = await order(A, 161, F2, [glassLine(5)]);
  r = await create({ orderId: C.id, lineId: c3.offers[0].lines[0].id, quantity: 2, mode: 'CUSTOM', price: '50', dest: into(E), actor: act(U.admin) });
  assert.deepEqual([r.status, r.via, r.source], ['APPLIED', 'SENT', REDUCED(16, 14)]);
  assert.deepEqual((await load(E.id)).offers[0].lines.map(lineRow), [['CAM', 5, '30', '66.96', false, false], ['CAM', 2, '30', '50', false, true]]);

  // --- Satış, farklı fiyat (karar 251): satış fiyatı girilir, müşteri fiyatı kaynağınki; yönetici onayı beklenmez — kaynak 14 → 10
  let c4 = await load(C.id);
  r = await create({ orderId: C.id, lineId: c4.offers[0].lines[0].id, quantity: 4, mode: 'CUSTOM', price: '35', dest: into(E), actor: act(U.sales) });
  assert.deepEqual([r.status, r.via, r.direct, r.source], ['APPLIED', 'SENT', true, REDUCED(14, 10)]);
  c4 = await load(C.id);
  assert.deepEqual([c4.offers[0].lines[0].adet, (await load(E.id)).offers[0].lines.map(lineRow).at(-1)], [10, ['CAM', 4, '35', '66.96', false, true]]);

  // --- Kaynakta müşteri fiyatı yok (eski kayıt): satışın kararı yöneticinin onayını bekler; kaynak adedi onayla düşer (14 → 10)
  const CU = await order(A, 166, OLD, [glassLine(14, { offerPrice: null })]);
  r = await create({ orderId: CU.id, lineId: CU.offers[0].lines[0].id, quantity: 4, mode: 'CUSTOM', price: '35', dest: into(E), actor: act(U.sales) });
  assert.deepEqual([r.status, r.source], ['PENDING', NOT_REDUCED(null)]);
  assert.deepEqual([(await load(CU.id)).offers.length, (await load(CU.id)).offers[0].lines[0].adet], [1, 14]);
  const decided = await comp.decideCompensation(db, { id: r.compensationId, approve: true, price: '45', actor: act(U.admin) });
  assert.deepEqual(decided, { ok: true, status: 'APPLIED', destOrderId: E.id, sourceOrderId: CU.id, source: REDUCED(14, 10) });
  let cu = await load(CU.id);
  assert.deepEqual([cu.offers[0].lines[0].adet, (await load(E.id)).offers[0].lines.map(lineRow).at(-1)], [10, ['CAM', 4, '35', '45', false, true]]);
  const applied = await db.auditLog.findFirstOrThrow({ where: { action: 'COMPENSATION_APPLIED', details: { path: ['compensationId'], equals: r.compensationId } } });
  assert.deepEqual([applied.details.quantity, applied.details.offerPrice, applied.details.normalPrice, applied.details.source], [4, 45, null, { ...REDUCED(14, 10), offerId: cu.offers[0].id }]);

  // --- Karar beklerken kaynak teklif değişirse (başka bir telafi ya da yöneticinin güncellemesi) adet KENDİLİĞİNDEN düşürülmez
  r = await create({ orderId: CU.id, lineId: cu.offers[0].lines[0].id, quantity: 2, mode: 'CUSTOM', price: '35', dest: into(E), actor: act(U.sales) });
  assert.equal(r.status, 'PENDING');
  const other = await create({ orderId: CU.id, lineId: cu.offers[0].lines[0].id, quantity: 1, mode: 'NORMAL', dest: newOn(F2), actor: act(U.sales) });
  assert.deepEqual(other.source, REDUCED(10, 9));
  assert.deepEqual(await comp.decideCompensation(db, { id: r.compensationId, approve: true, price: '45', actor: act(U.admin) }), { ok: true, status: 'APPLIED', destOrderId: E.id, sourceOrderId: CU.id, source: NOT_REDUCED('CHANGED') });
  cu = await load(CU.id);
  assert.equal(cu.offers[0].lines[0].adet, 9, 'kaynak teklif tahminle değiştirilmez; yönetici gerekirse günceller');
});

dbTest('kaynak adedi yalnızca temiz siparişte düşer: belgeli, belge isteği kuyrukta ve kapalı siparişte teklif değişmez; kaynakta cam kalmıyorsa telafi açılmaz', async () => {
  const unchanged = async (o, reason, p = {}) => {
    const before = JSON.stringify((await load(o.id)).offers);
    assert.deepEqual(await comp.sourceState(db, o.id), { ok: false, reason });
    const r = await create({ orderId: o.id, lineId: o.offers[0].lines[0].id, quantity: 2, dest: newOn(F2), actor: act(U.sales), ...p });
    assert.deepEqual([r.ok, r.status, r.direct, r.source], [true, 'APPLIED', true, NOT_REDUCED(reason)], reason);
    const after = await load(o.id);
    assert.equal(JSON.stringify(after.offers), before, `${reason}: kaynak teklif değişmez`);
    assert.equal(after.version, o.version);
    const [alert] = await alertOf(r.compensationId);
    assert.deepEqual(alert.details.source, NOT_REDUCED(reason));
    // Telafi yine açılır (ek üretim): 2 cam, kendi siparişinde
    assert.deepEqual((await load(r.destOrderId)).offers[0].lines.map((l) => [l.kind, l.adet]), [['CAM', 2]]);
  };
  // FGO belgesi olan sipariş (kesilmiş belge değiştirilemez; storno yok)
  const G = await order(A, 162, F1, [glassLine(6)]);
  await db.fgoDocument.create({ data: { orderId: G.id, kind: 'PROFORMA', series: 'PRF', number: '9200', issuedAt: new Date() } });
  await unchanged(G, 'BILLING');
  // Belge isteği kuyrukta olan sipariş
  const H = await order(A, 163, F1, [glassLine(6)]);
  const job = await db.notificationOutbox.create({ data: { type: 'FGO_GLASS', orderId: H.id, payload: { kind: 'PROFORMA' } } });
  await unchanged(H, 'BILLING', { mode: 'CUSTOM', price: '35' });
  await db.notificationOutbox.delete({ where: { id: job.id } });
  // İstek kalkınca sipariş yeniden temizdir: adet düşer
  assert.deepEqual(await comp.sourceState(db, H.id), { ok: true });
  const r = await create({ orderId: H.id, lineId: H.offers[0].lines[0].id, quantity: 2, dest: newOn(F2), actor: act(U.sales) });
  assert.deepEqual(r.source, REDUCED(6, 4));
  // Kapalı ("Yüklendi") sipariş
  const K = await order(A, 164, F1, [glassLine(6)], { status: 'YUKLENDI' });
  await unchanged(K, 'CLOSED');

  // Kaynakta ölçülü cam kalmıyorsa (siparişin bütün camı) telafi açılmaz — sandık parası cam sayılmaz; hiçbir kayıt oluşmaz
  const M = await order(A, 165, F1, [glassLine(2), crateFee()]);
  const counts = async () => [await db.compensation.count(), await db.order.count(), await db.offer.count(), await db.adminAlert.count(), await db.notification.count(), await db.orderEvent.count()];
  const before = await counts();
  for (const [u, mode] of [[U.sales, 'NORMAL'], [U.sales, 'CUSTOM'], [U.admin, 'NORMAL'], [U.admin, 'CUSTOM']]) {
    assert.deepEqual(await create({ orderId: M.id, lineId: M.offers[0].lines[0].id, quantity: 2, mode, price: mode === 'CUSTOM' ? '35' : null, dest: newOn(F2), actor: act(u) }), { ok: false, code: 'SOURCE_EMPTY' }, `${u.appRole} ${mode}`);
  }
  assert.deepEqual(await counts(), before);
  // Bedelsiz telafi kaynaktan düşmez (karar 256): siparişin bütün camı için de açılabilir; kaynak aynen kalır
  const whole = await create({ orderId: M.id, lineId: M.offers[0].lines[0].id, quantity: 2, mode: 'FREE', dest: newOn(F2), actor: act(U.sales) });
  assert.deepEqual([whole.ok, whole.source], [true, NOT_REDUCED('FREE')]);
  assert.deepEqual((await load(M.id)).offers.map((o) => o.lines.map((l) => [l.description, l.adet])), [[['Temper Lamine 44.2', 2], ['Sandık parası', 1]]]);
  const one = await create({ orderId: M.id, lineId: M.offers[0].lines[0].id, quantity: 1, mode: 'NORMAL', dest: newOn(F2), actor: act(U.sales) });
  assert.deepEqual(one.source, REDUCED(2, 1));
  assert.deepEqual((await load(M.id)).offers[0].lines.map((l) => [l.description, l.adet]), [['Temper Lamine 44.2', 1], ['Sandık parası', 1]]);
});

dbTest('mali engel (karar 256): yalnızca kesilmiş NİHAİ FATURA telafiyi engeller; proforma, avans faturası ve bekleyen belge isteği engellemez; kesilmiş belgeler değişmez', async () => {
  const docsBefore = async () => JSON.stringify(await db.fgoDocument.findMany({ orderBy: { number: 'asc' } }));
  // Proformalı (9301), avans faturalı (9302 + proforma 9304) ve belge isteği kuyrukta olan siparişler: telafi AÇILIR — satış ve
  // yönetici, bedelsiz ve bedelli. Bedelli telafide kaynak adedi belgeli siparişte düşmez (BILLING — mevcut kural), bedelsizde FREE.
  const P1 = await order(A, 170, F1, [glassLine(6)]);
  await db.fgoDocument.create({ data: { orderId: P1.id, kind: 'PROFORMA', series: 'PRF', number: '9301', issuedAt: new Date() } });
  const P2 = await order(A, 171, F1, [glassLine(6)]);
  await db.fgoDocument.create({ data: { orderId: P2.id, kind: 'PROFORMA', series: 'PRF', number: '9304', issuedAt: new Date() } });
  await db.fgoDocument.create({ data: { orderId: P2.id, kind: 'ADVANCE', series: 'GKH', number: '9302', issuedAt: new Date(), advanced: '100.00' } });
  const P3 = await order(A, 172, F1, [glassLine(6)]);
  const job = await db.notificationOutbox.create({ data: { type: 'FGO_GLASS', orderId: P3.id, payload: { kind: 'PROFORMA' } } });
  const docs0 = await docsBefore();
  for (const o of [P1, P2, P3]) {
    assert.deepEqual(await comp.compensationBlock(db, o.id), { blocked: false }, o.orderNo);
    const free = await create({ orderId: o.id, lineId: o.offers[0].lines[0].id, quantity: 1, mode: 'FREE', dest: newOn(F2), actor: act(U.sales) });
    assert.deepEqual([free.ok, free.status, free.source], [true, 'APPLIED', NOT_REDUCED('FREE')], `${o.orderNo} bedelsiz`);
    const paid = await create({ orderId: o.id, lineId: o.offers[0].lines[0].id, quantity: 2, mode: 'NORMAL', dest: newOn(F2), actor: act(U.admin) });
    assert.deepEqual([paid.ok, paid.status, paid.source], [true, 'APPLIED', NOT_REDUCED('BILLING')], `${o.orderNo} bedelli`);
    assert.deepEqual((await load(o.id)).offers.map((x) => x.lines.map((l) => l.adet)), [[6]], `${o.orderNo}: kaynak teklif değişmedi`);
  }
  // Kesilmiş belgeler, kuyruktaki istek ve ödemeler değişmedi / silinmedi
  assert.equal(await docsBefore(), docs0);
  assert.equal((await db.notificationOutbox.findUniqueOrThrow({ where: { id: job.id } })).status, 'PENDING');
  await db.notificationOutbox.delete({ where: { id: job.id } });

  // --- Nihai fatura: (a) siparişin kendi FGO faturası, (b) siparişi kapsayan KESİLMİŞ müşteri / zincir faturası partisi
  const P4 = await order(A, 173, F1, [glassLine(6)]);
  await db.fgoDocument.create({ data: { orderId: P4.id, kind: 'PROFORMA', series: 'PRF', number: '9305', issuedAt: new Date() } });
  await db.fgoDocument.create({ data: { orderId: P4.id, kind: 'INVOICE', series: 'GKH', number: '9303', issuedAt: new Date() } });
  const P5 = await order(A, 174, F1, [glassLine(6)]);
  const batchData = (status) => ({
    customerId: A.id, kind: 'INVOICE', status, currency: 'EUR', loadingDays: [date(F1)], selectionKey: `k-${status}`, sourceTotal: '10', ronNet: '50',
    fxRate: '5.0000', fxDate: date(dayOf(0)), fxSource: 'BNR', fxPolicy: 'BNR', fxCurrency: 'EUR', fxBaseRate: '5', fxSourceDate: date(dayOf(0)), fxResolvedAt: new Date(), fxManual: false,
    createdById: U.admin.id, orders: { create: [{ orderId: P5.id, orderNo: P5.orderNo, loadingDay: date(F1), sourceAmount: '10', activeKey: status === 'VOID' ? null : `INVOICE:test-${status}:${P5.id}` }] },
  });
  // Kuyrukta bekleyen (PENDING), kesilemeyen (FAILED) ve FGO'da silinip geçersizleşen (VOID) fatura partisi engel DEĞİLDİR
  const pending = await db.billingBatch.create({ data: batchData('PENDING') });
  assert.deepEqual(await comp.compensationBlock(db, P5.id), { blocked: false });
  await db.billingBatchOrder.updateMany({ where: { batchId: pending.id }, data: { activeKey: null } });
  await db.billingBatch.update({ where: { id: pending.id }, data: { status: 'VOID' } });
  assert.deepEqual(await comp.compensationBlock(db, P5.id), { blocked: false });
  const issued = await db.billingBatch.create({ data: batchData('ISSUED') });
  await db.fgoDocument.create({ data: { batchId: issued.id, kind: 'INVOICE', series: 'GKH', number: '9306', issuedAt: new Date() } });
  assert.deepEqual(await comp.compensationBlock(db, P4.id), { blocked: true, code: 'FINAL_INVOICE', ref: 'GKH9303' });
  assert.deepEqual(await comp.compensationBlock(db, P5.id), { blocked: true, code: 'FINAL_INVOICE', ref: 'GKH9306' });
  assert.deepEqual([...(await comp.finalInvoices(db, [P1.id, P2.id, P3.id, P4.id, P5.id])).entries()].sort(), [[P4.id, 'GKH9303'], [P5.id, 'GKH9306']].sort());

  // Sunucu engeli: hiçbir rol, hiçbir kararla, hiçbir hedefe telafi açamaz — hiçbir kayıt yazılmaz
  const counts = async () => [await db.compensation.count(), await db.order.count(), await db.offer.count(), await db.offerLine.count(), await db.adminAlert.count(), await db.notificationOutbox.count(), await db.orderEvent.count(), await db.auditLog.count()];
  const docs1 = await docsBefore();
  const F3 = await order(A, 175, F2, [glassLine(2)]);
  const base = await counts();
  for (const o of [P4, P5]) {
    for (const [u, mode] of [[U.sales, 'FREE'], [U.sales, 'NORMAL'], [U.sales, 'CUSTOM'], [U.admin, 'FREE'], [U.admin, 'NORMAL'], [U.admin, 'CUSTOM']]) {
      for (const dest of [newOn(F2), into(F3)]) {
        const res = await create({ orderId: o.id, lineId: o.offers[0].lines[0].id, quantity: 1, mode, price: mode === 'CUSTOM' ? '35' : null, dest, actor: act(u) });
        assert.deepEqual(res, { ok: false, code: 'FINAL_INVOICE' }, `${o.orderNo} ${u.appRole} ${mode} ${dest.type}`);
      }
    }
  }
  assert.deepEqual(await counts(), base, 'reddedilen istek hiçbir şey yazmaz');
  assert.equal(await docsBefore(), docs1);
  // Hedef olarak da: nihai faturalı sipariş listede seçilemez, doğrudan istek reddedilir
  const list = await comp.compensationDestinations(db, { source: { id: P1.id, customerId: A.id, currency: 'EUR' } });
  assert.deepEqual([list.find((x) => x.id === P4.id).reason, list.find((x) => x.id === P5.id).reason], ['FINAL_INVOICE', 'FINAL_INVOICE']);
  assert.deepEqual(await create({ orderId: P1.id, lineId: (await load(P1.id)).offers[0].lines[0].id, quantity: 1, mode: 'FREE', dest: into(P4), actor: act(U.admin) }), { ok: false, code: 'DEST_FINAL_INVOICE' });

  // Onay bekleyen karar: kaynağın nihai faturası bu arada kesildiyse yönetici onaylayamaz (FINAL_INVOICE); reddetmek serbest
  const Q = await order(A, 176, OLD, [glassLine(3, { offerPrice: null })]);
  const D = await order(A, 177, F2, [glassLine(1)]);
  const pend = await create({ orderId: Q.id, lineId: Q.offers[0].lines[0].id, quantity: 1, mode: 'CUSTOM', price: '35', dest: into(D), actor: act(U.sales) });
  assert.equal(pend.status, 'PENDING');
  await db.fgoDocument.create({ data: { orderId: Q.id, kind: 'INVOICE', series: 'GKH', number: '9307', issuedAt: new Date() } });
  const dBefore = JSON.stringify((await load(D.id)).offers);
  assert.deepEqual(await comp.decideCompensation(db, { id: pend.compensationId, approve: true, price: '45', actor: act(U.admin) }), { ok: false, code: 'FINAL_INVOICE' });
  assert.deepEqual([(await compOf(pend.compensationId)).status, JSON.stringify((await load(D.id)).offers)], ['PENDING', dBefore]);
  assert.equal((await comp.decideCompensation(db, { id: pend.compensationId, approve: false, actor: act(U.admin) })).status, 'REJECTED');
});

dbTest('hiçbir ağ çağrısı yapılmadı (FGO gerçek bir sistemdir; bu dosya FGO belgesi kesmez)', async () => {
  assert.equal(net, 0);
  // Belge kayıtları yalnızca testin doğrudan yazdığı üç satırdır; telafi / silme belge üretmez
  assert.deepEqual((await db.fgoDocument.findMany({ orderBy: { number: 'asc' } })).map((d) => d.number), ['9001', '9010', '9100', '9200', '9301', '9302', '9303', '9304', '9305', '9306', '9307']);
  assert.equal(await db.notificationOutbox.count({ where: { type: { in: ['FGO_GLASS', 'FGO_BATCH', 'FGO_PROFORMA', 'FGO_INVOICE'] } } }), 0);
});
