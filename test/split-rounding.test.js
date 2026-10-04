// Karar 114 — işlem (CNC / delik) eklemek için adetli cam satırının ayrılması (5 → 4 + 1) yalnızca fiziksel camların
// GÖSTERİMİDİR: toplam cam adedi, toplam m², müşteri tutarı ve fabrika maliyeti değişmemelidir. Önceden m² satır başına
// yuvarlandığı için round(m² × 4) + round(m² × 1) ≠ round(m² × 5) olabiliyordu (0,01 m² ve onun fiyatla çarpımı kadar fark).
// Burada bilinen sorunlu ölçülerle (333 × 1000, 335 × 1000 …) teklif, proforma, fatura ve onaylı yükleme hesapları sınanır.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignPieceBases, atOfferPrice, isSplitKey, offerLineTotals, offerProblems, offerTotals, pieceStartArea, sharedOpsGlasses, splitOnePiece } from '../server/orders/rules.js';
import { glassLines, glassTotals, invoiceLines, proformaLines } from '../server/glass/billing.js';
import { itemAsLine, lineTotals, snapshotLine } from '../server/loading/confirmation.js';

const glass = (extra = {}) => ({ id: 'L1', kind: 'CAM', description: 'Temper', descriptionRo: 'Securizat', enMm: 333, boyMm: 1000, adet: 5, unit: 'm2', unitPrice: '41.50', offerPrice: '66.96', free: false, ...extra });
const hole = (extra = {}) => ({ id: '', kind: 'DELIK', description: '', adet: 2, unit: 'adet', unitPrice: '3.00', offerPrice: '5.00', free: false, ...extra });
const key = () => 'grp1';
/** Ekrandaki "+Delik": cam ayrılır, delik ayrılan cama eklenir; sıra sunucudaki işlevle hesaplanır */
const splitWithHole = (lines, index = 0, h = hole()) => {
  const s = splitOnePiece(lines, index, undefined, key);
  return assignPieceBases([...s.lines.slice(0, s.index + 1), h, ...s.lines.slice(s.index + 1)]);
};
/** Eski hesap (satır başına yuvarlama): ayrılmış satırlar grup bilgisi olmadan */
const naive = (lines) => lines.map((l) => ({ ...l, splitGroup: null, pieceBase: 0 }));

test('ayırma toplamı değiştirmez: 333 × 1000, 5 adet → 4 + 1 (m², satış / maliyet tutarı, müşteri tutarı, adet)', () => {
  const before = [glass()];
  const cost = offerTotals(before);
  const sale = offerTotals(atOfferPrice(before));
  assert.deepEqual([cost.adet, cost.metraj, cost.amount, sale.amount], [5, 1.67, 69.3, 111.82]);

  const split = assignPieceBases(splitOnePiece(before, 0, undefined, key).lines);
  assert.deepEqual(split.map((l) => [l.adet, l.splitGroup, l.pieceBase]), [[4, 'grp1', 0], [1, 'grp1', 4]]);
  // Eski hesapta fark vardı: 1,33 + 0,33 = 1,66 m² (0,01 m² eksik) → tutarlar da değişiyordu
  assert.deepEqual([offerTotals(naive(split)).metraj, offerTotals(naive(split)).amount, offerTotals(atOfferPrice(naive(split))).amount], [1.66, 68.9, 111.16]);
  // Yeni hesap: kalemin m²'si TOPLAM adetten (5) hesaplanır; satırlar bu toplamı paylaşır
  const after = offerTotals(split);
  assert.deepEqual([after.adet, after.metraj, after.amount], [cost.adet, cost.metraj, cost.amount]);
  assert.equal(offerTotals(atOfferPrice(split)).amount, sale.amount);
  assert.deepEqual(split.map((l) => offerLineTotals(l).metraj), [1.33, 0.34], 'satırların payı: 1,33 + 0,34 = 1,67');
  assert.deepEqual([pieceStartArea(split[0]), pieceStartArea(split[1])], [0, 1.33]);
});

test('işlem eklemek toplamı YALNIZCA işlemin tutarı kadar değiştirir; art arda ayırmalar da toplamı korur', () => {
  const before = [glass(), glass({ id: 'L2', description: 'Lamine', enMm: 800, boyMm: 615, adet: 3, unitPrice: '37', offerPrice: '77.77' })];
  const cost = offerTotals(before);
  const sale = offerTotals(atOfferPrice(before));
  // +Delik (5 adetlik cama): 4 + 1 + delik
  let lines = splitWithHole(before);
  assert.deepEqual(lines.map((l) => [l.kind, l.adet]), [['CAM', 4], ['CAM', 1], ['DELIK', 2], ['CAM', 3]]);
  assert.deepEqual([offerProblems(lines), sharedOpsGlasses(lines)], [[], []]);
  let t = offerTotals(lines);
  assert.deepEqual([t.adet, t.metraj, t.delik, t.amount], [cost.adet, cost.metraj, 2, Math.round((cost.amount + 6) * 100) / 100]);
  assert.equal(offerTotals(atOfferPrice(lines)).amount, Math.round((sale.amount + 10) * 100) / 100);
  // Bir cama daha (kalan 4'lük satırdan) ve sonra 3'lük başka cama: her adımda cam toplamı aynı
  lines = splitWithHole(lines, 0, hole({ adet: 1 }));
  assert.deepEqual(lines.map((l) => [l.kind, l.adet, l.pieceBase ?? 0]), [['CAM', 3, 0], ['CAM', 1, 3], ['DELIK', 1, 0], ['CAM', 1, 4], ['DELIK', 2, 0], ['CAM', 3, 0]]);
  t = offerTotals(lines);
  assert.deepEqual([t.adet, t.metraj, t.amount], [cost.adet, cost.metraj, Math.round((cost.amount + 9) * 100) / 100]);
  assert.equal(offerTotals(atOfferPrice(lines)).amount, Math.round((sale.amount + 15) * 100) / 100);
});

test('her ölçü / adet / fiyat için: tek tek ayrılana kadar toplam m² ve iki tutar ayrılmamış satırla aynı', () => {
  let cases = 0, drifted = 0;
  for (const [enMm, boyMm] of [[333, 1000], [335, 1000], [1234, 567], [777, 333], [505, 505], [615, 1215], [2999, 1999], [1000, 2000]]) {
    for (const adet of [2, 3, 5, 7, 10, 13]) {
      for (const [unitPrice, offerPrice] of [['41.50', '66.96'], ['37', '0.01'], ['123.45', '199.99']]) {
        const line = glass({ enMm, boyMm, adet, unitPrice, offerPrice });
        const cost = offerTotals([line]);
        const sale = offerTotals(atOfferPrice([line]));
        let lines = [line];
        for (let k = 1; k < adet; k++) {
          lines = assignPieceBases(splitOnePiece(lines, 0, undefined, key).lines);
          const c = offerTotals(lines);
          const s = offerTotals(atOfferPrice(lines));
          assert.deepEqual([c.adet, c.metraj, c.amount, s.amount], [cost.adet, cost.metraj, cost.amount, sale.amount], `${enMm}×${boyMm} × ${adet} @ ${unitPrice}: ${k}. ayırma`);
          cases += 1;
          if (offerTotals(naive(lines)).metraj !== cost.metraj) drifted += 1;
        }
      }
    }
  }
  assert.ok(cases > 800 && drifted > 100, 'bu ölçülerin çoğunda eski hesap fark veriyordu');
});

test('olağan satırlar (ayrılmamış) eskisi gibi hesaplanır; grup yalnızca aynı cam + aynı ölçü için geçerlidir', () => {
  // pieceBase 0: m² = round(en × boy × adet), tutar = round(m² × fiyat) — değişmedi
  for (const [enMm, boyMm, adet, p] of [[333, 1000, 5, 41.5], [1234, 567, 7, 66.96], [1000, 2000, 3, 37]]) {
    const m2 = Math.round(((enMm * boyMm) / 1_000_000) * adet * 100 + Number.EPSILON * 100) / 100;
    const t = offerLineTotals(glass({ enMm, boyMm, adet, unitPrice: String(p) }));
    assert.equal(t.metraj, Math.round((((enMm * boyMm) / 1_000_000) * adet + Number.EPSILON) * 100) / 100);
    assert.equal(t.amount, Math.round((t.metraj * p + Number.EPSILON) * 100) / 100);
    assert.ok(Math.abs(m2 - t.metraj) < 0.011);
  }
  // Aynı cam, aynı ölçü ama ayrılmamış (anahtarsız) iki satır: gruplanmaz — eski hesap
  const two = assignPieceBases([glass({ adet: 4 }), glass({ id: 'L9', adet: 1 })]);
  assert.deepEqual(two.map((l) => [l.splitGroup, l.pieceBase]), [[null, 0], [null, 0]]);
  assert.equal(offerTotals(two).metraj, 1.66);
  // Anahtar: ölçüsü / camı farklı satır gruba giremez; tek kalan satır olağan satırdır; işlem ve adet birimli satır gruplanmaz
  const mixed = assignPieceBases([
    glass({ adet: 4, splitGroup: 'k' }), glass({ adet: 1, splitGroup: 'k', enMm: 334 }), glass({ adet: 1, splitGroup: 'k', description: 'Başka' }),
    glass({ adet: 1, splitGroup: 'k' }), hole({ splitGroup: 'k' }), glass({ adet: 2, splitGroup: 'tek' }), glass({ adet: 2, splitGroup: 'k', unit: 'adet' }),
    glass({ adet: 1, splitGroup: 'kötü anahtar!' }), glass({ adet: 1, splitGroup: 'kötü anahtar!' }),
  ]);
  assert.deepEqual(mixed.map((l) => [l.splitGroup, l.pieceBase]), [['k', 0], [null, 0], [null, 0], ['k', 4], [null, 0], [null, 0], [null, 0], [null, 0], [null, 0]]);
  assert.deepEqual([isSplitKey('g1a2b3'), isSplitKey(''), isSplitKey(null), isSplitKey('a b'), isSplitKey('x'.repeat(41))], [true, false, false, false, false]);
  // Kalan satırın adedi sonradan değişirse (gerçek adet değişikliği) sıra yeniden hesaplanır: 3 + 1 → kalem 4 cam
  const edited = assignPieceBases([glass({ adet: 3, splitGroup: 'k', pieceBase: 0 }), glass({ adet: 1, splitGroup: 'k', pieceBase: 4 })]);
  assert.deepEqual(edited.map((l) => l.pieceBase), [0, 3]);
  assert.equal(offerTotals(edited).metraj, offerTotals([glass({ adet: 4 })]).metraj);
});

test('ayrılan cam farklı fiyatlanırsa ya da bedelsiz yapılırsa m² yine kalemin toplamıdır; tutar her satırın kendi fiyatıyla', () => {
  const split = assignPieceBases(splitOnePiece([glass()], 0, undefined, key).lines);
  const priced = [split[0], { ...split[1], unitPrice: '50' }];
  assert.equal(offerTotals(priced).metraj, 1.67);
  // 1,33 m² × 41,50 = 55,20 (55,195 → mevcut yuvarlama) · ayrılan cam 0,34 m² × 50: tutar(1,67 × 50) − tutar(1,33 × 50) = 83,50 − 66,50
  assert.deepEqual(priced.map((l) => offerLineTotals(l).amount), [55.2, 17]);
  const free = [split[0], { ...split[1], free: true }];
  assert.deepEqual([offerTotals(free).metraj, offerTotals(free).amount], [1.67, 55.2]);
});

test('proforma ve fatura: ayrılmış cam ayrı satır / parça olmaz — belgeler ayrılmamış teklifinkiyle aynıdır', () => {
  const before = { lines: [glass(), glass({ id: 'L2', description: 'Lamine', descriptionRo: 'Laminat', enMm: 800, boyMm: 615, adet: 3, unitPrice: '37', offerPrice: '77.77' })] };
  // Teklifte 5'lik camdan biri ayrıldı; karşılaştırma camla ilgili olsun diye eklenen delik bedelsiz
  const after = { lines: splitWithHole(before.lines, 0, hole({ free: true, unitPrice: '0', offerPrice: '0' })) };
  assert.deepEqual(proformaLines(after), proformaLines(before));
  assert.deepEqual(proformaLines(before).map((l) => [l.name, l.qty, l.eur]), [['Securizat', 1.67, 66.96], ['Laminat', 1.48, 77.77]]);
  assert.deepEqual(glassLines(after), glassLines(before));
  assert.deepEqual(glassTotals(after), glassTotals(before));
  for (const rate of [4.9763, 5.0912, 5.2020]) {
    for (const vat of [19, 21]) assert.deepEqual(invoiceLines(after, rate, vat), invoiceLines(before, rate, vat), `kur ${rate}, TVA ${vat}`);
  }
  // Maliyet tarafı (satış fiyatıyla, bedelsiz dahil) da aynı
  const opts = { nameOf: (l) => l.description, priceOf: (l) => l.unitPrice, includeFree: true };
  assert.deepEqual(glassTotals(after, opts), glassTotals(before, opts));
  // Eski hesapta proforma iki cam satırı (1,33 + 0,33) ve 1,66 m² gösterirdi
  assert.deepEqual(proformaLines({ lines: naive(after.lines) }).map((l) => l.qty), [1.33, 0.33, 1.48]);
  // Ücretli delik: yalnızca kendi satırı / tutarı eklenir, cam satırı aynı kalır
  const paid = { lines: splitWithHole(before.lines) };
  assert.deepEqual(proformaLines(paid).map((l) => [l.name, l.qty, l.eur]), [['Securizat', 1.67, 66.96], ['Gaură', 2, 5], ['Laminat', 1.48, 77.77]]);
  assert.equal(glassTotals(paid)[0].total, Math.round((glassTotals(before)[0].total + 10) * 100) / 100);
  assert.equal(glassTotals(paid)[0].qty, 1.67);
  // Ayrılan cama yönetici başka müşteri fiyatı verdiyse ayrı satırdır (fiyat farklı); m² toplamı yine 1,67
  const other = { lines: after.lines.map((l, i) => (i === 1 ? { ...l, offerPrice: '70.00' } : l)) };
  assert.deepEqual(proformaLines(other).slice(0, 2).map((l) => [l.qty, l.eur]), [[1.33, 66.96], [0.34, 70]]);
});

test('onaylı yükleme: kalemler satırın sırasını (pieceBase) taşır; yüklenen m², satış ve maliyet ayrılmamış satırla aynı', () => {
  const order = { id: 'o1', customerId: 'c1' };
  const offer = { currency: 'EUR', offerAmount: 1 };
  const before = [glass()];
  const after = splitWithHole(before, 0, hole({ free: true, unitPrice: '0', offerPrice: '0' }));
  const snap = (lines) => lines.map((l, i) => ({ ...snapshotLine(order, offer, { ...l, sortOrder: i }), id: `i${i}` }));
  const a = snap(after), b = snap(before);
  assert.deepEqual(a.map((i) => [i.kind, i.quantity, i.pieceBase, i.m2]), [['CAM', 4, 0, 1.33], ['CAM', 1, 4, 0.34], ['DELIK', 2, 0, 0]]);
  assert.equal(Math.round((a[0].m2 + a[1].m2) * 100) / 100, b[0].m2);
  // Kârlılık / fatura kuralı (glassTotals) kalemlerden: aynı m², satış ve maliyet
  const ta = lineTotals(a.map(itemAsLine)), tb = lineTotals(b.map(itemAsLine));
  assert.deepEqual([ta.adet, ta.m2, ta.sale, ta.cost], [tb.adet, tb.m2, tb.sale, tb.cost]);
  assert.deepEqual([tb.adet, tb.m2], [5, 1.67]);
  assert.deepEqual(invoiceLines({ lines: a.map(itemAsLine) }, 5.0912, 21), invoiceLines({ lines: b.map(itemAsLine) }, 5.0912, 21));
  // Kalem tutarları (yuvarlanmamış saklanır) da kalemin toplamını verir
  const sum = (items, k) => Math.round(items.reduce((s, i) => s + i[k], 0) * 100) / 100;
  assert.deepEqual([sum(a, 'saleAmount'), sum(a, 'costAmount')], [sum(b, 'saleAmount'), sum(b, 'costAmount')]);
});
