import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { firstLogin } from './helpers';

// Demo ortamı (DEMO_MODE=1 + scripts/demo/seed.mjs) kontrolü. Yalnızca DEMO_URL ayarlıysa çalışır.
const DEMO_URL = process.env.DEMO_URL;
test.skip(!DEMO_URL, 'DEMO_URL ayarlı değil');
test.use({ baseURL: DEMO_URL });
test.describe.configure({ mode: 'serial' });

function demoPassword(): string {
  const txt = fs.readFileSync(process.env.DEMO_CRED_FILE || 'DEMO-GIRIS.txt', 'utf8');
  return /Şifre \(tüm hesaplar\): (\S+)/.exec(txt)![1];
}

async function as(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: DEMO_URL });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto('/login');
  await page.getByRole('link', { name: email }).click(); // demo hesabı listesinden e-posta doldurulur
  await expect(page.locator('#email')).toHaveValue(email);
  await page.fill('#password', demoPassword());
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/siparisler/);
  await expect(page.getByText('DEMO', { exact: true })).toBeVisible();
  return page;
}

const shot = async (page: Page, name: string) => {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(dir, `demo-${name}.png`), fullPage: true });
};

test('yönetici: teklif kontrolü, fiyat onayı ve demo posta kutusuyla yeni kullanıcı', async ({ browser }) => {
  const admin = await as(browser, 'yonetici@ornek.test');
  await expect(admin.locator('.card', { hasText: 'Teklif kontrolü' }).getByRole('link', { name: 'ORN104' })).toBeVisible();
  await expect(admin.locator('.card', { hasText: 'Fiyat onayı bekleyen' }).getByRole('link', { name: 'ORN105' })).toBeVisible();
  await shot(admin, '01-yonetici-siparisler');

  await admin.getByRole('link', { name: 'ORN104' }).first().click();
  await expect(admin.getByText('Teklif müşteriye gönderildikten sonra revize çizim yüklendi (v2')).toBeVisible();
  const pdf = await admin.request.get((await admin.locator('a[href^="/dosya/cizim/"]').first().getAttribute('href'))!);
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  // Yeni müşteri kullanıcısı → davet e-postası demo posta kutusuna düşer → ilk giriş
  const email = `yeni${Date.now()}@ornek.test`;
  await admin.goto('/admin/users');
  await admin.fill('#u-email', email);
  await admin.fill('#u-name', 'Yeni Kişi');
  await admin.locator('label.chip', { hasText: 'Müşteri' }).click();
  await admin.selectOption('#u-firm', { label: 'Örnek Cam SRL' });
  await admin.click('form.card button[type=submit]');
  await expect(admin.getByText(`${email} → Örnek Cam SRL firmasına atandı ve davet e-postası gönderildi.`)).toBeVisible();
  await admin.getByRole('link', { name: 'Demo posta kutusu' }).first().click();
  const code = (await admin.locator('.mail', { hasText: email }).locator('.code').textContent())!.trim();
  expect(code).toMatch(/^\d{6}$/);
  await shot(admin, '02-posta-kutusu');

  const ctx = await browser.newContext({ baseURL: DEMO_URL });
  await firstLogin(await ctx.newPage(), email, code, 'Yeni2026abc');
  await ctx.close();
});

test('satış, çizimci ve müşteri örnek siparişleri görür', async ({ browser }) => {
  const sales = await as(browser, 'satis@ornek.test');
  const fresh = sales.locator('.card', { hasText: 'Yeni siparişler — karar bekliyor' });
  await expect(fresh.getByRole('link', { name: 'ORN101' })).toBeVisible();
  await expect(fresh.getByRole('link', { name: 'ORN102' })).toBeVisible();
  await sales.getByRole('link', { name: 'ORN106' }).first().click();
  await expect(sales.getByRole('button', { name: 'Çizime Göndermeyi Geri Al' })).toBeVisible();

  const drawer = await as(browser, 'cizim@ornek.test');
  const jobs = drawer.locator('.card', { hasText: 'Çizim işleri' });
  await expect(jobs.getByRole('link', { name: 'ORN105' })).toBeVisible();
  await expect(jobs.getByRole('link', { name: 'ORN106' })).toBeVisible();

  const cust = await as(browser, 'musteri@ornek.test');
  await shot(cust, '03-musteri-siparislerim');
  await cust.getByRole('link', { name: 'ORN104' }).first().click();
  await expect(cust.getByRole('button', { name: 'Çizimi onayla' })).toBeVisible();
  await expect(cust.locator('#teklif tfoot')).toContainText('660,00 EUR');
  await shot(cust, '04-musteri-cizim-onayi');
});
