// Gerçek sunucu işareti ve test / geliştirme ayarlarının etkisizleştirilmesi (karar 151; güvenlik denetimi 3.50.9 AUD-13).
//   - işaret (TAKIP_DEPLOYMENT) yalnızca Compose'da sabit değerdir; .env ezemez; boş olmayan HER değer "gerçek sunucu"dur
//   - gerçek sunucuda DEMO_MODE, MAIL_OUTBOX_DIR, TRANSLATE_FAKE, COOKIE_SECURE=false yok sayılır: demo kapalı, e-posta
//     SMTP ile, çeviri gerçek sağlayıcıyla, çerez Secure — uygulama KAPANMAZ, uyarı yalnızca ayarın ADINI içerir
//   - uygulama ve işçi aynı açılış denetimini kullanır; işçi bu ayarları ham ortamdan okumaz, hatalı ortamda başlamaz
//   - demo verisi betiği tek ayara güvenmez: gerçek sunucuda ve boş olmayan veritabanında çalışmaz
//   - CI'daki uçtan uca testler ve demo ortamı (işaret yok) bu ayarları eskisi gibi kullanır
// Ağ / veritabanı kullanılmaz: saf kurallar + kaynak denetimi (tek süreç: kurulum testi betiklerinin "bash -n" sözdizimi
// denetimi). Gerçek süreç / veritabanı denemesi: test/db/server-mode.test.js; gerçek sunucu: e2e/sunucu-kipi.spec.ts;
// gerçek Compose: deploy/test/env-marker.sh.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPLOYMENT_VAR, ENV_VARS, IGNORED_ON_SERVER, SERVER_DEPLOYMENT, SERVER_IGNORED, formatEnvReport, getEnv, ignoredOnServer, isServerDeployment, resetEnvCache,
  startupEnv, validateEnv,
} from '../server/env.js';
import { isDemo } from '../server/demo/accounts.js';
import { DEMO_SEED_REFUSALS, demoSeedDataGuard, demoSeedEnvGuard } from '../server/demo/guard.js';
import { fakeTranslate, fakeTranslateOn, googleTranslate, translatorFor } from '../server/notes/provider.js';
import { avTarget } from '../server/files/antivirus.js';
import { translate } from '../server/i18n/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const yaml = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// Geçerli bir sunucu ortamı (SMTP dahil) + gizli sayılacak değerler
const SECRET = 'cok-gizli-anahtar-0123456789abcdef0123456789';
const BASE = {
  AUTH_SECRET: SECRET, DATABASE_URL: 'postgresql://takip:gizli-db-sifresi@db:5432/takip?schema=public', APP_URL: 'https://takip.ornek.test',
  SMTP_HOST: 'smtp.ornek.test', SMTP_USER: 'posta@ornek.test', SMTP_PASS: 'gizli-smtp-sifresi', MAIL_FROM: 'posta@ornek.test',
};
const OUTBOX = '/gizli/yol/aud13-outbox';
const FLAGS = { DEMO_MODE: '1', MAIL_OUTBOX_DIR: OUTBOX, TRANSLATE_FAKE: '1', COOKIE_SECURE: 'false' };
const SERVER = { [DEPLOYMENT_VAR]: SERVER_DEPLOYMENT };
const safe = (v) => [v.DEMO_MODE, v.MAIL_OUTBOX_DIR, v.TRANSLATE_FAKE, v.COOKIE_SECURE];
const SAFE = [false, undefined, false, true];

// process.env'i değiştiren testler: önceki değerler geri konur, önbellek sıfırlanır
const KEYS = [DEPLOYMENT_VAR, ...SERVER_IGNORED, 'NODE_ENV', 'AUTH_SECRET', 'DATABASE_URL', 'CLAMAV_HOST', 'CLAMAV_PORT'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function withEnv(extra) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { AUTH_SECRET: SECRET, DATABASE_URL: BASE.DATABASE_URL }, extra);
  resetEnvCache();
}
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetEnvCache();
});

// ───────────────────────── işaret ─────────────────────────

test('işaret: boş değilse gerçek sunucudur — değeri ne olursa olsun; tanınmayan değer ayrıca hatadır (test ayarlarını açamaz)', () => {
  assert.deepEqual([DEPLOYMENT_VAR, SERVER_DEPLOYMENT], ['TAKIP_DEPLOYMENT', 'server']);
  assert.deepEqual([...SERVER_IGNORED], ['DEMO_MODE', 'MAIL_OUTBOX_DIR', 'TRANSLATE_FAKE', 'COOKIE_SECURE']);
  for (const blank of [undefined, null, '', ' ', '\t\n']) {
    assert.equal(isServerDeployment({ [DEPLOYMENT_VAR]: blank }), false, JSON.stringify(blank));
    assert.equal(validateEnv({ ...BASE, [DEPLOYMENT_VAR]: blank }).server, false);
  }
  assert.equal(isServerDeployment({}), false);
  // Tek geçerli değer
  const ok = validateEnv({ ...BASE, ...SERVER });
  assert.deepEqual([ok.server, ok.errors, ok.values.TAKIP_DEPLOYMENT], [true, [], 'server']);
  // Başka her değer: yine gerçek sunucu (ayarlar yok sayılır) + hata (süreç açılmaz) — "kapatan" bir değer YOKTUR
  for (const odd of ['test', 'demo', 'dev', '0', 'false', 'off', 'no', 'SERVER', 'Server', ' server x', 'ci', 'none', 'null', 'undefined']) {
    const r = validateEnv({ ...BASE, ...FLAGS, [DEPLOYMENT_VAR]: odd });
    assert.equal(isServerDeployment({ [DEPLOYMENT_VAR]: odd }), true, odd);
    assert.equal(r.server, true, odd);
    assert.deepEqual(safe(r.values), SAFE, `${odd}: ayarlar yine yok sayılır`);
    assert.deepEqual(r.errors.map((e) => e.name), ['TAKIP_DEPLOYMENT'], odd);
    assert.equal(startupEnv({ ...BASE, ...FLAGS, [DEPLOYMENT_VAR]: odd }).ok, false);
  }
  // İşaret örnek dosyada "ayarlanacak değişken" olarak geçmez; platformun verdiği değişkendir
  assert.equal(ENV_VARS.TAKIP_DEPLOYMENT.example, false);
  assert.equal(/^#?\s*TAKIP_DEPLOYMENT=/m.test(read('.env.example')), false);
});

// ───────────────────────── gerçek sunucu: etkisizleştirme ─────────────────────────

test('gerçek sunucu: dört ayar tek tek ve birlikte yok sayılır; güvenli değerler zorlanır; uygulama kapanmaz (hata yok)', () => {
  const all = validateEnv({ ...BASE, ...SERVER, ...FLAGS });
  assert.deepEqual(all.errors, []);
  assert.deepEqual(safe(all.values), SAFE);
  assert.deepEqual(all.ignored, [...SERVER_IGNORED]);
  assert.deepEqual(all.warnings.filter((w) => w.code === IGNORED_ON_SERVER).map((w) => w.name), [...SERVER_IGNORED]);
  assert.equal(startupEnv({ ...BASE, ...SERVER, ...FLAGS }).ok, true, 'süreç açılır');
  // Tek tek
  for (const [name, value] of Object.entries(FLAGS)) {
    const r = validateEnv({ ...BASE, ...SERVER, [name]: value });
    assert.deepEqual([r.errors, r.ignored, safe(r.values)], [[], [name], SAFE], name);
  }
  // Yazım ne olursa olsun (geçersiz değer de): hata DEĞİL, yok sayılır
  const spellings = {
    DEMO_MODE: ['1', 'true', 'evet', 'yes', 'on', '2', ' 1 ', 'x'],
    MAIL_OUTBOX_DIR: ['/tmp/outbox', './.outbox', 'C:\\outbox', '0', 'false', ' '.repeat(2) + 'x'],
    TRANSLATE_FAKE: ['1', 'true', 'evet', 'on', 'x'],
    COOKIE_SECURE: ['false', '0', 'no', 'off', 'FALSE', 'belki', 'hayır'],
  };
  for (const [name, list] of Object.entries(spellings)) for (const value of list) {
    const r = validateEnv({ ...BASE, ...SERVER, [name]: value });
    assert.deepEqual([r.errors, r.ignored, safe(r.values)], [[], [name], SAFE], `${name}=${value}`);
  }
  // Zaten zararsız yazılmışsa (açıkça kapalı / güvenli) uyarı da üretilmez
  for (const harmless of [{ DEMO_MODE: '0' }, { TRANSLATE_FAKE: '0' }, { COOKIE_SECURE: 'true' }, { COOKIE_SECURE: '1' }, { COOKIE_SECURE: 'on' }, { DEMO_MODE: '' }, { MAIL_OUTBOX_DIR: '  ' }, {}]) {
    const r = validateEnv({ ...BASE, ...SERVER, ...harmless });
    assert.deepEqual([r.errors, r.ignored, r.warnings, safe(r.values)], [[], [], [], SAFE], JSON.stringify(harmless));
  }
  // NODE_ENV ölçüt değildir: işçi / araç kapsayıcısında .env onu ezse de sonuç aynı
  for (const node of ['development', 'test', 'production', '', undefined]) {
    const r = validateEnv({ ...BASE, ...SERVER, ...FLAGS, NODE_ENV: node });
    assert.deepEqual([r.server, r.errors, r.ignored, safe(r.values)], [true, [], [...SERVER_IGNORED], SAFE], String(node));
  }
  // DEMO_MODE hiçbir uyarıyı susturmaz; kendisi de yazılır
  const demo = validateEnv({ ...BASE, ...SERVER, DEMO_MODE: '1', MAIL_OUTBOX_DIR: OUTBOX, TRANSLATE_FAKE: '1' });
  assert.deepEqual(demo.ignored, ['DEMO_MODE', 'MAIL_OUTBOX_DIR', 'TRANSLATE_FAKE']);
  // E-posta: klasör yok sayıldığı için SMTP beklenir — SMTP eksikse bunun uyarısı da görünür (klasör onu gizlemez)
  const noSmtp = validateEnv({ AUTH_SECRET: SECRET, DATABASE_URL: BASE.DATABASE_URL, APP_URL: BASE.APP_URL, ...SERVER, MAIL_OUTBOX_DIR: OUTBOX });
  assert.ok(noSmtp.warnings.some((w) => w.name.includes('SMTP_HOST')));
  // Öteki ayarlar etkilenmez (AUD-12: tarayıcı adresi dahil)
  const other = validateEnv({ ...BASE, ...SERVER, ...FLAGS, CLAMAV_HOST: 'clamav', CLAMAV_PORT: '3310', NOTIFY_EMAILS: 'false', UPLOAD_MIN_FREE_MB: '0', INVITE_CODE_TTL_HOURS: '48' });
  assert.deepEqual([other.values.CLAMAV_HOST, other.values.CLAMAV_PORT, other.values.NOTIFY_EMAILS, other.values.UPLOAD_MIN_FREE_MB, other.values.INVITE_CODE_TTL_HOURS, other.values.SMTP_HOST],
    ['clamav', 3310, false, 0, 48, 'smtp.ornek.test']);
  assert.deepEqual(avTarget(other.values), { host: 'clamav', port: 3310 });
  // Zorunlu / bozuk değerler gerçek sunucuda da hatadır (mevcut kural)
  const bad = validateEnv({ ...SERVER, AUTH_SECRET: 'kisa', APP_TIMEZONE: 'Mars/Olympus', NOTIFY_EMAILS: 'belki' });
  assert.deepEqual(bad.errors.map((e) => e.name).sort(), ['APP_TIMEZONE', 'AUTH_SECRET', 'DATABASE_URL', 'NOTIFY_EMAILS']);
});

test('CI / demo / geliştirme (işaret yok): ayarlar eskisi gibi GEÇERLİDİR — üretim derlemesinde de', () => {
  for (const node of ['production', 'development', undefined]) {
    const r = validateEnv({ ...BASE, ...FLAGS, NODE_ENV: node });
    assert.deepEqual([r.server, r.errors, r.ignored], [false, [], []], String(node));
    assert.deepEqual(safe(r.values), [true, OUTBOX, true, false], `${node}: demo, klasör, sahte çeviri, Secure'suz çerez`);
    assert.equal(r.warnings.some((w) => w.code === IGNORED_ON_SERVER), false);
  }
  // CI'daki ana sunucu (uçtan uca testler) ve demo sunucusu
  const ci = validateEnv({ ...BASE, NODE_ENV: 'production', COOKIE_SECURE: 'false', MAIL_OUTBOX_DIR: OUTBOX, TRANSLATE_FAKE: '1' });
  assert.deepEqual(safe(ci.values), [false, OUTBOX, true, false]);
  const demo = validateEnv({ ...BASE, NODE_ENV: 'production', DEMO_MODE: '1', MAIL_OUTBOX_DIR: OUTBOX });
  assert.deepEqual([demo.values.DEMO_MODE, demo.values.MAIL_OUTBOX_DIR], [true, OUTBOX]);
  // Üretim derlemesi + işaret yok: açık olan her ayar günlüğe yazılır; DEMO_MODE artık ne susturur ne de kendisi sessizdir
  const names = (env) => validateEnv({ ...BASE, NODE_ENV: 'production', ...env }).warnings.map((w) => w.name);
  assert.deepEqual(names(FLAGS), ['DEMO_MODE', 'MAIL_OUTBOX_DIR', 'COOKIE_SECURE', 'TRANSLATE_FAKE']);
  assert.deepEqual(names({ DEMO_MODE: '1' }), ['DEMO_MODE']);
  assert.deepEqual(names({ DEMO_MODE: '1', MAIL_OUTBOX_DIR: OUTBOX, TRANSLATE_FAKE: '1' }), ['DEMO_MODE', 'MAIL_OUTBOX_DIR', 'TRANSLATE_FAKE']);
  assert.deepEqual(names({}), []);
  // Varsayılanlar değişmedi
  assert.equal(validateEnv({ ...BASE, NODE_ENV: 'production' }).values.COOKIE_SECURE, true);
  assert.equal(validateEnv({ ...BASE }).values.COOKIE_SECURE, false);
});

test('uyarı çıktıları değer, yol ya da sır içermez: yalnızca değişken adı + sabit metin', () => {
  const hostile = {
    ...BASE, ...SERVER, DEMO_MODE: 'gizli-demo-degeri', MAIL_OUTBOX_DIR: OUTBOX, TRANSLATE_FAKE: 'gizli-ceviri-degeri', COOKIE_SECURE: 'gizli-cerez-degeri',
    SMTP_PASS: 'gizli-smtp-sifresi', POSTGRES_PASSWORD: 'gizli-pg',
  };
  const result = validateEnv(hostile);
  const startup = startupEnv(hostile);
  const text = JSON.stringify([formatEnvReport(result), startup, result.errors, result.warnings, result.ignored]);
  for (const s of [OUTBOX, '/gizli', 'aud13-outbox', 'gizli-demo-degeri', 'gizli-ceviri-degeri', 'gizli-cerez-degeri', SECRET, 'gizli-smtp-sifresi', 'gizli-db-sifresi', 'gizli-pg', 'smtp.ornek.test', 'posta@ornek.test']) {
    assert.equal(text.includes(s), false, `sızmamalı: ${s}`);
  }
  // Rapor: göze çarpan başlık + dört ad; her satır "ad: sabit metin"
  const lines = startup.report.split('\n');
  assert.equal(lines[0], 'GÜVENLİK UYARISI — test / geliştirme ayarları gerçek sunucuda YOK SAYILDI (sunucudaki .env dosyasından kaldırın):');
  assert.deepEqual(lines.slice(1).map((l) => /^ {2}⚠ ([A-Z_]+): gerçek sunucuda yok sayıldı — /.exec(l)?.[1]), [...SERVER_IGNORED]);
  // Uyarı nesneleri yalnızca ad, sabit metin ve tür taşır
  for (const w of result.warnings) assert.deepEqual(Object.keys(w).sort(), w.code ? ['code', 'message', 'name'] : ['message', 'name']);
  // Hata raporu da değer yazmaz (bozuk değerlerle)
  const broken = formatEnvReport(validateEnv({ ...SERVER, AUTH_SECRET: 'kisa-gizli', DATABASE_URL: 'mysql://kullanici:gizli-parola@h/x', MAIL_OUTBOX_DIR: OUTBOX }));
  for (const s of ['kisa-gizli', 'gizli-parola', 'mysql://', OUTBOX]) assert.equal(broken.includes(s), false, s);
  // İşaretsiz ortamın uyarıları da değer taşımaz
  const ci = JSON.stringify(validateEnv({ ...BASE, NODE_ENV: 'production', ...FLAGS }).warnings);
  assert.equal(ci.includes(OUTBOX), false);
});

// ───────────────────────── uygulama: değerleri kullanan yerler ─────────────────────────

test('uygulama: getEnv üzerinden okuyan her yer gerçek sunucuda güvenli davranır (demo, çeviri, çerez, e-posta klasörü, kart)', () => {
  // Gerçek sunucu + dört ayar
  withEnv({ ...SERVER, ...FLAGS, NODE_ENV: 'production' });
  assert.deepEqual(safe(getEnv()), SAFE);
  assert.equal(isDemo(), false, 'demo kapalı: giriş sayfası kutusu, menü bağlantısı ve /demo/posta bunu kullanır');
  assert.equal(fakeTranslateOn(), false);
  assert.equal(translatorFor(), googleTranslate, 'gerçek sağlayıcı (çağrılmaz; yalnızca hangisinin seçildiği)');
  assert.deepEqual(ignoredOnServer(), [...SERVER_IGNORED]);
  // Aynı ayarlar işaretsiz ortamda (CI / demo) geçerlidir
  withEnv({ ...FLAGS, NODE_ENV: 'production' });
  assert.deepEqual(safe(getEnv()), [true, OUTBOX, true, false]);
  assert.equal(isDemo(), true);
  assert.equal(translatorFor(), fakeTranslate);
  assert.deepEqual(ignoredOnServer(), []);
  // Gerçek sunucu, temiz: uyarı yok → kart çizilmez
  withEnv({ ...SERVER });
  assert.deepEqual(ignoredOnServer(), []);
  assert.deepEqual(safe(getEnv()), SAFE);
  // ignoredOnServer kopya döndürür (çağıran önbelleği bozamaz)
  withEnv({ ...SERVER, DEMO_MODE: '1' });
  ignoredOnServer().push('X');
  assert.deepEqual(ignoredOnServer(), ['DEMO_MODE']);
});

test('yapı: bu dört ayar hiçbir yerde ham ortamdan okunmaz; tüketiciler doğrulanmış değeri kullanır; kart yalnızca adları gösterir', () => {
  // Uygulama, kitaplık, sunucu kodu, bileşenler ve betikler: process.env.<AYAR> yok
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [p] : [];
  });
  const offenders = [];
  for (const f of ['app', 'lib', 'server', 'components', 'scripts', 'prisma'].flatMap(walk).concat('instrumentation.ts')) {
    const src = strip(read(f));
    for (const m of src.matchAll(/process\.env(?:\.|\[\s*['"`])(DEMO_MODE|MAIL_OUTBOX_DIR|TRANSLATE_FAKE|COOKIE_SECURE|TAKIP_DEPLOYMENT)/g)) offenders.push(`${f}: ${m[1]}`);
    if (f !== 'server/env.js' && /\benv(?:\.|\[\s*['"`])TAKIP_DEPLOYMENT/.test(src)) offenders.push(`${f}: işareti kendi okuyor`);
  }
  assert.deepEqual(offenders, []);
  // Tüketiciler
  assert.match(strip(read('lib/env.ts')), /export function secureCookies\(\): boolean \{\n {2}return getEnv\(\)\.COOKIE_SECURE;\n\}/);
  assert.match(strip(read('server/demo/accounts.js')), /export function isDemo\(\) \{\n {2}return getEnv\(\)\.DEMO_MODE === true;\n\}/);
  assert.match(strip(read('server/notes/provider.js')), /export const fakeTranslateOn = \(env = getEnv\(\)\) => env\.TRANSLATE_FAKE === true;/);
  const invite = strip(read('lib/invite.ts'));
  assert.ok(invite.includes('const env = getEnv();') && invite.includes('const outbox: string | undefined = env.MAIL_OUTBOX_DIR;'));
  const demoPage = strip(read('app/(panel)/demo/posta/page.tsx'));
  assert.ok(demoPage.includes('const dir: string | undefined = getEnv().MAIL_OUTBOX_DIR;') && demoPage.includes('if (!isDemo() || !dir) notFound();'));
  assert.ok(strip(read('app/login/page.tsx')).includes('{isDemo() && ('));
  assert.ok(strip(read('app/(panel)/layout.tsx')).includes('const demo = isDemo();'));
  // Açılış denetimi: uygulama ortak fonksiyonu kullanır, hatada çıkar
  const inst = strip(read('instrumentation.ts'));
  assert.ok(inst.includes("const { startupEnv } = await import('./server/env.js');") && inst.includes('const startup = startupEnv(process.env);'));
  assert.match(inst, /if \(!startup\.ok\) \{\n\s+console\.error\(startup\.report\);\n\s+process\.exit\(1\);\n\s+\}/);
  assert.equal(/validateEnv|formatEnvReport/.test(inst), false, 'uygulama kendi doğrulamasını yazmaz');
  // Kart: yetki sayfanın ilk işi; adlar sabit listeden; uyarı yoksa çizilmez; değer okunmaz
  const page = strip(read('app/(panel)/admin/entegrasyonlar/page.tsx'));
  assert.ok(page.includes("await requirePermission('SETTINGS_MANAGE');"));
  assert.ok(page.includes('const ignoredNames: string[] = ignoredOnServer();'));
  assert.ok(page.includes('const envIgnored = SERVER_IGNORED.filter((name: string) => ignoredNames.includes(name));'));
  assert.ok(page.includes('{envIgnored.length > 0 && ('));
  const card = page.slice(page.indexOf('{envIgnored.length > 0 && ('), page.indexOf('{okMsg &&'));
  assert.ok(card.includes('id="ortam-uyarilari"') && card.includes('data-env-ignored={name}') && card.includes('t(`admin.integrations.env.ignored.${name}` as MsgKey)'));
  assert.equal(/getEnv|process\.env|MAIL_OUTBOX_DIR|\bs\.|sp\./.test(card), false, 'kartta değer / adres / istek verisi yok');
  // Her ad için iki dilde sabit metin
  for (const lang of ['tr', 'ro']) for (const key of ['title', 'intro', 'hint', ...SERVER_IGNORED.map((n) => `ignored.${n}`)]) {
    const k = `admin.integrations.env.${key}`;
    assert.notEqual(translate(lang, k), k, `${lang}: ${k}`);
  }
});

// ───────────────────────── işçi ─────────────────────────

test('işçi: uygulamayla aynı açılış denetimi — hatalı ortamda başlamaz; e-posta klasörünü yalnızca doğrulanmış değerden okur', () => {
  const src = strip(read('scripts/worker.mjs'));
  // Ortak denetim, veritabanı istemcisinden ve döngüden ÖNCE; hatada çıkış
  const order = [
    "import { getEnv, startupEnv } from '../server/env.js';",
    'const startup = startupEnv(process.env);',
    'if (!startup.ok) {',
    'process.exit(1);',
    'if (startup.report) console.warn(startup.report);',
    'const env = getEnv();',
    'const db = new PrismaClient();',
    'if (env.MAIL_OUTBOX_DIR) {',
    'transport: outboxTransport(env.MAIL_OUTBOX_DIR),',
    "log('işçi başladı');",
    'while (!stopping) {',
  ];
  const pos = order.map((s) => src.indexOf(s));
  assert.ok(pos.every((i) => i >= 0), `eksik: ${order.filter((_, i) => pos[i] < 0).join(' | ')}`);
  assert.deepEqual(pos, [...pos].sort((a, b) => a - b), 'sıra');
  assert.equal((src.match(/new PrismaClient\(/g) ?? []).length, 1);
  // Ham ortamdan TEK TEK değişken okunmaz: process.env yalnızca bütün olarak ortak denetime ve SMTP ayar okuyucusuna verilir
  assert.deepEqual(src.match(/process\.env\b(?!\))[^\n]{0,12}/g) ?? [], []);
  assert.deepEqual((src.match(/\w+\(process\.env\)/g) ?? []).sort(), ['readMailConfig(process.env)', 'startupEnv(process.env)']);
  assert.equal(/validateEnv|formatEnvReport/.test(src), false, 'işçi kendi doğrulamasını yazmaz');
  // Kural (işçinin kullandığı değerler): gerçek sunucuda klasör yok → SMTP yolu; hatalı ortamda başlamaz
  const server = validateEnv({ ...BASE, ...SERVER, ...FLAGS });
  assert.equal(server.values.MAIL_OUTBOX_DIR, undefined);
  assert.equal(startupEnv({ ...BASE, ...SERVER, ...FLAGS }).ok, true);
  for (const bad of [{ AUTH_SECRET: 'kisa' }, { DATABASE_URL: '' }, { NOTIFY_EMAILS: 'belki' }, { APP_TIMEZONE: 'Mars/Olympus' }, { SMTP_PORT: 'abc' }]) {
    const s = startupEnv({ ...BASE, ...SERVER, ...bad });
    assert.equal(s.ok, false, JSON.stringify(bad));
    assert.match(s.report, /^Ortam değişkenleri hatalı/);
  }
  // Test / demo işçisi (işaret yok): klasör geçerli
  assert.equal(validateEnv({ ...BASE, NODE_ENV: 'production', MAIL_OUTBOX_DIR: OUTBOX }).values.MAIL_OUTBOX_DIR, OUTBOX);
});

// ───────────────────────── demo verisi betiği ─────────────────────────

test('demo verisi: gerçek sunucuda DEMO_MODE=1 olsa da çalışmaz; ilk yükleme yalnızca boş veritabanına; tek ayara güvenilmez', () => {
  // Ortam koşulu
  assert.deepEqual(demoSeedEnvGuard({ DEMO_MODE: '1' }), { ok: true });
  assert.deepEqual(demoSeedEnvGuard({ ...BASE, DEMO_MODE: '1', MAIL_OUTBOX_DIR: OUTBOX, NODE_ENV: 'production' }), { ok: true }, 'CI demo adımı / Codespaces');
  for (const marker of ['server', 'test', '0', 'false', 'x']) {
    assert.deepEqual(demoSeedEnvGuard({ DEMO_MODE: '1', [DEPLOYMENT_VAR]: marker }), { ok: false, reason: 'server' }, marker);
    assert.deepEqual(demoSeedEnvGuard({ ...BASE, ...FLAGS, [DEPLOYMENT_VAR]: marker, NODE_ENV: 'development' }), { ok: false, reason: 'server' }, marker);
  }
  for (const demo of [undefined, '', '0', 'true', 'yes', 'on', '2', 'evet']) assert.deepEqual(demoSeedEnvGuard({ DEMO_MODE: demo }), { ok: false, reason: 'not-demo' }, String(demo));
  assert.deepEqual(demoSeedEnvGuard({}), { ok: false, reason: 'not-demo' });
  // Veri koşulu: demo hesapları yoksa veritabanı boş olmalı
  assert.deepEqual(demoSeedDataGuard({ demoAdminExists: false, otherUsers: 0, orders: 0 }), { ok: true });
  for (const state of [{ otherUsers: 1, orders: 0 }, { otherUsers: 0, orders: 1 }, { otherUsers: 12, orders: 340 }, { otherUsers: undefined, orders: 0 }, { otherUsers: 0, orders: NaN }, { otherUsers: '0', orders: 0 }, {}]) {
    assert.deepEqual(demoSeedDataGuard({ demoAdminExists: false, ...state }), { ok: false, reason: 'not-empty' }, JSON.stringify(state));
  }
  // Demo hesapları zaten varsa (yeniden çalıştırma) veri koşulu aranmaz; "var" yalnızca tam true'dur
  assert.deepEqual(demoSeedDataGuard({ demoAdminExists: true, otherUsers: 3, orders: 8 }), { ok: true });
  for (const truthy of [1, 'true', {}]) assert.deepEqual(demoSeedDataGuard({ demoAdminExists: truthy, otherUsers: 3, orders: 8 }), { ok: false, reason: 'not-empty' });
  for (const reason of ['server', 'not-demo', 'not-empty']) assert.ok(DEMO_SEED_REFUSALS[reason].length > 20);
  // Betik: ortam koşulu veritabanı istemcisinden ÖNCE; veri koşulu hiçbir yazmadan ÖNCE; DEMO_MODE'u kendi başına okumaz
  const seed = strip(read('scripts/demo/seed.mjs'));
  const order = [
    'const envGuard = demoSeedEnvGuard(process.env);',
    'if (!envGuard.ok) {',
    'process.exit(1);',
    'const prisma = new PrismaClient();',
    'const dataGuard = demoSeedDataGuard({',
    'if (!dataGuard.ok) {',
    'process.exitCode = 1;',
    'await runBaseSeed(prisma,',
    'await prisma.$transaction((tx) => main(tx),',
  ];
  const pos = order.map((s) => seed.indexOf(s));
  assert.ok(pos.every((i) => i >= 0), `eksik: ${order.filter((_, i) => pos[i] < 0).join(' | ')}`);
  assert.deepEqual(pos, [...pos].sort((a, b) => a - b), 'sıra');
  assert.equal(/DEMO_MODE/.test(seed), false, 'betik DEMO_MODE\'u kendi okumaz (koşul server/demo/guard.js içinde)');
  assert.equal((seed.match(/runBaseSeed\(/g) ?? []).length, 1);
  assert.equal((seed.match(/\$transaction\(/g) ?? []).length, 1);
  const beforeGuard = seed.slice(seed.indexOf('const prisma = new PrismaClient();'), seed.indexOf('const dataGuard = demoSeedDataGuard({'));
  assert.equal(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(|\$executeRaw|runBaseSeed\(|\$transaction\(/.test(beforeGuard.replace(/async function[\s\S]*?\n\}\n/g, '')), false, 'veri koşulundan önce yazma yok');
});

// ───────────────────────── sunucu düzeni (Compose) ─────────────────────────

test('sunucu düzeni: işaret Compose\'da SABİT değerdir (uygulama, işçi, araçlar); .env ezemez; başka hiçbir yerde verilmez', () => {
  const compose = read('deploy/docker-compose.yml');
  const service = (name) => {
    const lines = compose.split('\n');
    const start = lines.indexOf(`  ${name}:`);
    assert.ok(start > 0, `${name} servisi tanımlı`);
    const out = [];
    for (const line of lines.slice(start + 1)) {
      if (/^ {0,2}[^\s#]/.test(line)) break;
      if (!/^\s*#/.test(line)) out.push(line);
    }
    return out.join('\n');
  };
  for (const name of ['app', 'worker', 'tools']) {
    const def = service(name);
    // Sabit değer, environment: bloğunun içinde (Compose'da environment, env_file'dan önce gelir)
    assert.match(def, /^ {4}env_file: \.env$/m, `${name}: .env yine okunur`);
    const env = /^ {4}environment:\n((?: {6}.*\n)+)/m.exec(def)?.[1] ?? '';
    assert.ok(env.split('\n').includes('      TAKIP_DEPLOYMENT: server'), `${name}: işaret environment bloğunda, sabit`);
    assert.equal((def.match(/TAKIP_DEPLOYMENT/g) ?? []).length, 1, `${name}: tek tanım`);
  }
  for (const name of ['db', 'uploads-init', 'clamav', 'caddy']) assert.equal(/TAKIP_DEPLOYMENT/.test(service(name)), false, name);
  // Değişkenden okunmaz, liste biçiminde (- AD=değer) verilmez, başka değer yoktur
  const body = yaml(compose);
  assert.deepEqual(body.match(/^.*TAKIP_DEPLOYMENT.*$/gm), Array(3).fill('      TAKIP_DEPLOYMENT: server'));
  assert.equal(/\$\{?TAKIP_DEPLOYMENT|TAKIP_DEPLOYMENT=/.test(body), false);
  // İşareti başka hiçbir şey vermez: imaj, kurulumun ürettiği .env, sunucu aracı, CI'nın genel ortamı, demo kurulumu
  assert.equal(/TAKIP_DEPLOYMENT/.test(read('Dockerfile')), false, 'imaj işaret taşımaz (CI / demo aynı imaj kodunu işaretsiz çalıştırır)');
  for (const f of ['deploy/install.sh', 'deploy/takip.sh', 'scripts/demo/setup.sh', 'scripts/demo/start.sh', 'playwright.config.ts']) assert.equal(/TAKIP_DEPLOYMENT/.test(read(f)), false, f);
  // CI: işaret yalnızca "gerçek sunucu kipi" adımında, o adımın kendi ortamında verilir — işin genel ortamında YOKTUR
  const ci = read('.github/workflows/ci.yml');
  const jobEnv = ci.slice(ci.indexOf('\n    env:\n'), ci.indexOf('\n    steps:\n'));
  assert.ok(jobEnv.includes('MAIL_OUTBOX_DIR:') && jobEnv.includes("TRANSLATE_FAKE: '1'") && jobEnv.includes("COOKIE_SECURE: 'false'"), 'CI test ayarlarını bilerek kullanır');
  assert.equal(/TAKIP_DEPLOYMENT/.test(jobEnv), false);
  const demoStep = ci.slice(ci.indexOf('- name: Demo ortamı'), ci.indexOf('- name: Gerçek sunucu kipi'));
  assert.ok(demoStep.includes("DEMO_MODE: '1'") && !/TAKIP_DEPLOYMENT/.test(demoStep), 'demo adımı işaretsiz');
  assert.equal((ci.match(/TAKIP_DEPLOYMENT: server/g) ?? []).length, 1);
  // Kurulum testleri: işareti yalnızca komut satırı seçeneğiyle (compose run -e) bilerek kaldırır — .env ile değil
  const nonroot = read('deploy/test/worker-nonroot.sh');
  assert.match(nonroot, /^ {2}compose run --rm --no-deps -T -e TAKIP_DEPLOYMENT= -v "\$T\/outbox:\/tmp\/outbox" worker node scripts\/worker\.mjs --once /m,
    'işçi kurulum testi: e-posta turu tek seferlik kapsayıcıda, işaret komut satırından bilerek boş');
  assert.equal(/TAKIP_DEPLOYMENT=.*(tee|>>).*ENV_FILE/.test(nonroot), false);
  // Gerçek Compose denemesi: yalnızca CI'da çalışır, sözdizimi geçerli, iş akışında çağrılır ve shellcheck'ten geçer
  const marker = read('deploy/test/env-marker.sh');
  assert.match(marker, /^\[ "\$\{GITHUB_ACTIONS:-\}" = true \] \|\| \{ .*exit 2; \}$/m);
  for (const f of ['deploy/test/env-marker.sh', 'deploy/test/worker-nonroot.sh']) execFileSync('bash', ['-n', path.join(ROOT, f)]);
  const flow = read('.github/workflows/deploy-test.yml');
  assert.match(flow, /^ {8}run: bash deploy\/test\/env-marker\.sh$/m);
  assert.match(flow, /shellcheck -S warning .*deploy\/test\/env-marker\.sh/);
  assert.ok(flow.indexOf('run: bash deploy/test/worker-nonroot.sh\n') < flow.indexOf('run: bash deploy/test/env-marker.sh'), 'işçi testinden sonra (temiz .env ile)');
  // Deneme, .env'e işaret satırı yazarak ezmeyi dener ve .env'i testten önceki hâline getirir; deneme verisi imaja girmez
  assert.ok(marker.includes("'TAKIP_DEPLOYMENT=' 'TAKIP_DEPLOYMENT=test'") && marker.includes('restore_env') && marker.includes('sudo cmp -s "$T/env.asil" "$ENV_FILE"'));
  assert.match(read('.dockerignore'), /^deploy\/test$/m);
});
