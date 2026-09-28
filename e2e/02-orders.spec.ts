import { test, expect, type Browser, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, createUser, firstLogin, login, outboxCodeFor } from './helpers';

// Sipariş akışı: teklif yolu ve çizim yolu, rol yetkileri, firma izolasyonu, iç notlar.
test.describe.configure({ mode: 'serial' });

const SALES = 'satis@e2e.test';
const DRAWER = 'cizim@e2e.test';
const BETA = 'beta@betacam.test';
const PW = 'Ekip2026abc';
const GLASS = '66.3 Temper Lamine Cam (Şeffaf)';

const ids: { a?: string; b?: string; drawing?: string } = {};

async function as(browser: Browser, email: string, pw: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await login(page, email, pw);
  return page;
}

async function newOrder(page: Page, title: string, fileName: string): Promise<string> {
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

test('hazırlık: katalog, satış, çizim ve ikinci müşteri', async ({ page }) => {
  await login(page, ADMIN, ADMIN_PW);
  await page.goto('/admin/katalog');
  await page.getByLabel('Cam adı').first().fill(GLASS);
  await page.getByRole('button', { name: 'Kataloğa ekle' }).click();
  await expect(page.getByText('Cam kataloğa eklendi.')).toBeVisible();
  await page.getByPlaceholder(/örn\. 66\.3/).fill('4mm Float Cam');
  await page.getByRole('button', { name: 'Kataloğa ekle' }).click();

  await page.goto('/admin/firms');
  await page.fill('#f-name', 'Beta Cam');
  await page.fill('#f-prefix', 'BET');
  await page.click('form.card button[type=submit]');
  await expect(page.getByText('“Beta Cam” firması oluşturuldu (ön ek: BET)')).toBeVisible();

  await createUser(page, { email: SALES, name: 'Satış Kişi', role: 'Satış', firm: 'GKH Trading' });
  await createUser(page, { email: DRAWER, name: 'Çizim Kişi', role: 'Çizimci', firm: 'GKH Trading' });
  await createUser(page, { email: BETA, name: 'Beta Müşteri', role: 'Müşteri', firm: 'Beta Cam', canApprove: true });

  for (const email of [SALES, DRAWER, BETA]) {
    const ctx = await page.context().browser()!.newContext();
    const p = await ctx.newPage();
    await firstLogin(p, email, outboxCodeFor(email), PW);
    await ctx.close();
  }
});

test('teklif yolu: sipariş → teklif → yönetici onayı → müşteri onayı → yükleme', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  // Bu müşterinin onay yetkisi 01-onboarding'de verildi.
  ids.a = await newOrder(cust, 'Duş kabini', 'Darius.dwg');
  await expect(cust.getByText('UNS1').first()).toBeVisible();

  const sales = await as(browser, SALES, PW);
  await expect(sales.getByRole('heading', { name: 'Satış Paneli' })).toBeVisible();
  const row = sales.locator('tr', { hasText: 'UNS1' }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText('Üns**********')).toBeVisible(); // satış tam adı görmez
  await sales.goto(`/siparisler/${ids.a}`);
  await expect(sales.getByText('Ünsal Cam', { exact: true })).toHaveCount(0);
  await sales.getByRole('button', { name: 'Teklife Gönder (çizim gerekmiyor)' }).click();
  await expect(sales.getByText('Teklif tablosu açıldı.')).toBeVisible();
  await expect(sales.getByLabel('Açıklama').first()).toHaveValue(GLASS);
  await sales.getByLabel('En', { exact: true }).first().fill('1000');
  await sales.getByLabel('Boy', { exact: true }).first().fill('2000');
  await sales.getByLabel('Birim fiyat').first().fill('41,5');
  await expect(sales.locator('tfoot')).toContainText('249,00 EUR');
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  await expect(sales.getByText('Fiyat onayında').first()).toBeVisible();

  // Müşteri henüz teklifi göremez
  await cust.goto(`/siparisler/${ids.a}`);
  await expect(cust.getByRole('heading', { name: 'Teklifiniz' })).toHaveCount(0);

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/siparisler');
  await expect(admin.locator('.card', { hasText: 'Fiyat onayı bekleyen teklifler' }).getByText('UNS1')).toBeVisible();
  await admin.goto(`/siparisler/${ids.a}`);
  await expect(admin.getByText('Ünsal Cam').first()).toBeVisible(); // yönetici tam adı görür
  await admin.fill('#sandikEtiket', 'SB-M');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText('Fiyat onaylandı; teklif müşterinin panelinde.')).toBeVisible();

  await cust.goto(`/siparisler/${ids.a}`);
  await expect(cust.getByText('Teklifiniz hazır').first()).toBeVisible();
  await expect(cust.locator('#teklif tfoot')).toContainText('249,00 EUR');
  await cust.getByRole('button', { name: 'Teklifi onayla ve üretime al' }).click();
  await expect(cust.getByText('Teklifi onayladınız. Siparişiniz üretime alındı.')).toBeVisible();

  await sales.goto(`/siparisler/${ids.a}`);
  await sales.getByRole('button', { name: 'Yüklendi olarak işaretle' }).click();
  await expect(sales.getByText('Sipariş yüklendi olarak işaretlendi.')).toBeVisible();
  await sales.getByRole('button', { name: 'Arşivle' }).click();
  await expect(sales.getByText('Sipariş arşivlendi.')).toBeVisible();

  await cust.goto('/siparisler?view=archive');
  await expect(cust.getByRole('link', { name: 'UNS1' })).toBeVisible();
});

test('çizim yolu: çizime gönder → üstlen → yükle → revizyon → v2 → onay', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  ids.b = await newOrder(cust, 'Merdiven korkuluğu', 'korkuluk.pdf');

  const sales = await as(browser, SALES, PW);
  await sales.goto(`/siparisler/${ids.b}`);
  await sales.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(sales.getByText('Sipariş çizim ekibine gönderildi.')).toBeVisible();

  const drawer = await as(browser, DRAWER, PW);
  await expect(drawer.getByRole('heading', { name: 'Çizim Paneli' })).toBeVisible();
  await expect(drawer.locator('.card', { hasText: 'Çizim işleri' }).getByText('UNS2')).toBeVisible();
  // Çizimsiz sipariş çizim ekibine görünmez
  const hidden = await drawer.goto(`/siparisler/${ids.a}`);
  expect(hidden?.status()).toBe(404);

  await drawer.goto(`/siparisler/${ids.b}`);
  await drawer.getByRole('button', { name: 'Çizimi üstlen' }).click();
  await expect(drawer.getByText('Çizim işini üstlendiniz.')).toBeVisible();
  await drawer.setInputFiles('#drawing-file', { name: 'korkuluk-v1.dxf', mimeType: 'application/octet-stream', buffer: Buffer.from('dxf v1') });
  await drawer.getByRole('button', { name: 'Yükle ve onaya gönder' }).click();
  await expect(drawer.getByText('Çizim yüklendi ve müşterinin onayına gönderildi.')).toBeVisible();

  await cust.goto(`/siparisler/${ids.b}`);
  await expect(cust.getByText('Onayınız bekleniyor').first()).toBeVisible();
  const href = await cust.locator('a[href^="/dosya/cizim/"]').first().getAttribute('href');
  ids.drawing = href!.split('/').pop();
  const dl = await cust.request.get(href!);
  expect(dl.status()).toBe(200);
  expect(await dl.text()).toBe('dxf v1');
  await cust.fill('#rev-comment', 'Korkuluk yüksekliği 1100 mm olmalı');
  await cust.getByRole('button', { name: 'Revizyon iste' }).click();
  await expect(cust.getByText('Revizyon talebiniz çizim ekibine iletildi.')).toBeVisible();

  await drawer.goto(`/siparisler/${ids.b}`);
  await expect(drawer.getByText('Korkuluk yüksekliği 1100 mm olmalı').first()).toBeVisible();
  await drawer.setInputFiles('#drawing-file', { name: 'korkuluk-v2.dxf', mimeType: 'application/octet-stream', buffer: Buffer.from('dxf v2') });
  await drawer.getByRole('button', { name: 'Yükle ve onaya gönder' }).click();
  await expect(drawer.getByText('v2 · güncel')).toBeVisible();

  await cust.goto(`/siparisler/${ids.b}`);
  await cust.getByRole('button', { name: 'Çizimi onayla' }).click();
  await expect(cust.getByText('Çizimi onayladınız. Teklifiniz hazırlanıyor.')).toBeVisible();

  await sales.goto('/siparisler');
  const row = sales.locator('.card', { hasText: 'Teklif hazırlanacaklar' }).locator('tr', { hasText: 'UNS2' });
  await expect(row).toBeVisible();
  await expect(row.getByText('v2 · 1 tur')).toBeVisible();
});

test('notlar: iç not müşteriye görünmez', async ({ browser }) => {
  const sales = await as(browser, SALES, PW);
  await sales.goto(`/siparisler/${ids.b}`);
  await sales.getByLabel('Not', { exact: true }).fill('Müşteriyle fiyatı telefonda konuştuk');
  await sales.locator('input[name=internal]').check();
  await sales.getByRole('button', { name: 'Gönder', exact: true }).click();
  await expect(sales.getByText('Not eklendi.')).toBeVisible();
  await sales.getByLabel('Not', { exact: true }).fill('Teklifiniz bugün hazır olacak');
  await sales.getByRole('button', { name: 'Gönder', exact: true }).click();

  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/siparisler/${ids.b}`);
  await expect(cust.getByText('Teklifiniz bugün hazır olacak')).toBeVisible();
  await expect(cust.getByText('Müşteriyle fiyatı telefonda konuştuk')).toHaveCount(0);
});

test('izolasyon: başka firmanın müşterisi siparişi ve dosyayı göremez', async ({ browser }) => {
  const beta = await as(browser, BETA, PW);
  await expect(beta.getByText('UNS1')).toHaveCount(0);
  const res = await beta.goto(`/siparisler/${ids.b}`);
  expect(res?.status()).toBe(404);
  const dl = await beta.request.get(`/dosya/cizim/${ids.drawing}`);
  expect(dl.status()).toBe(404);
  await beta.goto('/siparisler/yeni');
  await expect(beta.getByText('BET1')).toBeVisible();

  // Giriş yapmamış biri dosya indiremez
  const ctx = await browser.newContext();
  const anon = await ctx.request.get(`/dosya/cizim/${ids.drawing}`);
  expect(anon.status()).toBe(401);
});
