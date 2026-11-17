// Cam siparişi FGO belge akışı — saf kurallar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { billingState, fgoUnitLine, glassDocLines, glassLines, invoiceLines, netOf, orderChain, renderDocEmail, ronGroup } from '../server/glass/billing.js';
import { emitereForm } from '../server/integrations/fgo.js';
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

test('belge RON satırları (karar 323): birim fiyat 2 hane; proforma faturanın düzeninde; iki belge kuruşu kuruşuna aynı', () => {
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
  // Proforma: aynı satırlar (CNC ve delik camın tutarında), aynı birim fiyat ve tutar
  const pro = glassDocLines(offer, rate, 21);
  assert.deepEqual(pro.map((l) => [l.name, l.qty, l.ron, l.net, l.gross]), inv.map((l) => [l.name, l.qty, l.ron, l.net, l.gross]));
  // Birim fiyat: grubun kesin tutarı / m², 2 haneye yuvarlanmış; satır tutarı FGO'nun hesabı (m² × birim fiyat)
  const exact = round2(round2(2.13 * ronPrice(47.3, rate)) + round2(3 * ronPrice(12.7, rate)) + round2(7 * ronPrice(1.33, rate)));
  assert.equal(inv[0].ron, round2(exact / 2.13));
  assert.equal(inv[0].net, round2(2.13 * inv[0].ron));
  assert.equal(inv[0].gross, grossOf(inv[0].net, 21));
  for (const l of inv) assert.equal(Number(l.ron.toFixed(2)), l.ron, '2 hane');
  // FGO'ya PretUnitar (2 hane) gider, PretTotal gitmez — proforma ve fatura aynı
  const settings = { cui: '1', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 };
  for (const [kind, rows] of [['proforma', pro], ['invoice', inv]]) {
    const f = emitereForm({ settings, key: 'K', kind, orderNo: 'X1', appUrl: '', customer: { name: 'X SRL' }, rate, lines: rows.map(fgoUnitLine) });
    assert.deepEqual([f['Continut[0][PretUnitar]'], f['Continut[0][PretTotal]'], f['Continut[1][PretUnitar]']], [inv[0].ron.toFixed(2), undefined, inv[1].ron.toFixed(2)], kind);
  }
});

test('ronGroup (karar 323): tek parça tek fiyatta birim fiyat = round2(EUR × kur); birleşen kalemlerde ortalama 2 hane', () => {
  assert.deepEqual(ronGroup([{ qty: 295.41, price: 72.5 }], 295.41, 5.096, 21), { ron: 369.46, net: round2(295.41 * 369.46), gross: grossOf(round2(295.41 * 369.46), 21) });
  // 48,36 m² × 65 € + 12 CNC × 15 €: birim fiyat 350,21 (önce 350,2078 çıkıyordu)
  assert.equal(ronGroup([{ qty: 48.36, price: 65 }, { qty: 12, price: 15 }], 48.36, 5.096, 21).ron, 350.21);
  assert.deepEqual(ronGroup([], 0, 5, 21), { ron: 0, net: 0, gross: 0 });
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
