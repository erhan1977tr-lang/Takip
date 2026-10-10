// Paket C — saf kurallar ve yapı denetimleri (kararlar 230–236). Veritabanı / ağ yok.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { glassDocText, invoiceProductName, invoiceLines } from '../server/glass/billing.js';
import { snapshotLine } from '../server/loading/confirmation.js';
import { orderLine } from '../server/accounting/supplier.js';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('nihai fatura ürün adı (karar 236): "Sticla" + teknik kısım; securizată / laminată atılır; başka ad değişmez', () => {
  assert.equal(invoiceProductName('STICLĂ SECURIZATĂ LAMINATĂ 4.2.4., PVB OPAQUE (GRI+GRI)'), 'Sticla 4.2.4., PVB OPAQUE (GRI+GRI)');
  assert.equal(invoiceProductName('Sticlă securizată 10 mm'), 'Sticla 10 mm');
  assert.equal(invoiceProductName('Sticlă laminată 44.2'), 'Sticla 44.2');
  assert.equal(invoiceProductName('Sticla securizata, 8 mm extraclar'), 'Sticla 8 mm extraclar');
  assert.equal(invoiceProductName('Sticlă 10 mm - diagonală (transparentă)'), 'Sticla 10 mm - diagonală (transparentă)');
  assert.equal(invoiceProductName('Sticlă securizată'), 'Sticla');
  assert.equal(invoiceProductName('Oglindă 4 mm'), 'Oglindă 4 mm');
  assert.equal(invoiceProductName('6.2.6., Sticla, Gri-Transparent, securizata'), '6.2.6., Sticla, Gri-Transparent, securizata');
  assert.equal(invoiceProductName('Sticlarie'), 'Sticlarie', 'kelime sınırı');
  assert.equal(invoiceProductName(null), '');
});

test('fatura satırı: gruplama özgün adla, yazılan ad kısalır; tutar ve miktar değişmez', () => {
  const line = (descriptionRo, extra = {}) => ({ kind: 'CAM', unit: 'm2', enMm: 1000, boyMm: 1000, adet: 1, offerPrice: '50', descriptionRo, ...extra });
  const lines = invoiceLines({ lines: [line('Sticlă securizată 10 mm'), line('Sticlă securizată 10 mm', { adet: 2 }), line('Oglindă 4 mm')] }, 5, 21);
  assert.deepEqual(lines.map((l) => [l.name, l.qty, l.net]), [['Sticla 10 mm', 3, 750], ['Oglindă 4 mm', 1, 250]]);
});

test('FGO açıklaması (karar 235): EUR belgede kayıtlı kurun cümlesi; RON ya da kur yoksa boş (uydurulmaz)', () => {
  assert.equal(glassDocText('EUR', { fxRate: '4.9765', fxPolicy: 'BT_UNIT_SELL', fxSource: 'MANUAL_DAY' }), 'Curs de vânzare BT: 4.9765 RON/EUR.');
  assert.equal(glassDocText('EUR', { fxRate: '5', fxPolicy: 'BNR', fxSource: 'BNR', fxSourceDate: new Date('2026-10-02T00:00:00Z') }), 'Curs BNR: 5.0000 RON/EUR (data 02.10.2026).');
  assert.equal(glassDocText('EUR', { fxRate: '5.202', fxPolicy: 'BNR_PLUS_PERCENT', fxSource: 'BNR', fxMarkupPercent: '2' }), 'Curs de schimb aplicat: 5.2020 RON/EUR.');
  assert.doesNotMatch(glassDocText('EUR', { fxRate: '5.202', fxPolicy: 'BNR_PLUS_PERCENT', fxSource: 'BNR', fxMarkupPercent: '2' }), /%|BNR/);
  assert.equal(glassDocText('EUR', { fxRate: '5.25', fxPolicy: 'BNR', fxSource: 'MANUAL' }), 'Curs de schimb aplicat: 5.2500 RON/EUR.');
  assert.equal(glassDocText('RON', { fxRate: '1' }), '');
  assert.equal(glassDocText('EUR', null), '');
  assert.equal(glassDocText('EUR', { fxRate: null }), '');
  assert.equal(glassDocText('EUR', { fxRate: '0' }), '');
});

test('fiyat gizliliği (karar 237): müşteri fiyatı yoksa satış / fabrika fiyatına düşülmez', () => {
  // Teklif görünümü (lib/orders.ts → offerPrices): eski teklifte de müşteri fiyatı = offerPrice; tutar = offerAmount
  const orders = read('lib/orders.ts');
  const fn = orders.slice(orders.indexOf('function offerPrices'), orders.indexOf('export function sanitizeRows'));
  assert.ok(fn.includes('amount: o.offerAmount ?? null,'));
  assert.ok(fn.includes('unitPrice: l.offerPrice ?? (legacy ? null : ZERO)'));
  assert.ok(!/legacy \? (o\.amount|l\.unitPrice)/.test(fn), 'satış fiyatına geri düşüş yok');
  // Yükleme tutarı: Price ya da offerAmount — satış tutarı (amount) değil
  const loading = read('lib/loading.ts');
  assert.ok(!loading.includes('sent.offerAmount ?? sent.amount'));
  // Yükleme onayı kopyası: eski teklifte satış fiyatı boş, maliyet satış sayılmaz
  const line = { id: 'l1', kind: 'CAM', unit: 'm2', enMm: 1000, boyMm: 1000, adet: 2, unitPrice: '30', offerPrice: null };
  const o = { id: 'o1', customerId: 'c1' };
  const snap = snapshotLine(o, { currency: 'EUR', offerAmount: null }, line);
  assert.deepEqual([snap.unitCost, snap.unitSale], [30, null]);
  // Kârlılık: eski teklifte maliyet satış tutarı olarak yazılmaz
  const row = orderLine({ id: 'o1', orderNo: 'ABC1', actualShipDate: new Date('2026-10-01T10:00:00Z'), estimatedShipDate: null, offers: [{ status: 'GONDERILDI', currency: 'EUR', offerAmount: null, lines: [line] }] });
  assert.equal(row.cost, 60);
  assert.notEqual(row.sale, 60);
});
