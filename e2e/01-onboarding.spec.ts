import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, firstLogin, outboxCodeFor } from './helpers';

// Akış: yönetici ilk girişi → firma → kullanıcı daveti → müşterinin ilk girişi → yetki kontrolü
test.describe.configure({ mode: 'serial' });

test('yönetici komut satırından oluşturulur ve ilk girişte şifresini belirler', async ({ page }) => {
  const out = execFileSync('node', ['scripts/create-admin.mjs', ADMIN, 'E2E Yönetici', '--factory', 'GKH Trading'], {
    encoding: 'utf8',
    env: process.env,
  });
  const code = /CODE=(\d{6})/.exec(out)?.[1];
  expect(code, out).toBeTruthy();

  // Yanlış kod reddedilir
  await page.goto('/login');
  await page.fill('#email', ADMIN);
  await page.click('button[type=submit]');
  await page.fill('#code', code === '000000' ? '111111' : '000000');
  await page.click('button[type=submit]');
  await expect(page.getByText('Doğrulama kodu hatalı ya da geçersiz.')).toBeVisible();

  await firstLogin(page, ADMIN, code!, ADMIN_PW);
  await expect(page).toHaveURL(/\/siparisler$/);
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Kullanıcılar', exact: true })).toBeVisible();
});

test('yönetici firma oluşturur ve müşteri kullanıcısını davet eder', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', ADMIN);
  await page.fill('#password', ADMIN_PW);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/siparisler$/);

  await page.goto('/admin/firms');
  await page.fill('#f-name', 'Ünsal Cam');
  await page.click('form.card button[type=submit]');
  await expect(page.getByText('“Ünsal Cam” firması oluşturuldu (kod: UNS)')).toBeVisible();

  // Aynı firma kodu ikinci kez kullanılamaz (kod tam 3 harf)
  await page.fill('#f-name', 'Unsal Başka');
  await page.fill('#f-prefix', 'UNS');
  await page.click('form.card button[type=submit]');
  await expect(page.getByText(/“UNS” kodu Ünsal Cam firmasında kullanılıyor/)).toBeVisible();
  await expect(page.locator('#f-name')).toHaveValue('Unsal Başka');
  await expect(page.locator('#f-prefix')).toHaveAttribute('maxlength', '3');

  await page.goto('/admin/users');
  await page.fill('#u-email', CUSTOMER);
  await page.fill('#u-name', 'Ali Veli');
  await page.locator('label.chip', { hasText: 'Müşteri' }).click();
  await page.selectOption('#u-firm', { label: 'Ünsal Cam' });
  await page.locator('input[name=canApprove]').check();
  await page.click('form.card button[type=submit]');
  await expect(page.getByText(`${CUSTOMER} → Ünsal Cam firmasına atandı ve davet e-postası gönderildi.`)).toBeVisible();
  await expect(page.locator('tr', { hasText: CUSTOMER }).getByText('Davet gönderildi')).toBeVisible();
});

test('davet edilen müşteri kodla girer, şifresini belirler ve yalnızca kendi paneline erişir', async ({ page }) => {
  const code = outboxCodeFor(CUSTOMER);
  await firstLogin(page, CUSTOMER, code, CUST_PW);
  await expect(page.getByRole('heading', { name: 'Ünsal Cam — Siparişlerim', exact: true })).toBeVisible();
  await expect(page.getByText('Müşteri · Ünsal Cam')).toBeVisible();

  // Yönetici sayfasına giremez
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/siparisler$/);

  // Aynı kod ikinci kez kullanılamaz
  await page.click('text=Çıkış');
  await expect(page).toHaveURL(/\/login\?info=logout/);
  await page.goto('/admin/firms');
  await expect(page).toHaveURL(/\/login/);

  await page.fill('#email', CUSTOMER);
  await page.fill('#password', 'yanlis-sifre-1');
  await page.click('button[type=submit]');
  await expect(page.getByText('E-posta veya şifre hatalı.')).toBeVisible();

  await page.fill('#password', CUST_PW);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/siparisler$/);
});

test('mobil görünümde menü üstte yatay listelenir', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.fill('#email', ADMIN);
  await page.fill('#password', ADMIN_PW);
  await page.click('button[type=submit]');
  await expect(page.locator('.mobile-nav')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await ctx.close();
});
