// Korkuluk hesaplayıcısı (karar 203–204): kesin teknik kurallar, varsayılan yapılandırma ve müşteri arayüzünün yapısı.
// Hesap Paket 5'in tek kuralıyla (calculate) yapılır; burada varsayılan yapılandırma o kurala verilip ürün sahibinin
// formülleriyle (bağımsız olarak hesaplanan beklenen değerler) karşılaştırılır. Veritabanı tarafı: test/db/railing-calc.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateRailing, calculate } from '../server/profile/calculator.js';
import { RAILING_CODES, RAILING_PACKS, RAILING_SYSTEMS, RAILING_THICKNESSES } from '../server/profile/railing-defaults.js';
import { railingCatalogProblems } from '../server/profile/calc-defaults.js';
import { PROFILE_PRODUCTS } from '../prisma/seed/data/profile-catalog.js';
import { translate } from '../server/i18n/index.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const pack = new Map(RAILING_PACKS.map((p) => [p.code, p]));
const ths = RAILING_THICKNESSES.map((t) => ({ id: t.key, mm: t.mm, isActive: true }));
/** Varsayılan sistemin calculate'e giden biçimi (ürünler varsayılan paket içerikleriyle) */
function sys(code, over = {}) {
  const s = RAILING_SYSTEMS.find((x) => x.code === code);
  return {
    code, kind: s.kind, isActive: true,
    items: s.items.map((i, n) => {
      const p = pack.get(i.product);
      return {
        id: `${code}-${n}`, slot: i.slot, sortOrder: (n + 1) * 10, productId: i.product, color: i.color, thicknessId: i.thickness, perMeter: i.perMeter,
        product: { id: i.product, code: i.product, nameTr: i.product, nameRo: i.product, unitCode: p.unit, isActive: true, packContent: p.content, packMeasure: p.measure, ...(over[i.product] ?? {}) },
      };
    }),
  };
}
const run = (profile, handrail, glass, color, meters) => calculateRailing(
  { profile: profile ? sys(profile) : null, handrail: handrail ? sys(handrail) : null, handrailWanted: !!handrail }, { color, thicknessId: glass, meters }, ths,
);
const qtys = (r) => (r.ok ? Object.fromEntries(r.lines.map((l) => [l.code, l.qty])) : r.errors);

/** Ürün sahibinin formülleri — bağımsız hesap (metre santimetre olarak, tam sayı) */
function expected(profile, handrail, glass, color, cm) {
  const bars = Math.ceil(cm / 600);
  const sfx = color === 'RAL7016' ? '7016' : 'ELX';
  const g = glass === 'G12' ? '12' : '16';
  const n = profile === 'FBL90' ? '90' : '115';
  const out = { [`${profile}-${sfx}`]: bars, [`PANA-L${n}`]: bars, [`PANA-${n}-${g}`]: bars };
  if (handrail === 'MR23') {
    out[`MR23-${sfx}`] = bars;
    out[g === '12' ? 'MC12' : 'MC16'] = Math.ceil(cm / (g === '12' ? 2700 : 4300));
  }
  if (handrail === 'RM29') out[`RM${g}-${sfx}`] = bars;
  return out;
}

test('örnek hesaplamalar (ürün sahibinin örnekleri)', () => {
  // A — 20 m, FBL90, MR23, 8+8, 7016: FBL90 4 boy, L90/90-16 (PANA-L90 + PANA-90-16) 4 poşet, MR23 4 boy, MC16 1 kutu
  assert.deepEqual(qtys(run('FBL90', 'MR23', 'G16', 'RAL7016', '20')), { 'FBL90-7016': 4, 'PANA-L90': 4, 'PANA-90-16': 4, 'MR23-7016': 4, MC16: 1 });
  // B — 25 m, FBL115, RM29, 6+6: FBL115 5, L115/115-12 5, RM12 5, conta yok
  assert.deepEqual(qtys(run('FBL115', 'RM29', 'G12', 'RAL7016', '25')), { 'FBL115-7016': 5, 'PANA-L115': 5, 'PANA-115-12': 5, 'RM12-7016': 5 });
  // C — 50 m, FBL90, küpeşte yok, 6+6: FBL90 9, L90/90-12 9; MR23 / RM / MC yok
  assert.deepEqual(qtys(run('FBL90', null, 'G12', 'RAL7016', '50')), { 'FBL90-7016': 9, 'PANA-L90': 9, 'PANA-90-12': 9 });
  // D — 60 m, FBL115, MR23, 6+6: FBL115 10, L115/115-12 10, MR23 10, MC12 3 kutu
  assert.deepEqual(qtys(run('FBL115', 'MR23', 'G12', 'RAL7016', '60')), { 'FBL115-7016': 10, 'PANA-L115': 10, 'PANA-115-12': 10, 'MR23-7016': 10, MC12: 3 });
});

test('bütün cam / renk / profil / küpeşte birleşimleri ve metreler: boy = yukarı(m / 6), poşet = boy, MC12 = yukarı(m / 27), MC16 = yukarı(m / 43)', () => {
  const meters = ['0,01', '1', '5,99', '6', '6,01', '12', '20', '25', '26,99', '27', '27,01', '43', '43,01', '50', '60', '120', '1000', '9999,99'];
  let n = 0;
  for (const glass of ['G12', 'G16']) for (const color of ['RAL7016', 'ELOXAT']) for (const profile of ['FBL90', 'FBL115']) for (const handrail of [null, 'MR23', 'RM29']) {
    for (const m of meters) {
      const cm = Math.round(Number(m.replace(',', '.')) * 100);
      const r = run(profile, handrail, glass, color, m);
      assert.equal(r.ok, true, `${profile} ${handrail} ${glass} ${color} ${m}`);
      assert.deepEqual(qtys(r), expected(profile, handrail, glass, color, cm), `${profile} ${handrail} ${glass} ${color} ${m}`);
      n++;
    }
  }
  assert.equal(n, 2 * 2 * 2 * 3 * meters.length);
  // Yuvarlama sınırları
  for (const [m, bars] of [['6', 1], ['12', 2], ['20', 4], ['25', 5], ['50', 9], ['6,01', 2], ['0,5', 1]]) {
    assert.equal(qtys(run('FBL90', null, 'G12', 'RAL7016', m))['FBL90-7016'], bars, m);
  }
  for (const [m, mc12, mc16] of [['20', 1, 1], ['25', 1, 1], ['50', 2, 2], ['60', 3, 2], ['27', 1, 1], ['27,01', 2, 1], ['43,01', 2, 2]]) {
    assert.equal(qtys(run('FBL90', 'MR23', 'G12', 'RAL7016', m)).MC12, mc12, `MC12 ${m}`);
    assert.equal(qtys(run('FBL90', 'MR23', 'G16', 'RAL7016', m)).MC16, mc16, `MC16 ${m}`);
  }
});

test('ürün eşleşmeleri: renk profilde ("-7016" / "-ELX"), conta / poşette renk yok; MC12 ile MC16 birlikte yok; RM29 conta eklemez; küpeşte yoksa yalnız FBL + poşet', () => {
  for (const glass of ['G12', 'G16']) for (const color of ['RAL7016', 'ELOXAT']) {
    const r = run('FBL90', 'MR23', glass, color, '30');
    assert.equal(r.ok, true);
    if (!r.ok) continue;
    const colored = Object.fromEntries(r.lines.map((l) => [l.code, l.colored]));
    const sfx = color === 'RAL7016' ? '7016' : 'ELX';
    assert.deepEqual(colored, { [`FBL90-${sfx}`]: true, 'PANA-L90': false, [`PANA-90-${glass === 'G12' ? '12' : '16'}`]: false, [`MR23-${sfx}`]: true, [glass === 'G12' ? 'MC12' : 'MC16']: false });
    assert.equal(r.lines.filter((l) => l.code === 'MC12' || l.code === 'MC16').length, 1);
    const rm = qtys(run('FBL115', 'RM29', glass, color, '30'));
    assert.ok(!('MC12' in rm) && !('MC16' in rm), 'RM29 conta eklemez');
    assert.ok(`RM${glass === 'G12' ? '12' : '16'}-${sfx}` in rm);
    const none = Object.keys(qtys(run('FBL115', null, glass, color, '30')));
    assert.ok(none.every((c) => c.startsWith('FBL115') || c.startsWith('PANA-')), none.join(','));
  }
  // Birimler: profil boy (BARA), poşet (PUNGI), conta kutu (CUTII); 6 m boy bir profil adedidir (6 adet değil)
  const r = run('FBL90', 'MR23', 'G12', 'RAL7016', '6');
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.lines.map((l) => [l.code, l.unitCode, l.qty]), [['FBL90-7016', 'BARA', 1], ['PANA-L90', 'PUNGI', 1], ['PANA-90-12', 'PUNGI', 1], ['MR23-7016', 'BARA', 1], ['MC12', 'CUTII', 1]]);
});

test('seçim hataları: profil zorunlu; renk / cam zorunlu; metre doğrulanır; seçilen küpeşte pasif ya da türü yanlışsa hesap yok; profil yerine küpeşte verilemez', () => {
  assert.deepEqual(run(null, 'MR23', 'G12', 'RAL7016', '10').errors, [{ code: 'PROFILE_REQUIRED' }]);
  assert.deepEqual(run('FBL90', 'MR23', 'G12', '', '10').errors, [{ code: 'COLOR_REQUIRED' }]);
  assert.deepEqual(run('FBL90', 'MR23', '', 'RAL7016', '10').errors, [{ code: 'THICKNESS_REQUIRED' }]);
  assert.deepEqual(run('FBL90', null, 'G12', 'RAL7016', '0').errors, [{ code: 'METERS_ZERO' }]);
  assert.deepEqual(run('FBL90', null, 'G12', 'RAL7016', '-5').errors, [{ code: 'METERS_BAD' }]);
  assert.deepEqual(run('FBL90', null, 'G12', 'RAL7016', '10001').errors, [{ code: 'METERS_TOO_LARGE', max: 10000 }]);
  const mr = sys('MR23');
  assert.deepEqual(calculateRailing({ profile: mr, handrail: null }, { color: 'RAL7016', thicknessId: 'G12', meters: '10' }, ths).errors, [{ code: 'SYSTEM_INACTIVE' }], 'küpeşte profil olarak seçilemez');
  assert.deepEqual(calculateRailing({ profile: sys('FBL90'), handrail: null, handrailWanted: true }, { color: 'RAL7016', thicknessId: 'G12', meters: '10' }, ths).errors, [{ code: 'SYSTEM_INACTIVE' }]);
  assert.deepEqual(calculateRailing({ profile: sys('FBL90'), handrail: { ...mr, isActive: false }, handrailWanted: true }, { color: 'RAL7016', thicknessId: 'G12', meters: '10' }, ths).errors, [{ code: 'SYSTEM_INACTIVE' }]);
  assert.deepEqual(calculateRailing({ profile: sys('FBL90'), handrail: { ...mr, items: [] }, handrailWanted: true }, { color: 'RAL7016', thicknessId: 'G12', meters: '10' }, ths).errors, [{ code: 'SYSTEM_EMPTY', system: 'MR23' }]);
});

test('eksik değer: tek bir eksik ürün bile HİÇBİR miktar üretmez; hata ürünü ve kalemi adıyla söyler (yarım sonuç yok)', () => {
  const broken = sys('FBL90', { 'PANA-90-16': { packContent: null, packMeasure: null } });
  const r = calculateRailing({ profile: broken, handrail: sys('MR23'), handrailWanted: true }, { color: 'RAL7016', thicknessId: 'G16', meters: '20' }, ths);
  assert.deepEqual(r, { ok: false, errors: [{ code: 'NO_PACK', product: 'PANA-90-16' }] });
  const inactive = sys('MR23', { MC12: { isActive: false } });
  const r2 = calculateRailing({ profile: sys('FBL115'), handrail: inactive, handrailWanted: true }, { color: 'ELOXAT', thicknessId: 'G12', meters: '20' }, ths);
  assert.deepEqual(r2, { ok: false, errors: [{ code: 'PRODUCT_INACTIVE', slot: 'MR23 · Conta', product: 'MC12' }] });
  // Bilinmeyen (varsayılanda olmayan) cam kalınlığı: ürün uydurulmaz
  const r3 = calculateRailing({ profile: sys('FBL90'), handrail: null }, { color: 'RAL7016', thicknessId: 'X10', meters: '20' }, [...ths, { id: 'X10', mm: '10', isActive: true }]);
  assert.equal(r3.ok, false);
  assert.deepEqual(r3.ok ? [] : r3.errors.map((e) => e.code), ['NO_OPTION']);
  assert.equal(translate('tr', 'profile.calc.error.PROFILE_REQUIRED'), 'Profil tipini seçin.');
  assert.equal(translate('ro', 'profile.calc.error.PROFILE_REQUIRED'), 'Alegeți dimensiunea profilului.');
});

test('varsayılan yapılandırma: katalogdaki gerçek kodlar ve birimler; GK15 / AD45 eklenmez; eksik / birimi farklı ürün açıkça bildirilir', () => {
  assert.deepEqual(RAILING_THICKNESSES.map((t) => [t.mm, t.label]), [['12.76', '6+6'], ['16.76', '8+8']]);
  assert.deepEqual(RAILING_SYSTEMS.map((s) => [s.code, s.kind]), [['FBL90', 'PROFILE'], ['FBL115', 'PROFILE'], ['MR23', 'HANDRAIL'], ['RM29', 'HANDRAIL']]);
  assert.ok(!RAILING_CODES.includes('GK15') && !RAILING_CODES.includes('AD45'));
  // İlk katalogda (seed) hepsi var ve birimleri uyar
  const catalog = PROFILE_PRODUCTS.map((p) => ({ code: p.code, unitCode: p.unit }));
  assert.deepEqual(railingCatalogProblems(catalog), { missing: [], wrongUnit: [] });
  // Eksik / birimi farklı ürün: açıkça listelenir
  const without = catalog.filter((p) => p.code !== 'PANA-L115').map((p) => (p.code === 'MC16' ? { ...p, unitCode: 'BUCATI' } : p));
  assert.deepEqual(railingCatalogProblems(without), { missing: ['PANA-L115'], wrongUnit: [{ code: 'MC16', unit: 'BUCATI', expected: 'CUTII' }] });
  // Her profil 6 m'lik boy; poşet bir boya yeter (6 m); contalar 27 / 43 m
  for (const p of RAILING_PACKS) assert.equal(p.content, p.code === 'MC12' ? '27' : p.code === 'MC16' ? '43' : '6', p.code);
  // Tek yazıcı: yalnızca boş paket içeriğine yazar, varolan sisteme dokunmaz, işaretle bir kez
  const writer = read('server/profile/calc-defaults.js');
  assert.match(writer, /where: \{ code: pk\.code, packContent: null, packMeasure: null \}/);
  assert.match(writer, /if \(cur\) \{\n\s+if \(!cur\.kind\)/);
  assert.match(writer, /state: 'blocked'/);
  assert.ok(!/profileProduct\.(create|upsert)/.test(writer), 'ürün oluşturulmaz');
});

test('müşteri arayüzü: beş alan (Cam tipi, Profil rengi, Profil tipi, Küpeşte, Toplam metre) yatay; "Stoktaki artıkları kullan" yok; metinler sözlükten; hesap yalnızca okur', () => {
  const ui = read('app/(panel)/siparisler/yeni/ProfileCalculator.tsx');
  const ids = [...ui.matchAll(/id="(calc-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['calc-thickness', 'calc-color', 'calc-profile', 'calc-handrail', 'calc-meters']);
  assert.ok(ui.includes('className="calc-grid"'));
  assert.ok(!/artık|resturi|leftover|checkbox/i.test(ui), 'artık seçeneği yok');
  assert.ok(!/\bname="/.test(ui), 'hesaplayıcının girişleri forma ait değil');
  // Görünen metin sözlükten (m.*) — sabit TR / RO metin yok
  assert.ok(!/>[A-Za-zÇĞİÖŞÜçğıöşüăâîșț]{3,}[^<{]*</.test(ui.replace(/\{[^}]*\}/g, '')), 'sabit metin yok');
  const css = read('app/globals.css');
  assert.match(css, /\.calc-grid \{ display: grid; grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  for (const k of ['glass', 'profileColor', 'profileType', 'handrail', 'handrailNone', 'colCode', 'colDesc', 'colColor', 'colUnit', 'apply', 'overwriteConfirm']) {
    for (const l of ['tr', 'ro']) assert.notEqual(translate(l, `profile.calc.${k}`), `profile.calc.${k}`, `${l}.${k}`);
  }
  assert.equal(translate('ro', 'profile.calc.handrailNone'), 'Fără');
  assert.equal(translate('tr', 'profile.calc.colors.RAL7016'), '7016 MAT');
  const svc = read('server/profile/calc-service.js');
  const fn = svc.slice(svc.indexOf('export async function runRailingCalc('));
  assert.ok(!/stockMovement|notificationOutbox|\.create\(|\.update\(|\.upsert\(/.test(fn), 'hesap kayıt / stok / bildirim yazmaz');
  const action = read('app/(panel)/siparisler/yeni/profile-calc-actions.ts');
  assert.ok(action.includes("requirePermission('ORDER_CREATE')") && action.includes('runRailingCalc(db,'));
  assert.ok(typeof calculate === 'function');
});
