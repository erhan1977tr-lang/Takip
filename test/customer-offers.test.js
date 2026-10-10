// Müşteri ana sayfası → "Tekliflerim" (karar 164): tarih aralığı, teklif seçimi (son gönderilen sürüm, gönderildiği yerel
// gün), toplamlar (para birimi başına) ve PDF dökümü (her teklif ayrı, sonda toplam m² ve tutar, TR / RO harfleri, logo).
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { OFFER_REPORT_MAX_DAYS, customerOfferReport, loadingParts, offerRange, offerReportFileName, offerWindow } from '../server/orders/customer-offers.js';
import { offerSummaryPdf } from '../server/pdf/offer-summary.js';
import { FONTS } from '../server/pdf/fonts.js';

const TZ = 'Europe/Bucharest';
const kindLabel = (k) => ({ CNC: 'CNC', DELIK: 'Delik' }[k] ?? k);
/** Müşteri görünümü: satırda unitPrice = müşteri fiyatı (lib/orders.ts → offerPrices); offerPrice boş */
const price = (l) => l.unitPrice;
const glass = (o) => ({ kind: 'CAM', unit: 'm2', free: false, poz: '', ...o });
const offer = (id, sentAt, lines, extra = {}) => ({ id, status: 'GONDERILDI', currency: 'EUR', sentAt: new Date(sentAt), createdAt: new Date(sentAt), lines, ...extra });
const order = (no, offers, extra = {}) => ({ id: `id-${no}`, orderNo: no, title: `Sipariş ${no}`, status: 'HAZIRLANIYOR', orderTypeCode: 'GLASS_ORDER', offers, ...extra });

test('tarih aralığı: boşsa bu ayın ilk günü → bugün; geçersiz / ters / çok uzun aralık reddedilir', () => {
  assert.deepEqual(offerRange({}, '2026-10-08'), { ok: true, from: '2026-10-01', to: '2026-10-08' });
  assert.deepEqual(offerRange({ bas: '2026-09-15', bit: '' }, '2026-10-08'), { ok: true, from: '2026-09-15', to: '2026-10-08' });
  assert.deepEqual(offerRange({ bas: '2026-02-30', bit: '2026-03-01' }, '2026-10-08').code, 'BAD_DATE');
  assert.deepEqual(offerRange({ bas: '01.10.2026' }, '2026-10-08').code, 'BAD_DATE');
  assert.deepEqual(offerRange({ bas: '2026-10-09', bit: '2026-10-08' }, '2026-10-08').code, 'ORDER');
  assert.equal(offerRange({ bas: '2025-01-01', bit: '2026-10-08' }, '2026-10-08').code, 'TOO_LONG');
  assert.ok(offerRange({ bas: '2025-09-04', bit: '2026-10-08' }, '2026-10-08').ok, `${OFFER_REPORT_MAX_DAYS} gün sığar`);
  assert.equal(offerRange({ bas: { $gt: '' } }, '2026-10-08').ok, true, 'metin olmayan değer yok sayılır (varsayılan)');
  // Sorgu penceresi yerel gün sınırlarını kapsar (Romanya saati UTC+2/+3)
  const w = offerWindow({ from: '2026-10-01', to: '2026-10-31' });
  assert.ok(w.gte <= new Date('2026-09-30T21:00:00Z') && w.lt >= new Date('2026-10-31T21:00:00Z'));
});

test('teklif seçimi: siparişin müşteriye gönderilmiş SON sürümü; yükleme tarihi olmayan sipariş, teklifi aralıkta gönderildiyse "tarihsiz" grupta; iptal, profil ve gönderilmemiş teklif yok', () => {
  const l1 = [glass({ description: 'Securizat 8mm', descriptionRo: 'Securizat 8mm', enMm: 1000, boyMm: 2000, adet: 3, unitPrice: '50' })];
  const orders = [
    // v1 eylülde, v2 ekimde: yalnızca v2 sayılır (sürüm 2)
    order('GLA1', [offer('b', '2026-10-02T08:00:00Z', [glass({ description: 'Temper', enMm: 1000, boyMm: 1000, adet: 2, unitPrice: '40' })]), offer('a', '2026-09-20T08:00:00Z', l1)]),
    // Yerel gün sınırı: 31.10 23:30 Bucharest = 31.10 20:30Z (içeride); 31.10 22:30Z = 01.11 yerel (dışarıda)
    order('GLA2', [offer('c', '2026-10-31T20:30:00Z', l1)]),
    order('GLA3', [offer('d', '2026-10-31T22:30:00Z', l1)]),
    order('GLA4', [offer('e', '2026-10-05T08:00:00Z', l1)], { status: 'IPTAL' }),
    order('GLAP5', [offer('f', '2026-10-05T08:00:00Z', l1)], { orderTypeCode: 'PROFILE_ORDER' }),
    order('GLA6', [offer('g', '2026-10-05T08:00:00Z', l1, { status: 'YONETIMDE' })]),
    // RON teklif: ayrı para birimi toplamı
    order('GLA7', [offer('h', '2026-10-06T08:00:00Z', [glass({ description: 'Float', enMm: 500, boyMm: 500, adet: 4, unitPrice: '10' })], { currency: 'RON' })]),
  ];
  const r = customerOfferReport(orders, { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'ro', kindLabel, price });
  assert.deepEqual(r.sections.map((s) => [s.orderNo, s.day, s.offerDay, s.version, s.currency]), [['GLA1', null, '2026-10-02', 2, 'EUR'], ['GLA2', null, '2026-10-31', 1, 'EUR'], ['GLA7', null, '2026-10-06', 1, 'RON']]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].day, null);
  // GLA1: 1 m² × 2 × 40 = 80 · GLA2: 2 m² × 3 × 50 = 300 → EUR 2 sipariş, 8 m², 5 cam, 380; RON: 0,25 × 4 = 1 m² × 10
  assert.deepEqual(r.totals, [{ currency: 'EUR', count: 2, m2: 8, pieces: 5, amount: 380 }, { currency: 'RON', count: 1, m2: 1, pieces: 4, amount: 10 }]);
  assert.equal(r.orders, 3);
  assert.deepEqual(r.sections[0].data.rows.map((x) => [x.desc, x.m2, x.unitPrice, x.amount]), [['Temper', 2, 40, 80]]);
  // Eylül aralığında GLA1'in v1'i dökümde YOK (son sürüm ekimde)
  assert.deepEqual(customerOfferReport(orders, { from: '2026-09-01', to: '2026-09-30', timeZone: TZ, locale: 'tr', kindLabel, price }).sections, []);
});

test('yükleme gününe göre gruplar: aralık YÜKLEME gününe uygulanır; teklifi aralıktan önce gönderilmiş sipariş de yüklemesiyle gelir; gruplar gün sırasıyla', () => {
  const l = (adet, p = '10') => [glass({ description: 'Temper', enMm: 1000, boyMm: 1000, adet, unitPrice: p })];
  const orders = [
    order('GLA20', [offer('a', '2026-09-10T08:00:00Z', l(2))], { estimatedShipDate: new Date('2026-10-02T00:00:00Z') }),
    order('GLA21', [offer('b', '2026-09-25T08:00:00Z', l(3))], { estimatedShipDate: new Date('2026-10-02T00:00:00Z') }),
    // Gerçek yükleme günü planlanandan önce gelir
    order('GLA22', [offer('c', '2026-09-26T08:00:00Z', l(1))], { estimatedShipDate: new Date('2026-10-20T00:00:00Z'), actualShipDate: new Date('2026-10-09T00:00:00Z') }),
    // Aralık dışı yükleme: teklif aralıkta gönderilmiş olsa da yok
    order('GLA23', [offer('d', '2026-10-05T08:00:00Z', l(1))], { estimatedShipDate: new Date('2026-11-04T00:00:00Z') }),
  ];
  const r = customerOfferReport(orders, { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'tr', kindLabel, price });
  assert.deepEqual(r.groups.map((g) => [g.day, g.sections.map((s) => s.orderNo)]), [['2026-10-02', ['GLA20', 'GLA21']], ['2026-10-09', ['GLA22']]]);
  assert.deepEqual(r.groups[0].totals, [{ currency: 'EUR', count: 2, m2: 5, pieces: 5, amount: 50 }]);
  assert.equal(r.sections[0].offerDay, '2026-09-10', 'teklif tarihi ayrı alan: yükleme günüyle karışmaz');
  assert.ok(!r.sections.some((s) => s.orderNo === 'GLA23'));
  // Yalnız eylül: hiçbir yükleme yok (teklif tarihleri eylülde olsa da gruplar yükleme gününe göredir)
  assert.equal(customerOfferReport(orders, { from: '2026-09-01', to: '2026-09-30', timeZone: TZ, locale: 'tr', kindLabel, price }).sections.length, 0);
});

/** Onay kalemi (GEÇERLİ hâl effectiveItems ile seçilir) */
const item = (o) => ({ confirmationId: 'c1', replanId: null, revision: 0, status: 'LOADED', ...o, confirmation: { shipDay: new Date(`${o.day}T00:00:00Z`) } });

test('kısmi yükleme: satır onaylı yüklemeye, etkin aktarıma ve tarihsiz kalana BÖLÜNÜR; bölümlerin toplamı siparişin ticari toplamına eşit, hiçbir grup tam tutarı iki kez almaz', () => {
  // 7 adet 1213 × 1517 (m² yuvarlaması bölümde de kalemin toplamından), 1 cam + CNC (işlem ilk yüklemede)
  const lines = [
    glass({ id: 'L1', description: 'Laminat 4.4.2', enMm: 1213, boyMm: 1517, adet: 7, unitPrice: '49.37' }),
    glass({ id: 'L2', description: 'Temper 10', enMm: 800, boyMm: 900, adet: 1, unitPrice: '33.33' }),
    { id: 'L3', kind: 'CNC', description: 'CNC', adet: 2, unit: 'adet', unitPrice: '12.5', free: false },
  ];
  const full = customerOfferReport([order('GLA30', [offer('x', '2026-09-20T08:00:00Z', lines)], { estimatedShipDate: new Date('2026-10-02T00:00:00Z') })],
    { from: '2026-09-01', to: '2026-12-31', timeZone: TZ, locale: 'tr', kindLabel, price });
  assert.equal(full.sections.length, 1);
  const whole = full.totals[0];

  const split = order('GLA30', [offer('x', '2026-09-20T08:00:00Z', lines)], {
    estimatedShipDate: new Date('2026-10-02T00:00:00Z'),
    loadedItems: [
      // 02.10 onayı: L1'den 4 yüklendi (önce 3 yazılmış, düzeltmeyle 4 — revision 1 geçerli), 3 yüklenmedi; L2 ve CNC tam
      item({ day: '2026-10-02', offerLineId: 'L1', quantity: 3 }), item({ day: '2026-10-02', offerLineId: 'L1', quantity: 4, status: 'NOT_LOADED' }),
      item({ day: '2026-10-02', offerLineId: 'L1', quantity: 4, revision: 1 }), item({ day: '2026-10-02', offerLineId: 'L1', quantity: 3, revision: 1, status: 'NOT_LOADED' }),
      item({ day: '2026-10-02', offerLineId: 'L2', quantity: 1 }), item({ day: '2026-10-02', offerLineId: 'L3', quantity: 2 }),
      // 09.10'a aktarılan 1 adet yüklendi (aktarımın onay kalemi)
      item({ confirmationId: 'c2', replanId: 'r1', day: '2026-10-09', offerLineId: 'L1', quantity: 1 }),
    ],
    replans: [
      { status: 'ACTIVE', quantity: 1, shipDay: new Date('2026-10-16T00:00:00Z'), sourceItem: { offerLineId: 'L1' } },
      { status: 'CANCELLED', quantity: 1, shipDay: new Date('2026-10-23T00:00:00Z'), sourceItem: { offerLineId: 'L1' } }, // sayılmaz
    ],
  });
  const r = customerOfferReport([split], { from: '2026-09-01', to: '2026-12-31', timeZone: TZ, locale: 'tr', kindLabel, price });
  assert.deepEqual(r.sections.map((s) => [s.day, s.partial, s.data.rows.map((x) => `${x.desc}×${x.adet}`).join(',')]), [
    ['2026-10-02', true, 'Laminat 4.4.2×4,Temper 10×1,CNC×2'],
    ['2026-10-09', true, 'Laminat 4.4.2×1'],
    ['2026-10-16', true, 'Laminat 4.4.2×1'],
    [null, true, 'Laminat 4.4.2×1'],
  ]);
  // Çift sayım yok: m², adet ve tutar bölünmemiş siparişle KURUŞU KURUŞUNA aynı; sipariş genel toplamda bir kez sayılır
  assert.deepEqual(r.totals, [whole]);
  assert.equal(r.totals[0].count, 1);
  const sumC = (k) => r.sections.reduce((s, x) => s + Math.round(x.data[k] * 100), 0) / 100;
  assert.equal(sumC('total'), whole.amount);
  assert.equal(sumC('metraj'), whole.m2);
  // Her grup yalnızca kendi bölümünün tutarını taşır (tam tutar değil)
  for (const g of r.groups) assert.ok(g.totals[0].amount < whole.amount, `${g.day}: ${g.totals[0].amount}`);
  // Aralık yükleme gününe: yalnız 09.10 → yalnızca o bölüm (+ siparişin tarihsiz kalanı)
  const one = customerOfferReport([split], { from: '2026-10-09', to: '2026-10-09', timeZone: TZ, locale: 'tr', kindLabel, price });
  assert.deepEqual(one.sections.map((s) => s.day), ['2026-10-09', null]);
});

test('loadingParts: onay kalemi teklif satırlarına bağlanamıyorsa sipariş bölünmez (ilk onay günü); onayı olmayan sipariş planlanan günde', () => {
  const lines = [glass({ id: 'N1', description: 'Temper', enMm: 1000, boyMm: 1000, adet: 2, unitPrice: '10' })];
  assert.deepEqual(loadingParts({ estimatedShipDate: new Date('2026-10-02T00:00:00Z') }, { lines }).map((p) => p.day), ['2026-10-02']);
  assert.deepEqual(loadingParts({}, { lines }).map((p) => p.day), [null]);
  const stale = loadingParts({ estimatedShipDate: new Date('2026-10-02T00:00:00Z'), loadedItems: [item({ day: '2026-10-05', offerLineId: 'ESKI', quantity: 2 })] }, { lines });
  assert.deepEqual(stale.map((p) => [p.day, p.lines.length]), [['2026-10-05', 1]]);
});

test('dosya adı seçili panel dilinde; tarih aralığıyla', () => {
  // Ortak dosya adı kuralı (Paket 7, server/files/export-name.js): ad seçili panel dilinde, harfler Latin karşılığıyla
  assert.equal(offerReportFileName('Tekliflerim', { from: '2026-10-01', to: '2026-10-31' }), 'Tekliflerim-2026-10-01_2026-10-31.pdf');
  assert.equal(offerReportFileName('Ofertele Mele', { from: '2026-10-01', to: '2026-10-31' }), 'Ofertele-Mele-2026-10-01_2026-10-31.pdf');
  assert.equal(offerReportFileName('Ofertele mele / ș"', { from: '2026-10-01', to: '2026-10-02' }), 'Ofertele-mele-s-2026-10-01_2026-10-02.pdf', 'başlıkta tırnak / bölü olmaz');
  assert.equal(offerReportFileName('', { from: '2026-10-01', to: '2026-10-02' }), '2026-10-01_2026-10-02.pdf');
});

// ---------- PDF: metin çıkarma (gömülü yazı tipinin glif → Unicode eşlemesiyle) ----------
const REVERSE = Object.fromEntries(['Regular', 'Bold'].map((k) => [k, new Map(FONTS[k].map.map(([cp, gid]) => [gid, cp]))]));
function pdfLines(pdf) {
  const out = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  const s = pdf.toString('latin1');
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length;
    let ops;
    try { ops = zlib.inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1'); } catch { continue; }
    for (const t of ops.matchAll(/\/(F1|F2) [\d.]+ Tf [\d.-]+ [\d.-]+ Td <([0-9a-f]*)> Tj/g)) {
      const map = REVERSE[t[1] === 'F2' ? 'Bold' : 'Regular'];
      out.push((t[2].match(/.{4}/g) ?? []).map((h) => String.fromCodePoint(map.get(parseInt(h, 16)) ?? 63)).join(''));
    }
  }
  return out;
}

const TEXT = (locale) => (locale === 'tr' ? {
  title: 'TEKLİFLERİM', firm: 'Ünsal Cam Şirketi', range: '01.10.2026 – 31.10.2026', generated: 'Oluşturulma: 08.10.2026', offerDate: 'Teklif tarihi', version: 'sürüm {n}',
  loadingDate: 'Yükleme', noDate: 'Yükleme tarihi henüz belli değil', partial: 'Kısmi yükleme — siparişin bu yüklemedeki bölümü', continued: 'devam',
  cols: { n: '#', desc: 'Açıklama', poz: 'Poz', en: 'En (mm)', boy: 'Boy (mm)', adet: 'Adet', um: 'Birim', m2: 'Metraj', unitPrice: 'Birim fiyat', amount: 'Tutar' },
  free: 'bedelsiz', piece: 'adet', groupTotal: 'Yükleme toplamı', grandTotal: 'Genel toplam', count: '{n} sipariş', pieces: '{n} adet', empty: 'Bu tarih aralığında teklif yok.',
  notes: ['Fiyatlara KDV dahil değildir.'],
} : {
  title: 'OFERTELE MELE', firm: 'Glass și Ușă SRL', range: '01.10.2026 – 31.10.2026', generated: 'Generat: 08.10.2026', offerDate: 'Data ofertei', version: 'versiunea {n}',
  loadingDate: 'Termen', noDate: 'Data de încărcare nu este încă stabilită', partial: 'Încărcare parțială — partea comenzii din această încărcare', continued: 'continuare',
  cols: { n: '#', desc: 'Descriere', poz: 'Poz', en: 'Lățime', boy: 'Înălțime', adet: 'Buc', um: 'U.M.', m2: 'Metraj', unitPrice: 'Preț unitar', amount: 'Valoare' },
  free: 'gratuit', piece: 'buc', groupTotal: 'Total încărcare', grandTotal: 'Total general', count: 'Comenzi: {n}', pieces: '{n} buc.', empty: 'Nu există oferte în acest interval.',
  notes: ['Prețurile nu includ TVA.', 'Cursul de vânzare BT din ziua facturii.'],
});

test('PDF: yükleme günü başlıkları; her sipariş ayrı başlıkla (yükleme + teklif tarihi); metraj 3 ondalık; grup ve genel toplam; TR / RO harfleri; satış fiyatı yok', () => {
  const orders = [
    order('UNS12', [offer('a', '2026-09-28T08:00:00Z', [glass({ description: 'Securizat 8mm șlefuit', enMm: 1000, boyMm: 2000, adet: 3, unitPrice: '41.5' })]), offer('z', '2026-09-02T08:00:00Z', [])],
      { title: 'Duș cabină — ıııi', estimatedShipDate: new Date('2026-10-02T00:00:00Z') }),
    order('UNS13', [offer('b', '2026-10-03T08:00:00Z', [glass({ description: 'Temper ğüşöç', enMm: 500, boyMm: 1000, adet: 4, unitPrice: '30' }), { kind: 'CNC', description: 'CNC', adet: 2, unit: 'adet', unitPrice: '15', free: false }])],
      { estimatedShipDate: new Date('2026-10-09T00:00:00Z') }),
  ];
  const report = customerOfferReport(orders, { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'tr', kindLabel, price });
  const lines = pdfLines(offerSummaryPdf(report, TEXT('tr')));
  const has = (s) => lines.some((l) => l.includes(s));
  for (const s of ['TEKLİFLERİM', 'Ünsal Cam Şirketi', 'Yükleme: 02.10.2026', 'Yükleme: 09.10.2026', 'UNS12 — Duș cabină — ıııi', 'Teklif tarihi: 28.09.2026', 'sürüm 2',
    'UNS13', 'Securizat 8mm șlefuit', 'Temper ğüşöç', '6,000', 'Yükleme toplamı', 'Genel toplam', '2 sipariş', '7 adet']) {
    assert.ok(has(s), `PDF'te yok: ${s}\n${lines.join(' | ')}`);
  }
  // Bölüm / grup / genel toplam: UNS12 6 m² × 41,5 = 249; UNS13 2 m² × 30 + 2 × 15 = 90 → 8 m², 339 EUR
  assert.ok(has('249,00 EUR') && has('90,00 EUR') && has('339,00 EUR'), lines.join(' | '));
  assert.ok(has('6,000 m²') && has('2,000 m²') && has('8,000 m²'), lines.join(' | '));
  // Yükleme günü sırası: 02.10 başlığı 09.10'dan önce
  assert.ok(lines.findIndex((l) => l.includes('Yükleme: 02.10.2026')) < lines.findIndex((l) => l.includes('Yükleme: 09.10.2026')));
  assert.ok(!lines.some((l) => l.includes('?')), 'yazı tipinde olmayan karakter yok');
  // Romence döküm: başlıklar ve sütunlar Romence
  const ro = pdfLines(offerSummaryPdf(customerOfferReport(orders, { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'ro', kindLabel, price }), TEXT('ro')));
  for (const s of ['OFERTELE MELE', 'Glass și Ușă SRL', 'Descriere', 'Lățime', 'Înălțime', 'U.M.', 'Termen: 02.10.2026', 'Total general', 'Comenzi: 2', 'Data ofertei: 03.10.2026', 'Cursul de vânzare BT din ziua facturii.']) {
    assert.ok(ro.some((l) => l.includes(s)), `RO PDF'te yok: ${s}`);
  }
  // Boş aralık: belge yine üretilir, "teklif yok" yazar
  const empty = pdfLines(offerSummaryPdf(customerOfferReport([], { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'tr', kindLabel, price }), TEXT('tr')));
  assert.ok(empty.includes('Bu tarih aralığında teklif yok.'));
  assert.ok(!empty.some((l) => l.includes('Genel toplam')));
});

test('PDF: kısmi yüklenen sipariş her günde yalnızca kendi bölümüyle; genel toplam bölünmemiş siparişle aynı', () => {
  const lines = [glass({ id: 'L1', description: 'Laminat', enMm: 1000, boyMm: 1000, adet: 5, unitPrice: '10' })];
  const o = order('UNS40', [offer('x', '2026-09-20T08:00:00Z', lines)], {
    estimatedShipDate: new Date('2026-10-02T00:00:00Z'),
    loadedItems: [item({ day: '2026-10-02', offerLineId: 'L1', quantity: 3 }), item({ day: '2026-10-02', offerLineId: 'L1', quantity: 2, status: 'NOT_LOADED' })],
    replans: [{ status: 'ACTIVE', quantity: 2, shipDay: new Date('2026-10-09T00:00:00Z'), sourceItem: { offerLineId: 'L1' } }],
  });
  const pdf = pdfLines(offerSummaryPdf(customerOfferReport([o], { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'tr', kindLabel, price }), TEXT('tr')));
  assert.ok(pdf.includes('30,00 EUR') && pdf.includes('20,00 EUR'), pdf.join(' | '));
  assert.ok(pdf.some((l) => l.includes('Kısmi yükleme')));
  // Genel toplam 50 EUR (5 m² × 10) — 2 × 50 değil
  assert.ok(pdf.includes('50,00 EUR') && !pdf.includes('100,00 EUR'), pdf.join(' | '));
});

test('PDF: çok siparişli döküm sayfalara bölünür; her sayfada numara; uzun sipariş sonraki sayfada "devam" başlığıyla sürer', () => {
  const many = Array.from({ length: 30 }, (_, i) => order(`UNS${100 + i}`, [offer(`o${i}`, '2026-10-05T08:00:00Z', Array.from({ length: 6 }, (_, j) => glass({ description: `Cam ${j}`, enMm: 1000, boyMm: 1000, adet: 1, unitPrice: '10' })))],
    { estimatedShipDate: new Date(`2026-10-${String(1 + (i % 3)).padStart(2, '0')}T00:00:00Z`) }));
  many.push(order('UNS999', [offer('long', '2026-10-05T08:00:00Z', Array.from({ length: 80 }, (_, j) => glass({ description: `Uzun ${j}`, enMm: 1000, boyMm: 1000, adet: 1, unitPrice: '1' })))], { estimatedShipDate: new Date('2026-10-04T00:00:00Z') }));
  const report = customerOfferReport(many, { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'tr', kindLabel, price });
  const pdf = offerSummaryPdf(report, TEXT('tr'));
  const pages = (pdf.toString('latin1').match(/\/Type \/Page /g) ?? []).length;
  assert.ok(pages >= 6, `sayfa: ${pages}`);
  const lines = pdfLines(pdf);
  assert.ok(lines.includes(`1 / ${pages}`) && lines.includes(`${pages} / ${pages}`));
  assert.ok(lines.some((l) => l.includes('UNS999') && l.includes('(devam)')));
  assert.ok(lines.some((l) => l.includes('31 sipariş')) && lines.some((l) => l.includes('1.880,00 EUR')), 'genel toplam: 30 × 6 × 10 + 80');
});
