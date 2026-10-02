import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, GLASS, TEAM_PW, as, newOrder } from './helpers';

const SALES = 'fiyat-satis@e2e.test'; // 08'de açıldı (05'te satis@e2e.test bilerek kilitlendi)

// Görünüm 3. aşama: sipariş sayfasının bölüm sırası (dosyalar → notlar → sipariş bilgileri → teklif) ve teklif
// tablosunun araçları (aynı camdan "+", sandık parası, tek fiyat, tabloyu temizle). İş kuralları değişmedi.
test('sipariş sayfası: bölüm sırası ve teklif tablosu araçları', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Düzen', 'duzen.pdf'); // siparişte 3 adet cam
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${id}`);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.locator('.offer-table')).toBeVisible();

  // Satış: işlemler → müşteri dosyaları → notlar → sipariş bilgileri → teklif tablosu; "İstenen camlar" ve "Sandıklar" yok
  const order = async (page: typeof sales) => {
    const heads = await page.locator('main h2').allTextContents();
    return (h: string) => heads.findIndex((x) => x.includes(h));
  };
  let pos = await order(sales);
  expect(pos('Müşteri sipariş dosyaları')).toBeGreaterThanOrEqual(0);
  expect(pos('Müşteri sipariş dosyaları')).toBeLessThan(pos('Notlar'));
  expect(pos('Notlar')).toBeLessThan(pos('Sipariş bilgileri'));
  expect(pos('Sipariş bilgileri')).toBeLessThan(pos('Teklif tablosu'));
  expect(pos('Sandıklar')).toBe(-1);
  await expect(sales.getByText('İstenen camlar')).toHaveCount(0);

  // Aynı camdan "+": hemen altına, aynı cam adıyla yeni satır
  const desc = sales.getByLabel('Açıklama', { exact: true });
  const price = sales.getByLabel('Birim fiyat', { exact: true });
  await expect(desc).toHaveCount(1);
  await sales.getByRole('button', { name: 'Aynı camdan yeni satır ekle' }).click();
  await expect(desc).toHaveCount(2);
  await expect(desc.nth(1)).toHaveValue(GLASS);
  await sales.getByRole('button', { name: '+CNC' }).first().click();
  await sales.getByLabel('CNC fiyatı').fill('15');

  // "Tek fiyatı tüm satırlara uygula": işaretliyken m² cam satırlarının hepsine; CNC satırı değişmez
  await sales.getByLabel('Tek fiyatı tüm satırlara uygula').check();
  await price.first().fill('44');
  await expect(price.nth(1)).toHaveValue('44');
  await expect(sales.getByLabel('CNC fiyatı')).toHaveValue('15');
  await sales.getByLabel('Tek fiyatı tüm satırlara uygula').uncheck();
  await price.nth(1).fill('40');
  await expect(price.first()).toHaveValue('44');

  // "+ Sandık parası": adetle fiyatlanan normal satır
  await sales.getByRole('button', { name: /Sandık parası/ }).click();
  await expect(desc.nth(2)).toHaveValue('Sandık parası');

  // "Tabloyu temizle" (onaylı): tablo siparişteki ilk hâline döner; kaydedilmedikçe hiçbir şey yazılmaz
  await sales.getByRole('button', { name: 'Tabloyu temizle' }).click();
  await expect(desc).toHaveCount(1);
  await expect(desc.first()).toHaveValue(GLASS);
  await expect(sales.getByLabel('Adet', { exact: true })).toHaveValue('3');
  await expect(sales.getByLabel('CNC fiyatı')).toHaveCount(0);

  // Yönetici: aynı sıra; "İstenen camlar" sipariş bilgilerinde durur
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${id}`);
  pos = await order(admin);
  expect(pos('Müşteri sipariş dosyaları')).toBeLessThan(pos('Notlar'));
  expect(pos('Notlar')).toBeLessThan(pos('Sipariş bilgileri'));
  await expect(admin.getByText('İstenen camlar')).toBeVisible();
});
