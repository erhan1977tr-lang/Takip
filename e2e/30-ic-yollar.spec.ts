import { test, expect, type APIResponse, type BrowserContext } from '@playwright/test';
import type { PrismaClient } from '@prisma/client';
import { CUSTOMER, CUST_PW, as } from './helpers';

// Uygulama içi yol kuralı (güvenlik denetimi AUD-6 + bildirim bağlantısı maddesi, karar 145): /dil yönlendirmesinin
// dönüş adresi ve bildirim bağlantısı aynı doğrulayıcıdan geçer (server/security/internal-path.js). Tarayıcı sekme /
// satır sonu karakterlerini adresten atar ve ters bölüyü bölü sayar; "/<sekme>/kotu.example" eski denetimden geçip
// kullanıcıyı başka siteye gönderiyordu.
// Bu testlerde site dışına HİÇBİR istek gitmez: yönlendirmeler izlenmeden (maxRedirects: 0) başlığa bakılır; tarayıcıyla
// yapılan denemelerde site dışı her istek durdurulur ve sayılır (evil.example ayrılmış bir addır, çözülmez).
test.describe.configure({ mode: 'serial' });

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const ORIGIN = new URL(BASE).origin;

let db: PrismaClient;
test.beforeAll(async () => {
  const { PrismaClient: Client } = await import('@prisma/client');
  db = new Client();
});
test.afterAll(async () => { await db.$disconnect(); });

const cookies = (res: APIResponse) => res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value).join('\n');
/** Site dışına giden her isteği durdurur ve kaydeder (gerçek ağa çıkılmaz) */
async function guard(ctx: BrowserContext): Promise<string[]> {
  const outside: string[] = [];
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (new URL(url).origin === ORIGIN) return route.continue();
    outside.push(url);
    return route.abort();
  });
  return outside;
}

// Yolun aldığı (bir kez çözülmüş) değerler: hepsi reddedilir
const HOSTILE = [
  '//evil.example', '///evil.example', '/\\evil.example', '/\\\\evil.example', '/\\/evil.example',
  '/\t/evil.example', '/\t\\evil.example', '/\t\t/evil.example', '\t//evil.example', '/\n/evil.example', '/\r/evil.example', '/\r\n/evil.example', '/\r\n\\evil.example',
  '/login\r\nSet-Cookie: x=1', '/login\nLocation: https://evil.example',
  '/\0/evil.example', '/\x0b/evil.example', '/\x0c/evil.example', '/\x1f/evil.example', '/\x7f/evil.example', '/ /evil.example', '/login ',
  '/.//evil.example', '/a/..//evil.example', '/%2e%2e//evil.example',
  'https://evil.example', 'https:evil.example', 'javascript:alert(1)', 'data:text/html,x',
  '//user@evil.example', '//takip.test@evil.example', '/\\takip.test@evil.example', 'https://takip.test@evil.example/',
  '/ /evil.example', '/ /evil.example', '/／evil.example', '/ş', 'login', '', `/${'a'.repeat(2000)}`,
];
// Geçerli dönüş adresleri: sorgu ve parça bayt bayt aynı döner
const VALID = [
  '/login', '/login?email=a%40b.ro', "/login?email=o'brien%40x.ro&x=1", '/login?email=user%2Btag%40gmail.com', '/login?error=locked&m=15',
  '/setup?email=x%40y.ro', '/depo/AbC-_123', '/siparisler', '/siparisler/cmgabc123?ok=created#finans',
  '/yuklemeler?gun=2026-10-06#yuklenmeyen', '/admin/muhasebe/cam/proforma?musteri=cmgabc#partiler', '/belgeler#doc-cmgabc',
];

test('/dil: saldırgan "next" → 303 Location /login (dil çerezi yine yazılır); geçerli yol sorgu ve parçasıyla aynen döner', async ({ request }) => {
  for (const [i, v] of HOSTILE.entries()) {
    const l = i % 2 ? 'tr' : 'ro';
    const res = await request.get(`/dil?l=${l}&next=${encodeURIComponent(v)}`, { maxRedirects: 0 });
    expect(res.status(), JSON.stringify(v)).toBe(303);
    expect(res.headers().location, JSON.stringify(v)).toBe('/login');
    // Dönüş adresi reddedilse de dil değişir
    expect(cookies(res), JSON.stringify(v)).toContain(`takip_lang=${l}`);
    expect(cookies(res), JSON.stringify(v)).not.toContain('evil');
  }
  // Adrese yazıldığı biçimiyle (yüzde kodlu) saldırı değerleri — denetimde tarayıcıyı dışarı gönderdiği doğrulanan ikisi başta
  for (const raw of ['/%09/evil.example', '/%09%5cevil.example', '%2f%09%2fevil.example', '/%09%09/evil.example', '/%5cevil.example', '//evil.example', '/%0a/evil.example',
    '/%0d%0aSet-Cookie:%20x=1', '/%00/evil.example', '/+/evil.example', '/%E2%80%A8/evil.example']) {
    const res = await request.get(`/dil?l=ro&next=${raw}`, { maxRedirects: 0 });
    expect([res.status(), res.headers().location], raw).toEqual([303, '/login']);
    expect(cookies(res), raw).toContain('takip_lang=ro');
  }
  // Çift kodlanmış değer bir kez çözülür; kalan yüzde kodu sitenin kendi yoludur (yeniden çözülmez) → aynen
  for (const [raw, want] of [['/%2509/evil.example', '/%09/evil.example'], ['/%255cevil.example', '/%5cevil.example']]) {
    const res = await request.get(`/dil?l=ro&next=${raw}`, { maxRedirects: 0 });
    expect([res.status(), res.headers().location], raw).toEqual([303, want]);
  }
  // Geçerli yollar: bayt bayt aynı (giriş sayfasının ürettiği bağlantı biçimiyle — encodeURIComponent)
  for (const v of VALID) {
    const res = await request.get(`/dil?l=tr&next=${encodeURIComponent(v)}`, { maxRedirects: 0 });
    expect([res.status(), res.headers().location], v).toEqual([303, v]);
    expect(cookies(res), v).toContain('takip_lang=tr');
  }
  // "next" yok → /login; dil geçersiz / yok → çerez yazılmaz (davranış aynı)
  const none = await request.get('/dil?l=ro', { maxRedirects: 0 });
  expect([none.status(), none.headers().location]).toEqual([303, '/login']);
  for (const q of ['/dil?next=/%09/evil.example', '/dil?l=xx&next=/%09/evil.example', '/dil?l=xx&next=/login']) {
    const res = await request.get(q, { maxRedirects: 0 });
    expect([res.status(), res.headers().location], q).toEqual([303, '/login']);
    expect(cookies(res), q).not.toContain('takip_lang');
  }
});

test('/dil tarayıcıda: saldırgan bağlantı giriş sayfasında kalır (site dışına istek yok); giriş sayfasındaki dil düğmesi e-postayı koruyarak aynı sayfaya döner', async ({ context, page }) => {
  const outside = await guard(context);
  for (const raw of ['/%09/evil.example', '/%09%5cevil.example', '//evil.example', '/%5cevil.example', '/.//evil.example']) {
    await page.goto(`/dil?l=ro&next=${raw}`);
    await expect(page, raw).toHaveURL(`${ORIGIN}/login`);
    await expect(page.locator('html'), raw).toHaveAttribute('lang', 'ro');
  }
  expect(outside, 'site dışına istek').toEqual([]);
  // Geçerli dönüş (dil değiştirme bozulmadı): yazılan e-posta sorguda aynen kalır
  await page.goto('/login?email=a%40b.ro');
  await page.locator('.lang-switch a[hreflang="tr"]').click();
  await expect(page).toHaveURL(`${ORIGIN}/login?email=a%40b.ro`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(page.locator('#email')).toHaveValue('a@b.ro');
  await page.locator('.lang-switch a[hreflang="ro"]').click();
  await expect(page).toHaveURL(`${ORIGIN}/login?email=a%40b.ro`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ro');
  expect(outside).toEqual([]);
});

test('bildirim bağlantısı: kayıttaki güvensiz bağlantı bağlantısız gösterilir (akışta link: null, dış bağlantı / gezinme yok); geçerli uygulama içi bağlantı çalışır', async ({ browser }) => {
  const user = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  const order = await db.order.findFirstOrThrow({ where: { customerId: user.customerId!, orderTypeCode: 'GLASS_ORDER', removedAt: null }, orderBy: { createdAt: 'desc' } });
  const good = `/siparisler/${order.id}#finans`;
  const unsafe = ['/\\evil.example', '/\t/evil.example', '/\t\\evil.example', '/\n\\evil.example', '//evil.example', 'https://evil.example/x', '/.//evil.example'];
  await db.notification.deleteMany({ where: { userId: user.id, dedupeKey: { startsWith: 'e2e:path:' } } });
  const mk = (key: string, link: string) => db.notification.create({
    data: { userId: user.id, type: 'ORDER_OFFER_UPDATED', message: 'e2e', params: { aud: 'customer', orderNo: order.orderNo }, link, orderId: order.id, dedupeKey: `e2e:path:${key}` },
  });
  const bad: { id: string; link: string | null }[] = [];
  for (const [i, link] of unsafe.entries()) bad.push(await mk(`bad${i}`, link));
  const ok = await mk('good', good);
  const page = await as(browser, CUSTOMER, CUST_PW);
  try {
    const outside = await guard(page.context());
    // Akış (JSON): güvensiz bağlantı null, geçerli bağlantı aynen
    const feed = await (await page.request.get('/bildirimler/akis')).json() as { items: { id: string; link: string | null }[] };
    const links = new Map(feed.items.map((x): [string, string | null] => [x.id, x.link]));
    for (const b of bad) expect(links.get(b.id), JSON.stringify(b.link)).toBeNull();
    expect(links.get(ok.id)).toBe(good);
    // Sayfa: ham yanıtta (HTML + sunucu bileşeni verisi) reddedilen adresin izi yok
    expect(await (await page.request.get('/siparisler')).text()).not.toContain('evil.example');
    await page.goto('/siparisler');
    await page.locator('.notif-bell').click();
    const item = (id: string) => page.locator(`.notif-panel .notif-item[data-id="${id}"]`);
    for (const b of bad) {
      await expect(item(b.id), JSON.stringify(b.link)).toBeVisible();
      await expect(item(b.id).locator('a'), JSON.stringify(b.link)).toHaveCount(0);
      await expect(item(b.id).locator('div.notif-main .notif-title')).toBeVisible();
    }
    await expect(page.locator('a[href*="evil.example"]')).toHaveCount(0);
    expect(await page.content()).not.toContain('evil.example');
    // Bağlantısız bildirime tıklamak hiçbir yere götürmez
    await item(bad[0].id).locator('div.notif-main').click();
    await item(bad[1].id).locator('div.notif-main').click();
    await expect(page).toHaveURL(`${ORIGIN}/siparisler`);
    expect(outside, 'site dışına istek').toEqual([]);
    // Geçerli bağlantı: aynen yazılır, tıklanınca okundu olur ve sipariş sayfası (parçasıyla) açılır
    await expect(item(ok.id).locator('a.notif-main')).toHaveAttribute('href', good);
    await item(ok.id).locator('a.notif-main').click();
    await expect(page).toHaveURL(`${ORIGIN}${good}`);
    await expect.poll(async () => (await db.notification.findUniqueOrThrow({ where: { id: ok.id } })).isRead).toBe(true);
    expect((await db.notification.findUniqueOrThrow({ where: { id: bad[0].id } })).isRead, 'bağlantısız bildirim tıklamayla okundu olmaz').toBe(false);
    expect(outside).toEqual([]);
  } finally {
    await db.notification.deleteMany({ where: { userId: user.id, dedupeKey: { startsWith: 'e2e:path:' } } });
    await page.context().close();
  }
});
