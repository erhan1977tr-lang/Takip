// Yükleme onayı (karar 92) ve eksik maliyet düzeltmesi (karar 93) — saf kurallar. Veritabanlı testler: test/db/loading-confirmation.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmLoading, itemAsLine, lineTotals, planItems, planKey, snapshotLine, summarize } from '../server/loading/confirmation.js';
import { confirmedLine, loadingProfits, mergeConfirmed, orderLine, supplierSummary } from '../server/accounting/supplier.js';
import { correctMissingCost } from '../server/accounting/cost-correction.js';
import { glassTotals } from '../server/glass/billing.js';

const glass = (extra = {}) => ({ id: 'l1', sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 2000, adet: 5, unit: 'm2', kind: 'CAM', unitPrice: '60', offerPrice: '100', weightKgM2: '25', ...extra });
const cnc = (extra = {}) => ({ id: 'l2', sortOrder: 1, description: 'CNC', adet: 2, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '10', ...extra });
const offer = (lines, extra = {}) => ({ id: 'of1', status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', lines, ...extra });
const order = (id, lines, extra = {}) => ({ id, orderNo: `ABC${id}`, title: 'Proje', customerId: 'c1', customer: { id: 'c1', name: 'ABC SRL' }, offers: [offer(lines)], ...extra });

test('onay kopyası: müşteri, sipariş, kaynak satır, cam, adet, m², birim maliyet / müşteri fiyatı ve tutarlar', () => {
  const o = order('1', [glass(), cnc()]);
  const g = snapshotLine(o, o.offers[0], o.offers[0].lines[0]);
  assert.deepEqual(
    { orderId: g.orderId, customerId: g.customerId, offerLineId: g.offerLineId, description: g.description, descriptionRo: g.descriptionRo, quantity: g.quantity, m2: g.m2, currency: g.currency, unitCost: g.unitCost, unitSale: g.unitSale, costAmount: g.costAmount, saleAmount: g.saleAmount, status: g.status },
    { orderId: '1', customerId: 'c1', offerLineId: 'l1', description: 'Temper', descriptionRo: 'Securizat', quantity: 5, m2: 10, currency: 'EUR', unitCost: 60, unitSale: 100, costAmount: 600, saleAmount: 1000, status: 'LOADED' },
  );
  // Maliyet = OfferLine.unitPrice, satış = OfferLine.offerPrice: ikisi ayrı saklanır
  const c = snapshotLine(o, o.offers[0], o.offers[0].lines[1]);
  assert.deepEqual([c.kind, c.quantity, c.m2, c.costAmount, c.saleAmount], ['CNC', 2, 0, 10, 20]);
  // Müşteriye bedelsiz satır: satış 0, fabrika maliyeti durur
  const f = snapshotLine(o, o.offers[0], glass({ free: true }));
  assert.deepEqual([f.saleAmount, f.costAmount, f.free], [0, 600, true]);
});

test('kısmi yükleme taşınabilir: kopya FİİLEN onaylanan adedi ve m²\'yi saklar (10 camdan 8 yüklendi, 2 yüklenmedi)', () => {
  const line = glass({ enMm: 800, boyMm: 800, adet: 10 }); // 10 cam = 6,40 m²
  const o = order('3', [line]);
  const loaded = snapshotLine(o, o.offers[0], line, { quantity: 8 });
  const missing = snapshotLine(o, o.offers[0], line, { quantity: 2, status: 'NOT_LOADED', reason: 'BROKEN' });
  assert.deepEqual([loaded.quantity, loaded.m2, loaded.saleAmount, loaded.costAmount], [8, 5.12, 512, 307.2]);
  assert.deepEqual([missing.quantity, missing.m2, missing.status, missing.notLoadedReason], [2, 1.28, 'NOT_LOADED', 'BROKEN']);
  assert.equal(loaded.offerLineId, missing.offerLineId, 'ikisi de aynı sipariş satırına bağlı: yüklenmeyen kısım izlenebilir, sonra yeniden planlanabilir');
  assert.equal(loaded.notLoadedReason, null);
  // Kârlılık ve özet yalnızca yüklenen kısmı sayar
  const l = confirmedLine({ orderId: '3', orderNo: 'ABC3', day: '2026-09-15', items: [loaded, missing] });
  assert.deepEqual([l.m2, l.sale, l.cost, l.confirmed], [5.12, 512, 307.2, true]);
  const s = summarize([{ orderId: '3', orderNo: 'ABC3', title: null, customerId: 'c1', customerName: 'ABC SRL', currency: 'EUR', items: [loaded, missing] }]);
  assert.deepEqual([s.totals.adet, s.totals.m2, s.totals.byCur.EUR], [8, 5.12, { sale: 512, cost: 307.2 }]);
  assert.equal(confirmedLine({ orderId: '3', orderNo: 'ABC3', day: 'x', items: [missing] }), null, 'hiç yüklenen kalemi olmayan sipariş sayılmaz');
});

test('onay planı: gönderilmiş teklifi olmayan ve başka yüklemede onaylanmış sipariş onaya girmez; parmak izi içerik değişince değişir', () => {
  const a = order('1', [glass(), cnc()]);
  const b = order('2', [glass({ id: 'l3' })], { customerId: 'c2', customer: { id: 'c2', name: 'XYZ SRL' } });
  const draft = order('4', [glass({ id: 'l4' })]);
  draft.offers[0].status = 'YONETIMDE';
  const moved = order('5', [glass({ id: 'l5' })]);
  const plan = planItems([a, b, draft, moved], new Map([['5', '2026-09-01']]));
  assert.deepEqual(plan.orders.map((o) => [o.orderNo, o.customerName, o.items.length]), [['ABC1', 'ABC SRL', 2], ['ABC2', 'XYZ SRL', 1]]);
  assert.deepEqual(plan.skipped.map((s) => [s.orderNo, s.reason, s.day ?? null]), [['ABC4', 'NO_SENT_OFFER', null], ['ABC5', 'ALREADY_CONFIRMED', '2026-09-01']]);
  assert.equal(plan.items.length, 3);
  assert.ok(plan.items.every((i) => i.status === 'LOADED'), '"Eksiksiz Yüklendi": bütün kalemler tam adetle');
  const key = planKey('2026-09-15', plan.items);
  assert.equal(key, planKey('2026-09-15', planItems([a, b]).items), 'aynı içerik → aynı parmak izi');
  assert.notEqual(key, planKey('2026-09-16', plan.items), 'gün');
  assert.notEqual(key, planKey('2026-09-15', planItems([order('1', [glass({ adet: 6 }), cnc()]), b]).items), 'adet değişti');
  assert.notEqual(key, planKey('2026-09-15', planItems([order('1', [glass({ offerPrice: '101' }), cnc()]), b]).items), 'müşteri fiyatı değişti');
  assert.notEqual(key, planKey('2026-09-15', planItems([order('1', [glass({ unitPrice: '61' }), cnc()]), b]).items), 'maliyet değişti');
  assert.notEqual(key, planKey('2026-09-15', planItems([a]).items), 'sipariş çıktı');
});

test('kopyadan hesap: teklif satırlarındaki kuralla (glassTotals) aynı sonuç; müşteri → sipariş → cam özeti', () => {
  const lines = [glass(), cnc(), { id: 'l6', sortOrder: 2, description: 'Sandık parası', adet: 1, unit: 'adet', kind: 'CAM', unitPrice: '40', offerPrice: '60' }, glass({ id: 'l7', sortOrder: 3, description: 'Lamine', descriptionRo: 'Laminat', adet: 1, unitPrice: '80', offerPrice: '120' })];
  const o = order('1', lines);
  const plan = planItems([o]);
  const t = lineTotals(plan.items.map(itemAsLine));
  const want = (priceOf) => Math.round(glassTotals(o.offers[0], { priceOf }).reduce((s, g) => s + g.total, 0) * 100) / 100;
  assert.equal(t.sale, want((l) => l.offerPrice));
  assert.equal(t.cost, want((l) => l.unitPrice));
  // Temper 10 m²: 1000 + CNC 20 + sandık 60 · Lamine 2 m²: 240 → satış 1320; maliyet 600 + 10 + 40 + 160 = 810
  assert.deepEqual([t.sale, t.cost, t.m2, t.adet], [1320, 810, 12, 6]);
  assert.deepEqual(orderLine({ ...o, actualShipDate: new Date('2026-09-15T12:00:00Z'), estimatedShipDate: null }).sale, t.sale, 'planlanan hesapla aynı');
  const s = summarize(plan.orders, (l) => l.descriptionRo || l.description);
  assert.deepEqual(s.customers.map((c) => [c.name, c.adet, c.m2]), [['ABC SRL', 6, 12]]);
  assert.deepEqual(s.customers[0].orders[0].glass.map((g) => [g.name, g.adet, g.m2, g.sale, g.cost]), [['Securizat', 5, 10, 1080, 650], ['Laminat', 1, 2, 240, 160]]);
  assert.deepEqual(s.totals, { orders: 1, adet: 6, m2: 12, items: 4, byCur: { EUR: { sale: 1320, cost: 810 } }, noCost: 0 });
});

test('kârlılık: onaylı günde onay kopyası kullanılır; sonradan değişen teklif / fiyat onaylı günü değiştirmez; sipariş iki kez sayılmaz', () => {
  const day = new Date('2026-09-15T12:00:00Z');
  const o1 = { ...order('1', [glass()]), actualShipDate: day, estimatedShipDate: null };
  const snapshot = planItems([o1]).orders;
  const confirmations = [{ day: '2026-09-15', orders: snapshot }];
  // Onaydan SONRA: yönetici müşteri fiyatını, satış maliyeti değiştirmiş; sipariş başka güne alınmış; yeni sipariş onaylı güne eklenmiş
  const changed = { ...order('1', [glass({ unitPrice: '75', offerPrice: '150' })]), actualShipDate: new Date('2026-09-20T12:00:00Z'), estimatedShipDate: null };
  const late = { ...order('2', [glass({ id: 'l9' })]), actualShipDate: day, estimatedShipDate: null };
  const other = { ...order('3', [glass({ id: 'l10', adet: 1, unitPrice: '10', offerPrice: '30' })]), actualShipDate: new Date('2026-09-18T12:00:00Z'), estimatedShipDate: null };
  const merged = mergeConfirmed([changed, late, other].map(orderLine), confirmations);
  const days = loadingProfits(merged.lines, [
    { shipDay: new Date('2026-09-15'), amount: '150', currency: 'EUR' },
    { shipDay: new Date('2026-09-15'), amount: '80', currency: 'RON' },
  ], merged);
  assert.deepEqual(days.map((d) => [d.day, d.confirmed, d.orders]), [['2026-09-18', false, 1], ['2026-09-15', true, 1]], '20 Eylül\'de yeniden sayılmadı');
  const d15 = days[1];
  assert.deepEqual(d15.byCur.EUR, { sale: 1000, cost: 600, transport: 150, profit: 250 }, 'onay anındaki fiyatlar (150 / 75 değil)');
  assert.deepEqual(d15.byCur.RON, { sale: 0, cost: 0, transport: 80, profit: -80 }, 'transport yalnızca kendi para biriminde düşülür');
  assert.equal(d15.m2, 10);
  assert.deepEqual(d15.outside, [{ orderId: '2', orderNo: 'ABC2' }], 'onaydan sonra o güne eklenen sipariş sayılmaz, ayrıca gösterilir');
  // Onaylanmamış gün: eski (planlanan) hesap aynen
  assert.deepEqual(days[0].byCur.EUR, { sale: 60, cost: 20, transport: 0, profit: 40 });
  // Fabrika ödemesi kârdan düşülmez; yalnızca bakiyeyi etkiler
  const s = supplierSummary(days, [{ amount: '500', currency: 'EUR' }]);
  assert.deepEqual(s.EUR, { sale: 1060, cost: 620, transport: 150, profit: 290, paid: 500, balance: 120 });
});

test('yükleme onayı ve maliyet düzeltmesi: yönetici dışındaki roller sunucuda reddedilir (veritabanına hiç gidilmez)', async () => {
  const noDb = new Proxy({}, { get() { throw new Error('veritabanına gidilmemeliydi'); } });
  for (const role of ['SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI', undefined, 'BILINMEYEN']) {
    assert.deepEqual(await confirmLoading(noDb, { day: '2026-09-15', key: 'x', actor: { id: 'u', role } }), { ok: false, code: 'FORBIDDEN' }, String(role));
    assert.deepEqual(await correctMissingCost(noDb, { lineId: 'l', cost: 10, actor: { id: 'u', role } }), { ok: false, code: 'FORBIDDEN' }, String(role));
  }
  const admin = { id: 'a', role: 'ADMIN' };
  assert.deepEqual(await confirmLoading(noDb, { day: '15.09.2026', key: 'x', actor: admin }), { ok: false, code: 'BAD_DAY' });
  // Yükleme günü gelmeden onaylanamaz (onay geri alınamaz)
  assert.deepEqual(await confirmLoading(noDb, { day: '2026-09-16', key: 'x', actor: admin, now: new Date('2026-09-15T10:00:00Z') }), { ok: false, code: 'FUTURE_DAY' });
  for (const cost of [0, -5, NaN, '12']) assert.deepEqual(await correctMissingCost(noDb, { lineId: 'l', cost, actor: admin }), { ok: false, code: 'BAD_COST' }, String(cost));
});
