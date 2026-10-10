// P2-A — "Aynı fiyat" telafisi ve CNC / delik adetleri (karar 112, 113, 157) — veritabanıyla, hata yeniden üretme denemesi.
// Bildirilen: aynı fiyatla taşınan telafi camı bedelsiz görünüyor; CNC / delik adetleri 1'e dönüşüyor.
// Kaynak ve hedef siparişte cam adedi, işlem adedi, fabrika fiyatı (unitPrice), müşteri fiyatı (offerPrice) ve bedelsiz
// işareti satır satır karşılaştırılır; hedef taslakta satışın kaydı, yöneticiye gönderimi ve yöneticinin onayı da sınanır.
// Kaynak müşteri fiyatı boşken "Aynı fiyat": sunucunun izlediği yol (compensationFlow ile ekranın gösterdiği aynı olmalı).
// Ağ çağrısı yok (FGO / BNR'ye hiç gidilmez).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const comp = await import('../../server/orders/compensation.js');
const { runOrderAction } = await import('../../server/orders/transitions.js');

const U = {};
let db, A;
let seq = 600, k = 0;
const act = (u) => ({ id: u.id, role: u.appRole, ip: '127.0.0.1', customerId: u.customerId });
const dayOf = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (key) => new Date(`${key}T12:00:00Z`);
const key = () => `p2a-${++k}-${'x'.repeat(16)}`;
const glass = (adet, extra = {}) => ({ description: 'Temper Lamine 44.2', descriptionRo: 'Sticlă laminată 44.2', enMm: 1000, boyMm: 2000, adet, unit: 'm2', kind: 'CAM', unitPrice: '30', offerPrice: '66.96', listPrice: '30', ...extra });
const cnc = (adet) => ({ description: 'CNC', adet, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '8' });
const hole = (adet) => ({ description: 'Delik', adet, unit: 'adet', kind: 'DELIK', unitPrice: '2', offerPrice: '3' });
const FULL = { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } };
async function order(day, lines, { offer = 'GONDERILDI', status = 'URETIMDE' } = {}) {
  const no = seq++;
  return db.order.create({
    data: {
      orderNo: `${A.prefix}${no}`, customerOrderNo: no, title: `P2A ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: A.id, createdById: U.admin.id, status, estimatedShipDate: at(day),
      offers: { create: { status: offer, currency: 'EUR', amount: '0', offerAmount: '0', createdById: U.admin.id, ...(offer === 'GONDERILDI' ? { sentAt: new Date() } : {}), lines: { create: lines.map((l, i) => ({ sortOrder: i, ...l })) } } },
    },
    include: FULL,
  });
}
const load = (id) => db.order.findUniqueOrThrow({ where: { id }, include: FULL });
/** [tür, adet, fabrika fiyatı, müşteri fiyatı, bedelsiz, telafi satırı mı] */
const row = (l) => [l.kind, l.adet, l.unitPrice.toString(), l.offerPrice == null ? null : l.offerPrice.toString(), l.free, !!l.compensationId];
const compRows = (o) => o.offers[0].lines.filter((l) => l.compensationId).map(row);
const create = (p) => comp.createCompensation(db, { requestKey: key(), confirm: true, mode: 'NORMAL', ...p });
/** Teklif formunun gönderdiği satırlar (bedelsiz satırın fiyatı formdan 0 gelir; satışta müşteri fiyatı yok) */
const formLines = (lines, withOffer) => lines.map((l) => ({
  id: l.id, description: l.description, poz: l.poz, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, free: l.free,
  unitPrice: l.free ? '0.00' : Number(l.unitPrice).toFixed(2),
  ...(withOffer ? { offerPrice: l.free ? '0.00' : l.offerPrice == null ? null : Number(l.offerPrice).toFixed(2) } : {}),
}));
// Beklenen telafi satırları: cam kaynağın fiyatlarıyla (bedelsiz DEĞİL), işlemler kaynağın adediyle (1'e inmez), müşteri fiyatı 0
const SAME_WITH_OPS = [['CAM', 1, '30', '66.96', false, true], ['CNC', 3, '5', '0', true, true], ['DELIK', 5, '2', '0', true, true]];

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  A = await db.customer.create({ data: { name: 'Aynı Fiyat SRL', prefix: 'AYF', email: 'ayf@telafi.test', taxId: '556677', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. 2', fxPolicy: 'BNR' } });
  for (const [name, appRole] of [['admin', 'ADMIN'], ['sales', 'SATIS']]) {
    U[name] = await db.user.create({ data: { email: `${name}@p2a.test`, name, type: 'INTERNAL', appRole, customerId: factory.id } });
  }
});
after(closeDb);

dbTest('aynı fiyat → taslak hedef (satış): cam kaynağın müşteri fiyatıyla, bedelsiz değil; CNC 3 / delik 5 aynen; satışın kaydı, yöneticiye gönderimi ve yöneticinin onayı değiştirmez', offline(async () => {
  // Kaynak: 4 işlemsiz cam + işlemli TEK cam (3 CNC, 5 delik)
  const S = await order(dayOf(5), [glass(4), glass(1), cnc(3), hole(5)]);
  const D = await order(dayOf(12), [glass(2)], { offer: 'HAZIRLANIYOR', status: 'HAZIRLANIYOR' });
  const opsGlass = S.offers[0].lines[1];
  const r = await create({ orderId: S.id, lineId: opsGlass.id, quantity: 1, dest: { type: 'EXISTING', orderId: D.id }, actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.via], [true, 'APPLIED', 'DRAFT'], JSON.stringify(r));
  const c = await db.compensation.findUniqueOrThrow({ where: { id: r.compensationId } });
  assert.deepEqual([c.priceMode, c.free, String(c.offerPrice), String(c.normalPrice), String(c.unitCost)], ['NORMAL', false, '66.96', '66.96', '30']);

  let d = await load(D.id);
  assert.deepEqual(compRows(d), SAME_WITH_OPS, 'telafi satırları hedef taslakta');
  // Satış taslağı kaydeder (formunda müşteri fiyatı yok) → müşteri fiyatı ve işlem adetleri korunur
  await runOrderAction(db, { orderId: D.id, action: 'save_offer', actor: act(U.sales), payload: { lines: formLines(d.offers[0].lines, false) } });
  d = await load(D.id);
  assert.deepEqual(compRows(d), SAME_WITH_OPS, 'satışın taslak kaydından sonra');
  // Satış yöneticiye gönderir
  await runOrderAction(db, { orderId: D.id, action: 'submit_offer', actor: act(U.sales), payload: { lines: formLines(d.offers[0].lines, false) } });
  d = await load(D.id);
  assert.equal(d.offers[0].status, 'YONETIMDE');
  assert.deepEqual(compRows(d), SAME_WITH_OPS, 'yöneticiye gönderimden sonra');
  // Yönetici fiyatlarıyla onaylar ve müşteriye gönderir (form müşteri fiyatlarını aynen gönderir)
  await runOrderAction(db, { orderId: D.id, action: 'approve_offer', actor: act(U.admin), payload: { lines: formLines(d.offers[0].lines, true) } });
  d = await load(D.id);
  assert.equal(d.offers[0].status, 'GONDERILDI');
  assert.deepEqual(compRows(d), SAME_WITH_OPS, 'müşteriye gönderilen teklifte');

  // Kaynak: temiz sipariş → yeni gönderilmiş sürüm; işlemli tek cam ve işlemleri kalktı, işlemsiz 4 cam aynen
  const s = await load(S.id);
  assert.equal(s.offers.length, 2);
  assert.deepEqual(s.offers[0].lines.map(row), [['CAM', 4, '30', '66.96', false, false]]);
  assert.deepEqual(s.offers[1].lines.map(row), [['CAM', 4, '30', '66.96', false, false], ['CAM', 1, '30', '66.96', false, false], ['CNC', 3, '5', '8', false, false], ['DELIK', 5, '2', '3', false, false]], 'eski sürüm değişmez');
}));

dbTest('aynı fiyat → yeni telafi siparişi ve müşterideki hedef teklif (satış): cam bedelsiz değil, tutar kaynağın fiyatıyla; işlem adetleri aynen', offline(async () => {
  const S = await order(dayOf(6), [glass(4), glass(1), cnc(2), hole(4)]);
  // Yeni sipariş: işlemsiz camdan 2 adet
  let r = await create({ orderId: S.id, lineId: S.offers[0].lines[0].id, quantity: 2, dest: { type: 'NEW', day: dayOf(14) }, actor: act(U.sales) });
  assert.deepEqual([r.ok, r.via, r.direct], [true, 'NEW', true], JSON.stringify(r));
  const T = await load(r.destOrderId);
  assert.equal(T.offers[0].status, 'GONDERILDI');
  assert.deepEqual(T.offers[0].lines.map(row), [['CAM', 2, '30', '66.96', false, true]]);
  // 2 cam × 2 m² × 66,96 = 267,84 (müşteri tutarı); satış (maliyet) 2 × 2 × 30 = 120
  assert.deepEqual([T.offers[0].offerAmount.toString(), T.offers[0].amount.toString()], ['267.84', '120']);

  // Müşterideki hedef teklif: işlemli tek camdan telafi
  const F = await order(dayOf(15), [glass(3)]);
  const s = await load(S.id);
  const opsGlass = s.offers[0].lines.find((l) => l.kind === 'CAM' && l.adet === 1);
  r = await create({ orderId: S.id, lineId: opsGlass.id, quantity: 1, dest: { type: 'EXISTING', orderId: F.id }, actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status, r.via, r.direct], [true, 'APPLIED', 'SENT', true], JSON.stringify(r));
  const f = await load(F.id);
  assert.deepEqual(compRows(f), [['CAM', 1, '30', '66.96', false, true], ['CNC', 2, '5', '0', true, true], ['DELIK', 4, '2', '0', true, true]]);
}));

dbTest('kaynak müşteri fiyatı boşken "aynı fiyat": doğrudan müşteriye gitmez — yeni siparişte yöneticinin fiyat onayı, müşterideki teklifte satış için onay bekler, yönetici için fiyat ister; ekranın akışı sunucuyla aynı', offline(async () => {
  const S = await order(dayOf(7), [glass(3, { offerPrice: null }), glass(2)]);
  const unpriced = S.offers[0].lines[0];
  const flow = (p) => comp.compensationFlow({ mode: 'NORMAL', sourceFree: false, sourcePriced: false, ...p });

  // Yeni sipariş (satış): fiyat onayı sırasına düşer
  let r = await create({ orderId: S.id, lineId: unpriced.id, quantity: 1, dest: { type: 'NEW', day: dayOf(16) }, actor: act(U.sales) });
  assert.deepEqual([r.ok, r.via, r.direct], [true, 'NEW', false], JSON.stringify(r));
  const T = await load(r.destOrderId);
  assert.deepEqual([T.offers[0].status, T.offers[0].lines.map(row)], ['YONETIMDE', [['CAM', 1, '30', null, false, true]]]);
  assert.equal(flow({ admin: false, destType: 'NEW', via: null }), 'pricing');

  // Müşterideki hedef + satış: yöneticinin onayını bekler (PENDING), hedef teklif değişmez
  const F = await order(dayOf(17), [glass(1)]);
  r = await create({ orderId: S.id, lineId: (await load(S.id)).offers[0].lines[0].id, quantity: 1, dest: { type: 'EXISTING', orderId: F.id }, actor: act(U.sales) });
  assert.deepEqual([r.ok, r.status], [true, 'PENDING'], JSON.stringify(r));
  assert.equal((await load(F.id)).offers.length, 1);
  assert.equal(flow({ admin: false, destType: 'EXISTING', via: 'SENT' }), 'pending');

  // Müşterideki hedef + yönetici: fiyatsız satır müşteriye gidemez
  const G = await order(dayOf(18), [glass(1)]);
  r = await create({ orderId: S.id, lineId: (await load(S.id)).offers[0].lines[0].id, quantity: 1, dest: { type: 'EXISTING', orderId: G.id }, actor: act(U.admin) });
  assert.deepEqual(r, { ok: false, code: 'PRICE_REQUIRED' });
  assert.equal(flow({ admin: true, destType: 'EXISTING', via: 'SENT' }), 'priceRequired');

  // Fiyatlı kaynak: aynı istekler doğrudan gider (karşılaştırma)
  assert.equal(flow({ admin: false, destType: 'NEW', via: null, sourcePriced: true }), 'direct');
  assert.equal(flow({ admin: true, destType: 'EXISTING', via: 'SENT', sourcePriced: true }), 'direct');
}));
