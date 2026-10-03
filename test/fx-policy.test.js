// Müşteri kur politikası (Aşama 7D-1): ondalık hesap, BNR okuma, tek çözücü. Ağa çıkılmaz; FGO'ya hiçbir şey gönderilmez.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMarkup, padRate } from '../server/fx/decimal.js';
import { bnrRate, fetchBnr, parseBnr } from '../server/fx/bnr.js';
import { FX_SNAPSHOT_CLEAR, FxUnavailable, fxSnapshot, parseFxPolicy, parseMarkupPercent, previewExchangeRate, resolveExchangeRate, trimPercent } from '../server/fx/resolve.js';

const BNR_XML = (date = '2026-10-02', eur = '5.1000') => `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="https://www.bnr.ro/xsd" xmlns:xsi="https://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="https://curs.bnr.ro/xsd/nbrfxrates.xsd">
  <Header><Publisher>National Bank of Romania</Publisher><PublishingDate>${date}</PublishingDate><MessageType>DR</MessageType></Header>
  <Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
    <Cube date="${date}">
      <Rate currency="EUR">${eur}</Rate>
      <Rate currency="HUF" multiplier="100">1.3204</Rate>
      <Rate currency="USD">4.3512</Rate>
      <Rate currency="XXX">0.0000</Rate>
      <Rate currency="YYY" multiplier="7">1.0000</Rate>
    </Cube>
  </Body>
</DataSet>`;

/** Yalnızca "günün BT kuru" ayarını bilen sahte veritabanı */
const fakeDb = (daily = null) => ({ integrationSetting: { findUnique: async () => (daily ? { value: daily } : null) } });
const DAY = '2026-10-03';
const bnrOk = (rate = '5.1000', date = '2026-10-02') => async () => ({ ok: true, rate, date, url: 'https://curs.bnr.ro/nbrfxrates.xml' });
const never = (name) => async () => { throw new Error(`${name} çağrılmamalıydı`); };

test('ondalık: BNR + % tam hesaplanır, yalnızca en sonda 4 ondalığa yuvarlanır (yarım-yukarı)', () => {
  assert.equal(applyMarkup('5.1000', '2'), '5.2020', '5.10 + %2 = 5.2020');
  assert.equal(applyMarkup('5.1000', '0'), '5.1000', '+ %0 = BNR');
  assert.equal(applyMarkup('5.1', '2.000'), '5.2020');
  assert.equal(applyMarkup('5.0934', '2.5'), '5.2207', '5.2207350 → 5.2207');
  assert.equal(applyMarkup('5.0935', '0.005'), '5.0938', '5.09375467… → 5.0938 (kayan noktayla değil)');
  assert.equal(applyMarkup('4.9765', '1.5'), '5.0511', '5.05114750 → 5.0511');
  assert.equal(applyMarkup('5.0001', '0.001'), '5.0002', '5.00015000… yarım-yukarı');
  assert.equal(applyMarkup('x', '2'), null);
  assert.equal(padRate('5.1'), '5.1000');
  assert.equal(padRate('0.013204'), '0.013204', 'fazla ondalık kesilmez');
});

test('yüzde doğrulama: sayı, 0–20, en çok 3 ondalık; politika formu', () => {
  assert.equal(parseMarkupPercent('2'), '2.000');
  assert.equal(parseMarkupPercent('2,5'), '2.500');
  assert.equal(parseMarkupPercent('0'), '0.000');
  assert.equal(parseMarkupPercent('20'), '20.000');
  for (const bad of ['', ' ', '-1', '20.001', '21', '1.2345', 'abc', '2%', '1e2', null, undefined]) assert.equal(parseMarkupPercent(bad), null, `geçersiz: ${bad}`);
  assert.equal(trimPercent('2.000'), '2');
  assert.equal(trimPercent('2.500'), '2.5');

  assert.deepEqual(parseFxPolicy({ policy: '', percent: '5' }), { ok: true, data: { fxPolicy: null, fxMarkupPercent: null } }, 'seçilmedi = eski kural');
  assert.deepEqual(parseFxPolicy({ policy: 'BNR', percent: '5' }), { ok: true, data: { fxPolicy: 'BNR', fxMarkupPercent: null } }, 'yüzde yalnızca BNR + %');
  assert.deepEqual(parseFxPolicy({ policy: 'BT_UNIT_SELL', percent: '' }), { ok: true, data: { fxPolicy: 'BT_UNIT_SELL', fxMarkupPercent: null } });
  assert.deepEqual(parseFxPolicy({ policy: 'BNR_PLUS_PERCENT', percent: '2' }), { ok: true, data: { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2.000' } });
  assert.deepEqual(parseFxPolicy({ policy: 'BNR_PLUS_PERCENT', percent: '' }), { ok: false, code: 'BAD_PERCENT' });
  assert.deepEqual(parseFxPolicy({ policy: 'BNR_PLUS_PERCENT', percent: '-2' }), { ok: false, code: 'BAD_PERCENT' });
  assert.deepEqual(parseFxPolicy({ policy: 'BNR_PLUS_PERCENT', percent: '50' }), { ok: false, code: 'BAD_PERCENT' });
  assert.deepEqual(parseFxPolicy({ policy: 'BT_XML', percent: '' }), { ok: false, code: 'BAD_POLICY' });
});

test('BNR XML: yapı doğrulanır, para birimi / pozitif sayı / gün okunur, çok birimli kur 1 birime çevrilir', () => {
  const r = parseBnr(BNR_XML());
  assert.equal(r.ok, true);
  assert.equal(r.date, '2026-10-02');
  assert.equal(r.rates.EUR, '5.1000');
  assert.equal(r.rates.HUF, '0.013204', '100 HUF = 1.3204 → 1 HUF');
  assert.equal(r.rates.XXX, undefined, 'sıfır kur okunmaz');
  assert.equal(r.rates.YYY, undefined, 'beklenmeyen çarpan okunmaz');
  assert.equal(parseBnr(BNR_XML().replace('National Bank of Romania', 'Someone Else')).ok, false, 'yayımcı BNR değil');
  assert.equal(parseBnr(BNR_XML().replace('https://www.bnr.ro/xsd"', 'https://example.com/xsd"')).ok, false, 'ad alanı BNR değil');
  assert.equal(parseBnr(BNR_XML().replace('https://www.bnr.ro/xsd"', 'http://www.bnr.ro/xsd"')).ok, true, 'eski (http) ad alanı da BNR');
  assert.equal(parseBnr('<!doctype html><html lang="ro"><head><title>BNR</title></head><body><p>EUR</p></body></html>').ok, false, 'BNR ana sayfası (eski adresin yönlendiği HTML) kur sayılmaz');
  assert.equal(parseBnr(BNR_XML().replace('<OrigCurrency>RON', '<OrigCurrency>EUR')).ok, false);
  assert.equal(parseBnr('<html>403</html>').ok, false);
  assert.equal(parseBnr(BNR_XML().replace(/<Rate[\s\S]*?<\/Cube>/, '</Cube>')).ok, false, 'kur yok');
});

test('BNR alma: yalnızca bnr.ro, saklanır (ikinci istek ağa çıkmaz), kaynak günü denetlenir', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(BNR_XML()); };
  const cache = { at: 0, data: null };
  const now = new Date('2026-10-03T08:00:00Z');
  const a = await bnrRate({ currency: 'EUR', day: DAY, fetchImpl, cache, now });
  assert.deepEqual(a, { ok: true, rate: '5.1000', date: '2026-10-02', url: 'https://curs.bnr.ro/nbrfxrates.xml' });
  const b = await bnrRate({ currency: 'HUF', day: DAY, fetchImpl, cache, now: new Date(now.getTime() + 10 * 60_000) });
  assert.equal(b.rate, '0.013204');
  assert.equal(calls, 1, '30 dakika içinde BNR yeniden istenmez');
  await bnrRate({ currency: 'EUR', day: DAY, fetchImpl, cache, now: new Date(now.getTime() + 31 * 60_000) });
  assert.equal(calls, 2, 'süre dolunca yeniden alınır');

  assert.equal((await bnrRate({ currency: 'CHF', day: DAY, fetchImpl, cache: { at: 0, data: null }, now })).ok, false, 'dosyada olmayan para birimi');
  assert.equal((await bnrRate({ currency: 'EUR', day: '2026-10-01', fetchImpl, cache: { at: 0, data: null }, now })).ok, false, 'kaynak günü belge gününden sonra olamaz');
  assert.equal((await bnrRate({ currency: 'EUR', day: '2026-10-20', fetchImpl, cache: { at: 0, data: null }, now })).ok, false, 'çok eski kur kullanılmaz');

  // BNR dışı adres hiç istenmez; hata saklanır ve hemen yeniden denenmez
  let foreign = 0;
  const c2 = { at: 0, data: null };
  const bad = await fetchBnr({ urls: ['https://example.com/nbrfxrates.xml', 'http://curs.bnr.ro/nbrfxrates.xml'], fetchImpl: async () => { foreign += 1; return new Response(BNR_XML()); }, cache: c2, now });
  assert.equal(bad.ok, false);
  assert.equal(foreign, 0);
  let fails = 0;
  const c3 = { at: 0, data: null };
  const down = async () => { fails += 1; return new Response('no', { status: 503 }); };
  assert.deepEqual(await fetchBnr({ urls: ['https://curs.bnr.ro/nbrfxrates.xml'], fetchImpl: down, cache: c3, now }), { ok: false, error: 'HTTP 503' });
  assert.equal((await fetchBnr({ urls: ['https://curs.bnr.ro/nbrfxrates.xml'], fetchImpl: down, cache: c3, now: new Date(now.getTime() + 5000) })).ok, false);
  assert.equal(fails, 1, 'başarısız denemeden sonra bir dakika beklenir');
});

test('çözücü — BNR ve BNR + %: taban kur, yüzde, uygulanan kur, kaynak ve günü birlikte döner', async () => {
  const now = new Date('2026-10-03T09:30:00Z');
  const bnr = await resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BNR' }, day: DAY, now, bnrImpl: bnrOk(), rateImpl: never('BT') });
  assert.deepEqual(bnr, {
    policy: 'BNR', currency: 'EUR', baseRate: '5.1000', markupPercent: null, finalRate: '5.1000', rate: 5.1,
    source: 'BNR', sourceDate: '2026-10-02', resolvedAt: '2026-10-03T09:30:00.000Z', manual: false,
  });
  const zero = await resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '0' }, day: DAY, now, bnrImpl: bnrOk() });
  assert.equal(zero.finalRate, '5.1000');
  assert.equal(zero.markupPercent, '0.000');
  // Yüzde veritabanından Decimal nesnesi olarak gelir (toString)
  const two = await resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: { toString: () => '2' } }, day: DAY, now, bnrImpl: bnrOk() });
  assert.deepEqual([two.baseRate, two.markupPercent, two.finalRate, two.rate, two.source, two.sourceDate, two.manual], ['5.1000', '2.000', '5.2020', 5.202, 'BNR', '2026-10-02', false]);
  // Yüzdesi bozuk kayıt: kur uydurulmaz
  await assert.rejects(() => resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: null }, day: DAY, bnrImpl: bnrOk() }), (e) => e instanceof FxUnavailable && e.code === 'BAD_POLICY');
  await assert.rejects(() => resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'ECB' }, day: DAY, bnrImpl: bnrOk() }), (e) => e.code === 'BAD_POLICY');
});

test('çözücü — BNR alınamazsa elle girilmiş BT kuruna SESSİZCE düşülmez', async () => {
  const db = fakeDb({ day: DAY, rate: 5.44 });
  const down = async () => ({ ok: false, error: 'HTTP 503' });
  await assert.rejects(
    () => resolveExchangeRate(db, { customer: { fxPolicy: 'BNR' }, day: DAY, settings: { fxMode: 'auto', fxUrl: 'https://bt.example' }, bnrImpl: down, rateImpl: never('BT XML') }),
    (e) => e instanceof FxUnavailable && e.code === 'BNR_UNAVAILABLE',
  );
  const p = await previewExchangeRate(db, { customer: { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2' }, day: DAY, bnrImpl: down });
  assert.equal(p.ok, false);
  assert.equal(p.code, 'BNR_UNAVAILABLE');
});

test('çözücü — BT_UNIT_SELL: BT XML kuru ASLA kullanılmaz; yalnızca yöneticinin bugün girdiği BT kuru (ELLE)', async () => {
  // Ayar "otomatik" ve XML 5.3250 dönecek olsa bile okunmaz
  let xml = 0;
  const xmlRate = async () => { xml += 1; return { ok: true, rate: 5.325, source: 'https://dev.bancatransilvania.ro/exchange.xml' }; };
  const settings = { fxMode: 'auto', fxUrl: 'https://dev.bancatransilvania.ro/exchange.xml' };
  await assert.rejects(
    () => resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: DAY, settings, rateImpl: xmlRate, bnrImpl: never('BNR') }),
    (e) => e instanceof FxUnavailable && e.code === 'BT_MANUAL_REQUIRED',
    'bugünün kuru girilmediyse belge bekler',
  );
  // Dünün kuru bugün geçmez
  await assert.rejects(() => resolveExchangeRate(fakeDb({ day: '2026-10-02', rate: 5.4 }), { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: DAY, settings, rateImpl: xmlRate }), (e) => e.code === 'BT_MANUAL_REQUIRED');
  const r = await resolveExchangeRate(fakeDb({ day: DAY, rate: 5.4412 }), { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: DAY, settings, rateImpl: xmlRate, bnrImpl: never('BNR') });
  assert.deepEqual([r.policy, r.baseRate, r.finalRate, r.source, r.sourceDate, r.manual, r.markupPercent], ['BT_UNIT_SELL', '5.4412', '5.4412', 'MANUAL_DAY', DAY, true, null]);
  assert.equal(xml, 0, 'BT XML hiç istenmedi');
});

test('çözücü — elle kur her politikanın önüne geçer ve MANUAL diye işaretlenir; yüzde eklenmez', async () => {
  const r = await resolveExchangeRate(fakeDb({ day: DAY, rate: 5.4 }), { customer: { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2' }, day: DAY, manualRate: '5,3000', bnrImpl: never('BNR'), rateImpl: never('BT') });
  assert.deepEqual([r.policy, r.baseRate, r.markupPercent, r.finalRate, r.source, r.sourceDate, r.manual], ['BNR_PLUS_PERCENT', '5.3000', null, '5.3000', 'MANUAL', DAY, true]);
  const n = await resolveExchangeRate(fakeDb(), { customer: null, day: DAY, manualRate: 5.25, rateImpl: never('BT') });
  assert.deepEqual([n.policy, n.finalRate, n.source, n.manual], ['LEGACY', '5.2500', 'MANUAL', true]);
  await assert.rejects(() => resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BNR' }, day: DAY, manualRate: '55', bnrImpl: bnrOk() }), (e) => e.code === 'BAD_MANUAL', 'geçersiz elle kur yerine BNR kullanılmaz');
});

test('çözücü — politika seçilmemiş müşteri (eski kural): 7D-1 öncesi davranış aynen', async () => {
  // Elle mod: yöneticinin bugün girdiği BT kuru; BNR hiç istenmez
  const man = await resolveExchangeRate(fakeDb({ day: DAY, rate: 5 }), { customer: { fxPolicy: null }, day: DAY, settings: { fxMode: 'manual' }, rateImpl: never('BT'), bnrImpl: never('BNR') });
  assert.deepEqual([man.policy, man.finalRate, man.source, man.manual], ['LEGACY', '5.0000', 'MANUAL_DAY', true]);
  await assert.rejects(
    () => resolveExchangeRate(fakeDb(), { customer: {}, day: DAY, settings: { fxMode: 'manual' }, rateImpl: never('BT'), bnrImpl: never('BNR') }),
    (e) => e.code === 'LEGACY_UNAVAILABLE' && /Günün BT kuru girilmedi/.test(e.message),
  );
  // Otomatik mod (yönetici Entegrasyonlar'da öyle seçtiyse): eski BT adresi, önceki gibi
  const auto = await resolveExchangeRate(fakeDb(), { customer: null, day: DAY, settings: { fxMode: 'auto', fxUrl: 'https://bt.example' }, rateImpl: async ({ url }) => ({ ok: true, rate: 4.9765, source: url }), bnrImpl: never('BNR') });
  assert.deepEqual([auto.policy, auto.finalRate, auto.source, auto.manual], ['LEGACY', '4.9765', 'https://bt.example', false]);
});

test('kur kaydı: çözücünün döndürdüğü her alan saklanır; temizleme aynı alanları boşaltır', async () => {
  const fx = await resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2' }, day: DAY, now: new Date('2026-10-03T09:30:00Z'), bnrImpl: bnrOk() });
  const docDay = new Date('2026-10-03T00:00:00Z');
  const snap = fxSnapshot(fx, docDay);
  assert.deepEqual(snap, {
    fxRate: '5.2020', fxDate: docDay, fxSource: 'BNR', fxPolicy: 'BNR_PLUS_PERCENT', fxCurrency: 'EUR', fxBaseRate: '5.1000', fxMarkupPercent: '2.000',
    fxSourceDate: new Date('2026-10-02T00:00:00Z'), fxResolvedAt: new Date('2026-10-03T09:30:00Z'), fxManual: false,
  });
  assert.deepEqual(Object.keys(FX_SNAPSHOT_CLEAR).sort(), Object.keys(snap).sort());
});
