import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, as, login, newOrder, zipOf } from './helpers';
import { eicar } from '../server/files/clamav.js';

// Aşama 2 — yüklenen dosyalar: içerik türü kontrolü ve antivirüs (CI'da gerçek ClamAV; deploy/clamav).
test.describe.configure({ mode: 'serial' });
test.skip(!process.env.CLAMAV_HOST, 'CLAMAV_HOST ayarlı değil (antivirüs yok)');

test('yükleme: temiz dosya kabul edilir; virüslü ve kılık değiştirmiş dosya reddedilir', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Antivirüs denemesi', 'olculer.pdf');
  await expect(cust.getByText('olculer.pdf')).toBeVisible();
  await expect(cust.getByText('taranmadı')).toHaveCount(0);

  // ZIP içinde standart (zararsız) EICAR test dosyası → virüs
  await cust.setInputFiles('input[name=files]', { name: 'ekler.zip', mimeType: 'application/zip', buffer: zipOf([{ name: 'eicar.com', data: eicar() }]) });
  await cust.getByRole('button', { name: 'Dosya ekle' }).click();
  await expect(cust.getByText('“ekler.zip” dosyasında virüs bulundu; dosya kabul edilmedi.')).toBeVisible();

  // Adı .pdf ama içi PDF değil
  await cust.setInputFiles('input[name=files]', { name: 'fatura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ bu bir PDF değil') });
  await cust.getByRole('button', { name: 'Dosya ekle' }).click();
  await expect(cust.getByText(/“fatura\.pdf” dosyasının içeriği uzantısıyla uyuşmuyor/)).toBeVisible();

  await cust.goto(`/siparisler/${id}`);
  await expect(cust.getByText('ekler.zip')).toHaveCount(0);
  await expect(cust.getByText('fatura.pdf')).toHaveCount(0);
  await cust.context().close();
});

test('yönetici: Entegrasyonlar sayfası tarayıcıyı, testi ve engellenen yüklemeyi gösterir', async ({ page }) => {
  await login(page, ADMIN, ADMIN_PW);
  await page.goto('/admin/entegrasyonlar');
  await expect(page.getByText(/Bağlı: ClamAV/)).toBeVisible();
  await expect(page.locator('.card', { hasText: 'Son engellenen yüklemeler' }).getByText('ekler.zip')).toBeVisible();
  await page.getByRole('button', { name: 'Bağlantıyı test et' }).click();
  await expect(page.getByText(/Test başarılı: test virüsü \(EICAR\) yakalandı/)).toBeVisible();
  await page.getByRole('button', { name: 'Bekleyenleri şimdi tara' }).click();
  await expect(page.getByText(/dosya tarandı/)).toBeVisible();
});
