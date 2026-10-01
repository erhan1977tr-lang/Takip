// Excel'den teklif tablosuna aktarma: sütun eşleştirme sonrası satır doğrulama.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cellNumber, looksLikeHeader, validateImportRows } from '../server/orders/excel-import.js';

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
