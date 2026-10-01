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

test('yükleme dökümü: müşteriye göre grup, aynı cam tek satır (adet + m²), CNC / delik camın tutarına dahil; Excel', async () => {
  const { buildLoadingSummary, loadingSummaryXlsx } = await import('../server/loading/summary.js');
  const { readXlsx } = await import('../server/files/xlsx.js');
  const { glassLines } = await import('../server/glass/billing.js');
  const glass = (description, en, boy, adet, offerPrice, unitPrice) => ({ kind: 'CAM', unit: 'm2', description, descriptionRo: `RO ${description}`, enMm: en, boyMm: boy, adet, offerPrice, unitPrice });
  const orders = [
    { orderNo: 'ALE46', title: 'Adrian', customer: { id: 'a', name: 'ALEGRAD' }, offers: [{ status: 'GONDERILDI', currency: 'EUR', lines: [
      glass('88.3 TEMPER LAMİNE', 1000, 2000, 2, '50', '30'),
      { kind: 'CNC', unit: 'adet', description: 'CNC', adet: 2, offerPrice: '10', unitPrice: '5' },
      glass('10 MM TEMPER', 1000, 1000, 1, '24', '20'),
    ] }] },
    { orderNo: 'ALE47', title: 'Sura Mica', customer: { id: 'a', name: 'ALEGRAD' }, offers: [{ status: 'GONDERILDI', currency: 'EUR', lines: [
      glass('88.3 TEMPER LAMİNE', 1000, 1000, 3, '50', '30'),
      { kind: 'DELIK', unit: 'adet', description: 'Delik', adet: 4, offerPrice: '2', unitPrice: '1', free: true },
    ] }] },
    { orderNo: 'GLA61', title: null, customer: { id: 'g', name: 'GLASSANDMORE' }, offers: [{ status: 'GONDERILDI', currency: 'EUR', lines: [glass('88.3 TEMPER LAMİNE', 1000, 1000, 1, '40', '25')] }] },
  ];
  const s = buildLoadingSummary(orders, { priceOf: (l) => l.offerPrice });
  assert.deepEqual(s.rows.map((r) => [r.customer, r.orders.join(','), r.name, r.adet, r.m2, r.total, r.unit]), [
    ['ALEGRAD', 'ALE46', '10 MM TEMPER', 1, 1, 24, 24],
    ['ALEGRAD', 'ALE46,ALE47', '88.3 TEMPER LAMİNE', 5, 7, 370, 52.86], // (4 m² × 50 + 2 CNC × 10) + 3 m² × 50; birim = 370 / 7
    ['GLASSANDMORE', 'GLA61', '88.3 TEMPER LAMİNE', 1, 1, 40, 40],
  ]);
  assert.ok(!s.rows.some((r) => /CNC|Delik/.test(r.name)), 'işlemler ayrıca listelenmez');
  assert.deepEqual(s.totals, { EUR: { adet: 7, m2: 9, total: 434 } });
  // Fatura hesabıyla aynı tutar (aynı fonksiyon)
  assert.equal(glassLines(orders[0].offers[0]).reduce((a, l) => a + l.eurTotal, 0), 244);
  // Satış: yalnızca satış fiyatı (müşteri fiyatı verisi hiç gelmez)
  const sales = buildLoadingSummary(orders.map((o) => ({ ...o, offers: o.offers.map((f) => ({ ...f, lines: f.lines.map((l) => ({ ...l, offerPrice: null })) })) })), { priceOf: (l) => l.unitPrice });
  assert.equal(sales.totals.EUR.total, 4 * 30 + 2 * 5 + 20 + 3 * 30 + 25);
  const x = readXlsx(loadingSummaryXlsx(s, { day: '2026-10-02', stats: [['Sipariş', 3]], text: { title: 'YÜKLEME DÖKÜMÜ', unit: 'm²', total: 'TOPLAM', cols: ['SİPARİŞ NO', 'MÜŞTERİ', 'PROJE', 'AÇIKLAMA', 'ADET', 'BİRİM', 'METRAJ', 'BİRİM FİYAT', 'TUTAR'] } })).rows;
  assert.equal(x[0][0], 'YÜKLEME DÖKÜMÜ · 2026-10-02');
  assert.deepEqual(x.find((r) => r[0] === 'ALE46, ALE47'), ['ALE46, ALE47', 'ALEGRAD', 'Adrian, Sura Mica', '88.3 TEMPER LAMİNE', 5, 'm²', 7, 52.86, 370]);
  assert.deepEqual(x[x.length - 1].slice(3), ['TOPLAM', 7, null, 9, null, 434, 'EUR']);
});
