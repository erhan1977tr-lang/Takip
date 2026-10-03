import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, TEAM_PW, as } from './helpers';

// Aşama 8 — uygulama içi bildirimler (karar 107): zil + okunmamış sayacı, sessiz ilk yükleme, yeni bildirimde açılır
// bildirim + TEK ses, sekme başlığı, okundu işaretleme (listeyi açmak okundu yapmaz), ses tercihi, müşteri yalıtımı ve
// satışta firma adı maskesi. Bildirimler doğrudan veritabanına yazılır (dağıtım kuralları veritabanı testlerinde).
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test';
const BETA = 'beta@betacam.test';
let orderId = '';
let orderNo = '';
let uns = { id: '', name: '' };
let salesId = '';
let custId = '';

async function shot(page: Page, name: string) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `masaustu-${name}.png`), fullPage: false });
}
async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
/** Ses çalma çağrılarını sayar (gerçek ses yerine): sayfa yüklenmeden önce kurulur */
async function countPlays(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __plays: number }).__plays = 0;
    const proto = window.HTMLMediaElement.prototype;
    proto.play = function play() { (window as unknown as { __plays: number }).__plays += 1; return Promise.resolve(); };
  });
}
const plays = (page: Page) => page.evaluate(() => (window as unknown as { __plays: number }).__plays);
/** Ortak yenilemeyi beklemek yerine zilin yoklamasını tetikler (aynı zamanlayıcının olayı) */
/** Arayüz dili Romence (müşteriye dönük dil): giriş kullanıcının dilini yazar; test metinleri Romence denetlenir */
const romanian = (page: Page) => page.context().addCookies([{ name: 'takip_lang', value: 'ro', url: new URL(page.url()).origin }]);
const poll = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('takip:poll')));

test('veri: müşteri kullanıcısına eski okunmamış bildirimler', async () => {
  const db = await prisma();
  const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  const sales = await db.user.findUniqueOrThrow({ where: { email: SALES2 } });
  uns = { id: cust.customer!.id, name: cust.customer!.name };
  custId = cust.id;
  salesId = sales.id;
  const o = await db.order.findFirstOrThrow({ where: { customerId: uns.id, orderTypeCode: 'GLASS_ORDER' }, orderBy: { createdAt: 'desc' } });
  orderId = o.id;
  orderNo = o.orderNo;
  await db.notification.deleteMany({ where: { userId: { in: [cust.id, sales.id] } } });
  // 7 eski okunmamış: ilk yüklemede yalnızca rozet, ses ve açılır bildirim yok
  for (let i = 1; i <= 7; i++) {
    await db.notification.create({ data: { userId: cust.id, type: 'ORDER_OFFER_UPDATED', message: 'eski', params: { aud: 'customer', orderNo: o.orderNo }, link: `/siparisler/${o.id}`, orderId: o.id, dedupeKey: `e2e:old:${i}`, createdAt: new Date(Date.now() - (10 - i) * 60_000) } });
  }
  await db.$disconnect();
});

test('müşteri: 7 eski okunmamış → rozet 7, sekme "(7) …", ses / açılır bildirim yok; yeni parti → tek açılır bildirim + tek ses; okundu akışı; ses tercihi', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await countPlays(page);
  const { login } = await import('./helpers');
  await login(page, CUSTOMER, CUST_PW);
  await romanian(page);
  await page.goto('/siparisler');
  const bell = page.locator('.notif-bell');
  await expect(bell.locator('.notif-badge')).toHaveText('7');
  await expect(page).toHaveTitle(/^\(7\) /);
  await page.mouse.click(5, 5); // tarayıcı etkileşimi (ses politikası)
  await page.waitForTimeout(500);
  await expect(page.locator('.notif-toast')).toHaveCount(0);
  expect(await plays(page), 'eski okunmamışlar ses çalmaz').toBe(0);

  // Listeyi açmak okundu YAPMAZ
  await bell.click();
  await expect(page.locator('.notif-panel .notif-item.unread')).toHaveCount(7);
  await shot(page, 'bildirim-listesi');
  await page.keyboard.press('Escape');
  await expect(bell.locator('.notif-badge')).toHaveText('7');

  // Yeni parti: 3 bildirim aynı anda → tek özet açılır bildirim, tek ses, rozet 10
  const db = await prisma();
  for (let i = 1; i <= 3; i++) {
    await db.notification.create({ data: { userId: custId, type: i === 1 ? 'ORDER_OFFER_SENT' : 'ORDER_SHIP_DATE', message: 'yeni', params: { aud: 'customer', orderNo, day: '2026-11-20' }, link: `/siparisler/${orderId}`, orderId, dedupeKey: `e2e:new:${i}` } });
  }
  await poll(page);
  const toast = page.locator('.notif-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('3 notificări noi');
  await expect(bell.locator('.notif-badge')).toHaveText('10');
  await expect(page).toHaveTitle(/^\(10\) /);
  expect(await plays(page), 'parti başına tek ses').toBe(1);
  await shot(page, 'bildirim-acilir');
  // Aynı akış yeniden yoklanınca yeni sayılmaz
  await poll(page);
  await page.waitForTimeout(300);
  expect(await plays(page)).toBe(1);
  await toast.locator('.notif-close').click();
  await expect(toast).toHaveCount(0);

  // Tek yeni bildirim: başlık + bağlantı; tıklayınca okundu olur ve sipariş sayfası açılır
  await db.notification.create({ data: { userId: custId, type: 'ORDER_DRAWING_UPLOADED', message: 'yeni', params: { aud: 'customer', orderNo }, link: `/siparisler/${orderId}`, orderId, dedupeKey: 'e2e:new:4' } });
  await poll(page);
  await expect(toast).toContainText('Desenul v-a fost trimis spre aprobare');
  await expect(toast).toContainText(`Comanda ${orderNo}`);
  expect(await plays(page)).toBe(2);
  await toast.locator('a.notif-main').click();
  await expect(page).toHaveURL(new RegExp(`/siparisler/${orderId}`));
  await expect(bell.locator('.notif-badge')).toHaveText('10');
  expect((await db.notification.findFirstOrThrow({ where: { dedupeKey: 'e2e:new:4' } })).isRead).toBe(true);

  // "Okundu" düğmesi ve "tümünü okundu": rozet ve başlık güncellenir, sonunda rozet kalkar
  await bell.click();
  await page.locator('.notif-panel .notif-item.unread').first().locator('.notif-read').click();
  await expect(bell.locator('.notif-badge')).toHaveText('9');
  await page.locator('.notif-panel').getByRole('button', { name: 'Marchează toate ca citite' }).click();
  await expect(bell.locator('.notif-badge')).toHaveCount(0);
  await expect(page).not.toHaveTitle(/^\(\d+\)/);
  expect(await db.notification.count({ where: { userId: custId, isRead: false } })).toBe(0);

  // Ses tercihi (zildeki anahtar): kapatınca yeni bildirim ses çalmaz ama açılır bildirim gelir; tercih kalıcı
  const sw = page.locator('.notif-panel .notif-switch');
  await expect(sw).toHaveText('Activat');
  // Sunucu işleminin yanıtı (yeniden çizilen panel akışı) gelmeden yeni bildirim eklenirse, eski akış yoklamanın
  // sonucunu ezer (yarış) — bu yüzden işlemin yanıtı beklenir.
  const saved = page.waitForRequest((r) => r.method() === 'POST');
  await sw.click();
  await expect(sw).toHaveText('Dezactivat');
  await (await saved).response();
  await expect.poll(async () => (await db.user.findUniqueOrThrow({ where: { id: custId } })).notificationSound).toBe(false);
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await db.notification.create({ data: { userId: custId, type: 'ORDER_OFFER_SENT', message: 'yeni', params: { aud: 'customer', orderNo }, link: `/siparisler/${orderId}`, orderId, dedupeKey: 'e2e:new:5' } });
  await poll(page);
  await expect(toast).toBeVisible();
  await expect(bell.locator('.notif-badge')).toHaveText('1');
  expect(await plays(page), 'ses kapalı: ses yok, bildirim var').toBe(2);
  // Ayarlar sayfasında aynı tercih (tek kayıt)
  await page.goto('/ayarlar');
  await expect(page.locator('input[name=notificationSound]')).not.toBeChecked();
  await page.locator('input[name=notificationSound]').check();
  await page.getByRole('button', { name: 'Salvează' }).click();
  await expect(page).toHaveURL(/ok=1/);
  expect((await db.user.findUniqueOrThrow({ where: { id: custId } })).notificationSound).toBe(true);
  await db.$disconnect();
  await ctx.close();
});

test('yalıtım ve maske: başka firmanın müşterisi ve satış, A müşterisinin bildirimini görmez; satışın bildiriminde firma maskeli; başkasının bildirimi okundu yapılamaz', async ({ browser }) => {
  const db = await prisma();
  const target = await db.notification.findFirstOrThrow({ where: { userId: custId, dedupeKey: 'e2e:new:5' } });
  await db.notification.update({ where: { id: target.id }, data: { isRead: false } });
  await db.notification.create({ data: { userId: salesId, type: 'ORDER_CREATED', message: 'yeni', params: { aud: 'staff', orderNo, firm: `${uns.name.slice(0, 3)}**********` }, link: `/siparisler/${orderId}`, orderId, dedupeKey: 'e2e:sales:1' } });

  const beta = await as(browser, BETA, TEAM_PW);
  await beta.goto('/siparisler');
  await expect(beta.locator('.notif-bell .notif-badge')).toHaveCount(0);
  const j = await (await beta.request.get('/bildirimler/akis')).json();
  expect(j.unread).toBe(0);
  expect(JSON.stringify(j)).not.toContain(orderNo);
  // Başkasının bildirimini okundu işaretleme (taklit sunucu işlemi isteği): kullanıcı kimliği oturumdan alınır,
  // istekteki kimlik hiçbir satıra uymaz
  await beta.goto('/siparisler');
  const html = await (await beta.request.get('/siparisler')).text();
  const ids = [...html.matchAll(/\$ACTION_ID_[0-9a-f]+/g)].map((m) => m[0]);
  const origin = new URL(beta.url()).origin;
  for (const field of new Set(ids)) {
    await beta.request.post('/siparisler', { multipart: { [field]: '', 0: target.id, 1: 'true' }, headers: { origin } }).catch(() => null);
  }
  expect((await db.notification.findUniqueOrThrow({ where: { id: target.id } })).isRead, 'başkasının bildirimi okundu olmadı').toBe(false);
  await beta.context().close();

  const sales = await as(browser, SALES2, TEAM_PW);
  await romanian(sales);
  await sales.goto('/siparisler');
  await expect(sales.locator('.notif-bell .notif-badge')).toHaveText('1');
  await sales.locator('.notif-bell').click();
  const item = sales.locator('.notif-panel .notif-item').first();
  await expect(item).toContainText('Comandă nouă');
  await expect(item).toContainText(`${uns.name.slice(0, 3)}**********`);
  await expect(item).not.toContainText(uns.name);
  const sj = await (await sales.request.get('/bildirimler/akis')).json();
  expect(JSON.stringify(sj)).not.toContain(uns.name);
  await sales.context().close();

  // Oturumsuz akış isteği: 401, veri yok
  const anon = await browser.newContext();
  const r = await anon.request.get('/bildirimler/akis');
  expect(r.status()).toBe(401);
  expect(JSON.stringify(await r.json())).not.toContain(orderNo);
  await anon.close();
  await db.$disconnect();
});

test('yönetici: bildirim bağlantısı yetkisiz sayfaya girişi açmaz (bağlantı yetki değildir)', async ({ browser }) => {
  // Müşteri, satış bildirimindeki admin adresini elinde bulundursa da sayfa kendi yetkisini denetler
  const page = await as(browser, CUSTOMER, CUST_PW);
  await page.goto('/admin/muhasebe/cam/proforma?musteri=x#partiler');
  await expect(page).toHaveURL(/\/siparisler(#.*)?$/); // tarayıcı adres parçasını (#…) yönlendirmede korur
  await expect(page.locator('h1')).not.toContainText(/proforma/i);
  await page.context().close();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/siparisler');
  await expect(admin.locator('.notif-bell')).toBeVisible();
  await admin.context().close();
});
