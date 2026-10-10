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

/** Eski test verisi (sipariş + teklifler) → döküm girdisi (karar 233: { orderNo, title, currency, customer, lines }) */
const flat = (orders) => orders.map((o) => ({ orderNo: o.orderNo, title: o.title, customer: o.customer, currency: o.offers[0].currency, lines: o.offers[0].lines }));
/** Döküm satırları: [müşteri, sipariş, ad, adet, m², ort. fiyat, tutar, bedelsiz] */
const rowsOf = (s) => s.customers.flatMap((c) => c.orders.flatMap((o) => o.rows.map((r) => [c.name, o.orderNo, r.name, r.adet, r.m2, r.price, r.total, r.free])));
const SUMMARY_TEXT = {
  title: 'YÜKLEME ÖZETİ · 02.10.2026', sheetFirms: 'Firmalar', linesNone: '-', firmsTitle: 'F', guestTitle: 'G', guestNone: '-',
  total: 'TOPLAM', free: 'bedelsiz (telafi)', unit: 'm²',
  cols: { order: 'SİPARİŞ NO', customer: 'MÜŞTERİ', project: 'PROJE', desc: 'AÇIKLAMA', qty: 'ADET', unit: 'BİRİM', m2: 'METRAJ', price: 'BİRİM FİYAT', amount: 'TUTAR', currency: 'Para birimi' },
  firmCols: { firm: '', orders: '', glass: '', cnc: '', holes: '', m2: '', net: '', crates: '', gross: '', factory: '', offer: '' }, guestCols: { order: '', owner: '', host: '', crate: '' },
};

test('yükleme özeti (karar 233): müşteri → sipariş; aynı ad yalnızca AYNI siparişte birleşir; CNC / delik tutarda; toplamlar; tek sayfa', async () => {
  const { buildLoadingSummary, loadingSummarySheets } = await import('../server/loading/summary.js');
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
  const s = buildLoadingSummary(flat(orders), { priceOf: (l) => l.offerPrice });
  assert.deepEqual(rowsOf(s), [
    // ALE46: 4 m² × 50 + 2 CNC × 10 = 220 (ortalama birim fiyat yalnızca cam: 50); 10 MM ayrı satır
    ['ALEGRAD', 'ALE46', '88.3 TEMPER LAMİNE', 2, 4, 50, 220, false],
    ['ALEGRAD', 'ALE46', '10 MM TEMPER', 1, 1, 24, 24, false],
    // ALE47 aynı cam ama başka sipariş: ayrı blok (siparişler arasında birleştirilmez); bedelsiz delik tutara girmez
    ['ALEGRAD', 'ALE47', '88.3 TEMPER LAMİNE', 3, 3, 50, 150, false],
    ['GLASSANDMORE', 'GLA61', '88.3 TEMPER LAMİNE', 1, 1, 40, 40, false],
  ]);
  const [ale] = s.customers;
  assert.deepEqual(ale.orders.map((o) => o.subtotal), [{ adet: 3, m2: 5, total: 244 }, { adet: 3, m2: 3, total: 150 }]);
  assert.deepEqual(ale.totals, { EUR: { adet: 6, m2: 8, total: 394 } });
  assert.deepEqual(s.totals, { EUR: { adet: 7, m2: 9, total: 434 } });
  // Fatura hesabıyla aynı tutar (aynı fonksiyon): sipariş ara toplamı = faturanın cam satırları toplamı
  assert.equal(glassLines(orders[0].offers[0]).reduce((a, l) => a + l.eurTotal, 0), 244);
  // Satış: yalnızca satış fiyatı
  const sales = buildLoadingSummary(flat(orders).map((o) => ({ ...o, lines: o.lines.map((l) => ({ ...l, offerPrice: null })) })), { priceOf: (l) => l.unitPrice });
  assert.equal(sales.totals.EUR.total, 4 * 30 + 2 * 5 + 20 + 3 * 30 + 25);
  // Excel (P3 — karar 241): "Firmalar" + düz "Döküm" (her kalem bir satır, sipariş blokları yok); toplam para birimi başına
  const empty = { name: '', orders: 0, camAdet: 0, cnc: 0, delik: 0, metraj: 0, netKg: 0, crates: 0, grossKg: 0, money: {} };
  const sheets = loadingSummarySheets({
    subtitle: '', stats: [['Sipariş', 3]], firms: [], total: empty, guests: [], details: [{ sheetName: 'Döküm', title: 'D', lines: s }],
    money: { sales: false, offer: true }, text: SUMMARY_TEXT,
  });
  assert.deepEqual(sheets.map((x) => x.name), ['Firmalar', 'Döküm']);
  assert.deepEqual(sheets[0].blocks.map((b) => b.title), ['F', 'G']);
  assert.equal(sheets[1].blocks.length, 1, 'düz tablo: tek blok');
  const [d] = sheets[1].blocks;
  assert.deepEqual(d.columns.map((c) => c.header), ['SİPARİŞ NO', 'MÜŞTERİ', 'PROJE', 'AÇIKLAMA', 'ADET', 'BİRİM', 'METRAJ', 'BİRİM FİYAT', 'TUTAR', 'Para birimi']);
  assert.deepEqual(d.rows, [
    ['ALE46', 'ALEGRAD', 'Adrian', '88.3 TEMPER LAMİNE', 2, 'm²', 4, 50, 220, 'EUR'],
    ['ALE46', 'ALEGRAD', 'Adrian', '10 MM TEMPER', 1, 'm²', 1, 24, 24, 'EUR'],
    ['ALE47', 'ALEGRAD', 'Sura Mica', '88.3 TEMPER LAMİNE', 3, 'm²', 3, 50, 150, 'EUR'],
    ['GLA61', 'GLASSANDMORE', '', '88.3 TEMPER LAMİNE', 1, 'm²', 1, 40, 40, 'EUR'],
  ]);
  assert.deepEqual(d.totals, [['', '', '', 'TOPLAM', 7, '', 9, '', 434, 'EUR']]);
  assert.equal(d.columns[6].type, 'm2', 'metraj 3 ondalık gösterim');
});

test('yükleme özeti: ağırlıklı ortalama birim fiyat Σ(m² × fiyat) / Σm²; birleştirme toplamı değiştirmez; para birimleri toplanmaz', async () => {
  const { buildLoadingSummary } = await import('../server/loading/summary.js');
  const { glassLines } = await import('../server/glass/billing.js');
  const G = '66.3 TEMPER LAMİNE CAM (REFLEKTE FÜME + ŞEFFAF)';
  const glass = (en, boy, adet, price) => ({ kind: 'CAM', unit: 'm2', description: G, descriptionRo: 'RO', enMm: en, boyMm: boy, adet, offerPrice: String(price), unitPrice: '1' });
  const hole = { kind: 'DELIK', unit: 'adet', description: 'Delik', adet: 2, offerPrice: '3', unitPrice: '1' };
  const ale40 = { status: 'GONDERILDI', currency: 'EUR', lines: [glass(1000, 2000, 3, 75), glass(1000, 1000, 4, 90), hole, glass(70, 1000, 1, 75)] };
  const orders = [
    { orderNo: 'ALE40', title: 'Adina', customer: { id: 'a', name: 'ALEGRAD' }, offers: [ale40] },
    { orderNo: 'ALE41', title: 'Sibiu', customer: { id: 'a', name: 'ALEGRAD' }, offers: [{ status: 'GONDERILDI', currency: 'EUR', lines: [glass(1000, 1000, 2, 75)] }] },
    { orderNo: 'ALE42', title: 'Lei', customer: { id: 'a', name: 'ALEGRAD' }, offers: [{ status: 'GONDERILDI', currency: 'RON', lines: [glass(1000, 1000, 1, 400)] }] },
  ];
  const s = buildLoadingSummary(flat(orders), { priceOf: (l) => l.offerPrice });
  // ALE40: 75'lik (6 + 0,07 m²) ve 90'lık (4 m²) cam aynı adla TEK satır: Σ(m² × fiyat) / Σm² = 815,25 / 10,07 = 80,96;
  // tutar = 450 + 360 + delik 6 + 5,25 = 821,25 (faturanın cam satırlarıyla aynı)
  assert.deepEqual(rowsOf(s), [
    ['ALEGRAD', 'ALE40', G, 8, 10.07, 80.96, 821.25, false],
    ['ALEGRAD', 'ALE41', G, 2, 2, 75, 150, false],
    ['ALEGRAD', 'ALE42', G, 1, 1, 400, 400, false],
  ]);
  assert.equal(glassLines(ale40).reduce((a, l) => a + l.eurTotal, 0), 821.25);
  // Birleştirme toplamı değiştirmez: fiyat başına ayrı satırların toplamıyla aynı
  const { glassTotals } = await import('../server/glass/billing.js');
  assert.equal(glassTotals(ale40, { nameOf: (l) => l.description, priceOf: (l) => l.offerPrice, byPrice: true }).reduce((a, g) => a + g.total, 0), 821.25);
  assert.deepEqual(s.customers[0].totals, { EUR: { adet: 10, m2: 12.07, total: 971.25 }, RON: { adet: 1, m2: 1, total: 400 } });
  assert.deepEqual(s.totals, { EUR: { adet: 10, m2: 12.07, total: 971.25 }, RON: { adet: 1, m2: 1, total: 400 } });
});

test('yükleme özeti: sandık parası faturadaki gibi camın tutarına eklenir (ayrı satır olmaz; birim fiyata girmez); bedelsiz telafi ayrı satır, tutar 0', async () => {
  const { buildLoadingSummary } = await import('../server/loading/summary.js');
  const { invoiceLines } = await import('../server/glass/billing.js');
  const glass = (adet, extra = {}) => ({ kind: 'CAM', unit: 'm2', description: '10 MM TEMPER', descriptionRo: 'Securizat 10', enMm: 1000, boyMm: 1000, adet, offerPrice: '24', unitPrice: '20', ...extra });
  const crateFee = { kind: 'CAM', unit: 'adet', description: 'Sandık parası', descriptionRo: 'Ambalaj (ladă)', adet: 1, offerPrice: '30', unitPrice: '25' };
  const offer = { status: 'GONDERILDI', currency: 'EUR', lines: [glass(2), crateFee, glass(1, { free: true, offerPrice: '0', compensationId: 'c1' })] };
  const orders = [
    { orderNo: 'ADE6', title: 'Radera', customer: { id: 'x', name: 'ADER GLASS' }, offers: [offer] },
    { orderNo: 'ADE7', title: 'Harry', customer: { id: 'x', name: 'ADER GLASS' }, offers: [{ status: 'GONDERILDI', currency: 'EUR', lines: [glass(3)] }] },
  ];
  const s = buildLoadingSummary(flat(orders), { priceOf: (l) => l.offerPrice });
  // ADE6: 2 m² × 24 + 30 sandık parası = 78 (birim fiyat camın: 24); bedelsiz telafi camı fiziksel satır, 0
  assert.deepEqual(rowsOf(s), [
    ['ADER GLASS', 'ADE6', '10 MM TEMPER', 2, 2, 24, 78, false],
    ['ADER GLASS', 'ADE6', '10 MM TEMPER', 1, 1, 0, 0, true],
    ['ADER GLASS', 'ADE7', '10 MM TEMPER', 3, 3, 24, 72, false],
  ]);
  assert.deepEqual(s.customers[0].orders[0].subtotal, { adet: 3, m2: 3, total: 78 }, 'fiziksel adet bedelsiz camı içerir; tutar içermez');
  // Fatura da aynı kuralla: tek cam satırı, sandık parası camın tutarında (2 × 24 + 30 = 78); bedelsiz cam faturada yok
  const inv = invoiceLines(offer, 1, 0);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].net, 78);
  assert.equal(s.totals.EUR.total, 150);
});
