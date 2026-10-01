import { test, expect } from '@playwright/test';
import { CUSTOMER, CUST_PW, SALES, TEAM_PW as PW, as } from './helpers';

// 02-orders'tan sonra çalışır: UNS2 üretimde, teklifi 1000×2000×3 (6 m², 66.3 lamine).
const LOAD_DAY = '2027-03-19';

test('yükleme takvimi: tahmini yük, gerçek sandık kaydı, müşteri ve firma izolasyonu', async ({ browser }) => {
  const sales = await as(browser, SALES, PW);
  await sales.goto('/siparisler?view=all&q=UNS2');
  await sales.getByRole('link', { name: 'UNS2' }).first().click();
  await expect(sales).toHaveURL(/\/siparisler\/[a-z0-9]+$/);
  const orderUrl = sales.url();
  await sales.fill('#ship-date', LOAD_DAY);
  await sales.getByRole('button', { name: 'Tarihi güncelle' }).click();
  await expect(sales.locator('.alert-ok')).toContainText('Tahmini yükleme tarihi güncellendi');
  // 6 m² × 30 kg/m² (katalogdaki ağırlık, karar 22) = 180 kg → 1 sandık, brüt 230 kg (yükleme sekmesinde)
  // Satışın sipariş sayfasında "Sandıklar" bölümü yok (sandıklar Yüklemeler sekmesinde)
  await expect(sales.locator('#sandik')).toHaveCount(0);
  await expect(sales.getByRole('button', { name: 'Sandıkları kaydet' })).toHaveCount(0); // sipariş sayfasında giriş yok

  await sales.getByRole('link', { name: 'Yüklemeler' }).first().click();
  await expect(sales.getByRole('heading', { name: 'Yüklemeler', exact: true })).toBeVisible();
  await sales.goto(`/yuklemeler?gun=${LOAD_DAY}`);
  await expect(sales.getByRole('heading', { name: 'Yükleme: 19.03.2027' })).toBeVisible();
  const table = sales.locator('.load-table');
  await expect(table.getByRole('link', { name: 'UNS2' })).toBeVisible();
  await expect(table).toContainText('Üns**********'); // satış tam adı görmez
  await expect(table.locator('tfoot')).toContainText('230');
  await expect(sales.locator('.cal-day.sel')).toContainText('Üns**********');
  await sales.goto('/yuklemeler?view=liste&ay=2027-03');
  await expect(sales.getByRole('link', { name: '19.03.2027' })).toBeVisible();

  // Gerçek sandık kaydı yükleme sekmesinde (müşteri + gün): tahminin önüne geçer
  await sales.goto(`/yuklemeler?gun=${LOAD_DAY}`);
  await sales.locator('.crate-row summary').first().click();
  await sales.getByRole('button', { name: '+ Sandık ekle' }).click();
  await sales.getByLabel('Uzunluk (mm) (1)').fill('2400');
  await sales.getByLabel('Genişlik (mm) (1)').fill('1600');
  await sales.getByLabel('Yükseklik (mm) (1)').fill('900');
  await sales.getByLabel('Net ağırlık (kg) (1)').fill('190');
  await sales.getByLabel('Brüt ağırlık (kg) (1)').fill('150');
  await sales.getByRole('button', { name: 'Sandıkları kaydet' }).click();
  await expect(sales.locator('.crate-editor .alert-error')).toContainText('brüt ağırlık netten küçük olamaz');
  await sales.getByLabel('Brüt ağırlık (kg) (1)').fill('260');
  await expect(sales.locator('.crate-editor')).toContainText('Net 190 kg · Brüt 260 kg');
  await sales.getByRole('button', { name: 'Sandıkları kaydet' }).click();
  await expect(sales.locator('.crate-editor .alert-ok')).toContainText('Sandıklar kaydedildi.');
  await sales.reload();
  await expect(sales.locator('.load-table tfoot')).toContainText('260');
  await expect(sales.locator('.load-table').getByText('gerçek').first()).toBeVisible();
  await expect(sales.getByLabel('Uzunluk (mm) (1)')).toHaveValue('2400');
  await expect(sales.locator('.crate-editor .badge')).toContainText('güncellendi');
  await sales.goto(orderUrl);
  await expect(sales.locator('#sandik')).toHaveCount(0);

  // Müşteri kendi takviminde görür; teklif tutarı müşteriye gönderilmiş tekliften
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.getByRole('link', { name: 'Yükleme takvimim' }).first().click();
  await expect(cust.getByRole('heading', { name: 'Yükleme takvimim' })).toBeVisible();
  await cust.goto(`/yuklemeler?gun=${LOAD_DAY}`);
  await expect(cust.locator('.load-table').getByRole('link', { name: 'UNS2' })).toBeVisible();
  await expect(cust.locator('.load-table')).toContainText('300,00 EUR');

  // Başka firmanın müşterisi göremez
  const beta = await as(browser, 'beta@betacam.test', PW);
  await beta.goto(`/yuklemeler?gun=${LOAD_DAY}`);
  await expect(beta.getByText('Bu gün için yükleme yok.')).toBeVisible();
});
