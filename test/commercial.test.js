// Bağımsız yönetici ticari teklifi (3.83.0, karar 277): hesap (m² ve tutar hassasiyeti mevcut kuralla aynı), doğrulama,
// müşteri görünümü (maliyet / kâr asla), PDF metni, iç Excel, yetki ve yapı (sipariş / FGO / stok modülü yok).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { can, ROLE_PERMISSIONS, ROLES } from '../server/auth/permissions.js';
import {
  DEFAULT_TERMS, GKH_CONTACT, computeOffer, customerView, offerNoText, packsFor, parseOffer, perMlContent, pieceMilli, previewOffer,
  profileDefaults, validityText, fromScaled,
} from '../server/commercial/rules.js';
import { internalSheets } from '../server/commercial/export.js';
import { commercialOfferPdf } from '../server/pdf/commercial-offer.js';
import { writeReportXlsx } from '../server/files/xlsx-report.js';
import { readXlsx } from '../server/files/xlsx.js';
import { FONTS } from '../server/pdf/fonts.js';
import { offerLineTotals, pieceAreaFromDims } from '../server/orders/rules.js';
import ro from '../server/i18n/ro/index.js';
import { translate } from '../server/i18n/index.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Örnek teklif (Trademark Glass, 0496) — katalog kopyası
const CAT = {
  glassProducts: new Map([
    ['g1', { id: 'g1', nameTr: 'Temperli lamine 8.8.2', colorTr: 'Şeffaf', nameRo: '8.2.8., TRANSPARENT, Securizat', colorRo: 'cantuit', isActive: true }],
  ]),
  profileProducts: new Map([
    ['p1', { id: 'p1', code: 'FBL115-7016', nameRo: 'Profil Aluminiu - Balustrada - 6M.- GAURIT', nameTr: 'Profil', unitCode: 'BARA', packMeasure: 'M', packContent: '6.000', category: { nameRo: 'PROFILE ALUMINIU', nameTr: 'PROFİL', sortOrder: 3 } }],
    ['p2', { id: 'p2', code: 'GK15', nameRo: 'Garnitura Exterior', nameTr: 'Dış conta', unitCode: 'CUTII', packMeasure: 'M', packContent: '137', category: { nameRo: 'GARNITURI', nameTr: 'CONTA', sortOrder: 1 } }],
    ['p3', { id: 'p3', code: 'PANA', nameRo: 'Penele Geam de 16', nameTr: 'Takoz', unitCode: 'BUCATI', packMeasure: 'BUC', packContent: '1', category: { nameRo: 'ACCESORII', nameTr: 'AKSESUAR', sortOrder: 4 } }],
  ]),
  customers: new Map([['c1', { id: 'c1', name: 'Trademark Glass SRL' }]]),
};
const SAMPLE = {
  date: '2026-10-06', firmName: 'Trademark Glass', validityDays: '5', terms: [...DEFAULT_TERMS], note: 'iç not: fabrika 50', glassExtraCost: '1700',
  glass: [{ productId: 'g1', description: '8.2.8., TRANSPARENT, Securizat, cantuit', en: '1000', boy: '970', qty: '280', price: '63,10', cost: '50' }],
  profile: [
    { productId: 'p1', meters: '300', color: 'RAL7016', price: '28.15', cost: '22.12' },
    { productId: 'p2', meters: '270', price: '1.10', cost: '0.28' },
    { productId: 'p3', qty: '900', price: '1.75', cost: '0.46' },
  ],
};
const parsed = () => {
  const r = parseOffer(SAMPLE, CAT);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.data;
};

test('hesap: örnek teklifin tutarları (cam m² 3 ondalık, tutar bir kez 2 ondalık; profil metreyle, tam paket)', () => {
  const c = computeOffer(parsed());
  assert.equal(c.glass[0].pieceM2, '0.970');
  assert.equal(c.glass[0].m2, '271.600');
  assert.equal(c.glass[0].amount, '17137.96');
  // FBL115: 300 m → 50 çubuk (6 m) → 300 ML × 28.15 = 8445.00
  assert.deepEqual([c.profile[0].qty, c.profile[0].billQty, c.profile[0].amount], [50, '300', '8445.00']);
  // GK15: 270 m → 2 kutu (137 m) → 274 ML × 1.10 = 301.40 (örnek teklifteki 274)
  assert.deepEqual([c.profile[1].qty, c.profile[1].billQty, c.profile[1].amount], [2, '274', '301.40']);
  assert.deepEqual([c.profile[2].qty, c.profile[2].billQty, c.profile[2].amount], [900, '900', '1575.00']);
  assert.equal(c.totals.glass, '17137.96');
  assert.equal(c.totals.profile, '10321.40');
  assert.equal(c.totals.total, '27459.36');
  // İç maliyet: cam 271.6 × 50 + nakliye/gümrük 1700; örnek iç dosyadaki cam kârı 1857.96
  assert.equal(c.glass[0].costAmount, '13580.00');
  assert.equal(c.totals.extraCost, '1700.00');
  assert.equal(c.totals.extraPerM2, '6.2592');
  const glassProfit = Number(c.totals.glass) - Number(c.totals.glassCost) - Number(c.totals.extraCost);
  assert.equal(glassProfit.toFixed(2), '1857.96');
  // Maliyet: cam 13580 + 1700 + profil 300 × 22.12 + 274 × 0.28 + 900 × 0.46
  assert.equal(c.totals.cost, '22406.72');
  assert.equal(c.totals.profit, '5052.64');
  assert.equal(c.totals.margin, '18.40');
  assert.equal(c.totals.missingCost, 0);
});

test('hesap: m² ve tutar mevcut sipariş kuralıyla aynı (parça en × boy 3 ondalık, adetle çarpım, tutar bir kez) — rastgele 2000 satır', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return 1 + (seed % n); };
  for (let i = 0; i < 2000; i++) {
    const en = 49 + rnd(4000), boy = 49 + rnd(4000), qty = rnd(300), price = (rnd(20000) / 100).toFixed(2);
    const mine = computeOffer({ glass: [{ en, boy, qty, price, cost: null }], profile: [] }).glass[0];
    assert.equal(Number(fromScaled(pieceMilli(en, boy), 3)), pieceAreaFromDims(en, boy), `${en}×${boy}`);
    const theirs = offerLineTotals({ kind: 'CAM', unit: 'm2', enMm: en, boyMm: boy, adet: qty, pieceM2: pieceAreaFromDims(en, boy), unitPrice: price });
    assert.equal(Number(mine.m2), theirs.metraj, `${en}×${boy}×${qty}`);
    // Tutar: m² × fiyat TAM yarım-yukarı (tam sayı aritmetiği). Mevcut kayan noktalı yuvarlama yalnızca tam yarım kuruş
    // sınırında bir kuruş aşağı kalabilir; başka hiçbir farka izin yok.
    const exact = BigInt(Math.round(Number(mine.m2) * 1000)) * BigInt(Math.round(Number(price) * 100)); // 10⁻⁵
    const half = exact % 1000n === 500n;
    const diff = Math.round((Number(mine.amount) - theirs.amount) * 100);
    assert.ok(diff === 0 || (half && diff === 1), `${en}×${boy}×${qty}×${price}: ${mine.amount} / ${theirs.amount}`);
  }
});

test('hesap: tutar bir kez yarım-yukarı (0.005 → yukarı), fiyat 4 ondalık', () => {
  const c = computeOffer({ glass: [{ en: 1000, boy: 1000, qty: 1, price: '10.005', cost: null }], profile: [{ perMl: false, content: null, qty: 3, price: '0.3333', cost: '0.1' }] });
  assert.equal(c.glass[0].amount, '10.01');
  assert.equal(c.profile[0].amount, '1.00');
  assert.equal(c.totals.missingCost, 1);
  // Maliyeti eksik satırın satışı kâra sayılmaz: kâr / marj yalnızca maliyeti girilmiş satırlardan
  assert.equal(c.totals.costedSale, '1.00');
  assert.equal(c.totals.profit, '0.70');
});

test('profil: metre → tam paket (hesaplayıcının yuvarlaması), metreyle fiyat yalnızca paket ölçüsü M + içerik', () => {
  assert.equal(packsFor('300', '6'), 50);
  assert.equal(packsFor('300.01', '6'), 51);
  assert.equal(packsFor('0.01', '137'), 1);
  assert.equal(perMlContent({ packMeasure: 'M', packContent: '6.000' }), '6');
  assert.equal(perMlContent({ packMeasure: 'BUC', packContent: '10' }), null);
  assert.equal(perMlContent({ packMeasure: 'M', packContent: null }), null);
  assert.equal(perMlContent({ packMeasure: 'M', packContent: '0' }), null);
  // Öneri: liste / alış fiyatı birim başına → €/ML; alış EUR değilse ya da birim farklıysa maliyet önerilmez
  assert.deepEqual(profileDefaults({ listPrice: '168.90', purchasePrice: '132.72', purchaseCurrency: 'EUR', unitCode: 'BARA', packMeasure: 'M', packContent: '6' }), { price: '28.15', cost: '22.12' });
  assert.deepEqual(profileDefaults({ listPrice: '2', purchasePrice: '1', purchaseCurrency: 'RON', unitCode: 'BUCATI' }), { price: '2.00', cost: null });
  assert.deepEqual(profileDefaults({ listPrice: '2', purchasePrice: '1', purchaseCurrency: 'EUR', purchaseUnit: 'CUTII', unitCode: 'BUCATI' }), { price: '2.00', cost: null });
});

test('doğrulama: hatalı girişler satır bilgisiyle reddedilir; ürün bilgisi katalogdan', () => {
  const bad = (patch, code, extra = {}) => {
    const r = parseOffer({ ...SAMPLE, ...patch }, CAT);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.code, code);
    for (const [k, v] of Object.entries(extra)) assert.equal(r[k], v);
  };
  bad({ date: '2026-13-40' }, 'DATE');
  bad({ firmName: '', customerId: '' }, 'FIRM');
  bad({ customerId: 'yok' }, 'CUSTOMER');
  bad({ validityDays: '0' }, 'VALIDITY');
  bad({ terms: Array(21).fill('x') }, 'TERMS');
  bad({ glassExtraCost: '-5' }, 'EXTRA');
  bad({ glass: [{ ...SAMPLE.glass[0], productId: 'zz' }] }, 'GLASS_PRODUCT', { section: 'glass', index: 0 });
  bad({ glass: [{ ...SAMPLE.glass[0], en: '0' }] }, 'DIMENSION');
  bad({ glass: [{ ...SAMPLE.glass[0], boy: '10001' }] }, 'DIMENSION');
  bad({ glass: [{ ...SAMPLE.glass[0], qty: '1.5' }] }, 'QTY');
  bad({ glass: [{ ...SAMPLE.glass[0], price: '' }] }, 'PRICE');
  bad({ glass: [{ ...SAMPLE.glass[0], price: '1.00001' }] }, 'PRICE');
  bad({ glass: [{ ...SAMPLE.glass[0], cost: 'abc' }] }, 'COST');
  bad({ profile: [{ productId: 'p1', meters: '0', price: '1' }] }, 'METERS', { section: 'profile', index: 0 });
  bad({ profile: [{ productId: 'p1', meters: '1.234', price: '1' }] }, 'METERS');
  bad({ profile: [{ productId: 'p3', qty: '0', price: '1' }] }, 'QTY');
  bad({ profile: [{ productId: 'p1', meters: '6', price: '1', color: 'MAVI' }] }, 'COLOR');
  bad({ profile: [{ productId: 'p1', meters: '6' }] }, 'PRICE');
  bad({ glass: Array(101).fill(SAMPLE.glass[0]) }, 'TOO_MANY');
  // Firma adı boşsa seçilen müşterinin adı; ürün kodu / birim / kategori tarayıcıdan değil katalogdan
  const r = parseOffer({ ...SAMPLE, firmName: '', customerId: 'c1', profile: [{ productId: 'p2', meters: '10', price: '1', code: 'SAHTE', unitCode: 'X', category: 'Y' }] }, CAT);
  assert.equal(r.ok, true);
  assert.equal(r.data.firmName, 'Trademark Glass SRL');
  assert.deepEqual([r.data.profile[0].code, r.data.profile[0].unitCode, r.data.profile[0].category, r.data.profile[0].content], ['GK15', 'CUTII', 'GARNITURI', '137']);
  // Maliyet isteğe bağlı (boş → null; uydurulmaz)
  const nc = parseOffer({ ...SAMPLE, glass: [{ ...SAMPLE.glass[0], cost: '' }] }, CAT);
  assert.equal(nc.data.glass[0].cost, null);
});

test('müşteri görünümü: maliyet, kâr, marj, nakliye / gümrük, iç not ve katalog kimliği YOK', () => {
  const data = parsed();
  const v = customerView({ no: 496, version: 1, data, draft: false });
  const json = JSON.stringify(v);
  for (const key of ['cost', 'Cost', 'profit', 'margin', 'extra', 'note', 'productId', 'catalogTr', 'costedSale']) assert.ok(!json.includes(`"${key}`), key);
  for (const secret of ['22.12', '13580', '1700', 'iç not', '6.2592']) assert.ok(!json.includes(secret), secret);
  assert.equal(v.no, '0496');
  assert.deepEqual(v.totals, { glassM2: '271.600', glass: '17137.96', profile: '10321.40', total: '27459.36' });
  // Profil satırları kategoriye göre (kategori sırası), metreyle fiyatlananlar ML
  assert.deepEqual(v.profileGroups.map((g) => g.title), ['GARNITURI', 'PROFILE ALUMINIU', 'ACCESORII']);
  assert.deepEqual(v.profileGroups[1].rows[0], { description: 'Profil Aluminiu - Balustrada - 6M.- GAURIT', code: 'FBL115-7016', color: 'RAL7016', unit: 'ML', qty: '300', perMl: true, price: '28.15', amount: '8445.00' });
  assert.equal(v.profileGroups[2].rows[0].unit, 'bucăți');
  assert.equal(v.terms[0], validityText(5));
  assert.equal(offerNoText(7), '0007');
});

/** PDF içerik akışlarındaki metinler (test/admin-fixes.test.js ile aynı okuyucu) */
const REVERSE = Object.fromEntries(['Regular', 'Bold'].map((k) => [k, new Map(FONTS[k].map.map(([cp, gid]) => [gid, cp]))]));
function pdfText(pdf) {
  const out = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  const s = pdf.toString('latin1');
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length;
    let ops;
    try { ops = zlib.inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1'); } catch { continue; }
    for (const t of ops.matchAll(/\/(F1|F2) [\d.]+ Tf [\d.-]+ [\d.-]+ Td <([0-9a-f]*)> Tj/g)) {
      const map = REVERSE[t[1] === 'F2' ? 'Bold' : 'Regular'];
      out.push((t[2].match(/.{4}/g) ?? []).map((h) => String.fromCodePoint(map.get(parseInt(h, 16)) ?? 63)).join(''));
    }
  }
  return out;
}

test('müşteri PDF: Romence, logo, örnek düzen ve tutarlar; maliyet / kâr / iç not yazılmaz; taslak damgası', () => {
  const data = parsed();
  const pdf = commercialOfferPdf(customerView({ no: 496, version: 1, data, draft: false }), ro.commercial.pdf, GKH_CONTACT);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const text = pdfText(pdf).join('\n');
  assert.ok(pdf.toString('latin1').includes('/Subtype /Image'), 'GKH logosu gömülü');
  for (const s of ['OFERTA', 'Nr : 0496', 'Trademark Glass', '06.10.2026', '1000  x  970', '271.600', '63.10 €', '17,137.96 €', 'FBL115-7016', '8,445.00 €',
    '274', '301.40 €', 'GARNITURI', 'TOTAL FĂRĂ TVA', '27,459.36 €', '1- Oferta este valabilă 5 zile lucrătoare.', 'www.gkh.ro', 'info@gkh.ro']) {
    assert.ok(text.includes(s), s);
  }
  for (const secret of ['22.12', '13,580', '1,700', '1857', 'iç not', 'Cost', 'Profit', 'Marj', 'CIORNĂ']) assert.ok(!text.includes(secret), secret);
  const draft = pdfText(commercialOfferPdf(customerView({ no: 496, version: 2, data, draft: true }), ro.commercial.pdf, GKH_CONTACT)).join('\n');
  assert.ok(draft.includes('CIORNĂ'));
  assert.ok(draft.includes('Revizia 2'));
  // Çok satırlı teklif sayfalara bölünür (her sayfada altbilgi)
  const many = { ...data, glass: Array(60).fill(data.glass[0]) };
  const long = pdfText(commercialOfferPdf(customerView({ no: 1, version: 1, data: many, draft: false }), ro.commercial.pdf, GKH_CONTACT)).join('\n');
  assert.ok(long.includes('1 / 3') || long.includes('1 / 2'), 'sayfa numarası');
});

test('iç Excel: satış, maliyet, kâr, marj ve iç not; ortak rapor yazıcısıyla okunur', () => {
  const t = (key, params) => translate('tr', key, params);
  const sheets = internalSheets({ no: 496, version: 1, status: 'TASLAK', draft: true, data: parsed() }, t, { statusText: 'Taslak', locale: 'tr' });
  const buf = writeReportXlsx({ sheets, logo: null });
  const flat = readXlsx(buf).rows.flat();
  for (const v of [17137.96, 13580, 1700, 8445, 22406.72, 5052.64, 18.4, 'FBL115-7016', 'iç not: fabrika 50', 'ML']) assert.ok(flat.includes(v), String(v));
});

test('yetki: ticari teklif yalnızca yönetici ve yönetici yardımcısında', () => {
  assert.deepEqual(ROLES.filter((r) => can(r, 'COMMERCIAL_OFFER_MANAGE')).sort(), ['ADMIN', 'YONETICI_YARDIMCISI']);
  assert.ok(ROLE_PERMISSIONS.YONETICI_YARDIMCISI.includes('COMMERCIAL_OFFER_MANAGE'));
});

test('menü: "Teklif Oluştur" ve "Teklifler" Çizim Ekibi ile Muhasebe arasında (yönetici ve yardımcısı)', () => {
  const nav = read('lib/roles.ts');
  const admin = nav.slice(nav.indexOf('const ADMIN_NAV'), nav.indexOf('export const NAV'));
  const i = (s) => admin.indexOf(s);
  assert.ok(i("'nav.drawingTeam'") < i("'nav.commercialOffers'") && i("'nav.commercialOffers'") < i("'nav.accounting'"));
  assert.ok(i("'/admin/ticari-teklifler/yeni', key: 'nav.commercialOfferNew'") > i("'nav.commercialOffers'"));
  assert.ok(i("'/admin/ticari-teklifler', key: 'nav.commercialOfferList'") > i("'nav.commercialOfferNew'"));
  assert.ok(i("'/admin/ticari-teklifler', key: 'nav.commercialOfferList'") < i("'nav.accounting'"));
  assert.equal(translate('tr', 'nav.commercialOfferNew'), 'Teklif Oluştur');
  assert.equal(translate('tr', 'nav.commercialOfferList'), 'Teklifler');
});

test('yapı: her servis işlevinin ilk satırı yetki denetimi; sayfa / action / rota yetki ister', () => {
  const svc = read('server/commercial/service.js');
  const exported = [...svc.matchAll(/export async function (\w+)\([^)]*\) \{\n(.*)\n/g)];
  assert.ok(exported.length >= 9);
  for (const [, name, first] of exported) assert.equal(first.trim(), 'if (!allowed(actor)) return FORBIDDEN;', name);
  assert.match(svc, /const allowed = \(actor\) => can\(actor\?\.role, 'COMMERCIAL_OFFER_MANAGE'\);/);
  const dir = path.join('app', '(panel)', 'admin', 'ticari-teklifler');
  const files = ['page.tsx', 'yeni/page.tsx', '[id]/page.tsx'].map((f) => path.join(dir, f));
  for (const f of files) assert.match(read(f), /requirePermission\('COMMERCIAL_OFFER_MANAGE'\)/, f);
  for (const f of ['[id]/pdf/route.ts', '[id]/excel/route.ts']) assert.match(read(path.join(dir, f)), /userCan\(user, 'COMMERCIAL_OFFER_MANAGE'\)/, f);
  const actions = read(path.join(dir, 'actions.ts'));
  const fns = [...actions.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\n(.*)\n/g)];
  assert.ok(fns.length >= 6);
  for (const [, name, first] of fns) assert.match(first, /requirePermission\(PERM\)/, name);
});

test('yapı: modül sipariş, FGO, stok, bildirim ve e-posta kodunu kullanmaz; yalnızca kendi tablolarına yazar', () => {
  const files = ['server/commercial/rules.js', 'server/commercial/service.js', 'server/commercial/export.js', 'server/pdf/commercial-offer.js',
    ...fs.readdirSync(path.join(ROOT, 'app/(panel)/admin/ticari-teklifler'), { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `app/(panel)/admin/ticari-teklifler/${f}`)];
  for (const f of files) {
    const s = read(f);
    for (const bad of [/orders\/transitions/, /orders\/create/, /integrations\/fgo/, /glass\/billing/, /profile\/stock/, /profile\/create/, /notifications\//, /mail\//, /enqueueOutbox/, /notificationOutbox/, /stockMovement/, /\border\.create/, /\boffer\.create/]) {
      assert.doesNotMatch(s, bad, `${f}: ${bad}`);
    }
  }
  const svc = read('server/commercial/service.js');
  const writes = [...svc.matchAll(/tx\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(writes)].sort(), ['commercialOffer', 'commercialOfferVersion']);
  // PDF üreticisi yalnızca müşteri görünümünü alır: maliyet / kâr alanlarına hiç değinmez
  const pdf = read('server/pdf/commercial-offer.js');
  assert.doesNotMatch(pdf, /\bcost|profit|margin|extraCost|costAmount/);
  assert.match(read('app/(panel)/admin/ticari-teklifler/[id]/pdf/route.ts'), /commercialOfferPdf\(view, /);
  assert.match(read('app/(panel)/admin/ticari-teklifler/[id]/pdf/route.ts'), /const view = customerView\(/);
});

test('önizleme: eksik / hatalı satır toplama katılmaz; geçerli satırlar sunucu kuralıyla', () => {
  const pv = previewOffer({
    glassExtraCost: '',
    glass: [{ productId: 'g1', en: '1000', boy: '970', qty: '280', price: '63,10', cost: '' }, { productId: 'g1', en: 'x', boy: '1', qty: '1', price: '1' }],
    profile: [{ productId: 'p1', meters: '300', price: '28.15', cost: '22.12' }, { productId: '', qty: '1', price: '1' }],
  }, (id) => (id === 'p1' ? '6' : null));
  assert.equal(pv.invalid, 2);
  assert.equal(pv.glass[1], null);
  assert.equal(pv.glass[0].amount, '17137.96');
  assert.equal(pv.totals.total, '25582.96');
  assert.equal(pv.totals.missingCost, 1);
});
