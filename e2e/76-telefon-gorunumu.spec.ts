import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, as, login } from './helpers';

// 4.2.31 — telefonda profil siparişi okunur olmalı (müşteri bildirimi): yalnızca görünüm. Dar ekranda (360 px)
//  - sayfa yatay taşmaz (telefon tarayıcısı sayfayı küçültüp yazıları okunmaz hâle getirmez),
//  - adım çubuğu dikeydir ve adım adları kelime ortasından bölünmez,
//  - ürün / teklif satırları kart olarak görünür: adet, birim fiyat ve tutar ekranın içinde, etiketleriyle,
// geniş ekranda tablo eskisi gibi (başlık satırı görünür). İşlev, değer ve akış değişmez.
test.describe.configure({ mode: 'serial' });
const PHONE = { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true };
let url = '';

async function phone(browser: import('@playwright/test').Browser): Promise<Page> {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await login(page, CUSTOMER, CUST_PW);
  return page;
}

async function noHorizontalOverflow(page: Page) {
  const { sw, w } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(sw, 'sayfa yatay taşmamalı').toBeLessThanOrEqual(w);
  expect(w).toBe(360);
}

/** Hücre ekranın içinde (yatay kaydırmanın arkasında değil) */
async function inViewport(page: Page, sel: import('@playwright/test').Locator) {
  const box = await sel.boundingBox();
  expect(box, 'hücre görünür olmalı').toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
}

async function stepperReadable(page: Page) {
  const steps = page.locator('.profile-stepper .step');
  expect(await steps.count()).toBe(7);
  const rows = await steps.evaluateAll((els) => els.map((el) => {
    const lbl = el.querySelector('.lbl') as HTMLElement;
    const lh = parseFloat(getComputedStyle(lbl).lineHeight);
    return { top: el.getBoundingClientRect().top, lines: Math.round(lbl.getBoundingClientRect().height / lh) };
  }));
  for (let i = 0; i < rows.length; i++) {
    expect(rows[i].lines, `adım ${i + 1} adı tek satır`).toBe(1);
    if (i > 0) expect(rows[i].top, 'adımlar alt alta').toBeGreaterThan(rows[i - 1].top);
  }
}

test('telefon: yeni profil siparişi ve sipariş sayfası okunur (taşma yok, adımlar dikey, ürün kartları)', async ({ browser }) => {
  const cust = await phone(browser);
  await cust.goto('/siparisler/yeni?tip=PROFILE_ORDER');
  await noHorizontalOverflow(cust);
  await cust.fill('#title', 'Telefon görünümü');
  await cust.locator('tr', { hasText: 'GK15' }).locator('input.qty-input').fill('2');
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  const again = cust.locator('#stok-uyari').getByRole('button', { name: 'Yine de gönder' });
  // Stok uyarısı (karar 177) çıkarsa "Yine de gönder"; çıkmazsa sipariş doğrudan oluşur
  await Promise.race([cust.waitForURL(/ok=profile_created/), again.waitFor()]);
  if (await again.isVisible()) await again.click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=profile_created/);
  url = new URL(cust.url()).pathname;

  await noHorizontalOverflow(cust);
  await stepperReadable(cust);
  const table = cust.locator('table.profile-lines');
  await expect(table.locator('thead')).toBeHidden();
  const row = table.locator('tbody tr', { hasText: 'GK15' });
  const qty = row.locator('td[data-label="Adet"]');
  await expect(qty).toHaveText('2');
  // Etiket hücrenin üstünde (CSS ::before, data-label'dan)
  expect(await qty.evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"Adet"');
  await inViewport(cust, qty);
  await inViewport(cust, row.locator('td.pl-name'));
  await cust.context().close();
});

test('telefon: gönderilen teklifte birim fiyat ve tutar ekranda; geniş ekranda tablo değişmedi', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(url);
  const prices = admin.locator('form#teklif input[name=l_price]');
  for (let i = 0; i < await prices.count(); i++) if (!(await prices.nth(i).inputValue())) await prices.nth(i).fill('12,50');
  await admin.locator('form#teklif').getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(admin.getByText('Teklif müşteriye gönderildi.')).toBeVisible();
  await admin.context().close();

  const cust = await phone(browser);
  await cust.goto(url);
  await noHorizontalOverflow(cust);
  await stepperReadable(cust);
  const offer = cust.locator('#teklif table.profile-lines');
  const row = offer.locator('tbody tr', { hasText: 'GK15' });
  for (const label of ['Adet', 'Birim fiyat', 'Tutar']) {
    const cell = row.locator(`td[data-label^="${label}"]`);
    await expect(cell).toBeVisible();
    await inViewport(cust, cell);
  }
  await inViewport(cust, offer.locator('tfoot td').last());
  await cust.context().close();

  // Geniş ekran: aynı sayfa tablo olarak (başlık satırı görünür, adım çubuğu yatay)
  const desk = await as(browser, CUSTOMER, CUST_PW);
  await desk.goto(url);
  await expect(desk.locator('#teklif table.profile-lines thead')).toBeVisible();
  const tops = await desk.locator('.profile-stepper .step').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size, 'geniş ekranda adımlar tek satırda').toBe(1);
  await desk.context().close();
});
