import { test, type Browser } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, login } from './helpers';

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
  await shoot(browser, null, [['01-giris', '/login']]);
  await shoot(browser, [CUSTOMER, CUST_PW], [
    ['02-musteri-siparislerim', '/siparisler'],
    ['03-musteri-yeni-siparis', '/siparisler/yeni'],
    ['04-musteri-siparis-detay', uns2],
  ]);
  await shoot(browser, ['satis@e2e.test', 'Ekip2026abc'], [
    ['05-satis-paneli', '/siparisler'],
    ['06-satis-teklif-tablosu', uns2],
  ]);
  await shoot(browser, ['cizim@e2e.test', 'Ekip2026abc'], [['07-cizim-paneli', '/siparisler?view=all']]);
  await shoot(browser, [ADMIN, ADMIN_PW], [
    ['08-yonetici-kullanicilar', '/admin/users'],
    ['09-yonetici-musteriler', '/admin/firms'],
    ['10-yonetici-katalog', '/admin/katalog'],
  ]);
  await shoot(browser, null, [['01-giris', '/login']], true);
  await shoot(browser, [CUSTOMER, CUST_PW], [
    ['02-musteri-siparislerim', '/siparisler'],
    ['04-musteri-siparis-detay', uns2],
  ], true);
  await shoot(browser, ['satis@e2e.test', 'Ekip2026abc'], [['06-satis-teklif-tablosu', uns2]], true);
});
