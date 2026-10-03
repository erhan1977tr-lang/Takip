// Cam siparişi FGO belge akışı — saf kurallar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingState, glassLines, invoiceLines, isLoaded, netOf, proformaLines, renderDocEmail } from '../server/glass/billing.js';
import { grossOf, ronPrice } from '../server/integrations/fgo.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

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
  assert.equal(netOf(1210, 21), 1000);
});

test('fatura RON satırları: eklenen kalemler TVA hariç; genel toplam proformayla kuruşu kuruşuna aynı (karar 63)', () => {
  const offer = { lines: [
    { kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat 8 mm', enMm: 1235, boyMm: 1000, adet: 1, offerPrice: '47.3' },
    { kind: 'CNC', unit: 'adet', description: 'CNC', adet: 3, offerPrice: '12.7' },
    { kind: 'DELIK', unit: 'adet', description: 'Delik', adet: 7, offerPrice: '1.33' },
    { kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat 8 mm', enMm: 887, boyMm: 1000, adet: 1, offerPrice: '47.3' },
    { kind: 'CAM', unit: 'm2', description: 'Lamine', descriptionRo: 'Laminat 44.2', enMm: 777, boyMm: 1000, adet: 1, offerPrice: '83.17' },
  ] };
  const rate = 5.0912;
  const inv = invoiceLines(offer, rate, 21);
  assert.deepEqual(inv.map((l) => [l.name, l.unit, l.qty]), [['Securizat 8 mm', 'mp', 2.13], ['Laminat 44.2', 'mp', 0.78]]);
  assert.ok(!inv.some((l) => /CNC|Gaură/.test(l.name)), 'faturada yalnızca cam');
  const pf = proformaLines(offer).map((l) => round2(l.qty * ronPrice(l.eur, rate)));
  const sum = (xs) => round2(xs.reduce((s, x) => s + x, 0));
  assert.equal(sum(inv.map((l) => l.net)), sum(pf), 'TVA hariç toplam = proforma');
  assert.equal(sum(inv.map((l) => l.gross)), sum(pf.map((n) => grossOf(n, 21))), 'TVA dahil toplam = proforma');
  // CNC/delik cama TVA hariç eklenir: Securizat = cam + 3 CNC + 7 delik + ikinci cam (her biri proformadaki gibi)
  assert.equal(inv[0].net, sum([pf[0], pf[1], pf[2], pf[3]]));
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
  // Karar 94: ödenmiş proforma + avans faturası yok + yüklenmiş → kapanış faturası düğmesi yok (düşüm uydurulmaz)
  const paidFgo = billingState({ ...base, loaded: true, docs: [{ ...P, paid: '500' }] });
  assert.deepEqual([paidFgo.actions, paidFgo.wait], [[], 'paid_no_advance'], 'FGO\'da tahsilat görünen proforma');
  const paidManual = billingState({ ...base, loaded: true, docs: [P], billing: { paidAmount: '300' } });
  assert.deepEqual([paidManual.actions, paidManual.wait], [[], 'paid_no_advance'], 'yöneticinin elle girdiği ödeme');
  // Ödenmemiş proforma (FGO 0 gösteriyor) ve avans faturası olan sipariş: akış değişmedi
  assert.deepEqual(billingState({ ...base, loaded: true, docs: [{ ...P, paid: '0' }] }).actions, ['invoice']);
  assert.deepEqual(billingState({ ...base, loaded: true, docs: [{ ...P, paid: '500' }, A], billing: { paidAmount: '500' } }).actions, ['invoice'], 'avans faturası varsa kapanış faturası (avans düşülür)');
  // Yüklenmeden önce ödenmiş proforma: avans faturası düğmesi aynen
  assert.deepEqual(billingState({ ...base, docs: [{ ...P, paid: '500' }] }).actions, ['advance']);
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
