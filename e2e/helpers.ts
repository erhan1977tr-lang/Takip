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
export async function createUser(page: Page, u: { email: string; name: string; role: 'Müşteri' | 'Satış' | 'Çizimci' | 'Denetimci'; firm: string; canApprove?: boolean }) {
  await page.goto('/admin/users');
  await page.fill('#u-email', u.email);
  await page.fill('#u-name', u.name);
  await page.locator('label.chip', { hasText: u.role }).click();
  await page.selectOption('#u-firm', { label: u.role === 'Müşteri' ? u.firm : `${u.firm} (fabrika)` });
  if (u.canApprove) await page.locator('input[name=canApprove]').check();
  await page.click('form.card button[type=submit]');
  await expect(page.getByText(`${u.email} → ${u.firm} firmasına atandı ve davet e-postası gönderildi.`)).toBeVisible();
}

export const GLASS = '66.3 Temper Lamine Cam (Şeffaf)';
export const SALES = 'satis@e2e.test';
export const DRAWER = 'cizim@e2e.test';
export const TEAM_PW = 'Ekip2026abc';

/** Ayrı bir tarayıcı oturumunda giriş yapar; onay pencerelerini otomatik kabul eder. */
export async function as(browser: import('@playwright/test').Browser, email: string, pw: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await login(page, email, pw);
  return page;
}

/** Müşteri olarak yeni sipariş oluşturur, sipariş kimliğini döndürür. */
export async function newOrder(page: Page, title: string, fileName: string): Promise<string> {
  await page.goto('/siparisler/yeni');
  await page.fill('#title', title);
  await page.setInputFiles('#files', { name: fileName, mimeType: 'application/octet-stream', buffer: Buffer.from(`test dosyası ${title}`) });
  await page.getByLabel('Cam', { exact: true }).selectOption({ label: GLASS });
  await page.getByLabel('Adet', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(page).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/);
  await expect(page.getByText('Siparişiniz alındı.')).toBeVisible();
  return /\/siparisler\/([a-z0-9]+)/.exec(page.url())![1];
}

/** Teklif tablosunun ilk satırını doldurur (1000 × 2000 mm, adet siparişten gelir). */
export async function fillOffer(page: Page, price = '41,5') {
  await page.getByLabel('En', { exact: true }).first().fill('1000');
  await page.getByLabel('Boy', { exact: true }).first().fill('2000');
  await page.getByLabel('Birim fiyat').first().fill(price);
}

/**
 * ADR 0003 sızıntı taraması: kullanıcının bağlantıları izleyerek erişebildiği sayfaları gezer ve her sayfanın
 * ham yanıtında (HTML + RSC verisi) aranan metinlerin (ve JSON kaçışlı biçimlerinin) geçip geçmediğine bakar.
 */
export async function crawlForLeaks(page: Page, secrets: string[], max = 80): Promise<{ pages: number; leaks: string[] }> {
  const needles = secrets
    .filter((s) => s.trim().length >= 5)
    .flatMap((s) => [s, JSON.stringify(s).slice(1, -1), s.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)]);
  const seen = new Set<string>();
  const queue = ['/siparisler'];
  const leaks: string[] = [];
  while (queue.length && seen.size < max) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    for (const variant of [url, `${url}${url.includes('?') ? '&' : '?'}_rsc=1`]) {
      const res = await page.request.get(variant, { headers: variant.includes('_rsc') ? { RSC: '1' } : {} });
      const body = await res.text();
      for (const n of needles) if (body.includes(n)) leaks.push(`${variant}: "${n}"`);
    }
    await page.goto(url);
    for (const href of await page.locator('a[href^="/"]').evaluateAll((els) => els.map((a) => a.getAttribute('href') || ''))) {
      const clean = href.split('#')[0];
      if (!clean || /^\/(dosya|dil|login|setup|_next)\b/.test(clean) || seen.has(clean)) continue;
      queue.push(clean);
    }
  }
  return { pages: seen.size, leaks: [...new Set(leaks)] };
}

/** Müşteri firmalarının gizli tutulacak bilgileri (tam ad, ilk 3 harften sonrası, iletişim). */
export async function customerSecrets(): Promise<string[]> {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const rows = await db.customer.findMany({
      where: { type: 'CUSTOMER' }, select: { name: true, contactPerson: true, phone: true, address: true, taxId: true },
    });
    return rows.flatMap((r) => [r.name, r.name.slice(3), r.contactPerson, r.phone, r.address, r.taxId]).filter((x): x is string => !!x);
  } finally {
    await db.$disconnect();
  }
}
