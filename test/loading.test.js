import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glassKgPerM2, orderLoad, sumLoads, dayKey, monthGrid, parseMonth, shiftMonth, gridRange } from '../server/orders/loading.js';

test('cam m² ağırlığı açıklamadan', () => {
  assert.equal(glassKgPerM2('8mm Temperli Cam'), 20);
  assert.equal(glassKgPerM2('10 mm temperli'), 25);
  assert.equal(glassKgPerM2('44.2 Lamine Cam'), 20.8);
  assert.equal(glassKgPerM2('66.2 Temper Lamine Cam (Şeffaf)'), 30.8);
  assert.equal(glassKgPerM2('Paslanmaz aparat'), null);
});

test('sipariş yükü: tahmini sandık (1700 kg) ve 50 kg dara', () => {
  const l = orderLoad({
    lines: [
      { description: '8mm Temperli Cam', enMm: 1000, boyMm: 2000, adet: 3 }, // 6 m² × 20 = 120 kg
      { description: 'Aparat', adet: 20, unit: 'adet' },
    ],
  });
  assert.deepEqual(l, { metraj: 6, camAdet: 3, netKg: 120, crates: 1, grossKg: 170, realCrates: false });
  const big = orderLoad({ lines: [{ description: '10mm', enMm: 3000, boyMm: 2000, adet: 12 }] }); // 72 m² × 25 = 1800
  assert.equal(big.crates, 2);
  assert.equal(big.grossKg, 1900);
});

test('gerçek sandık kayıtları tahminin önüne geçer', () => {
  const l = orderLoad({
    lines: [{ description: '8mm', enMm: 1000, boyMm: 2000, adet: 3 }],
    crates: [{ netAgirlik: '118', brutAgirlik: '175' }, { netAgirlik: null, brutAgirlik: null }],
  });
  assert.equal(l.crates, 2);
  assert.equal(l.realCrates, true);
  assert.equal(l.netKg, 178); // 118 + 120/2
  assert.equal(l.grossKg, 175 + 60 + 50);
});

test('siparişsiz satır: cam adedi sipariş kalemlerinden', () => {
  assert.equal(orderLoad({ items: [{ camAdedi: 4 }, { camAdedi: 2 }] }).camAdet, 6);
});

test('grup toplamı: tahmini camlar birlikte sandıklanır', () => {
  const a = orderLoad({ lines: [{ description: '10mm', enMm: 2000, boyMm: 2000, adet: 8 }] }); // 32 m² → 800 kg
  const b = orderLoad({ lines: [{ description: '10mm', enMm: 2000, boyMm: 2000, adet: 8 }] });
  const s = sumLoads([a, b]);
  assert.equal(s.netKg, 1600);
  assert.equal(s.crates, 1);
  assert.equal(s.grossKg, 1650);
  const real = orderLoad({ lines: [], crates: [{ netAgirlik: 300, brutAgirlik: 360 }] });
  assert.deepEqual([sumLoads([a, real]).crates, sumLoads([a, real]).grossKg], [2, 800 + 50 + 360]);
});

test('gün anahtarı Romanya saatine göre', () => {
  assert.equal(dayKey(new Date('2026-10-16T12:00:00Z')), '2026-10-16');
  assert.equal(dayKey(new Date('2026-10-15T22:30:00Z')), '2026-10-16'); // 01:30 Bükreş
});

test('takvim ızgarası pazartesiden başlar', () => {
  const g = monthGrid('2026-09');
  assert.equal(g[0][0].key, '2026-08-31');
  assert.equal(g[0][0].inMonth, false);
  assert.equal(g[0][1].key, '2026-09-01');
  assert.equal(g.length, 5);
  assert.equal(g[4][6].key, '2026-10-04');
  assert.equal(monthGrid('2026-03').length, 6); // 1 Mart pazar
  assert.equal(parseMonth('2026-13'), null);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  const r = gridRange('2026-09');
  assert.ok(r.from < new Date('2026-08-31T00:00:00Z') && r.to > new Date('2026-10-04T23:59:59Z'));
});
