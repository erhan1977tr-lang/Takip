import { test, expect, type Page } from '@playwright/test';
import type { Prisma } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, login, INSPECTOR_PW } from './helpers';

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
// Yükleme günü gün ortası (12:00 UTC) saklanır (parseDateOnly gibi): Romanya günü ile UTC günü aynı kalır
const LOADED = new Date(`${day(-20).toISOString().slice(0, 10)}T12:00:00Z`);

let paidOrderId = ''; // proforması olan, FGO'da tahsilatı görünmeyen sipariş (avans tutarı formdan gelmez — karar 104, 207)
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
  const users: [string, string][] = [[CUSTOMER, CUST_PW], [SALES2, TEAM_PW], [DRAWER, TEAM_PW], [INSPECTOR, INSPECTOR_PW]];
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
    // Avans faturası isteme (taklit tutarla)
    const r2 = await forge(p, paidUrl, docField, { id: paidOrderId, kind: 'ADVANCE', amount: '300' });
    expect(r2.url(), `${who}: avans`).not.toContain('fgo');
    expect(await db.glassBilling.count({ where: { orderId: paidOrderId } }), `${who}: ödeme kaydı oluşmadı`).toBe(0);
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
  // Finans / FGO kartında tutar alanı yok: ödeme FGO'dan okunur ya da yönetici Ödemeler kartında elle kaydeder (karar 206 —
  // ayrı form, belge kesmez). Avans isteğine eklenen taklit tutar yok sayılır; yönetici oturumuyla bile ödeme kaydı / avans
  // isteği oluşturmaz.
  await admin.goto(paidUrl);
  await expect(admin.locator('#gb-paid')).toHaveCount(0);
  await expect(admin.locator('#finans')).toContainText('ödeme aşağıda elle kaydedilince');
  await expect(admin.locator('#finans input[name=amount]')).toHaveCount(0);
  await expect(admin.locator('#avans-durumu')).toContainText('FGO tahsilatı');
  const ok2 = await forge(admin, paidUrl, docField, { id: paidOrderId, kind: 'ADVANCE', amount: '300' });
  expect(ok2.url()).toContain('fgoError=');
  expect(await db.glassBilling.count({ where: { orderId: paidOrderId } })).toBe(0);
  expect(await db.notificationOutbox.count({ where: { orderId: paidOrderId, type: 'FGO_GLASS' } })).toBe(0);
  const ok3 = await forge(admin, newUrl, docField, { id: newOrderId, kind: 'PROFORMA' });
  expect(ok3.url(), 'işlem çalıştı; FGO kapalı olduğu için belge istenmedi').toContain('fgoError=FGO_DISABLED');
  await db.$disconnect();
  await admin.context().close();
});

// ---------- Aşama 7C: eksik maliyet düzeltmesi ve yükleme onayı (karar 92–93) ----------
const LOADED_DAY = LOADED.toISOString().slice(0, 10);
const LOADING_URL = `/yuklemeler?gun=${LOADED_DAY}`;

test('eksik maliyet düzeltmesi: yalnızca yönetici; müşteri fiyatı değişmez; müşteri ve satış taklit istekle yazamaz', async ({ browser }) => {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const line = await db.offerLine.findFirstOrThrow({ where: { description: 'Özel işlem', offer: { order: { orderNo: { endsWith: '9101' } } } } });
  const cost = async () => Number((await db.offerLine.findUniqueOrThrow({ where: { id: line.id } })).unitPrice);
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(SUPPLIER);
  const card = admin.locator('#maliyet-gir');
  const row = card.locator('tr', { hasText: 'Özel işlem' });
  await expect(card.getByRole('heading', { name: /Eksik maliyetler/ })).toBeVisible();
  await expect(row).toContainText('25,00 EUR'); // müşteri birim fiyatı (değişmeyecek)

  // Taklit istek: müşteri ve satış maliyet yazamaz
  const field = await actionField(admin, SUPPLIER, 'name="lineId"');
  for (const [who, email, pw] of [['musteri', CUSTOMER, CUST_PW], ['satis', SALES2, TEAM_PW]] as const) {
    const p = await as(browser, email, pw);
    const r = await forge(p, SUPPLIER, field, { lineId: line.id, cost: '99' });
    expect(r.url(), who).toMatch(/\/siparisler$/);
    expect(await cost(), `${who}: maliyet yazılmadı`).toBe(0);
    await p.context().close();
  }

  // Yönetici maliyeti girer: maliyet 610 → 625, kâr 285 → 270; satış (1045) aynı
  await row.locator('[name=cost]').fill('15');
  await row.getByRole('button', { name: 'Maliyeti kaydet' }).click();
  await expect(admin.locator('.alert-ok')).toContainText('Maliyet kaydedildi. Müşteri fiyatı değişmedi.');
  const day = admin.locator('#yuklemeler tr', { hasText: dmy(LOADED) });
  await expect(day).toContainText('1.045,00');
  await expect(day).toContainText('625,00');
  await expect(day).toContainText('270,00');
  await expect(day).not.toContainText('maliyet eksik');
  await expect(admin.locator('#maliyet-gir tr', { hasText: 'Özel işlem' })).toHaveCount(0);
  expect(await cost()).toBe(15);
  const after = await db.offerLine.findUniqueOrThrow({ where: { id: line.id } });
  expect(Number(after.offerPrice)).toBe(25);
  // Kayıtlı maliyetin üzerine taklit istekle de yazılamaz (yönetici oturumunda bile)
  const again = await forge(admin, SUPPLIER, field, { lineId: line.id, cost: '77' });
  expect(again.url()).toContain('error=costCOST_EXISTS');
  expect(await cost()).toBe(15);
  expect(await db.auditLog.count({ where: { action: 'OFFER_COST_CORRECTION', entityId: line.id } })).toBe(1);
  await db.$disconnect();
  await admin.context().close();
});

test('yükleme onayı: önizleme, yalnızca yönetici onaylar (dört rol taklit istekle onaylayamaz), tek ve değişmez kayıt; kârlılık onaydan', async ({ browser }) => {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const confirmations = () => db.loadingConfirmation.count({ where: { shipDay: new Date(`${LOADED_DAY}T00:00:00Z`) } });
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(LOADING_URL);
  const box = admin.locator('#onay');
  // Önizleme: müşteri → sipariş → cam; adet, m², satış ve maliyet
  await expect(box.getByRole('heading', { name: /Yükleme onayı/ })).toBeVisible();
  await expect(box).toContainText('Onaylanmadı');
  await expect(box.locator('tr.group-total')).toContainText('Ünsal Cam');
  await expect(box.locator('tr.sub', { hasText: '9101' }).first()).toContainText('1.045,00 EUR');
  await expect(box.locator('tr.sub', { hasText: '9101' }).first()).toContainText('625,00 EUR');
  await expect(box.locator('tr.glass-row', { hasText: 'Temper' })).toContainText('10,00');
  await expect(box.locator('tfoot')).toContainText('1 sipariş · 5 cam · 10,00 m²');
  await shot(admin, '53-yukleme-onay-onizleme');

  // Onaylanmamış günde diğer roller onay bölümünü görmez; taklit istekle de onaylayamaz
  const html = await (await admin.request.get(LOADING_URL)).text();
  const key = /name="key" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? '';
  expect(key, 'önizleme parmak izi').toHaveLength(32);
  const field = await actionField(admin, LOADING_URL, 'name="key"');
  const users: [string, string, string][] = [['musteri', CUSTOMER, CUST_PW], ['satis', SALES2, TEAM_PW], ['cizim', DRAWER, TEAM_PW], ['denetimci', INSPECTOR, INSPECTOR_PW]];
  for (const [who, email, pw] of users) {
    const p = await as(browser, email, pw);
    if (who !== 'cizim') {
      await p.goto(LOADING_URL);
      await expect(p.locator('#onay'), who).toHaveCount(0);
      await expect(p.getByRole('button', { name: 'Yükleme yapıldı' }), who).toHaveCount(0);
    }
    const r = await forge(p, LOADING_URL, field, { day: LOADED_DAY, key, note: `TAKLIT-${who}` });
    expect(r.url(), who).not.toContain('onay=ok');
    expect(await confirmations(), `${who}: onay kaydı oluşmadı`).toBe(0);
    await p.context().close();
  }

  // Yönetici "Yükleme yapıldı" ile kaydeder (Paket 7: eski adı "Eksiksiz Yüklendi"; onay penceresi kabul edilir)
  await admin.reload();
  await expect(box.getByRole('button', { name: 'Eksiksiz Yüklendi' })).toHaveCount(0);
  await expect(box).not.toContainText('Yüklenmeyen cam var');
  await box.locator('[name=note]').fill('E2E PLAKA 34');
  await box.getByRole('button', { name: 'Yükleme yapıldı' }).click();
  await expect(admin).toHaveURL(/onay=ok/);
  await expect(box.locator('.alert-ok')).toContainText('Yükleme yapıldı olarak kaydedildi: 1 sipariş.');
  await expect(box.locator('.section-head .badge')).toHaveText('Yükleme yapıldı');
  await expect(box).toContainText(/Onaylayan: .+ · \d{2}\.\d{2}\.\d{4}/);
  await expect(box).toContainText('E2E PLAKA 34');
  await expect(box.getByRole('button', { name: 'Yükleme yapıldı' })).toHaveCount(0);
  await expect(box.locator('tr.sub', { hasText: '9101' }).first()).toContainText('1.045,00 EUR');
  expect(await confirmations()).toBe(1);
  const items = await db.loadingConfirmationItem.findMany({ where: { order: { orderNo: { endsWith: '9101' } } }, orderBy: { sortOrder: 'asc' } });
  expect(items.map((i) => [i.description, i.quantity, Number(i.m2), Number(i.unitCost), Number(i.unitSale), i.status])).toEqual([
    ['Temper', 5, 10, 60, 100, 'LOADED'], ['CNC', 2, 0, 5, 10, 'LOADED'], ['Özel işlem', 1, 0, 15, 25, 'LOADED'],
  ]);
  await shot(admin, '54-yukleme-onayli');
  await shot(admin, '54-yukleme-onayli', true);

  // İkinci onay (aynı istek yeniden gönderilse de) reddedilir: tek kayıt
  const twice = await forge(admin, LOADING_URL, field, { day: LOADED_DAY, key });
  expect(twice.url()).toContain('onayHata=ALREADY_CONFIRMED');
  expect(await confirmations()).toBe(1);
  expect(await db.loadingConfirmationItem.count({ where: { order: { orderNo: { endsWith: '9101' } } } })).toBe(3);

  // Satış onaylı kaydı görür: müşteri adı maskeli, tutar yok. Müşteri görünümü değişmedi.
  const sales = await as(browser, SALES2, TEAM_PW);
  await sales.goto(LOADING_URL);
  await expect(sales.locator('#onay')).toContainText('Yükleme yapıldı');
  await expect(sales.locator('#onay tr.group-total')).toContainText('Üns**********');
  await expect(sales.locator('#onay')).not.toContainText('Ünsal');
  await expect(sales.locator('#onay')).not.toContainText('1.045,00');
  await sales.context().close();
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(LOADING_URL);
  await expect(cust.locator('#onay')).toHaveCount(0);
  await cust.context().close();

  // Kârlılık artık onay kaydından: teklif sonradan değişse de onaylı yüklemenin tutarı değişmez
  await db.offerLine.updateMany({ where: { description: 'Temper', offer: { order: { orderNo: { endsWith: '9101' } } } }, data: { offerPrice: '999', unitPrice: '1' } });
  await admin.goto(SUPPLIER);
  const day = admin.locator('#yuklemeler tr', { hasText: dmy(LOADED) });
  await expect(day).toContainText('onaylı');
  await expect(day).toContainText('1.045,00');
  await expect(day).toContainText('625,00');
  await expect(day).toContainText('270,00');
  await shot(admin, '55-tedarikci-onayli');
  await db.$disconnect();
  await admin.context().close();
});
