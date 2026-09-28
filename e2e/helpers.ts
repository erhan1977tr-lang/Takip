import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const ADMIN = 'admin@e2e.test';
export const ADMIN_PW = 'Yonetici2026';
export const CUSTOMER = 'ali@unsal.test';
export const CUST_PW = 'Musteri2026x';

export function outboxCodeFor(email: string): string {
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

export async function firstLogin(page: Page, email: string, code: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/setup\?email=/);
  await page.fill('#code', code);
  await page.click('button[type=submit]');
  await expect(page.getByRole('heading', { name: 'Şifrenizi belirleyin', exact: true })).toBeVisible();
  await page.fill('#password', password);
  await page.fill('#password2', password);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/siparisler/);
}

export async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/siparisler/);
}

/** Yönetici olarak kullanıcı oluşturur (davet e-postası outbox'a düşer). */
export async function createUser(page: Page, u: { email: string; name: string; role: 'Müşteri' | 'Satış' | 'Çizimci'; firm: string; canApprove?: boolean }) {
  await page.goto('/admin/users');
  await page.fill('#u-email', u.email);
  await page.fill('#u-name', u.name);
  await page.locator('label.chip', { hasText: u.role }).click();
  await page.selectOption('#u-firm', { label: u.role === 'Müşteri' ? u.firm : `${u.firm} (fabrika)` });
  if (u.canApprove) await page.locator('input[name=canApprove]').check();
  await page.click('form.card button[type=submit]');
  await expect(page.getByText(`${u.email} → ${u.firm} firmasına atandı ve davet e-postası gönderildi.`)).toBeVisible();
}
