import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, GLASS, TEAM_PW, as, sampleFile } from './helpers';

// Müşteri "Yeni Sipariş" (karar 85): sipariş tipi seçimi durur; cam siparişinde TEK cam tipi (formda "+ Cam ekle" yok,
// sunucu ikinci camı reddeder); tahmini yükleme tarihi mevcut hesaptan gelir ve siparişe aynı tarih yazılır; dosya
// alanı (sürükle-bırak görünümü, seçilenlerin listesi) aynı yükleme mekanizmasını kullanır; yeni sipariş müşterinin
// mevcut sipariş listesinde görünür. Eski çok camlı siparişler ve satış / yönetici teklif tablosu etkilenmez.
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te kilitleniyor)
let orderUrl = '';
let orderNo = '';
let shipDate = '';

async function shot(page: Page, name: string, mobile = false) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const before = page.viewportSize();
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `${mobile ? 'mobil' : 'masaustu'}-${name}.png`), fullPage: true });
  if (before) await page.setViewportSize(before);
}

test('yeni cam siparişi: tip seçimi, tek cam, yükleme tarihi, dosya listesi; sunucu ikinci camı reddeder', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  // Sipariş tipi seçimi yerinde (yeni tipler eklenebilir)
  await cust.goto('/siparisler/yeni');
  await expect(cust.getByRole('link', { name: /Cam siparişi/ })).toBeVisible();
  await expect(cust.getByRole('link', { name: /Profil siparişi/ })).toBeVisible();
  await cust.getByRole('link', { name: /Cam siparişi/ }).click();
  await expect(cust).toHaveURL(/tip=GLASS_ORDER/);
  await expect(cust.getByRole('heading', { name: 'Yeni Sipariş', exact: true })).toBeVisible();
  await expect(cust.getByRole('link', { name: 'Sipariş tipini değiştir' })).toHaveAttribute('href', '/siparisler/yeni');

  // Bölümler eski TAKİP sırasıyla
  const heads = await cust.locator('main h2').allTextContents();
  expect(heads.map((h) => h.trim())).toEqual(['Sipariş bilgileri', 'Sipariş dosyaları (zorunlu)', 'İstediğiniz cam kombinasyonu (zorunlu)', 'Ek bilgi (isteğe bağlı)']);

  // Tek cam: bir seçim alanı, "+ Cam ekle" yok
  await expect(cust.locator('select[name=glassId]')).toHaveCount(1);
  await expect(cust.getByRole('button', { name: /Cam ekle/ })).toHaveCount(0);
  await expect(cust.getByText('Bir siparişte tek cam tipi seçilir.')).toBeVisible();

  // Tahmini yükleme tarihi notu (GG.AA.YYYY, Cuma)
  const note = cust.locator('.ship-note');
  await expect(note).toHaveText(/^Bu siparişin tahmini yükleme tarihi \d{2}\.\d{2}\.\d{4} olacak; satış ekibi gerekirse günceller\.$/);
  shipDate = /(\d{2})\.(\d{2})\.(\d{4})/.exec(await note.innerText())![0];
  const [d, m, y] = shipDate.split('.').map(Number);
  expect(new Date(Date.UTC(y, m - 1, d)).getUTCDay()).toBe(5);

  // Gönder düğmesi: ad + dosya + cam olmadan kapalı
  const send = cust.getByRole('button', { name: 'Siparişi gönder' });
  await expect(send).toBeDisabled();
  await cust.fill('#title', 'Tek cam siparişi');

  // Dosyalar: iki ayrı seçim birikir, listede ad + boyutla görünür, biri çıkarılabilir (aynı dosya alanı gönderilir)
  await expect(cust.locator('#files')).toHaveAttribute('type', 'file');
  await cust.setInputFiles('#files', sampleFile('plan-a.pdf', 'plan a'));
  await cust.setInputFiles('#files', [sampleFile('olcu-b.dxf', 'olcu b'), sampleFile('yanlis-c.png', 'yanlis c')]);
  const picked = cust.locator('#secilen-dosyalar .file-row');
  await expect(picked).toHaveCount(3);
  await expect(cust.locator('#secilen-dosyalar')).toContainText('Yüklenecek dosyalar (3)');
  await expect(picked.nth(0)).toContainText('plan-a.pdf');
  await expect(picked.nth(0)).toContainText('MB');
  await cust.getByRole('button', { name: 'Çıkar: yanlis-c.png' }).click();
  await expect(picked).toHaveCount(2);
  expect(await cust.locator('#files').evaluate((el: HTMLInputElement) => Array.from(el.files ?? []).map((f) => f.name))).toEqual(['plan-a.pdf', 'olcu-b.dxf']);
  await expect(send).toBeDisabled(); // cam seçilmedi
  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: GLASS });
  await cust.getByLabel('Adet', { exact: true }).fill('4');
  await expect(cust.getByText('Sipariş gönderilmeye hazır.')).toBeVisible();
  await cust.fill('#note', 'Kenarlar rodajlı');
  await shot(cust, '25-musteri-yeni-cam-siparisi');
  await shot(cust, '25-musteri-yeni-cam-siparisi', true);

  // SUNUCU kuralı: form elle değiştirilip ikinci cam eklense de sipariş açılmaz (seçimler ve dosyalar ekranda kalır)
  await cust.evaluate(() => {
    const sel = document.querySelector<HTMLSelectElement>('select[name=glassId]')!;
    const form = sel.form!;
    const second = Array.from(sel.options).find((o) => o.value && o.value !== sel.value)!;
    for (const [name, value] of [['glassId', second.value], ['glassQty', '2']]) {
      const hidden = document.createElement('input');
      Object.assign(hidden, { type: 'hidden', name, value, className: 'e2e-extra' });
      form.appendChild(hidden);
    }
  });
  await send.click();
  await expect(cust.locator('.alert-error')).toHaveText('Bir siparişte yalnızca bir cam tipi seçilebilir.');
  await expect(cust).toHaveURL(/\/siparisler\/yeni\?tip=GLASS_ORDER$/);
  await expect(picked).toHaveCount(2);
  await cust.evaluate(() => document.querySelectorAll('.e2e-extra').forEach((e) => e.remove()));

  // Tek camla gönderilir
  await send.click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/);
  orderUrl = new URL(cust.url()).pathname;
  await expect(cust.getByText('Siparişiniz alındı.')).toBeVisible();
  await expect(cust.getByText(`${GLASS} × 4`)).toBeVisible();
  await expect(cust.getByText('plan-a.pdf')).toBeVisible();
  await expect(cust.getByText('olcu-b.dxf')).toBeVisible();
  await expect(cust.getByText('yanlis-c.png')).toHaveCount(0);
  await expect(cust.getByText('Kenarlar rodajlı')).toBeVisible();
  // Siparişe yazılan tarih, formda gösterilen tarihle aynı (tek hesap)
  await expect(cust.locator('dl.order-info')).toContainText(shipDate);
  orderNo = (await cust.locator('.page-head .mono').first().innerText()).trim();
  expect(orderNo).toMatch(/^UNS\d+$/);

  // Mevcut müşteri listesinde: numara, ad, durum, tarih, ayrıntı
  await cust.goto('/siparisler');
  const row = cust.locator('tr', { has: cust.locator(`a[href="${orderUrl}"]`) }).first();
  await expect(row.getByRole('link', { name: orderNo, exact: true })).toBeVisible();
  await expect(row).toContainText('Tek cam siparişi');
  await expect(row.locator('.badge').first()).toBeVisible();
  await expect(row).toContainText(shipDate);
  await expect(row.getByRole('link', { name: 'Detay' })).toHaveAttribute('href', orderUrl);
  await cust.context().close();
});

test('yükleme tarihi: satış değiştirince müşteri her yerde yeni tarihi görür; başka firma siparişi ve taslağı açamaz', async ({ browser }) => {
  const sales = await as(browser, SALES2, TEAM_PW);
  await sales.goto(orderUrl);
  await sales.fill('#ship-date', '2027-05-14');
  await sales.getByRole('button', { name: 'Tarihi güncelle' }).click();
  await expect(sales.getByText('Tahmini yükleme tarihi güncellendi.')).toBeVisible();
  await sales.context().close();

  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(orderUrl);
  await expect(cust.locator('dl.order-info')).toContainText('14.05.2027');
  await expect(cust.locator('dl.order-info')).not.toContainText(shipDate);
  await cust.goto('/siparisler');
  await expect(cust.locator('tr', { has: cust.locator(`a[href="${orderUrl}"]`) }).first()).toContainText('14.05.2027');
  // Taslak kaydet: yalnızca kendi firmasında
  await cust.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await cust.fill('#title', 'Yalıtım taslağı');
  await cust.getByRole('button', { name: 'Taslak kaydet' }).click();
  await expect(cust).toHaveURL(/taslak=[a-z0-9]+&ok=draft/);
  const draftUrl = cust.url().replace(/&ok=draft$/, '');
  await expect(cust.locator('select[name=glassId]')).toHaveCount(1);

  const beta = await as(browser, 'beta@betacam.test', TEAM_PW);
  expect((await beta.goto(orderUrl))?.status()).toBe(404);
  await beta.goto(new URL(draftUrl).pathname + new URL(draftUrl).search);
  await expect(beta.getByText('Taslak bulunamadı')).toBeVisible();
  await expect(beta.locator('#title')).toHaveCount(0);
  await beta.goto('/siparisler');
  await expect(beta.getByText(orderNo, { exact: true })).toHaveCount(0);
  await expect(beta.getByText('Yalıtım taslağı')).toHaveCount(0);
  await beta.context().close();

  await cust.goto(new URL(draftUrl).pathname + new URL(draftUrl).search);
  await cust.getByRole('button', { name: 'Taslağı sil' }).click();
  await expect(cust.getByText('Yalıtım taslağı')).toHaveCount(0);
  await cust.context().close();
});

test('eski çok camlı sipariş normal açılır; satış teklif tablosunda "+ Cam ekle" durur', async ({ browser }) => {
  // Kuraldan önce açılmış sipariş gibi: aynı siparişe ikinci cam doğrudan kayda eklenir (formdan eklenemez)
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const order = await db.order.findUniqueOrThrow({ where: { orderNo } });
    await db.orderItem.create({ data: { orderId: order.id, glassName: 'ESKİ İKİNCİ CAM — FÜME', glassNameRo: 'A DOUA STICLĂ VECHE — GRI', camAdedi: 6 } });
  } finally {
    await db.$disconnect();
  }
  const cust = await as(browser, CUSTOMER, CUST_PW);
  expect((await cust.goto(orderUrl))?.status()).toBe(200);
  await expect(cust.getByText(`${GLASS} × 4`)).toBeVisible();
  await expect(cust.getByText('ESKİ İKİNCİ CAM — FÜME × 6')).toBeVisible();
  await cust.goto('/siparisler');
  await expect(cust.getByRole('link', { name: orderNo, exact: true })).toBeVisible();
  await cust.context().close();

  const admin = await as(browser, ADMIN, ADMIN_PW);
  expect((await admin.goto(orderUrl))?.status()).toBe(200);
  await expect(admin.getByText('ESKİ İKİNCİ CAM — FÜME × 6')).toBeVisible();
  await admin.context().close();

  // Satış: teklif tablosu sınırlanmaz — "+ Cam ekle" ile ikinci cam satırı eklenir ve kaydedilir
  const sales = await as(browser, SALES2, TEAM_PW);
  await sales.goto(orderUrl);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  const rows = sales.locator('.offer-table tbody tr');
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  await sales.getByRole('button', { name: '+ Cam ekle' }).click();
  await expect.poll(() => rows.count()).toBeGreaterThan(before);
  await sales.context().close();
});

test('profil siparişi: form aynı akışla çalışır; listede görünür; teslim alma tarihi GG.AA.YYYY', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto('/siparisler/yeni?tip=PROFILE_ORDER');
  await expect(cust.getByRole('heading', { name: 'Yeni Profil Siparişi' })).toBeVisible();
  await expect(cust.locator('#files')).toHaveCount(0); // profil siparişinde dosya / cam yok
  await expect(cust.locator('select[name=glassId]')).toHaveCount(0);
  await expect(cust.locator('.ship-note')).toHaveCount(0); // cam yükleme tarihi notu profil formunda yok
  const send = cust.getByRole('button', { name: 'Siparişi gönder' });
  await expect(send).toBeDisabled();
  await cust.fill('#title', 'Profil düzeni');
  await cust.locator('tr', { hasText: 'MC12' }).locator('input.qty-input').fill('3');
  await expect(cust.locator('tr.picked')).toHaveCount(1);
  await expect(cust.locator('tr', { hasText: 'MC12' }).locator('td.thumb img')).toHaveCount(1); // ürün görseli
  await shot(cust, '26-musteri-yeni-profil-siparisi');
  await send.click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=profile_created/);
  const url = new URL(cust.url()).pathname;
  const no = (await cust.locator('.page-head .mono').first().innerText()).trim();
  expect(no).toMatch(/^UNSP\d+$/);
  // Profil akışı aynı: fiyat bekler (müşteri onayı aşaması fiyat geldikten sonra); cam kuralları uygulanmaz
  await expect(cust.getByText('Teklifiniz hazırlanıyor.').first()).toBeVisible();
  await expect(cust.getByRole('button', { name: 'Teklifi onayla' })).toHaveCount(0);

  // Mevcut listede: numara, "Profil" rozeti, durum, ayrıntı
  await cust.goto('/siparisler');
  const row = cust.locator('tr', { has: cust.locator(`a[href="${url}"]`) }).first();
  await expect(row.getByRole('link', { name: no, exact: true })).toBeVisible();
  await expect(row).toContainText('Profil');
  await expect(row).toContainText('Profil düzeni');
  await expect(row.getByRole('link', { name: 'Detay' })).toBeVisible();

  // Yönetici fiyatlar → müşteri teslim alma tarihiyle onaylar; tarih her yerde GG.AA.YYYY
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(url);
  await admin.getByLabel('MC12 — Birim fiyat (EUR)').fill('5');
  await admin.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(admin.getByText('Teklif müşteriye gönderildi.')).toBeVisible();
  await admin.context().close();
  await cust.goto(url);
  const iso = await cust.locator('#pk-date').inputValue();
  expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const shown = iso.split('-').reverse().join('.');
  await cust.fill('#pk-phone', '+40 723 111 222');
  await cust.fill('#pk-plate', 'b 77 xyz');
  await cust.getByRole('button', { name: 'Teklifi onayla' }).click();
  await expect(cust.getByText('Teklifi onayladınız.', { exact: false })).toBeVisible();
  await expect(cust.locator('#teslim')).toContainText(shown);
  await cust.goto('/siparisler');
  await expect(cust.locator('tr', { has: cust.locator(`a[href="${url}"]`) }).first()).toContainText(shown);
  await cust.context().close();
});
