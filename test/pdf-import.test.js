// Fabrika PDF'i aktarımı (karar 255) — saf kurallar: satır kurma, ayrıştırma, cam cinsi / PVB kodu, katalog eşleşmesi,
// müşteri / proje denetimi, işlem satırları, iskonto, A / B denetimleri ve teklif satırı planı. Fikstürler SENTETİKTİR:
// gerçek müşteri adı ve ticari fiyat yoktur (firma "MUSTERIX", kod ABC; fiyatlar uydurma). Gerçek fabrika PDF'leri depoya girmez.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLines } from '../server/orders/pdf-import/lines.js';
import { checkSubtotal, discountBp, expectedAmount, milli, moneyCents, parseFactoryOrder } from '../server/orders/pdf-import/parse.js';
import { catalogGlassSignature, factoryGlassSignature, glassCandidates, orderGlassVerdict } from '../server/orders/pdf-import/glass.js';
import { buildImportPlan, opKindOf, projectCheck, projectRefs } from '../server/orders/pdf-import/plan.js';
import { extractTextItems, PDF_IMPORT_LIMITS } from '../server/orders/pdf-import/extract.js';
import { PdfDoc } from '../server/pdf/pdf.js';

import { DESC_BRONZE, DESC_TENTESOL, DESC_UC, FORM_CNC, form } from './fixtures/factory-pdf.js';

// ---------------------------------------------------------------- satırlar
test('satır kurma: aynı sayfada yakın taban çizgileri tek satır, soldan sağa; sayfa sırası korunur; boş parça atılır', () => {
  const lines = buildLines([
    { page: 1, x: 300, y: 166.79, str: '3960' }, { page: 1, x: 28, y: 156, str: '1' }, { page: 1, x: 37, y: 155.9, str: '6 mm Temperli' },
    { page: 1, x: 355, y: 166.47, str: '1' }, { page: 1, x: 318, y: 166.6, str: '1160' }, { page: 1, x: 400, y: 166.5, str: '   ' },
    { page: 2, x: 10, y: 20, str: 'ikinci sayfa' },
  ]);
  assert.deepEqual(lines.map((l) => [l.page, l.text]), [[1, '1 6 mm Temperli'], [1, '3960 1160 1'], [2, 'ikinci sayfa']]);
});

// ---------------------------------------------------------------- ayrıştırma
test('sayılar: Türkçe biçim → kuruş / binde bir / yüzde×100; geçersiz biçim null', () => {
  assert.deepEqual([moneyCents('1.183,44'), moneyCents('7,50'), moneyCents('7,5'), milli('4,594'), milli('1.234,567'), discountBp('0,0'), discountBp('12,5'), discountBp('101')], [118344, 750, null, 4594, 1234567, 0, 1250, null]);
  assert.equal(expectedAmount(4594, 9000, 0), 41346); // 4,594 × 90,00
  assert.equal(expectedAmount(10000, 10000, 1000), 90000); // 10 × 100 × 0,9
});

test('başlık: fabrika sipariş no = büyük numara (121.001 DEĞİL), tarihler, proje; müşteri adı (alıcı) kullanılmaz', () => {
  const p = parseFactoryOrder(FORM_CNC);
  assert.deepEqual(p.header, { factoryNo: '90001', orderDate: '2026-09-01', deliveryDate: '2026-10-01', project: 'MUSTERIX ABC 40' });
  // Numara aynı satırda olmayabilir (büyük yazı): ayrı satırda da bulunur
  const alone = parseFactoryOrder(form({ no: '', rows: FORM_CNC.slice(7, 13).map((l) => l.text), total: '2 4,235 433,50', sub: '433,50', grand: '520,20', extraHead: [] }).map((l, i) => (i === 0 ? { ...l, text: '90002' } : l)));
  assert.equal(alone.header.factoryNo, '90002');
  const two = parseFactoryOrder(form({ no: '90001 90003', rows: FORM_CNC.slice(7, 13).map((l) => l.text), total: '2 4,235 433,50', sub: '433,50', grand: '520,20' }));
  assert.ok(two.problems.some((x) => x.code === 'FACTORY_NO_AMBIGUOUS'));
});

test('tablo: cam satırı (alt alta ve tek satırda), işlem satırı kendinden önceki cama bağlı, TL etiketi yok sayılır; grup özeti satır olmaz', () => {
  const p = parseFactoryOrder(FORM_CNC);
  assert.deepEqual(p.problems, []);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows.map((r) => [r.sno, r.en, r.boy, r.adet, r.m2, r.totalM2, r.unitPrice, r.discount, r.amount, r.poz, r.ops.length]), [
    [1, 3000, 1000, 1, 3000, 3000, 10000, 0, 30000, 'ABC 40', 1],
    [2, 1235, 1000, 1, 1235, 1235, 10000, 0, 12350, 'ABC 40', 1],
  ]);
  assert.equal(p.rows[0].description, DESC_TENTESOL);
  assert.deepEqual(p.rows[0].ops[0], { line: 10, name: 'CNC İŞLEMİ', unit: 'ADET', qty: 1000, totalQty: 1000, unitPrice: 500, discount: 0, amount: 500 });
  assert.deepEqual(p.totals, { count: 2, totalM2: 4235, tableSum: 43350, subtotal: 43350, grossSum: 43350, discount: 0, vat: 8670, grandTotal: 52020 });
  // Tek satırlık düzen (S.No + ad + sayılar aynı satırda) ve "." ile biten ad
  const one = parseFactoryOrder(form({ rows: [`1 ${DESC_BRONZE} 740 800 1 0,592 0,592 49,00 TL 0,0 29,01 ABC 65`], total: '1 0,592 29,01', sub: '29,01', grand: '34,81' }));
  assert.deepEqual(one.problems, []);
  assert.equal(one.rows[0].description, '6 mm Temperli Düz Cam DR+1.14 Şeffaf+6 mm Temperli Bronz Cam DR');
  assert.equal(checkSubtotal(one).ok, true);
});

test('Ara Toplam (KDV hariç) tek esas; KDV ve Genel Toplam okunur ama hiçbir hesaba girmez; A denetimi kuruşu kuruşuna', () => {
  const p = parseFactoryOrder(FORM_CNC);
  assert.deepEqual(checkSubtotal(p), { pdfSum: 43350, subtotal: 43350, ok: true });
  const wrong = parseFactoryOrder(form({ rows: FORM_CNC.slice(7, 13).map((l) => l.text), total: '2 4,235 433,50', sub: '433,49', grand: '520,20' }));
  assert.equal(checkSubtotal(wrong).ok, false);
  const none = parseFactoryOrder(FORM_CNC.filter((l) => !/Ara Toplam/.test(l.text)));
  assert.ok(none.problems.some((x) => x.code === 'SUBTOTAL_MISSING'));
});

test('PDF kendi içinde tutarsızsa sorun: tutar ≠ m² × fiyat, m² × adet ≠ toplam m², tanınmayan satır, eksik satır, form değil', () => {
  const bad = parseFactoryOrder(form({ rows: ['1 6 mm Temperli Düz Cam DR', '1000 1000 2 1,000 2,500 10,00 TL 0,0 99,00 ABC 40', 'BU BIR NOT SATIRI 12,50'], total: '2 2,500 99,00', sub: '99,00', grand: '0,00' }));
  const codes = bad.problems.map((x) => x.code);
  assert.ok(codes.includes('ROW_AREA_MISMATCH') && codes.includes('ROW_AMOUNT_MISMATCH') && codes.includes('UNRECOGNIZED_LINE'), codes.join());
  assert.ok(parseFactoryOrder(form({ rows: ['1 6 mm Temperli Düz Cam DR'], total: '0 0,000 0,00', sub: '0,00', grand: '0,00' })).problems.some((x) => x.code === 'ROW_INCOMPLETE'));
  assert.deepEqual(parseFactoryOrder([{ page: 1, text: 'Bambaşka bir belge' }]).problems.map((x) => x.code), ['NOT_FACTORY_FORM']);
});

test('iskontolu satır: tutar = toplam m² × fiyat × (1 − iskonto); özgün fiyat, iskonto ve net tutar korunur', () => {
  const p = parseFactoryOrder(form({ rows: [`1 ${DESC_BRONZE}`, '1000 1000 2 1,000 2,000 50,00 TL 10,0 90,00 ABC 40', 'CNC İŞLEMİ ADET 2,000 2,000 5,00 TL 10,0 9,00'], total: '2 2,000 99,00', sub: '99,00', grand: '0,00' }));
  assert.deepEqual(p.problems, []);
  assert.deepEqual([p.rows[0].unitPrice, p.rows[0].discount, p.rows[0].amount, p.rows[0].ops[0].amount], [5000, 1000, 9000, 900]);
});

test('çok sayfalı form: ikinci sayfadaki başlık ve sütun başlığı tekrarı satır sayılmaz', () => {
  const p = parseFactoryOrder(form({
    rows: [`1 ${DESC_TENTESOL}`, '3000 1000 1 3,000 3,000 100,00 TL 0,0 300,00 ABC 40', 'CNC İŞLEMİ ADET 1,000 1,000 5,00 TL 0,0 5,00'],
    page2: ['Trakya Cam ve Alm SİPARİŞ FORMU', 'Sipariş No : 90001 121.001 Teslim Tarihi : 01-10-2026', 'S.No Cam Adı / Cinsi En x Boy Adet M2 Top. M2 Birim Fiyat İsk. Tutar Poz',
      `2 ${DESC_TENTESOL}`, '1235 1000 1 1,235 1,235 100,00 TL 0,0 123,50 ABC 40', 'CNC İŞLEMİ ADET 1,000 1,000 5,00 TL 0,0 5,00'],
    total: '2 4,235 433,50', sub: '433,50', grand: '520,20',
  }));
  assert.deepEqual(p.problems, []);
  assert.equal(p.rows.length, 2);
});

// ---------------------------------------------------------------- cam cinsi
test('PVB kat sayısı = PVB ÷ 0,38: 0,38 → 6.1.6, 0,76 → 6.2.6, 1,14 → 6.3.6, 1,52 → 6.4.6, 8+1,14+8 → 8.3.8; tam katı değilse kod yok', () => {
  const code = (d) => factoryGlassSignature(d).code;
  assert.equal(code('6 mm Temperli Düz Cam DR+0.38 Şeffaf+6 mm Temperli Düz Cam DR'), '6.1.6');
  assert.equal(code('6 mm Temperli Düz Cam DR+0.76 Şeffaf+6 mm Temperli Düz Cam DR'), '6.2.6');
  assert.equal(code(DESC_TENTESOL), '6.3.6');
  assert.equal(code('6 mm Temperli Düz Cam DR+1,52 Şeffaf+6 mm Temperli Düz Cam DR'), '6.4.6');
  assert.equal(code(DESC_UC), '8.3.8');
  assert.equal(code('10 mm Temperli Düz Cam DR+1.14 Şeffaf+8 mm Temperli Düz Cam DR'), '10.3.8'); // farklı kalınlıklar
  const odd = factoryGlassSignature('6 mm Temperli Düz Cam DR+1.00 Şeffaf+6 mm Temperli Düz Cam DR');
  assert.deepEqual([odd.ok, odd.code, odd.problem], [false, null, 'PVB_NOT_MULTIPLE']);
  assert.equal(code('10 mm Temperli Düz Cam DR'), '10'); // tek kat
});

test('renk / kaplama sınıfları; "ŞEKİLLİ + CNC" kuyruğu cam cinsini değiştirmez; şekil bilgisi ayrı', () => {
  const t = factoryGlassSignature(DESC_TENTESOL);
  assert.deepEqual([t.colours, t.unknown, t.tempered, t.shaped], [['CLEAR', 'GREY', 'REFLECTIVE'], [], true, true]);
  assert.deepEqual(factoryGlassSignature(DESC_TENTESOL.replace(' ŞEKİLLİ + CNC OYUK', '')).colours, t.colours);
  assert.deepEqual(factoryGlassSignature(DESC_BRONZE).colours, ['BRONZE', 'CLEAR']);
  const uc = factoryGlassSignature(DESC_UC);
  assert.deepEqual([uc.colours, uc.drilled, uc.shaped], [['ULTRA_CLEAR'], true, true]);
  // Bilinmeyen kaplama sözcüğü: otomatik eşleşme yok
  assert.deepEqual(factoryGlassSignature('6 mm Temperli Stopsol Cam DR+1.14 Şeffaf+6 mm Temperli Düz Cam DR').unknown, ['STOPSOL', 'PLY_COLOUR']);
  assert.ok(factoryGlassSignature('6 mm Temperli Düz Cam DR+0.76 Opak Beyaz+6 mm Temperli Düz Cam DR').colours.includes('PVB_OPAQUE'));
});

const CATALOG = [
  { id: 'g-ref', nameTr: '6.3.6 Temperli Lamine', colorTr: 'Füme Reflekte-Şeffaf', nameRo: 'Sticlă 6.3.6.', colorRo: 'Gri reflectiv-Transparent', label: '6.3.6 Füme Reflekte' },
  { id: 'g-brz', nameTr: '6.3.6 Temperli Lamine', colorTr: 'Bronz-Şeffaf', nameRo: 'Sticlă 6.3.6.', colorRo: 'Bronz-Transparent', label: '6.3.6 Bronz' },
  { id: 'g-626', nameTr: '6.2.6 Temperli Lamine', colorTr: 'Bronz-Şeffaf', label: '6.2.6 Bronz' },
  { id: 'g-uc', nameTr: '8.3.8 Temperli Lamine', colorTr: 'Ultra Clear', nameRo: 'STICLĂ SECURIZATĂ LAMINATĂ 8.3.8.', colorRo: 'Extra clar', label: '8.3.8 Ultra Clear' },
  { id: 'g-old', nameTr: '6.3.6 Temperli Lamine', colorTr: 'Bronz-Şeffaf (eski)', label: 'eski', isActive: false },
];

test('katalog: kod + renk birebir aynı TEK cam otomatik; aynı kodlu başkaları elle seçilebilir; pasif cam aday değil', () => {
  assert.deepEqual(catalogGlassSignature(CATALOG[3]), { code: '8.3.8', colours: ['ULTRA_CLEAR'] });
  assert.deepEqual(catalogGlassSignature({ nameRo: 'STICLĂ SECURIZATĂ LAMINATĂ 4.2.4., PVB OPAQUE (GRI+GRI)' }), { code: '4.2.4', colours: ['GREY', 'PVB_OPAQUE'] });
  const active = CATALOG.filter((g) => g.isActive !== false);
  assert.deepEqual(glassCandidates(factoryGlassSignature(DESC_BRONZE), active), { exact: ['g-brz'], sameCode: ['g-ref', 'g-brz'] });
  assert.deepEqual(glassCandidates(factoryGlassSignature(DESC_UC), active).exact, ['g-uc']);
  // İki birebir eşleşme → otomatik seçim yok
  assert.deepEqual(glassCandidates(factoryGlassSignature(DESC_BRONZE), [...active, { ...CATALOG[1], id: 'g-brz2' }]).exact, ['g-brz', 'g-brz2']);
  assert.equal(orderGlassVerdict(factoryGlassSignature(DESC_BRONZE), CATALOG[1]), 'MATCH');
  assert.equal(orderGlassVerdict(factoryGlassSignature(DESC_BRONZE), CATALOG[2]), 'MISMATCH'); // 6.2.6 ≠ 6.3.6
  assert.equal(orderGlassVerdict(factoryGlassSignature(DESC_BRONZE), CATALOG[0]), 'MISMATCH'); // renk farklı
  assert.equal(orderGlassVerdict(factoryGlassSignature(DESC_BRONZE), { nameTr: '66.2 Lamine' }), 'UNKNOWN');
  assert.equal(orderGlassVerdict(factoryGlassSignature(DESC_BRONZE), null), 'NONE');
});

// ---------------------------------------------------------------- müşteri / proje
test('proje: firma kodu + numara siparişle aynı olmalı; büyük/küçük harf ve boşluk farkı yok sayılır; farklı / belirsiz reddedilir', () => {
  const order = { prefix: 'ABC', customerOrderNo: '40' };
  assert.deepEqual(projectRefs('musterix abc40 ŞANTİYE'), [{ code: 'ABC', no: '40' }]);
  assert.deepEqual(projectCheck('MUSTERIX ABC 40', order), { ok: true, code: 'ABC', no: '40' });
  assert.deepEqual(projectCheck('musterix  abc   40 MANDACHE', order), { ok: true, code: 'ABC', no: '40' });
  // Tireli müşteri numarası (karar 259): "ABC 40-1" ayrı bir siparişin numarasıdır — 40 numaralı siparişe aktarılmaz;
  // 40-1 numaralı siparişe aynen eşleşir (baştaki sıfır da korunur)
  assert.deepEqual(projectCheck('MUSTERIX ABC 40-1', order), { ok: false, code: 'WRONG_PROJECT', found: 'ABC 40-1' });
  assert.deepEqual(projectCheck('MUSTERIX ABC 40-1 MANDACHE', { prefix: 'ABC', customerOrderNo: '40-1' }), { ok: true, code: 'ABC', no: '40-1' });
  assert.deepEqual(projectCheck('ABC 001-1', { prefix: 'ABC', customerOrderNo: '001-1' }), { ok: true, code: 'ABC', no: '001-1' });
  assert.equal(projectCheck('ABC 001-1', { prefix: 'ABC', customerOrderNo: '1-1' }).code, 'WRONG_PROJECT');
  assert.equal(projectCheck('ABC 40', { prefix: 'ABC', customerOrderNo: 40 }).ok, true, 'eski çağıran (sayı) da çalışır');
  assert.deepEqual(projectCheck('BASKA FIRMA XYZ 40', order), { ok: false, code: 'WRONG_CUSTOMER', found: 'XYZ' });
  assert.deepEqual(projectCheck('MUSTERIX ABC 41', order), { ok: false, code: 'WRONG_PROJECT', found: 'ABC 41' });
  assert.equal(projectCheck('MUSTERIX ABC 40 ABC 41', order).code, 'PROJECT_AMBIGUOUS');
  assert.equal(projectCheck('ABC 40 XYZ 12', order).code, 'PROJECT_AMBIGUOUS');
  assert.equal(projectCheck('MUSTERIX', order).code, 'PROJECT_UNRECOGNIZED');
  assert.equal(projectCheck(null, order).code, 'PROJECT_MISSING');
});

// ---------------------------------------------------------------- plan
const ORDER = { prefix: 'ABC', customerOrderNo: '40', glass: CATALOG[0] };
const plan = (lines, extra = {}) => buildImportPlan({ parsed: parseFactoryOrder(lines), importKey: 'cimp000000000000000000001', order: ORDER, catalog: CATALOG.filter((g) => g.isActive !== false), ...extra });

test('plan: cam ve CNC ayrı satır; alış fiyatı satış fiyatına (unitPrice), müşteri fiyatı boş; Poz PDF’ten; kaynak satır no', () => {
  const p = plan(FORM_CNC);
  assert.deepEqual(p.blocking, []);
  assert.deepEqual(p.lines.map((l) => [l.kind, l.description, l.poz, l.enMm, l.boyMm, l.adet, l.unit, l.unitPrice, l.offerPrice, l.sourceRow, l.glassProductId]), [
    ['CAM', '6.3.6 Füme Reflekte', 'ABC 40', 3000, 1000, 1, 'm2', '100.00', null, 1, 'g-ref'],
    ['CNC', 'CNC İŞLEMİ', '', null, null, 1, 'adet', '5.00', null, 1, null],
    ['CAM', '6.3.6 Füme Reflekte', 'ABC 40', 1235, 1000, 1, 'm2', '100.00', null, 2, 'g-ref'],
    ['CNC', 'CNC İŞLEMİ', '', null, null, 1, 'adet', '5.00', null, 2, null],
  ]);
  assert.equal(p.header.projectCode, 'ABC 40');
  assert.ok(!JSON.stringify(p.header).includes('MUSTERIX'), 'proje metni (müşteri adı) planın başlığına girmez');
});

test('B denetimi: PDF’in 3 ondalıklı m²’si aynen kullanılır (karar 261) — 2 ondalığa yuvarlamadan doğan fark kalmaz; satır eklenmez', () => {
  const p = plan(FORM_CNC);
  // PDF 300,00 + 123,50 + 2 × 5 = 433,50 · TAKİP 300,00 + 1,235 × 100 = 123,50 + 10 = 433,50 (eskiden 1,24 m² → 434,00)
  assert.deepEqual(p.checks.a, { pdfSum: 43350, subtotal: 43350, ok: true, rounding: false });
  assert.deepEqual(p.checks.b, { takipTotal: 43350, subtotal: 43350, diff: 0, explained: true });
  assert.deepEqual(p.warnings.filter((w) => w.code === 'ROUNDING_DIFFERENCE'), []);
  assert.deepEqual(p.lines.filter((l) => l.kind === 'CAM').map((l) => [l.pieceM2, l.adet]), [['3.000', 1], ['1.235', 1]]);
  assert.deepEqual(p.rows.map((r) => [r.m2, r.totalM2, r.takipM2]), [[3000, 3000, 3000], [1235, 1235, 1235]]);
  assert.equal(p.lines.length, 4, 'fark için satır / düzeltme / ek ücret yok');
  assert.deepEqual([p.checks.vat, p.checks.grandTotal], [8670, 52020]);
});

test('açıklanamayan fark (PDF m²’si en × boy değil) aktarmayı durdurur; A tutmazsa da durur', () => {
  const p = plan(form({ rows: [`1 ${DESC_TENTESOL}`, '1000 1000 1 1,250 1,250 100,00 TL 0,0 125,00 ABC 40'], total: '1 1,250 125,00', sub: '125,00', grand: '150,00' }));
  // m² PDF'ten aynen alınır (karar 261): PDF m²'si ölçüyle uyuşmayınca fark tutara yansımaz ama gizlenmez — aktarma durur
  assert.deepEqual(p.blocking.map((b) => [b.code, b.row, b.pdfM2, b.dimsM2]), [['AREA_MISMATCH', 1, 1250, 1000]]);
  const a = plan(form({ rows: FORM_CNC.slice(7, 13).map((l) => l.text), total: '2 4,235 433,50', sub: '400,00', grand: '480,00' }));
  assert.ok(a.blocking.some((b) => b.code === 'SUBTOTAL_MISMATCH'));
});

test('Ara Toplam ile satır toplamı arasında küçük yuvarlama farkı (ADE 8: 769,62 / 769,64) aktarmayı durdurmaz; maliyetler PDF’ten aynen', () => {
  const rows = [`1 ${DESC_TENTESOL}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 40', `2 ${DESC_TENTESOL}`, '1000 1000 1 1,000 1,000 100,00 TL 0,0 100,00 ABC 40'];
  const p = plan(form({ rows, total: '2 2,000 200,00', sub: '200,02', grand: '240,02' }));
  assert.deepEqual(p.blocking, []);
  assert.deepEqual(p.warnings.filter((w) => w.code === 'SUBTOTAL_ROUNDING').map((w) => [w.pdfSum, w.subtotal, w.diff]), [['200.00', '200.02', '0.02']]);
  assert.equal(p.checks.a.ok, false);
  assert.equal(p.checks.a.rounding, true);
  assert.equal(p.checks.b.explained, true);
  assert.deepEqual(p.lines.map((l) => [l.kind, l.unitPrice, l.offerPrice]), [['CAM', '100.00', null], ['CAM', '100.00', null]], 'alış maliyeti PDF’ten, müşteri fiyatı boş');
  assert.equal(p.lines.length, 2, 'fark için satır / düzeltme eklenmez');
  // sınırın üstü (2 tutarlı satır → en çok 2 kuruş) ve büyük fark aktarmayı durdurmaya devam eder
  for (const sub of ['200,03', '199,97', '210,00']) {
    const q = plan(form({ rows, total: '2 2,000 200,00', sub, grand: '250,00' }));
    assert.ok(q.blocking.some((b) => b.code === 'SUBTOTAL_MISMATCH'), sub);
    assert.equal(q.checks.a.rounding, false);
  }
});

test('iskontolu satır: net birim fiyat = net tutar ÷ miktar (2 ondalık); yuvarlama farkı açıklanır, gizli düzeltme yok', () => {
  const p = plan(form({ rows: [`1 ${DESC_TENTESOL}`, '1000 1000 3 1,000 3,000 33,33 TL 10,0 89,99 ABC 40'], total: '3 3,000 89,99', sub: '89,99', grand: '107,99' }));
  assert.deepEqual(p.blocking, []);
  assert.equal(p.lines[0].unitPrice, '30.00'); // 89,99 ÷ 3 = 29,9967 → 30,00
  assert.deepEqual([p.rows[0].unitPrice, p.rows[0].discount, p.rows[0].amount, p.rows[0].netUnit], [3333, 1000, 8999, 3000]);
  assert.equal(p.checks.b.diff, 1);
  assert.equal(p.checks.b.explained, true);
});

test('adetli cam + işlem: cam tek adetlik satırlara ayrılır (aynı ticari kalem), işlem miktarı cama bölünür; bölünmezse durur', () => {
  const p = plan(form({ rows: [`1 ${DESC_TENTESOL}`, '1000 2000 2 2,000 4,000 100,00 TL 0,0 400,00 ABC 40', 'CNC İŞLEMİ ADET 2,000 2,000 5,00 TL 0,0 10,00'], total: '2 4,000 410,00', sub: '410,00', grand: '492,00' }));
  assert.deepEqual(p.blocking, []);
  assert.deepEqual(p.lines.map((l) => [l.kind, l.adet, l.splitGroup != null]), [['CAM', 1, true], ['CNC', 1, false], ['CAM', 1, true], ['CNC', 1, false]]);
  assert.equal(p.lines[0].splitGroup, p.lines[2].splitGroup);
  assert.equal(p.checks.b.diff, 0);
  const odd = plan(form({ rows: [`1 ${DESC_TENTESOL}`, '1000 2000 2 2,000 4,000 100,00 TL 0,0 400,00 ABC 40', 'CNC İŞLEMİ ADET 3,000 3,000 5,00 TL 0,0 15,00'], total: '2 4,000 415,00', sub: '415,00', grand: '498,00' }));
  assert.ok(odd.blocking.some((b) => b.code === 'OPS_QTY_AMBIGUOUS'));
});

test('işlem türü: CNC İŞLEMİ → CNC, ... DELİK → Delik; tanınmayan ad tahmin edilmez (seçim istenir), seçimle aktarılır', () => {
  assert.deepEqual([opKindOf('CNC İŞLEMİ'), opKindOf('CNC BÜYÜK DELİK'), opKindOf('Delik'), opKindOf('RODAJ')], ['CNC', 'DELIK', 'DELIK', null]);
  const rows = [`1 ${DESC_UC}`, '1000 1000 1 1,000 1,000 80,00 TL 0,0 80,00 ABC 40', 'RODAJ ADET 4,000 4,000 1,00 TL 0,0 4,00'];
  const order = { ...ORDER, glass: CATALOG[3] };
  const p = buildImportPlan({ parsed: parseFactoryOrder(form({ rows, total: '1 1,000 84,00', sub: '84,00', grand: '100,80' })), importKey: 'k', order, catalog: CATALOG });
  assert.deepEqual(p.blocking.map((b) => b.code), ['NEEDS_OP_CHOICE']);
  const chosen = buildImportPlan({ parsed: parseFactoryOrder(form({ rows, total: '1 1,000 84,00', sub: '84,00', grand: '100,80' })), importKey: 'k', order, catalog: CATALOG, choices: { ops: { RODAJ: 'CNC' } } });
  assert.deepEqual(chosen.blocking, []);
  assert.deepEqual(chosen.lines.map((l) => [l.kind, l.adet, l.unitPrice]), [['CAM', 1, '80.00'], ['CNC', 4, '1.00']]);
  // Birimi ADET olmayan işlem (metre) desteklenmez
  const mt = buildImportPlan({ parsed: parseFactoryOrder(form({ rows: [`1 ${DESC_UC}`, '1000 1000 1 1,000 1,000 80,00 TL 0,0 80,00 ABC 40', 'CNC İŞLEMİ MT 2,500 2,500 2,00 TL 0,0 5,00'], total: '1 1,000 85,00', sub: '85,00', grand: '102,00' })), importKey: 'k', order, catalog: CATALOG });
  assert.ok(mt.blocking.some((b) => b.code === 'OP_UNIT_UNSUPPORTED'));
});

test('cam: siparişin camıyla belirgin uyuşmazlık durdurur; sipariş camı doğrulanamazsa uyarı + tekil eşleşme; belirsizse seçim', () => {
  const lines = form({ rows: [`1 ${DESC_BRONZE} 740 800 1 0,592 0,592 49,00 TL 0,0 29,01 ABC 40`], total: '1 0,592 29,01', sub: '29,01', grand: '34,81' });
  assert.ok(plan(lines).blocking.some((b) => b.code === 'GLASS_ORDER_MISMATCH')); // sipariş: füme reflekte, PDF: bronz
  const unknown = buildImportPlan({ parsed: parseFactoryOrder(lines), importKey: 'k', order: { ...ORDER, glass: { id: 'x', nameTr: 'Lamine Cam' } }, catalog: CATALOG });
  assert.deepEqual(unknown.blocking, []);
  assert.equal(unknown.lines[0].glassProductId, 'g-brz');
  assert.ok(unknown.warnings.some((w) => w.code === 'ORDER_GLASS_UNVERIFIED'));
  const twin = [...CATALOG, { ...CATALOG[1], id: 'g-brz2', label: '6.3.6 Bronz (2)' }];
  const amb = buildImportPlan({ parsed: parseFactoryOrder(lines), importKey: 'k', order: { ...ORDER, glass: null }, catalog: twin });
  assert.ok(amb.blocking.some((b) => b.code === 'NEEDS_GLASS_CHOICE'));
  const key = amb.glassChoices[0].key;
  const picked = buildImportPlan({ parsed: parseFactoryOrder(lines), importKey: 'k', order: { ...ORDER, glass: null }, catalog: twin, choices: { glass: { [key]: 'g-brz2' } } });
  assert.deepEqual([picked.blocking, picked.lines[0].glassProductId], [[], 'g-brz2']);
  // Aday olmayan kimlik (başka kodlu cam) seçilemez
  const foreign = buildImportPlan({ parsed: parseFactoryOrder(lines), importKey: 'k', order: { ...ORDER, glass: null }, catalog: twin, choices: { glass: { [key]: 'g-uc' } } });
  assert.ok(foreign.blocking.some((b) => b.code === 'NEEDS_GLASS_CHOICE'));
});

test('Poz: aynı Poz birden çok satırda olabilir; Poz yoksa fabrika sipariş no yazılır ve uyarı verilir', () => {
  const p = plan(FORM_CNC);
  assert.deepEqual(p.lines.filter((l) => l.kind === 'CAM').map((l) => l.poz), ['ABC 40', 'ABC 40']);
  const noPoz = plan(form({ rows: [`1 ${DESC_TENTESOL}`, '3000 1000 1 3,000 3,000 100,00 TL 0,0 300,00'], total: '1 3,000 300,00', sub: '300,00', grand: '360,00' }));
  assert.equal(noPoz.lines[0].poz, '90001');
  assert.ok(noPoz.warnings.some((w) => w.code === 'POZ_FALLBACK'));
  assert.equal(noPoz.rows[0].pozFromPdf, false);
});

test('yanlış müşteri / yanlış proje PDF’i aktarılmaz', () => {
  assert.ok(plan(form({ project: 'BASKA XYZ 40', rows: FORM_CNC.slice(7, 13).map((l) => l.text), total: '2 4,235 433,50', sub: '433,50', grand: '520,20' })).blocking.some((b) => b.code === 'WRONG_CUSTOMER'));
  assert.ok(plan(form({ project: 'MUSTERIX ABC 41', rows: FORM_CNC.slice(7, 13).map((l) => l.text), total: '2 4,235 433,50', sub: '433,50', grand: '520,20' })).blocking.some((b) => b.code === 'WRONG_PROJECT'));
});

// ---------------------------------------------------------------- metin çıkarma (pdf.js)
let pdfjs = null;
try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); } catch { /* yerel ortamda paket yoksa */ }
const needPdfjs = (name, fn) => test(name, { skip: !pdfjs && !process.env.CI ? 'pdfjs-dist yok (yerel)' : false }, fn);

/** Fabrika formuna benzeyen sentetik PDF (TAKİP'in kendi PDF yazıcısıyla; gömülü yazı tipi + ToUnicode) */
function syntheticPdf(lines) {
  const doc = new PdfDoc({ title: 'x' });
  let page = doc.addPage();
  let y = 40;
  for (const l of lines) {
    if (y > 800) { page = doc.addPage(); y = 40; }
    let x = 20;
    for (const part of l.split(' | ')) { page.text(x, y, part, { size: 8 }); x += 6 * part.length + 12; }
    y += 12;
  }
  return new Uint8Array(doc.toBuffer());
}

needPdfjs('pdf.js: sentetik fabrika formu → satırlar → ayrıştırma (uçtan uca, ağ yok)', async () => {
  const lines = FORM_CNC.map((l) => l.text.replace(/ (\d{3,5} \d{3,5} \d )/, ' | $1'));
  const ex = await extractTextItems(syntheticPdf(lines));
  assert.equal(ex.ok, true, JSON.stringify(ex));
  const p = parseFactoryOrder(buildLines(ex.items));
  assert.deepEqual(p.problems, []);
  assert.equal(p.header.factoryNo, '90001');
  assert.equal(p.rows.length, 2);
  assert.equal(checkSubtotal(p).ok, true);
});

needPdfjs('pdf.js: PDF olmayan / çok büyük / metinsiz dosya sabit kodla reddedilir', async () => {
  assert.deepEqual(await extractTextItems(new TextEncoder().encode('merhaba dünya')), { ok: false, error: 'NOT_PDF' });
  assert.deepEqual(await extractTextItems(new Uint8Array(PDF_IMPORT_LIMITS.maxBytes + 1)), { ok: false, error: 'TOO_BIG' });
  const empty = new PdfDoc({ title: 'x' }); empty.addPage();
  assert.deepEqual(await extractTextItems(new Uint8Array(empty.toBuffer())), { ok: false, error: 'NO_TEXT' });
  const broken = new TextEncoder().encode('%PDF-1.7\nbozuk içerik');
  assert.equal((await extractTextItems(broken)).ok, false);
  assert.deepEqual(await extractTextItems(syntheticPdf(['a']), { limits: { ...PDF_IMPORT_LIMITS, maxPages: 0 } }), { ok: false, error: 'TOO_MANY_PAGES' });
});

// ---------------------------------------------------------------- yapı (yetki ve gizlilik)
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('yapı: her sunucu işlemi önce OFFER_PREPARE ister; servis de denetler; fabrika PDF’i sipariş dosyası olarak kaydedilmez', () => {
  const actions = read('app/(panel)/siparisler/[id]/pdf-import-actions.ts');
  for (const name of ['uploadFactoryPdfAction', 'previewFactoryPdfAction', 'applyFactoryPdfAction']) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`));
    assert.match(body.slice(0, body.indexOf('\n}')), /^[^\n]*\n\s*const user = await requirePermission\('OFFER_PREPARE'\);/, name);
  }
  assert.ok(!/orderFile\.create|kind: 'INTERNAL'|kind: 'CUSTOMER'/.test(actions));
  const svc = read('server/orders/pdf-import/service.js');
  for (const name of ['importTarget', 'recordUploads', 'importPreview']) {
    const body = svc.slice(svc.indexOf(`export async function ${name}(`));
    assert.match(body, /^[^\n]*\n\s*if \(!allowed\(actor\)\) return FORBIDDEN;/, name);
  }
  assert.match(svc.slice(svc.indexOf('export async function applyImports(')), /if \(!allowed\(actor\)\) throw new WorkflowError\('FORBIDDEN'\);/);
  assert.match(svc, /const allowed = \(actor\) => !!actor && can\(actor\.role, 'OFFER_PREPARE'\);/);
});

test('yapı: özgün fabrika PDF’i saklanmaz (indirme yolu yok, kayıt dosyasız, okunan dosya silinir); müşteri / denetimci kaynak almaz; geçmiş satırı kapalı', async () => {
  const route = read('app/dosya/[kind]/[id]/route.ts');
  assert.ok(!/fabrika|offerImport/.test(route), 'fabrika PDF’i için indirme yolu yok');
  const svc = read('server/orders/pdf-import/service.js');
  const rec = svc.slice(svc.indexOf('export async function recordUploads('), svc.indexOf('export function emptyGlassLines('));
  assert.match(rec, /storageKey: null,/);
  // Okunan her dosya, kaydı yeni açılsa da var olan kayıt kullanılsa da (karar 263) silinmek üzere döner — döngünün ilk adımı
  assert.match(rec, /for \(const f of stored\) \{\n\s*discard\.push\(\{ storageKey: f\.storageKey \}\);/);
  assert.match(read('prisma/schema.prisma'), /storageKey     String\?  @unique/);
  for (const f of ['server/files/antivirus.js', 'server/customers/deletion.js']) assert.ok(!/offerImport\.(findMany|count)/.test(read(f)), f);
  assert.match(read('lib/orders.ts'), /importId: null, sourceRow: null/);
  const { STAFF_EVENT_POLICY } = await import('../server/orders/order-view.js');
  const { EVENTS } = await import('../server/orders/rules.js');
  assert.deepEqual(STAFF_EVENT_POLICY.OFFER_PDF_IMPORTED, { row: 'OFFER_PREPARE', note: 'OFFER_PREPARE' });
  assert.equal(EVENTS.OFFER_PDF_IMPORTED.customer, false);
  const { can } = await import('../server/auth/permissions.js');
  assert.deepEqual(['ADMIN', 'YONETICI_YARDIMCISI', 'SATIS', 'MUSTERI', 'DENETIMCI', 'CIZIM'].map((r) => can(r, 'OFFER_PREPARE')), [true, true, true, false, false, false]);
});

test('yapı: aktarma yöneticiye göndermez, müşteri fiyatı yazmaz; teklif satırının kaynağı formdan alınmaz', () => {
  const tr = read('server/orders/transitions.js');
  const body = tr.slice(tr.indexOf('async import_offer_pdf(h)'), tr.indexOf('async send_to_drawing(h)'));
  assert.ok(!/YONETIMDE|GONDERILDI|OFFER_SUBMITTED|recordPriceOverrides/.test(body), 'gönderim yok');
  assert.match(body, /lineData\(\{ \.\.\.l, offerPrice: null \}/);
  assert.match(tr, /importId: old\?\.importId \?\? null,\n\s*sourceRow: old\?\.sourceRow \?\? null,/);
  assert.match(tr, /import_offer_pdf: \['edit_offer', 'approve_price'\]/);
  // Aktarmadan (ve her işlemden) sonra düzenleyici kayıtlı satırlarla yeniden kurulur: eski istemci durumu satırların yerine geçmez
  assert.match(read('app/(panel)/siparisler/[id]/page.tsx'), /<OfferEditor\s+\/\/[^\n]*\n[^\n]*\n\s+key=\{`\$\{offer\.id\}:\$\{order\.version\}`\}/);
});
