// Excel'den teklif tablosuna aktarma: sütun eşleştirme sonrası satır doğrulama.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cellNumber, looksLikeHeader, validateImportRows } from '../server/orders/excel-import.js';
import { isXls, readXls } from '../server/files/xls.js';
import { XlsxError, readXlsx, writeXlsx } from '../server/files/xlsx.js';

test('Excel aktarma: genişlik/yükseklik > 0, adet tam sayı > 0; boş satır atlanır; başlık atlanabilir', () => {
  const rows = [
    ['Poz', 'En', 'Boy', 'Adet'],
    ['K1', 1000, 2000, 2],
    ['K2', '850,5', '1.950', '1'],
    [null, '', '', null], // tamamen boş → yok sayılır
    ['K3', 0, 500, 1],
    ['K4', 'abc', 500, 1.5],
    ['K5', 700, 800, '-3'],
  ];
  const map = { width: 1, height: 2, qty: 3 };
  assert.equal(looksLikeHeader(rows, map), true);
  const r = validateImportRows(rows, map, { skipHeader: true });
  assert.equal(r.valid, 2);
  assert.equal(r.invalid, 3);
  assert.deepEqual(r.rows.map((x) => [x.line, x.en, x.boy, x.adet, x.errors.join('+')]), [
    [2, 1000, 2000, 2, ''], [3, 851, 1950, 1, ''], [5, null, 500, 1, 'width'], [6, null, 500, null, 'width+qty'], [7, 700, 800, null, 'qty'],
  ]);
  const noSkip = validateImportRows(rows, map);
  assert.equal(noSkip.invalid, 4, 'başlık atlanmazsa geçersiz sayılır');
  assert.equal(cellNumber('1200 mm'), 1200);
  assert.equal(cellNumber(''), null);
  assert.ok(Number.isNaN(cellNumber('12x')));
  assert.equal(looksLikeHeader([[1, 2, 3]], { width: 0, height: 1, qty: 2 }), false);
});

test('eski Excel (.xls, BIFF8) okunur: metin (Türkçe / Romence), tam sayı, ondalık, boş satır; .xlsx ile aynı satırlar', () => {
  const buf = fs.readFileSync(new URL('./fixtures/olculer.xls', import.meta.url));
  assert.equal(isXls(buf), true);
  const { rows } = readXls(buf);
  assert.deepEqual(rows[0], ['Poz', 'Lățime', 'Înălțime', 'Adet', 'Not']);
  assert.deepEqual(rows[1], ['K1', 1000, 2000, 2, 'Şeffaf']);
  assert.deepEqual(rows[2].slice(0, 4), ['K2', '850,5', 1950, 1], 'metin olarak yazılmış ondalık da kabul edilir (doğrulamada sayıya çevrilir)');
  assert.deepEqual(rows[3], [], 'boş satır');
  assert.deepEqual(rows[5].slice(0, 4), ['K4', 700, 800, 1.5]);
  // Aynı doğrulama: 2 geçerli, 2 geçersiz (genişlik 0; adet 1,5), boş satır yok sayılır
  const map = { width: 1, height: 2, qty: 3 };
  const r = validateImportRows(rows, map, { skipHeader: looksLikeHeader(rows, map) });
  assert.deepEqual([r.valid, r.invalid], [2, 2]);
  assert.deepEqual(r.rows.filter((x) => !x.errors.length).map((x) => [x.en, x.boy, x.adet]), [[1000, 2000, 2], [851, 1950, 1]]);
  // .xlsx aynı sonucu verir; .xls olmayan içerik reddedilir
  const x = readXlsx(writeXlsx({ sheetName: 'a', rows: rows.map((row) => row.map((v) => v ?? '')) })).rows;
  assert.deepEqual(validateImportRows(x, map, { skipHeader: true }).valid, 2);
  assert.equal(isXls(Buffer.from('PK\u0003\u0004')), false);
  assert.throws(() => readXls(Buffer.from('bu bir excel değil')), XlsxError);
  assert.throws(() => readXls(Buffer.concat([buf.subarray(0, 600), Buffer.alloc(100)])), XlsxError, 'bozuk dosya');
});

// Karar 113: Excel'den aktarılan cam satırı olağan cam satırıdır (adet > 1 olabilir); sonradan işlem eklenirse aynı kural
test('Excel\'den aktarılan adet > 1 satır geçerlidir; işlem eklenince tek cam ayrılır (toplam adet ve tutar aynı)', async () => {
  const { offerProblems, offerTotals, sharedOpsGlasses, splitOnePiece } = await import('../server/orders/rules.js');
  const r = validateImportRows([['K1', 1000, 2000, 6], ['K2', 800, 600, 1]], { width: 1, height: 2, qty: 3 });
  assert.equal(r.valid, 2);
  // Teklif tablosuna aktarıldığı biçim: siparişteki cam, ölçü ve adet Excel'den, fiyat liste fiyatı
  const lines = r.rows.map((x) => ({ id: '', kind: 'CAM', description: 'Temper', enMm: String(x.en), boyMm: String(x.boy), adet: String(x.adet), unit: 'm2', unitPrice: '24' }));
  assert.deepEqual([offerProblems(lines), sharedOpsGlasses(lines)], [[], []], 'aktarılan satırlar adetle durur');
  const before = offerTotals(lines);
  assert.deepEqual([before.adet, before.metraj], [7, 12.48]);
  // +Delik (6 adetlik satıra): bir cam ayrılır, delik ona eklenir
  const s = splitOnePiece(lines, 0);
  const hole = { id: '', kind: 'DELIK', description: '', adet: '2', unit: 'adet', unitPrice: '2' };
  const after = [...s.lines.slice(0, s.index + 1), hole, ...s.lines.slice(s.index + 1)];
  assert.deepEqual(after.map((l) => [l.kind, l.enMm ?? '', l.adet]), [['CAM', '1000', '5'], ['CAM', '1000', '1'], ['DELIK', '', '2'], ['CAM', '800', '1']]);
  assert.deepEqual([offerProblems(after), sharedOpsGlasses(after)], [[], []]);
  const t = offerTotals(after);
  assert.deepEqual([t.adet, t.metraj, t.delik, t.amount], [7, 12.48, 2, before.amount + 4]);
  // Ayırmadan eklenseydi (taklit istek): belirsiz
  assert.deepEqual(sharedOpsGlasses([lines[0], hole, lines[1]]), [0]);
});
