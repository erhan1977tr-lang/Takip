import { test, expect, type Page, type Request } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, sampleFile } from './helpers';

// İstek gövdesi sınırları (AUD-4, karar 141). Vekil (deploy/Caddyfile) büyük gövdeye yalnızca dosya yükleme formu olan
// SAYFALARIN adresinde izin verir. Bu test, tarayıcının sunucu işlemlerini (Server Actions) gerçekten hangi adrese POST
// ettiğini kaydeder: işlem, formun bulunduğu sayfanın adresine gider (ayrı bir yükleme adresi yoktur) ve her gövde o
// adresin Caddyfile'daki sınırına sığar. (Uçtan uca testler Caddy'siz çalışır; Caddy'nin kendisi sunucu kurulumu testinde.)
const MiB = 1024 * 1024;
const caddy = fs.readFileSync(path.join('deploy', 'Caddyfile'), 'utf8').split('\n').map((l) => l.replace(/^\s*#.*$/, '')).join('\n');
const size = (v: string) => Number(/^\d+/.exec(v)![0]) * ({ KB: 1e3, MB: 1e6, GB: 1e9 } as Record<string, number>)[v.replace(/^\d+/, '')];
const matchers = Object.fromEntries([...caddy.matchAll(/^\t@(\w+) path (.+)$/gm)].map((m) => [m[1], m[2].trim().split(/\s+/)]));
const tiers = [...caddy.matchAll(/^\thandle(?: @(\w+))? \{\n\t\trequest_body \{\n\t\t\tmax_size (\w+)\n/gm)].map((m) => ({ paths: m[1] ? matchers[m[1]] : null, max: size(m[2]) }));
/** Adresin (yol) vekildeki gövde sınırı — Caddy "path": tam eşleşme ya da sondaki * ile ön ek */
const limitFor = (p: string) => (tiers.find((t) => t.paths?.some((x) => (x.endsWith('*') ? p.startsWith(x.slice(0, -1)) : x === p))) ?? tiers.find((t) => !t.paths)!).max;

/** Sıradaki sunucu işlemi isteği (Next-Action başlıklı POST) → { yol, gövde boyutu } */
async function actionPost(page: Page, run: () => Promise<unknown>): Promise<{ path: string; bytes: number }> {
  const wait = page.waitForRequest((r: Request) => r.method() === 'POST' && !!r.headers()['next-action']);
  await run();
  const req = await wait;
  await req.response();
  return { path: new URL(req.url()).pathname, bytes: (await req.sizes()).requestBodySize };
}

test('sunucu işlemleri formun bulunduğu sayfanın adresine POST edilir; her gövde o adresin vekildeki sınırına sığar', async ({ browser }) => {
  expect(tiers.map((t) => t.max)).toEqual([260e6, 6e6, 2e6]);

  // 1. Giriş (oturum yok): /login — küçük gövde, varsayılan (2 MB) kademede
  const cust = await (await browser.newContext()).newPage();
  cust.on('dialog', (d) => d.accept());
  await cust.goto('/login');
  await cust.fill('#email', CUSTOMER);
  await cust.fill('#password', CUST_PW);
  const login = await actionPost(cust, () => cust.click('button[type=submit]'));
  await expect(cust).toHaveURL(/\/siparisler/);
  expect(login.path).toBe('/login');
  expect(limitFor(login.path)).toBe(2e6);
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
  expect(limitFor(created.path)).toBe(260e6);
  expect(created.bytes).toBeGreaterThan(3 * MiB);
  expect(created.bytes).toBeGreaterThan(limitFor('/login'));
  expect(created.bytes).toBeLessThan(limitFor(created.path));

  // 3. Sipariş sayfasında dosya ekleme: /siparisler/<id> — aynı sayfa adresi, yükleme kademesi
  const orderPath = new URL(cust.url()).pathname;
  await cust.setInputFiles('input[name=files]', sampleFile('ek-olcu.pdf', 'ek'));
  const added = await actionPost(cust, () => cust.locator('button', { hasText: 'Dosya ekle' }).click());
  await expect(cust.getByText('ek-olcu.pdf').first()).toBeVisible();
  expect(added.path).toBe(orderPath);
  expect(orderPath).toMatch(/^\/siparisler\/[a-z0-9]+$/);
  expect(limitFor(added.path)).toBe(260e6);

  // 4. Sipariş sayfasındaki küçük işlem (not): aynı adrese gider — işlem başına ayrı adres yok
  await cust.locator('#notlar textarea[name=text]').fill('Gövde sınırı notu');
  const note = await actionPost(cust, () => cust.locator('#notlar form', { has: cust.locator('textarea[name=text]') }).getByRole('button').click());
  await expect(cust.getByText('Gövde sınırı notu').first()).toBeVisible();
  expect(note.path).toBe(orderPath);
  expect(note.bytes).toBeLessThan(20_000);
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
  expect(limitFor(preview.path)).toBe(6e6);
  expect(preview.bytes).toBeLessThan(limitFor(preview.path));
  await admin.context().close();
});
