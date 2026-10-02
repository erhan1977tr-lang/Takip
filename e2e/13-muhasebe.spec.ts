import { test, expect, type Page } from '@playwright/test';
import type { Prisma } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, login } from './helpers';

// Muhasebe (karar 51, 87–90): Profil Tahsilat, Cam Tahsilat, Tedarikçi Hesap Durumu yalnızca yönetici.
//  - Kalan toplamında aynı borç iki kez sayılmaz (proforma + avans + fatura).
//  - Yükleme kârı: satış (yönetici fiyatı) − maliyet (satış fiyatı) − transport; maliyeti eksik satır sessizce 0 sayılmaz.
//  - Yetkisiz roller sayfalara adresle de giremez; sunucu işlemlerini (form gönderimini taklit ederek) de çalıştıramaz.
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te kilitleniyor)
const INSPECTOR = 'denetim@e2e.test'; // 05'te açıldı
const PAGES = ['/admin/muhasebe/profil', '/admin/muhasebe/cam', '/admin/muhasebe/tedarikci'];
const SUPPLIER = '/admin/muhasebe/tedarikci';
// Yalnızca muhasebe ekranlarında görünen veriler: yetkisiz yanıtta hiçbiri bulunmamalı
const SECRETS = ['GKH77003', 'PRF77001', 'E2E-ODEME', 'E2E TIR'];
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
const dmy = (d: Date) => d.toISOString().slice(0, 10).split('-').reverse().join('.');
const LOADED = day(-20);

let paidOrderId = ''; // proforması olan, ödemesi girilmemiş sipariş ("Ödeme alındı" formu)
let newOrderId = ''; // hiç belgesi olmayan sipariş ("Proforma Gönder" formu)

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

/** Sayfanın HTML'inden, içinde `marker` geçen formun sunucu işlemi alanını ($ACTION_ID_…) bulur */
async function actionField(page: Page, url: string, marker: string): Promise<string> {
  const html = await (await page.request.get(url)).text();
  const form = html.split('<form').find((chunk) => chunk.includes(marker));
  const m = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form) : null;
  expect(m, `sunucu işlemi alanı bulunamadı (${url}, ${marker})`).toBeTruthy();
  return m![0];
}

/** Form gönderimini taklit eder (düğme ekranda olmasa da): tarayıcının yaptığı çok parçalı POST'un aynısı */
async function forge(page: Page, url: string, field: string, data: Record<string, string>) {
  const origin = new URL(page.url()).origin;
  return page.request.post(url, { multipart: { [field]: '', ...data }, headers: { origin } });
}

test('veri: FGO belgeleri, yüklenmiş sipariş, transport ve fabrika ödemesi', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  const firm = await db.customer.findUniqueOrThrow({ where: { id: cust.customerId! } });
  const order = (no: number, ship: Date, lines: Prisma.OfferLineCreateWithoutOfferInput[]) => db.order.create({
    data: {
      orderNo: `${firm.prefix}${no}`, customerOrderNo: no, title: 'Muhasebe e2e', orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id,
      status: 'URETIMDE', estimatedShipDate: ship,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '610.00', offerAmount: '1045.00', createdById: admin.id, sentAt: new Date(), lines: { create: lines } } },
    },
  });
  const glass = { sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 2000, adet: 5, unit: 'm2', unitPrice: '60', offerPrice: '100', kind: 'CAM' };
  // Yüklenmiş sipariş: 10 m² · satış 1000 + CNC 20 + özel işlem 25 = 1045 · maliyet 600 + 10 + 0 (maliyeti eksik satır) = 610
  const a = await order(9101, LOADED, [
    glass,
    { sortOrder: 1, description: 'CNC', adet: 2, unit: 'adet', unitPrice: '5', offerPrice: '10', kind: 'CNC' },
    { sortOrder: 2, description: 'Özel işlem', adet: 1, unit: 'adet', unitPrice: '0', offerPrice: '25', kind: 'CAM' },
  ]);
  // Aynı borcun üç belgesi: proforma 1200 → avans faturası 500 (ödendi) → kapanış faturası 700 (200 ödendi)
  const doc = (orderId: string, kind: string, series: string, number: string, total: string, paid: string, ago: number) =>
    db.fgoDocument.create({ data: { orderId, kind, series, number, total, paid, issuedAt: day(-ago), checkedAt: new Date() } });
  await doc(a.id, 'PROFORMA', 'PRF', '77001', '1200.00', '0', 30);
  await doc(a.id, 'ADVANCE', 'GKH', '77002', '500.00', '500.00', 25);
  await doc(a.id, 'INVOICE', 'GKH', '77003', '700.00', '200.00', 18);
  // Henüz yüklenmemiş, yalnızca proforması olan sipariş
  const b = await order(9102, day(20), [glass]);
  await doc(b.id, 'PROFORMA', 'PRF', '77004', '300.00', '0', 2);
  // Hiç belgesi olmayan sipariş
  const c = await order(9103, day(25), [glass]);
  await db.loadingCost.create({ data: { shipDay: new Date(`${LOADED.toISOString().slice(0, 10)}T00:00:00Z`), amount: '150.00', currency: 'EUR', note: 'E2E TIR' } });
  await db.factoryPayment.create({ data: { paidOn: new Date(`${day(-10).toISOString().slice(0, 10)}T00:00:00Z`), amount: '400.00', currency: 'EUR', note: 'E2E-ODEME' } });
  await db.$disconnect();
  paidOrderId = b.id;
  newOrderId = c.id;
});

test('yönetici: Cam Tahsilat — aynı borç iki kez sayılmaz; süzgeç; FGO ile Güncelle', async ({ page }) => {
  await login(page, ADMIN, ADMIN_PW);
  for (const name of ['Profil Tahsilat', 'Cam Tahsilat', 'Tedarikçi Hesap Durumu']) await expect(page.locator('.sidebar').getByRole('link', { name })).toBeVisible();

  await page.goto('/admin/muhasebe/cam');
  await expect(page.getByRole('heading', { name: 'Cam Tahsilat' })).toBeVisible();
  // 9101: avans 500 + kapanış 700 (proforma sayılmaz) · 9102: proforma 300 → toplam 1500, tahsil 700, kalan 800
  // (belgeleri körlemesine toplamak 2700 toplam / 2000 kalan gösterirdi)
  const stats = page.locator('.stats-money .stat');
  await expect(stats.nth(0)).toContainText('1.500,00');
  await expect(stats.nth(1)).toContainText('700,00');
  await expect(stats.nth(2)).toContainText('800,00');
  await expect(stats.nth(3).locator('.v')).toHaveText('2'); // açık belge: kapanış faturası (kısmi) + 9102 proforması
  // Belgelerin hepsi listede; yerine fatura kesilen proforma toplamda yok
  const replaced = page.locator('tr', { hasText: 'PRF77001' });
  await expect(replaced).toContainText('1.200,00 RON');
  await expect(replaced).toContainText('faturaya döndü');
  await expect(page.locator('tr', { hasText: 'GKH77002' })).toContainText('Ödendi');
  await expect(page.locator('tr', { hasText: 'GKH77003' })).toContainText('Kısmi Ödendi');
  await expect(page.locator('tr', { hasText: 'GKH77003' })).toContainText('500,00 RON');
  await expect(page.locator('tr', { hasText: 'PRF77004' })).toContainText('Ödenmedi');
  await shot(page, '50-cam-tahsilat');
  await shot(page, '50-cam-tahsilat', true);

  await page.getByRole('link', { name: 'Ödendi', exact: true }).click();
  await expect(page).toHaveURL(/durum=odendi/);
  await expect(page.getByText('Bu süzgece uyan belge yok.')).toBeVisible();
  await page.getByRole('link', { name: 'Açık', exact: true }).click();
  await expect(page.locator('tr', { hasText: 'PRF77004' })).toBeVisible();
  // Toplamlar süzgeçten etkilenmez
  await expect(stats.nth(2)).toContainText('800,00');

  // FGO kapalıyken güncelleme hiçbir şeyi değiştirmez, nedenini söyler
  await page.getByRole('button', { name: 'FGO ile Güncelle' }).click();
  await expect(page.locator('.alert-error')).toContainText('FGO bağlantısı kapalı');

  await page.goto('/admin/muhasebe/profil');
  await expect(page.getByRole('heading', { name: 'Profil Tahsilat' })).toBeVisible();
  await shot(page, '51-profil-tahsilat');
});

test('yönetici: Tedarikçi Hesap Durumu — yükleme kârı, eksik maliyet uyarısı, transport ve fabrika ödemesi', async ({ page }) => {
  await login(page, ADMIN, ADMIN_PW);
  await page.goto(SUPPLIER);
  await expect(page.getByRole('heading', { name: 'Tedarikçi Hesap Durumu' })).toBeVisible();
  // Yükleme satırı: satış 1045 − maliyet 610 − transport 150 = 285
  const row = page.locator('#yuklemeler tr', { hasText: dmy(LOADED) });
  await expect(row).toContainText('10,00 m²');
  await expect(row).toContainText('1.045,00');
  await expect(row).toContainText('610,00');
  await expect(row).toContainText('150,00');
  await expect(row).toContainText('285,00');
  await expect(row).toContainText('E2E TIR');
  // Maliyeti kayıtlı olmayan satır sessizce 0 sayılmaz: sipariş adıyla uyarı
  await expect(row).toContainText('maliyet eksik');
  await expect(page.locator('#maliyet-eksik')).toContainText('9101');
  await expect(page.locator('#maliyet-eksik')).not.toContainText('9102');
  // Fabrika ödemesi yüklemeye bağlı değil: ödemeler listesinde, yükleme kârından düşülmez
  await expect(page.locator('tr', { hasText: 'E2E-ODEME' })).toContainText('400,00');

  // Yeni fabrika ödemesi
  const payForm = page.locator('form.acc-form', { has: page.locator('#fp-day') });
  await payForm.locator('[name=amount]').fill('250,50');
  await payForm.locator('[name=note]').fill('E2E-ODEME-2');
  await page.getByRole('button', { name: 'Ödeme ekle' }).click();
  await expect(page.locator('.alert-ok')).toContainText('Ödeme eklendi.');
  await expect(page.locator('tr', { hasText: 'E2E-ODEME-2' })).toContainText('250,50');
  // Yükleme gününe ikinci transport kalemi (RON ayrı satırda kalır, EUR'ya eklenmez)
  await row.locator('summary').click();
  await row.locator('[name=amount]').fill('80');
  await row.locator('select[name=currency]').selectOption('RON');
  await row.locator('[name=note]').fill('E2E vama');
  await row.getByRole('button', { name: 'Ekle', exact: true }).click();
  await expect(page.locator('.alert-ok')).toContainText('Transport maliyeti eklendi.');
  await expect(row).toContainText('285,00'); // EUR kârı değişmedi
  await expect(page.locator('#yuklemeler tr', { hasText: 'RON' }).filter({ hasText: '-80,00' })).toBeVisible();
  await shot(page, '52-tedarikci');
  await shot(page, '52-tedarikci', true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'mobilde sayfa yana taşmaz').toBe(true);
});

test('yetkisiz roller muhasebe sayfalarına adresle de giremez; menüde de yok', async ({ browser }) => {
  const users: [string, string][] = [[CUSTOMER, CUST_PW], [SALES2, TEAM_PW], [DRAWER, TEAM_PW], [INSPECTOR, 'Denet1']];
  for (const [email, pw] of users) {
    const p = await as(browser, email, pw);
    for (const name of ['Profil Tahsilat', 'Cam Tahsilat', 'Tedarikçi Hesap Durumu']) await expect(p.locator('.sidebar').getByRole('link', { name }), email).toHaveCount(0);
    for (const url of PAGES) {
      await p.goto(url);
      await expect(p, `${email} ${url}`).toHaveURL(/\/siparisler$/);
      // Sayfanın ham yanıtında da muhasebe verisi yok (düğme gizlemek yetki değildir)
      const body = await (await p.request.get(url)).text();
      for (const s of SECRETS) expect(body.includes(s), `${email} ${url} → ${s}`).toBe(false);
    }
    await p.context().close();
  }
  // Oturumsuz istek girişe gider
  const anon = await browser.newContext();
  const page = await anon.newPage();
  for (const url of PAGES) {
    await page.goto(url);
    await expect(page, url).toHaveURL(/\/login/);
  }
  await anon.close();
});

test('taklit istek: müşteri ve satış muhasebe / FGO işlemlerini form göndererek çalıştıramaz', async ({ browser }) => {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const paidUrl = `/siparisler/${paidOrderId}`;
  const newUrl = `/siparisler/${newOrderId}`;
  // Sunucu işlemlerinin alanları yöneticinin sayfasından (yetkisiz kullanıcı bunları bir yerden öğrenmiş sayılır)
  const payField = await actionField(admin, SUPPLIER, 'id="fp-day"');
  const paidField = await actionField(admin, paidUrl, 'id="gb-paid"');
  const docField = await actionField(admin, newUrl, 'value="PROFORMA"');
  const payment = (who: string) => ({ paidOn: '2026-09-21', amount: '777.77', currency: 'EUR', note: `TAKLIT-${who}` });
  const payments = (who: string) => db.factoryPayment.count({ where: { note: `TAKLIT-${who}` } });
  const fgoRequests = () => db.notificationOutbox.count({ where: { orderId: newOrderId, type: 'FGO_GLASS' } });

  for (const [who, email, pw] of [['musteri', CUSTOMER, CUST_PW], ['satis', SALES2, TEAM_PW]] as const) {
    const p = await as(browser, email, pw);
    // Fabrika ödemesi ekleme
    const r1 = await forge(p, SUPPLIER, payField, payment(who));
    expect(r1.url(), `${who}: ödeme`).toMatch(/\/siparisler$/);
    expect(await payments(who), `${who}: ödeme kaydı oluşmadı`).toBe(0);
    // Cam proforması "ödendi" işaretleme
    const r2 = await forge(p, paidUrl, paidField, { id: paidOrderId, amount: '300' });
    expect(r2.url(), `${who}: ödendi`).not.toContain('fgoOk');
    expect(await db.glassBilling.count({ where: { orderId: paidOrderId } }), `${who}: ödeme işaretlenmedi`).toBe(0);
    // FGO belgesi isteme
    const r3 = await forge(p, newUrl, docField, { id: newOrderId, kind: 'PROFORMA' });
    expect(r3.url(), `${who}: FGO belgesi`).not.toContain('fgo');
    expect(await fgoRequests(), `${who}: FGO isteği kuyruğa girmedi`).toBe(0);
    expect(await db.auditLog.count({ where: { entityId: newOrderId, action: 'FGO_DOC_REQUEST' } })).toBe(0);
    await p.context().close();
  }

  // Karşı kontrol: aynı taklit istek yönetici oturumuyla işlemi gerçekten çalıştırır (yani engel yetki kontrolüdür)
  const ok1 = await forge(admin, SUPPLIER, payField, payment('yonetici'));
  expect(ok1.url()).toContain('ok=payment');
  expect(await payments('yonetici')).toBe(1);
  const ok2 = await forge(admin, paidUrl, paidField, { id: paidOrderId, amount: '300' });
  expect(ok2.url()).toContain('fgoOk=paid');
  expect(await db.glassBilling.count({ where: { orderId: paidOrderId } })).toBe(1);
  const ok3 = await forge(admin, newUrl, docField, { id: newOrderId, kind: 'PROFORMA' });
  expect(ok3.url(), 'işlem çalıştı; FGO kapalı olduğu için belge istenmedi').toContain('fgoError=FGO_DISABLED');
  await db.$disconnect();
  await admin.context().close();
});
