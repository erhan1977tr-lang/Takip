// Fiyat tabloları (Aşama 3b): Excel okuma/yazma, yükleme planı, tablo seçimi, teklif satırlarının doldurulması,
// liste fiyatından sapmalar. Veritabanısız saf kurallar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readXlsx, writeXlsx } from '../server/files/xlsx.js';
import { glassKey, parseCatalogSheet } from '../server/catalog/glass.js';
import {
  enrichLines, parsePrice, parsePriceSheet, planPriceImport, prefillLines, priceOverrides, priceSheetRows, resolveTable, validateTable,
} from '../server/pricing/tables.js';

const fixture = (f) => readXlsx(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url))).rows;
// Ürün sahibinin kataloğu (104 cam), id'ler test için
const catalog = parseCatalogSheet(fixture('cam-katalogu.xlsx')).items.map((it, i) => ({ id: `g${i}`, ...it.value }));
const byKey = new Map(catalog.map((g) => [glassKey(g.nameTr, g.colorTr), g]));

test('fiyat: sayı okuma (virgül, yuvarlama, sınırlar)', () => {
  assert.equal(parsePrice('30'), 30);
  assert.equal(parsePrice('30,5'), 30.5);
  assert.equal(parsePrice(12.345), 12.35);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(null), null);
  assert.ok(Number.isNaN(parsePrice('-1')));
  assert.ok(Number.isNaN(parsePrice('abc')));
  assert.ok(Number.isNaN(parsePrice(2_000_000)));
});

test('fiyat: tablo bilgileri doğrulanır', () => {
  assert.deepEqual(validateTable({ name: ' GKH  2026 ', currency: 'eur', holePrice: '3', cncPrice: '' }),
    { ok: true, value: { name: 'GKH 2026', currency: 'EUR', holePrice: 3, cncPrice: null } });
  assert.deepEqual(validateTable({ name: '', currency: 'XYZ', holePrice: 'x', cncPrice: '-2' }),
    { ok: false, errors: ['NAME', 'CURRENCY', 'HOLE_PRICE', 'CNC_PRICE'] });
});

test('fiyat Excel: ürün sahibinin dosyası okunur (90 fiyatlı, 14 boş cam; hepsi katalogda)', () => {
  const sheet = parsePriceSheet(fixture('fiyat-listesi.xlsx'));
  assert.equal(sheet.ok, true);
  assert.equal(sheet.currency, 'EUR');
  assert.equal(sheet.items.length, 90);
  assert.equal(sheet.blank, 14);
  assert.deepEqual(sheet.errors, []);
  assert.deepEqual(sheet.items[0], { row: 6, key: '10 MM TEMPER CAM|BRONZ', label: '10 MM TEMPER CAM — BRONZ', price: 30 });
  const plan = planPriceImport({ currency: 'EUR', holePrice: null, cncPrice: null }, catalog, new Map(), sheet);
  assert.equal(plan.set.length, 90);
  assert.equal(plan.unknown.length, 0);
  assert.equal(plan.currencyMismatch, false);
});

test('fiyat Excel: başlıksız / boş / hatalı satırlar', () => {
  assert.deepEqual(parsePriceSheet([['x']]), { ok: false, error: 'HEADERS' });
  assert.deepEqual(parsePriceSheet([['Cam adı', 'Renk', 'Birim fiyat']]), { ok: false, error: 'EMPTY' });
  const s = parsePriceSheet([
    ['Para birimi', 'RON'], ['Delik fiyatı', '2,5'], ['CNC fiyatı', 'x'], [],
    ['Cam adı', 'Renk', 'Birim fiyat'],
    ['4 MM FLOAT', 'ŞEFFAF', 'on'], ['4 MM FLOAT', 'ŞEFFAF', 10], ['4 mm float', 'şeffaf', 11], ['', 'BRONZ', 5], ['BİLİNMEYEN CAM', '', 7],
  ]);
  assert.equal(s.currency, 'RON');
  assert.equal(s.holePrice, 2.5);
  assert.equal(s.cncPrice, undefined, 'hatalı CNC fiyatı yok sayılır, hata listelenir');
  assert.deepEqual(s.errors.map((e) => [e.row, e.codes[0]]), [[3, 'PRICE'], [6, 'PRICE'], [8, 'DUPLICATE'], [9, 'NAME']]);
  const plan = planPriceImport({ currency: 'EUR', holePrice: 2.5, cncPrice: null }, [{ id: 'a', nameTr: '4 MM FLOAT', colorTr: 'ŞEFFAF' }], new Map([['a', 10]]), s);
  assert.equal(plan.currencyMismatch, true);
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.unknown, [{ row: 10, label: 'BİLİNMEYEN CAM' }]);
  assert.deepEqual(plan.extra, {}, 'aynı delik fiyatı değişiklik sayılmaz');
});

test('fiyat Excel: indirilen dosya aynen geri okunur (pasif cam listelenmez)', () => {
  const glasses = [
    { id: 'a', nameTr: '4 MM FLOAT', colorTr: 'ŞEFFAF', isActive: true },
    { id: 'b', nameTr: '6 MM TEMPER', colorTr: '', isActive: true },
    { id: 'c', nameTr: 'ESKİ CAM', colorTr: '', isActive: false },
  ];
  const rows = priceSheetRows({ name: 'GKH 2026', currency: 'EUR', holePrice: 3, cncPrice: null }, glasses, new Map([['a', 12.5], ['c', 9]]));
  const back = parsePriceSheet(readXlsx(writeXlsx({ sheetName: 'Fiyatlar', rows })).rows);
  assert.equal(back.currency, 'EUR');
  assert.equal(back.holePrice, 3);
  assert.equal(back.cncPrice, null);
  assert.deepEqual(back.items.map((i) => [i.key, i.price]), [['4 MM FLOAT|ŞEFFAF', 12.5]]);
  assert.equal(back.blank, 1);
});

test('fiyat: satışçının tablosu — kendi etkin tablosu, yoksa varsayılan', () => {
  const tables = [{ id: 'd', isActive: true, isDefault: true }, { id: 'x', isActive: true, isDefault: false }, { id: 'p', isActive: false, isDefault: false }];
  assert.equal(resolveTable({ priceTableId: 'x' }, tables)?.id, 'x');
  assert.equal(resolveTable({ priceTableId: null }, tables)?.id, 'd');
  assert.equal(resolveTable({ priceTableId: 'p' }, tables)?.id, 'd', 'pasif tablo yerine varsayılan');
  assert.equal(resolveTable({ priceTableId: null }, [{ id: 'x', isActive: true, isDefault: false }]), null);
});

const g1 = byKey.get('10 MM TEMPER CAM|BRONZ');
const pricing = { id: 't', name: 'T', currency: 'EUR', holePrice: 3, cncPrice: 12, prices: new Map([[g1.id, 30]]) };
const item = { glassProductId: g1.id, glassName: '10 MM TEMPER CAM — BRONZ', glassNameRo: 'X RO — BRONZ', glassWeightKgM2: 25, camAdedi: 3 };

test('teklif: satışçının taslağı siparişin camlarıyla ve liste fiyatıyla dolu gelir', () => {
  const [l] = prefillLines([item], pricing);
  assert.deepEqual(
    [l.description, l.descriptionRo, l.glassProductId, l.weightKgM2, l.adet, l.listPrice, l.unitPrice],
    ['10 MM TEMPER CAM — BRONZ', 'X RO — BRONZ', g1.id, 25, 3, 30, '30.00'],
  );
  const [none] = prefillLines([{ ...item, glassProductId: 'yok' }], pricing);
  assert.deepEqual([none.listPrice, none.unitPrice], [null, '0.00'], 'tabloda fiyatı olmayan cam: satışçı elle girer');
  assert.equal(prefillLines([item], null)[0].listPrice, null, 'tablo yoksa fiyat boş');
});

test('teklif: satırlar sunucuda tamamlanır — cam her iki dildeki adından tanınır, liste fiyatı korunur', () => {
  const base = { poz: null, enMm: 1000, boyMm: 1000, adet: 1, unit: 'm2', free: false };
  const lines = enrichLines([
    { ...base, kind: 'CAM', description: 'x ro — bronz', unitPrice: '28.00' }, // siparişteki Romence ad (büyük/küçük harf farkı yok)
    { ...base, kind: 'DELIK', description: '', unitPrice: '3.00', unit: 'adet' },
    { ...base, kind: 'CNC', description: '', unitPrice: '15.00', unit: 'adet' },
    { ...base, kind: 'CAM', description: 'Katalogda olmayan özel cam', unitPrice: '50.00' },
  ], { glasses: catalog, items: [item], previous: [], pricing });
  assert.deepEqual(lines.map((l) => [l.glassProductId, l.listPrice]), [[g1.id, 30], [null, 3], [null, 12], [null, null]]);
  assert.deepEqual([lines[0].description, lines[0].descriptionRo, lines[0].weightKgM2], ['10 MM TEMPER CAM — BRONZ', 'X RO — BRONZ', 25]);

  // Tablo sonradan değişse de teklifteki liste fiyatı teklif anındaki gibi kalır ("açık tekliflere uygula" yok)
  const later = { ...pricing, holePrice: 4, prices: new Map([[g1.id, 35]]) };
  const again = enrichLines(lines, { glasses: catalog, items: [item], previous: lines, pricing: later });
  assert.deepEqual(again.map((l) => l.listPrice), [30, 3, 12, null]);
});

test('teklif: liste fiyatından farklı satırlar (bedelsiz de sayılır)', () => {
  const d = priceOverrides([
    { kind: 'CAM', description: 'A', listPrice: 30, unitPrice: '30.00' },
    { kind: 'CAM', description: 'B', listPrice: 30, unitPrice: '28.00' },
    { kind: 'DELIK', description: '', listPrice: 3, unitPrice: '0.00', free: true },
    { kind: 'CAM', description: 'C', listPrice: null, unitPrice: '99.00' },
  ]);
  assert.deepEqual(d, [
    { line: 2, kind: 'CAM', description: 'B', listPrice: 30, unitPrice: 28, free: false },
    { line: 3, kind: 'DELIK', description: '', listPrice: 3, unitPrice: 0, free: true },
  ]);
});

test('sandık parası satırı: iki dilde tanınır, iki dildeki adıyla kaydedilir; sözlükle aynı metin', async () => {
  const { CRATE_LINE, offerLineTotals } = await import('../server/orders/rules.js');
  const { DICTS } = await import('../server/i18n/index.js');
  assert.equal(DICTS.tr.offer.editor.crateLine, CRATE_LINE.tr);
  assert.equal(DICTS.ro.offer.editor.crateLine, CRATE_LINE.ro);
  for (const description of [CRATE_LINE.tr, CRATE_LINE.ro, 'sandık parası']) {
    const [l] = enrichLines([{ kind: 'CAM', unit: 'adet', adet: 2, unitPrice: '35', description }], { glasses: [], pricing: null });
    assert.equal(l.description, CRATE_LINE.tr);
    assert.equal(l.descriptionRo, CRATE_LINE.ro);
    assert.equal(l.glassProductId, null);
    assert.equal(offerLineTotals(l).amount, 70, 'adet × fiyat (normal satır kuralı)');
  }
  const [other] = enrichLines([{ kind: 'CAM', unit: 'adet', adet: 1, unitPrice: '5', description: 'Nakliye' }], { glasses: [], pricing: null });
  assert.equal(other.descriptionRo, null);
});
