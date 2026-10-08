import { test, expect } from '@playwright/test';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, as, login, sampleFile } from './helpers';

// Aşama 3: cam kataloğu Excel'den yüklenir; müşteri siparişi taslak olarak kaydedip sonra gönderir.
test.describe.configure({ mode: 'serial' });

test('yönetici: katalog Excel\'i önizlenir, onaylanınca yüklenir ve geri indirilebilir', async ({ page }) => {
  await login(page, ADMIN, ADMIN_PW);
  await page.goto('/admin/katalog');
  await page.setInputFiles('input[name=file]', path.join('test', 'fixtures', 'cam-katalogu.xlsx'));
  await page.getByRole('button', { name: 'Önizle' }).click();
  await expect(page.getByText('104 yeni cam eklenecek').first()).toBeVisible();
  // Henüz kaydedilmedi
  await expect(page.locator('tr', { hasText: 'STICLĂ SECURIZATĂ 10 MM' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Onayla ve kaydet' }).click();
  await expect(page.getByText('Excel yüklendi: 104 yeni cam, 0 cam güncellendi.')).toBeVisible();
  await expect(page.locator('tr', { hasText: '10 MM TEMPER CAM' }).first()).toContainText('STICLĂ SECURIZATĂ 10 MM');

  // Aynı dosya ikinci kez: değişecek bir şey yok
  await page.setInputFiles('input[name=file]', path.join('test', 'fixtures', 'cam-katalogu.xlsx'));
  await page.getByRole('button', { name: 'Önizle' }).click();
  await expect(page.getByText('104 cam aynı')).toBeVisible();
  await expect(page.getByText('Değişecek bir şey yok.')).toBeVisible();

  // Excel olmayan dosya
  await page.setInputFiles('input[name=file]', sampleFile('liste.pdf', 'pdf'));
  await page.getByRole('button', { name: 'Önizle' }).click();
  await expect(page.getByText(/Dosya okunamadı/)).toBeVisible();

  const res = await page.request.get('/admin/katalog/excel');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('spreadsheetml');
  expect((await res.body()).subarray(0, 2).toString()).toBe('PK');

  // Pasif cam müşteri listesinde görünmez
  await page.fill('input[name=q]', 'ULTRA CLEAR');
  await page.getByRole('button', { name: 'Ara' }).click();
  const row = page.locator('tr').filter({ has: page.locator('td', { hasText: /^10 MM TEMPER CAMULTRA CLEAR$/ }) });
  await row.locator('button', { hasText: 'Pasifleştir' }).click();
  await expect(row.getByText('Pasif', { exact: true })).toBeVisible();
});

test('müşteri: taslak kaydeder, listeden devam eder, ek bilgiyle gönderir', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await expect(cust.getByLabel('Cam', { exact: true }).locator('option', { hasText: '10 MM TEMPER CAM — ULTRA CLEAR' })).toHaveCount(0);
  await cust.fill('#title', 'Taslak deneme');
  await cust.getByRole('button', { name: 'Taslak kaydet' }).click();
  await expect(cust.getByText('Taslak kaydedildi.')).toBeVisible();

  await cust.goto('/siparisler');
  const drafts = cust.locator('.card', { hasText: 'Taslaklarım' });
  await expect(drafts.getByText('Taslak deneme')).toBeVisible();
  await drafts.getByRole('link', { name: 'Devam et' }).click();
  await expect(cust.getByRole('heading', { name: 'Taslak sipariş' })).toBeVisible();
  await expect(cust.locator('#title')).toHaveValue('Taslak deneme');

  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: '10 MM TEMPER CAM — BRONZ' });
  await cust.setInputFiles('#files', sampleFile('olcu.pdf', 'taslak'));
  await cust.fill('#note', 'Kenarlar rodajlı olsun');
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/);
  // İstenen cam: adet yok (müşteri formunda cam adedi alanı yok — karar 160)
  await expect(cust.locator('.plain-list li', { hasText: '10 MM TEMPER CAM — BRONZ' })).toHaveText('10 MM TEMPER CAM — BRONZ');
  await expect(cust.getByText('Kenarlar rodajlı olsun')).toBeVisible();
  await expect(cust.getByText('olcu.pdf')).toBeVisible();

  await cust.goto('/siparisler');
  await expect(cust.locator('.card', { hasText: 'Taslaklarım' })).toHaveCount(0);
  await cust.context().close();
});
