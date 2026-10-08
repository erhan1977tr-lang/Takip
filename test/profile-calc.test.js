// Paket 5 (karar 175–177): profil hesaplayıcısı (saf kural), stok kuralları (kritik eşik, rezerve, müşteri görünümü),
// yetki ve yapı. Veritabanıyla uçtan uca: test/db/profile-calc.test.js; tarayıcıda: e2e/39-profil-hesaplayici.spec.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_CALC_METERS, PROFILE_COLORS, applyCalc, calculate, cleanSlot, fromScaled, matches, needText, overlaps, parseMeters, parsePack,
  parsePerMeter, parseThickness, slotKey, slotsOf, systemNeeds, systemProblems, toScaled,
} from '../server/profile/calculator.js';
import {
  STOCK_CRITICAL_ALERT, addStockMovement, applyStockImport, crossesCritical, customerShortageView, customerStockLine, parseThreshold,
  setCriticalStock, stockLockKeys, stockRowStatus,
} from '../server/profile/stock.js';
import { addCalcItem, addThickness, removeCalcItem, saveSystem, setThicknessActive, updateCalcItem } from '../server/profile/calc-service.js';
import { createProfileCalcLimits, PROFILE_CALC_LIMITS } from '../server/profile/limits.js';
import { MAX_PROFILE_QTY } from '../server/profile/rules.js';
import { PROFILE_LOCKS } from '../server/profile/transitions.js';
import { PACK_CONTENTS } from '../prisma/seed/data/profile-calc.js';
import { PROFILE_PRODUCTS } from '../prisma/seed/data/profile-catalog.js';
import { ALERT_TYPES } from '../server/pricing/alerts.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------- örnek katalog ve sistemler (değerler yalnızca test içindir) ----------
const product = (id, code, content, measure, extra = {}) => ({
  id, code, nameTr: `${code} tr`, nameRo: `${code} ro`, unitCode: measure === 'BUC' ? 'PUNGI' : code.startsWith('MR') || code.startsWith('RM') ? 'BARA' : 'CUTII',
  isActive: true, packContent: content, packMeasure: measure, category: { isActive: true }, ...extra,
});
const P = {
  mr7016: product('p-mr7016', 'MR23-7016', '6', 'M'),
  mrElx: product('p-mrelx', 'MR23-ELX', '6', 'M'),
  mc12: product('p-mc12', 'MC12', '27', 'M'),
  mc16: product('p-mc16', 'MC16', '43', 'M'),
  gk15: product('p-gk15', 'GK15', '137', 'M'),
  pana: product('p-pana', 'PANA-L90', '100', 'BUC'),
  rm7016: product('p-rm7016', 'RM29-7016', '6', 'M'),
  rmElx: product('p-rmelx', 'RM29-ELX', '6', 'M'),
};
const T12 = { id: 't12', mm: '12.76', isActive: true };
const T16 = { id: 't16', mm: '16.76', isActive: true };
const T10 = { id: 't10', mm: '10.76', isActive: true };
let seq = 0;
const item = (slot, p, { color = null, thicknessId = null, perMeter = '1' } = {}) => ({
  id: `i${++seq}`, slot, sortOrder: seq * 10, productId: p?.id ?? null, product: p ?? null, color, thicknessId, perMeter,
});
const mr23 = () => ({
  id: 'sys-mr23', code: 'MR23', isActive: true,
  items: [
    item('Profil', P.mr7016, { color: 'RAL7016' }),
    item('Profil', P.mrElx, { color: 'ELOXAT' }),
    item('El tutamağı contası', P.mc12, { thicknessId: 't12' }),
    item('El tutamağı contası', P.mc16, { thicknessId: 't16' }),
  ],
});
const rm29 = () => ({
  id: 'sys-rm29', code: 'RM29', isActive: true,
  items: [item('Profil', P.rm7016, { color: 'RAL7016' }), item('Profil', P.rmElx, { color: 'ELOXAT' })],
});
const qtys = (r) => (r.ok ? Object.fromEntries(r.lines.map((l) => [l.code, l.qty])) : r.errors.map((e) => e.code));

test('hesaplayıcı: metre girişi — yalnızca 0’dan büyük, en çok 2 ondalık, en çok 10.000 m; eksi / boş / sayı olmayan reddedilir', () => {
  assert.deepEqual(parseMeters('24'), { ok: true, cm: 2400 });
  assert.deepEqual(parseMeters(' 24,5 '), { ok: true, cm: 2450 });
  assert.deepEqual(parseMeters('24.05'), { ok: true, cm: 2405 });
  assert.deepEqual(parseMeters('0024'), { ok: true, cm: 2400 });
  assert.deepEqual(parseMeters(String(MAX_CALC_METERS)), { ok: true, cm: MAX_CALC_METERS * 100 });
  for (const [raw, code] of [
    ['', 'METERS_EMPTY'], [null, 'METERS_EMPTY'], ['   ', 'METERS_EMPTY'],
    ['-5', 'METERS_BAD'], ['abc', 'METERS_BAD'], ['1e3', 'METERS_BAD'], ['12,345', 'METERS_BAD'], ['Infinity', 'METERS_BAD'], ['NaN', 'METERS_BAD'],
    ['12,5,1', 'METERS_BAD'], ['1.000,5', 'METERS_BAD'], ['0x10', 'METERS_BAD'], ['+5', 'METERS_BAD'],
    ['0', 'METERS_ZERO'], ['0,00', 'METERS_ZERO'], ['000', 'METERS_ZERO'],
    ['10000,01', 'METERS_TOO_LARGE'], ['123456', 'METERS_TOO_LARGE'], ['9'.repeat(400), 'METERS_TOO_LARGE'],
  ]) assert.equal(parseMeters(raw).code, code, String(raw).slice(0, 20));
});

test('hesaplayıcı: ondalık sayılar tam sayı olarak (kayan nokta yok); fazla anlamlı ondalık yuvarlanmaz, reddedilir', () => {
  assert.equal(toScaled('0.1', 4) + toScaled('0.2', 4), toScaled('0.3', 4));
  assert.equal(toScaled('137', 3), 137000n);
  assert.equal(toScaled('12,5', 3), 12500n);
  assert.equal(toScaled('1.2340', 3), 1234n, 'sondaki sıfır sorun değil');
  assert.equal(toScaled('1.2345', 3), null, 'ölçekten fazla anlamlı ondalık');
  for (const bad of ['-1', '1e3', 'abc', '', ' ', NaN, Infinity, '1,2,3']) assert.equal(toScaled(bad, 3), null, String(bad));
  assert.equal(toScaled(12.5, 3), 12500n);
  assert.equal(fromScaled(137000n, 3), '137');
  assert.equal(fromScaled(12500n, 3), '12.5');
  assert.equal(fromScaled(1n, 4), '0.0001');
});

test('hesaplayıcı: yöneticinin değerleri — paket içeriği (adet ölçüsünde tam sayı), tüketim, cam kalınlığı, kalem adı', () => {
  assert.deepEqual(parsePack({ content: '', measure: '' }), { ok: true, value: { packContent: null, packMeasure: null } });
  assert.deepEqual(parsePack({ content: '137', measure: 'M' }), { ok: true, value: { packContent: '137', packMeasure: 'M' } });
  assert.deepEqual(parsePack({ content: '5,75', measure: 'm' }), { ok: true, value: { packContent: '5.75', packMeasure: 'M' } });
  assert.deepEqual(parsePack({ content: '100', measure: 'BUC' }), { ok: true, value: { packContent: '100', packMeasure: 'BUC' } });
  assert.equal(parsePack({ content: '2,5', measure: 'BUC' }).code, 'PACK_INT');
  assert.equal(parsePack({ content: '137', measure: '' }).code, 'PACK_MEASURE');
  assert.equal(parsePack({ content: '137', measure: 'KG' }).code, 'PACK_MEASURE');
  for (const c of ['0', '-1', 'abc', '100000.001', '100001', '1,2345']) assert.equal(parsePack({ content: c, measure: 'M' }).code, 'PACK', c);
  assert.deepEqual(parsePerMeter(''), { ok: true, value: null });
  assert.deepEqual(parsePerMeter('2,5'), { ok: true, value: '2.5' });
  assert.deepEqual(parsePerMeter('0.0001'), { ok: true, value: '0.0001' });
  for (const c of ['0', '-1', '1000.0001', '0.00001', 'x']) assert.deepEqual(parsePerMeter(c), { ok: false }, c);
  assert.deepEqual(parseThickness('12,76'), { ok: true, value: '12.76' });
  for (const c of ['0', '0.5', '200.01', '12.765', '', 'x']) assert.deepEqual(parseThickness(c), { ok: false }, c);
  assert.equal(cleanSlot('  El   tutamağı contası '), 'El tutamağı contası');
  assert.equal(cleanSlot(''), null);
  assert.equal(cleanSlot('x'.repeat(61)), null);
  assert.equal(slotKey('profil'), slotKey('PROFİL'), 'Türkçe büyük harf eşleşir');
});

test('hesaplayıcı: MR23 — renk profili seçer (RAL 7016 / eloksal), cam kalınlığı MC12 ya da MC16’yı seçer; adet yukarı yuvarlanır', () => {
  const ths = [T12, T16];
  // 30 m: profil 30 / 6 = 5 boy; MC12 30 / 27 → 2 kutu; MC16 30 / 43 → 1 kutu
  assert.deepEqual(qtys(calculate(mr23(), { color: 'RAL7016', thicknessId: 't12', meters: '30' }, ths)), { 'MR23-7016': 5, MC12: 2 });
  assert.deepEqual(qtys(calculate(mr23(), { color: 'RAL7016', thicknessId: 't16', meters: '30' }, ths)), { 'MR23-7016': 5, MC16: 1 });
  assert.deepEqual(qtys(calculate(mr23(), { color: 'ELOXAT', thicknessId: 't16', meters: '30' }, ths)), { 'MR23-ELX': 5, MC16: 1 });
  // Tam katı: 27 m → 1 kutu MC12; 27,01 m → 2 kutu; 30,01 m → 6 boy
  assert.deepEqual(qtys(calculate(mr23(), { color: 'RAL7016', thicknessId: 't12', meters: '27' }, ths)), { 'MR23-7016': 5, MC12: 1 });
  assert.deepEqual(qtys(calculate(mr23(), { color: 'RAL7016', thicknessId: 't12', meters: '27,01' }, ths)), { 'MR23-7016': 5, MC12: 2 });
  assert.deepEqual(qtys(calculate(mr23(), { color: 'RAL7016', thicknessId: 't12', meters: '30,01' }, ths)), { 'MR23-7016': 6, MC12: 2 });
  const r = calculate(mr23(), { color: 'RAL7016', thicknessId: 't12', meters: '30' }, ths);
  assert.ok(r.ok);
  assert.deepEqual(r.lines.map((l) => [l.code, l.need, l.content, l.measure, l.slots]), [
    ['MR23-7016', '30', '6', 'M', ['Profil']], ['MC12', '30', '27', 'M', ['El tutamağı contası']],
  ]);
  assert.equal(r.meters, '30');
  assert.deepEqual(systemNeeds(mr23().items), { color: true, thickness: true });
});

test('hesaplayıcı: RM29 MR23’ün MC kuralını kullanmaz — kalınlık gerekmez, MC12 / MC16 hiç hesaplanmaz', () => {
  const ths = [T12, T16];
  assert.deepEqual(systemNeeds(rm29().items), { color: true, thickness: false });
  for (const thicknessId of ['t12', 't16', '', 'yok']) {
    const r = calculate(rm29(), { color: 'ELOXAT', thicknessId, meters: '30' }, ths);
    assert.deepEqual(qtys(r), { 'RM29-ELX': 5 }, thicknessId);
  }
  // Sistemler birbirinden bağımsız: MR23'ün satırları RM29'u etkilemez
  assert.deepEqual(systemProblems(rm29(), ths), []);
});

test('hesaplayıcı: renk ve cam kalınlığı yalnızca gerektiğinde zorunlu; pasif / bilinmeyen kalınlık seçilemez', () => {
  assert.deepEqual(qtys(calculate(mr23(), { color: '', thicknessId: 't12', meters: '10' }, [T12])), ['COLOR_REQUIRED']);
  assert.deepEqual(qtys(calculate(mr23(), { color: 'RED', thicknessId: 't12', meters: '10' }, [T12])), ['COLOR_REQUIRED']);
  assert.deepEqual(qtys(calculate(mr23(), { color: 'RAL7016', thicknessId: '', meters: '10' }, [T12])), ['THICKNESS_REQUIRED']);
  assert.deepEqual(qtys(calculate(mr23(), { color: 'RAL7016', thicknessId: 't12', meters: '10' }, [{ ...T12, isActive: false }])), ['THICKNESS_REQUIRED']);
  assert.deepEqual(qtys(calculate(mr23(), { color: 'RAL7016', thicknessId: 'yok', meters: '10' }, [T12])), ['THICKNESS_REQUIRED']);
  assert.deepEqual(qtys(calculate(null, { meters: '10' }, [])), ['SYSTEM_INACTIVE']);
  assert.deepEqual(qtys(calculate({ ...mr23(), isActive: false }, { color: 'RAL7016', thicknessId: 't12', meters: '10' }, [T12])), ['SYSTEM_INACTIVE']);
  assert.deepEqual(qtys(calculate({ id: 's', isActive: true, items: [] }, { meters: '10' }, [])), ['SYSTEM_EMPTY']);
  assert.deepEqual(qtys(calculate(mr23(), { color: 'RAL7016', thicknessId: 't12', meters: '-3' }, [T12])), ['METERS_BAD']);
});

test('hesaplayıcı: eksik teknik değer tahmin edilmez — HİÇBİR miktar üretilmez, eksik değer ve yeri söylenir', () => {
  const ths = [T12, T16, T10];
  // Kalınlık 10,76 için conta satırı yok → hesap yok (MC sessizce atlanmaz)
  const noOption = calculate(mr23(), { color: 'RAL7016', thicknessId: 't10', meters: '30' }, ths);
  assert.equal(noOption.ok, false);
  assert.deepEqual(noOption.errors, [{ code: 'NO_OPTION', slot: 'El tutamağı contası', color: 'RAL7016', thicknessMm: '10.76' }]);
  // Tüketim katsayısı girilmemiş → yalnızca hata (öbür kalemlerin miktarı da dönmez)
  const sys = mr23();
  sys.items[2].perMeter = null;
  const noPer = calculate(sys, { color: 'RAL7016', thicknessId: 't12', meters: '30' }, ths);
  assert.equal(noPer.ok, false);
  assert.equal('lines' in noPer, false);
  assert.deepEqual(noPer.errors, [{ code: 'NO_PER_METER', slot: 'El tutamağı contası', product: 'MC12' }]);
  // Paket içeriği girilmemiş (ör. bar boyu) → NO_PACK, ürün adıyla; aynı ürün iki kalemde olsa da tek hata
  const s2 = mr23();
  s2.items[0].product = { ...P.mr7016, packContent: null, packMeasure: null };
  s2.items.push(item('Kapak profili', s2.items[0].product, { color: 'RAL7016' }));
  const noPack = calculate(s2, { color: 'RAL7016', thicknessId: 't12', meters: '30' }, ths);
  assert.deepEqual(noPack.errors, [{ code: 'NO_PACK', product: 'MR23-7016' }]);
  // Pasif ürün
  const s3 = mr23();
  s3.items[3].product = { ...P.mc16, isActive: false };
  assert.deepEqual(calculate(s3, { color: 'RAL7016', thicknessId: 't16', meters: '30' }, ths).errors, [{ code: 'PRODUCT_INACTIVE', slot: 'El tutamağı contası', product: 'MC16' }]);
  const s4 = mr23();
  s4.items[3].product = { ...P.mc16, category: { isActive: false } };
  assert.equal(calculate(s4, { color: 'RAL7016', thicknessId: 't16', meters: '30' }, ths).errors[0].code, 'PRODUCT_INACTIVE');
  // Aynı seçime uyan iki satır (veri elle bozulmuşsa) → AMBIGUOUS
  const s5 = mr23();
  s5.items.push(item('El tutamağı contası', P.mc16, { thicknessId: null }));
  assert.equal(calculate(s5, { color: 'RAL7016', thicknessId: 't16', meters: '30' }, ths).errors[0].code, 'AMBIGUOUS');
  // Çok büyük sonuç (10.000 m × 1.000 adet / 10 adetlik poşet = 1.000.000 poşet > üst sınır); sınırın kendisi geçerli
  const small = product('p-pana10', 'PANA-10', '10', 'BUC');
  const big = calculate({ id: 's6', isActive: true, items: [item('Kama', small, { perMeter: '1000' })] }, { meters: '10000' }, ths);
  assert.deepEqual(big.errors, [{ code: 'TOO_MANY', product: 'PANA-10', max: MAX_PROFILE_QTY }]);
  const edge = calculate({ id: 's7', isActive: true, items: [item('Kama', P.pana, { perMeter: '1000' })] }, { meters: '10000' }, ths);
  assert.deepEqual(qtys(edge), { 'PANA-L90': MAX_PROFILE_QTY });
});

test('hesaplayıcı: "bu koşulda gerekmez" satırı; aynı ürün birden çok kalemde → ihtiyaç toplanır, BİR kez yuvarlanır; adet ölçüsü', () => {
  const ths = [T12, T16];
  const s = {
    id: 's', isActive: true,
    items: [
      item('Kama', P.pana, { thicknessId: 't12', perMeter: '4' }),
      item('Kama', null, { thicknessId: 't16' }),
      item('Conta iç', P.gk15, { perMeter: '1' }),
      item('Conta dış', P.gk15, { perMeter: '1' }),
    ],
  };
  // 12,76: 50 m × 4 = 200 adet → 2 poşet; GK15 50 + 50 = 100 m → 1 kutu (ayrı yuvarlansa 2 olurdu)
  assert.deepEqual(qtys(calculate(s, { thicknessId: 't12', meters: '50' }, ths)), { 'PANA-L90': 2, GK15: 1 });
  // 16,76: kama gerekmez (hata değil)
  assert.deepEqual(qtys(calculate(s, { thicknessId: 't16', meters: '50' }, ths)), { GK15: 1 });
  const r = calculate(s, { thicknessId: 't12', meters: '50,25' }, ths);
  assert.ok(r.ok);
  assert.deepEqual(r.lines.find((l) => l.code === 'GK15')?.slots, ['Conta iç', 'Conta dış']);
  assert.equal(r.lines.find((l) => l.code === 'PANA-L90')?.need, '201', 'adet ihtiyacı tam sayıya yukarı');
  assert.equal(needText(30_750_000n, 'BUC'), '31');
  assert.equal(needText(13_024_870n, 'M'), '13.03');
  assert.equal(needText(13_000_000n, 'M'), '13');
  // Yalnızca "gerekmez" satırları → hesaplanacak ürün yok
  assert.deepEqual(qtys(calculate({ id: 'x', isActive: true, items: [item('Kama', null)] }, { meters: '5' }, ths)), ['NO_PRODUCTS']);
});

test('hesaplayıcı: sonuç en küçük yeterli adettir (rastgele değerlerle, kesirli tam sayı kanıtı)', () => {
  let s = 20261008;
  const rnd = (n) => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
  for (let i = 0; i < 400; i++) {
    const cm = 1 + rnd(MAX_CALC_METERS * 100);
    const per = 1 + rnd(50_000); // 0,0001 … 5 (ölçek 10⁻⁴)
    const content = 1 + rnd(200_000); // 0,001 … 200 (ölçek 10⁻³)
    const meters = fromScaled(BigInt(cm), 2);
    const sys = { id: 'r', isActive: true, items: [item('X', product('px', 'PX', fromScaled(BigInt(content), 3), 'M'), { perMeter: fromScaled(BigInt(per), 4) })] };
    const r = calculate(sys, { meters }, []);
    const need = BigInt(cm) * BigInt(per); // 10⁻⁶
    const c6 = BigInt(content) * 1000n;
    const expect = (need + c6 - 1n) / c6;
    if (expect > BigInt(MAX_PROFILE_QTY)) { assert.equal(r.ok, false); continue; }
    assert.ok(r.ok, `${meters} × ${per} / ${content}`);
    const q = BigInt(r.lines[0].qty);
    assert.ok(q * c6 >= need && (q - 1n) * c6 < need, `${meters} m × ${fromScaled(BigInt(per), 4)} ÷ ${fromScaled(BigInt(content), 3)} → ${q}`);
  }
});

test('hesaplayıcı: koşul çakışması ve yöneticinin "eksikler" listesi (her renk × etkin kalınlık)', () => {
  assert.equal(overlaps({ color: null, thicknessId: null }, { color: 'RAL7016', thicknessId: 't12' }), true);
  assert.equal(overlaps({ color: 'RAL7016', thicknessId: null }, { color: 'ELOXAT', thicknessId: null }), false);
  assert.equal(overlaps({ color: null, thicknessId: 't12' }, { color: null, thicknessId: 't16' }), false);
  assert.equal(overlaps({ color: 'RAL7016', thicknessId: 't12' }, { color: null, thicknessId: 't12' }), true);
  assert.equal(matches({ color: null, thicknessId: 't12' }, 'ELOXAT', 't12'), true);
  assert.equal(matches({ color: 'RAL7016', thicknessId: null }, 'ELOXAT', 't12'), false);
  assert.deepEqual(systemProblems(mr23(), [T12, T16]), []);
  // Yeni kalınlık eklenince MR23'te o kalınlığın contası eksik (iki renkte)
  assert.deepEqual(systemProblems(mr23(), [T12, T16, T10]).map((e) => [e.code, e.color, e.thicknessMm]), [
    ['NO_OPTION', 'RAL7016', '10.76'], ['NO_OPTION', 'ELOXAT', '10.76'],
  ]);
  // Pasif kalınlık sayılmaz
  assert.deepEqual(systemProblems(mr23(), [T12, T16, { ...T10, isActive: false }]), []);
  assert.deepEqual(systemProblems({ items: [] }, []), [{ code: 'SYSTEM_EMPTY' }]);
  assert.deepEqual(systemProblems(mr23(), []).map((e) => e.code), ['NO_THICKNESS']);
  const s = mr23();
  s.items[3].perMeter = null;
  assert.deepEqual(systemProblems(s, [T12, T16]), [{ code: 'NO_PER_METER', slot: 'El tutamağı contası', product: 'MC16' }]);
  assert.deepEqual(slotsOf(mr23().items).map((x) => [x.label, x.items.length]), [['Profil', 2], ['El tutamağı contası', 2]]);
  assert.deepEqual(PROFILE_COLORS, ['RAL7016', 'ELOXAT']);
});

test('hesaplayıcı: forma aktarım — yalnızca sonuçtaki ürünler değişir, elle girilmiş farklı adetler ÖNCE listelenir', () => {
  const current = { a: '5', b: '', c: '0', d: '7', other: '3' };
  const lines = [{ productId: 'a', qty: 5 }, { productId: 'b', qty: 2 }, { productId: 'c', qty: 4 }, { productId: 'd', qty: 1 }, { productId: 'e', qty: 9 }];
  const { next, overwrites } = applyCalc(current, lines);
  assert.deepEqual(next, { a: '5', b: '2', c: '4', d: '1', e: '9', other: '3' }, 'sonuçta olmayan ürüne dokunulmaz');
  assert.deepEqual(overwrites, [{ productId: 'd', from: '7', to: '1' }], 'aynı adet, boş ve 0 üzerine yazma sayılmaz');
  assert.deepEqual(current, { a: '5', b: '', c: '0', d: '7', other: '3' }, 'girdi değişmez');
  assert.deepEqual(applyCalc({}, [{ productId: 'x', qty: 3 }]), { next: { x: '3' }, overwrites: [] });
});

test('stok: kritik eşik kuralı — yeni kritik dönemde tek uyarı; zaten kritikken süren düşüş yeni uyarı açmaz', () => {
  assert.equal(crossesCritical({ threshold: 5, before: 8, after: 5 }), true, 'eşiğe eşit = kritik');
  assert.equal(crossesCritical({ threshold: 5, before: 8, after: 3 }), true);
  assert.equal(crossesCritical({ threshold: 5, before: 4, after: 2 }), false, 'zaten kritikti');
  assert.equal(crossesCritical({ threshold: 5, before: 8, after: 6 }), false);
  assert.equal(crossesCritical({ threshold: null, before: 8, after: -10 }), false, 'eşik yok');
  assert.equal(crossesCritical({ threshold: 0, before: 1, after: 0 }), true, '0 eşiği = stok bitti');
  assert.deepEqual(parseThreshold(''), { ok: true, value: null });
  assert.deepEqual(parseThreshold('25'), { ok: true, value: 25 });
  for (const bad of ['-1', '2.5', 'x', '10000000', '1e3']) assert.deepEqual(parseThreshold(bad), { ok: false }, bad);
  assert.deepEqual(stockRowStatus({ stock: 3, reserved: 10, threshold: 5 }), { critical: true, negative: false, shortForOrders: 7 });
  assert.deepEqual(stockRowStatus({ stock: -2, reserved: 0, threshold: null }), { critical: false, negative: true, shortForOrders: 2 });
  assert.deepEqual(stockRowStatus({ stock: 9, reserved: 4, threshold: 5 }), { critical: false, negative: false, shortForOrders: 0 });
  assert.equal(STOCK_CRITICAL_ALERT, 'STOCK_CRITICAL');
  assert.ok(ALERT_TYPES.includes('STOCK_CRITICAL') && ALERT_TYPES.includes('STOCK_SHORTAGE'));
});

test('stok: müşteriye giden değerler — yalnızca gereken / mevcut / eksik; mevcut eksiye düşmez (iç bakiye gitmez)', () => {
  assert.deepEqual(customerStockLine(10, 4), { needed: 10, available: 4, missing: 6 });
  assert.deepEqual(customerStockLine(10, -7), { needed: 10, available: 0, missing: 10 });
  assert.deepEqual(customerStockLine(3, 9), { needed: 3, available: 9, missing: 0 });
  const view = customerShortageView([{ productId: 'p1', code: 'GK15', nameTr: 'Conta', nameRo: 'Garnitură', unitCode: 'CUTII', qty: 5, stock: -3, missing: 8 }]);
  assert.deepEqual(view, [{ code: 'GK15', nameTr: 'Conta', nameRo: 'Garnitură', unitCode: 'CUTII', needed: 5, available: 0, missing: 5 }]);
  assert.equal('productId' in view[0], false, 'iç kimlik müşteriye gitmez');
});

test('stok: kilit anahtarları tekrarsız ve SIRALI (her yazan aynı sırayla kilitler — kilitlenme yok); depo çıkışı ve iptal kilitli', () => {
  assert.deepEqual(stockLockKeys(['b', 'a', null, 'b', undefined, 'c']), ['stock:a', 'stock:b', 'stock:c']);
  assert.deepEqual(Object.keys(PROFILE_LOCKS).sort(), ['cancel', 'mark_paid', 'send_to_warehouse']);
  const order = { profileItems: [{ productId: 'z' }, { productId: null }, { productId: 'a' }] };
  for (const fn of Object.values(PROFILE_LOCKS)) assert.deepEqual(fn(order), ['stock:a', 'stock:z']);
});

test('yetki: stok ve hesaplayıcı servisleri yetkiyi kendileri de denetler — yetkisiz rol veritabanına hiç dokunmaz', async () => {
  const untouchable = new Proxy({}, { get: (_, k) => { throw new Error(`veritabanına dokunuldu: ${String(k)}`); } });
  for (const role of ['DENETIMCI', 'SATIS', 'CIZIM', 'MUSTERI', undefined]) {
    const actor = { id: 'u1', role, ip: null };
    assert.deepEqual(await addStockMovement(untouchable, { productId: 'p', kind: 'GIRIS', qty: 5 }, actor), { ok: false, code: 'FORBIDDEN' }, role);
    assert.deepEqual(await applyStockImport(untouchable, [{ code: 'GK15', qty: 1 }], 'SAYIM', actor), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await setCriticalStock(untouchable, { productId: 'p', threshold: '3' }, actor), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await addThickness(untouchable, { mm: '12.76' }, actor), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await setThicknessActive(untouchable, { id: 't', active: false }, actor), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await saveSystem(untouchable, { code: 'X', nameRo: 'X' }, actor), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await addCalcItem(untouchable, { systemId: 's', slot: 'A' }, actor), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await updateCalcItem(untouchable, { id: 'i', perMeter: '1' }, actor), { ok: false, code: 'FORBIDDEN' });
    assert.deepEqual(await removeCalcItem(untouchable, { id: 'i' }, actor), { ok: false, code: 'FORBIDDEN' });
  }
});

test('hız sınırı: hesaplayıcı ve gönderim öncesi stok uyarısı kullanıcı başına sınırlı (stok yoklaması yavaşlar)', () => {
  const l = createProfileCalcLimits({ calc: { limit: 3, windowMs: 1000 }, stockCheck: { limit: 2, windowMs: 1000 } });
  assert.deepEqual([1, 2, 3, 4].map(() => l.calc('u1', 0)), [true, true, true, false]);
  assert.equal(l.calc('u2', 0), true, 'başka kullanıcının hakkı ayrı');
  assert.equal(l.calc('u1', 1001), true, 'pencere geçince yeniden');
  assert.deepEqual([1, 2, 3].map(() => l.stockCheck('u1', 0)), [true, true, false]);
  assert.ok(PROFILE_CALC_LIMITS.calc.limit >= 30 && PROFILE_CALC_LIMITS.stockCheck.limit >= 10);
});

test('seed: yalnızca ürün sahibinin kesin paket içerikleri (GK15 137, AD45 24, MC12 27, MC16 43 m / kutu); katsayı, sistem, RM29 yok', () => {
  assert.deepEqual(PACK_CONTENTS.map((p) => [p.code, p.content, p.measure]), [['GK15', '137', 'M'], ['AD45', '24', 'M'], ['MC12', '27', 'M'], ['MC16', '43', 'M']]);
  for (const p of PACK_CONTENTS) assert.ok(PROFILE_PRODUCTS.some((x) => x.code === p.code), p.code);
  assert.equal(PROFILE_PRODUCTS.some((x) => x.code.startsWith('RM29')), false, 'RM29 kendiliğinden eklenmez');
  const step = read('prisma/seed/steps/profile-calc.mjs');
  assert.doesNotMatch(step, /profileSystem\.(create|upsert)|profileCalcItem|profileGlassThickness|perMeter/, 'seed sistem / satır / kalınlık / katsayı yazmaz');
  assert.match(step, /packContent: null, packMeasure: null/, 'yalnızca boş içeriğe yazar');
  assert.match(step, /PACK_SEED_ACTION/);
  assert.match(read('prisma/seed/base.mjs'), /profileCatalogStep, profileCalcStep\]/, 'katalogdan sonra çalışır');
});

test('yapı: stoğa yazan her yol ürün kilidini alır; stok sayfası denetimciye salt okunur; müşteri işlemi genel stok okumaz', () => {
  const stock = read('server/profile/stock.js');
  // stockMovement.create / createMany yazan her işlev, yazmadan önce lockStock çağırır
  const fns = stock.split(/\nexport (?:async )?function /).slice(1);
  const writers = fns.filter((f) => /stockMovement\.(create|createMany)\(/.test(f));
  assert.deepEqual(writers.map((f) => f.slice(0, f.indexOf('('))).sort(), ['addStockMovement', 'applyStockImport', 'deductOrderStock', 'returnOrderStock']);
  for (const f of writers) assert.ok(f.indexOf('lockStock(') > 0 && f.indexOf('lockStock(') < f.search(/stockMovement\.(create|createMany)\(/), f.slice(0, 40));
  // Uygulamada stok hareketi yalnızca stock.js'te yazılır
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(p) : /\.(js|mjs|ts|tsx)$/.test(e.name) ? [p] : [];
  });
  const writersOutside = ['app', 'lib', 'server', 'components', 'scripts'].flatMap(walk)
    .filter((f) => f !== 'server/profile/stock.js' && /stockMovement\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(/.test(read(f)));
  assert.deepEqual(writersOutside, []);
  // Stok sayfası: görüntüleme STOCK_VIEW, formlar yalnızca STOCK_MANAGE ile; işlemler STOCK_MANAGE
  const page = read('app/(panel)/admin/stok/page.tsx');
  assert.match(page, /requirePermission\('STOCK_VIEW'\)/);
  assert.match(page, /const manage = userCan\(user, 'STOCK_MANAGE'\)/);
  const forms = [...page.matchAll(/<form /g)].map((m) => m.index);
  assert.equal(forms.length, 3);
  const gridStart = page.indexOf('{manage && (\n        <div className="grid-2">');
  const gridEnd = page.indexOf('\n      )}\n', gridStart);
  assert.ok(gridStart > 0 && gridEnd > gridStart);
  assert.equal(forms.filter((i) => i > gridStart && i < gridEnd).length, 2, 'giriş / sayım ve Excel formu yalnızca yöneticide');
  const thr = page.indexOf('<form action={stockThresholdAction}');
  assert.match(page.slice(thr - 80, thr), /\{manage \? \(\s*$/, 'eşik formu yalnızca yöneticide');
  const actions = read('app/(panel)/admin/stok/actions.ts');
  assert.equal((actions.match(/export async function/g) ?? []).length, (actions.match(/requirePermission\('STOCK_MANAGE'\)/g) ?? []).length);
  assert.match(read('app/(panel)/admin/stok/excel/route.ts'), /userCan\(user, 'STOCK_MANAGE'\)/, 'Excel yalnızca yönetici');
  // Müşterinin işlemleri: stok değeri yalnızca customerShortages / runCalc üzerinden (genel stokLevels / reservedLevels yok)
  const cust = read('app/(panel)/siparisler/yeni/profile-calc-actions.ts');
  assert.doesNotMatch(cust, /stockLevels|reservedLevels|profileProduct\.findMany/);
  assert.equal((cust.match(/requirePermission\('ORDER_CREATE'\)/g) ?? []).length, 2);
  // Hesaplayıcı ayarları yalnızca CATALOG_MANAGE
  const calcActions = read('app/(panel)/admin/profil-katalogu/hesaplama/actions.ts');
  assert.equal((calcActions.match(/export async function/g) ?? []).length, (calcActions.match(/requirePermission\('CATALOG_MANAGE'\)/g) ?? []).length);
  assert.match(read('app/(panel)/admin/profil-katalogu/hesaplama/page.tsx'), /requirePermission\('CATALOG_MANAGE'\)/);
});
