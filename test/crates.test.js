// Sandıklar (yükleme sekmesi): satır doğrulama ve müşteri + gün yükü (girilen sandıklar tahminin önüne geçer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupLoad, validateCrates } from '../server/loading/crates.js';

test('sandık: satırlar doğrulanır, boş satır atlanır', () => {
  const ok = validateCrates([
    { crateNo: '15', lengthMm: '2700', widthMm: '541', heightMm: '1182', netKg: '1275', grossKg: '1335', note: ' FOL2 ', orderIds: ['a', 'a', ''] },
    { crateNo: '', lengthMm: '', widthMm: '', heightMm: '', netKg: '', grossKg: '', note: '' },
    { crateNo: '16', netKg: '1043,5' },
  ]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.rows[0], { origNo: null, crateNo: 15, lengthMm: 2700, widthMm: 541, heightMm: 1182, netKg: 1275, grossKg: 1335, note: 'FOL2', orderIds: ['a'] });
  assert.deepEqual([ok.rows[1].crateNo, ok.rows[1].netKg, ok.rows[1].grossKg, ok.rows[1].lengthMm], [16, 1043.5, null, null]);

  const bad = validateCrates([
    { crateNo: '0' }, { crateNo: '5', lengthMm: '12.5' }, { crateNo: '5' }, { crateNo: '6', netKg: '300', grossKg: '200' },
    { crateNo: '7', netKg: 'abc' }, { crateNo: '8', note: 'x'.repeat(201) },
  ]);
  assert.deepEqual(bad.errors, [
    { row: 1, code: 'NO' }, { row: 2, code: 'DIM' }, { row: 3, code: 'DUPLICATE_NO' }, { row: 4, code: 'GROSS_LT_NET' },
    { row: 5, code: 'WEIGHT' }, { row: 6, code: 'NOTE' },
  ]);
});

const loads = [
  { metraj: 6, camAdet: 3, cnc: 1, delik: 2, netKg: 1200 },
  { metraj: 4.5, camAdet: 2, cnc: 0, delik: 0, netKg: 900 },
];

test('sandık: girilmediyse müşteri + gün tahmini (1.700 kg\'a bölünüp yukarı yuvarlanır, sandık başına 50 kg)', () => {
  assert.deepEqual(groupLoad(loads), {
    orders: 2, metraj: 10.5, camAdet: 5, cnc: 1, delik: 2, netKg: 2100, grossKg: 2200, crates: 2, realCrates: false, estimatedCrates: 2, estimatedNetKg: 2100,
  });
});

test('sandık: girilen sandıklar tahminin önüne geçer; boş net cam ağırlığından paylaştırılır, boş brüt = net + dara', () => {
  const g = groupLoad(loads, [
    { netAgirlik: '1275', brutAgirlik: '1335', daraKg: 50 },
    { netAgirlik: null, brutAgirlik: null, daraKg: 50 },
  ]);
  // ikinci sandığın neti: 2100 / 2 = 1050, brütü 1050 + 50
  assert.deepEqual([g.crates, g.netKg, g.grossKg, g.realCrates, g.estimatedCrates], [2, 2325, 2435, true, 0]);
});

test('otomatik sandık bağı (karar 234): yeni sandık kendi bütün siparişlerine; kayıtlı sandık (origNo) bağlarını korur; formdan gelen sipariş yok sayılır', async () => {
  const { autoLinkRows } = await import('../server/loading/crates.js');
  const v = validateCrates([
    { origNo: '5', crateNo: '5', orderIds: ['YABANCI'] },
    { origNo: '6', crateNo: '9' },
    { crateNo: '7', orderIds: ['b'] },
    { origNo: '5', crateNo: '8' },
  ]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.rows.map((r) => r.origNo), [5, 6, null, 5]);
  const stored = [{ crateNo: 5, orders: [{ orderId: 'a' }, { orderId: 'gone' }] }, { crateNo: 6, orders: [] }];
  const out = autoLinkRows(v.rows, stored, [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(out.map((r) => [r.crateNo, r.orderIds]), [
    [5, ['a']], // kayıtlı: yalnızca bugünün kendi siparişleriyle kesişim; formdaki yabancı kimlik yok sayılır
    [9, []], // kayıtlı, numarası değişti: bağları (boş) korunur — yeniden bağlanmaz
    [7, ['a', 'b']], // yeni: firmanın o günkü misafir olmayan bütün siparişleri
    [8, ['a', 'b']], // aynı origNo ikinci kez: yeni sandık sayılır
  ]);
});
