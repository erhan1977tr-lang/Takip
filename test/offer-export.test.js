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

test('satışın teklif tablosu: PDF ve Excel her zaman, FİYATSIZ — satış / alış ve müşteri fiyatı dosyaya girmez; m² 3 ondalık', () => {
  const sales = { canExport: false, isAdmin: false, customerExcel: false, isSales: true };
  assert.equal(canExportOffer('pdf', sales), true);
  assert.equal(canExportOffer('xlsx', sales), true, 'müşteri Excel izni gerekmez');
  assert.equal(canExportOffer('csv', sales), false);
  const lines = [
    { kind: 'CAM', description: 'Temper 8mm', poz: 'K1', enMm: 1235, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '31.37', offerPrice: '57.11', pieceM2: '1.235', shaped: true },
    { kind: 'CNC', description: 'CNC', adet: 2, unit: 'adet', unitPrice: '4.44', offerPrice: '9.99' },
  ];
  // route: satışta price → null (fiyatsız)
  const data = offerExportData({ lines, price: () => null, locale: 'tr', kindLabel: (k) => k, shapedLabel: 'Şekilli' });
  assert.equal(data.metraj, 2.47);
  const text = {
    title: 'TEKLİF TABLOSU', orderNo: 'GLA40-1', firm: 'GLA**********', date: '12.10.2026', currency: 'EUR', notes: ['Fiyatsız'], noPrices: true,
    cols: { n: '#', desc: 'Açıklama', poz: 'Poz', en: 'En', boy: 'Boy', adet: 'Adet', m2: 'm²', unitPrice: 'Birim fiyat', amount: 'Tutar' },
    free: 'Bedelsiz', total: 'Toplam', piece: 'adet',
  };
  const x = readXlsx(offerXlsx(data, text)).rows;
  const flat = x.flat().map(String);
  assert.ok(!flat.some((v) => /31[.,]37|57[.,]11|4[.,]44|9[.,]99|Birim fiyat|Tutar/.test(v)), 'fiyat ya da fiyat sütunu yok');
  assert.ok(x.every((r) => r.length <= 7), 'yalnızca 7 sütun');
  const totalRow = x.find((r) => r[0] === 'Toplam');
  assert.equal(Number(totalRow[5]), 2, 'toplam adet');
  assert.equal(Number(totalRow[6]), 2.47, 'toplam metraj');
  assert.ok(x.some((r) => r[1] === 'Temper 8mm (Şekilli)' && Number(r[6]) === 2.47));
  const pdf = offerPdf(data, text);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  // yönetici / müşteri dosyası değişmedi: fiyat sütunları yerinde
  const priced = readXlsx(offerXlsx(offerExportData({ lines, price: (l) => l.offerPrice, locale: 'tr', kindLabel: (k) => k }), { ...text, noPrices: false })).rows;
  assert.ok(!priced.find((r) => r[0] === 'Toplam')[5], 'fiyatlı dosyada toplam satırı eskisi gibi (adet boş)');
  assert.ok(priced.some((r) => r.length === 9));
});
