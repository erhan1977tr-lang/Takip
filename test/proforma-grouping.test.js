// P4 — proformada aynı teknik cam tek satır (karar 242): saf kural. Gruplama anahtarı, ağırlıklı ortalama fiyat (yalnızca
// gösterim), kesin tutar (parça parça), CNC / delik / sandık ayrı, kuruş kaybı / artışı yok (özellik testi), nihai fatura ve
// müşteri partisi kuralları.
import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceLines, proformaAmount, proformaFgoLines, proformaGlassKey, proformaLines } from '../server/glass/billing.js';
import { planOrder } from '../server/glass/batch.js';
import { grossOf, ronPrice, ronTotal } from '../server/integrations/fgo.js';
import { offerLineTotals } from '../server/orders/rules.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const cam = (ro, en, boy, adet, price, extra = {}) => ({ kind: 'CAM', unit: 'm2', description: `TR ${ro}`, descriptionRo: ro, enMm: en, boyMm: boy, adet, offerPrice: price, unitPrice: '1', ...extra });
const cnc = (adet, price) => ({ kind: 'CNC', unit: 'adet', description: 'CNC', adet, offerPrice: price, unitPrice: '1' });
const hole = (adet, price) => ({ kind: 'DELIK', unit: 'adet', description: 'Delik', adet, offerPrice: price, unitPrice: '1' });
const crate = (adet, price) => ({ kind: 'CAM', unit: 'adet', description: 'Sandık parası', descriptionRo: 'Ambalaj (ladă)', adet, offerPrice: price, unitPrice: '0', crateFee: true });
const S8 = 'Sticlă securizată 8 mm';

/** Eski kural: her teklif satırı ayrı proforma satırı — TVA hariç / dahil RON toplamı (FGO'nun satır başına hesabı) */
function ungrouped(lines, rate, vat) {
  let net = 0, gross = 0;
  for (const l of lines) {
    if (l.free || l.offerPrice == null) continue;
    const isGlass = (l.kind ?? 'CAM') === 'CAM' && (l.unit ?? 'm2') === 'm2';
    const qty = isGlass ? offerLineTotals({ ...l, unitPrice: 0 }).metraj : Math.max(0, Math.trunc(Number(l.adet) || 0));
    if (!(qty > 0)) continue;
    const n = round2(qty * ronPrice(l.offerPrice, rate));
    net = round2(net + n);
    gross = round2(gross + grossOf(n, vat));
  }
  return { net, gross };
}
/** Yeni proformanın FGO satırlarından toplam (PretTotal verilen satır o tutar; diğerleri adet × birim, KDV satır başına) */
function grouped(lines, rate, vat) {
  const fgo = proformaFgoLines(proformaLines({ lines }), rate, vat);
  let gross = 0;
  for (const l of fgo) gross = round2(gross + (l.gross != null ? l.gross : grossOf(round2(l.qty * ronPrice(l.eur, rate)), vat)));
  return { net: ronTotal(fgo, rate), gross, rows: fgo };
}

test('1. aynı teknik cam + aynı fiyat → tek satır; m² toplamı; fiyat aynen (ortalama yok); tutar parçalardan', () => {
  const rows = proformaLines({ lines: [cam(S8, 1000, 2000, 2, '50'), cam(S8, 1234, 1000, 1, '50'), cam(S8, 500, 500, 3, '50')] });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].name, rows[0].unit, rows[0].qty, rows[0].eur, rows[0].averaged], [S8, 'mp', 4 + 1.23 + 0.75, 50, false]);
  assert.equal(proformaAmount(rows[0]), round2(4 * 50 + 1.23 * 50 + 0.75 * 50));
});

test('2. aynı teknik cam + farklı fiyat → tek satır; gösterilen fiyat m² ağırlıklı ortalama; kesin tutar ayrı hesaplanır', () => {
  const rows = proformaLines({ lines: [cam(S8, 1000, 1000, 2, '47.30'), cam(S8, 887, 1000, 1, '49.90'), cam(S8, 1000, 333, 1, '51.15')] });
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.deepEqual(r.parts, [{ qty: 2, eur: 47.3 }, { qty: 0.89, eur: 49.9 }, { qty: 0.33, eur: 51.15 }]);
  assert.equal(r.qty, 3.22);
  assert.equal(r.averaged, true);
  assert.equal(r.eur, round2((2 * 47.3 + 0.89 * 49.9 + 0.33 * 51.15) / 3.22), 'Σ(m² × fiyat) / Σm²');
  // Kesin tutar ortalama fiyattan DEĞİL: parça parça
  assert.equal(proformaAmount(r), round2(round2(2 * 47.3) + round2(0.89 * 49.9) + round2(0.33 * 51.15)));
  // FGO satırı: TVA dahil toplamla (PretTotal) — miktar m² toplamı
  const [f] = proformaFgoLines(rows, 5.0912, 21);
  assert.equal(f.qty, 3.22);
  assert.ok(f.net > 0 && f.gross > f.net);
  assert.ok(!('parts' in f) && !('averaged' in f), 'FGO satırına iç alan gitmez');
});

test('3. farklı teknik camlar birleşmez; anahtar teknik ad (boşluk / harf büyüklüğü farkı aynı ad), kısaltılmış fatura adı değil', () => {
  const rows = proformaLines({ lines: [
    cam(S8, 1000, 1000, 1, '50'), cam('Sticlă laminată 8 mm', 1000, 1000, 1, '50'), cam('Sticlă securizată 10 mm', 1000, 1000, 1, '50'),
    cam('STICLĂ  SECURIZATĂ 8 mm ', 1000, 1000, 1, '50'),
  ] });
  assert.deepEqual(rows.map((r) => [r.name, r.qty]), [[S8, 2], ['Sticlă laminată 8 mm', 1], ['Sticlă securizată 10 mm', 1]]);
  // Nihai faturada ikisi de "Sticla 8 mm" yazılır — proforma anahtarı bu kısaltma DEĞİL
  assert.notEqual(proformaGlassKey(S8), proformaGlassKey('Sticlă laminată 8 mm'));
  assert.equal(proformaGlassKey(' sticlă   securizată 8 MM'), proformaGlassKey(S8));
  // Romence nitelik yoksa açıklama ad olur (eski kural) — o da kendi anahtarı
  const plain = proformaLines({ lines: [{ ...cam(S8, 1000, 1000, 1, '50'), descriptionRo: null, description: 'Temper 8' }, cam(S8, 1000, 1000, 1, '50')] });
  assert.deepEqual(plain.map((r) => r.name), ['Temper 8', S8]);
});

test('4. finansal ayrımlar: bedelsiz (tam indirim) satır girmez; siparişler arası birleşme yok; para birimi / KDV belge düzeyinde', () => {
  // Bedelsiz satır (telafi) proformaya hiç girmez — aynı camla birleşip tutarı / ortalamayı bozmaz
  const rows = proformaLines({ lines: [cam(S8, 1000, 1000, 2, '50'), cam(S8, 1000, 1000, 5, '0', { free: true }), cam(S8, 1000, 1000, 1, null)] });
  assert.deepEqual(rows.map((r) => [r.qty, r.eur, r.averaged]), [[2, 50, false]]);
  // Müşteri partisi: her sipariş kendi satırları — aynı cam iki siparişte iki satır (başında kaynak sipariş)
  const order = (id, no, currency = 'EUR') => ({ id, orderNo: no, status: 'URETIMDE', onHold: false, offers: [{ id: `of-${id}`, status: 'GONDERILDI', currency, lines: [cam(S8, 1000, 1000, 1, '50'), cam(S8, 1000, 1000, 1, '60')] }] });
  const a = planOrder(order('a', 'ABC1'), { day: '2026-11-02' });
  const c = planOrder(order('c', 'ABC2'), { day: '2026-11-02' });
  assert.deepEqual([...a.lines, ...c.lines].map((l) => [l.name, l.qty, l.price, l.amount]), [
    [`Comanda ABC1 — ${S8}`, 2, 55, 110], [`Comanda ABC2 — ${S8}`, 2, 55, 110],
  ]);
  // Para birimi siparişin teklifinde (partide karışık para birimi zaten engelli: MIXED_CURRENCY) — satır para birimi taşımaz;
  // RON teklifte kur 1: aynı kural
  const ron = planOrder(order('r', 'ABC3', 'RON'), { day: '2026-11-02' });
  assert.equal(ron.lines.length, 1);
  // KDV oranı belgenin oranıdır: aynı satırlar farklı oranla hesaplansa da birleşik satırın toplamı parça parça doğru
  for (const vat of [9, 19, 21]) {
    const lines = [cam(S8, 1235, 1000, 1, '47.30'), cam(S8, 887, 1000, 1, '49.90')];
    assert.deepEqual([grouped(lines, 5, vat).net, grouped(lines, 5, vat).gross], [ungrouped(lines, 5, vat).net, ungrouped(lines, 5, vat).gross], `KDV ${vat}`);
  }
});

test('5. CNC, delik ve sandık bedeli ayrı satırlar: cam grubuna girmez, birbiriyle birleşmez; sıra korunur', () => {
  const rows = proformaLines({ lines: [cam(S8, 1000, 1000, 1, '50'), cnc(2, '10'), hole(4, '2'), cam(S8, 1000, 1000, 1, '55'), hole(1, '2'), crate(1, '25'), cnc(1, '10')] });
  assert.deepEqual(rows.map((r) => [r.name, r.unit, r.qty, r.eur]), [
    [S8, 'mp', 2, 52.5], ['Prelucrare CNC', 'buc', 2, 10], ['Gaură', 'buc', 4, 2], ['Gaură', 'buc', 1, 2], ['Ambalaj (ladă)', 'buc', 1, 25], ['Prelucrare CNC', 'buc', 1, 10],
  ]);
  assert.ok(rows.slice(1).every((r) => r.parts.length === 1 && !r.averaged));
});

test('6. çok satırlı, küsuratlı, kısmi miktarlı teklif: TVA hariç ve dahil RON toplamı birleştirmeden öncekiyle kuruşu kuruşuna aynı (özellik testi)', () => {
  let seed = 20261010;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const names = [S8, 'Sticlă laminată 44.2', 'Sticlă securizată 10 mm', 'Sticlă extraclară 6 mm'];
  for (let round = 0; round < 400; round++) {
    const lines = [];
    const n = 1 + Math.floor(rnd() * 14);
    for (let i = 0; i < n; i++) {
      const k = rnd();
      const price = (5 + Math.floor(rnd() * 15000) / 100).toFixed(2);
      if (k < 0.6) lines.push(cam(pick(names), 100 + Math.floor(rnd() * 2900), 100 + Math.floor(rnd() * 2900), 1 + Math.floor(rnd() * 9), price, rnd() < 0.08 ? { free: true } : {}));
      else if (k < 0.75) lines.push(cnc(1 + Math.floor(rnd() * 5), price));
      else if (k < 0.9) lines.push(hole(1 + Math.floor(rnd() * 9), (Math.floor(rnd() * 500) / 100).toFixed(2)));
      else lines.push(crate(1 + Math.floor(rnd() * 3), price));
    }
    const rate = pick([1, 4.9763, 5.0912, 5.2020, 4.9701]);
    const vat = pick([19, 21]);
    const before = ungrouped(lines, rate, vat);
    const after = grouped(lines, rate, vat);
    assert.deepEqual([after.net, after.gross], [before.net, before.gross], `tur ${round}`);
    // Kaynak para biriminde de: Σ satır tutarı = Σ teklif satırı tutarı (fiyatlı, bedelsiz değil)
    const eur = round2(proformaLines({ lines }).reduce((s, r) => s + proformaAmount(r), 0));
    const eurBefore = round2(lines.filter((l) => !l.free).reduce((s, l) => {
      const isGlass = l.kind === 'CAM' && l.unit === 'm2';
      return s + round2((isGlass ? offerLineTotals({ ...l, unitPrice: 0 }).metraj : l.adet) * Number(l.offerPrice));
    }, 0));
    assert.equal(eur, eurBefore, `tur ${round} (kaynak)`);
    // m² toplamı korunur
    const m2 = (rows) => round2(rows.filter((r) => r.unit === 'mp').reduce((s, r) => s + r.qty, 0));
    assert.equal(m2(proformaLines({ lines })), round2(lines.filter((l) => !l.free && l.kind === 'CAM' && l.unit === 'm2').reduce((s, l) => s + offerLineTotals({ ...l, unitPrice: 0 }).metraj, 0)));
  }
});

test('7. nihai fatura satırları bu değişiklikten etkilenmez (yalnızca cam, işlemler cama eklenir; "Sticla …" adı)', () => {
  const offer = { lines: [cam(S8, 1235, 1000, 1, '47.3'), cnc(3, '12.7'), hole(7, '1.33'), cam(S8, 887, 1000, 1, '47.3'), cam('Sticlă laminată 44.2', 777, 1000, 1, '83.17')] };
  const inv = invoiceLines(offer, 5.0912, 21);
  assert.deepEqual(inv.map((l) => [l.name, l.unit, l.qty]), [['Sticla 8 mm', 'mp', 2.13], ['Sticla 44.2', 'mp', 0.78]]);
  // Fatura toplamı proformanın (yeni, birleşik) toplamıyla aynı kalır (karar 63)
  const pf = grouped(offer.lines, 5.0912, 21);
  assert.equal(round2(inv.reduce((s, l) => s + l.net, 0)), pf.net);
  assert.equal(round2(inv.reduce((s, l) => s + l.gross, 0)), pf.gross);
});

test('8. belge metni: satır adı Romence teknik ad (ilk satırınki), ölçü / adet adda yok; tek parçalı satır eskisi gibi birim fiyatla', () => {
  const rows = proformaFgoLines(proformaLines({ lines: [cam(S8, 1000, 1000, 1, '50'), cam(S8, 500, 1000, 1, '60'), cnc(1, '10'), cam('Sticlă laminată 44.2', 1000, 1000, 1, '80')] }), 5, 21);
  assert.deepEqual(rows.map((r) => r.name), [S8, 'Prelucrare CNC', 'Sticlă laminată 44.2']);
  assert.ok(rows.every((r) => !/\d+\s*[x×]\s*\d+|\bbuc\b/i.test(r.name)));
  assert.deepEqual(rows.slice(1).map((r) => [r.net, r.gross, r.eur]), [[undefined, undefined, 10], [undefined, undefined, 80]]);
  assert.deepEqual([rows[0].net, rows[0].gross], [round2(250 + 150), round2(grossOf(250, 21) + grossOf(150, 21))]);
});
