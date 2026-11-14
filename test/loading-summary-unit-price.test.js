// Yükleme özeti — birim fiyat = Tutar / Metraj (karar 313; ürün sahibinin örneği ALE100): yöneticinin "Döküm (Fabrika)"
// sayfası, satışın "Döküm"ü ve (4.2.19, karar 317) yöneticinin müşteri fiyatlı "Döküm"ü. Guard: denetimcinin müşteri fiyatlı
// dökümü, tutar, metraj, toplamlar ve bedelsiz satır değişmez.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLoadingSummary, detailRows } from '../server/loading/summary.js';

const TEXT = { free: 'bedelsiz (telafi)', unit: 'm²' };
const glass = (description, en, boy, adet, unitPrice, offerPrice, extra = {}) => ({ kind: 'CAM', unit: 'm2', description, enMm: en, boyMm: boy, adet, unitPrice, offerPrice, ...extra });
// ALE100'e benzer: şekilli cam + CNC / delik (işlem bedeli tutarda)
const ORDERS = [
  { orderNo: 'ALE100', title: 'Daniel Poplaca', currency: 'EUR', customer: { id: 'a', name: 'Alegrad' }, lines: [
    glass('88.3 TEMPER LAMİNE CAM - ŞEKİLLİ', 1500, 2012, 1, '55.80', '83.20'),
    { kind: 'CNC', unit: 'adet', description: 'Kose Yuvarlama', adet: 2, unitPrice: '2.50', offerPrice: '2.50' },
    { kind: 'DELIK', unit: 'adet', description: 'CNC KÜÇÜK DELİK', adet: 4, unitPrice: '2.50', offerPrice: '2.50' },
  ] },
  { orderNo: 'ALE51', title: 'Telafi', currency: 'EUR', customer: { id: 'a', name: 'Alegrad' }, lines: [
    glass('88.3 TEMPER', 1000, 1000, 2, '49.5', '66.79', { free: true }),
  ] },
  { orderNo: 'GLA72', title: 'Ovidiu', currency: 'EUR', customer: { id: 'g', name: 'Glassandmore' }, lines: [glass('10 MM TEMPER', 1000, 2000, 3, '24', '33.41')] },
];
const factory = (unitPrice) => buildLoadingSummary(ORDERS, { priceOf: (l) => l.unitPrice, unitPrice });

test('fabrika dökümü: birim fiyat = tutar / metraj (CNC / delik birim fiyata dahil); tutar ve metraj aynı', () => {
  const avg = detailRows(factory(undefined), TEXT);
  const amt = detailRows(factory('amount'), TEXT);
  const row = (rows, no) => rows.find((r) => r[0] === no && !String(r[3]).includes('bedelsiz'));
  // ALE100: 1,5 × 2,012 → 3,02 m² × 55,80 = 168,52 + 2 × 2,50 + 4 × 2,50 = 183,52 → 183,52 / 3,02 = 60,77
  assert.deepEqual(row(avg, 'ALE100').slice(4, 9), [1, 'm²', 3.02, 55.8, 183.52], 'eski: cam fiyatı');
  assert.deepEqual(row(amt, 'ALE100').slice(4, 9), [1, 'm²', 3.02, 60.77, 183.52], 'yeni: tutar / metraj');
  // İşlemsiz satırda iki yol aynı sonucu verir
  assert.deepEqual(row(amt, 'GLA72'), row(avg, 'GLA72'));
  assert.equal(row(amt, 'GLA72')[7], 24);
  // Bedelsiz telafi satırı: fiyat ve tutar 0 (değişmez)
  const free = (rows) => rows.find((r) => String(r[3]).includes('bedelsiz'));
  assert.deepEqual(free(amt), free(avg));
  assert.deepEqual(free(amt).slice(7, 9), [0, 0]);
  // Toplamlar aynı
  assert.deepEqual(factory('amount').totals, factory(undefined).totals);
  for (const r of amt) if (r[6] > 0 && r[8] > 0) assert.equal(r[7], Math.round((r[8] / r[6]) * 100) / 100, `${r[0]}: birim fiyat × metraj ≈ tutar`);
});

test('müşteri fiyatlı döküm, varsayılan (denetimci): camın ağırlıklı ortalaması', () => {
  const rows = detailRows(buildLoadingSummary(ORDERS, { priceOf: (l) => l.offerPrice }), TEXT);
  const ale = rows.find((r) => r[0] === 'ALE100');
  assert.equal(ale[7], 83.2);
});

test('yöneticinin müşteri fiyatlı dökümü (karar 317): birim fiyat = tutar / metraj; tutar ve toplam aynı', () => {
  const customer = (unitPrice) => buildLoadingSummary(ORDERS, { priceOf: (l) => l.offerPrice, unitPrice });
  const ale = detailRows(customer('amount'), TEXT).find((r) => r[0] === 'ALE100');
  // 3,02 m² × 83,20 = 251,26 + 2 × 2,50 + 4 × 2,50 = 266,26 → 266,26 / 3,02 = 88,17
  assert.deepEqual(ale.slice(6, 9), [3.02, 88.17, 266.26]);
  assert.deepEqual(customer('amount').totals, customer(undefined).totals);
});

test('yapı: Yükleme Özeti — yöneticinin iki döküm sayfası ve satışın dökümü tutar / metraj; denetimcinin dökümü ortalama', () => {
  const route = fs.readFileSync(new URL('../app/(panel)/yuklemeler/dokum/route.ts', import.meta.url), 'utf8');
  assert.ok(route.includes("const finalPrice = admin || userCan(user, 'PRICE_FINAL_VIEW');"));
  assert.ok(route.includes('const factoryOnly = !finalPrice;'), 'satış: müşteri fiyatını görmeyen rol');
  assert.ok(route.includes('const amountPrice = admin || factoryOnly;'), 'yönetici (müşteri fiyatlı Döküm — karar 317) ve satış; denetimci değil');
  assert.ok(route.includes("buildLoadingSummary(orders, { priceOf: (l) => (admin ? l.offerPrice : l.unitPrice), unitPrice: amountPrice ? 'amount' : 'average' })"));
  assert.ok(route.includes("lines: buildLoadingSummary(orders, { priceOf: (l) => l.unitPrice, unitPrice: 'amount' })"), 'yöneticinin Döküm (Fabrika) sayfası');
});
