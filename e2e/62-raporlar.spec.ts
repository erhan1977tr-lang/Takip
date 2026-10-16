import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, TEAM_PW, as, reportSheet } from './helpers';

// Yönetici raporları (3.89.0, karar 284):
//  - menü: "Raporlar" Muhasebe ile Satın Alma arasında; beş sekme (Siparişler, Cam, Profil ve stok, Yükleme, Finans)
//  - filtreler adres çubuğunda; aralık ve esas alınan tarih ekranda yazılı; özet kartları + tablolar
//  - Excel aynı filtrelerle aynı sayıları verir (kartlar özet sayfasında)
//  - yönetici yardımcısı açar; satış / müşteri sayfayı ve Excel'i açamaz (sunucuda)
//  - raporlar hiçbir tabloyu değiştirmez (Excel indirme yalnızca bir denetim kaydı yazar)
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı
const DEPUTY = `rapor-yardimci-${Date.now().toString(36)}@e2e.test`;
const DEPUTY_PW = 'Yardimci2026rapor';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const MODELS = ['order', 'offer', 'offerLine', 'loadingConfirmation', 'loadingConfirmationItem', 'stockMovement', 'fgoDocument', 'manualPayment', 'notificationOutbox', 'notification'] as const;
async function counts() {
  const db = await prisma();
  try {
    return Object.fromEntries(await Promise.all(MODELS.map(async (m) => [m, await (db as unknown as Record<string, { count: () => Promise<number> }>)[m].count()])));
  } finally {
    await db.$disconnect();
  }
}

test.beforeAll(async () => {
  // Yönetici yardımcısı: doğrudan veritabanında (parola özetiyle) — kullanıcı yönetimi akışı 48'de sınanıyor
  const db = await prisma();
  try {
    const { hashPassword } = await import('../server/auth/password-hash.js');
    const factory = await db.customer.findFirstOrThrow({ where: { type: 'FACTORY' } });
    await db.user.create({ data: { email: DEPUTY, name: 'Rapor Yardımcı', type: 'INTERNAL', appRole: 'YONETICI_YARDIMCISI', customerId: factory.id, passwordHash: await hashPassword(DEPUTY_PW) } });
  } finally {
    await db.$disconnect();
  }
});

test('yönetici: menüde Raporlar; beş sekme; aralık / esas tarih yazılı; Excel aynı sayılar; hiçbir tablo değişmez', async ({ browser }) => {
  const before = await counts();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const side = admin.locator('.sidebar');
  const texts = await side.locator('a, .nav-section').allInnerTexts();
  const at = (s: string) => texts.findIndex((x) => x.trim().startsWith(s));
  expect(at('Raporlar')).toBeGreaterThan(at('Tedarikçi Hesap Durumu'));
  expect(at('Raporlar')).toBeLessThan(at('Tedarikçi Siparişleri'));
  await side.getByRole('link', { name: 'Raporlar' }).click();
  await expect(admin).toHaveURL(/\/admin\/raporlar/);
  await expect(admin.locator('[data-report-tab]')).toHaveCount(5);
  await expect(admin.locator('#rapor')).toHaveAttribute('data-report', 'orders');
  await expect(admin.locator('[data-report-range]')).toContainText('Aralık:');
  await expect(admin.locator('.report-meta')).toContainText('Esas alınan tarih: siparişin oluşturulduğu gün');

  // Bu yıl, cam raporu
  await admin.locator('[data-report-tab="glass"]').click();
  await admin.locator('#r-donem').selectOption('this_year');
  await admin.getByRole('button', { name: 'Göster' }).click();
  await expect(admin).toHaveURL(/tur=glass/);
  await expect(admin).toHaveURL(/donem=this_year/);
  await expect(admin.locator('#rapor')).toHaveAttribute('data-report', 'glass');
  const m2 = Number(await admin.locator('[data-card="commercialM2"]').getAttribute('data-value'));
  expect(Number.isFinite(m2)).toBe(true);

  // Excel: aynı filtreler, kartlar özet sayfasında aynı sayı
  const href = await admin.locator('[data-report-excel]').getAttribute('href');
  expect(href).toMatch(/^\/admin\/raporlar\/excel\?tur=glass&donem=this_year/);
  const res = await admin.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('spreadsheetml');
  expect(res.headers()['content-disposition']).toMatch(/Rapor-Cam/);
  const summary = await reportSheet(await res.body(), 1);
  const row = summary.find((r) => r[0] === 'Ticari m²');
  expect(row?.[2]).toBe(m2);

  // Finans sekmesi: EUR / RON ayrı satırlar; tablo başlıkları; notlar
  await admin.locator('[data-report-tab="finance"]').click();
  await expect(admin.locator('#rapor')).toHaveAttribute('data-report', 'finance');
  await expect(admin.locator('[data-table="financeSummary"]')).toBeVisible();
  await expect(admin.locator('[data-note="CURRENCY_SEPARATE"]')).toBeVisible();
  const curs = await admin.locator('[data-table="financeSummary"] tbody td[data-col="currency"]').allInnerTexts();
  expect(new Set(curs).size).toBe(curs.length);

  // Hatalı filtre: hesaplanmaz, açıklama
  await admin.goto('/admin/raporlar?tur=orders&bas=2026-10-10');
  await expect(admin.locator('[data-report-error="INVALID_FILTERS"]')).toContainText('Başlangıç ve bitiş birlikte girilmeli');
  await expect(admin.locator('#rapor')).toHaveCount(0);

  // Telefon genişliği: sayfa yatay kaymaz
  await admin.setViewportSize({ width: 390, height: 800 });
  await admin.goto('/admin/raporlar?tur=loading&donem=this_month');
  const overflow = await admin.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  expect(await counts()).toEqual(before);
});

test('yönetici yardımcısı raporları açar ve Excel indirir', async ({ browser }) => {
  const page = await as(browser, DEPUTY, DEPUTY_PW);
  await page.goto('/admin/raporlar?tur=profile');
  await expect(page.locator('#rapor')).toHaveAttribute('data-report', 'profile');
  await expect(page.locator('[data-table="stock"]')).toBeVisible();
  const res = await page.request.get('/admin/raporlar/excel?tur=profile&donem=this_month');
  expect(res.status()).toBe(200);
});

test('satış ve müşteri: Raporlar menüde yok; sayfa ve Excel sunucuda kapalı', async ({ browser }) => {
  for (const [email, pw] of [[SALES, TEAM_PW], [CUSTOMER, CUST_PW]]) {
    const page = await as(browser, email, pw);
    await expect(page.locator('.sidebar').getByRole('link', { name: 'Raporlar' })).toHaveCount(0);
    await page.goto('/admin/raporlar?tur=finance');
    await expect(page.locator('#rapor')).toHaveCount(0);
    const res = await page.request.get('/admin/raporlar/excel?tur=finance&donem=this_year');
    expect(res.status()).toBe(404);
    expect((await res.body()).length).toBeLessThan(200);
  }
});
