import { test, expect } from '@playwright/test';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, TEAM_PW, as, createUser, firstLogin, login, outboxCodeFor, sampleFile } from './helpers';

// 05'te satis@e2e.test bilerek kilitlendi; bu testin kendi satışçısı var
const SALES = 'fiyat-satis@e2e.test';

// Aşama 3b: fiyat tablosu Excel'den yüklenir; satışçının teklifine liste fiyatı gelir; satışçı fiyatı değiştirirse
// yöneticinin "Önemli kararlar" listesine ve giriş ekranına uyarı düşer. (Katalog 07'de yüklendi.)
test.describe.configure({ mode: 'serial' });

test('yönetici: fiyat tablosu oluşturur, fiyat Excel\'ini yükler, satışçıyı atar', async ({ page }) => {
  await login(page, ADMIN, ADMIN_PW);
  await page.goto('/admin/fiyatlar');
  await page.fill('#new-name', 'E2E Fiyat 2026');
  await page.fill('#new-hole', '3');
  await page.fill('#new-cnc', '12');
  await page.getByRole('button', { name: 'Tablo oluştur' }).click();
  await expect(page.getByText('Tablo oluşturuldu.')).toBeVisible();
  await expect(page.getByText('Varsayılan', { exact: true }).first()).toBeVisible(); // ilk tablo varsayılan

  await page.setInputFiles('input[name=file]', path.join('test', 'fixtures', 'fiyat-listesi.xlsx'));
  await page.getByRole('button', { name: 'Önizle' }).click();
  await expect(page.getByText('90 fiyat değişecek')).toBeVisible();
  await expect(page.getByText('14 satırda fiyat boş (değişmeyecek)')).toBeVisible();
  await page.getByRole('button', { name: 'Onayla ve kaydet' }).click();
  await expect(page.getByText('Excel yüklendi: 90 değişiklik kaydedildi.')).toBeVisible();
  // Katalogda başka testlerin eklediği camlar da var; fiyatsız sayısı onlara göre değişir
  await expect(page.getByText(/\d+ camın fiyatı girilmemiş/)).toBeVisible();

  const url = new URL(page.url());
  const res = await page.request.get(`/admin/fiyatlar/excel?tablo=${url.searchParams.get('tablo')}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('spreadsheetml');

  await createUser(page, { email: SALES, name: 'Fiyat Satışçı', role: 'Satış', firm: 'GKH Trading' });
  const ctx = await page.context().browser()!.newContext();
  const p = await ctx.newPage();
  await firstLogin(p, SALES, outboxCodeFor(SALES), TEAM_PW);
  await ctx.close();
  await page.goto(url.pathname + url.search.replace(/&?ok=[^&]*/, ''));

  const row = page.locator('tr', { hasText: SALES });
  await row.getByRole('button', { name: 'Bu tabloya ata' }).click();
  await expect(page.getByText('Atama kaydedildi.')).toBeVisible();
  await expect(page.locator('tr', { hasText: SALES }).getByText('Bu tablo')).toBeVisible();
});

test('satış: liste fiyatı dolu gelir; değiştirip gönderince yönetici uyarı görür ve kapatır', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto('/siparisler/yeni');
  await cust.fill('#title', 'Fiyat deneme');
  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: '10 MM TEMPER CAM — BRONZ' });
  await cust.setInputFiles('#files', sampleFile('fiyat.pdf', 'fiyat'));
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/);
  const orderUrl = new URL(cust.url()).pathname;
  await cust.context().close();

  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(orderUrl);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.getByLabel('Açıklama').first()).toHaveValue('10 MM TEMPER CAM — BRONZ');
  await expect(sales.getByLabel('Birim fiyat').first()).toHaveValue('30.00');
  await expect(sales.getByText('Liste: 30,00')).toBeVisible();
  await expect(sales.getByText('Fiyatlar “E2E Fiyat 2026” tablosundan geldi.')).toBeVisible();
  await sales.getByLabel('En', { exact: true }).first().fill('1000');
  await sales.getByLabel('Boy', { exact: true }).first().fill('1000');
  await sales.getByLabel('Birim fiyat').first().fill('28');
  await expect(sales.getByText('Liste fiyatı 30,00; değiştirdiniz — yöneticiye bildirilecek.')).toBeVisible();
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  await sales.context().close();

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await expect(admin.getByText('1 önemli karar bekliyor (ör. satışçı liste fiyatını değiştirdi).')).toBeVisible();
  await admin.getByRole('link', { name: 'Önemli kararlar →' }).click();
  await expect(admin.getByRole('heading', { name: 'Bekleyen önemli kararlar', level: 1 })).toBeVisible();
  await expect(admin.getByText('Satışçı liste fiyatını değiştirdi').first()).toBeVisible();
  await expect(admin.getByText(/liste 30,00 → 28,00 EUR/)).toBeVisible();
  await admin.getByRole('button', { name: 'Gördüm' }).click();
  await expect(admin.getByText('Kapatıldı.')).toBeVisible();
  await expect(admin.getByText('Şu an bekleyen bir karar yok.', { exact: false })).toBeVisible();
  await admin.goto('/siparisler');
  await expect(admin.getByText(/önemli karar bekliyor/)).toHaveCount(0);
  await admin.context().close();
});
