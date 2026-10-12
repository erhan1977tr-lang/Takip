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

test('satışın teklif tablosu (karar 267): PDF ve Excel her zaman, yalnız SATIŞIN kendi fiyatıyla — müşteri fiyatı ve yöneticinin sandık satırı dosyaya girmez; m² 3 ondalık', () => {
  const sales = { canExport: false, isAdmin: false, customerExcel: false, isSales: true };
  assert.equal(canExportOffer('pdf', sales), true);
  assert.equal(canExportOffer('xlsx', sales), true, 'müşteri Excel izni gerekmez');
  assert.equal(canExportOffer('csv', sales), false);
  // Satışa gelen satırlar sunucuda temizlenmiş: offerPrice null, yöneticinin sandık satırı yok (offerPrices)
  const lines = [
    { kind: 'CAM', description: 'Temper 8mm', poz: '81037', enMm: 1235, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '31.37', offerPrice: null, pieceM2: '1.235', shaped: true },
    { kind: 'CNC', description: 'CNC', adet: 2, unit: 'adet', unitPrice: '4.44', offerPrice: null },
  ];
  // route: satışta price → unitPrice (satış fiyatı)
  const data = offerExportData({ lines, price: (l) => l.unitPrice, locale: 'tr', kindLabel: (k) => k, shapedLabel: 'Şekilli' });
  assert.equal(data.metraj, 2.47);
  const text = {
    title: 'TEKLİF TABLOSU', orderNo: 'GLA40-1', firm: 'GLA**********', date: '12.10.2026', currency: 'EUR', notes: ['KDV hariç'],
    cols: { n: '#', desc: 'Açıklama', poz: 'Poz', en: 'En', boy: 'Boy', adet: 'Adet', m2: 'm²', unitPrice: 'Birim fiyat', amount: 'Tutar' },
    free: 'Bedelsiz', total: 'Toplam', piece: 'adet',
  };
  const x = readXlsx(offerXlsx(data, text)).rows;
  const flat = x.flat().map(String);
  assert.ok(x.some((r) => r.length === 9), 'fiyat sütunlarıyla');
  assert.ok(!flat.some((v) => /57[.,]11|9[.,]99/.test(v)), 'müşteri fiyatı yok');
  const glass = x.find((r) => r[1] === 'Temper 8mm (Şekilli)');
  assert.deepEqual([glass[2], Number(glass[6]), Number(glass[7]), Number(glass[8])], ['81037', 2.47, 31.37, 77.48]);
  assert.ok(x.some((r) => Number(r[7]) === 4.44 && Number(r[8]) === 8.88), 'CNC satış fiyatı');
  const totalRow = x.find((r) => r[0] === 'Toplam');
  assert.equal(Number(totalRow[6]), 2.47, 'toplam metraj');
  assert.equal(Number(totalRow[8]), 86.36, 'toplam = satış tutarları');
  const pdf = offerPdf(data, text);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});
