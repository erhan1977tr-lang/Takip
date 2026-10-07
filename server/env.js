// Ortam değişkenlerinin tek tanımı ve doğrulaması (ADR 0011).
// Uygulama yapılandırmayı buradan okur; yeni bir değişken önce buraya, sonra .env.example'a eklenir.
// Doğrulama çıktısı sır değerlerini (secret: true) asla yazdırmaz.
//
// GERÇEK SUNUCU (karar 151; güvenlik denetimi 3.50.9 AUD-13). Kodun "gerçek sunucudayım" dediği tek işaret
// TAKIP_DEPLOYMENT değişkenidir; onu yalnızca deploy/docker-compose.yml verir (environment: içinde sabit değer — Compose'da
// environment, env_file'dan ÖNCE gelir: sunucudaki .env dosyası bu değeri ezemez, boşaltamaz). İşaret varken test /
// geliştirme ayarları (SERVER_IGNORED) ne yazılmış olursa olsun YOK SAYILIR ve güvenli davranış zorlanır: demo kapalı,
// e-posta gerçek SMTP ile, çeviri gerçek sağlayıcıyla, çerezler yalnızca HTTPS ile. Uygulama KAPANMAZ; bunun yerine açılış
// günlüğüne ve yönetici ekranına (Entegrasyonlar → "Ortam uyarıları") yalnızca ayarın ADI yazılır — değer, yol, sır yazılmaz.
// Uygulama da işçi de aynı kuralı buradan alır (getEnv / startupEnv); bu ayarlar başka hiçbir yerde ham process.env'den
// okunmaz. NODE_ENV=production ölçüt DEĞİLDİR: CI'daki uçtan uca testler ve demo ortamı da üretim derlemesini bu ayarlarla
// çalıştırır — onlarda işaret yoktur, ayarlar eskisi gibi geçerlidir.

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

/** Gerçek sunucu işaretinin adı ve tek geçerli değeri (deploy/docker-compose.yml → environment) */
export const DEPLOYMENT_VAR = 'TAKIP_DEPLOYMENT';
export const SERVER_DEPLOYMENT = 'server';
/** Gerçek sunucuda yok sayılan test / geliştirme ayarları (adları; sıra raporda ve ekranda bu sıradır) */
export const SERVER_IGNORED = Object.freeze(['DEMO_MODE', 'MAIL_OUTBOX_DIR', 'TRANSLATE_FAKE', 'COOKIE_SECURE']);
/** Uyarı türü: gerçek sunucuda yok sayılan ayar */
export const IGNORED_ON_SERVER = 'ignored-on-server';

/**
 * Gerçek sunucu kurulumu mu? İşaret BOŞ DEĞİLSE evet — değeri ne olursa olsun (tanınmayan değer ayrıca hatadır): yanlış
 * yazılmış bir işaret test ayarlarını açamaz. İşareti kapatmanın tek yolu onu hiç vermemek / boş vermektir; sunucuda bunu
 * .env yapamaz (Compose'daki sabit değer önceliklidir), yalnızca bilerek verilen komut satırı seçeneği yapabilir
 * (docker compose run -e TAKIP_DEPLOYMENT= … — kurulum testinin kullandığı yol).
 * @param {Record<string, string | undefined>} [env]
 */
export function isServerDeployment(env = process.env) {
  return !isBlank(env[DEPLOYMENT_VAR]);
}

/** Yok sayılacak ayar "zaten zararsız" mı (açıkça kapalı / güvenli yazılmış)? O zaman uyarı da üretilmez. */
function harmlessOnServer(name, raw) {
  if (name === 'COOKIE_SECURE') return /^(1|true|yes|on)$/i.test(raw);
  if (name === 'MAIL_OUTBOX_DIR') return false;
  return raw === '0';
}
const IGNORED_TEXT = {
  DEMO_MODE: 'gerçek sunucuda yok sayıldı — demo kapalı',
  MAIL_OUTBOX_DIR: 'gerçek sunucuda yok sayıldı — e-postalar klasöre yazılmaz, SMTP ile gönderilir',
  TRANSLATE_FAKE: 'gerçek sunucuda yok sayıldı — sahte çeviri kapalı',
  COOKIE_SECURE: 'gerçek sunucuda yok sayıldı — çerezler yalnızca HTTPS ile gönderilir',
};

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
  COOKIE_SECURE: { group: 'app', parse: parseBool, desc: 'Çerezler yalnızca HTTPS ile mi gitsin (varsayılan: üretimde evet; gerçek sunucuda HER ZAMAN evet — false yok sayılır)' },
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
  MAIL_OUTBOX_DIR: { group: 'dev', desc: 'Ayarlıysa e-posta gönderilmez, bu klasöre yazılır (yalnızca geliştirme/test/demo; gerçek sunucuda yok sayılır)' },

  // --- demo / test ---
  DEMO_MODE: {
    group: 'dev',
    parse: (v) => {
      if (v !== '0' && v !== '1') throw new Error('0 ya da 1 olmalı');
      return v === '1';
    },
    default: false,
    desc: 'Demo ortamı (örnek veriler, demo posta kutusu; gerçek sunucuda yok sayılır)',
  },
  TRANSLATE_FAKE: {
    group: 'dev',
    parse: (v) => {
      if (v !== '0' && v !== '1') throw new Error('0 ya da 1 olmalı');
      return v === '1';
    },
    default: false,
    desc: 'Not çevirisinde sahte sağlayıcı (Google\'a istek gitmez; yalnızca geliştirme / test; gerçek sunucuda yok sayılır)',
  },
  TEST_DATABASE_URL: { group: 'dev', secret: true, parse: parseUrl(['postgresql:', 'postgres:']), desc: 'Veritabanı testleri için AYRI veritabanı' },
  E2E_BASE_URL: { group: 'dev', parse: parseUrl(['http:', 'https:']), desc: 'Uçtan uca testlerin adresi' },
  SCREENSHOT_DIR: { group: 'dev', desc: 'Uçtan uca testlerin ekran görüntüsü klasörü' },

  // --- platformun verdiği (örnek dosyada yok) ---
  TAKIP_DEPLOYMENT: {
    example: false,
    parse: (v) => {
      if (v !== SERVER_DEPLOYMENT) throw new Error(`yalnızca sunucu kurulumu verir ("${SERVER_DEPLOYMENT}"); elle ayarlanmaz`);
      return v;
    },
    desc: 'Gerçek sunucu işareti; yalnızca deploy/docker-compose.yml verir (.env ezemez). Varken test / geliştirme ayarları yok sayılır',
  },
  GIT_SHA: { example: false, desc: 'Derlenen commit; sunucu kurulumu Docker imajına yazar (deploy/takip.sh)' },
  CODESPACES: { example: false, desc: 'GitHub Codespaces içinde "true"' },
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: { example: false, desc: 'Codespaces port yönlendirme alan adı' },
};

const MAIL_REQUIRED = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];

/**
 * Ortamı doğrular ve — gerçek sunucuda — test / geliştirme ayarlarını etkisizleştirir. Hata → süreç açılmamalı; uyarı →
 * açılır ama günlüğe yazılır. Dönen `values` uygulamanın ve işçinin kullandığı TEK değer kümesidir: gerçek sunucuda
 * SERVER_IGNORED içindeki ayarlar hiç verilmemiş gibidir (DEMO_MODE=false, MAIL_OUTBOX_DIR yok, TRANSLATE_FAKE=false) ve
 * COOKIE_SECURE her zaman true'dur. `ignored`: yok sayılan ayarların ADLARI (değer taşımaz).
 * @returns {{ values: Record<string, any>, errors: {name: string, message: string}[],
 *   warnings: {name: string, message: string, code?: string}[], server: boolean, ignored: string[] }}
 */
export function validateEnv(env = process.env) {
  const values = {};
  const errors = [];
  const warnings = [];
  const server = isServerDeployment(env);
  // Gerçek sunucu her zaman "üretim"dir (işçi / araç kapsayıcısında NODE_ENV .env'den ezilse de)
  const production = server || env.NODE_ENV === 'production';

  // Gerçek sunucu: test / geliştirme ayarları okunmadan ÖNCE kaynaktan çıkarılır — değerleri (geçersiz olsa da) hiçbir
  // kurala, hataya ya da varsayılana giremez
  const ignored = [];
  let source = env;
  if (server) {
    source = { ...env };
    for (const name of SERVER_IGNORED) {
      if (isBlank(env[name]) || harmlessOnServer(name, String(env[name]).trim())) continue;
      delete source[name];
      ignored.push(name);
    }
  }

  for (const [name, spec] of Object.entries(ENV_VARS)) {
    const raw = source[name];
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

  // --- gerçek sunucu: güvenli davranış zorlanır (yukarıda kaynaktan çıkarılanların sonucu burada bir kez daha sabitlenir) ---
  if (server) {
    values.DEMO_MODE = false;
    values.MAIL_OUTBOX_DIR = undefined;
    values.TRANSLATE_FAKE = false;
    values.COOKIE_SECURE = true;
    for (const name of ignored) warnings.push({ name, message: IGNORED_TEXT[name], code: IGNORED_ON_SERVER });
  }

  if (!values.MAIL_OUTBOX_DIR) {
    const missing = MAIL_REQUIRED.filter((k) => isBlank(env[k]));
    if (missing.length) warnings.push({ name: missing.join(', '), message: 'e-posta ayarları eksik; davet ve bildirim e-postaları gönderilemez' });
  }
  if (production) {
    if (!values.APP_URL) warnings.push({ name: 'APP_URL', message: 'tanımlı değil; e-postadaki bağlantılar eksik olur' });
  }
  // Üretim derlemesi ama gerçek sunucu DEĞİL (CI'daki uçtan uca testler, demo ortamı): ayarlar geçerlidir; hangilerinin açık
  // olduğu günlüğe yazılır. Hiçbiri öbürünün uyarısını susturmaz (eskiden DEMO_MODE susturuyordu) ve DEMO_MODE'un kendisi de yazılır.
  if (production && !server) {
    const note = 'açık — bu bir test / demo kurulumu olmalı (gerçek sunucuda yok sayılır)';
    if (values.DEMO_MODE) warnings.push({ name: 'DEMO_MODE', message: `${note}: demo hesapları ve demo posta kutusu` });
    if (values.MAIL_OUTBOX_DIR) warnings.push({ name: 'MAIL_OUTBOX_DIR', message: `${note}: e-postalar gönderilmiyor, klasöre yazılıyor` });
    if (!values.COOKIE_SECURE && !isBlank(env.COOKIE_SECURE)) warnings.push({ name: 'COOKIE_SECURE', message: `${note}: çerezler HTTPS olmadan da gönderilir` });
    if (values.TRANSLATE_FAKE) warnings.push({ name: 'TRANSLATE_FAKE', message: `${note}: notlar gerçekten çevrilmiyor (sahte çeviri)` });
  }
  if (values.TEST_DATABASE_URL && values.DATABASE_URL && sameDatabase(values.TEST_DATABASE_URL, values.DATABASE_URL)) {
    errors.push({ name: 'TEST_DATABASE_URL', message: 'DATABASE_URL ile aynı veritabanını gösteriyor; testler tabloları temizler' });
  }

  return { values, errors, warnings, server, ignored };
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

/**
 * Sonucu insanın okuyacağı metne çevirir. HİÇBİR değer yazılmaz — yalnızca değişken adları ve sabit metinler (sır, yol,
 * adres, şifre çıkmaz). Gerçek sunucuda yok sayılan ayarlar ayrı, göze çarpan bir başlık altında yazılır.
 */
export function formatEnvReport({ errors, warnings }) {
  const lines = [];
  if (errors.length) {
    lines.push('Ortam değişkenleri hatalı (.env.example dosyasına bakın):');
    for (const e of errors) lines.push(`  ✘ ${e.name}: ${e.message}`);
  }
  const ignored = warnings.filter((w) => w.code === IGNORED_ON_SERVER);
  if (ignored.length) {
    lines.push('GÜVENLİK UYARISI — test / geliştirme ayarları gerçek sunucuda YOK SAYILDI (sunucudaki .env dosyasından kaldırın):');
    for (const w of ignored) lines.push(`  ⚠ ${w.name}: ${w.message}`);
  }
  for (const w of warnings) if (w.code !== IGNORED_ON_SERVER) lines.push(`  ⚠ ${w.name}: ${w.message}`);
  return lines.join('\n');
}

/**
 * Açılış denetimi — uygulama (instrumentation.ts) ve işçi (scripts/worker.mjs) ORTAK kullanır: aynı doğrulama, aynı
 * etkisizleştirme, aynı rapor. Süreçten çıkmaz; `ok` false ise çağıran raporu yazıp çıkar (süreç açılmamalı).
 * @returns {{ ok: boolean, report: string, server: boolean, ignored: string[] }}
 */
export function startupEnv(env = process.env) {
  const result = validateEnv(env);
  return { ok: result.errors.length === 0, report: formatEnvReport(result), server: result.server, ignored: result.ignored };
}

let cached;
const current = () => (cached ??= validateEnv(process.env));
/**
 * Doğrulanmış ve (gerçek sunucuda) etkisizleştirilmiş değerler; varsayılanlar uygulanmış. Hatalı değerlerde varsayılan
 * döner; açılış denetimi (startupEnv) hatayı ayrıca bildirir ve süreci açmaz.
 */
export function getEnv() {
  return current().values;
}
/** Bu süreçte gerçek sunucuda yok sayılan ayarların ADLARI (yönetici ekranındaki "Ortam uyarıları" kartı). Değer taşımaz. */
export function ignoredOnServer() {
  return [...current().ignored];
}
/** Yalnızca testler için. */
export function resetEnvCache() {
  cached = undefined;
}
