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
  // 6 m² × 30 kg/m² (katalogdaki ağırlık, karar 22) = 180 kg → 1 sandık, brüt 230 kg
  await expect(sales.locator('#sandik')).toContainText('6,00 m²');
  await expect(sales.locator('#sandik')).toContainText('net 180 kg · 1 sandık · brüt 230 kg');

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

  // Gerçek sandık kaydı tahminin önüne geçer
  await sales.goto(orderUrl);
  await sales.getByLabel('Sandık ölçüsü').first().fill('2400×1600×900');
  await sales.getByLabel('Net kg').first().fill('190');
  await sales.getByLabel('Brüt kg').first().fill('260');
  await sales.getByRole('button', { name: 'Sandıkları kaydet' }).click();
  await expect(sales.locator('.alert-ok')).toContainText('Sandık ölçü ve ağırlıkları kaydedildi');
  await expect(sales.getByLabel('Sandık ölçüsü').first()).toHaveValue('2400×1600×900');
  await sales.goto(`/yuklemeler?gun=${LOAD_DAY}`);
  await expect(sales.locator('.load-table tfoot')).toContainText('260');
  await expect(sales.locator('.load-table').getByText('gerçek')).toBeVisible();

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
