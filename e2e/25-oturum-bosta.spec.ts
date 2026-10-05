import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, SALES, TEAM_PW, as } from './helpers';

// 30 dakika gerçek kullanıcı etkinliği olmayan oturum kapanır (karar 135) — tarayıcıda, beş rolle.
// GERÇEKTEN BEKLENMEZ. Zaman iki yerden ilerletilir:
//   - sunucu saati: oturumun son etkinlik anı veritabanında geriye alınır (30 dakika "geçmiş" olur);
//   - tarayıcı saati: Playwright'ın sahte saati (page.clock) — otomatik yenileme ve izleyici zamanlayıcıları çalışır.
// Kanıtlananlar: otomatik yenileme / yoklama / betik olayları oturumu uzatmaz; gerçek klavye / fare etkinliği uzatır;
// süre dolunca sayfa, API ve sunucu işlemi reddedilir; eski sekme girişe döner; çıkış çalışır; yetkiler aynıdır.
test.describe.configure({ mode: 'serial' });

const INSPECTOR = 'denetim@e2e.test';
const MIN = 60_000;
const ACTIVITY = '/oturum/etkinlik';
const FEED = '/bildirimler/akis';
const IDLE_TEXT = 'Güvenliğiniz için oturumunuz kapatıldı: 30 dakika boyunca işlem yapılmadı. Lütfen yeniden giriş yapın.';
const ROLES = [
  ['yönetici', ADMIN, ADMIN_PW], ['müşteri', CUSTOMER, CUST_PW], ['satış', SALES, TEAM_PW], ['çizim', DRAWER, TEAM_PW], ['denetimci', INSPECTOR, INSPECTOR_PW],
] as const;

let db: PrismaClient;
test.beforeAll(async () => {
  const { PrismaClient: Client } = await import('@prisma/client');
  db = new Client();
});
test.afterAll(async () => { await db.$disconnect(); });

/** Bu tarayıcının oturum satırı (çerezdeki değerin özeti) */
async function tokenHash(ctx: BrowserContext): Promise<string> {
  const cookie = (await ctx.cookies()).find((c) => c.name === 'takip_session');
  expect(cookie, 'oturum çerezi').toBeTruthy();
  return crypto.createHash('sha256').update(cookie!.value).digest('hex');
}
const row = (hash: string) => db.session.findUnique({ where: { tokenHash: hash } });
/** Sunucu saati ileri: son etkinlik anı `ms` kadar öncesine alınır */
async function idleFor(hash: string, ms: number): Promise<number> {
  const at = new Date(Date.now() - ms);
  await db.session.update({ where: { tokenHash: hash }, data: { lastSeenAt: at } });
  return at.getTime();
}
const seen = async (hash: string) => (await row(hash))!.lastSeenAt.getTime();
const isRsc = (url: string, headers: Record<string, string>) => url.includes('_rsc=') || headers.rsc === '1';
/** Etkinlik bildirimlerini toplar */
function watch(page: Page): string[] {
  const posts: string[] = [];
  page.on('request', (r) => { if (r.url().endsWith(ACTIVITY)) posts.push(r.postData() ?? ''); });
  return posts;
}
const activityReply = (page: Page) => page.waitForResponse((r) => r.url().endsWith(ACTIVITY) && r.request().method() === 'POST', { timeout: 15_000 });

test('beş rol: 30 dakika etkinlik yoksa oturum biter — eski sekme girişe döner, sayfa / API / sunucu işlemi reddedilir; yeniden girişte yetkiler aynı', async ({ browser }) => {
  for (const [who, email, pw] of ROLES) {
    // --- 1) Tek sekme: 29 dakika geçerli, 30. dakikada geçersiz
    const page = await as(browser, email, pw);
    const hash = await tokenHash(page.context());
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    // 29 dakika: oturum geçerli; sayfa yenileme ve bildirim akışı çalışır ama son etkinlik anını DEĞİŞTİRMEZ
    const at29 = await idleFor(hash, 29 * MIN);
    await page.reload();
    await expect(page, who).toHaveURL(/\/siparisler/);
    await expect(page.locator('h1').first()).toBeVisible();
    expect((await page.request.get(FEED)).status(), who).toBe(200);
    expect(await seen(hash), `${who}: yenileme / yoklama oturumu uzatmadı`).toBe(at29);
    // 30 dakika doldu (tarayıcı kapatılıp sonra dönülmüş gibi: arada açık panel sayfası yok): giriş sayfası + açıklama
    await page.goto('about:blank');
    await idleFor(hash, 30 * MIN + 2000);
    await page.goto('/siparisler');
    await expect(page, who).toHaveURL(/\/login\?info=idle$/);
    await expect(page.locator('.alert-info[data-info="idle"]')).toHaveText(IDLE_TEXT);
    expect(await row(hash), `${who}: geçersiz oturum satırı silindi`).toBeNull();
    // Korumalı sayfa, API ve dosya adresleri; etkinlik bildirimi biten oturumu canlandırmaz
    await page.goto('/siparisler');
    await expect(page).toHaveURL(/\/login/);
    expect((await page.request.get(FEED)).status(), who).toBe(401);
    expect((await page.request.get('/admin/katalog/excel', { maxRedirects: 0 })).status(), who).toBe(401);
    expect((await page.request.post(ACTIVITY, { headers: { 'x-takip-activity': '1' }, data: { idle: 0 } })).status(), who).toBe(401);
    expect(await db.session.count({ where: { tokenHash: hash } })).toBe(0);
    await page.context().close();

    // --- 2) Yeniden giriş: rolün yetkileri aynı (yönetici sayfası ve dosyası yalnızca yöneticiye açılır)
    const again = await as(browser, email, pw);
    const ctx = again.context();
    const hash2 = await tokenHash(ctx);
    expect(hash2).not.toBe(hash);
    // (sonraki adımın açık bırakılan sekmeleri şimdi açılır: sayfaları yüklenip etkileşime hazır olsun)
    const stale = await ctx.newPage();
    await stale.goto('/siparisler');
    let form: Page | null = null;
    if (email === ADMIN) { // yönetici: doldurulmuş ama gönderilmemiş bir form
      form = await ctx.newPage();
      await form.goto('/admin/katalog');
      await form.fill('#nameTr', 'BOSTA OTURUM CAMI');
      await form.fill('#nameRo', 'Sticla sesiune inactiva');
      await form.fill('#weightKgM2', '30');
    }
    await again.goto('/admin/users');
    if (email === ADMIN) await expect(again).toHaveURL(/\/admin\/users/);
    else await expect(again, `${who}: yönetici sayfası kapalı`).toHaveURL(/\/siparisler/);
    expect((await again.request.get('/admin/katalog/excel')).status(), who).toBe(email === ADMIN ? 200 : 404);

    // --- 3) Açık bırakılan sekmeler: süre dolduktan sonra sunucu işlemi kaydı değiştirmez, sekme girişe düşer
    await stale.waitForLoadState('networkidle');
    if (form) await form.waitForLoadState('networkidle');
    await idleFor(hash2, 31 * MIN);
    const other = user.language === 'tr' ? 'ro' : 'tr';
    await stale.locator('select.lang-select').selectOption(other);
    await expect(stale, `${who}: eski sekme`).toHaveURL(/\/login/);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).language, `${who}: sunucu işlemi reddedildi`).toBe(user.language);
    expect(await row(hash2)).toBeNull();
    if (form) {
      await form.getByRole('button', { name: 'Kataloğa ekle' }).click();
      await expect(form).toHaveURL(/\/login/);
      expect(await db.glassProduct.count({ where: { nameTr: 'BOSTA OTURUM CAMI' } }), 'doldurulmuş form kaydedilmedi').toBe(0);
    }
    await ctx.close();
  }
});

test('otomatik yenileme, bildirim yoklaması ve betik olayları oturumu uzatmaz; gerçek klavye / fare etkinliği uzatır; çalışan kullanıcı içeride kalır', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  const hash = await tokenHash(page.context());
  await page.clock.install();
  await page.goto('/siparisler');
  const posts = watch(page);
  const aged = await idleFor(hash, 20 * MIN);

  // Gerçek otomatik yenileme: ortak 60 saniyelik zamanlayıcı üç kez çalışır (sunucu bileşeni yeniden çizilir)
  for (let i = 0; i < 3; i++) {
    const refreshed = page.waitForResponse((r) => r.url().includes('/siparisler') && isRsc(r.url(), r.request().headers()), { timeout: 30_000 });
    await page.clock.runFor(61_000);
    expect((await refreshed).ok(), `otomatik yenileme ${i + 1}`).toBeTruthy();
  }
  // Bildirim yoklaması (zilin JSON akışı) ve doğrudan istek
  const polled = page.waitForResponse((r) => r.url().endsWith(FEED));
  await page.evaluate(() => window.dispatchEvent(new Event('takip:poll')));
  expect((await polled).status()).toBe(200);
  expect((await page.request.get(FEED)).status()).toBe(200);
  // Betiklerin ürettiği olaylar gerçek etkinlik değildir
  await page.evaluate(() => {
    for (const k of ['keydown', 'pointerdown', 'wheel', 'touchstart', 'touchmove']) window.dispatchEvent(new Event(k, { bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { screenX: 10, screenY: 10, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { screenX: 90, screenY: 70, bubbles: true }));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await page.clock.runFor(2000);
  expect(posts, 'etkinlik yokken hiç etkinlik isteği gitmez').toEqual([]);
  expect(await seen(hash), 'yenileme / yoklama / betik olayı son etkinlik anını değiştirmedi').toBe(aged);

  // Gerçek etkinlik: fare + klavye → tek bildirim, oturum uzar
  let reply = activityReply(page);
  await page.mouse.move(200, 200);
  await page.mouse.move(260, 240);
  await page.keyboard.press('Shift');
  const first = await reply;
  expect(first.status()).toBe(200);
  expect(((await first.json()) as { state: string }).state).toBe('active');
  expect(Date.now() - (await seen(hash)), 'son etkinlik anı şimdi').toBeLessThan(15_000);
  await page.mouse.move(300, 260);
  await page.keyboard.press('Shift');
  await page.clock.runFor(1000);
  expect(posts.length, 'aynı dakikadaki etkinlik tek bildirim').toBe(1);
  // Dakika dolunca bekleyen etkinlik TEK bildirimle, etkinliğin yaşıyla gider (bildirimin gittiği an değil)
  reply = activityReply(page);
  await page.clock.runFor(61_000);
  expect((await reply).status()).toBe(200);
  expect(posts.length).toBe(2);
  const age = (JSON.parse(posts[1]) as { idle: number }).idle;
  expect(age).toBeGreaterThan(30_000);
  expect(age).toBeLessThanOrEqual(61_000);
  await page.clock.runFor(61_000);
  expect(posts.length, 'etkinlik bitince istek de biter').toBe(2);

  // Çalışan kullanıcı: üç kez "25 dakika geçti → etkinlik" (75 dakika) — oturum hep geçerli
  for (let i = 0; i < 3; i++) {
    await idleFor(hash, 25 * MIN);
    await page.clock.runFor(61_000); // otomatik yenileme: izleyici kalan süreyi (5 dk) sunucudan öğrenir, uzatmaz
    expect(Date.now() - (await seen(hash)), `tur ${i + 1}: yenileme uzatmadı`).toBeGreaterThan(24 * MIN);
    reply = activityReply(page);
    await page.keyboard.press('Shift');
    expect((await reply).status(), `tur ${i + 1}`).toBe(200);
    expect(Date.now() - (await seen(hash)), `tur ${i + 1}: etkinlik uzattı`).toBeLessThan(15_000);
  }
  await page.reload();
  await expect(page).toHaveURL(/\/siparisler/);

  // Etkinlik bitti: sekme açık, otomatik yenileme sürüyor — 30 dakika sonra bir sonraki yenileme girişe götürür
  await idleFor(hash, 30 * MIN + 2000);
  await page.clock.runFor(61_000);
  await expect(page).toHaveURL(/\/login\?info=idle$/, { timeout: 15_000 });
  await expect(page.locator('.alert-info[data-info="idle"]')).toHaveText(IDLE_TEXT);
  expect(await row(hash)).toBeNull();
  await page.context().close();
});

test('form doldurulup bırakılan sekme: otomatik yenileme durmuşken de 30 dakikanın sonunda kendiliğinden giriş sayfasına gider', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  const hash = await tokenHash(page.context());
  await page.clock.install();
  await page.goto('/admin/katalog');
  const posts = watch(page);
  // Yazı yazmak gerçek etkinliktir (bildirilir); form "dolu" olduğundan otomatik yenileme sayfayı yenilemez
  await page.waitForLoadState('networkidle');
  const reply = activityReply(page);
  await page.locator('#nameTr').pressSequentially('YARIM KALAN CAM', { delay: 60 });
  expect((await reply).status()).toBe(200);
  expect(Date.now() - (await seen(hash))).toBeLessThan(15_000);
  // Bekleyen son tuş vuruşları dakika dolunca bildirilir; sonrası sessizlik
  const trailing = activityReply(page);
  await page.clock.runFor(61_000);
  expect((await trailing).status()).toBe(200);
  const before = posts.length;
  expect(before).toBe(2);
  // 30 dakika (sunucu + tarayıcı saati) hiçbir etkinlik yok
  await idleFor(hash, 30 * MIN + 2000);
  await page.clock.fastForward(31 * MIN);
  await expect(page).toHaveURL(/\/login\?info=idle$/, { timeout: 15_000 });
  await expect(page.locator('.alert-info[data-info="idle"]')).toHaveText(IDLE_TEXT);
  expect(await row(hash)).toBeNull();
  // 30 dakika boyunca tek istek: süre dolunca sorulan soru (uzatmayan, yaş ≥ 30 dakika)
  const later = posts.slice(before).map((p) => (JSON.parse(p) as { idle: number }).idle);
  expect(later.length).toBeLessThanOrEqual(1);
  for (const idle of later) expect(idle).toBeGreaterThanOrEqual(30 * MIN);
  expect(await db.glassProduct.count({ where: { nameTr: 'YARIM KALAN CAM' } })).toBe(0);
  await page.context().close();
});

test('çok sekme: bir sekmedeki gerçek etkinlik aynı oturumu canlı tutar; arka plandaki sekmeler uzatmaz; çıkış bütün sekmeleri kapatır', async ({ browser }) => {
  const a = await as(browser, SALES, TEAM_PW);
  const ctx = a.context();
  const hash = await tokenHash(ctx);
  const b = await ctx.newPage();
  await b.goto('/siparisler');
  const postsB = watch(b);
  const postsA = watch(a);
  /** B sekmesinin arka plan istekleri: sayfa yenileme + bildirim yoklaması */
  const background = async () => {
    await b.reload();
    await expect(b).toHaveURL(/\/siparisler/);
    expect((await b.request.get(FEED)).status()).toBe(200);
    await b.evaluate(() => window.dispatchEvent(new Event('takip:poll')));
  };

  // 20 dakika geçti; B'de yalnızca arka plan istekleri → uzatmaz
  const aged = await idleFor(hash, 20 * MIN);
  await background();
  await background();
  expect(await seen(hash), 'arka plan sekmesi uzatmadı').toBe(aged);
  // A'da gerçek etkinlik → oturum (iki sekme için de) uzar
  await a.bringToFront();
  const reply = activityReply(a);
  await a.keyboard.press('Shift');
  expect((await reply).status()).toBe(200);
  expect(Date.now() - (await seen(hash))).toBeLessThan(15_000);
  expect(postsA.length).toBe(1);
  await background();

  // İki sekme de açık ama dokunulmuyor: arka plan istekleri sürse de 30 dakikada oturum biter (kalıcı oturum yok)
  const again = await idleFor(hash, 29 * MIN);
  await background();
  await a.reload();
  await expect(a).toHaveURL(/\/siparisler/);
  expect(await seen(hash)).toBe(again);
  expect(postsB, 'dokunulmayan sekme hiç etkinlik isteği yollamadı').toEqual([]);
  expect(postsA.length).toBe(1);
  await idleFor(hash, 30 * MIN + 2000);
  await a.reload();
  await expect(a).toHaveURL(/\/login/);
  await b.reload();
  await expect(b).toHaveURL(/\/login/);
  expect(await row(hash)).toBeNull();
  await ctx.close();

  // Çıkış: bir sekmeden çıkınca oturum satırı silinir; öbür sekme korumalı hiçbir şeye erişemez, etkinliği oturumu geri getirmez
  const c = await as(browser, SALES, TEAM_PW);
  const ctx2 = c.context();
  const hash2 = await tokenHash(ctx2);
  const d = await ctx2.newPage();
  await d.goto('/siparisler');
  await c.bringToFront();
  await c.getByRole('button', { name: 'Çıkış' }).click();
  await expect(c).toHaveURL(/\/login\?info=logout$/);
  await expect(c.getByText('Çıkış yaptınız.')).toBeVisible();
  expect(await row(hash2), 'çıkış oturum satırını sildi').toBeNull();
  expect((await d.request.get(FEED)).status()).toBe(401);
  await d.bringToFront();
  const gone = activityReply(d);
  await d.keyboard.press('Shift');
  expect((await gone).status(), 'çıkıştan sonra etkinlik oturum açmaz').toBe(401);
  await expect(d).toHaveURL(/\/login$/);
  expect(await db.session.count({ where: { tokenHash: hash2 } })).toBe(0);
  await ctx2.close();
});

test('etkinlik adresi: yalnızca aynı siteden, özel başlıkla, POST ile; "boştayım" sorusu ve bozuk gövde uzatmaz; oturumsuz istek reddedilir', async ({ browser, playwright }) => {
  const page = await as(browser, CUSTOMER, CUST_PW);
  const hash = await tokenHash(page.context());
  const aged = await idleFor(hash, 10 * MIN);
  const post = (headers: Record<string, string>, data: unknown) => page.request.post(ACTIVITY, { headers, data });
  const H = { 'x-takip-activity': '1' };
  expect((await post({}, { idle: 0 })).status(), 'özel başlık yok').toBe(403);
  expect((await post({ ...H, origin: 'https://kotu.example' }, { idle: 0 })).status(), 'başka site').toBe(403);
  expect((await post({ ...H, 'sec-fetch-site': 'cross-site' }, { idle: 0 })).status(), 'başka site (Sec-Fetch-Site)').toBe(403);
  expect((await page.request.get(ACTIVITY, { headers: H })).status(), 'GET ile kayıt değişmez').toBe(405);
  for (const body of [{ idle: '0' }, { idle: null }, { idle: -1 }, {}, []]) expect((await post(H, body)).status(), JSON.stringify(body)).toBe(400);
  // "Boştayım" sorusu (yaş ≥ 30 dakika): yanıt verir, uzatmaz
  const ask = await post(H, { idle: 30 * MIN });
  expect(ask.status()).toBe(200);
  const left = ((await ask.json()) as { state: string; remainingMs: number }).remainingMs;
  expect(left).toBeGreaterThan(19 * MIN);
  expect(left).toBeLessThanOrEqual(20 * MIN);
  expect(await seen(hash), 'reddedilen ve uzatmayan isteklerin hiçbiri son etkinlik anını değiştirmedi').toBe(aged);
  // Geçerli bildirim (etkinliğin yaşıyla): an 5 saniye öncesi olarak yazılır
  expect((await post(H, { idle: 5000 })).status()).toBe(200);
  const now = await seen(hash);
  expect(Date.now() - now).toBeGreaterThanOrEqual(5000);
  expect(Date.now() - now).toBeLessThan(20_000);
  // Oturumsuz istek
  const anon = await playwright.request.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3000' });
  expect((await anon.post(ACTIVITY, { headers: H, data: { idle: 0 } })).status(), 'oturumsuz').toBe(401);
  await anon.dispose();
  await page.context().close();
});
