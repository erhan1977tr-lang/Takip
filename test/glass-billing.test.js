// Cam siparişi FGO belge akışı — saf kurallar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingState, glassLines, invoiceLines, netOf, orderChain, proformaFgoLines, proformaLines, renderDocEmail } from '../server/glass/billing.js';
import { grossOf, ronPrice } from '../server/integrations/fgo.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

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
  // Proforma (P4 — karar 242): aynı cam tek satır (iki parça → TVA hariç / dahil toplamla); CNC ve delik ayrı satır
  const fgo = proformaFgoLines(proformaLines(offer), rate, 21);
  assert.deepEqual(fgo.map((l) => l.name), ['Securizat 8 mm', 'Prelucrare CNC', 'Gaură', 'Laminat 44.2']);
  const pf = fgo.map((l) => (l.net != null ? l.net : round2(l.qty * ronPrice(l.eur, rate))));
  const pg = fgo.map((l, i) => (l.gross != null ? l.gross : grossOf(pf[i], 21)));
  const sum = (xs) => round2(xs.reduce((s, x) => s + x, 0));
  assert.equal(sum(inv.map((l) => l.net)), sum(pf), 'TVA hariç toplam = proforma');
  assert.equal(sum(inv.map((l) => l.gross)), sum(pg), 'TVA dahil toplam = proforma');
  // CNC/delik cama TVA hariç eklenir: Securizat = iki cam (proformanın birleşik satırı) + 3 CNC + 7 delik
  assert.equal(inv[0].net, sum([pf[0], pf[1], pf[2]]));
});

test('proforma satırları ayrıntılı: cam (nitelik, m²), CNC ve delik ayrı satırlarda; ölçü/adet adda yok', () => {
  const lines = proformaLines({ lines: [
    { kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat 8 mm', enMm: 1000, boyMm: 2000, adet: 2, offerPrice: '50' },
    { kind: 'CNC', unit: 'adet', description: 'CNC', adet: 3, offerPrice: '10' },
    { kind: 'DELIK', unit: 'adet', description: 'Delik', adet: 4, offerPrice: '2', free: true },
    { kind: 'DELIK', unit: 'adet', description: 'Delik', adet: 2, offerPrice: '2.5' },
    { kind: 'CAM', unit: 'm2', description: 'Temper', descriptionRo: 'Securizat 8 mm', enMm: 1000, boyMm: 1000, adet: 1, offerPrice: '50' },
  ] });
  // Aynı teknik cam tek satır (P4 — karar 242); CNC ve delik ayrı satırlar, birbirleriyle de birleşmez
  assert.deepEqual(lines, [
    { code: '', name: 'Securizat 8 mm', unit: 'mp', qty: 5, eur: 50, averaged: false, parts: [{ qty: 4, eur: 50 }, { qty: 1, eur: 50 }] },
    { code: '', name: 'Prelucrare CNC', unit: 'buc', qty: 3, eur: 10, averaged: false, parts: [{ qty: 3, eur: 10 }] },
    { code: '', name: 'Gaură', unit: 'buc', qty: 2, eur: 2.5, averaged: false, parts: [{ qty: 2, eur: 2.5 }] },
  ]);
});

test('düğmeler (karar 239): proforma → (tahsilat) → avans; nihai fatura sipariş sayfasında YOK — ne tarih ne ödeme açar', () => {
  const base = { status: 'URETIMDE', loaded: false, docs: [], pending: [], hasOffer: true };
  const P = { kind: 'PROFORMA', paid: null }, F = { kind: 'INVOICE' };
  const A = (advanced, seq = 1) => ({ kind: 'ADVANCE', seq, advanced, total: advanced });
  const both = (p) => { const r = billingState(p); return [r.actions, r.wait]; };
  assert.deepEqual(both(base), [['proforma'], null]);
  // Proforma var, tahsilat yok: düğme yok; nihai fatura onaylı yüklemeden (yükleme günü Faturalama kartı) — "ödeme bekleniyor" yok
  assert.deepEqual(both({ ...base, docs: [P] }), [[], 'final_from_loading']);
  assert.deepEqual(both({ ...base, docs: [{ ...P, paid: '0' }] }), [[], 'final_from_loading'], 'ödenmemiş proforma engel değil');
  assert.deepEqual(billingState({ ...base, docs: [{ ...P, paid: '500' }] }).actions, ['advance'], 'tahsilat görünürse avans');
  assert.deepEqual(billingState({ ...base, docs: [{ ...P, paid: '500' }], billing: { paidAmount: '300' } }).advanceRequired, 500, 'elle girilmiş eski ödeme kaydı okunmaz');
  assert.deepEqual(both({ ...base, docs: [{ ...P, paid: '500' }, A('500')] }), [[], 'final_from_loading']);
  // Onaylı yükleme (loaded = kayıt var): hiçbir durumda 'invoice' yok; proformasız siparişe artık proforma da istenmez
  for (const docs of [[], [P], [{ ...P, paid: '0' }], [{ ...P, paid: '500' }, A('500')], [{ ...P, paid: '800' }, A('500'), A('300', 2)]]) {
    const r = billingState({ ...base, loaded: true, docs });
    assert.ok(!r.actions.includes('invoice'), JSON.stringify(docs));
    assert.equal(r.wait, 'final_from_loading');
  }
  assert.deepEqual(billingState({ ...base, loaded: true }).actions, [], 'onaylı yüklemesi olan siparişe sipariş düzeyi proforma yok');
  // Avans: yüklemeden önce de sonra da yalnızca fark kadar
  for (const loaded of [false, true]) {
    const more = billingState({ ...base, loaded, docs: [{ ...P, paid: '800' }, A('500')] });
    assert.deepEqual([more.actions, more.wait, more.paid, more.advanced, more.advanceRequired], [['advance'], loaded ? 'advance_required' : 'final_from_loading', 800, 500, 300]);
  }
  assert.deepEqual(both({ ...base, loaded: true, docs: [P, A('500'), F] }), [[], 'done'], 'eski sipariş düzeyi kapanış faturası: belge akışı tamam');
  assert.equal(billingState({ ...base, docs: [{ ...P, paid: '100.00' }, { kind: 'ADVANCE', seq: 1, advanced: '100.00', total: '99.99' }] }).advanceRequired, 0);
  assert.deepEqual(billingState({ ...base, pending: ['PROFORMA'] }).actions, [], 'kesilirken ikinci istek yok');
  assert.deepEqual(billingState({ ...base, docs: [{ ...P, paid: '500' }], pending: ['ADVANCE'] }).actions, [], 'avans kuyruktayken ikinci avans isteği yok (çift tıklama)');
  assert.deepEqual(billingState({ ...base, hasOffer: false }).actions, []);
  assert.deepEqual(billingState({ ...base, status: 'IPTAL' }).actions, []);
  // Müşteri proforması partisi sipariş başına belgeyi dışlar; kendi proforması olan sipariş (fatura partisinde olsa da) avans alabilir
  assert.deepEqual(both({ ...base, inBatch: true }), [[], 'batch']);
  assert.deepEqual(billingState({ ...base, inBatch: true, docs: [{ ...P, paid: '500' }] }).actions, ['advance']);
});

test('sipariş zinciri (orderChain): tahsilat − avansı kesilen; sıra; eski kayıtta avans tutarı = FGO toplamı', () => {
  const c = orderChain([
    { kind: 'ADVANCE', seq: 2, advanced: '300.00', total: '300.00', number: '12' },
    { kind: 'PROFORMA', paid: '1000.00', total: '1210.00' },
    { kind: 'ADVANCE', seq: 1, advanced: '500.00', total: '499.99', number: '11' },
  ]);
  assert.deepEqual([c.paid, c.advanced, c.advanceRequired, c.nextSeq, c.advances.map((a) => a.number)], [1000, 800, 200, 3, ['11', '12']]);
  assert.deepEqual(orderChain([{ kind: 'PROFORMA', paid: '605' }, { kind: 'ADVANCE', total: '605.00' }]).advanceRequired, 0, 'eski avans (advanced / seq yok): FGO toplamı');
  assert.deepEqual([orderChain([]).advanceRequired, orderChain([]).nextSeq], [0, 1]);
  // Tahsilat avanstan az (FGO'da ödeme geri alınmış): eksi avans olmaz
  assert.equal(orderChain([{ kind: 'PROFORMA', paid: '100' }, { kind: 'ADVANCE', seq: 1, advanced: '500' }]).advanceRequired, 0);
});

test('müşteri e-postası Romence: belge türü, no, tarih, sipariş, toplam; PDF ekte + TAKİP bağlantısı', () => {
  const m = renderDocEmail({ kind: 'ADVANCE', series: 'GKH', number: '685', issuedAt: '2026-10-04T09:00:00Z', orderNos: ['GLA68'], total: '1210', currency: 'RON', firmName: 'Glass & More', attached: true, portalUrl: 'https://takip.test/belgeler' });
  assert.equal(m.subject, 'Factură de avans GKH685 — comanda GLA68');
  assert.match(m.text, /Tip document: Factură de avans/);
  assert.match(m.text, /Număr document: GKH685/);
  assert.match(m.text, /Data emiterii: 04\.10\.2026/);
  assert.match(m.text, /Comanda: GLA68/);
  assert.match(m.text, /Total: 1\.210,00 RON \(cu TVA\)/);
  assert.match(m.text, /atașat acestui e-mail \(PDF\)/);
  assert.match(m.text, /https:\/\/takip\.test\/belgeler/);
  assert.match(m.html, /Glass &amp; More/);
});
