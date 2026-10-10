import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, TEAM_PW, as, sampleFile } from './helpers';

// Aşama 5 — iki kademeli fiyat (karar 4): satış kendi fiyatını, yönetici müşteri fiyatını girer; müşteri fiyatları
// müşteriye özel tablodan gelir (karar 32). Satış müşteri fiyatını, müşteri satış fiyatını hiçbir yerde görmez.
test.describe.configure({ mode: 'serial' });
const SALES = 'fiyat-satis@e2e.test'; // 08'de açıldı; E2E Fiyat 2026 tablosunda (10 MM TEMPER CAM — BRONZ: 30)
const GLASS = '10 MM TEMPER CAM — BRONZ';

test('yönetici: müşteriye özel fiyat tablosu, firmaya bağlanır', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/musteri-fiyatlari');
  await expect(admin.getByRole('heading', { name: 'Müşteri Fiyatları', level: 1 })).toBeVisible();
  await admin.fill('#new-name', 'E2E Müşteri Özel');
  await admin.fill('#new-hole', '4');
  await admin.getByRole('button', { name: 'Tablo oluştur' }).click();
  await expect(admin.getByText('Tablo oluşturuldu.')).toBeVisible();
  await admin.getByPlaceholder('Cam ara…').fill('10 MM TEMPER CAM — BRONZ');
  await admin.getByLabel(`${GLASS} — Birim fiyat (EUR/m²)`).fill('45');
  await admin.getByRole('button', { name: 'Kaydet', exact: true }).last().click();
  await expect(admin.getByText('1 değişiklik kaydedildi.')).toBeVisible();
  await admin.locator('tr', { hasText: 'Ünsal Cam' }).getByRole('button', { name: 'Bu tabloya ata' }).click();
  await expect(admin.getByText('Atama kaydedildi.')).toBeVisible();
  await admin.context().close();
});

test('teklif: satış fiyatı ↔ müşteri fiyatı; kim neyi görür', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await cust.fill('#title', 'İki fiyat');
  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: GLASS });
  await cust.setInputFiles('#files', sampleFile('iki.pdf', 'iki'));
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/);
  const url = new URL(cust.url()).pathname;

  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(url);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.getByLabel('Birim fiyat').first()).toHaveValue('30.00');
  await sales.getByLabel('En', { exact: true }).first().fill('1000');
  await sales.getByLabel('Boy', { exact: true }).first().fill('2000');
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();

  // Yönetici: müşteri fiyatı müşterinin tablosundan dolu gelir (45), satış fiyatı (30) yanında
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(url);
  await expect(admin.getByLabel('Müşteri fiyatı').first()).toHaveValue('45.00');
  await expect(admin.getByText('Satış tutarı 60,00 · Müşteri tutarı 90,00 · Fark 30,00 EUR')).toBeVisible();
  await expect(admin.getByText('Müşteri fiyatları “E2E Müşteri Özel” tablosundan geldi.')).toBeVisible();
  // Yönetici ölçüyü değiştirir → satışın teklifi de değişir
  await admin.getByLabel('Boy', { exact: true }).first().fill('3000');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText(/Fiyat onaylandı|üretime alındı/).first()).toBeVisible();
  await admin.goto('/teklifler');
  const row = admin.locator('.card', { hasText: 'Müşteride' }).locator('tr', { hasText: 'İki fiyat' });
  await expect(row).toContainText('90,00 EUR'); // satış tutarı: 3 m² × 30
  await expect(row).toContainText('135,00 EUR'); // müşteri tutarı: 3 m² × 45

  // Müşteri yalnızca müşteri fiyatını görür
  await cust.goto(url);
  await expect(cust.locator('#teklif')).toContainText('135,00 EUR');
  await expect(cust.locator('#teklif')).toContainText('45,00');
  await expect(cust.locator('#teklif')).not.toContainText('30,00');
  await expect(cust.getByText('Fiyatlar KDV hariçtir.').first()).toBeVisible();
  // Toplam metraj (P2-B): salt okunur teklif tablosunun altında, hesap iki ondalık / gösterim üç ondalık; fiyattan bağımsız
  await expect(cust.locator('#teklif [data-offer-m2]')).toHaveText('Toplam metraj: 3,000 m²');
  await expect(cust.locator('#teklif [data-offer-m2]')).toHaveAttribute('data-offer-m2', '3.00');

  // Satış müşteri fiyatını hiçbir yerde görmez (sayfanın ham yanıtında da yok)
  await sales.goto(url);
  await expect(sales.locator('#teklif')).toContainText('90,00');
  await expect(sales.locator('#teklif [data-offer-m2]')).toHaveText('Toplam metraj: 3,000 m²');
  const html = await (await sales.request.get(url)).text();
  expect(html).not.toContain('135,00');
  expect(html).not.toContain('135.00');
  expect(html).not.toMatch(/"offerPrice":"?45/);
  const list = await (await sales.request.get('/teklifler')).text();
  expect(list).not.toContain('135,00');

  // Satışın Teklifler sayfası (fonksiyonel paket 1): yalnızca iki liste — "Fiyatımı bekleyenler" ve "Teklif tablosu
  // açılmamış siparişler". Yönetici onayındaki ve müşterideki teklifler (bu siparişinki dahil) burada listelenmez.
  const heads = async (p: typeof sales) => (await p.locator('main .card-head h2').allTextContents()).map((x) => x.replace(/\s*\d+\s*$/, '').trim());
  await sales.goto('/teklifler');
  expect(await heads(sales)).toEqual(['Fiyatımı bekleyenler', 'Teklif tablosu açılmamış siparişler']);
  await expect(sales.locator('main tr', { hasText: 'İki fiyat' })).toHaveCount(0);
  // Yöneticinin sayfası değişmedi: son teklifin durumuna göre üç grup; müşterideki teklif orada
  await admin.goto('/teklifler');
  expect(await heads(admin)).toEqual(['Satışta hazırlananlar', 'Yönetici onayında', 'Müşteride']);
  await expect(admin.locator('.card', { hasText: 'Müşteride' }).locator('tr', { hasText: 'İki fiyat' })).toHaveCount(1);
});
