// Müşteri kur politikası (Aşama 7D-1): ondalık hesap, BNR okuma, tek çözücü. Ağa çıkılmaz; FGO'ya hiçbir şey gönderilmez.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMarkup, padRate } from '../server/fx/decimal.js';
import { bnrRate, fetchBnr, parseBnr } from '../server/fx/bnr.js';
import { FX_SNAPSHOT_CLEAR, FxUnavailable, fxDocumentText, fxSnapshot, manualExchangeRate, offerNotePolicy, parseFxPolicy, parseMarkupPercent, previewExchangeRate, resolveExchangeRate, trimPercent } from '../server/fx/resolve.js';
import * as bt from '../server/fx/bt.js';
import { FGO_DEFAULTS } from '../server/integrations/fgo.js';

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

  assert.deepEqual(parseFxPolicy({ policy: '', percent: '5' }), { ok: false, code: 'BAD_POLICY' }, 'politika zorunlu: "seçilmedi" diye bir durum yok');
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
  const bnr = await resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BNR' }, day: DAY, now, bnrImpl: bnrOk() });
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
    () => resolveExchangeRate(db, { customer: { fxPolicy: 'BNR' }, day: DAY, bnrImpl: down }),
    (e) => e instanceof FxUnavailable && e.code === 'BNR_UNAVAILABLE',
  );
  const p = await previewExchangeRate(db, { customer: { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2' }, day: DAY, bnrImpl: down });
  assert.equal(p.ok, false);
  assert.equal(p.code, 'BNR_UNAVAILABLE');
});

test('çözücü — BT_UNIT_SELL: yalnızca yöneticinin bugün girdiği BT kuru (ELLE); BT XML belge kuru olamaz', async () => {
  await assert.rejects(
    () => resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: DAY, bnrImpl: never('BNR') }),
    (e) => e instanceof FxUnavailable && e.code === 'BT_MANUAL_REQUIRED',
    'bugünün kuru girilmediyse belge bekler',
  );
  // Dünün kuru bugün geçmez
  await assert.rejects(() => resolveExchangeRate(fakeDb({ day: '2026-10-02', rate: 5.4 }), { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: DAY }), (e) => e.code === 'BT_MANUAL_REQUIRED');
  const r = await resolveExchangeRate(fakeDb({ day: DAY, rate: 5.4412 }), { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: DAY, bnrImpl: never('BNR') });
  assert.deepEqual([r.policy, r.baseRate, r.finalRate, r.source, r.sourceDate, r.manual, r.markupPercent], ['BT_UNIT_SELL', '5.4412', '5.4412', 'MANUAL_DAY', DAY, true, null]);
  // XML kuru verecek bir okuyucu çözücüye verilse bile yok sayılır: çözücünün BT XML'ine giden bir yolu yok
  let xml = 0;
  const xmlRate = async () => { xml += 1; return { ok: true, rate: 5.325, source: 'https://dev.bancatransilvania.ro/exchange.xml' }; };
  await assert.rejects(() => resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BT_UNIT_SELL' }, day: DAY, rateImpl: xmlRate, settings: { fxMode: 'auto', fxUrl: 'https://dev.bancatransilvania.ro/exchange.xml' } }), (e) => e.code === 'BT_MANUAL_REQUIRED');
  assert.equal(xml, 0, 'BT XML hiç istenmedi');
  assert.equal(typeof bt.rateForDay, 'undefined', 'XML\'e düşen eski kur seçimi kaldırıldı');
  assert.ok(!('fxMode' in FGO_DEFAULTS) && !('fxUrl' in FGO_DEFAULTS), 'FGO ayarında kur kaynağı yok');
});

test('çözücü — elle kur her politikanın önüne geçer ve MANUAL diye işaretlenir; yüzde eklenmez', async () => {
  const r = await resolveExchangeRate(fakeDb({ day: DAY, rate: 5.4 }), { customer: { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2' }, day: DAY, manualRate: '5,3000', bnrImpl: never('BNR') });
  assert.deepEqual([r.policy, r.baseRate, r.markupPercent, r.finalRate, r.source, r.sourceDate, r.manual], ['BNR_PLUS_PERCENT', '5.3000', null, '5.3000', 'MANUAL', DAY, true]);
  const n = manualExchangeRate({ customer: { fxPolicy: 'BT_UNIT_SELL' }, manualRate: 5.25, day: DAY });
  assert.deepEqual([n.policy, n.finalRate, n.rate, n.source, n.manual], ['BT_UNIT_SELL', '5.2500', 5.25, 'MANUAL', true]);
  await assert.rejects(() => resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BNR' }, day: DAY, manualRate: '55', bnrImpl: bnrOk() }), (e) => e.code === 'BAD_MANUAL', 'geçersiz elle kur yerine BNR kullanılmaz');
});

test('çözücü — politikası olmayan müşteri için kur çözülmez (eski / varsayılan kur yolu yok)', async () => {
  for (const customer of [null, {}, { fxPolicy: null }, { fxPolicy: 'LEGACY' }]) {
    await assert.rejects(() => resolveExchangeRate(fakeDb({ day: DAY, rate: 5 }), { customer, day: DAY, bnrImpl: bnrOk() }), (e) => e instanceof FxUnavailable && e.code === 'BAD_POLICY');
    assert.throws(() => manualExchangeRate({ customer, manualRate: 5.2, day: DAY }), (e) => e.code === 'BAD_POLICY');
  }
});

test('BNR kuralı: BNR\'nin yayımladığı son kur — cumartesi çözülen kur cuma kurudur ve kaynak günü cuma saklanır', async () => {
  // 03.10.2026 cumartesi; BNR'nin dosyasındaki son gün 02.10.2026 cuma. İş günü takvimi tutulmaz.
  const fetchImpl = async () => new Response(BNR_XML('2026-10-02', '5.3447'));
  const sat = new Date('2026-10-03T10:00:00Z');
  const bnrImpl = (o) => bnrRate({ ...o, fetchImpl, cache: { at: 0, data: null } });
  const r = await resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BNR' }, day: '2026-10-03', now: sat, bnrImpl });
  assert.deepEqual([r.finalRate, r.source, r.sourceDate], ['5.3447', 'BNR', '2026-10-02']);
  // Pazartesi, BNR yeni kur yayımlamadan önce: hâlâ cuma kuru
  const mon = await resolveExchangeRate(fakeDb(), { customer: { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2.5' }, day: '2026-10-05', now: new Date('2026-10-05T07:00:00Z'), bnrImpl });
  assert.deepEqual([mon.baseRate, mon.finalRate, mon.sourceDate], ['5.3447', '5.4783', '2026-10-02']);
  assert.equal(fxSnapshot(r, new Date('2026-10-03T00:00:00Z')).fxSourceDate.toISOString().slice(0, 10), '2026-10-02', 'kayıtta BNR\'nin gerçek kaynak günü');
});

test('FGO belge açıklaması: politika → cümle; yüzde ve taban kur müşteri belgesine yazılmaz; yazılan kur kayıttaki uygulanan kurdur', async () => {
  const docDay = new Date('2026-10-03T00:00:00Z');
  const snapOf = async (customer, o = {}) => fxSnapshot(await resolveExchangeRate(fakeDb({ day: DAY, rate: 5.4412 }), { customer, day: DAY, bnrImpl: bnrOk('5.3447', '2026-10-02'), ...o }), docDay);
  assert.equal(fxDocumentText(await snapOf({ fxPolicy: 'BT_UNIT_SELL' })), 'Curs de vânzare BT: 5.4412 RON/EUR');
  assert.equal(fxDocumentText(await snapOf({ fxPolicy: 'BNR' })), 'Curs BNR: 5.3447 RON/EUR (data 02.10.2026)', 'BNR: kaynak günü');
  const plus = await snapOf({ fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2.5' });
  assert.equal(fxDocumentText(plus), 'Curs de schimb aplicat: 5.4783 RON/EUR');
  assert.equal(plus.fxRate, '5.4783', 'uygulanan kur kayıtta');
  assert.deepEqual([plus.fxBaseRate, plus.fxMarkupPercent], ['5.3447', '2.500'], 'taban kur ve yüzde yalnızca kayıtta (yönetici ekranı)');
  for (const text of [fxDocumentText(plus)]) assert.ok(!/BNR|2[.,]5|%|5\.3447/.test(text), 'belgede BNR, yüzde ya da taban kur geçmez');
  // Elle kur: hangi politika olursa olsun "uygulanan kur"
  for (const customer of [{ fxPolicy: 'BT_UNIT_SELL' }, { fxPolicy: 'BNR' }, { fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: '2' }]) {
    assert.equal(fxDocumentText(await snapOf(customer, { manualRate: '5,3000' })), 'Curs de schimb aplicat: 5.3000 RON/EUR');
  }
  // Veritabanından okunan kayıt (Decimal / Date) ve politikası kayıtlı olmayan eski kayıt
  assert.equal(fxDocumentText({ fxRate: { toString: () => '5.3447' }, fxPolicy: 'BNR', fxSource: 'BNR', fxCurrency: 'EUR', fxSourceDate: new Date('2026-10-02T00:00:00Z'), fxDate: docDay }), 'Curs BNR: 5.3447 RON/EUR (data 02.10.2026)');
  assert.equal(fxDocumentText({ fxRate: '4.98', fxSource: 'MANUAL' }), 'Curs de schimb aplicat: 4.9800 RON/EUR');
});

test('teklif notu: politika → metin türü; BNR + % müşteriye yalnızca "sözleşme kuru" (yüzde yok)', async () => {
  assert.equal(offerNotePolicy('BT_UNIT_SELL'), 'BT_UNIT_SELL');
  assert.equal(offerNotePolicy('BNR'), 'BNR');
  assert.equal(offerNotePolicy('BNR_PLUS_PERCENT'), 'BNR_PLUS_PERCENT');
  assert.equal(offerNotePolicy(undefined), 'BNR_PLUS_PERCENT', 'bilinmeyen: nötr metin');
  const ro = (await import('../server/i18n/ro/fx.js')).default.offerNote;
  const tr = (await import('../server/i18n/tr/fx.js')).default.offerNote;
  assert.equal(ro.BT_UNIT_SELL, 'Conversia în RON se va efectua la cursul de vânzare BT aplicabil la data emiterii documentului fiscal.');
  assert.equal(ro.BNR, 'Conversia în RON se va efectua la cursul BNR aplicabil la data emiterii documentului fiscal.');
  assert.equal(ro.BNR_PLUS_PERCENT, 'Conversia în RON se va efectua la cursul de schimb contractual aplicabil la data emiterii documentului fiscal.');
  for (const d of [ro, tr]) {
    assert.deepEqual(Object.keys(d), ['BT_UNIT_SELL', 'BNR', 'BNR_PLUS_PERCENT']);
    assert.ok(!/BNR|%|\d/.test(d.BNR_PLUS_PERCENT), 'BNR + % notunda BNR, yüzde ya da sayı geçmez');
    for (const v of Object.values(d)) assert.ok(!/Transilvania/.test(v));
  }
  // Eski sabit metin ("Banca Transilvania satış kuru") hiçbir sözlükte kalmadı
  for (const l of ['ro', 'tr']) {
    const all = JSON.stringify((await import(`../server/i18n/${l}/index.js`)).default);
    assert.ok(!/Băncii Transilvania|Banca Transilvania satış/.test(all), l);
  }
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
