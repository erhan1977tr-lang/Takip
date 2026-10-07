import { test, expect, type Browser, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, TEAM_PW, as, createUser, firstLogin, login, outboxCodeFor } from './helpers';

// Giriş / kod denemesi sınırı ve davet kodu deneme hakkı — AYNI ANDA gelen isteklerle aşılamaz (karar 148; güvenlik
// denetimi 3.50.9 AUD-10). Gerçek sunucuda, sunucu işlemlerine doğrudan (tarayıcı formu olmadan) paralel isteklerle:
//  - giriş: aynı e-posta + IP'den aynı anda 20 yanlış şifre → yalnızca 5'i doğrulanır, 15'i kilitli; veritabanında 5 hata
//  - kilit doğru şifreyi de açmaz; başka IP'den olağan giriş çalışır ve öteki IP'nin hatalarını silmez
//  - davet kodu: ayrı IP'lerden aynı anda 8 yanlış kod → davetin deneme sayısı tam 5 (8 değil); kilitli davette doğru kod
//    da reddedilir; yönetici yeni kod gönderince olağan ilk giriş çalışır ve doğru kod hata saymaz
// Sınırlar veritabanındadır (e-posta + IP). Bu dosya kendi kullanıcılarını ve kendi IP adreslerini (X-Forwarded-For —
// testte vekil yoktur) kullanır: öteki testlerin sayaçlarını etkilemez. E-posta gönderilmez (klasöre yazılır).
test.describe.configure({ mode: 'serial' });

const USER = 'yaris@unsal.test'; // şifresi olan kullanıcı (giriş yarışı)
const INVITED = 'yaris-davet@unsal.test'; // davet bekleyen kullanıcı (kod yarışı)
const IP_A = '203.0.113.60';
const IP_B = '203.0.113.61';
const SETUP = `/setup?email=${encodeURIComponent(INVITED)}`;

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
/** Verilen IP'den (X-Forwarded-For) gelen yeni bir tarayıcı oturumu */
async function from(browser: Browser, ip: string): Promise<Page> {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': ip } });
  return ctx.newPage();
}
async function actionField(page: Page, url: string, marker: string): Promise<string> {
  const html = await (await page.request.get(url)).text();
  const form = html.split('<form').find((chunk) => chunk.includes(marker));
  const m = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form) : null;
  expect(m, `sunucu işlemi alanı bulunamadı (${url}, ${marker})`).toBeTruthy();
  return m![0];
}
/** Sunucu işlemine doğrudan istek (tarayıcı formu olmadan), verilen IP'den; yanıtın vardığı adres döner */
async function post(page: Page, url: string, field: string, data: Record<string, string>, ip: string): Promise<URL> {
  const origin = new URL(page.url()).origin;
  const res = await page.request.post(url, { multipart: { [field]: '', ...data }, headers: { origin, 'x-forwarded-for': ip } });
  return new URL(res.url());
}
const tally = (list: (string | null)[], v: string) => list.filter((x) => x === v).length;

test('veri: şifresi olan bir kullanıcı ve davet bekleyen bir kullanıcı', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await createUser(admin, { email: USER, name: 'Yarış Kişi', role: 'Müşteri', firm: 'Ünsal Cam' });
  await createUser(admin, { email: INVITED, name: 'Yarış Davetli', role: 'Müşteri', firm: 'Ünsal Cam' });
  await admin.context().close();
  const fresh = await (await browser.newContext()).newPage();
  await firstLogin(fresh, USER, outboxCodeFor(USER), TEAM_PW);
  await fresh.context().close();
});

test('giriş: aynı anda 20 yanlış şifre → yalnızca 5 deneme doğrulanır; kilit doğru şifreyi de açmaz; başka IP\'den olağan giriş çalışır', async ({ browser }) => {
  const db = await prisma();
  const failures = (ip: string) => db.authFailure.findMany({ where: { email: USER, ip } });
  // Doğrudan istekler için yalın bir oturum: IP her istekte ayrıca verilir (post)
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  const field = await actionField(page, '/login', 'name="password"');
  // Aynı anda 20 istek, hepsi yanlış şifre
  const urls = await Promise.all(Array.from({ length: 20 }, (_, i) => post(page, '/login', field, { email: USER, password: `yanlis-sifre-${i}`, lang: 'tr' }, IP_A)));
  const errors = urls.map((u) => u.searchParams.get('error'));
  expect([tally(errors, 'invalid'), tally(errors, 'locked')], 'yalnızca 5 istek şifreyi denedi').toEqual([5, 15]);
  for (const u of urls) expect(u.pathname).toBe('/login');
  // Veritabanı: tam 5 hata (hepsi tamamlanmış — süren deneme kalmadı); denetim kaydında 5 hatalı giriş
  const rows = await failures(IP_A);
  expect(rows.map((r) => r.kind)).toEqual(['LOGIN', 'LOGIN', 'LOGIN', 'LOGIN', 'LOGIN']);
  expect(await db.auditLog.count({ where: { action: 'LOGIN_FAILED', user: { email: USER }, ip: IP_A } })).toBe(5);
  // Kilit sürerken doğru şifre de açmaz (şifre hiç denenmez); oturum açılmaz
  const locked = await post(page, '/login', field, { email: USER, password: TEAM_PW, lang: 'tr' }, IP_A);
  expect([locked.pathname, locked.searchParams.get('error')]).toEqual(['/login', 'locked']);
  await page.goto('/siparisler');
  await expect(page).toHaveURL(/\/login/);
  expect((await failures(IP_A)).length).toBe(5);
  await page.context().close();

  // Başka IP'den olağan giriş (ekrandan) çalışır; öteki IP'nin hataları silinmez, bu IP için hata kalmaz
  const other = await from(browser, IP_B);
  await login(other, USER, TEAM_PW);
  await expect(other).toHaveURL(/\/siparisler/);
  await other.context().close();
  expect([(await failures(IP_A)).length, (await failures(IP_B)).length]).toEqual([5, 0]);
  await db.$disconnect();
});

test('davet kodu: ayrı IP\'lerden aynı anda 8 yanlış kod → deneme sayısı tam 5; kilitli davette doğru kod da reddedilir; yeni kodla olağan ilk giriş çalışır', async ({ browser }) => {
  const db = await prisma();
  const user = await db.user.findUniqueOrThrow({ where: { email: INVITED } });
  const openInvite = () => db.userInvite.findFirstOrThrow({ where: { userId: user.id, usedAt: null }, orderBy: { createdAt: 'desc' } });
  const failures = () => db.authFailure.findMany({ where: { email: INVITED } });
  const code = outboxCodeFor(INVITED);
  const wrong: string[] = [];
  for (let i = 0; wrong.length < 8; i++) { const c = String(100000 + i * 7919).slice(0, 6); if (c !== code) wrong.push(c); }
  expect((await openInvite()).attempts).toBe(0);

  const page = await (await browser.newContext()).newPage();
  await page.goto(SETUP);
  const field = await actionField(page, SETUP, 'name="code"');
  // Aynı anda 8 yanlış kod, her biri ayrı IP'den (e-posta + IP sınırı devrede değil; e-posta sınırı 20'nin altında):
  // davetin kendi sınırı olmasa 8 kodun hepsi denenirdi
  const urls = await Promise.all(wrong.map((c, i) => post(page, '/setup', field, { email: INVITED, code: c }, `203.0.113.${70 + i}`)));
  expect(urls.map((u) => u.searchParams.get('error'))).toEqual(Array(8).fill('wrong_code'));
  expect((await openInvite()).attempts, 'davet başına en çok 5 deneme — paralel isteklerle de').toBe(5);
  expect((await failures()).map((r) => r.kind)).toEqual(Array(8).fill('CODE'));
  // Kilitli davette doğru kod da reddedilir: şifre adımına geçilmez
  const correct = await post(page, '/setup', field, { email: INVITED, code }, '203.0.113.90');
  expect(correct.searchParams.get('error')).toBe('wrong_code');
  expect((await page.context().cookies()).some((c) => c.name === 'takip_setup'), 'şifre adımı açılmadı').toBe(false);
  expect([(await openInvite()).attempts, (await failures()).length]).toEqual([5, 9]);
  await page.context().close();

  // Yönetici yeni kod gönderir → olağan ilk giriş (ekrandan) çalışır
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/users');
  await admin.locator('tr', { hasText: INVITED }).getByRole('button', { name: 'Yeni kod gönder' }).click();
  await expect(admin).toHaveURL(/ok=invite/);
  await admin.context().close();
  const next = outboxCodeFor(INVITED);
  const fresh = await from(browser, '203.0.113.91');
  await firstLogin(fresh, INVITED, next, TEAM_PW);
  await fresh.context().close();
  // Doğru kod hata saymadı: bu IP için kayıt yok; yeni davetin deneme sayısı 0; önceki 9 hata yerinde
  const all = await failures();
  expect([all.length, all.filter((r) => r.ip === '203.0.113.91').length]).toEqual([9, 0]);
  const used = await db.userInvite.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
  expect([used.attempts, used.usedAt !== null]).toEqual([0, true]);
  expect((await db.user.findUniqueOrThrow({ where: { email: INVITED } })).passwordHash).toBeTruthy();
  await db.$disconnect();
});
