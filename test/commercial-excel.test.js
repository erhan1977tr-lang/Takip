// Ticari teklif → Cam: Excel'den aktarma (4.1.0, karar 298) — dosya okuma (gerçek .xls / .xlsx, 1,5 MB, bozuk / desteklenmeyen),
// sütun eşleştirme ve başlık, cam eşleştirmesi (Türkçe / Romence / etiket, boş → varsayılan, belirsiz / eşleşmeyen → elle,
// tahmin yok), ölçü / adet / 100 satır sınırları, aynı dosya / satır uyarısı, yapı (yetki önce, boyut okumadan önce, satış
// aktarımı değişmedi, dosya saklanmaz).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMERCIAL_IMPORT_MAX_BYTES, duplicateRows, glassIndex, glassKey, guessHeaderRow, HEADER_ROW_CHOICES, headerRowOf, importCapacity, importRows,
  looksLikeHeaderRow, matchGlass,
} from '../server/commercial/excel-import.js';
import { excelName, readCommercialExcel } from '../server/commercial/excel-read.js';
import { writeXlsx } from '../server/files/xlsx.js';
import { IMPORT_MAX_COLS, IMPORT_MAX_ROWS, validateImportRows } from '../server/orders/excel-import.js';
import { computeOffer, glassLineM2, previewOffer } from '../server/commercial/rules.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fixture = (n) => fs.readFileSync(path.join(ROOT, 'test/fixtures', n));

// Katalog: iki cam aynı Romence ada sahip (belirsizlik), biri Türkçe İ / ı içerir
const CATALOG = [
  { id: 'g1', nameTr: '8.8.2 TEMPERLİ LAMİNE', colorTr: 'ŞEFFAF', nameRo: '8.8.2 Securizat laminat', colorRo: 'transparent', label: '8.8.2 TEMPERLİ LAMİNE — ŞEFFAF' },
  { id: 'g2', nameTr: '10 mm Temperli', colorTr: 'Füme', nameRo: 'Sticlă 10', colorRo: 'gri', label: '10 mm Temperli — Füme' },
  { id: 'g3', nameTr: '10 mm Temperli', colorTr: 'Bronz', nameRo: 'Sticlă 10', colorRo: 'gri', label: '10 mm Temperli — Bronz' },
];
const INDEX = glassIndex(CATALOG);
const VALID = new Set(CATALOG.map((g) => g.id));

test('cam anahtarı: büyük / küçük harf, Türkçe İ / ı, boşluk farkı yok sayılır', () => {
  assert.equal(glassKey('  8.8.2   TEMPERLİ  lamine '), '8.8.2 temperli lamine');
  assert.equal(glassKey('TEMPERLI'), glassKey('temperli'));
  assert.equal(glassKey('Temperlı'), glassKey('TEMPERLİ'));
  assert.equal(glassKey('ŞEFFAF'), 'şeffaf');
  assert.equal(glassKey(null), '');
});

test('cam eşleştirme: yalnızca tek ve kesin eşleşme; boş / eşleşmeyen / belirsiz ayrı; benzer ad tahmin edilmez', () => {
  assert.deepEqual(matchGlass('8.8.2 temperli lamine şeffaf', INDEX), { status: 'MATCH', id: 'g1' }); // Türkçe ad + renk
  assert.deepEqual(matchGlass('8.8.2 TEMPERLI LAMINE — SEFFAF', INDEX), { status: 'NONE' }); // ş ≠ s: tahmin yok
  assert.deepEqual(matchGlass('8.8.2 Securizat laminat, transparent', INDEX), { status: 'MATCH', id: 'g1' }); // Romence
  assert.deepEqual(matchGlass('8.8.2 TEMPERLİ LAMİNE — ŞEFFAF', INDEX), { status: 'MATCH', id: 'g1' }); // ekran etiketi
  assert.deepEqual(matchGlass('10 mm temperli füme', INDEX), { status: 'MATCH', id: 'g2' });
  assert.equal(matchGlass('Sticlă 10 gri', INDEX).status, 'AMBIGUOUS'); // iki cam aynı Romence yazım
  assert.equal(matchGlass('10 mm Temperli', INDEX).status, 'NONE'); // kısmi metin (renk yok) eşleşmez
  assert.equal(matchGlass('8.8.2 temperli', INDEX).status, 'NONE');
  assert.equal(matchGlass('temperli lamine şeffaf 8.8.2', INDEX).status, 'NONE');
  assert.deepEqual(matchGlass('   ', INDEX), { status: 'EMPTY' });
});

const ROWS = [
  ['Cam', 'En', 'Boy', 'Adet'],
  ['8.8.2 temperli lamine şeffaf', '1.200', '850,5', '2'], // 2: eşleşti, 1200 × 851 (satış aktarımının yuvarlaması)
  ['', '1000 mm', 900, 1], // 3: boş → varsayılan
  ['Bilinmeyen cam', 700, 800, 1], // 4: eşleşmedi → varsayılana GEÇMEZ
  ['Sticlă 10 gri', 600, 600, 3], // 5: belirsiz → otomatik seçim yok
  ['8.8.2 temperli lamine şeffaf', 0, 500, 1], // 6: en 0
  ['8.8.2 temperli lamine şeffaf', 10001, 500, 1], // 7: en sınır dışı
  ['8.8.2 temperli lamine şeffaf', 500, 500, 1.5], // 8: adet tam sayı değil
  ['8.8.2 temperli lamine şeffaf', 500, 500, 100001], // 9: adet sınır dışı
  ['8.8.2 temperli lamine şeffaf', 500, 10000, 100000], // 10: tam sınırda geçerli
  [], // boş satır atlanır
];
const MAP = { glass: 0, width: 1, height: 2, qty: 3 };

test('satır doğrulama: başlık, sayı biçimleri, yuvarlama, ticari sınırlar, cam durumları', () => {
  assert.equal(looksLikeHeaderRow(ROWS, MAP), true);
  const r = importRows(ROWS, MAP, { skipHeader: true, index: INDEX, valid: VALID });
  const by = Object.fromEntries(r.rows.map((x) => [x.line, x]));
  assert.deepEqual([by[2].glass, by[2].glassStatus, by[2].en, by[2].boy, by[2].qty, by[2].ok], ['g1', 'MATCH', 1200, 851, 2, true]);
  assert.deepEqual([by[3].glass, by[3].glassStatus, by[3].en], [null, 'MISSING', 1000]); // varsayılan seçilmedi
  assert.deepEqual([by[4].glass, by[4].glassStatus], [null, 'NONE']);
  assert.deepEqual([by[5].glass, by[5].glassStatus], [null, 'AMBIGUOUS']);
  assert.deepEqual(by[6].errors, ['width']);
  assert.deepEqual(by[7].errors, ['widthRange']);
  assert.deepEqual(by[8].errors, ['qty']);
  assert.deepEqual(by[9].errors, ['qtyRange']);
  assert.deepEqual([by[10].ok, by[10].boy, by[10].qty], [true, 10000, 100000]);
  assert.equal(r.rows.length, 9, 'boş satır ve başlık sayılmaz');
  assert.deepEqual([r.ready, r.invalid, r.needsGlass], [2, 4, 3]);
  // Varsayılan cam yalnızca BOŞ hücreye uygulanır; eşleşmeyen ve belirsiz satır varsayılana geçmez
  const d = importRows(ROWS, MAP, { skipHeader: true, index: INDEX, valid: VALID, defaultId: 'g2' });
  const dy = Object.fromEntries(d.rows.map((x) => [x.line, x]));
  assert.deepEqual([dy[3].glass, dy[3].glassStatus], ['g2', 'DEFAULT']);
  assert.deepEqual([dy[4].glass, dy[5].glass], [null, null]);
  // Elle seçim: belirsiz ve eşleşmeyen satırlar seçilen camla aktarılır; katalogda olmayan seçim yok sayılır
  const p = importRows(ROWS, MAP, { skipHeader: true, index: INDEX, valid: VALID, defaultId: 'g2', picks: { 4: 'g3', 5: 'g2', 2: 'yok' } });
  const py = Object.fromEntries(p.rows.map((x) => [x.line, x]));
  assert.deepEqual([py[4].glass, py[4].glassStatus, py[5].glass, py[5].glassStatus], ['g3', 'PICKED', 'g2', 'PICKED']);
  assert.deepEqual([py[2].glass, py[2].glassStatus], ['g1', 'MATCH']);
  assert.equal(p.ready, 5);
  // Pasif / katalog dışı varsayılan kullanılmaz
  assert.equal(importRows(ROWS, MAP, { skipHeader: true, index: INDEX, valid: VALID, defaultId: 'pasif' }).rows.find((x) => x.line === 3).glass, null);
  // Cam sütunu yok: bütün satırlar varsayılan ister
  const noCol = importRows(ROWS, { ...MAP, glass: -1 }, { skipHeader: true, index: INDEX, valid: VALID, defaultId: 'g1' });
  assert.ok(noCol.rows.filter((x) => x.errors.length === 0).every((x) => x.glass === 'g1' && x.glassStatus === 'DEFAULT'));
  // Başlık seçeneği kapalıyken ilk satır geçersiz sayılır (sütunlar değiştirilebilir)
  assert.equal(importRows(ROWS, MAP, { skipHeader: false, index: INDEX, valid: VALID }).rows[0].errors.length > 0, true);
  const swapped = importRows(ROWS, { glass: 0, width: 2, height: 1, qty: 3 }, { skipHeader: true, index: INDEX, valid: VALID });
  assert.deepEqual([swapped.rows[0].en, swapped.rows[0].boy], [851, 1200]);
});

test('100 satır sınırı: aşılırsa hiç eklenmez, kalan yer gösterilir; aynı satır uyarısı', () => {
  assert.deepEqual(importCapacity(98, 2), { ok: true, existing: 98, adding: 2, free: 2, max: 100 });
  assert.deepEqual(importCapacity(98, 3), { ok: false, existing: 98, adding: 3, free: 2, max: 100 });
  assert.equal(importCapacity(100, 1).free, 0);
  assert.equal(importCapacity(120, 1).free, 0);
  const existing = [{ productId: 'g1', en: '1200', boy: '851', qty: '2' }, { productId: '', en: '', boy: '', qty: '1' }];
  assert.equal(duplicateRows([{ productId: 'g1', en: 1200, boy: 851, qty: 2 }, { productId: 'g1', en: 1200, boy: 851, qty: 3 }], existing), 1);
  assert.equal(duplicateRows([{ productId: 'g2', en: 1200, boy: 851, qty: 2 }], existing), 0);
});

test('aktarılan satır mevcut hesaptan geçer: satış fiyatı boş → toplama katılmaz; fiyat girilince aynı kural', () => {
  const line = { productId: 'g1', description: 'x', en: '1200', boy: '851', qty: '2', price: '', cost: '41,5', ops: [] };
  assert.equal(previewOffer({ glass: [line], profile: [] }, () => null).glass[0], null);
  const priced = previewOffer({ glass: [{ ...line, price: '60' }], profile: [] }, () => null);
  assert.deepEqual([priced.glass[0].m2, priced.glass[0].amount, priced.glass[0].costAmount], ['2.042', '122.52', '84.74']);
});

test('dosya okuma: gerçek .xls ve .xlsx, 1,5 MB sınırı, bozuk / boş / desteklenmeyen dosya, ön izleme sınırları', () => {
  assert.equal(COMMERCIAL_IMPORT_MAX_BYTES, 1.5 * 1024 * 1024);
  const xls = readCommercialExcel(fixture('olculer.xls'));
  assert.equal(xls.ok, true);
  assert.deepEqual(xls.rows[1], ['K1', '1000', '2000', '2', 'Şeffaf']);
  assert.match(xls.fingerprint, /^[0-9a-f]{64}$/);
  const xlsx = readCommercialExcel(writeXlsx({ sheetName: 'Ölçüler', rows: [['Cam', 'En', 'Boy', 'Adet'], ['10 mm temperli füme', 1000, 2000, 2]] }));
  assert.deepEqual(xlsx.rows, [['Cam', 'En', 'Boy', 'Adet'], ['10 mm temperli füme', '1000', '2000', '2']]);
  assert.notEqual(xlsx.fingerprint, xls.fingerprint);
  assert.deepEqual(readCommercialExcel(Buffer.alloc(COMMERCIAL_IMPORT_MAX_BYTES + 1)), { ok: false, error: 'TOO_BIG' });
  assert.deepEqual(readCommercialExcel(Buffer.alloc(0)), { ok: false, error: 'EMPTY' });
  assert.deepEqual(readCommercialExcel(Buffer.from('%PDF-1.7 değil excel')), { ok: false, error: 'UNREADABLE' });
  assert.deepEqual(readCommercialExcel(Buffer.from('PK\u0003\u0004bozuk zip')), { ok: false, error: 'UNREADABLE' });
  // Tam sınırda okunur (ayrıştırıcı sahte)
  assert.equal(readCommercialExcel(Buffer.alloc(COMMERCIAL_IMPORT_MAX_BYTES), { parse: () => ({ rows: [['a']] }) }).ok, true);
  // Ön izleme penceresi ve metin sınırı satış aktarımıyla aynı (previewRows)
  const wide = readCommercialExcel(Buffer.from('x'), { parse: () => ({ rows: Array.from({ length: IMPORT_MAX_ROWS + 10 }, () => Array(IMPORT_MAX_COLS + 5).fill(1)) }) });
  assert.deepEqual([wide.rows.length, wide.rows[0].length], [IMPORT_MAX_ROWS, IMPORT_MAX_COLS]);
  assert.deepEqual(readCommercialExcel(Buffer.from('x'), { parse: () => ({ rows: [['a'.repeat(40_000)]] }) }), { ok: false, error: 'TOO_MUCH_TEXT' });
  assert.deepEqual(['a.xls', 'B.XLSX', ' c.xlsx '].map(excelName), [true, true, true]);
  assert.deepEqual(['a.csv', 'a.xlsm', 'a.xls.pdf', 'xlsx', ''].map(excelName), [false, false, false, false, false]);
});

test('yapı: işlem önce yetki ister, boyutu dosyayı okumadan denetler, dosyayı saklamaz; satış aktarımına dokunulmadı', () => {
  const action = read('app/(panel)/admin/ticari-teklifler/actions.ts');
  const body = action.slice(action.indexOf('export async function readCommercialExcelAction'));
  const fnBody = body.slice(0, body.indexOf('\n}\n'));
  assert.match(fnBody, /^export async function readCommercialExcelAction\(fd: FormData\)[^{]*\{\n\s*await requirePermission\(PERM\);/);
  const sizeAt = fnBody.indexOf('file.size > COMMERCIAL_IMPORT_MAX_BYTES');
  assert.ok(sizeAt > 0 && sizeAt < fnBody.indexOf('arrayBuffer()'), 'boyut, içerik okunmadan önce');
  assert.ok(fnBody.indexOf('excelName(file.name)') < fnBody.indexOf('arrayBuffer()'));
  for (const bad of [/storeFiles|storeUpload|writeFile|fs\./, /db\.|tx\./, /redirect\(/]) assert.doesNotMatch(fnBody, bad);
  const reader = read('server/commercial/excel-read.js');
  assert.match(reader, /import \{ parseExcel, previewRows \} from '\.\.\/orders\/excel-file\.js';/);
  assert.doesNotMatch(reader, /writeFile|createWriteStream|storeFiles|prisma|from '\.\.\/\.\.\/lib/);
  // Tarayıcı modülü sunucuya özgü bir şey içe aktarmaz
  const pure = read('server/commercial/excel-import.js');
  assert.doesNotMatch(pure, /node:|excel-file|xlsx\.js|xls\.js|prisma/);
  assert.match(pure, /import \{ cellNumber, looksLikeHeader, validateImportRows \} from '\.\.\/orders\/excel-import\.js';/);
  // Satış ekibinin Excel aktarımı: düzenleyicisi ve işlemi yeni modülü kullanmaz
  assert.doesNotMatch(read('app/(panel)/siparisler/[id]/ExcelImport.tsx'), /commercial/);
  assert.doesNotMatch(read('app/(panel)/siparisler/[id]/actions.ts'), /commercial\/excel/);
  // Düzenleyici: satış fiyatı boş, maliyet atanmış tablodan (elle cam seçmeyle aynı kaynak)
  const editor = read('app/(panel)/admin/ticari-teklifler/OfferEditor.tsx');
  assert.match(editor, /description: g\?\.descRo \?\? '', en: String\(r\.en\), boy: String\(r\.boy\), qty: String\(r\.qty\), price: '', cost: asInput\(g\?\.listCost\), ops: \[\]/);
  // Metinler iki dilde
  for (const loc of ['tr', 'ro']) assert.match(read(`server/i18n/${loc}/commercial.js`), /TOO_BIG: '[^']*1,5 MB[^']*'/);
});

test('satır m²: fiyattan / maliyetten bağımsız, fiyatlı satırda computeOffer ile aynı; ölçü / adet değişince yeniden hesaplanır', () => {
  const base = { productId: 'g1', en: '1200', boy: '851', qty: '2' };
  assert.equal(glassLineM2({ ...base, price: '', cost: '' }), '2.042'); // fiyat ve maliyet boş
  assert.equal(glassLineM2({ ...base, price: '60', cost: '41,5' }), '2.042');
  assert.equal(glassLineM2({ ...base, qty: '3' }), '3.063');
  assert.equal(glassLineM2({ ...base, en: '1000', boy: '970', qty: '1' }), '0.970');
  assert.equal(glassLineM2({ ...base, en: '333', boy: '333', qty: '1' }), '0.111'); // parça 3 ondalık, yarım-yukarı (0.110889)
  for (const bad of [{ productId: '' }, { en: '' }, { en: '0' }, { boy: '10001' }, { qty: '0' }, { qty: '1,5' }, { qty: '100001' }]) {
    assert.equal(glassLineM2({ ...base, ...bad }), null, JSON.stringify(bad));
  }
  // Fiyatlı satırda düzenleyicinin gösterdiği değer = computeOffer'ın değeri (rastgele 2000 satır)
  let seed = 5;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return 1 + (seed % n); };
  for (let k = 0; k < 2000; k++) {
    const l = { productId: 'g1', en: rnd(10000), boy: rnd(10000), qty: rnd(500), price: '1', cost: null };
    assert.equal(glassLineM2(l), computeOffer({ glass: [l], profile: [] }).glass[0].m2);
  }
  // Toplamlar değişmedi: fiyatsız satır toplam m²'ye ve tutara katılmaz (önizleme kuralı aynı)
  const pv = previewOffer({ glass: [{ ...base, price: '' }, { ...base, price: '60' }], profile: [] }, () => null);
  assert.deepEqual([pv.glass[0], pv.totals.glassM2, pv.invalid], [null, '2.042', 1]);
});

// 4.2.0: ön izleme satış aktarımıyla aynı düzende — başlık satırı seçimi, gerçek hücre tablosu (ortak bileşen), onay adımı
const TITLED = [
  ['GKH Trading — ölçü listesi', '', '', ''],
  ['Proje: Villa', '', '', ''],
  [],
  ['Cam', 'Genişlik', 'Yükseklik', 'Adet'],
  ['8.8.2 temperli lamine şeffaf', '1200', '851', '2'],
  ['', '1000', '500', '1'],
  ['', 'x', '500', '1'],
];
const TMAP = { glass: 0, width: 1, height: 2, qty: 3 };

test('başlık satırı: seçilen satır ve üstündekiler aktarılmaz, satır numaraları dosyadaki gibi; skipHeader ile aynı sonuç', () => {
  const r = importRows(TITLED, TMAP, { headerRow: 3, index: INDEX, valid: VALID, defaultId: 'g2' });
  assert.deepEqual(r.rows.map((x) => x.line), [5, 6, 7]);
  assert.deepEqual(r.rows.map((x) => [x.glass, x.glassStatus, x.ok]), [['g1', 'MATCH', true], ['g2', 'DEFAULT', true], ['g2', 'DEFAULT', false]]);
  assert.deepEqual(r.rows[2].errors, ['width']);
  assert.deepEqual([r.ready, r.invalid, r.needsGlass], [2, 1, 0]);
  // Başlık seçilmezse üstteki metin satırları hatalı satır olarak görünür (sessizce atılmaz)
  const none = importRows(TITLED, TMAP, { headerRow: -1, index: INDEX, valid: VALID });
  assert.deepEqual(none.rows.map((x) => x.line), [1, 2, 4, 5, 6, 7]);
  assert.equal(none.rows.find((x) => x.line === 4).errors.length, 3);
  // headerRow 0 = eski "ilk satır başlık" kuralı; verilmezse skipHeader geçerli
  for (const skipHeader of [true, false]) {
    assert.deepEqual(importRows(ROWS, MAP, { headerRow: skipHeader ? 0 : -1, index: INDEX, valid: VALID }), importRows(ROWS, MAP, { skipHeader, index: INDEX, valid: VALID }));
  }
  // Ölçü / adet doğrulaması satış aktarımının kuralıyla aynı (başlık sonrası satırlar)
  const sales = validateImportRows(TITLED.map((x, i) => (i <= 3 ? [] : x)), TMAP);
  assert.deepEqual(r.rows.map((x) => [x.line, x.en, x.boy, x.qty]), sales.rows.map((x) => [x.line, x.en, x.boy, x.adet]));
});

test('başlık satırı önerisi: üstte not satırları olsa da ilk başlık bulunur; bulunamazsa satış kuralı; geçersiz seçim → yok', () => {
  assert.equal(guessHeaderRow(TITLED, TMAP), 3);
  assert.equal(guessHeaderRow(ROWS, MAP), 0);
  assert.equal(guessHeaderRow([['1', '2', '3', '4'], ['5', '6', '7', '8']], TMAP), -1);
  // Yalnızca ilk 20 satır aranır
  const deep = [...Array.from({ length: HEADER_ROW_CHOICES + 2 }, () => ['not']), ['c', 'En', 'Boy', 'Adet'], ['', '1', '2', '3']];
  assert.equal(guessHeaderRow(deep, TMAP), -1);
  assert.equal(headerRowOf('3', 7), 3);
  for (const bad of ['-2', '7', '1.5', 'x', '', null, ' ']) assert.equal(headerRowOf(bad, 7), -1, String(bad));
  assert.equal(headerRowOf(String(HEADER_ROW_CHOICES - 1), 50), HEADER_ROW_CHOICES - 1);
  assert.equal(headerRowOf(String(HEADER_ROW_CHOICES), 50), -1);
});

test('yapı: iki Excel penceresi aynı ön izleme tablosunu kullanır; satış davranışı (sütunlar, başlık kutusu, aktarım) değişmedi', () => {
  const grid = read('components/ExcelGrid.tsx');
  assert.doesNotMatch(grid, /'use server'|commercial|actions/);
  const sales = read('app/(panel)/siparisler/[id]/ExcelImport.tsx');
  assert.match(sales, /from '@\/components\/ExcelGrid'/);
  assert.match(sales, /<ExcelGrid rows=\{rows\} cols=\{cols\} picked=\{\[map\.width, map\.height, map\.qty\]\}/);
  assert.match(sales, /validateImportRows\(rows, map, \{ skipHeader \}\)/);
  assert.match(sales, /readOfferExcelAction\(orderId, id\)/);
  assert.match(sales, /\(\['width', 'height', 'qty'\] as const\)/);
  assert.doesNotMatch(sales, /headerRow|guessHeaderRow|commercial/);
  const com = read('app/(panel)/admin/ticari-teklifler/ExcelImport.tsx');
  assert.match(com, /from '@\/components\/ExcelGrid'/);
  assert.match(com, /\(\['glass', 'width', 'height', 'qty'\] as const\)/);
  // Onay: "aktar" önce özet açar; düzenleyiciye yalnızca onay düğmesi ekler
  assert.match(com, /onClick=\{\(\) => setStep\('confirm'\)\} data-excel-apply/);
  assert.match(com, /onClick=\{commit\} data-excel-commit/);
  assert.equal((com.match(/onImport\(/g) ?? []).length, 1);
  assert.match(com, /const commit = \(\) => \{\n\s*if \(!canApply \|\| !data\) return;\n\s*onImport\(ready, data\.fingerprint\);/);
});
