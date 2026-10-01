// Cam siparişi FGO belge akışı — saf kurallar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingState, glassLines, isLoaded, netOf, proformaLines, renderDocEmail, toRonLines } from '../server/glass/billing.js';

test('cam yüklendi: yükleme gününden 2 gün sonra (gerçek, yoksa tahmini gün)', () => {
  const o = (a, e) => ({ actualShipDate: a ? new Date(a) : null, estimatedShipDate: e ? new Date(e) : null });
  assert.equal(isLoaded(o(null, '2026-10-01T00:00:00Z'), '2026-10-02'), false);
  assert.equal(isLoaded(o(null, '2026-10-01T00:00:00Z'), '2026-10-03'), true);
  assert.equal(isLoaded(o('2026-09-20T00:00:00Z', '2026-10-30T00:00:00Z'), '2026-09-22'), true, 'gerçek gün öncelikli');
  assert.equal(isLoaded(o(null, null), '2030-01-01'), false);
});

test('belge satırları: yalnızca cam (Romence nitelik, ölçü/adet yok); CNC ve delik tutarı ilgili cama eklenir', () => {
  const lines = glassLines({ lines: [
    { kind: 'CNC', unit: 'adet', description: 'CNC', adet: 1, offerPrice: '7' }, // camdan önce: sonraki cama
    { kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat 8 mm', enMm: 1000, boyMm: 2000, adet: 2, offerPrice: '50', poz: 'K1' },
    { kind: 'CNC', unit: 'adet', description: 'CNC', adet: 3, offerPrice: '10' },
    { kind: 'DELIK', unit: 'adet', description: 'Delik', adet: 4, offerPrice: '2', free: true },
    { kind: 'DELIK', unit: 'adet', description: 'Delik', adet: 2, offerPrice: '2.5' },
    { kind: 'CAM', unit: 'm2', description: 'Lamine', descriptionRo: 'Laminat 44.2', enMm: 500, boyMm: 1000, adet: 1, offerPrice: '80' },
    { kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat 8 mm', enMm: 1000, boyMm: 1000, adet: 1, offerPrice: '50' },
    { kind: 'CAM', unit: 'm2', description: 'X', enMm: 100, boyMm: 100, adet: 1, offerPrice: null },
  ] });
  assert.deepEqual(lines, [
    { code: '', name: 'Securizat 8 mm', unit: 'mp', qty: 5, eurTotal: 200 + 7 + 30 + 5 + 50 },
    { code: '', name: 'Laminat 44.2', unit: 'mp', qty: 0.5, eurTotal: 40 },
  ]);
  const total = lines.reduce((s, l) => s + l.eurTotal, 0);
  assert.equal(total, 7 + 200 + 30 + 5 + 40 + 50, 'teklif toplamı korunur (bedelsiz hariç)');
  const ron = toRonLines(lines, 5);
  assert.deepEqual(ron[0], { code: '', name: 'Securizat 8 mm', unit: 'mp', qty: 5, ron: 292 }, '(292 € × 5) / 5 m²');
  assert.ok(!ron.some((l) => /CNC|Gaură|mm ×/.test(l.name)));
  assert.equal(netOf(1210, 21), 1000);
});

test('proforma satırları ayrıntılı: cam (nitelik, m²), CNC ve delik ayrı satırlarda; ölçü/adet adda yok', () => {
  const lines = proformaLines({ lines: [
    { kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat 8 mm', enMm: 1000, boyMm: 2000, adet: 2, offerPrice: '50' },
    { kind: 'CNC', unit: 'adet', description: 'CNC', adet: 3, offerPrice: '10' },
    { kind: 'DELIK', unit: 'adet', description: 'Delik', adet: 4, offerPrice: '2', free: true },
    { kind: 'DELIK', unit: 'adet', description: 'Delik', adet: 2, offerPrice: '2.5' },
    { kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat 8 mm', enMm: 1000, boyMm: 1000, adet: 1, offerPrice: '50' },
  ] });
  assert.deepEqual(lines, [
    { code: '', name: 'Securizat 8 mm', unit: 'mp', qty: 4, eur: 50 },
    { code: '', name: 'Prelucrare CNC', unit: 'buc', qty: 3, eur: 10 },
    { code: '', name: 'Gaură', unit: 'buc', qty: 2, eur: 2.5 },
    { code: '', name: 'Securizat 8 mm', unit: 'mp', qty: 1, eur: 50 },
  ]);
});

test('düğmeler: proforma → ödeme → avans → (yüklenince) fatura; müşteri onayı yok; tekrar kesim yok', () => {
  const base = { status: 'URETIMDE', loaded: false, docs: [], billing: null, pending: [], hasOffer: true };
  const P = { kind: 'PROFORMA', paid: null }, A = { kind: 'ADVANCE' }, F = { kind: 'INVOICE' };
  assert.deepEqual(billingState(base).actions, ['proforma']);
  assert.deepEqual(billingState({ ...base, docs: [P] }).actions, ['mark_paid']);
  assert.equal(billingState({ ...base, docs: [P] }).wait, 'wait_payment');
  assert.deepEqual(billingState({ ...base, docs: [{ ...P, paid: '500' }] }).actions, ['advance'], 'FGO\'da tahsilat görünürse');
  assert.deepEqual(billingState({ ...base, docs: [P], billing: { paidAmount: '300' } }).actions, ['advance'], 'elle girilen ödeme');
  assert.equal(billingState({ ...base, docs: [P], billing: { paidAmount: '300' } }).paidAmount, 300);
  assert.deepEqual(billingState({ ...base, docs: [P, A] }).actions, [], 'avanstan sonra yüklemeyi bekler');
  assert.deepEqual(billingState({ ...base, loaded: true }).actions, ['invoice'], 'yüklendi, avans yok → fatura');
  assert.deepEqual(billingState({ ...base, loaded: true, docs: [P] }).actions, ['invoice']);
  assert.deepEqual(billingState({ ...base, loaded: true, docs: [P, A] }).actions, ['invoice']);
  assert.deepEqual(billingState({ ...base, loaded: true, docs: [P, A, F] }).actions, []);
  assert.deepEqual(billingState({ ...base, pending: ['PROFORMA'] }).actions, [], 'kesilirken ikinci istek yok');
  assert.deepEqual(billingState({ ...base, hasOffer: false }).actions, []);
  assert.deepEqual(billingState({ ...base, status: 'IPTAL' }).actions, []);
});

test('müşteri e-postası Romence: belge no, tutar, PDF bağlantısı', () => {
  const m = renderDocEmail({ kind: 'ADVANCE', series: 'GKH', number: '685', orderNo: 'GLA68', total: '1210', link: 'https://fgo.example/x.pdf', firmName: 'Glass & More' });
  assert.equal(m.subject, 'Factură de avans GKH685 — comanda GLA68');
  assert.match(m.text, /Număr document: GKH685/);
  assert.match(m.text, /1210,00 RON \(cu TVA\)/);
  assert.match(m.text, /https:\/\/fgo\.example\/x\.pdf/);
  assert.match(m.html, /Glass &amp; More/);
});
