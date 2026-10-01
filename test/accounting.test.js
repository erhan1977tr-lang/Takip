// Muhasebe (tahsilat durumu, yükleme kârı, fabrika bakiyesi) — saf hesaplar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentStatus, remaining } from '../server/accounting/receivables.js';
import { loadingProfits, orderLine, parseAmount, supplierSummary } from '../server/accounting/supplier.js';

test('tahsilat durumu: ödenmedi / kısmi / ödendi; kalan', () => {
  assert.equal(paymentStatus(null, null), 'UNKNOWN');
  assert.equal(paymentStatus('100', '0'), 'UNPAID');
  assert.equal(paymentStatus('100', null), 'UNPAID');
  assert.equal(paymentStatus('100', '40'), 'PARTIAL');
  assert.equal(paymentStatus('100', '100'), 'PAID');
  assert.equal(paymentStatus('100', '120'), 'PAID');
  assert.equal(remaining('100', '40'), 60);
  assert.equal(remaining('100', '120'), 0);
  assert.equal(remaining(null, '1'), null);
});

test('yükleme kârı: satış − maliyet − nakliye, para birimi başına; ödemeler ayrı (dağıtılmaz)', () => {
  const offer = (cur, amount, offerAmount) => ({ status: 'GONDERILDI', currency: cur, amount, offerAmount, lines: [{ description: 'Cam', enMm: 1000, boyMm: 1000, adet: 3, unit: 'm2', kind: 'CAM' }] });
  const day = new Date('2026-09-15T00:00:00Z');
  const lines = [
    orderLine({ id: 'a', orderNo: 'GLA1', actualShipDate: day, estimatedShipDate: null, offers: [offer('EUR', '600', '1000')] }),
    orderLine({ id: 'b', orderNo: 'GLA2', actualShipDate: null, estimatedShipDate: day, price: { amount: '550' }, offers: [offer('EUR', '300', '500')] }),
    orderLine({ id: 'c', orderNo: 'GLA3', actualShipDate: day, estimatedShipDate: null, offers: [{ ...offer('EUR', '1', '1'), status: 'YONETIMDE' }] }),
  ];
  assert.equal(lines[2], null, 'gönderilmemiş teklif sayılmaz');
  assert.equal(lines[1].sale, 550, 'yönetici fiyatı (Price) öncelikli');
  const days = loadingProfits(lines, [{ shipDay: day, amount: '100', currency: 'EUR' }, { shipDay: new Date('2026-09-20'), amount: '50', currency: 'RON' }]);
  assert.equal(days.length, 2);
  assert.equal(days[0].day, '2026-09-20', 'en yeni önce');
  const d = days[1];
  assert.equal(d.orders, 2);
  assert.equal(d.m2, 6);
  assert.deepEqual(d.byCur.EUR, { sale: 1550, cost: 900, transport: 100, profit: 550 });
  const s = supplierSummary(days, [{ amount: '700', currency: 'EUR' }, { amount: '10', currency: 'USD' }]);
  assert.deepEqual(s.EUR, { sale: 1550, cost: 900, transport: 100, profit: 550, paid: 700, balance: 200 });
  assert.deepEqual(s.RON, { sale: 0, cost: 0, transport: 50, profit: -50, paid: 0, balance: 0 });
  assert.deepEqual(s.USD, { sale: 0, cost: 0, transport: 0, profit: 0, paid: 10, balance: -10 });
});

test('tutar girişi', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1234.5'), 1234.5);
  assert.equal(parseAmount('1,234.50'), 1234.5);
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount('abc'), null);
});
