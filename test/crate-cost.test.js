// Sandık parası fabrika maliyeti (karar 257): yöneticinin sandık bedelinin fabrika maliyeti kuralla 0 EUR'dur ve "maliyet
// eksik" uyarısına girmez. Kural tek yerde: server/orders/rules.js → missingCost (tedarikçi sayfası, yükleme onayı /
// kârlılık, eksik maliyet düzeltmesi aynı işlevi kullanır).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingCost, CRATE_LINE } from '../server/orders/rules.js';
import { missingCost as supplierMissingCost } from '../server/accounting/supplier.js';
import { lineTotals, itemAsLine } from '../server/loading/confirmation.js';

const glass = (extra = {}) => ({ kind: 'CAM', unit: 'm2', description: 'Temper 10', enMm: 1000, boyMm: 1000, adet: 1, free: false, unitPrice: 30, offerPrice: 60, ...extra });
const crate = (extra = {}) => ({ kind: 'CAM', unit: 'adet', description: CRATE_LINE.tr, adet: 2, free: false, crateFee: true, unitPrice: 0, offerPrice: 40, ...extra });

test('maliyet eksik: müşterinin ödediği, maliyeti 0 olan satır — sandık parası hariç', () => {
  assert.equal(missingCost(glass()), false);
  assert.equal(missingCost(glass({ unitPrice: 0 })), true, 'yöneticinin eklediği, fiyat tablosunda fiyatı olmayan cam');
  assert.equal(missingCost(glass({ unitPrice: null })), true);
  assert.equal(missingCost(glass({ unitPrice: 0, free: true })), false, 'bedelsiz');
  assert.equal(missingCost(glass({ unitPrice: 0, offerPrice: null })), false, 'müşteri fiyatı yok');
  // Yöneticinin sandık bedeli: maliyet 0 EUR kuraldır — eksik sayılmaz (işaretli ya da adıyla tanınan; iki dilde)
  assert.equal(missingCost(crate()), false);
  assert.equal(missingCost(crate({ crateFee: false })), false, 'onay kalemi biçimi (işaret yok): adı + adetli birim');
  assert.equal(missingCost(crate({ crateFee: false, description: CRATE_LINE.ro })), false);
  assert.equal(missingCost(crate({ crateFee: false, description: '  sandık PARASI ' })), false);
  // Adı sandık parası olsa da m² cam satırı sandık değildir
  assert.equal(missingCost(crate({ crateFee: false, unit: 'm2' })), true);
  // Tek kural: muhasebe modülü aynı işlevi dışa verir
  assert.equal(supplierMissingCost, missingCost);
});

test('yükleme onayı / kârlılık: sandık satırı maliyetsiz sayılmaz; maliyeti 0 olarak toplanır', () => {
  const t = lineTotals([glass(), crate()]);
  assert.equal(t.noCost, 0);
  const t2 = lineTotals([glass({ unitPrice: 0 }), crate()]);
  assert.equal(t2.noCost, 1, 'yalnızca maliyeti eksik cam sayılır');
  // Onay kalemi biçimi (crateFee alanı yok): itemAsLine üzerinden de aynı
  const item = { offerLineId: 'l1', id: 'i1', description: CRATE_LINE.tr, descriptionRo: CRATE_LINE.ro, enMm: null, boyMm: null, quantity: 2, unit: 'adet', kind: 'CAM', free: false, sortOrder: 1, unitCost: '0', unitSale: '40', weightKgM2: null, pieceBase: 0 };
  assert.equal(lineTotals([itemAsLine(item)]).noCost, 0);
});
