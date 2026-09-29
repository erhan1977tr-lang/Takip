import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ENV_VARS, validateEnv, formatEnvReport, sameDatabase } from '../server/env.js';

const ok = {
  DATABASE_URL: 'postgresql://takip:gizli-sifre@localhost:5432/takip?schema=public',
  AUTH_SECRET: 'x'.repeat(32),
  MAIL_OUTBOX_DIR: '/tmp/outbox',
};

test('env: geçerli ortamda hata yok, varsayılanlar uygulanır', () => {
  const r = validateEnv(ok);
  assert.deepEqual(r.errors, []);
  assert.equal(r.values.INVITE_CODE_TTL_HOURS, 24);
  assert.equal(r.values.APP_TIMEZONE, 'Europe/Bucharest');
  assert.equal(r.values.SMTP_PORT, 587);
  assert.equal(r.values.SMTP_SECURE, false);
  assert.equal(r.values.COOKIE_SECURE, false);
  assert.equal(r.values.DEMO_MODE, false);
  assert.equal(validateEnv({ ...ok, NODE_ENV: 'production' }).values.COOKIE_SECURE, true);
});

test('env: zorunlu ve hatalı değerler tek seferde listelenir', () => {
  const r = validateEnv({ AUTH_SECRET: 'kisa', SMTP_PORT: 'abc', COOKIE_SECURE: 'belki', APP_TIMEZONE: 'Mars/Olympus', APP_URL: 'ftp://x', DEMO_MODE: 'evet' });
  const names = r.errors.map((e) => e.name).sort();
  assert.deepEqual(names, ['APP_TIMEZONE', 'APP_URL', 'AUTH_SECRET', 'COOKIE_SECURE', 'DATABASE_URL', 'DEMO_MODE', 'SMTP_PORT']);
});

test('env: rapor sır değerlerini yazdırmaz', () => {
  const env = { ...ok, AUTH_SECRET: 'cok-gizli', SMTP_PASS: 'smtp-gizli', MAIL_OUTBOX_DIR: '' };
  const text = formatEnvReport(validateEnv(env));
  assert.match(text, /AUTH_SECRET/);
  for (const secret of ['cok-gizli', 'smtp-gizli', 'gizli-sifre']) assert.ok(!text.includes(secret), secret);
});

test('env: SMTP eksikse ve posta klasörü yoksa uyarı verir, hata vermez', () => {
  const r = validateEnv({ ...ok, MAIL_OUTBOX_DIR: '' });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.name.includes('SMTP_HOST')));
});

test('env: port 465 → TLS; APP_URL sondaki / atılır', () => {
  const r = validateEnv({ ...ok, SMTP_PORT: '465', APP_URL: 'https://takip.ornek.ro/' });
  assert.equal(r.values.SMTP_SECURE, true);
  assert.equal(r.values.APP_URL, 'https://takip.ornek.ro');
});

test('env: test veritabanı ana veritabanıyla aynı olamaz', () => {
  assert.ok(sameDatabase('postgresql://a:b@h:5432/takip', 'postgres://c:d@h/takip?schema=public'));
  assert.ok(!sameDatabase('postgresql://a:b@h:5432/takip', 'postgresql://a:b@h:5432/takip_test'));
  const r = validateEnv({ ...ok, TEST_DATABASE_URL: ok.DATABASE_URL });
  assert.ok(r.errors.some((e) => e.name === 'TEST_DATABASE_URL'));
});

test('env: tanımdaki her değişken .env.example içinde anlatılmış', () => {
  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const missing = Object.entries(ENV_VARS)
    .filter(([, s]) => s.example !== false)
    .map(([name]) => name)
    .filter((name) => !new RegExp(`^#?\\s*${name}=`, 'm').test(example));
  assert.deepEqual(missing, []);
});

test('env: uygulama kodu yapılandırmayı process.env yerine server/env.js üzerinden okur', () => {
  // Çatı değişkenleri (NODE_ENV, NEXT_RUNTIME) ve bağımsız betikler hariç.
  const allowed = new Set(['NODE_ENV', 'NEXT_RUNTIME']);
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js)$/.test(e.name) && p !== 'server/env.js' && p !== 'server/mail/config.js') {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/process\.env\.([A-Z_]+)/g)) {
          if (!allowed.has(m[1])) offenders.push(`${p}: ${m[1]}`);
        }
      }
    }
  };
  for (const d of ['app', 'lib', 'server', 'components']) walk(d);
  assert.deepEqual(offenders, []);
});
