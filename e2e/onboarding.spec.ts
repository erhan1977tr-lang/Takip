import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Akış: yönetici ilk girişi → firma → kullanıcı daveti → müşterinin ilk girişi → yetki kontrolü
test.describe.configure({ mode: 'serial' });

const ADMIN = 'admin@e2e.test';
const CUSTOMER = 'ali@unsal.test';
const ADMIN_PW = 'Yonetici2026';
const CUST_PW = 'Musteri2026x';

function outboxCodeFor(email: string): string {
  const dir = process.env.MAIL_OUTBOX_DIR;
  if (!dir) throw new Error('MAIL_OUTBOX_DIR ayarlı değil');
  const files = fs.readdirSync(dir).filter((f) => f.includes(email)).sort();
  expect(files.length, `outbox'ta ${email} için e-posta yok`).toBeGreaterThan(0);
  const msg = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  expect(msg.subject).toContain('Takip');
  const m = /(\d{6})/.exec(msg.text);
  if (!m) throw new Error('E-postada kod bulunamadı');
  return m[1];
}

async function firstLogin(page: Page, email: string, code: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/setup\?email=/);
  await page.fill('#code', code);
  await page.click('button[type=submit]');
  await expect(page.getByRole('heading', { name: 'Şifrenizi belirleyin' })).toBeVisible();
  await page.fill('#password', password);
  await page.fill('#password2', password);
  await page.click('button[type=submit]');
}

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
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByRole('heading', { name: 'Kullanıcılar' })).toBeVisible();
});

test('yönetici firma oluşturur ve müşteri kullanıcısını davet eder', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', ADMIN);
  await page.fill('#password', ADMIN_PW);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/admin\/users$/);

  await page.goto('/admin/firms');
  await page.fill('#f-name', 'Ünsal Cam');
  await page.click('form.card button[type=submit]');
  await expect(page.getByText('“Ünsal Cam” firması oluşturuldu (ön ek: UNS)')).toBeVisible();

  // Aynı ön ek ikinci kez kullanılamaz
  await page.fill('#f-name', 'Unsal Başka');
  await page.click('form.card button[type=submit]');
  await expect(page.getByText(/ön eki Ünsal Cam firmasında kullanılıyor/)).toBeVisible();
  await expect(page.locator('#f-name')).toHaveValue('Unsal Başka');

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
  await expect(page).toHaveURL(/\/siparisler$/);
  await expect(page.getByRole('heading', { name: 'Siparişlerim' })).toBeVisible();
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
