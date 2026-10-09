import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as, fillOffer, login, newOrder } from './helpers';

// Sipariş sayfasının bölüm sırası (3.62.1, karar 214): teknik çizimi olan siparişte yönetici, satış, müşteri ve denetimci
// panelinde Sipariş Bilgileri → Teklif Tablosu → Teknik Çizim ve Onaylar — masaüstü ve telefon genişliğinde. Yalnızca yer
// değişti: hangi rolün hangi bölümü gördüğü aynı. Çizim ekibinin ekranı (teklif tablosu yok) değişmedi: müşteri dosyaları →
// çizim dosyaları → çizim onayı / revizyon → notlar → sipariş bilgileri.
// FGO / e-posta / Google'a istek yapılmaz.
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)
const INSPECTOR = 'denetim@e2e.test';
let id = '';

/** Bölümlerin sayfadaki dikey yeri (belge koordinatı) — yoksa null. Görsel sıra = ekrandaki sıra. */
const tops = (page: Page) => page.evaluate(() => Object.fromEntries(['bilgiler', 'teklif', 'cizim', 'cizim-dosyalari', 'notlar'].map((key) => {
  const el = document.getElementById(key);
  return [key, el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null];
}))) as Promise<Record<string, number | null>>;

/** Sipariş Bilgileri → Teklif Tablosu → Teknik Çizim ve Onaylar; ayrıca sayfa yatay taşmaz */
async function infoOfferDrawing(page: Page, who: string) {
  await expect(page.locator('#bilgiler')).toBeVisible();
  await expect(page.locator('#teklif')).toBeVisible();
  await expect(page.locator('#cizim')).toBeVisible();
  const t = await tops(page);
  expect(t.bilgiler!, `${who}: bilgiler < teklif`).toBeLessThan(t.teklif!);
  expect(t.teklif!, `${who}: teklif < çizim`).toBeLessThan(t.cizim!);
  // Çizim kartı tek (çizim ekibinin ayrı kartları bu rollerde yok)
  await expect(page.locator('#cizim-dosyalari')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${who}: yatay taşma yok`).toBe(true);
}

test('teknik çizimli sipariş: yönetici, satış, müşteri, denetimci — Sipariş Bilgileri → Teklif Tablosu → Teknik Çizim ve Onaylar (masaüstü)', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  id = await newOrder(cust, 'Bölüm sırası', 'bolum-sirasi.pdf');
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${id}`);
  await sales.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(sales.locator('.offer-table')).toBeVisible(); // teklif hattı çizimle paralel açılır
  // Satış — teklif düzenlenirken
  await infoOfferDrawing(sales, 'satış (düzenleme)');
  await fillOffer(sales, '40');
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  // Satış — salt okunur teklif (yöneticide)
  await infoOfferDrawing(sales, 'satış (yöneticide)');

  // Yönetici — fiyat onayı (düzenleyici), sonra gönderilmiş teklif
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${id}`);
  await infoOfferDrawing(admin, 'yönetici (fiyat onayı)');
  await admin.getByLabel('Müşteri fiyatı', { exact: true }).first().fill('50');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText(/Fiyat onaylandı/).first()).toBeVisible();
  await infoOfferDrawing(admin, 'yönetici (gönderildi)');

  // Müşteri ve denetimci — gönderilmiş teklif + çizim kartı (çizim henüz gelmedi; kart yine teklifin altında)
  await cust.goto(`/siparisler/${id}`);
  await infoOfferDrawing(cust, 'müşteri');
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(`/siparisler/${id}`);
  await infoOfferDrawing(insp, 'denetimci');
  // Görünürlük değişmedi: müşteri satış fiyatını / satış rozetini görmez, çizim kartı yalnızca kendi düğmeleriyle
  await expect(cust.locator('#teklif tfoot')).toContainText('300,00 EUR'); // 6 m² × 50 (müşteri fiyatı)
  expect(await cust.content()).not.toContain('240,00');

  // Çizim ekibi: teklif tablosu yok; kendi sırası değişmedi
  const drawer = await as(browser, DRAWER, TEAM_PW);
  await drawer.goto(`/siparisler/${id}`);
  await expect(drawer.locator('#cizim-dosyalari')).toBeVisible();
  await expect(drawer.locator('#teklif')).toHaveCount(0);
  const d = await tops(drawer);
  expect(d['cizim-dosyalari']!).toBeLessThan(d.cizim!);
  expect(d.cizim!).toBeLessThan(d.notlar!);
  expect(d.notlar!).toBeLessThan(d.bilgiler!);
  await Promise.all([cust.context().close(), sales.context().close(), admin.context().close(), insp.context().close(), drawer.context().close()]);
});

test('telefon genişliği (390 × 844): satış ve müşteri aynı sırayla; çizimi olmayan siparişte çizim kartı yok', async ({ browser }) => {
  for (const [email, pw, who] of [[SALES, TEAM_PW, 'satış'], [CUSTOMER, CUST_PW, 'müşteri']] as const) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await login(page, email, pw);
    await page.goto(`/siparisler/${id}`);
    await infoOfferDrawing(page, `${who} (telefon)`);
    await ctx.close();
  }
  // Çizimi olmayan sipariş ("Teklife Gönder"): çizim kartı hiç yok (koşul değişmedi)
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const plain = await newOrder(cust, 'Çizimsiz sıra', 'cizimsiz-sira.pdf');
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${plain}`);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.locator('.offer-table')).toBeVisible();
  await expect(sales.locator('#cizim')).toHaveCount(0);
  const t = await tops(sales);
  expect(t.bilgiler!).toBeLessThan(t.teklif!);
  await Promise.all([cust.context().close(), sales.context().close()]);
});
