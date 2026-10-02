// Cam kataloğu: Excel okuma/yazma, doğrulama, yükleme planı, sipariş satırı kopyası (Aşama 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readXlsx, writeXlsx } from '../server/files/xlsx.js';
import { readZip, writeZip } from '../server/files/zip.js';
import {
  CATALOG_HEADERS, CUSTOMER_GLASS_TYPES, catalogSheetRows, glassLabel, glassOrderItems, itemGlassName, parseActive, parseCatalogSheet, parseNumber,
  planCatalogImport, validateGlass,
} from '../server/catalog/glass.js';
import { draftLines, readDraftItems } from '../server/orders/drafts.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

test('zip: yazılan dosya geri okunur; bozuk/zip olmayan veri reddedilir', () => {
  const z = writeZip([{ name: 'a.txt', data: 'merhaba ş' }, { name: 'klasör/b.bin', data: Buffer.from([0, 1, 2]) }]);
  const m = readZip(z);
  assert.equal(m.get('a.txt').toString(), 'merhaba ş');
  assert.deepEqual([...m.get('klasör/b.bin')], [0, 1, 2]);
  assert.throws(() => readZip(Buffer.from('%PDF-1.4 değil')));
  // Açılmış boyut sınırı (zip bombasına karşı)
  const big = writeZip([{ name: 'x', data: Buffer.alloc(2 * 1024 * 1024) }]);
  assert.throws(() => readZip(big, { maxTotal: 1024 * 1024 }));
});

test('xlsx: ürün sahibinin katalog dosyası okunur (104 cam, başlık satırı 4)', () => {
  const { sheetName, rows } = readXlsx(fixture('cam-katalogu.xlsx'));
  assert.equal(sheetName, 'Cam kataloğu');
  assert.deepEqual(rows[3], CATALOG_HEADERS);
  assert.deepEqual(rows[4], ['10 MM TEMPER CAM', 'BRONZ', 'STICLĂ SECURIZATĂ 10 MM', 'BRONZ', '10 MM TEMPERED GLASS', 'BRONZE', 25, 'Evet']);
  const p = parseCatalogSheet(rows);
  assert.ok(p.ok);
  assert.equal(p.items.length, 104);
  assert.equal(p.errors.length, 0);
  assert.ok(p.items.every((i) => i.value.weightKgM2 > 0 && i.value.nameRo && i.value.isActive));
});

test('xlsx: fiyat listesi de okunur (Aşama 3b için)', () => {
  const { rows } = readXlsx(fixture('fiyat-listesi.xlsx'));
  assert.deepEqual(rows[4], ['Cam adı', 'Renk', 'Birim fiyat']);
  assert.equal(rows.filter((r, i) => i > 4 && r[0]).length, 104);
});

test('xlsx: indirilen katalog aynen geri yüklenebilir (Türkçe/Romence karakterler, sayılar)', () => {
  const items = parseCatalogSheet(readXlsx(fixture('cam-katalogu.xlsx')).rows).items.map((i) => i.value);
  const buf = writeXlsx({ sheetName: 'Cam kataloğu', rows: catalogSheetRows(items), bold: [0, 3] });
  const back = parseCatalogSheet(readXlsx(buf).rows);
  assert.ok(back.ok);
  assert.deepEqual(back.items.map((i) => i.value), items);
  assert.equal(readXlsx(writeXlsx({ sheetName: 'x', rows: [['A & <b> "c"', 1.25]] })).rows[0][0], 'A & <b> "c"');
});

test('katalog: satır hataları satır numarasıyla; aynı cam iki kez; virgüllü ağırlık; Hayır = pasif', () => {
  const rows = [
    ['CAM KATALOĞU'], [],
    CATALOG_HEADERS,
    ['8 MM TEMPER CAM', 'ŞEFFAF', 'STICLĂ 8 MM', 'TRANSPARENTĂ', '', '', '20,5', 'Hayır'],
    ['8 mm temper cam ', 'şeffaf', 'X', '', '', '', 20, 'Evet'], // aynı cam (büyük/küçük harf, boşluk)
    ['', 'BRONZ', 'STICLĂ', '', '', '', 20, 'Evet'],             // Türkçe ad yok
    ['6 MM', '', '', '', '', '', 'yirmi', 'Belki'],               // Romence ad, ağırlık, aktif hatalı
    [null, null],
  ];
  const p = parseCatalogSheet(rows);
  assert.ok(p.ok);
  assert.equal(p.items.length, 1);
  assert.deepEqual([p.items[0].row, p.items[0].value.weightKgM2, p.items[0].value.isActive], [4, 20.5, false]);
  assert.deepEqual(p.errors.map((e) => [e.row, e.codes]), [
    [5, ['DUPLICATE']],
    [6, ['NAME_TR']],
    [7, ['NAME_RO', 'WEIGHT', 'ACTIVE']],
  ]);
  assert.deepEqual(parseCatalogSheet([['başka', 'bir', 'tablo']]), { ok: false, error: 'HEADERS' });
  assert.deepEqual(parseCatalogSheet([CATALOG_HEADERS]), { ok: false, error: 'EMPTY' });
});

test('katalog: doğrulama sınırları', () => {
  assert.equal(parseNumber('1 234,5'), 1234.5);
  assert.ok(Number.isNaN(parseNumber('12a')));
  assert.equal(parseActive('Da'), true);
  assert.equal(parseActive('nu'), false);
  assert.equal(parseActive(''), true);
  const base = { nameTr: 'A', nameRo: 'B', weightKgM2: 25 };
  assert.ok(validateGlass(base).ok);
  assert.deepEqual(validateGlass({ ...base, weightKgM2: 0 }).errors, ['WEIGHT']);
  assert.deepEqual(validateGlass({ ...base, weightKgM2: 501 }).errors, ['WEIGHT']);
  assert.deepEqual(validateGlass({ ...base, nameTr: 'x'.repeat(121) }).errors, ['TOO_LONG']);
});

test('katalog: yükleme planı — Türkçe ad + renkle eşleşir; dosyada olmayana dokunulmaz', () => {
  const existing = [
    { id: 'a', nameTr: '10 MM TEMPER CAM', colorTr: 'BRONZ', nameRo: 'Eski RO', colorRo: 'BRONZ', nameEn: null, colorEn: null, weightKgM2: '25', isActive: true },
    { id: 'b', nameTr: '10 MM TEMPER CAM', colorTr: 'FÜME', nameRo: 'STICLĂ', colorRo: 'GRI', nameEn: null, colorEn: null, weightKgM2: '25', isActive: true },
    { id: 'c', nameTr: 'ESKİ CAM', colorTr: '', nameRo: 'VECHE', colorRo: '', nameEn: null, colorEn: null, weightKgM2: null, isActive: true },
  ];
  const items = [
    { nameTr: '10 mm temper cam', colorTr: 'bronz', nameRo: 'Yeni RO', colorRo: 'BRONZ', nameEn: null, colorEn: null, weightKgM2: 25, isActive: true },
    { nameTr: '10 MM TEMPER CAM', colorTr: 'FÜME', nameRo: 'STICLĂ', colorRo: 'GRI', nameEn: null, colorEn: null, weightKgM2: 25, isActive: true },
    { nameTr: 'YENİ CAM', colorTr: '', nameRo: 'NOUĂ', colorRo: '', nameEn: null, colorEn: null, weightKgM2: 30, isActive: true },
  ];
  const plan = planCatalogImport(existing, items);
  assert.deepEqual(plan.create.map((v) => v.nameTr), ['YENİ CAM']);
  assert.deepEqual(plan.update.map((u) => [u.id, u.changes]), [['a', ['nameTr', 'colorTr', 'nameRo']]]);
  assert.equal(plan.unchanged, 1, 'Decimal "25" ile 25 aynı sayılır');
  assert.deepEqual(plan.untouched.map((g) => g.id), ['c']);
});

test('cam adı: herkes seçtiği dilde görür; sipariş satırı iki dilde kopya saklar', () => {
  const g = { id: 'p', isActive: true, nameTr: '8 MM TEMPER CAM', colorTr: 'FÜME', nameRo: 'STICLĂ SECURIZATĂ 8 MM', colorRo: 'GRI', weightKgM2: '20' };
  assert.equal(glassLabel(g, 'tr'), '8 MM TEMPER CAM — FÜME');
  assert.equal(glassLabel(g, 'ro'), 'STICLĂ SECURIZATĂ 8 MM — GRI');
  assert.equal(glassLabel({ ...g, colorTr: '', colorRo: '' }, 'ro'), 'STICLĂ SECURIZATĂ 8 MM');
  const r = glassOrderItems([{ id: 'p', qty: '3' }, { id: '', qty: '1' }], [g]);
  assert.ok(r.ok);
  assert.deepEqual(r.items, [{ glassProductId: 'p', glassName: '8 MM TEMPER CAM — FÜME', glassNameRo: 'STICLĂ SECURIZATĂ 8 MM — GRI', glassWeightKgM2: 20, camAdedi: 3 }]);
  assert.equal(itemGlassName(r.items[0], 'ro'), 'STICLĂ SECURIZATĂ 8 MM — GRI');
  assert.equal(itemGlassName({ glassName: 'Eski kayıt', glassNameRo: null }, 'ro'), 'Eski kayıt', 'eski siparişte Romence ad yoksa Türkçesi');
});

test('sipariş satırı: pasif cam, geçersiz adet, boş seçim reddedilir', () => {
  const g = { id: 'p', isActive: true, nameTr: 'A', nameRo: 'B', weightKgM2: 1 };
  assert.deepEqual(glassOrderItems([{ id: '', qty: '1' }], [g]), { ok: false, code: 'NO_GLASS' });
  assert.deepEqual(glassOrderItems([{ id: 'p', qty: '1' }], [{ ...g, isActive: false }]), { ok: false, code: 'GLASS_GONE' });
  assert.deepEqual(glassOrderItems([{ id: 'yok', qty: '1' }], [g]), { ok: false, code: 'GLASS_GONE' });
  for (const qty of ['0', '-1', '1.5', '10000', 'abc']) assert.deepEqual(glassOrderItems([{ id: 'p', qty }], [g]), { ok: false, code: 'BAD_QTY' }, qty);
  assert.ok(glassOrderItems([{ id: 'p', qty: '9999' }], [g]).ok);
});

test('müşterinin yeni cam siparişi: tam olarak bir cam tipi — sıfır ve iki reddedilir (karar 85)', () => {
  const a = { id: 'a', isActive: true, nameTr: 'A', nameRo: 'A-ro', weightKgM2: 10 };
  const b = { id: 'b', isActive: true, nameTr: 'B', nameRo: 'B-ro', weightKgM2: 20 };
  assert.equal(CUSTOMER_GLASS_TYPES, 1);
  assert.deepEqual(glassOrderItems([], [a, b]), { ok: false, code: 'NO_GLASS' }, 'sıfır cam');
  assert.deepEqual(glassOrderItems([{ id: '', qty: '1' }, { id: '  ', qty: '2' }], [a, b]), { ok: false, code: 'NO_GLASS' }, 'boş seçimler cam sayılmaz');
  const one = glassOrderItems([{ id: 'a', qty: '5' }], [a, b]);
  assert.ok(one.ok, 'tek cam');
  assert.deepEqual(one.items.map((i) => [i.glassProductId, i.camAdedi]), [['a', 5]]);
  assert.deepEqual(glassOrderItems([{ id: 'a', qty: '1' }, { id: 'b', qty: '1' }], [a, b]), { ok: false, code: 'ONE_GLASS' }, 'iki farklı cam');
  assert.deepEqual(glassOrderItems([{ id: 'a', qty: '1' }, { id: 'a', qty: '3' }], [a, b]), { ok: false, code: 'ONE_GLASS' }, 'aynı cam iki satır da olmaz');
  // Kural adetten bağımsız: tek cam tipinden çok sayıda adet istenebilir
  assert.ok(glassOrderItems([{ id: 'b', qty: '9999' }], [a, b]).ok);
});

test('taslak: cam satırları gevşek kurallarla saklanır, bozuk veri okunurken atlanır', () => {
  assert.deepEqual(draftLines([{ id: 'a', qty: '2' }, { id: '', qty: '5' }, { id: 'b', qty: '' }]), [{ glassProductId: 'a', qty: 2 }, { glassProductId: 'b', qty: 1 }]);
  assert.throws(() => draftLines([{ id: 'a', qty: '0' }]), (e) => e.code === 'BAD_QTY');
  assert.deepEqual(readDraftItems([{ glassProductId: 'a', qty: 1 }, { glassProductId: 3 }, null, 'x']), [{ glassProductId: 'a', qty: 1 }]);
  assert.deepEqual(readDraftItems('bozuk'), []);
});
