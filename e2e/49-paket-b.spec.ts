import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, TEAM_PW, as, createUser, firstLogin, outboxCodeFor, seeSections } from './helpers';

// Paket B — müşteri paneli (kararlar 228–229), gerçek sunucuda. FGO e2e veritabanında KAPALIDIR (gerçek FGO'ya istek yok).
//  - "Bir mesajınız var": müşteri listesinde okunmamış gelişmesi olan siparişin yanında kırmızı uyarı; sipariş sayfasını
//    açmak uyarıyı tek başına okumaz — ilgili bölüm ekranda görülünce yalnızca o kullanıcı için okunur
//  - fiyat listeli müşteri: profil formunda fiyatlar, toplam ve alış günü; sipariş doğrudan onaylı açılır (teklif / onay
//    adımı yok); telefon / plaka eksik uyarısı; müşteri tamamlayınca kalkar. Listesiz müşteri eski akışta kalır.
test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const CUST = `pb-musteri-${RUN}@pbfirma.test`;
const CUST2 = `pb-musteri2-${RUN}@pbfirma.test`;
const FIRM = `Paket B Firma ${RUN}`;
let firmId = '';
let glassOrderId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('veri: bu dosyaya özel firma (fiyat listeli), iki müşteri kullanıcısı ve bir cam siparişi', async ({ browser }) => {
  const db = await prisma();
  try {
    const prefixes = new Set((await db.customer.findMany({ select: { prefix: true } })).map((c) => c.prefix));
    const prefix = ['PBQ', 'PBW', 'PBZ', 'QPB', 'WPB', 'ZPB'].find((p) => !prefixes.has(p))!;
    const firm = await db.customer.create({ data: { name: FIRM, prefix } });
    firmId = firm.id;
    const gk = await db.profileProduct.findUniqueOrThrow({ where: { code: 'GK15' } });
    const table = await db.profilePriceTable.create({ data: { name: `Paket B liste ${RUN}`, items: { create: [{ productId: gk.id, unitPrice: '9.90' }] } } });
    await db.customer.update({ where: { id: firm.id }, data: { profilePriceTableId: table.id } });
  } finally {
    await db.$disconnect();
  }
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await createUser(admin, { email: CUST, name: 'PB Müşteri', role: 'Müşteri', firm: FIRM, canApprove: true });
  await createUser(admin, { email: CUST2, name: 'PB Müşteri 2', role: 'Müşteri', firm: FIRM, canApprove: true });
  await admin.context().close();
  for (const email of [CUST, CUST2]) {
    const fresh = await (await browser.newContext()).newPage();
    await firstLogin(fresh, email, outboxCodeFor(email), TEAM_PW);
    await fresh.context().close();
  }
  const db2 = await prisma();
  try {
    const u = await db2.user.findUniqueOrThrow({ where: { email: CUST }, include: { customer: true } });
    const o = await db2.order.create({
      data: { orderNo: `${u.customer!.prefix}1`, customerOrderNo: 1, title: `PB cam ${RUN}`, orderTypeCode: 'GLASS_ORDER', customerId: firmId, createdById: u.id, status: 'HAZIRLANIYOR', drawingTrack: 'YAPILIYOR' },
    });
    glassOrderId = o.id;
  } finally {
    await db2.$disconnect();
  }
});

test('"Bir mesajınız var": listede kırmızı uyarı; sayfayı açmak okumaz — bölüm görülünce yalnızca gören kullanıcı için okunur', async ({ browser }) => {
  const db = await prisma();
  try {
    const u1 = await db.user.findUniqueOrThrow({ where: { email: CUST } });
    const u2 = await db.user.findUniqueOrThrow({ where: { email: CUST2 } });
    for (const u of [u1, u2]) {
      await db.notification.create({ data: { userId: u.id, type: 'ORDER_DRAWING_UPLOADED', message: 'x', params: { aud: 'customer', orderNo: 'PB' }, link: `/siparisler/${glassOrderId}#cizim-onay`, orderId: glassOrderId, dedupeKey: `e2e:pb:${u.id}:${RUN}` } });
    }
    const page = await as(browser, CUST, TEAM_PW);
    await page.goto('/siparisler');
    const row = page.locator('tr', { has: page.locator(`a.order-no[href="/siparisler/${glassOrderId}"]`) });
    await expect(row.locator('.order-alert-msg')).toHaveText('Bir mesajınız var');
    // Kısa ekran: çizim bölümü ilk görünümün altında kalır
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto(`/siparisler/${glassOrderId}`);
    const cizim = page.locator('#cizim').first();
    await expect(cizim).toHaveCount(1);
    const below = await cizim.evaluate((el) => el.getBoundingClientRect().top > window.innerHeight);
    if (below) {
      await page.waitForTimeout(1500);
      expect(await db.notification.count({ where: { userId: u1.id, orderId: glassOrderId, isRead: false } }), 'sayfayı açmak tek başına okumaz').toBe(1);
    }
    await seeSections(page, ['#cizim']);
    await expect.poll(() => db.notification.count({ where: { userId: u1.id, orderId: glassOrderId, isRead: false } })).toBe(0);
    expect(await db.notification.count({ where: { userId: u2.id, orderId: glassOrderId, isRead: false } }), 'başka kullanıcının uyarısı kalır').toBe(1);
    await page.goto('/siparisler');
    await expect(row.locator('.order-alert-msg')).toHaveCount(0);
    await page.context().close();
    // İkinci kullanıcı hâlâ görür
    const p2 = await as(browser, CUST2, TEAM_PW);
    await p2.goto('/siparisler');
    await expect(p2.locator('tr', { has: p2.locator(`a.order-no[href="/siparisler/${glassOrderId}"]`) }).locator('.order-alert-msg')).toHaveText('Bir mesajınız var');
    await p2.context().close();
  } finally {
    await db.$disconnect();
  }
});

test('fiyat listeli müşteri: formda fiyat, toplam ve alış günü; sipariş doğrudan onaylı açılır; eksik telefon / plaka uyarısı müşteri tamamlayınca kalkar', async ({ browser }) => {
  const page = await as(browser, CUST, TEAM_PW);
  await page.goto('/siparisler/yeni?tip=PROFILE_ORDER');
  const card = page.locator('#dogrudan');
  await expect(card).toBeVisible();
  await expect(card).toContainText(`Paket B liste ${RUN}`);
  await expect(page.getByText('Teklifi onaylayın')).toHaveCount(0);
  const gkRow = page.locator('tr', { has: page.locator('.mono', { hasText: 'GK15' }) }).first();
  await expect(gkRow.locator('td[data-price]')).toHaveAttribute('data-price', '9.9');
  await gkRow.locator('input[name=p_qty]').fill('3');
  await expect(card.locator('[data-direct-total]')).toHaveAttribute('data-direct-total', '29.70');
  await expect(page.locator('#dg-date')).not.toHaveValue('');
  // Gönder (stok uyarısı çıkarsa "Yine de gönder")
  await page.locator('.submit-bar').getByRole('button', { name: 'Siparişi gönder' }).click();
  const anyway = page.getByRole('button', { name: 'Yine de gönder' });
  await expect(async () => {
    if (await anyway.isVisible()) await anyway.click();
    await expect(page).toHaveURL(/ok=profile_direct/, { timeout: 2000 });
  }).toPass();
  await expect(page.getByText('Siparişiniz fiyat listenizle doğrudan iletildi.')).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').pop()!;
  const db = await prisma();
  try {
    const o = await db.order.findUniqueOrThrow({ where: { id }, include: { profile: true, offers: true, price: true } });
    expect([o.profile!.stage, o.profile!.direct, o.offers[0].status, String(o.price!.amount)]).toEqual(['ONAYLANDI', true, 'GONDERILDI', '29.7']);
    // FGO e2e'de kapalı: proforma işi yazılmaz, gerçek FGO'ya istek yok
    expect(await db.notificationOutbox.count({ where: { orderId: id, type: 'FGO_PROFORMA' } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
  // Teslim bilgileri eksik: ne eksik açıkça yazılır; müşteri tamamlar
  const missing = page.locator('#teslim-eksik');
  await expect(missing).toHaveAttribute('data-pickup-missing', 'contactPhone,vehiclePlate');
  await expect(missing).toContainText('telefon, araç plakası');
  await expect(page.locator('[data-pickup-deadline]')).toBeVisible();
  await page.locator('#up-phone').fill('0723 000 000');
  await page.locator('#up-plate').fill('b 77 pbx');
  await page.locator('#teslim').getByRole('button', { name: 'Kaydet' }).click();
  await expect(page).toHaveURL(/ok=pickup_updated/);
  await expect(page.locator('#teslim-eksik')).toHaveCount(0);
  await page.context().close();
});

test('fiyat listesi olmayan müşteri: form eski akışta (fiyat / alış günü kartı yok)', async ({ browser }) => {
  const { CUSTOMER, CUST_PW } = await import('./helpers');
  const page = await as(browser, CUSTOMER, CUST_PW);
  await page.goto('/siparisler/yeni?tip=PROFILE_ORDER');
  await expect(page.locator('#dogrudan')).toHaveCount(0);
  await expect(page.locator('td[data-price]')).toHaveCount(0);
  await page.context().close();
});
