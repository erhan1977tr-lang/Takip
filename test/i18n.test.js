import { test } from 'node:test';
import assert from 'node:assert/strict';
import tr from '../server/i18n/tr/index.js';
import ro from '../server/i18n/ro/index.js';
import { translate, interpolate, isLocale } from '../server/i18n/index.js';
import { formatOfferProblems } from '../server/i18n/format.js';
import { detectLocale, localeFromAcceptLanguage, localeForCountry, clientIp } from '../server/i18n/detect.js';
import { offerProblems } from '../server/orders/rules.js';

/** { 'a.b.c': 'metin', … } */
function flatten(o, p = '', out = {}) {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
const T = flatten(tr), R = flatten(ro);
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('Türkçe ve Romence sözlüklerin anahtarları aynı', () => {
  const onlyTr = Object.keys(T).filter((k) => !(k in R));
  const onlyRo = Object.keys(R).filter((k) => !(k in T));
  assert.deepEqual(onlyTr, [], `yalnızca TR'de: ${onlyTr.join(', ')}`);
  assert.deepEqual(onlyRo, [], `yalnızca RO'da: ${onlyRo.join(', ')}`);
});

test('tüm değerler boş olmayan metin; yer tutucular iki dilde aynı', () => {
  for (const [k, v] of Object.entries(T)) {
    assert.equal(typeof v, 'string', `tr ${k}`);
    assert.equal(typeof R[k], 'string', `ro ${k}`);
    assert.ok(v.trim() && R[k].trim(), `boş metin: ${k}`);
    assert.equal(placeholders(v), placeholders(R[k]), `yer tutucu farkı: ${k}`);
  }
});

test('Romencede sedilli ş/ţ değil, virgüllü ș/ț kullanılır', () => {
  const bad = Object.entries(R).filter(([, v]) => /[şţŞŢ]/.test(v)).map(([k]) => k);
  assert.deepEqual(bad, []);
});

test('çeviri ve yer tutucu', () => {
  assert.equal(translate('tr', 'status.order.URETIMDE'), 'Üretimde');
  assert.equal(translate('ro', 'status.order.URETIMDE'), 'În producție');
  assert.equal(translate('ro', 'status.sla.left', { h: '15.0' }), '15.0 h rămase');
  assert.equal(translate('ro', 'yok.boyle.bir.anahtar'), 'yok.boyle.bir.anahtar');
  assert.equal(interpolate('{a}-{b}-{c}', { a: 1, b: 'x' }), '1-x-{c}');
  assert.ok(isLocale('ro') && isLocale('tr') && !isLocale('en'));
});

test('yeni cam siparişi: tahmini yükleme tarihi notu (GG.AA.YYYY) iki dilde', () => {
  assert.equal(
    translate('ro', 'newOrder.form.info.shipNote', { date: '23.10.2026' }),
    'Data estimată de încărcare a acestei comenzi va fi 23.10.2026; echipa de vânzări o actualizează dacă este necesar.',
  );
  assert.equal(translate('tr', 'newOrder.form.info.shipNote', { date: '23.10.2026' }), 'Bu siparişin tahmini yükleme tarihi 23.10.2026 olacak; satış ekibi gerekirse günceller.');
});

test('teklif eksikleri iki dilde', () => {
  const p = offerProblems([
    { kind: 'CAM', enMm: 1000, boyMm: 2000, adet: 1, unit: 'm2', unitPrice: '24' },
    { kind: 'CNC', adet: 2, unit: 'adet', unitPrice: '' },
    { kind: 'DELIK', adet: 4, unit: 'adet', unitPrice: '0' },
  ]);
  const fmt = (d) => formatOfferProblems(p, { offerProblems: d.offerProblems, lineKind: d.status.lineKind });
  assert.deepEqual(fmt(tr), ['2 satırın fiyatı boş: 1. CNC, 1. Delik. Fiyat girin ya da satırı bedelsiz işaretleyin.']);
  assert.deepEqual(fmt(ro), ['2 rânduri fără preț: 1. CNC, 1. Găuri. Introduceți prețul sau marcați rândul ca gratuit.']);
  assert.deepEqual(formatOfferProblems(offerProblems([{ kind: 'CAM', unit: 'm2', unitPrice: '5' }]), { offerProblems: tr.offerProblems, lineKind: tr.status.lineKind }),
    ['1. satır: m² ile fiyatlanan satırda en ve boy girilmeli.']);
  // Karar 113: işlem adedi 1'den büyük cam satırına bağlanamaz (hangi satır olduğu yazılır)
  const shared = offerProblems([
    { kind: 'CAM', description: 'Temper', enMm: 1000, boyMm: 2000, adet: 4, unit: 'm2', unitPrice: '24' },
    { kind: 'CAM', description: 'Lamine', enMm: 1000, boyMm: 2000, adet: 5, unit: 'm2', unitPrice: '24' },
    { kind: 'DELIK', adet: 3, unit: 'adet', unitPrice: '2' },
  ]);
  assert.deepEqual(formatOfferProblems(shared, { offerProblems: tr.offerProblems, lineKind: tr.status.lineKind }),
    ["2. satır (Lamine): CNC / delik tek bir cama aittir; adedi 1'den büyük cam satırına işlem bağlanamaz. İşlemli camı ayrı satıra (adet 1) ayırın."]);
  assert.match(formatOfferProblems(shared, { offerProblems: ro.offerProblems, lineKind: ro.status.lineKind })[0], /^rândul 2 \(Lamine\): CNC \/ găurile aparțin unei singure bucăți/);
});

test('dil seçimi: ülke, tarayıcı dili, varsayılan', () => {
  assert.equal(localeForCountry('TR'), 'tr');
  assert.equal(localeForCountry('ro'), 'ro');
  assert.equal(localeForCountry('MD'), 'ro');
  assert.equal(localeForCountry('DE'), null);
  assert.equal(localeFromAcceptLanguage('en-US,en;q=0.9,tr;q=0.8'), 'tr');
  assert.equal(localeFromAcceptLanguage('ro-RO,ro;q=0.9,en;q=0.8'), 'ro');
  assert.equal(localeFromAcceptLanguage('tr;q=0.4,ro;q=0.9'), 'ro');
  assert.equal(localeFromAcceptLanguage('de-DE,en;q=0.5'), null);
  const lookup = (ip) => ({ '78.180.1.1': 'TR', '86.121.5.5': 'RO' })[ip] ?? null;
  // IP, tarayıcı dilinden önce gelir
  assert.equal(detectLocale({ ip: '78.180.1.1', acceptLanguage: 'ro-RO' }, lookup), 'tr');
  assert.equal(detectLocale({ ip: '86.121.5.5', acceptLanguage: 'tr-TR' }, lookup), 'ro');
  // Cloudflare ülke başlığı en önce
  assert.equal(detectLocale({ country: 'TR', ip: '86.121.5.5' }, lookup), 'tr');
  // IP bilinmiyorsa tarayıcı dili, o da yoksa Romence
  assert.equal(detectLocale({ ip: '127.0.0.1', acceptLanguage: 'tr-TR,tr;q=0.9' }, lookup), 'tr');
  assert.equal(detectLocale({ ip: '8.8.8.8', acceptLanguage: 'en-US' }, lookup), 'ro');
  assert.equal(detectLocale({}, lookup), 'ro');
});

test('istemci IP adresi başlıklardan', () => {
  const h = (o) => (n) => o[n] ?? null;
  // Güvenilen kaynak Caddy'nin yazdığı X-Forwarded-For'dur (ayrıntılı testler: test/security.test.js)
  assert.equal(clientIp(h({ 'x-forwarded-for': '86.121.5.5' })), '86.121.5.5');
  assert.equal(clientIp(h({ 'cf-connecting-ip': '78.180.1.1', 'x-forwarded-for': '1.1.1.1' })), '1.1.1.1');
  assert.equal(clientIp(h({ 'x-real-ip': '5.5.5.5' })), null);
  assert.equal(clientIp(h({})), null);
});
