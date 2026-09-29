import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, login, newOrder, sampleFile } from './helpers';

// Aşama 4: çizim taslağa yüklenir (çoklu dosya, virüs taraması), "Müşteriye gönder" onaylı ikinci adımdır;
// gönderilen sürüm müşteri karar vermeden gerekçeyle geri çekilebilir, sürüm geçmişte kalır.
test.describe.configure({ mode: 'serial' });

/** Onay pencerelerini kendimiz yöneteceğimiz çizimci oturumu (as() hepsini kabul eder). */
async function drawerPage(browser: import('@playwright/test').Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await login(page, DRAWER, TEAM_PW);
  return page;
}

test('çizim: taslak → onaylı gönderim → geri çekme → yeni sürüm', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Duşakabin', 'dus.pdf');
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${id}`);
  await admin.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(admin.getByText('Sipariş çizim ekibine yönlendirildi.')).toBeVisible();

  const drawer = await drawerPage(browser);
  await drawer.goto(`/siparisler/${id}`);
  await drawer.setInputFiles('#drawing-file', [sampleFile('dus-v1.dxf', 'dxf'), sampleFile('dus-v1.pdf', 'pdf'), sampleFile('yanlis.png', 'png')]);
  await drawer.getByRole('button', { name: 'Taslağa yükle' }).click();
  await expect(drawer.getByText('Dosyalar taslağa eklendi.')).toBeVisible();

  // Taslaktan dosya çıkarma (onaylı)
  drawer.once('dialog', (d) => d.accept());
  await drawer.locator('.file-row', { hasText: 'yanlis.png' }).getByRole('button', { name: 'Çıkar' }).click();
  await expect(drawer.getByText('Dosya taslaktan çıkarıldı.')).toBeVisible();
  await expect(drawer.locator('.file-row', { hasText: 'yanlis.png' })).toHaveCount(0);

  // "Emin misiniz?" sorusuna hayır → gönderilmez
  let asked = '';
  drawer.once('dialog', (d) => { asked = d.message(); void d.dismiss(); });
  await drawer.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect.poll(() => asked).toContain('Emin misiniz?');
  expect(asked).toContain('v1 (2 dosya)');
  await expect(drawer.getByText('Taslak v1 — müşteri henüz görmüyor')).toBeVisible();
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.getByRole('button', { name: 'Çizimi onayla' })).toHaveCount(0);
  // Taslak dosyası müşteriye kapalı (sunucuda): bağlantıyı bilse de indiremez
  const draftHref = await drawer.locator('.file-row', { hasText: 'dus-v1.dxf' }).locator('a[href^="/dosya/cizim/"]').first().getAttribute('href');
  expect((await cust.request.get(draftHref!)).status()).toBe(404);
  expect((await drawer.request.get(draftHref!)).status()).toBe(200);

  // Evet → müşteriye gider
  drawer.once('dialog', (d) => d.accept());
  await drawer.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(drawer.getByText('Çizim müşterinin onayına gönderildi.')).toBeVisible();
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.getByRole('button', { name: 'Çizimi onayla' })).toBeVisible();
  await expect(cust.locator('.file-row', { hasText: 'dus-v1.dxf' })).toBeVisible();

  // Müşteri karar vermeden geri çekme (gerekçe zorunlu, onaylı)
  await drawer.goto(`/siparisler/${id}`);
  await drawer.fill('input[name=reason]', 'Yanlış ölçü gönderildi');
  drawer.once('dialog', (d) => d.accept());
  await drawer.getByRole('button', { name: 'Geri çek' }).click();
  await expect(drawer.getByText('Çizim sürümü geri çekildi; yeni sürüm yükleyebilirsiniz.')).toBeVisible();

  await cust.goto(`/siparisler/${id}`);
  await expect(cust.getByRole('button', { name: 'Çizimi onayla' })).toHaveCount(0);
  await expect(cust.getByText('geri çekildi').first()).toBeVisible();
  await expect(cust.getByText('Yanlış ölçü gönderildi').first()).toBeVisible();

  // Yeni sürüm (v2) — v1 geçmişte kalır
  await drawer.setInputFiles('#drawing-file', sampleFile('dus-v2.pdf', 'pdf v2'));
  await drawer.getByRole('button', { name: 'Taslağa yükle' }).click();
  drawer.once('dialog', (d) => d.accept());
  await drawer.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(drawer.getByText('Çizim müşterinin onayına gönderildi.')).toBeVisible();
  await expect(drawer.getByText('v2 · güncel')).toBeVisible();
  await expect(drawer.locator('.drawing-version', { hasText: 'dus-v1.dxf' })).toContainText('geri çekildi');

  await cust.goto(`/siparisler/${id}`);
  await cust.getByRole('button', { name: 'Çizimi onayla' }).click();
  await expect(cust.getByText(/Çizimi onayladınız|üretime alındı/)).toBeVisible();
});
