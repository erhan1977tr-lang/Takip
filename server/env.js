// Ortam değişkenlerinin tek tanımı ve doğrulaması (ADR 0011).
// Uygulama yapılandırmayı buradan okur; yeni bir değişken önce buraya, sonra .env.example'a eklenir.
// Doğrulama çıktısı sır değerlerini (secret: true) asla yazdırmaz.

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

function parseBool(v) {
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error('true ya da false olmalı');
}
function parseInt10(min, max) {
  return (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${min}–${max} arasında tam sayı olmalı`);
    return n;
  };
}
function parseUrl(protocols) {
  return (v) => {
    let u;
    try {
      u = new URL(v);
    } catch {
      throw new Error('geçerli bir adres değil');
    }
    if (!protocols.includes(u.protocol)) throw new Error(`${protocols.join(' / ')} ile başlamalı`);
    return v.trim();
  };
}
function parseTimeZone(v) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
  } catch {
    throw new Error('geçerli bir saat dilimi değil (ör. Europe/Bucharest)');
  }
  return v;
}

/**
 * group: .env.example'daki bölüm. example: false → örnek dosyada aranmaz (platformun verdiği değişkenler).
 * required: her ortamda zorunlu. secret: değeri günlüğe yazılmaz.
 */
export const ENV_VARS = {
  // --- uygulama ---
  APP_URL: { group: 'app', parse: (v) => parseUrl(['http:', 'https:'])(v).replace(/\/+$/, ''), desc: 'Tarayıcıda açılan adres; e-postadaki bağlantılar bunu kullanır' },
  APP_DOMAIN: { group: 'app', desc: 'Caddy sertifika alan adı (yalnızca docker compose)' },
  AUTH_SECRET: {
    group: 'app', required: true, secret: true,
    parse: (v) => {
      if (v.length < 32) throw new Error('en az 32 karakter olmalı');
      return v;
    },
    desc: 'Oturum ve davet kodu imzası',
  },
  COOKIE_SECURE: { group: 'app', parse: parseBool, desc: 'Çerezler yalnızca HTTPS ile mi gitsin (varsayılan: üretimde evet)' },
  INVITE_CODE_TTL_HOURS: { group: 'app', parse: parseInt10(1, 24 * 30), default: 24, desc: 'Davet / şifre kodunun geçerlilik süresi (saat)' },
  APP_TIMEZONE: { group: 'app', parse: parseTimeZone, default: 'Europe/Bucharest', desc: 'Tarihlerin gösterildiği saat dilimi' },
  UPLOAD_DIR: { group: 'app', default: './uploads', desc: 'Yüklenen dosyaların klasörü (herkese açık olmamalı)' },
  UPLOAD_MIN_FREE_MB: { group: 'app', parse: parseInt10(0, 1_000_000), default: 1024, desc: 'Yükleme klasöründe bu kadar MB boş alan kalmayacaksa yeni dosya kabul edilmez (0: denetim kapalı)' },
  CLIENT_IP_SOURCE: {
    group: 'app', default: 'proxy',
    parse: (v) => {
      if (v !== 'proxy' && v !== 'cloudflare') throw new Error('proxy ya da cloudflare olmalı');
      return v;
    },
    desc: 'İstemci IP adresinin kaynağı: proxy = Caddy (X-Forwarded-For); cloudflare yalnızca site Cloudflare arkasındaysa (server/security/client-ip.js)',
  },
  // Tarayıcının adresinin TEK kaynağı bu iki değişkendir (karar 150): uygulamadan / veritabanından değiştirilemez
  CLAMAV_HOST: { group: 'app', desc: 'Antivirüs (clamd) adresi — yalnızca buradan gelir, uygulamadan değiştirilemez; tanımlıysa yüklenen dosyalar taranır (sunucuda: clamav)' },
  CLAMAV_PORT: { group: 'app', parse: parseInt10(1, 65535), default: 3310, desc: 'Antivirüs (clamd) portu — yalnızca buradan gelir' },

  // --- veritabanı ---
  DATABASE_URL: { group: 'db', required: true, secret: true, parse: parseUrl(['postgresql:', 'postgres:']), desc: 'PostgreSQL bağlantısı' },
  POSTGRES_PASSWORD: { group: 'db', secret: true, desc: 'docker compose veritabanı şifresi' },

  // --- e-posta ---
  SMTP_HOST: { group: 'mail', desc: 'SMTP sunucusu' },
  SMTP_PORT: { group: 'mail', parse: parseInt10(1, 65535), default: 587, desc: '587 = STARTTLS, 465 = TLS' },
  SMTP_SECURE: { group: 'mail', parse: parseBool, desc: 'Boşsa port 465 ise true' },
  SMTP_USER: { group: 'mail', desc: 'SMTP kullanıcı adı' },
  SMTP_PASS: { group: 'mail', secret: true, desc: 'SMTP şifresi' },
  MAIL_FROM: { group: 'mail', desc: 'Gönderen ADRESİ (ör. info@gkh.ro). Görünen ad her e-postada "GKH Trading Invest SRL" olur; buradaki ad kullanılmaz' },
  NOTIFY_EMAILS: { group: 'mail', parse: parseBool, default: true, desc: 'Sipariş olaylarında bildirim e-postaları gönderilsin mi (false = kapalı; olaylar kuyrukta kalır)' },
  MAIL_OUTBOX_DIR: { group: 'dev', desc: 'Ayarlıysa e-posta gönderilmez, bu klasöre yazılır (yalnızca geliştirme/test/demo)' },

  // --- demo / test ---
  DEMO_MODE: {
    group: 'dev',
    parse: (v) => {
      if (v !== '0' && v !== '1') throw new Error('0 ya da 1 olmalı');
      return v === '1';
    },
    default: false,
    desc: 'Demo ortamı (örnek veriler, demo posta kutusu)',
  },
  TRANSLATE_FAKE: {
    group: 'dev',
    parse: (v) => {
      if (v !== '0' && v !== '1') throw new Error('0 ya da 1 olmalı');
      return v === '1';
    },
    default: false,
    desc: 'Not çevirisinde sahte sağlayıcı (Google\'a istek gitmez; yalnızca geliştirme / test)',
  },
  TEST_DATABASE_URL: { group: 'dev', secret: true, parse: parseUrl(['postgresql:', 'postgres:']), desc: 'Veritabanı testleri için AYRI veritabanı' },
  E2E_BASE_URL: { group: 'dev', parse: parseUrl(['http:', 'https:']), desc: 'Uçtan uca testlerin adresi' },
  SCREENSHOT_DIR: { group: 'dev', desc: 'Uçtan uca testlerin ekran görüntüsü klasörü' },

  // --- platformun verdiği (örnek dosyada yok) ---
  GIT_SHA: { example: false, desc: 'Derlenen commit; sunucu kurulumu Docker imajına yazar (deploy/takip.sh)' },
  CODESPACES: { example: false, desc: 'GitHub Codespaces içinde "true"' },
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: { example: false, desc: 'Codespaces port yönlendirme alan adı' },
};

const MAIL_REQUIRED = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];

/**
 * Ortamı doğrular. Hata → sunucu açılmamalı; uyarı → açılır ama günlüğe yazılır.
 * @returns {{ values: Record<string, any>, errors: {name: string, message: string}[], warnings: {name: string, message: string}[] }}
 */
export function validateEnv(env = process.env) {
  const values = {};
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === 'production';

  for (const [name, spec] of Object.entries(ENV_VARS)) {
    const raw = env[name];
    if (isBlank(raw)) {
      if (spec.required) errors.push({ name, message: 'tanımlı değil' });
      values[name] = spec.default;
      continue;
    }
    try {
      values[name] = spec.parse ? spec.parse(String(raw).trim()) : String(raw).trim();
    } catch (e) {
      errors.push({ name, message: e.message });
      values[name] = spec.default;
    }
  }
  // SMTP_PASS boşluk içerebilir; kırpılmadan saklanır
  if (!isBlank(env.SMTP_PASS)) values.SMTP_PASS = env.SMTP_PASS;

  // --- ilişkili kurallar ---
  if (values.COOKIE_SECURE === undefined) values.COOKIE_SECURE = production;
  if (values.SMTP_SECURE === undefined) values.SMTP_SECURE = values.SMTP_PORT === 465;

  if (!values.MAIL_OUTBOX_DIR) {
    const missing = MAIL_REQUIRED.filter((k) => isBlank(env[k]));
    if (missing.length) warnings.push({ name: missing.join(', '), message: 'e-posta ayarları eksik; davet ve bildirim e-postaları gönderilemez' });
  }
  if (production) {
    if (!values.APP_URL) warnings.push({ name: 'APP_URL', message: 'tanımlı değil; e-postadaki bağlantılar eksik olur' });
    if (values.MAIL_OUTBOX_DIR && !values.DEMO_MODE) warnings.push({ name: 'MAIL_OUTBOX_DIR', message: 'üretimde ayarlı; e-postalar gönderilmiyor, klasöre yazılıyor' });
    if (!values.COOKIE_SECURE && !isBlank(env.COOKIE_SECURE)) warnings.push({ name: 'COOKIE_SECURE', message: 'üretimde false; çerezler HTTPS olmadan da gönderilir' });
    if (values.TRANSLATE_FAKE && !values.DEMO_MODE) warnings.push({ name: 'TRANSLATE_FAKE', message: 'üretimde ayarlı; notlar gerçekten çevrilmiyor (sahte çeviri)' });
  }
  if (values.TEST_DATABASE_URL && values.DATABASE_URL && sameDatabase(values.TEST_DATABASE_URL, values.DATABASE_URL)) {
    errors.push({ name: 'TEST_DATABASE_URL', message: 'DATABASE_URL ile aynı veritabanını gösteriyor; testler tabloları temizler' });
  }

  return { values, errors, warnings };
}

/** İki bağlantı adresi aynı sunucudaki aynı veritabanını mı gösteriyor? (şifre ve parametreler yok sayılır) */
export function sameDatabase(a, b) {
  const key = (s) => {
    const u = new URL(s);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  };
  try {
    return key(a) === key(b);
  } catch {
    return false;
  }
}

/** Sonucu insanın okuyacağı metne çevirir; sır değerleri yazılmaz (zaten hiç değer yazılmaz). */
export function formatEnvReport({ errors, warnings }) {
  const lines = [];
  if (errors.length) {
    lines.push('Ortam değişkenleri hatalı (.env.example dosyasına bakın):');
    for (const e of errors) lines.push(`  ✘ ${e.name}: ${e.message}`);
  }
  for (const w of warnings) lines.push(`  ⚠ ${w.name}: ${w.message}`);
  return lines.join('\n');
}

let cached;
/** Doğrulanmış değerler (varsayılanlar uygulanmış). Hatalı değerlerde varsayılan döner; açılış kontrolü hatayı ayrıca bildirir. */
export function getEnv() {
  if (!cached) cached = validateEnv(process.env).values;
  return cached;
}
/** Yalnızca testler için. */
export function resetEnvCache() {
  cached = undefined;
}
