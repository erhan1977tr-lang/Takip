import { test, expect } from '@playwright/test';
import {
  ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, GLASS, SALES, TEAM_PW as PW,
  as, createUser, fillOffer, firstLogin, login, newOrder, outboxCodeFor,
} from './helpers';

// Sipariş akışı: çizim ve teklif hatları bağımsız; müşteri yalnızca çizimi onaylar, teklifi görür.
test.describe.configure({ mode: 'serial' });

const BETA = 'beta@betacam.test';
const ids: { a?: string; b?: string; drawing?: string } = {};

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

test('teklif yolu: çizim gerekmez → teklif → yönetici onayı → müşteri görür (onaylamaz) → üretim', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  ids.a = await newOrder(cust, 'Duş kabini', 'Darius.dwg');
  await expect(cust.getByText('UNS1').first()).toBeVisible();

  const sales = await as(browser, SALES, PW);
  await expect(sales.getByRole('heading', { name: 'Satış Paneli' })).toBeVisible();
  const row = sales.locator('.card', { hasText: 'Yeni siparişler — karar bekliyor' }).locator('tr', { hasText: 'UNS1' });
  await expect(row).toBeVisible();
  await expect(row.getByText('Üns**********')).toBeVisible(); // satış tam adı görmez
  await sales.goto(`/siparisler/${ids.a}`);
  await expect(sales.getByText('Ünsal Cam', { exact: true })).toHaveCount(0);
  await expect(sales.getByText('Sıradaki adım: Çizim Ekibine Gönder · Teklife Gönder')).toBeVisible();
  await expect(sales.getByRole('button', { name: 'Beklemeye Al' })).toBeVisible();
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.getByText('Çizim gerekmiyor olarak işaretlendi.')).toBeVisible();
  await expect(sales.getByLabel('Açıklama').first()).toHaveValue(GLASS);
  await fillOffer(sales);
  await expect(sales.locator('.offer-table tfoot')).toContainText('249,00 EUR');
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  await expect(sales.getByText('Üretime almak için bekleniyor:')).toBeVisible();
  await expect(sales.getByRole('button', { name: 'Üretime al' })).toHaveCount(0);

  // Müşteri, yönetici onaylamadan teklifi göremez
  await cust.goto(`/siparisler/${ids.a}`);
  await expect(cust.getByRole('heading', { name: 'Teklifiniz' })).toHaveCount(0);

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/teklifler');
  await expect(admin.locator('.card', { hasText: 'Yönetici onayında' }).getByRole('link', { name: 'UNS1' })).toBeVisible();
  await admin.goto(`/siparisler/${ids.a}`);
  await expect(admin.getByText('Ünsal Cam').first()).toBeVisible(); // yönetici tam adı görür
  await admin.fill('#sandikEtiket', 'SB-M');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText('Fiyat onaylandı; teklif müşterinin panelinde.')).toBeVisible();

  // Müşteri teklifi görür ama onaylamaz
  await cust.goto(`/siparisler/${ids.a}`);
  await expect(cust.getByRole('heading', { name: 'Teklifiniz' })).toBeVisible();
  await expect(cust.locator('#teklif tfoot')).toContainText('249,00 EUR');
  await expect(cust.getByRole('button', { name: /onayla/i })).toHaveCount(0);
  await cust.goto('/teklifler');
  await expect(cust.getByRole('link', { name: 'UNS1' })).toBeVisible();
  await expect(cust.getByText('249,00 EUR')).toBeVisible();

  // Satış üretime alır
  await sales.goto(`/siparisler/${ids.a}`);
  await sales.getByRole('button', { name: 'Üretime al' }).click();
  await expect(sales.getByText('Sipariş üretime alındı.')).toBeVisible();
  await sales.getByRole('button', { name: 'Yüklendi olarak işaretle' }).click();
  await expect(sales.getByText('Sipariş yüklendi olarak işaretlendi.')).toBeVisible();
  await sales.getByRole('button', { name: 'Arşivle' }).click();
  await expect(sales.getByText('Sipariş arşivlendi.')).toBeVisible();

  await cust.goto('/siparisler?view=archive');
  await expect(cust.getByRole('link', { name: 'UNS1' })).toBeVisible();
});

test('çizim yolu: çizim ve teklif paralel yürür; üretim ikisi de tamamlanınca açılır', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  ids.b = await newOrder(cust, 'Merdiven korkuluğu', 'korkuluk.pdf');

  const sales = await as(browser, SALES, PW);
  await sales.goto(`/siparisler/${ids.b}`);
  await sales.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(sales.getByText('Sipariş çizim ekibine yönlendirildi.')).toBeVisible();

  // Satış, çizim beklemeden teklifi yazar
  await fillOffer(sales);
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${ids.b}`);
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText('Fiyat onaylandı; teklif müşterinin panelinde.')).toBeVisible();

  // Teklif müşteride ama çizim bitmediği için üretime alınamaz
  await sales.goto(`/siparisler/${ids.b}`);
  await expect(sales.getByRole('button', { name: 'Üretime al' })).toHaveCount(0);
  await expect(sales.getByText('Çizim henüz tamamlanmadı')).toBeVisible();
  await cust.goto(`/siparisler/${ids.b}`);
  await expect(cust.getByRole('heading', { name: 'Teklifiniz' })).toBeVisible();
  await expect(cust.getByText('Çizim hazırlanıyor').first()).toBeVisible();

  const drawer = await as(browser, DRAWER, PW);
  await expect(drawer.getByRole('heading', { name: 'Çizim Paneli' })).toBeVisible();
  await expect(drawer.locator('.card', { hasText: 'Çizim işleri' }).getByRole('link', { name: 'UNS2' })).toBeVisible();
  const hidden = await drawer.goto(`/siparisler/${ids.a}`); // çizimsiz sipariş çizim ekibine görünmez
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

  await sales.goto(`/siparisler/${ids.b}`);
  await expect(sales.getByText('Çizim müşteri onayında')).toBeVisible();

  await cust.goto(`/siparisler/${ids.b}`);
  await cust.getByRole('button', { name: 'Çizimi onayla' }).click();
  await expect(cust.getByText('Çizimi onayladınız.')).toBeVisible();

  await sales.goto('/siparisler');
  const row = sales.locator('.card', { hasText: 'Üretime alınabilecekler' }).locator('tr', { hasText: 'UNS2' });
  await expect(row).toBeVisible();
  await expect(row.getByText('v2 · 1 tur')).toBeVisible();
  await sales.goto(`/siparisler/${ids.b}`);
  await expect(sales.getByRole('button', { name: 'Üretime al' })).toBeVisible();
});

test('teklif revizyonu: müşteri yeni sürüm onaylanana kadar eski teklifi görür', async ({ browser }) => {
  const sales = await as(browser, SALES, PW);
  await sales.goto(`/siparisler/${ids.b}`);
  await sales.getByRole('button', { name: 'Teklifi revize et' }).click();
  await expect(sales.getByText('Teklifin yeni sürümü açıldı.')).toBeVisible();
  await sales.getByLabel('Birim fiyat').first().fill('50');
  await expect(sales.locator('.offer-table tfoot')).toContainText('300,00 EUR');
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByRole('button', { name: 'Üretime al' })).toHaveCount(0);

  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/siparisler/${ids.b}`);
  await expect(cust.locator('#teklif tfoot')).toContainText('249,00 EUR');

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${ids.b}`);
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await cust.goto(`/siparisler/${ids.b}`);
  await expect(cust.locator('#teklif tfoot')).toContainText('300,00 EUR');
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
