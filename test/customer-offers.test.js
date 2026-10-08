// Müşteri ana sayfası → "Tekliflerim" (karar 164): tarih aralığı, teklif seçimi (son gönderilen sürüm, gönderildiği yerel
// gün), toplamlar (para birimi başına) ve PDF dökümü (her teklif ayrı, sonda toplam m² ve tutar, TR / RO harfleri, logo).
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { OFFER_REPORT_MAX_DAYS, customerOfferReport, offerRange, offerReportFileName, offerWindow } from '../server/orders/customer-offers.js';
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

test('teklif seçimi: siparişin müşteriye gönderilmiş SON sürümü, gönderildiği YEREL gün aralıkta; iptal, profil ve gönderilmemiş teklif yok', () => {
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
  assert.deepEqual(r.sections.map((s) => [s.orderNo, s.day, s.version, s.currency]), [['GLA1', '2026-10-02', 2, 'EUR'], ['GLA7', '2026-10-06', 1, 'RON'], ['GLA2', '2026-10-31', 1, 'EUR']]);
  // GLA1: 1 m² × 2 × 40 = 80 · GLA2: 2 m² × 3 × 50 = 300 → EUR 2 teklif, 8 m², 380; RON: 0,25 × 4 = 1 m² × 10
  assert.deepEqual(r.totals, [{ currency: 'EUR', count: 2, m2: 8, amount: 380 }, { currency: 'RON', count: 1, m2: 1, amount: 10 }]);
  assert.deepEqual(r.sections[0].data.rows.map((x) => [x.desc, x.m2, x.unitPrice, x.amount]), [['Temper', 2, 40, 80]]);
  // Eylül aralığında GLA1'in v1'i dökümde YOK (son sürüm ekimde)
  assert.deepEqual(customerOfferReport(orders, { from: '2026-09-01', to: '2026-09-30', timeZone: TZ, locale: 'tr', kindLabel, price }).sections, []);
});

test('fiyat: yalnızca çağıranın verdiği müşteri fiyatı kullanılır; işlem satırları, bedelsiz satır ve bölünmüş parça teklif PDF kuralıyla aynı', () => {
  const lines = [
    glass({ description: 'Securizat 8mm', enMm: 1000, boyMm: 2000, adet: 1, unitPrice: '50', offerPrice: null }),
    { kind: 'CNC', description: 'CNC', adet: 2, unit: 'adet', unitPrice: '10', free: false },
    { kind: 'DELIK', description: 'Delik', adet: 3, unit: 'adet', unitPrice: '0', free: true },
    glass({ description: 'Telafi', enMm: 1000, boyMm: 1000, adet: 1, unitPrice: '0', free: true }),
  ];
  const r = customerOfferReport([order('GLA9', [offer('x', '2026-10-03T08:00:00Z', lines)])], { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'tr', kindLabel, price });
  assert.deepEqual(r.sections[0].data.rows.map((x) => [x.n, x.desc, x.m2, x.amount, x.free]), [
    [1, 'Securizat 8mm', 2, 100, false], [null, 'CNC', null, 20, false], [null, 'Delik', null, 0, true], [2, 'Telafi', 1, 0, true],
  ]);
  assert.deepEqual(r.totals, [{ currency: 'EUR', count: 1, m2: 3, amount: 120 }]);
  // Satırda başka fiyat alanı olsa da kullanılmaz (fabrika / satış fiyatı dökümüne girmez)
  const leak = customerOfferReport([order('GLA9', [offer('x', '2026-10-03T08:00:00Z', [glass({ description: 'C', enMm: 1000, boyMm: 1000, adet: 1, unitPrice: '50', salesPrice: '999', listPrice: '777' })])])],
    { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'tr', kindLabel, price });
  assert.equal(leak.sections[0].data.total, 50);
});

test('dosya adı seçili panel dilinde; tarih aralığıyla', () => {
  assert.equal(offerReportFileName('tekliflerim', { from: '2026-10-01', to: '2026-10-31' }), 'tekliflerim-2026-10-01_2026-10-31.pdf');
  assert.equal(offerReportFileName('ofertele-mele', { from: '2026-10-01', to: '2026-10-31' }), 'ofertele-mele-2026-10-01_2026-10-31.pdf');
  assert.equal(offerReportFileName('Ofertele mele / ș"', { from: '2026-10-01', to: '2026-10-02' }), 'ofertele-mele-s-2026-10-01_2026-10-02.pdf', 'başlıkta tırnak / bölü olmaz');
  assert.equal(offerReportFileName('', { from: '2026-10-01', to: '2026-10-02' }), 'oferte-2026-10-01_2026-10-02.pdf');
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
  cols: { n: '#', desc: 'Açıklama', poz: 'Poz', en: 'En (mm)', boy: 'Boy (mm)', adet: 'Adet', m2: 'Metraj', unitPrice: 'Birim fiyat', amount: 'Tutar' },
  free: 'bedelsiz', piece: 'adet', subtotal: 'Teklif toplamı', grandTotal: 'Genel toplam', count: '{n} teklif', empty: 'Bu tarih aralığında teklif yok.',
  notes: ['Fiyatlara KDV dahil değildir.'],
} : {
  title: 'OFERTELE MELE', firm: 'Glass și Ușă SRL', range: '01.10.2026 – 31.10.2026', generated: 'Generat: 08.10.2026', offerDate: 'Data ofertei', version: 'versiunea {n}',
  cols: { n: '#', desc: 'Descriere', poz: 'Poz', en: 'Lățime', boy: 'Înălțime', adet: 'Buc', m2: 'Metraj', unitPrice: 'Preț unitar', amount: 'Valoare' },
  free: 'gratuit', piece: 'buc', subtotal: 'Total ofertă', grandTotal: 'Total general', count: 'Oferte: {n}', empty: 'Nu există oferte în acest interval.',
  notes: ['Prețurile nu includ TVA.', 'Cursul de vânzare BT din ziua facturii.'],
});

test('PDF: her teklif ayrı ve ayrıntılı; sonda genel toplam (m² ve tutar, para birimi başına); TR / RO harfleri gömülü yazı tipiyle; satış fiyatı yok', () => {
  const orders = [
    order('UNS12', [offer('a', '2026-10-02T08:00:00Z', [glass({ description: 'Securizat 8mm șlefuit', enMm: 1000, boyMm: 2000, adet: 3, unitPrice: '41.5' })]), offer('z', '2026-09-02T08:00:00Z', [])], { title: 'Duș cabină — ıııi' }),
    order('UNS13', [offer('b', '2026-10-03T08:00:00Z', [glass({ description: 'Temper ğüşöç', enMm: 500, boyMm: 1000, adet: 4, unitPrice: '30' }), { kind: 'CNC', description: 'CNC', adet: 2, unit: 'adet', unitPrice: '15', free: false }])]),
  ];
  const report = customerOfferReport(orders, { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'tr', kindLabel, price });
  const lines = pdfLines(offerSummaryPdf(report, TEXT('tr')));
  const has = (s) => lines.some((l) => l.includes(s));
  for (const s of ['TEKLİFLERİM', 'Ünsal Cam Şirketi', 'UNS12 — Duș cabină — ıııi', 'Teklif tarihi: 02.10.2026 · sürüm 2', 'UNS13', 'Securizat 8mm șlefuit', 'Temper ğüşöç', 'Genel toplam', '2 teklif']) {
    assert.ok(has(s), `PDF'te yok: ${s}\n${lines.join(' | ')}`);
  }
  // Teklif toplamları ve genel toplam: UNS12 6 m² × 41,5 = 249; UNS13 2 m² × 30 + 2 × 15 = 90 → 8 m², 339 EUR
  assert.ok(has('249,00 EUR') && has('90,00 EUR') && has('339,00 EUR'), lines.join(' | '));
  assert.ok(has('6 m²') && has('2 m²') && has('8 m²'), lines.join(' | '));
  assert.ok(!lines.some((l) => l.includes('?')), 'yazı tipinde olmayan karakter yok');
  // Romence döküm: başlıklar ve sütunlar Romence
  const ro = pdfLines(offerSummaryPdf(customerOfferReport(orders, { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'ro', kindLabel, price }), TEXT('ro')));
  for (const s of ['OFERTELE MELE', 'Glass și Ușă SRL', 'Descriere', 'Lățime', 'Înălțime', 'Total general', 'Oferte: 2', 'Data ofertei: 03.10.2026', 'Cursul de vânzare BT din ziua facturii.']) {
    assert.ok(ro.some((l) => l.includes(s)), `RO PDF'te yok: ${s}`);
  }
  // Boş aralık: belge yine üretilir, "teklif yok" yazar
  const empty = pdfLines(offerSummaryPdf(customerOfferReport([], { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'tr', kindLabel, price }), TEXT('tr')));
  assert.ok(empty.includes('Bu tarih aralığında teklif yok.'));
  assert.ok(!empty.some((l) => l.includes('Genel toplam')));
});

test('PDF: çok teklifli döküm sayfalara bölünür; her sayfada numara; teklif başlığı tablodan ayrı düşmez', () => {
  const many = Array.from({ length: 30 }, (_, i) => order(`UNS${100 + i}`, [offer(`o${i}`, '2026-10-05T08:00:00Z', Array.from({ length: 6 }, (_, j) => glass({ description: `Cam ${j}`, enMm: 1000, boyMm: 1000, adet: 1, unitPrice: '10' })))]));
  const report = customerOfferReport(many, { from: '2026-10-01', to: '2026-10-31', timeZone: TZ, locale: 'tr', kindLabel, price });
  const pdf = offerSummaryPdf(report, TEXT('tr'));
  const pages = (pdf.toString('latin1').match(/\/Type \/Page /g) ?? []).length;
  assert.ok(pages >= 4, `sayfa: ${pages}`);
  const lines = pdfLines(pdf);
  assert.ok(lines.includes(`1 / ${pages}`) && lines.includes(`${pages} / ${pages}`));
  assert.ok(lines.some((l) => l.includes('30 teklif')) && lines.some((l) => l.includes('1.800,00 EUR')), 'genel toplam: 30 × 6 × 10');
});
