import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as, newOrder } from './helpers';

// Gövde kapısı (karar 143) — uygulamadaki adres (GET /oturum/govde-izni), tarayıcının gerçek oturumlarıyla.
// Üretimde bu adresi yalnızca Caddy sorar (büyük gövdeyi uygulamaya iletmeden önce; dışarıya 404 verir). Burada vekil yok:
// adres doğrudan sorulur ve Caddy'nin yazdığı başlık (X-Forwarded-Uri: özgün adres) elle verilir. Kanıtlananlar:
//   - oturum yoksa izin yok; beş rolün geçerli oturumu yükleme sayfalarında izin alır; bilinmeyen adreste izin yok
//   - kapı salt okunurdur: oturumu uzatmaz, boşta kalmış oturumun satırını ve çerezini silmez
//   - kapı yetkilendirme değildir ve siparişin var olup olmadığını söylemez; asıl denetim sayfada / işlemdedir
//   - adres yalnızca GET'tir (HEAD dahil); POST / PUT / PATCH / DELETE 405
// Gerçek Caddy arkasındaki davranış (iletilen bayt, kapalı tarafa düşme): deploy/test/body-gate.sh.
test.describe.configure({ mode: 'serial' });

const INSPECTOR = 'denetim@e2e.test';
const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)
const MIN = 60_000;
const GATE = '/oturum/govde-izni';
const ALLOW = { status: 204, header: 'izin', body: '' };
const DENY = { status: 401, header: null, body: '' };
const ROLES = [
  ['yönetici', ADMIN, ADMIN_PW], ['müşteri', CUSTOMER, CUST_PW], ['satış', SALES, TEAM_PW], ['çizim', DRAWER, TEAM_PW], ['denetimci', INSPECTOR, INSPECTOR_PW],
] as const;
const UPLOAD_PAGES = ['/siparisler/yeni', '/siparisler/yeni?tip=GLASS_ORDER', '/admin/fiyatlar', '/admin/musteri-fiyatlari', '/admin/katalog', '/admin/profil-katalogu', '/admin/stok'];
const OTHER = ['/', '/login', '/setup', '/siparisler', '/yuklemeler', '/admin/users', '/depo', '/oturum/govde-izni', '/SIPARISLER/yeni', '//siparisler/yeni', '/siparisler/%79eni', '/siparisler/../admin/users'];

let db: PrismaClient;
test.beforeAll(async () => {
  const { PrismaClient: Client } = await import('@prisma/client');
  db = new Client();
});
test.afterAll(async () => { await db.$disconnect(); });

/** Kapıya, Caddy'nin soracağı biçimde sor (özgün adres başlıkta; çerezler bu tarayıcının) */
async function ask(page: Page, uri: string | null, method: 'GET' | 'HEAD' = 'GET') {
  const r = await page.request.fetch(GATE, { method, headers: uri === null ? {} : { 'x-forwarded-uri': uri } });
  return { status: r.status(), header: r.headers()['x-takip-govde'] ?? null, body: await r.text() };
}
async function tokenHash(ctx: BrowserContext): Promise<string> {
  const cookie = (await ctx.cookies()).find((c) => c.name === 'takip_session');
  expect(cookie, 'oturum çerezi').toBeTruthy();
  return crypto.createHash('sha256').update(cookie!.value).digest('hex');
}
const row = (hash: string) => db.session.findUnique({ where: { tokenHash: hash } });

test('oturum yoksa izin yok; beş rolün geçerli oturumu yükleme sayfalarında izin alır; bilinmeyen adreste izin yok; adres yalnızca GET', async ({ browser }) => {
  // Giriş yapmamış tarayıcı
  const anon = await (await browser.newContext()).newPage();
  for (const uri of [...UPLOAD_PAGES, '/siparisler/cmyoksiparis0000000000000', ...OTHER]) expect(await ask(anon, uri), `oturumsuz ${uri}`).toEqual(DENY);
  expect(await ask(anon, null)).toEqual(DENY);
  // Uydurma çerez
  await anon.context().addCookies([{ name: 'takip_session', value: crypto.randomBytes(32).toString('base64url'), url: process.env.E2E_BASE_URL || 'http://127.0.0.1:3000' }]);
  expect(await ask(anon, '/siparisler/yeni')).toEqual(DENY);
  await anon.context().close();

  for (const [who, email, pw] of ROLES) {
    const page = await as(browser, email, pw);
    const hash = await tokenHash(page.context());
    const before = await row(hash);
    for (const uri of UPLOAD_PAGES) expect(await ask(page, uri), `${who} ${uri}`).toEqual(ALLOW);
    for (const uri of OTHER) expect(await ask(page, uri), `${who} ${uri}`).toEqual(DENY);
    expect(await ask(page, null), who).toEqual(DENY);
    // Yanıt önbelleğe alınmaz; HEAD de yalnızca okur; gövdesi yoktur
    const res = await page.request.get(GATE, { headers: { 'x-forwarded-uri': '/siparisler/yeni' } });
    expect(res.headers()['cache-control']).toBe('no-store');
    expect((await ask(page, '/siparisler/yeni', 'HEAD')).status).toBe(204);
    // Yalnızca GET: gövdeli yöntemler 405 (gövde okunmaz, izin başlığı dönmez)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await page.request.fetch(GATE, { method, headers: { 'x-forwarded-uri': '/siparisler/yeni', 'content-type': 'application/octet-stream' }, data: Buffer.alloc(300_000, 0x20) });
      expect(r.status(), `${who} ${method}`).toBe(405);
      expect(r.headers()['x-takip-govde']).toBeUndefined();
    }
    // Onlarca sorudan sonra oturum satırı birebir aynı (kapı oturumu uzatmaz, hiçbir şey yazmaz)
    expect(await row(hash), who).toEqual(before);
    await page.context().close();
  }
});

test('kapı salt okunur: boşta kalmış oturuma izin vermez ama satırını ve çerezini silmez; çıkıştan sonra izin yok', async ({ browser }) => {
  const page = await as(browser, CUSTOMER, CUST_PW);
  const ctx = page.context();
  const hash = await tokenHash(ctx);
  expect(await ask(page, '/siparisler/yeni')).toEqual(ALLOW);
  // 29 dakika: hâlâ geçerli; kapı son etkinlik anını değiştirmez
  const at29 = new Date(Date.now() - 29 * MIN);
  await db.session.update({ where: { tokenHash: hash }, data: { lastSeenAt: at29 } });
  for (let i = 0; i < 10; i++) expect(await ask(page, '/siparisler/yeni')).toEqual(ALLOW);
  expect((await row(hash))!.lastSeenAt.getTime()).toBe(at29.getTime());
  // 30 dakika doldu: kapı izin vermez — ama oturum satırı ve çerez YERİNDE (kapı silmez; silmek asıl oturum okumasının işi)
  await page.goto('about:blank');
  const at31 = new Date(Date.now() - 31 * MIN);
  await db.session.update({ where: { tokenHash: hash }, data: { lastSeenAt: at31 } });
  for (let i = 0; i < 5; i++) expect(await ask(page, '/siparisler/yeni')).toEqual(DENY);
  expect((await row(hash))!.lastSeenAt.getTime()).toBe(at31.getTime());
  expect((await ctx.cookies()).some((c) => c.name === 'takip_session')).toBe(true);
  // Asıl denetim olduğu gibi çalışır: sayfa girişe yollar ve geçersiz satırı siler
  await page.goto('/siparisler');
  await expect(page).toHaveURL(/\/login\?info=idle$/);
  expect(await row(hash)).toBeNull();
  expect(await ask(page, '/siparisler/yeni')).toEqual(DENY);
  await ctx.close();

  // Çıkış: oturum satırı silinir → kapı kapanır
  const again = await as(browser, CUSTOMER, CUST_PW);
  expect(await ask(again, '/siparisler/yeni')).toEqual(ALLOW);
  const hash2 = await tokenHash(again.context());
  await db.session.deleteMany({ where: { tokenHash: hash2 } });
  expect(await ask(again, '/siparisler/yeni')).toEqual(DENY);
  await again.context().close();
});

test('kapı yetkilendirme değildir ve siparişin varlığını söylemez: asıl denetim sayfada / işlemde kalır', async ({ browser }) => {
  // Müşterinin kendi siparişi
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const own = `/siparisler/${await newOrder(cust, 'Kapı denemesi', 'kapi.pdf')}`;
  // Başka firmanın bir siparişi (veritabanından) ve var olmayan bir sipariş
  const me = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  const foreign = await db.order.findFirst({ where: { customerId: { not: me.customerId! }, orderTypeCode: 'GLASS_ORDER' } });
  const paths = [own, `/siparisler/${foreign?.id ?? 'cmbaskafirma00000000000000'}`, '/siparisler/cmyoksiparis0000000000000'];
  // Geçerli oturum: üçü de aynı yanıt (kapı siparişe bakmaz) — oturumsuz: üçü de aynı yanıt (var / yok ayırt edilemez)
  for (const p of paths) expect(await ask(cust, p), p).toEqual(ALLOW);
  const anon = await (await browser.newContext()).newPage();
  for (const p of paths) expect(await ask(anon, p), p).toEqual(DENY);
  await anon.context().close();
  // Asıl denetim: müşteri başka firmanın siparişini / olmayan siparişi AÇAMAZ (kapının izni bunu değiştirmez)
  for (const p of paths.slice(1)) {
    const res = await cust.request.get(p, { maxRedirects: 0 });
    expect([302, 303, 307, 308, 404], `${p} → ${res.status()}`).toContain(res.status());
    await cust.goto(p);
    await expect(cust.locator('input[name=files]')).toHaveCount(0);
  }
  // Kendi siparişinde dosya ekleme formu var; denetimci aynı sayfayı görür ama formu yoktur (salt okunur rol) — kapı ikisine de izin verir
  await cust.goto(own);
  await expect(cust.locator('input[name=files]').first()).toBeVisible();
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  expect(await ask(insp, own)).toEqual(ALLOW);
  await insp.goto(own);
  await expect(insp.locator('h1').first()).toBeVisible();
  await expect(insp.locator('input[type=file]')).toHaveCount(0);
  await insp.context().close();
  await cust.context().close();
});
