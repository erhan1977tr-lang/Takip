// Teklif dışa aktarma: izin (sunucu), satırlar/tutarlar PDF ve Excel'de aynı.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canExportOffer, offerExportData, offerXlsx } from '../server/orders/offer-export.js';
import { offerPdf } from '../server/pdf/offer.js';
import { readXlsx } from '../server/files/xlsx.js';

test('teklif dışa aktarma izni: yönetici her zaman; müşteri PDF her zaman, Excel yalnızca izinle', () => {
  const admin = { canExport: true, isAdmin: true, customerExcel: false };
  const customer = { canExport: true, isAdmin: false, customerExcel: false };
  assert.equal(canExportOffer('pdf', admin), true);
  assert.equal(canExportOffer('xlsx', admin), true);
  assert.equal(canExportOffer('pdf', customer), true);
  assert.equal(canExportOffer('xlsx', customer), false, 'izin yoksa Excel reddedilir');
  assert.equal(canExportOffer('xlsx', { ...customer, customerExcel: true }), true);
  assert.equal(canExportOffer('pdf', { canExport: false, isAdmin: false, customerExcel: true }), false, 'satış / çizim / denetimci');
  assert.equal(canExportOffer('csv', admin), false);
});

test('teklif dışa aktarma: müşteri fiyatıyla satırlar ve toplam; PDF ve Excel aynı veriden', () => {
  const lines = [
    { kind: 'CAM', description: 'Temper 8mm', descriptionRo: 'Securizat 8mm', poz: 'K1', enMm: 1000, boyMm: 2000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50' },
    { kind: 'CNC', description: 'CNC', enMm: null, boyMm: null, adet: 3, unit: 'adet', unitPrice: '5', offerPrice: '10' },
    { kind: 'DELIK', description: 'Delik', adet: 4, unit: 'adet', unitPrice: '1', offerPrice: '2', free: true },
  ];
  const data = offerExportData({ lines, price: (l) => l.offerPrice, locale: 'ro', kindLabel: (k) => (k === 'CNC' ? 'CNC' : 'Găuri') });
  assert.deepEqual(data.rows.map((r) => [r.n, r.desc, r.m2, r.unitPrice, r.amount]), [
    [1, 'Securizat 8mm', 4, 50, 200], [null, 'CNC', null, 10, 30], [null, 'Găuri', null, 0, 0],
  ]);
  assert.equal(data.total, 230, 'satış fiyatı (30) hiç kullanılmaz');
  assert.equal(data.metraj, 4);
  const text = {
    title: 'OFERTĂ', orderNo: 'GLA68', firm: 'Glass and More', date: '01.10.2026', currency: 'EUR', notes: ['Prețuri fără TVA.'],
    cols: { n: '#', desc: 'Descriere', poz: 'Poz', en: 'Lățime', boy: 'Înălțime', adet: 'Buc', m2: 'm²', unitPrice: 'Preț', amount: 'Valoare' },
    free: 'gratuit', total: 'Total', piece: 'buc',
  };
  const x = readXlsx(offerXlsx(data, text)).rows;
  const totalRow = x.find((r) => r[0] === 'Total');
  assert.equal(Number(totalRow[8]), 230);
  assert.ok(x.some((r) => r[1] === 'Securizat 8mm' && Number(r[8]) === 200));
  const pdf = offerPdf(data, text);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});
