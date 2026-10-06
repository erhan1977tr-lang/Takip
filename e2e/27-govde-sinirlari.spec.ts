import { test, expect, type Page, type Request } from '@playwright/test';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, sampleFile } from './helpers';
import { readCaddyfile } from '../test/caddyfile.js';

// İstek gövdesi sınırları (AUD-4, karar 141) ve gövde kapısı (karar 143). Vekil (deploy/Caddyfile) büyük gövdeye yalnızca
// dosya yükleme formu olan SAYFALARIN adresinde ve yalnızca kapıdan geçen isteğe izin verir. Bu test, tarayıcının sunucu
// işlemlerini (Server Actions) gerçekten hangi adrese, hangi boyda POST ettiğini kaydeder: işlem, formun bulunduğu sayfanın
// adresine gider (ayrı bir yükleme adresi yoktur); her gövde o isteğin Caddyfile'daki kademesine sığar; büyük gövdeli
// yükleme kapıya sorulacak istektir ve kapı bu tarayıcının oturumuna izin verir; küçük işlemler kapıya hiç sorulmaz.
// (Uçtan uca testler Caddy'siz çalışır; Caddy'nin kendisi sunucu kurulumu testinde: deploy/test/body-gate.sh.)
const MiB = 1024 * 1024;
const { tiers, routeFor } = readCaddyfile(path.join('deploy', 'Caddyfile'));
const GATE = '/oturum/govde-izni';

type ActionPost = { path: string; uri: string; bytes: number; declared: string | null };
/** Vekilin bu isteği koyacağı kademe: Caddyfile'daki eşleştiricilerle (adres + yöntem + bildirilen boy) */
const tierOf = (a: ActionPost) => routeFor({ path: a.path, method: 'POST', contentLength: a.declared });
/** Kapının yanıtı: Caddy'nin soracağı biçimde (özgün adres X-Forwarded-Uri'de; çerezler bu tarayıcının) */
async function gate(page: Page, uri: string): Promise<{ status: number; header: string | null }> {
  const r = await page.request.get(GATE, { headers: { 'x-forwarded-uri': uri } });
  return { status: r.status(), header: r.headers()['x-takip-govde'] ?? null };
}

/** Sıradaki sunucu işlemi isteği (Next-Action başlıklı POST) → { yol, adres (yol + sorgu), gövde boyu, bildirilen boy } */
async function actionPost(page: Page, run: () => Promise<unknown>): Promise<ActionPost> {
  const wait = page.waitForRequest((r: Request) => r.method() === 'POST' && !!r.headers()['next-action']);
  await run();
  const req = await wait;
  await req.response();
  // Dosyalı gövdelerde tarayıcı gövde boyutunu bildirmeyebilir: ağdaki Content-Length başlığı esas alınır
  const declared = (await req.allHeaders())['content-length'] ?? null;
  const url = new URL(req.url());
  return { path: url.pathname, uri: url.pathname + url.search, bytes: Math.max(Number(declared ?? 0), (await req.sizes()).requestBodySize), declared };
}

test('sunucu işlemleri formun bulunduğu sayfanın adresine POST edilir; her gövde o adresin vekildeki sınırına sığar', async ({ browser }) => {
  expect(tiers.map((t) => [t.name, t.max, t.gated])).toEqual([['yukleme', 260e6, true], ['yonetim_excel', 6e6, true], [null, 2e6, false]]);

  // 1. Giriş (oturum yok): /login — küçük gövde, varsayılan (2 MB) kademede; kapıya sorulmaz
  const cust = await (await browser.newContext()).newPage();
  cust.on('dialog', (d) => d.accept());
  await cust.goto('/login');
  // Giriş yapmamış tarayıcı kapıdan büyük gövde izni alamaz
  expect(await gate(cust, '/siparisler/yeni?tip=GLASS_ORDER')).toEqual({ status: 401, header: null });
  await cust.fill('#email', CUSTOMER);
  await cust.fill('#password', CUST_PW);
  const login = await actionPost(cust, () => cust.click('button[type=submit]'));
  await expect(cust).toHaveURL(/\/siparisler/);
  expect(login.path).toBe('/login');
  expect(tierOf(login)).toEqual({ blocked: false, tier: null, gated: false, max: 2e6 });
  expect(login.bytes).toBeGreaterThan(0);
  expect(login.bytes).toBeLessThan(20_000);

  // 2. Yeni sipariş (dosyalı): /siparisler/yeni — yükleme kademesi; 3 MiB'lık dosya varsayılan sınırı aşar ama buraya sığar
  await cust.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await cust.fill('#title', 'Gövde sınırı');
  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: '10 MM TEMPER CAM — BRONZ' });
  const big = sampleFile('buyuk-plan.pdf', 'plan');
  big.buffer = Buffer.concat([big.buffer, Buffer.alloc(3 * MiB, 0x20)]);
  await cust.setInputFiles('#files', big);
  const created = await actionPost(cust, () => cust.getByRole('button', { name: 'Siparişi gönder' }).click());
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/);
  expect(created.path).toBe('/siparisler/yeni');
  expect(created.uri).toBe('/siparisler/yeni?tip=GLASS_ORDER');
  // 2 MB'ı aşan gövde: vekil bu isteği kapıya sorar (yükleme kademesi); kapı bu oturuma izin verir
  expect(tierOf(created)).toEqual({ blocked: false, tier: 'yukleme', gated: true, max: 260e6 });
  expect(created.bytes).toBeGreaterThan(3 * MiB);
  expect(created.bytes).toBeGreaterThan(2e6);
  expect(created.bytes).toBeLessThan(260e6);
  expect(await gate(cust, created.uri)).toEqual({ status: 204, header: 'izin' });

  // 3. Sipariş sayfasında dosya ekleme: /siparisler/<id> — aynı sayfa adresi, yükleme kademesi
  const orderPath = new URL(cust.url()).pathname;
  await cust.setInputFiles('input[name=files]', sampleFile('ek-olcu.pdf', 'ek'));
  const added = await actionPost(cust, () => cust.locator('button', { hasText: 'Dosya ekle' }).click());
  await expect(cust.getByText('ek-olcu.pdf').first()).toBeVisible();
  expect(added.path).toBe(orderPath);
  expect(orderPath).toMatch(/^\/siparisler\/[a-z0-9]+$/);
  // Küçük dosya: gövde 2 MB'ın altında → kapıya sorulmaz, olağan kademeden geçer; büyük dosya aynı adreste kapıdan geçerdi
  expect(tierOf(added)).toEqual({ blocked: false, tier: null, gated: false, max: 2e6 });
  expect(added.bytes).toBeLessThan(2e6);
  expect(routeFor({ path: added.path, method: 'POST', contentLength: String(50 * MiB) })).toEqual({ blocked: false, tier: 'yukleme', gated: true, max: 260e6 });
  expect(await gate(cust, added.uri)).toEqual({ status: 204, header: 'izin' });

  // 4. Sipariş sayfasındaki küçük işlem (not): aynı adrese gider — işlem başına ayrı adres yok
  await cust.locator('#notlar textarea[name=text]').fill('Gövde sınırı notu');
  const note = await actionPost(cust, () => cust.locator('#notlar form', { has: cust.locator('textarea[name=text]') }).getByRole('button').click());
  await expect(cust.getByText('Gövde sınırı notu').first()).toBeVisible();
  expect(note.path).toBe(orderPath);
  expect(note.bytes).toBeLessThan(20_000);
  expect(tierOf(note).gated).toBe(false);
  await cust.context().close();

  // 5. Yönetim Excel yüklemesi: /admin/katalog — 6 MB kademesi
  const admin = await (await browser.newContext()).newPage();
  await admin.goto('/login');
  await admin.fill('#email', ADMIN);
  await admin.fill('#password', ADMIN_PW);
  await admin.click('button[type=submit]');
  await expect(admin).toHaveURL(/\/siparisler/);
  await admin.goto('/admin/katalog');
  await admin.setInputFiles('input[name=file]', path.join('test', 'fixtures', 'cam-katalogu.xlsx'));
  const preview = await actionPost(admin, () => admin.getByRole('button', { name: 'Önizle' }).click());
  // Dosya okundu (önizleme özeti geldi): hata yok
  await expect(admin.getByText(/Dosya okunamadı/)).toHaveCount(0);
  await expect(admin.getByText(/cam aynı|yeni cam|güncellenecek/).first()).toBeVisible();
  expect(preview.path).toBe('/admin/katalog');
  // Küçük Excel (bu dosya ~11 KB) kapıya sorulmaz; 2 MB'ı aşan Excel yönetim kademesinde (6 MB) kapıdan geçer
  expect(tierOf(preview).gated).toBe(false);
  expect(preview.bytes).toBeLessThan(2e6);
  expect(routeFor({ path: preview.path, method: 'POST', contentLength: String(4 * MiB) })).toEqual({ blocked: false, tier: 'yonetim_excel', gated: true, max: 6e6 });
  expect(await gate(admin, preview.uri)).toEqual({ status: 204, header: 'izin' });
  await admin.context().close();
});
