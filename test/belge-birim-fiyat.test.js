// Karar 323 — cam proforması ve nihai fatura: birim fiyat virgülden sonra 2 hane; proforma faturanın düzeninde (aynı cam tek
// satır, CNC / delik / sandık camın tutarına eklenir); aynı kapsamda iki belge kuruşu kuruşuna aynı. Saf kural + özellik testi.
// (Önceki P4 — karar 242 proforma gruplaması bunun yerine geçti.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { fgoUnitLine, glassDocLines, glassTotals, invoiceLines, ronGroup } from '../server/glass/billing.js';
import { planOrder } from '../server/glass/batch.js';
import { emitereForm, grossOf, ronPrice } from '../server/integrations/fgo.js';
import { expectedGross } from '../server/finance/uncertain.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const cam = (ro, en, boy, adet, price, extra = {}) => ({ kind: 'CAM', unit: 'm2', description: `TR ${ro}`, descriptionRo: ro, enMm: en, boyMm: boy, adet, offerPrice: price, unitPrice: '1', ...extra });
const cnc = (adet, price) => ({ kind: 'CNC', unit: 'adet', description: 'CNC', adet, offerPrice: price, unitPrice: '1' });
const hole = (adet, price) => ({ kind: 'DELIK', unit: 'adet', description: 'Delik', adet, offerPrice: price, unitPrice: '1' });
const crate = (adet, price) => ({ kind: 'CAM', unit: 'adet', description: 'Sandık parası', descriptionRo: 'Ambalaj (ladă)', adet, offerPrice: price, unitPrice: '0', crateFee: true });
const S8 = 'Sticlă securizată 8 mm';
const settings = { cui: '1', proformaSeries: 'PRF', invoiceSeries: 'GKH', proformaType: 'Proforma', invoiceType: 'Factura', vatRate: 21 };
const form = (kind, lines, rate) => emitereForm({ settings, key: 'K', kind, orderNo: 'X1', appUrl: '', customer: { name: 'X SRL' }, rate, lines: lines.map(fgoUnitLine) });
const rows = (f) => {
  const out = [];
  for (let i = 0; `Continut[${i}][Denumire]` in f; i++) out.push({ name: f[`Continut[${i}][Denumire]`], qty: f[`Continut[${i}][NrProduse]`], unit: f[`Continut[${i}][PretUnitar]`], total: f[`Continut[${i}][PretTotal]`] });
  return out;
};
/** FGO'nun hesabı: satır = adet × birim fiyat, TVA satır başına */
const fgoGross = (f) => round2(rows(f).reduce((s, r) => s + grossOf(round2(Number(r.qty) * Number(r.unit)), 21), 0));

test('1. proforma faturanın düzeninde: aynı cam tek satır, CNC / delik / sandık camın tutarında; sıra ilk görülen cam', () => {
  const offer = { lines: [cnc(2, '10'), cam(S8, 1000, 1000, 2, '50'), hole(4, '2.5'), cam('Sticlă laminată 44.2', 1000, 500, 1, '80'), cam(S8, 1000, 1000, 1, '55'), crate(1, '30')] };
  const pro = glassDocLines(offer, 5, 21);
  assert.deepEqual(pro.map((l) => [l.name, l.unit, l.qty, l.eurTotal]), [[S8, 'mp', 3, round2(20 + 100 + 10 + 55 + 30)], ['Sticlă laminată 44.2', 'mp', 0.5, 40]]);
  // Sandık son camın grubunda olur (glassGroups kuralı) — fatura da öyle; toplam teklifin müşteri toplamı
  assert.deepEqual(pro.map((l) => l.eurTotal), glassTotals(offer).map((g) => g.total));
});

test('2. birim fiyat 2 hane; satır tutarı = m² × birim fiyat; FGO\'ya PretUnitar gider, PretTotal gitmez', () => {
  const offer = { lines: [cam(S8, 1234, 987, 3, '47.33'), cnc(5, '12.70'), hole(7, '1.33')] };
  const rate = 5.0912;
  for (const kind of ['proforma', 'invoice']) {
    const lines = kind === 'proforma' ? glassDocLines(offer, rate, 21) : invoiceLines(offer, rate, 21);
    const f = form(kind, lines, rate);
    for (const r of rows(f)) {
      assert.equal(r.total, undefined, `${kind}: PretTotal yok`);
      assert.match(r.unit, /^\d+\.\d{2}$/, `${kind}: birim fiyat 2 hane`);
    }
    assert.equal(fgoGross(f), round2(lines.reduce((s, l) => s + l.gross, 0)), `${kind}: TAKİP'teki tutar = FGO'nun hesabı`);
    assert.equal(expectedGross(lines.map(fgoUnitLine), { rate, vatRate: 21 }).gross, fgoGross(f), 'belirsiz sonuç doğrulaması aynı tutarı bekler');
  }
});

test('3. aynı kapsamda proforma ve fatura kuruşu kuruşuna aynı (özellik testi: küsuratlı ölçü, fiyat, kur, işlem)', () => {
  let seed = 323;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const names = [S8, 'Sticlă laminată 44.2', 'Sticlă float 6 mm'];
  for (let round = 0; round < 400; round++) {
    const lines = [];
    const n = 1 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      if (r < 0.6 || lines.length === 0) lines.push(cam(names[Math.floor(rnd() * 3)], 200 + Math.floor(rnd() * 2800), 200 + Math.floor(rnd() * 2800), 1 + Math.floor(rnd() * 9), (10 + rnd() * 140).toFixed(2)));
      else if (r < 0.75) lines.push(cnc(1 + Math.floor(rnd() * 20), (1 + rnd() * 40).toFixed(2)));
      else if (r < 0.9) lines.push(hole(1 + Math.floor(rnd() * 30), (0.5 + rnd() * 5).toFixed(2)));
      else lines.push(crate(1, (10 + rnd() * 60).toFixed(2)));
    }
    const rate = Number((4.9 + rnd() * 0.4).toFixed(4));
    const pro = glassDocLines({ lines }, rate, 21);
    const inv = invoiceLines({ lines }, rate, 21);
    assert.deepEqual(pro.map((l) => [l.qty, l.ron, l.net, l.gross]), inv.map((l) => [l.qty, l.ron, l.net, l.gross]), `tur ${round}`);
    assert.equal(fgoGross(form('proforma', pro, rate)), fgoGross(form('invoice', inv, rate)), `tur ${round}`);
    // Yuvarlama farkı satır başına en çok m² × 0,005 RON (birim fiyatın yarım banı)
    for (const l of pro) {
      let exact = 0;
      for (const p of l.parts) exact = round2(exact + round2(p.qty * ronPrice(p.price, rate)));
      assert.ok(Math.abs(l.net - exact) <= l.qty * 0.005 + 0.005 + 1e-9, `tur ${round}: ${l.net} ~ ${exact}`);
    }
  }
});

test('4. tek camlı, tek fiyatlı satır: birim fiyat = round2(EUR × kur) — bugünkü proforma birim fiyatıyla aynı', () => {
  const offer = { lines: [cam(S8, 1000, 1500, 2, '72.50')] };
  const [l] = glassDocLines(offer, 5.096, 21);
  assert.equal(l.ron, ronPrice('72.50', 5.096));
  assert.deepEqual(ronGroup([{ qty: 3, price: 72.5 }], 3, 5.096, 21).ron, l.ron);
});

test('5. bedelsiz ve fiyatsız satır yazılmaz; işlemi olup camı olmayan teklif boş', () => {
  assert.deepEqual(glassDocLines({ lines: [cam(S8, 1000, 1000, 1, '0', { free: true }), cam(S8, 1000, 1000, 1, null)] }, 5, 21), []);
  assert.deepEqual(glassDocLines({ lines: [cnc(2, '10')] }, 5, 21), []);
});

test('6. müşteri proforması (parti): sipariş başına aynı kural, kaynak tutarı ve RON hesabı aynı parçalardan', () => {
  const order = { id: 'o1', orderNo: 'ABC1', title: 'P', status: 'URETIMDE', onHold: false, fgoDocuments: [], billingBatchOrders: [],
    offers: [{ id: 'f', status: 'GONDERILDI', currency: 'EUR', lines: [cam(S8, 1000, 1000, 2, '50'), cnc(3, '10'), cam(S8, 1000, 500, 1, '60')] }] };
  const p = planOrder(order, { day: '2026-11-20' });
  assert.deepEqual(p.lines.map((l) => [l.name, l.unit, l.qty, l.amount, l.averaged]), [[`Comanda ABC1 — ${S8}`, 'mp', 2.5, 160, true]]);
  const [doc] = glassDocLines(order.offers[0], 5.0912, 21);
  assert.deepEqual(ronGroup(p.lines[0].parts, p.lines[0].qty, 5.0912, 21), { ron: doc.ron, net: doc.net, gross: doc.gross });
});
