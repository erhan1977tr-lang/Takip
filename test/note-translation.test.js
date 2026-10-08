// Not çevirisi (karar 127) — saf kurallar ve Google sağlayıcısı. Gerçek Google'a istek GİTMEZ: sağlayıcı yalnızca
// sahte fetchImpl ile çağrılır ve dosya boyunca global fetch kapalıdır (çağrılırsa test düşer).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAKE_FAIL_MARK, FAKE_SAME_MARK, GOOGLE_TRANSLATE_URL, TRANSLATE_ERRORS, TRANSLATION_MAX, TranslateError, fakeTranslate, fakeTranslateOn,
  googleErrorCode, googleTranslate, safeDetail, translatorFor,
} from '../server/notes/provider.js';
import {
  canRetryTranslation, noteView, notesFor, parseTranslateKey, translateReady, translationState, translationTarget, STALE_PENDING_MS,
} from '../server/notes/translation.js';
import { translate } from '../server/i18n/index.js';
import { validateEnv } from '../server/env.js';

const KEY = 'AIzaSyTESTONLY-not-a-real-key-0123456789';
const realFetch = globalThis.fetch;
let leaked = 0;
before(() => {
  globalThis.fetch = async () => {
    leaked += 1;
    throw new Error('test: gerçek ağ isteği yapılmamalı');
  };
});
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(leaked, 0, 'hiçbir test gerçek ağa çıkmadı');
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const okBody = (text) => ({ data: { translations: [{ translatedText: text, detectedSourceLanguage: 'ro' }] } });
const codeOf = async (p) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof TranslateError, `TranslateError bekleniyordu: ${e}`);
    return e.code;
  }
  return 'OK';
};

test('yön yazanın rolünden: müşteri → Türkçe; yönetici / satış / çizim → Romence; not yazamayan rol → çeviri yok', () => {
  assert.deepEqual(['MUSTERI', 'ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI', '', null, undefined, 'BILINMEYEN'].map(translationTarget), ['tr', 'ro', 'ro', 'ro', null, null, null, null, null]);
});

test('Google isteği: anahtar yalnızca başlıkta (adreste / gövdede yok), hedef dil çağırandan, kaynak dil gönderilmez, format text', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return json(200, okBody('Lütfen ölçüyü 1200 mm olarak değiştirin'));
  };
  const text = '  Vă rog să modificați dimensiunea la 1200 mm\n<b>urgent</b> & "important"  ';
  const r = await googleTranslate({ text, target: 'tr', key: KEY, fetchImpl });
  assert.deepEqual(r, { text: 'Lütfen ölçüyü 1200 mm olarak değiştirin' });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, GOOGLE_TRANSLATE_URL);
  assert.equal(url, 'https://translation.googleapis.com/language/translate/v2');
  assert.ok(!url.includes(KEY) && !url.includes('key='), 'anahtar adreste yok');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-Goog-Api-Key'], KEY);
  assert.ok(!String(init.body).includes(KEY), 'anahtar gövdede yok');
  assert.deepEqual(JSON.parse(init.body), { q: text, target: 'tr', format: 'text' }, 'metin olduğu gibi gider; kaynak dil yok');
  assert.ok(init.signal instanceof AbortSignal);
  // Romence hedef
  await googleTranslate({ text: 'Teklifiniz hazır', target: 'ro', key: KEY, fetchImpl });
  assert.equal(JSON.parse(calls[1].init.body).target, 'ro');
});

test('Google hataları güvenli koda çevrilir: anahtar / yetki, kota, sunucu, zaman aşımı, ağ, bozuk yanıt', async () => {
  const run = (res) => codeOf(googleTranslate({ text: 'a', target: 'tr', key: KEY, fetchImpl: async () => res }));
  const err = (code, message, extra = {}) => ({ error: { code, message, ...extra } });
  assert.equal(await run(json(400, err(400, 'API key not valid. Please pass a valid API key.', { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] }))), 'AUTH');
  assert.equal(await run(json(403, err(403, 'Cloud Translation API has not been used in project 1 before or it is disabled.', { status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] }))), 'AUTH');
  assert.equal(await run(json(403, err(403, 'Requests from this IP are blocked.', { errors: [{ reason: 'forbidden' }] }))), 'AUTH');
  assert.equal(await run(json(401, err(401, 'Request had invalid authentication credentials.'))), 'AUTH');
  assert.equal(await run(json(403, err(403, 'Daily Limit Exceeded', { errors: [{ reason: 'dailyLimitExceeded' }] }))), 'QUOTA');
  assert.equal(await run(json(403, err(403, 'User Rate Limit Exceeded', { errors: [{ reason: 'userRateLimitExceeded' }] }))), 'QUOTA');
  assert.equal(await run(json(429, err(429, 'Quota exceeded', { status: 'RESOURCE_EXHAUSTED' }))), 'QUOTA');
  assert.equal(await run(json(400, err(400, 'Invalid Value', { errors: [{ reason: 'invalid' }] }))), 'BAD_REQUEST');
  assert.equal(await run(json(500, err(500, 'Internal error'))), 'SERVER');
  assert.equal(await run(json(503, { not: 'json error' })), 'SERVER');
  assert.equal(await run(new Response('<html>bad gateway</html>', { status: 502 })), 'SERVER');
  assert.equal(await run(json(404, err(404, 'Not found'))), 'HTTP');
  // Yanıt biçimi beklenen gibi değil
  for (const body of [{}, { data: {} }, { data: { translations: [] } }, { data: { translations: [{ translatedText: '   ' }] } }, { data: { translations: [{ translatedText: 5 }] } }]) {
    assert.equal(await run(json(200, body)), 'BAD_RESPONSE');
  }
  assert.equal(await run(new Response('düz metin', { status: 200 })), 'BAD_RESPONSE');
  // Ağ / zaman aşımı
  assert.equal(await codeOf(googleTranslate({ text: 'a', target: 'tr', key: KEY, fetchImpl: async () => { throw new TypeError('fetch failed'); } })), 'NETWORK');
  assert.equal(await codeOf(googleTranslate({ text: 'a', target: 'tr', key: KEY, fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } })), 'TIMEOUT');
  const t0 = Date.now();
  assert.equal(await codeOf(googleTranslate({ text: 'a', target: 'tr', key: KEY, timeoutMs: 30, fetchImpl: () => new Promise(() => {}) })), 'TIMEOUT');
  assert.ok(Date.now() - t0 < 2000, 'yanıt gelmezse çağrı beklemede kalmaz');
  // Anahtar yoksa Google'a hiç gidilmez
  let called = 0;
  assert.equal(await codeOf(googleTranslate({ text: 'a', target: 'tr', key: '', fetchImpl: async () => { called += 1; return json(200, okBody('x')); } })), 'NO_KEY');
  assert.equal(called, 0);
  // Bilinmeyen kod güvenli genel koda iner; kod listesi dışına çıkılmaz
  assert.equal(new TranslateError('UYDURMA').code, 'ERROR');
  for (const c of [googleErrorCode(418, null), googleErrorCode(403, { error: 'metin' }), googleErrorCode(200, undefined)]) assert.ok(TRANSLATE_ERRORS.includes(c), c);
});

test('anahtar hiçbir hata metninde / ayrıntısında yer almaz; Google yanıtı kısaltılır', async () => {
  const echo = `API key ${KEY} is not valid.\nProject: 1234567890 ${'x'.repeat(600)}`;
  let e;
  try {
    await googleTranslate({ text: 'a', target: 'tr', key: KEY, fetchImpl: async () => json(400, { error: { code: 400, message: echo, details: [{ reason: 'API_KEY_INVALID' }] } }) });
  } catch (x) {
    e = x;
  }
  assert.ok(e instanceof TranslateError);
  assert.equal(e.code, 'AUTH');
  for (const s of [e.message, e.detail, String(e), JSON.stringify(e), e.stack]) assert.ok(!String(s).includes(KEY), 'anahtar sızmadı');
  assert.ok(e.detail.includes('***') && e.detail.length <= 200 && !e.detail.includes('\n'));
  assert.equal(e.message, 'çeviri yapılamadı: AUTH', 'hata iletisi yalnızca güvenli koddur');
  // Başka bir anahtar biçimi de ayıklanır (yanıtta farklı bir anahtar geçse bile)
  assert.equal(safeDetail('key=AIzaSyOTHERKEY0123456789abcdef bad', KEY), 'key=*** bad');
  assert.equal(safeDetail(null, KEY), '');
  // Çok uzun çeviri saklanacak sınıra kısaltılır
  const long = await googleTranslate({ text: 'a', target: 'tr', key: KEY, fetchImpl: async () => json(200, okBody('ç'.repeat(TRANSLATION_MAX + 500))) });
  assert.equal(long.text.length, TRANSLATION_MAX);
});

test('sahte sağlayıcı (TRANSLATE_FAKE=1): ağa çıkmaz, belirlenimli; yalnızca ortam değişkeniyle seçilir', async () => {
  assert.deepEqual(await fakeTranslate({ text: 'Bună ziua', target: 'tr', key: KEY }), { text: '[tr] Bună ziua' });
  assert.deepEqual(await fakeTranslate({ text: 'Merhaba', target: 'ro' }), { text: '[ro] Merhaba' });
  assert.equal(await codeOf(fakeTranslate({ text: `not ${FAKE_FAIL_MARK}`, target: 'tr' })), 'TIMEOUT');
  assert.deepEqual(await fakeTranslate({ text: `tamam ${FAKE_SAME_MARK}`, target: 'tr' }), { text: `tamam ${FAKE_SAME_MARK}` });
  assert.equal(translatorFor({ TRANSLATE_FAKE: true }), fakeTranslate);
  assert.equal(translatorFor({ TRANSLATE_FAKE: false }), googleTranslate);
  assert.equal(translatorFor({}), googleTranslate, 'ayar yoksa gerçek sağlayıcı');
  assert.deepEqual([fakeTranslateOn({ TRANSLATE_FAKE: true }), fakeTranslateOn({ TRANSLATE_FAKE: 'true' }), fakeTranslateOn({})], [true, false, false]);
  // Ortam: yalnızca 0 / 1; üretimde açıksa uyarı
  const base = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgresql://a:b@localhost:5432/x' };
  assert.equal(validateEnv(base).values.TRANSLATE_FAKE, false);
  assert.equal(validateEnv({ ...base, TRANSLATE_FAKE: '1' }).values.TRANSLATE_FAKE, true);
  assert.ok(validateEnv({ ...base, TRANSLATE_FAKE: 'evet' }).errors.some((x) => x.name === 'TRANSLATE_FAKE'));
  assert.ok(validateEnv({ ...base, TRANSLATE_FAKE: '1', NODE_ENV: 'production' }).warnings.some((x) => x.name === 'TRANSLATE_FAKE'));
  assert.ok(!validateEnv({ ...base, NODE_ENV: 'production' }).warnings.some((x) => x.name === 'TRANSLATE_FAKE'));
});

test('anahtar girişi: boş = değiştirme; boşluksuz 20–200 karakter; ayar hazır = açık + anahtar kayıtlı', () => {
  assert.deepEqual(parseTranslateKey(''), { ok: true, key: '' });
  assert.deepEqual(parseTranslateKey(null), { ok: true, key: '' });
  assert.deepEqual(parseTranslateKey(`  ${KEY}  `), { ok: true, key: KEY });
  for (const bad of ['kisa', 'a'.repeat(19), 'a'.repeat(201), `${'a'.repeat(15)} ${'b'.repeat(15)}`, `${'a'.repeat(25)}ş`, `${'a'.repeat(25)}\n${'b'.repeat(5)}`]) {
    assert.deepEqual(parseTranslateKey(bad), { ok: false }, JSON.stringify(bad));
  }
  assert.deepEqual([
    translateReady({ enabled: true, hasKey: true }), translateReady({ enabled: true, keySealed: 'v1:..' }), translateReady({ enabled: true, hasKey: false }),
    translateReady({ enabled: false, hasKey: true }), translateReady(null), translateReady({}),
  ], [true, true, false, false, false, false]);
});

const note = (o = {}) => ({ id: 'n', text: 'özgün', internal: false, translation: null, translationLang: null, translationStatus: null, translationError: null, translationAt: null, ...o });
const AT = new Date('2026-10-04T10:00:00Z');
const fields = (n) => [n.translation, n.translationLang, n.translationStatus, n.translationError, n.translationAt];

test('görünürlük: çeviri notun görünürlüğünü aşamaz — iç not çevirisi kimseye gitmez; müşteriye yalnızca tamamlanmış Romence çeviri; iç ekibe yalnızca müşteri notunun Türkçesi; denetimci yalnızca özgün notu görür', () => {
  const done = (lang, o = {}) => note({ translation: `[${lang}] çeviri`, translationLang: lang, translationStatus: 'DONE', translationAt: AT, ...o });
  const failed = note({ translationLang: 'ro', translationStatus: 'FAILED', translationError: 'QUOTA', translationAt: AT });
  const pending = note({ translationLang: 'ro', translationStatus: 'PENDING', translationAt: AT });
  const same = note({ translationLang: 'ro', translationStatus: 'SAME', translationAt: AT });
  const STAFF = ['ADMIN', 'SATIS', 'CIZIM'];

  // Yönetici, satış, çizim (karar 130): müşteri notunun Türkçe çevirisi + durum + güvenli hata kodu. İç ekibin KENDİ
  // notunun Romence çevirisi müşteri içindir: tamamlanmış çeviri iç ekibe hiç dönmez (not yalnızca özgün dilinde);
  // süren / başarısız çevirinin durumu döner — çevrilemeyen not "yeniden dene" ile istenebilsin diye.
  for (const role of STAFF) {
    assert.deepEqual(fields(noteView(role, done('tr'))), ['[tr] çeviri', 'tr', 'DONE', null, AT], role);
    for (const own of [done('ro'), same]) {
      const v = noteView(role, own);
      assert.deepEqual(fields(v), [null, null, null, null, null], role);
      assert.deepEqual([v.id, v.text, v.internal], ['n', 'özgün', false], 'özgün not aynen');
      assert.equal(translationState(v, AT), null, 'ekranda çeviri / durum çizilecek bir şey yok');
    }
    assert.deepEqual(fields(noteView(role, failed)), [null, 'ro', 'FAILED', 'QUOTA', AT], role);
    assert.deepEqual(translationState(noteView(role, failed), AT), { state: 'failed', code: 'QUOTA' }, 'başarısız çeviri yeniden istenebilir');
    assert.deepEqual(fields(noteView(role, pending)), [null, 'ro', 'PENDING', null, AT], role);
    // Müşteri notunun süren / başarısız / "aynı" çevirisi: metin yok, durum var (değişmedi)
    assert.deepEqual(fields(noteView(role, note({ translationLang: 'tr', translationStatus: 'FAILED', translationError: 'TIMEOUT', translationAt: AT }))), [null, 'tr', 'FAILED', 'TIMEOUT', AT], role);
    assert.deepEqual(fields(noteView(role, note({ translationLang: 'tr', translationStatus: 'SAME', translationAt: AT }))), [null, 'tr', 'SAME', null, AT], role);
  }
  // Müşteri: iç ekibin notunun Romencesi gider; kendi notunun Türkçesi, hata kodu, bekleme / "aynı" durumu gitmez
  assert.deepEqual(fields(noteView('MUSTERI', done('ro'))), ['[ro] çeviri', 'ro', 'DONE', null, AT]);
  for (const n of [done('tr'), failed, pending, same, done('ro', { translation: null }), done('ro', { translation: '' })]) {
    assert.deepEqual(fields(noteView('MUSTERI', n)), [null, null, null, null, null]);
  }
  // Denetimci (karar 128): notu görür ama YALNIZCA özgün dilinde — saklanan çeviri, çeviri durumu / hatası hiç gitmez
  for (const n of [done('tr'), done('ro'), failed, pending, same]) {
    const v = noteView('DENETIMCI', n);
    assert.deepEqual(fields(v), [null, null, null, null, null]);
    assert.deepEqual([v.id, v.text, v.internal], ['n', 'özgün', false], 'özgün not aynen');
    assert.equal(translationState(v, AT), null, 'ekranda çeviri durumu / "yeniden dene" çizilecek bir şey yok');
  }
  // Rolü olmayan / tanımsız rol: en dar görünüm (çeviri alanı yok)
  for (const role of [null, undefined, '', 'BILINMEYEN']) for (const n of [done('ro'), done('tr'), failed]) assert.deepEqual(fields(noteView(role, n)), [null, null, null, null, null]);
  // Özgün metin ve öbür alanlar hiçbir görünümde değişmez
  for (const role of [...STAFF, 'MUSTERI', 'DENETIMCI']) assert.deepEqual([noteView(role, done('ro')).text, noteView(role, done('ro')).id], ['özgün', 'n']);

  // İç not: yanlışlıkla çeviri alanı yazılmış olsa bile hiçbir role çeviri dönmez; müşteriye not da dönmez
  const leaky = done('ro', { id: 'ic', internal: true, text: 'iç: fiyat gizli' });
  for (const role of [...STAFF, 'MUSTERI', 'DENETIMCI']) assert.deepEqual(fields(noteView(role, leaky)), [null, null, null, null, null], role);
  const all = [done('tr', { id: 'm' }), done('ro', { id: 's' }), leaky, failed];
  assert.deepEqual(notesFor('MUSTERI', all).map((n) => [n.id, n.translation]), [['m', null], ['s', '[ro] çeviri'], ['n', null]]);
  assert.ok(!JSON.stringify(notesFor('MUSTERI', all)).includes('fiyat gizli'));
  assert.ok(!JSON.stringify(notesFor('MUSTERI', all)).includes('QUOTA'));
  assert.deepEqual(notesFor('SATIS', all).map((n) => [n.id, n.internal, n.translation]), [['m', false, '[tr] çeviri'], ['s', false, null], ['ic', true, null], ['n', false, null]]);
  for (const role of STAFF) assert.ok(!JSON.stringify(notesFor(role, all)).includes('[ro] çeviri'), `${role}: Romence çeviri iç ekibe gitmez`);
  // Aynı not, üç bakış: müşteri özgün + Romence · iç ekip yalnızca özgün · denetimci yalnızca özgün
  assert.deepEqual(['MUSTERI', 'ADMIN', 'SATIS', 'CIZIM', 'DENETIMCI'].map((role) => noteView(role, done('ro')).translation), ['[ro] çeviri', null, null, null, null]);
  // Müşterinin notu, üç bakış: iç ekip özgün + Türkçe · müşteri yalnızca özgün · denetimci yalnızca özgün
  assert.deepEqual(['ADMIN', 'SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI'].map((role) => noteView(role, done('tr')).translation), ['[tr] çeviri', '[tr] çeviri', '[tr] çeviri', null, null]);
  // Denetimcinin nota erişimi DEĞİŞMEDİ (iç notlar dahil hepsini görür); yalnızca çeviri alanları gelmez
  const forInspector = notesFor('DENETIMCI', all);
  assert.deepEqual(forInspector.map((n) => [n.id, n.internal, n.text]), [['m', false, 'özgün'], ['s', false, 'özgün'], ['ic', true, 'iç: fiyat gizli'], ['n', false, 'özgün']]);
  assert.ok(forInspector.every((n) => fields(n).every((x) => x === null)));
  for (const leak of ['çeviri', 'QUOTA', 'FAILED', 'DONE']) assert.ok(!JSON.stringify(forInspector.map(fields)).includes(leak), leak);
  // Girdi nesneleri değiştirilmez
  assert.equal(leaky.translation, '[ro] çeviri');
});

test('çeviri durumu (iç ekip ekranı) ve yeniden deneme yetkisi', () => {
  const at = (ms) => new Date(AT.getTime() - ms);
  assert.equal(translationState(note(), AT), null, 'çevirisiz / eski not');
  assert.equal(translationState(note({ internal: true, translationStatus: 'DONE' }), AT), null);
  assert.deepEqual(translationState(note({ translationStatus: 'DONE' }), AT), { state: 'done', code: null });
  assert.deepEqual(translationState(note({ translationStatus: 'SAME' }), AT), { state: 'same', code: null });
  assert.deepEqual(translationState(note({ translationStatus: 'FAILED', translationError: 'AUTH' }), AT), { state: 'failed', code: 'AUTH' });
  assert.deepEqual(translationState(note({ translationStatus: 'FAILED' }), AT), { state: 'failed', code: 'ERROR' });
  assert.deepEqual(translationState(note({ translationStatus: 'PENDING', translationAt: at(1000) }), AT), { state: 'pending', code: null });
  assert.deepEqual(translationState(note({ translationStatus: 'PENDING', translationAt: at(STALE_PENDING_MS + 1) }), AT), { state: 'failed', code: 'INTERRUPTED' }, 'yarıda kalan çeviri');
  assert.deepEqual(translationState(note({ translationStatus: 'PENDING', translationAt: at(STALE_PENDING_MS + 1).toISOString() }), AT), { state: 'failed', code: 'INTERRUPTED' });
  assert.deepEqual(['ADMIN', 'SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI', null].map(canRetryTranslation), [true, true, true, false, false, false]);
});

test('etiketler: çevirinin dilinde ve sabit; her hata kodunun iki dilde metni var', () => {
  assert.equal(translate('tr', 'order.notes.translatedLabel'), 'Türkçe · otomatik çevrilmiştir');
  assert.equal(translate('ro', 'order.notes.translatedLabel'), 'Română · tradus automat');
  assert.equal(translate('ro', 'order.notes.original'), 'Mesaj original');
  assert.equal(translate('tr', 'order.notes.original'), 'Özgün mesaj');
  for (const code of TRANSLATE_ERRORS) {
    for (const locale of ['tr', 'ro']) {
      const key = `order.notes.translation.reason.${code}`;
      assert.notEqual(translate(locale, key), key, `${locale} ${code}`);
    }
  }
  assert.equal(translate('tr', 'admin.integrations.translate.title'), 'Not çevirisi');
});

// ---------- Sayfa açılışı / yenileme / otomatik yenileme / işçi çeviri isteği YAPAMAZ (karar 128) ----------
// Davranış testleri (veritabanı + tarayıcı) sağlayıcının çağrılmadığını sayar; buradaki testler bunun YAPISAL nedenini
// sabitler: sağlayıcıyı çağıran kod yalnızca üç işlevdedir ve bunları yalnızca iki sunucu işlemi (form gönderimi) çağırır.
const { default: fsSync } = await import('node:fs');
const { default: pathMod } = await import('node:path');
const ROOT = pathMod.resolve(pathMod.dirname(new URL(import.meta.url).pathname), '..');
function sources(dirs, exts = ['.js', '.mjs', '.ts', '.tsx']) {
  const out = [];
  const walk = (dir) => {
    for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = pathMod.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
    }
  };
  for (const d of dirs) walk(pathMod.join(ROOT, d));
  return out.map((f) => ({ file: pathMod.relative(ROOT, f).split(pathMod.sep).join('/'), text: fsSync.readFileSync(f, 'utf8') }));
}
const APP = sources(['app', 'lib', 'server', 'scripts', 'components']);
const filesWith = (re) => APP.filter((s) => re.test(s.text)).map((s) => s.file).sort();

test('sağlayıcıyı (Google) yükleyen tek kod çeviri servisidir; sipariş sayfası yalnızca saf kuralları yükler', () => {
  // server/notes/provider.js'i içe aktaranlar: çeviri servisi ve Entegrasyonlar sayfası (yalnızca "test modu" uyarısı için)
  assert.deepEqual(filesWith(/from\s+['"][^'"]*notes\/provider(\.js)?['"]|from\s+['"]\.\/provider\.js['"]/), ['app/(panel)/admin/entegrasyonlar/page.tsx', 'server/notes/translation.js']);
  // Sağlayıcı işlevlerinin adı başka hiçbir dosyada geçmez
  assert.deepEqual(filesWith(/\b(googleTranslate|fakeTranslate|translatorFor)\s*\(/), ['server/notes/provider.js', 'server/notes/translation.js']);
  // Saf kurallar dosyası yalnızca yetki matrisini yükler: ağ, ortam, veritabanı, sağlayıcı yok
  const view = APP.find((s) => s.file === 'server/notes/view.js').text;
  assert.deepEqual([...view.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['../auth/permissions.js']);
  assert.ok(!/\bfetch\s*\(|provider|translation\.js|getEnv|process\.env/.test(view.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  // Sipariş sayfası ve sipariş yükleyici (her sayfa açılışında / otomatik yenilemede çalışan yol) yalnızca view.js'i yükler
  for (const file of ['app/(panel)/siparisler/[id]/page.tsx', 'lib/orders.ts']) {
    const text = APP.find((s) => s.file === file).text;
    assert.match(text, /notes\/view\.js'/, file);
    assert.ok(!/notes\/(translation|provider)(\.js)?'/.test(text), `${file}: çeviri servisi / sağlayıcı yüklenmez`);
  }
});

test('çeviri isteyen işlevler yalnızca iki sunucu işleminden çağrılır: yeni not, yeni revizyon talebi (karar 163) ve açık "yeniden dene" (+ yöneticinin bağlantı denemesi); işçi ve öbür sunucu kodu çağırmaz', () => {
  // Sağlayıcı çeviri servisinde yalnızca dört yerde seçilir (addNote, retryNoteTranslation, translateRevision,
  // testTranslation) ve yalnızca runTranslation / testTranslation içinde çağrılır
  const svc = APP.find((s) => s.file === 'server/notes/translation.js').text;
  assert.equal((svc.match(/translatorFor\(\)/g) ?? []).length, 4);
  assert.equal((svc.match(/await translator\(|await \(translator \?\? translatorFor\(\)\)\(/g) ?? []).length, 2);
  assert.equal((svc.match(/await runTranslation\(db, note, /g) ?? []).length, 2, 'not çevirisi: runTranslation yalnızca addNote ve retryNoteTranslation içinden');
  assert.equal((svc.match(/await runTranslation\(/g) ?? []).length, 3, '+ translateRevision (revizyon notu, karar 163) — başka çağıran yok');
  // Bu işlevleri çağıran dosyalar: yalnızca iki "use server" işlem dosyası (form gönderimiyle çalışır; GET / çizimle değil)
  assert.deepEqual(filesWith(/\b(addNote|retryNoteTranslation|translateRevision)\s*\(/).filter((f) => f !== 'server/notes/translation.js'), ['app/(panel)/siparisler/[id]/actions.ts']);
  // Revizyon notu (karar 163): talep yazıldıktan SONRA, yalnızca talebi yazan kullanıcının sunucu işleminden; bir kez —
  // sahiplenme yalnızca çeviri durumu hiç yazılmamış talebe uygulanır (çevrilmiş / çevrilemedi / sürüyor yeniden çevrilmez)
  const rev = svc.slice(svc.indexOf('export async function translateRevision('), svc.indexOf('export async function testTranslation('));
  assert.match(rev, /requestedById: String\(actor\.id \?\? ''\), translationStatus: null/);
  assert.match(rev, /updateMany\(\{\s*where: \{ id: revision\.id, translationStatus: null \}/);
  assert.ok(rev.indexOf('limits.translation(actor, now.getTime())') < rev.indexOf("translationStatus: 'PENDING'"), 'hak sahiplenmeden önce');
  assert.ok(rev.indexOf('translateReady(settings)') < rev.indexOf('limits.translation('), 'kapalıyken hak harcanmaz');
  const action = APP.find((s) => s.file === 'app/(panel)/siparisler/[id]/actions.ts').text;
  const reqRev = action.slice(action.indexOf('export async function requestRevisionAction('));
  assert.ok(reqRev.indexOf("await act(user, id, 'request_revision'") < reqRev.indexOf('await translateRevision('), 'çeviri talep kaydedildikten sonra');
  assert.equal((action.match(/translateRevision\(/g) ?? []).length, 1);
  assert.deepEqual(filesWith(/\btestTranslation\s*\(/).filter((f) => f !== 'server/notes/translation.js'), ['app/(panel)/admin/entegrasyonlar/actions.ts']);
  for (const file of ['app/(panel)/siparisler/[id]/actions.ts', 'app/(panel)/admin/entegrasyonlar/actions.ts']) {
    assert.ok(APP.find((s) => s.file === file).text.startsWith("'use server'"), `${file}: sunucu işlemi`);
  }
  // Çeviri servisini içe aktaranlar: iki işlem dosyası + Entegrasyonlar sayfası (yalnızca ayar okur: getTranslateSettings, failedTranslations)
  assert.deepEqual(filesWith(/notes\/translation(\.js)?['"]/), ['app/(panel)/admin/entegrasyonlar/actions.ts', 'app/(panel)/admin/entegrasyonlar/page.tsx', 'app/(panel)/siparisler/[id]/actions.ts']);
  const settingsPage = APP.find((s) => s.file === 'app/(panel)/admin/entegrasyonlar/page.tsx').text;
  assert.match(settingsPage, /import \{ failedTranslations, getTranslateSettings \} from '@\/server\/notes\/translation\.js';/);
  // İşçi (scripts/worker.mjs) ve onun kullandığı sunucu kodu not çevirisini hiç yüklemez: işçi çeviri yapamaz, yeniden deneyemez
  const worker = APP.find((s) => s.file === 'scripts/worker.mjs').text;
  assert.ok(!/notes\//.test(worker));
  assert.deepEqual(APP.filter((s) => s.file.startsWith('server/') && !s.file.startsWith('server/notes/') && /notes\/(translation|provider|view)/.test(s.text)).map((s) => s.file), []);
  // Tek seferlik çeviri: sonucu yazan güncelleme yalnızca "sürüyor" (PENDING) kaydına uygulanır; yeniden deneme yalnızca
  // FAILED ya da yarıda kalmış PENDING kaydını sahiplenir — DONE / SAME hiçbir yoldan yeniden çevrilemez
  assert.match(svc, /updateMany\(\{ where: \{ id: note\.id, translationStatus: 'PENDING' \}/);
  assert.match(svc, /OR: \[\{ translationStatus: 'FAILED' \}, \{ translationStatus: 'PENDING', translationAt: \{ lt: stale \} \}\]/);
});
