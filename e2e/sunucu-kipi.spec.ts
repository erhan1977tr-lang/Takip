import fs from 'node:fs';
import path from 'node:path';
import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER } from './helpers';

// Gerçek sunucu kipi (karar 151; güvenlik denetimi 3.50.9 AUD-13). Yalnızca SERVER_MODE_URL ayarlıysa çalışır: CI, aynı
// üretim derlemesini ÜÇÜNCÜ bir sunucu olarak gerçek sunucu işaretiyle (TAKIP_DEPLOYMENT=server) ve sunucuya yanlışlıkla
// kopyalanmış bir demo / test .env'inin dört ayarıyla birlikte başlatır: DEMO_MODE=1, MAIL_OUTBOX_DIR=<klasör>,
// TRANSLATE_FAKE=1, COOKIE_SECURE=false. Beklenen: ayarlar YOK SAYILIR, sunucu kapanmaz —
//   - giriş sayfasında demo kutusu yok; /demo/posta yöneticiye de 404; menüde demo bağlantısı yok
//   - oturum, dil çerezi Secure
//   - e-posta diske yazılmaz (klasör oluşmaz), "gönderildi" işaretlenmez
//   - sahte çeviri kapalı ("TEST MODU" kartı yok); Entegrasyonlar'da "Ortam uyarıları" kartı yalnızca dört ADI gösterir
//   - sunucu günlüğündeki uyarı yalnızca adları içerir (klasör yolu, sır yok)
// Karşılaştırma (aynı testte): işaretsiz ana test sunucusu (uçtan uca testlerin kullandığı) bu ayarları bilerek KULLANMAYA
// devam eder — çerez Secure değil, e-posta klasöre yazılır, "TEST MODU" görünür, uyarı kartı yoktur.
// Not eklenmez / çeviri denenmez: gerçek sunucu kipinde sağlayıcı gerçektir (Google'a istek gitmemeli). Bu makinede SMTP
// ayarı yoktur: gerçek sunucu kipindeki e-posta denemesi ağa çıkmadan "ayar eksik" ile biter.
const SERVER = process.env.SERVER_MODE_URL;
test.skip(!SERVER, 'SERVER_MODE_URL ayarlı değil');
test.describe.configure({ mode: 'serial' });

const MAIN = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const SERVER_OUTBOX = process.env.MAIL_OUTBOX_DIR ?? ''; // gerçek sunucu kipindeki sunucuya verilen (yok sayılması gereken) klasör
const MAIN_OUTBOX = process.env.MAIN_OUTBOX_DIR ?? ''; // ana test sunucusunun gerçekten kullandığı klasör
const SERVER_LOG = process.env.SERVER_MODE_LOG ?? 'server-mode.log';
const NAMES = ['DEMO_MODE', 'MAIL_OUTBOX_DIR', 'TRANSLATE_FAKE', 'COOKIE_SECURE'];
const INVITEE = 'sunucu-kipi@unsal.test';
const COOKIE = 'takip_session';

let api: APIRequestContext;
const sessions: Record<string, string> = {};

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const setCookies = (res: { headersArray(): { name: string; value: string }[] }) =>
  res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
const isSecure = (cookie: string) => /;\s*secure(;|$)/i.test(cookie);
/** Çerez kavanozuna güvenmeden: oturum anahtarı her istekte başlık olarak verilir */
const as = (base: string) => ({ cookie: `${COOKIE}=${sessions[base]}` });
async function actionOf(html: string, find: (chunk: string) => boolean): Promise<string> {
  const form = html.split('<form').find(find);
  const m = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form) : null;
  expect(m, 'sunucu işlemi alanı bulunamadı').toBeTruthy();
  return m![0];
}
/** Yönetici girişi (sunucu işlemine doğrudan istek); oturum çerezinin Set-Cookie satırını döndürür */
async function login(base: string, ip: string): Promise<string> {
  const html = await (await api.get(`${base}/login`, { headers: { cookie: '' } })).text();
  const field = await actionOf(html, (c) => c.includes('name="password"'));
  const res = await api.post(`${base}/login`, {
    multipart: { [field]: '', email: ADMIN, password: ADMIN_PW, lang: 'tr' }, headers: { origin: base, 'x-forwarded-for': ip, cookie: '' }, maxRedirects: 0,
  });
  expect(res.status(), `${base}: giriş yönlendirmesi`).toBe(303);
  const cookie = setCookies(res).find((c) => c.startsWith(`${COOKIE}=`));
  expect(cookie, `${base}: oturum çerezi`).toBeTruthy();
  sessions[base] = /^[^=]+=([^;]+)/.exec(cookie!)![1];
  return cookie!;
}

test.beforeAll(async () => {
  api = await playwrightRequest.newContext({ extraHTTPHeaders: { 'accept-language': 'tr-TR' } });
});
test.afterAll(async () => {
  await api.dispose();
  const db = await prisma();
  await db.userInvite.deleteMany({ where: { user: { email: INVITEE } } });
  await db.user.deleteMany({ where: { email: INVITEE } });
  await db.$disconnect();
});

test('giriş sayfası ve çerezler: demo kutusu yok; dil ve oturum çerezi Secure (ana test sunucusunda ayarlar geçerli)', async () => {
  // Demo kutusu: gerçek sunucu kipinde yok
  const loginHtml = await (await api.get(`${SERVER}/login`, { headers: { cookie: '' } })).text();
  expect(loginHtml).toContain('name="password"');
  for (const s of ['demo-accounts', 'yonetici@ornek.test', 'DEMO-GIRIS']) expect(loginHtml.includes(s), `giriş sayfasında "${s}"`).toBe(false);

  // Dil çerezi (oturumsuz GET): Secure
  const lang = await api.get(`${SERVER}/dil?l=ro&next=/login`, { maxRedirects: 0, headers: { cookie: '' } });
  expect(lang.status()).toBe(303);
  const langCookies = setCookies(lang);
  expect(langCookies.length).toBeGreaterThan(0);
  for (const c of langCookies) expect(isSecure(c), `dil çerezi Secure: ${c.split('=')[0]}`).toBe(true);

  // Oturum çerezi: Secure + HttpOnly
  const session = await login(SERVER!, '203.0.113.201');
  expect(isSecure(session), 'oturum çerezi Secure').toBe(true);
  expect(/;\s*httponly/i.test(session)).toBe(true);

  // Karşılaştırma — işaretsiz ana test sunucusu: COOKIE_SECURE=false bilerek geçerli (http:// ile uçtan uca testler)
  const mainLang = setCookies(await api.get(`${MAIN}/dil?l=ro&next=/login`, { maxRedirects: 0, headers: { cookie: '' } }));
  expect(mainLang.length).toBeGreaterThan(0);
  for (const c of mainLang) expect(isSecure(c), 'ana test sunucusu: dil çerezi Secure değil').toBe(false);
  expect(isSecure(await login(MAIN, '203.0.113.202')), 'ana test sunucusu: oturum çerezi Secure değil').toBe(false);
});

test('yönetici: /demo/posta 404, menüde demo yok; "Ortam uyarıları" kartı yalnızca dört adı gösterir; sahte çeviri kapalı', async () => {
  // Oturum geçerli (yönetici sayfası açılıyor) ama demo posta kutusu yok
  const page = await api.get(`${SERVER}/admin/entegrasyonlar`, { headers: as(SERVER!), maxRedirects: 0 });
  expect(page.status(), 'yönetici oturumu geçerli').toBe(200);
  const html = await page.text();
  const demo = await api.get(`${SERVER}/demo/posta`, { headers: as(SERVER!), maxRedirects: 0 });
  expect(demo.status(), '/demo/posta').toBe(404);
  expect(html.includes('/demo/posta'), 'menüde demo posta bağlantısı').toBe(false);

  // Kart: başlık + dört ad; değer / yol yok
  expect(html).toContain('id="ortam-uyarilari"');
  expect(html).toContain('Ortam uyarıları');
  const card = html.slice(html.indexOf('id="ortam-uyarilari"'), html.indexOf('id="ortam-uyarilari"') + 6000);
  for (const name of NAMES) expect(card.includes(`data-env-ignored="${name}"`), `kartta ${name}`).toBe(true);
  expect((html.match(/data-env-ignored="/g) ?? []).length).toBe(NAMES.length);
  expect(SERVER_OUTBOX.length, 'test: klasör yolu verilmiş olmalı').toBeGreaterThan(5);
  for (const secret of [SERVER_OUTBOX, path.basename(SERVER_OUTBOX), process.env.AUTH_SECRET ?? 'AUTH_SECRET-yok']) {
    expect(html.includes(secret), `sayfada değer / yol / sır yok: ${secret.slice(0, 12)}…`).toBe(false);
  }
  // Sahte çeviri kapalı: "TEST MODU" kartı yok
  expect(html.includes('TEST MODU'), 'TEST MODU').toBe(false);

  // Karşılaştırma — ana test sunucusu: uyarı kartı yok (hiçbir şey yok sayılmıyor), sahte çeviri bilerek açık
  const mainHtml = await (await api.get(`${MAIN}/admin/entegrasyonlar`, { headers: as(MAIN) })).text();
  expect(mainHtml.includes('id="ortam-uyarilari"'), 'ana test sunucusu: uyarı kartı yok').toBe(false);
  expect(mainHtml.includes('data-env-ignored='), 'ana test sunucusu: yok sayılan ayar yok').toBe(false);
  expect(mainHtml.includes('TEST MODU'), 'ana test sunucusu: sahte çeviri açık').toBe(true);
});

test('e-posta: gerçek sunucu kipinde diske yazılmaz ve "gönderildi" işaretlenmez; ana test sunucusunda klasöre yazılır', async () => {
  const db = await prisma();
  const firm = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  const user = await db.user.upsert({
    where: { email: INVITEE },
    create: { email: INVITEE, name: 'Sunucu Kipi', type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firm.customerId },
    update: { passwordHash: null, isActive: true },
  });
  const send = async (base: string) => {
    const html = await (await api.get(`${base}/admin/users`, { headers: as(base) })).text();
    const field = await actionOf(html, (c) => c.includes(`value="${user.id}"`) && /Davet gönder|Yeni kod gönder/.test(c));
    const res = await api.post(`${base}/admin/users`, { multipart: { [field]: '', id: user.id }, headers: { origin: base, ...as(base) }, maxRedirects: 0 });
    expect(res.status()).toBe(303);
    return res.headers().location ?? '';
  };
  const lastInvite = () => db.userInvite.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
  const filesIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

  // Gerçek sunucu kipi: MAIL_OUTBOX_DIR yok sayılır → SMTP yolu (bu makinede ayarlı değil) → gönderilemedi; diske yazılmadı
  const before = filesIn(SERVER_OUTBOX).length;
  expect(await send(SERVER!), 'gerçek sunucu kipi: e-posta gönderilemedi (SMTP ayarı yok)').toContain('error=mail');
  expect((await lastInvite()).sentAt, 'gönderildi işaretlenmedi').toBeNull();
  expect(filesIn(SERVER_OUTBOX).length, 'klasöre dosya yazılmadı').toBe(before);
  expect(before, 'klasör hiç kullanılmadı').toBe(0);

  // Karşılaştırma — ana test sunucusu: aynı işlem klasöre yazar ve "gönderildi" işaretler (test özelliği duruyor)
  expect(MAIN_OUTBOX.length, 'test: ana klasör yolu verilmiş olmalı').toBeGreaterThan(5);
  const mainBefore = filesIn(MAIN_OUTBOX).filter((f) => f.includes(INVITEE)).length;
  expect(await send(MAIN), 'ana test sunucusu: e-posta klasöre yazıldı').toContain('ok=invite');
  expect((await lastInvite()).sentAt).not.toBeNull();
  expect(filesIn(MAIN_OUTBOX).filter((f) => f.includes(INVITEE)).length).toBe(mainBefore + 1);
  expect(filesIn(SERVER_OUTBOX).length, 'gerçek sunucu kipinin klasörü yine boş').toBe(0);
  await db.$disconnect();
});

test('sunucu günlüğü: uyarı göze çarpar ve yalnızca dört adı içerir — klasör yolu ve sır yok; sunucu kapanmadı', async () => {
  const log = fs.readFileSync(SERVER_LOG, 'utf8');
  expect(log).toContain('GÜVENLİK UYARISI — test / geliştirme ayarları gerçek sunucuda YOK SAYILDI');
  for (const name of NAMES) expect(log.includes(`⚠ ${name}: gerçek sunucuda yok sayıldı`), `günlükte ${name}`).toBe(true);
  for (const secret of [SERVER_OUTBOX, path.basename(SERVER_OUTBOX), process.env.AUTH_SECRET ?? 'AUTH_SECRET-yok', process.env.DATABASE_URL ?? 'DATABASE_URL-yok']) {
    expect(log.includes(secret), `günlükte değer / yol / sır yok: ${secret.slice(0, 12)}…`).toBe(false);
  }
  // Uygulama kapanmadı: hâlâ yanıt veriyor
  expect((await api.get(`${SERVER}/login`, { headers: { cookie: '' } })).status()).toBe(200);
  expect((await api.get(`${SERVER}/surum`)).status()).toBe(200);
});
