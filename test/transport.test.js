// Nakliye listesi (Yüklemeler → PDF): gruplama, ağırlık, eksik sandık; PDF üretimi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTransportList, crateWeight } from '../server/loading/transport.js';
import { transportListPdf } from '../server/pdf/transport-list.js';

const crate = (customerId, prefix, crateNo, extra = {}) => ({
  customerId, customer: { prefix, name: `${prefix} SRL` }, crateNo, lengthMm: 2716, widthMm: 507, heightMm: 1520,
  netAgirlik: null, brutAgirlik: null, daraKg: '50', note: null, ...extra,
});

test('nakliye listesi: müşteri koduna göre gruplar, ara toplam, toplam; sandığı girilmemiş siparişler', () => {
  const list = buildTransportList([
    crate('tm', 'TM', 3, { brutAgirlik: '1388' }),
    crate('sb', 'SB', 8, { brutAgirlik: '581' }),
    crate('sb', 'SB', 1, { brutAgirlik: '984', note: 'Misafir yük' }),
    crate('sb', 'SB', 2, { netAgirlik: '785' }), // brüt yok → net + dara
    crate('tm', 'TM', 4, { lengthMm: null, widthMm: null, heightMm: null }), // ölçü ve ağırlık yok
  ], [
    { orderNo: 'SB10', customerId: 'sb' }, { orderNo: 'TM4', customerId: 'tm' }, { orderNo: 'ADE6', customerId: 'ade' },
  ]);
  assert.deepEqual(list.groups.map((g) => g.code), ['SB', 'TM']);
  assert.deepEqual(list.groups[0].crates.map((c) => c.crateNo), [1, 2, 8]);
  assert.equal(list.groups[0].totalKg, 2400);
  assert.equal(list.groups[0].crates[1].weight, 835, 'net 785 + dara 50');
  assert.equal(list.groups[1].crates[1].weight, null, 'ağırlık uydurulmaz');
  assert.equal(list.groups[1].crates[1].dims, '');
  assert.equal(list.groups[0].crates[0].dims, '2716 × 507 × 1520');
  assert.equal(list.crateCount, 5);
  assert.equal(list.totalKg, 3788);
  assert.deepEqual(list.missing, ['ADE6']);
  assert.equal(crateWeight({ brutAgirlik: null, netAgirlik: null }), null);
});

test('nakliye listesi PDF: geçerli PDF, birçok sandıkta birden çok sayfa', () => {
  const text = {
    title: 'NAKLİYE LİSTESİ', day: 'Yükleme günü', colNo: 'Sandık no', colDims: 'U × G × Y (mm)', colKg: 'Ağırlık (kg)', colNote: 'Not',
    subtotal: '{n} sandık · ara toplam', crateCount: 'Sandık adedi', totalKg: 'TOPLAM AĞIRLIK', missing: 'Sandık ölçüsü girilmemiş siparişler',
    noPrice: 'Bu belge fiyat bilgisi içermez.', empty: 'Sandık yok.',
  };
  const small = transportListPdf({ day: '2026-10-02', company: 'GKH Trading', text, list: buildTransportList([crate('sb', 'SB', 1, { brutAgirlik: '10' })], []) });
  assert.equal(small.subarray(0, 5).toString(), '%PDF-');
  const many = Array.from({ length: 60 }, (_, i) => crate(i < 30 ? 'a' : 'b', i < 30 ? 'AAA' : 'BBB', i + 1, { brutAgirlik: '100' }));
  const big = transportListPdf({ day: '2026-10-02', company: 'GKH Trading', text, list: buildTransportList(many, []) });
  assert.ok((big.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length >= 2);
  const empty = transportListPdf({ day: '2026-10-02', company: 'GKH Trading', text, list: buildTransportList([], [{ orderNo: 'X1', customerId: 'x' }]) });
  assert.equal(empty.subarray(0, 5).toString(), '%PDF-');
});
