import { test, type Browser } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, SALES, TEAM_PW, as, login, newOrder } from './helpers';

// Görsel kontrol için ekran görüntüleri (yalnızca SCREENSHOT_DIR ayarlıysa çalışır).
const DIR = process.env.SCREENSHOT_DIR;
test.skip(!DIR, 'SCREENSHOT_DIR ayarlı değil');

async function shoot(browser: Browser, who: [string, string] | null, shots: [string, string][], mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  if (who) await login(page, who[0], who[1]);
  for (const [name, url] of shots) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(DIR!, `${mobile ? 'mobil' : 'masaustu'}-${name}.png`), fullPage: true });
  }
  await ctx.close();
}

async function orderId(browser: Browser, no: string): Promise<string> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, ADMIN, ADMIN_PW);
  await page.goto(`/siparisler?view=all&q=${no}`);
  const href = await page.getByRole('link', { name: no }).first().getAttribute('href');
  await ctx.close();
  return href!;
}

test('ekran görüntüleri', async ({ browser }) => {
  fs.mkdirSync(DIR!, { recursive: true });
  const uns2 = await orderId(browser, 'UNS2');
  // Satışın yeni sipariş görünümü ve çizim sürerken teklif tablosu için üçüncü sipariş
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const uns3 = `/siparisler/${await newOrder(cust, 'Ofis bölme camı', 'bolme.xlsx')}`;
  await cust.context().close();

  await shoot(browser, null, [['01-giris', '/login']]);
  await shoot(browser, [CUSTOMER, CUST_PW], [
    ['02-musteri-siparislerim', '/siparisler'],
    ['03-musteri-yeni-siparis', '/siparisler/yeni'],
    ['04-musteri-siparis-detay', uns2],
    ['05-musteri-tekliflerim', '/teklifler'],
  ]);
  await shoot(browser, [SALES, TEAM_PW], [
    ['06-satis-paneli', '/siparisler'],
    ['07-satis-yeni-siparis-karar', uns3],
  ]);
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(uns3);
  await sales.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await sales.waitForURL(/ok=to_drawing/);
  await sales.setViewportSize({ width: 1440, height: 900 });
  await sales.screenshot({ path: path.join(DIR!, 'masaustu-08-satis-cizim-surerken-teklif.png'), fullPage: true });
  await sales.context().close();
  await shoot(browser, [SALES, TEAM_PW], [['09-satis-uretimde', uns2], ['10-satis-teklifler', '/teklifler']]);
  await shoot(browser, ['cizim@e2e.test', TEAM_PW], [['11-cizim-paneli', '/siparisler']]);
  await shoot(browser, [ADMIN, ADMIN_PW], [
    ['12-yonetici-kullanicilar', '/admin/users'],
    ['13-yonetici-musteriler', '/admin/firms'],
    ['14-yonetici-katalog', '/admin/katalog'],
    ['15-yonetici-teklif-guncelle', `${uns2}?teklif=guncelle`],
    ['16-yonetici-siparisler', '/siparisler'],
  ]);
  await shoot(browser, [CUSTOMER, CUST_PW], [
    ['02-musteri-siparislerim', '/siparisler'],
    ['04-musteri-siparis-detay', uns2],
  ], true);
  await shoot(browser, [SALES, TEAM_PW], [['06-satis-paneli', '/siparisler?view=all']], true);
});
