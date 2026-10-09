import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, TEAM_PW, as, fillOffer, login, newOrder } from './helpers';

// Satış paneli düzeltme paketi 1 (3.62.0, 3.62.1):
//  - satışın sandık parası (karar 211, 214): yöneticinin tablosundaki gibi "+ Cam ekle"nin yanındaki "+ Sandık parası" ile
//    bağımsız, numaralı kalem (kendi adedi ve birim fiyatı; cam satırının altında "+Sandık" yok); satış ekler / değiştirir,
//    yönetici görür ve müşteri fiyatını girer; yöneticinin sandık bedeli satışa hiçbir ekranda / yanıtta görünmez; müşteri
//    toplamı tek sayım
//  - "Yöneticiye göndermeyi geri al" (karar 212): yalnızca gönderen satışçıya, yönetici göndermeden önce; geri alınan
//    teklif yeniden düzenlenir ve gönderilir; yöneticinin taslağı / sandık bedeli kaybolmaz; gönderildikten sonra yok
//  - uzun teklif tablosunda ↑ / ↓ (karar 213): teklif yöneticiye gittikten sonra (salt okunur) da görünür, tablonun
//    başına / sonuna kaydırır (üst çubuğun altına), kısa tabloda yok; masaüstü ve telefon genişliği
// FGO / e-posta / Google'a istek yapılmaz.
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)
let orderId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('satışın sandık ücreti ve geri alma: satış ekler / değiştirir, yönetici görür; yöneticinin sandık bedeli satışa görünmez; geri alınan teklif yeniden gönderilir', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  orderId = await newOrder(cust, 'Satış paneli', 'satis-paneli.pdf');
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${orderId}`);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await fillOffer(sales, '40'); // 3 × 1000 × 2000 mm = 6 m² × 40 = 240
  // Cam satırının altında "+Sandık" yok; tablonun altında "+ Cam ekle"nin yanında "+ Sandık parası" (yöneticinin düzeni)
  await expect(sales.locator('.offer-table [data-add-sales-crate]')).toHaveCount(0);
  const tools = sales.locator('.offer-tools .group').first();
  await expect(tools.getByRole('button')).toHaveText(['+ Cam ekle', '+ Sandık parası']); // yan yana, bu sırayla
  await tools.getByRole('button', { name: '+ Sandık parası' }).click();
  // Bağımsız, numaralı kalem: tablonun sonunda 2. satır; ölçüsüz, adetli; satışın ekranında rozet yok; adı sabit
  const crateRow = sales.locator('.offer-table tr[data-sales-crate]');
  await expect(crateRow).toHaveCount(1);
  await expect(sales.locator('.offer-table tbody tr').last()).toHaveAttribute('data-sales-crate', '');
  await expect(crateRow.locator('td.c-no')).toHaveText('2');
  await expect(crateRow).toHaveClass(/glass-line/);
  await expect(crateRow.locator('[data-sales-crate-badge], [data-crate-fee]')).toHaveCount(0);
  await expect(crateRow.getByLabel('Açıklama', { exact: true })).toHaveValue('Sandık parası');
  await expect(crateRow.getByLabel('Açıklama', { exact: true })).not.toBeEditable();
  await expect(crateRow.getByLabel('En', { exact: true })).toHaveCount(0);
  await sales.getByLabel('Sandık adedi').fill('2');
  await sales.getByLabel('Sandık ücreti fiyatı').fill('20');
  await expect(sales.locator('.offer-table tfoot')).toContainText('3 cam · 2 sandık');
  await expect(sales.locator('.offer-table tfoot')).toContainText('280,00 EUR'); // 240 + 2 × 20
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  // Salt okunur teklif: satışın sandık parası numaralı 2. kalem (satışta rozet yok) ve geri alma düğmesi
  const viewCrate = sales.locator('#teklif tbody tr').nth(1);
  await expect(viewCrate).toContainText('Sandık parası');
  await expect(viewCrate.locator('td').first()).toHaveText('2');
  await expect(sales.locator('#teklif [data-sales-crate], #teklif [data-crate-fee]')).toHaveCount(0);
  await expect(sales.locator('#teklif tfoot')).toContainText('280,00 EUR');
  await expect(sales.getByRole('button', { name: 'Yöneticiye göndermeyi geri al', exact: true })).toBeVisible();
  // Kısa tabloda ↑ / ↓ yok
  await sales.locator('#offer-table').scrollIntoViewIfNeeded();
  await expect(sales.locator('.table-jump')).toHaveCount(0);

  // Yönetici: satışın sandık ücretini rozetle görür, müşteri fiyatını girer; kendi sandık bedelini ekler (satış görmez)
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${orderId}`);
  await expect(admin.locator('.offer-table tr[data-sales-crate] [data-sales-crate-badge]')).toHaveText('Sandık ücreti · satışın');
  await expect(admin.locator('.offer-table tr[data-sales-crate] td.c-no')).toHaveText('2');
  await expect(admin.locator('[data-add-sales-crate]')).toHaveCount(0); // yöneticinin düğmesi kendi (gizli) sandık bedeli
  await expect(admin.getByRole('button', { name: 'Yöneticiye göndermeyi geri al' })).toHaveCount(0);
  await admin.getByLabel('Müşteri fiyatı', { exact: true }).first().fill('50');
  await admin.getByLabel('Sandık ücreti müşteri fiyatı').fill('30');
  await admin.getByRole('button', { name: /Sandık parası/ }).click();
  await admin.getByLabel('Müşteri fiyatı', { exact: true }).nth(1).fill('25');
  await admin.getByRole('button', { name: 'Taslak olarak kaydet' }).click();
  await expect(admin.getByText('Teklif taslak olarak kaydedildi.')).toBeVisible();

  // Satış: yöneticinin sandık bedeli hiçbir yerde yok (ekran ve ham yanıt); kendi sandık ücreti duruyor
  await sales.goto(`/siparisler/${orderId}`);
  await expect(sales.locator('#teklif tbody tr')).toHaveCount(2);
  const html = await (await sales.request.get(`/siparisler/${orderId}`)).text();
  expect(html).not.toContain('data-crate-fee');
  expect(html).not.toMatch(/\\?"crateFee\\?":\s*true/);
  expect(html).not.toContain('Sandık bedeli · satış görmez');

  // Geri al → teklif yeniden düzenlenebilir (yöneticinin satırı yine yok), değiştir, yeniden gönder
  await sales.getByRole('button', { name: 'Yöneticiye göndermeyi geri al', exact: true }).click();
  await expect(sales.getByText('Teklif yöneticiden geri alındı; düzenleyip yeniden gönderebilirsiniz.')).toBeVisible();
  await expect(sales.locator('.offer-table tbody tr')).toHaveCount(2);
  await sales.getByLabel('Sandık adedi').fill('3');
  await expect(sales.locator('.offer-table tfoot')).toContainText('300,00 EUR'); // 240 + 3 × 20
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();

  // Geçmiş: gönderim, geri alma, yeniden gönderim (müşteriye kapalı)
  const db = await prisma();
  const events = (await db.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })).map((e) => e.event).filter((e) => e.startsWith('OFFER_'));
  expect(events).toEqual(['OFFER_SUBMITTED', 'OFFER_WITHDRAWN', 'OFFER_SUBMITTED']);

  // Yönetici: yeniden gelen teklif fiyat onayında — taslak fiyatları ve sandık bedeli durdu; gönderir
  await admin.goto(`/siparisler/${orderId}`);
  await expect(admin.locator('.offer-table tbody tr')).toHaveCount(3);
  await expect(admin.getByLabel('Sandık ücreti müşteri fiyatı')).toHaveValue('30.00');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText(/Fiyat onaylandı/).first()).toBeVisible();
  // Müşteri: 6 m² × 50 + 3 × 30 + 25 = 415 (her satır bir kez); "satış" rozetleri müşteride yok
  await cust.goto(`/siparisler/${orderId}`);
  await expect(cust.locator('#teklif tfoot')).toContainText('415,00 EUR');
  await expect(cust.locator('#teklif [data-sales-crate], #teklif [data-crate-fee]')).toHaveCount(0);
  // Müşteride iki sandık parası da numaralı ayrı kalem (cam 1, sandık 2, sandık 3)
  await expect(cust.locator('#teklif tbody tr td:first-child')).toHaveText(['1', '2', '3']);
  // Gönderildikten sonra satışta geri alma yok
  await sales.goto(`/siparisler/${orderId}`);
  await expect(sales.getByRole('button', { name: 'Yöneticiye göndermeyi geri al' })).toHaveCount(0);
  await expect(sales.locator('#teklif tfoot')).toContainText('300,00 EUR');
  expect(await (await sales.request.get(`/siparisler/${orderId}`)).text()).not.toContain('415,00');
  await db.$disconnect();
  await Promise.all([cust.context().close(), sales.context().close(), admin.context().close()]);
});

/** Tablonun ekrandaki yeri ve üst çubuğun alt kenarı */
const place = (page: Page) => page.locator('#offer-table').evaluate((el) => {
  const r = el.getBoundingClientRect();
  const se = document.scrollingElement ?? document.documentElement;
  return {
    top: r.top, bottom: r.bottom, vh: window.innerHeight, bar: document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0,
    atEnd: window.scrollY + window.innerHeight >= se.scrollHeight - 2, atStart: window.scrollY <= 0,
  };
});

async function jumps(page: Page) {
  await page.locator('#offer-table').scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 200);
  const group = page.locator('.table-jump');
  await expect(group).toBeVisible();
  await group.getByRole('button', { name: 'Teklif tablosunun sonuna' }).click();
  // Tablonun son satırı ekranın altında (sayfa daha aşağı inemiyorsa tablonun sonu ekranda)
  await expect.poll(async () => { const p = await place(page); return Math.abs(p.bottom - (p.vh - 8)) < 6 || (p.atEnd && p.bottom <= p.vh); }).toBe(true);
  await group.getByRole('button', { name: 'Teklif tablosunun başına' }).click();
  // Başlık satırı üst çubuğun hemen altında (çubuğun altında kalmaz)
  await expect.poll(async () => { const p = await place(page); return Math.abs(p.top - (p.bar + 8)) < 6 || (p.atStart && p.top >= p.bar); }).toBe(true);
  const header = await page.locator('#offer-table thead').evaluate((el) => el.getBoundingClientRect().top);
  expect(header).toBeGreaterThanOrEqual((await place(page)).bar);
}

test('uzun teklif tablosu: ↑ / ↓ teklif yöneticiye gittikten sonra da (salt okunur) görünür ve tablonun başına / sonuna kaydırır; telefonda da', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Uzun teklif', 'uzun-teklif.pdf');
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${id}`);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.locator('.offer-table')).toBeVisible();
  // Uzun tablo: taslak teklife 36 cam satırı (test verisi; satış ekranından kaydedilir ve gönderilir)
  const db = await prisma();
  const offer = await db.offer.findFirstOrThrow({ where: { orderId: id }, orderBy: { createdAt: 'desc' } });
  await db.offerLine.deleteMany({ where: { offerId: offer.id } });
  await db.offerLine.createMany({
    data: Array.from({ length: 36 }, (_, i) => ({ offerId: offer.id, sortOrder: i, description: `Uzun cam ${i + 1}`, enMm: 500 + i, boyMm: 600, adet: 1, unit: 'm2', unitPrice: '40.00', kind: 'CAM' })),
  });
  await db.$disconnect();
  await sales.goto(`/siparisler/${id}`);
  // Düzenlenebilir tabloda (önceden de vardı)
  await jumps(sales);
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  // Salt okunur teklifte (düzeltme): oklar görünür ve tablonun içinde kalır
  await expect(sales.locator('#teklif tbody tr')).toHaveCount(36);
  await jumps(sales);

  // Telefon genişliği (390 × 844): aynı oklar, aynı davranış; sayfa yatay taşmaz
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  await login(p, SALES, TEAM_PW);
  await p.goto(`/siparisler/${id}`);
  await jumps(p);
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await Promise.all([cust.context().close(), sales.context().close(), phone.close()]);
});
