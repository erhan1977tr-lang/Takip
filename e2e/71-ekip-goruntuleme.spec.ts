import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, TEAM_PW, as, assignOrderTo, createUser, firstLogin, newOrder, outboxCodeFor } from './helpers';

// Satış ekibinin ortak görüntülemesi (4.3.17, karar 301) ve çizimci değiştirme (D-3, karar 303) — gerçek sunucuda:
//   - aynı geçerli varsayılan çizimciye bağlı satışçı ekip arkadaşının siparişini, dosyasını ve teklif dışa aktarımını GÖRÜR,
//     "Sıra bende"de görmez, sayfada hiçbir işlem / form yoktur;
//   - sunucu işlemleri doğrudan gönderilse de (çizime gönder, teklife gönder, not ekle) ekip arkadaşının siparişi değişmez;
//   - farklı çizimciye bağlı satışçı siparişi, dosyayı ve teklifi göremez (404);
//   - yönetici çizimciyi değiştirir: çizim kaydı değişmez, ortak görüntüleme satışçıların çizimcisine göre kalır.
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test';
const MATE = 'ekip-ortak-satis@e2e.test';
const OTHER = 'ekip-baska-satis@e2e.test';
const OTHER_DRAWER = 'ekip-baska-cizim@e2e.test';
let orderId = '';
let orderNo = '';
let mateOrderId = '';
let fileId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
async function actionField(page: Page, url: string, marker: string): Promise<string> {
  const html = await (await page.request.get(url)).text();
  const form = html.split('<form').find((chunk) => chunk.includes(marker));
  const m = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form) : null;
  expect(m, `sunucu işlemi alanı bulunamadı (${url}, ${marker})`).toBeTruthy();
  return m![0];
}
async function forge(page: Page, url: string, field: string, data: Record<string, string>) {
  const origin = new URL(page.url()).origin;
  return page.request.post(url, { multipart: { [field]: '', ...data }, headers: { origin }, maxRedirects: 0 });
}

test('veri: aynı çizimciye bağlı ekip arkadaşı, farklı çizimciye bağlı satışçı, ikisine birer sipariş', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await createUser(admin, { email: MATE, name: 'Ortak Satış', role: 'Satış', firm: 'GKH Trading' });
  await createUser(admin, { email: OTHER, name: 'Başka Satış', role: 'Satış', firm: 'GKH Trading' });
  await createUser(admin, { email: OTHER_DRAWER, name: 'Başka Çizim', role: 'Çizimci', firm: 'GKH Trading' });
  for (const email of [MATE, OTHER, OTHER_DRAWER]) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await firstLogin(p, email, outboxCodeFor(email), TEAM_PW);
    await ctx.close();
  }
  await admin.context().close();
  const db = await prisma();
  const a = await db.user.findUniqueOrThrow({ where: { email: SALES } });
  expect(a.defaultDrawerId, 'satışçının varsayılan çizimcisi').toBeTruthy();
  const otherDrawer = await db.user.findUniqueOrThrow({ where: { email: OTHER_DRAWER } });
  await db.user.update({ where: { email: MATE }, data: { defaultDrawerId: a.defaultDrawerId } });
  await db.user.update({ where: { email: OTHER }, data: { defaultDrawerId: otherDrawer.id } });
  await db.$disconnect();

  const cust = await as(browser, CUSTOMER, CUST_PW);
  orderId = await newOrder(cust, 'Ekip görüntüleme A', 'ekip-gor.pdf');
  mateOrderId = await newOrder(cust, 'Ekip görüntüleme C', 'ekip-gor-c.pdf');
  await cust.context().close();
  await assignOrderTo(orderId, SALES);
  await assignOrderTo(mateOrderId, MATE);
  const db2 = await prisma();
  const o = await db2.order.findUniqueOrThrow({ where: { id: orderId }, include: { files: true } });
  orderNo = o.orderNo;
  fileId = o.files[0].id;
  await db2.$disconnect();
});

test('ekip arkadaşı: siparişi, dosyayı ve teklif dışa aktarımını görür; "Sıra bende"de yok; sayfada işlem ve form yok', async ({ browser }) => {
  const mate = await as(browser, MATE, TEAM_PW);
  const r = await mate.goto(`/siparisler/${orderId}`);
  expect(r!.status()).toBe(200);
  await expect(mate.locator('[data-team-view]')).toContainText('Fiyat Satışçı');
  await expect(mate.getByRole('button', { name: 'Çizim Ekibine Gönder' })).toHaveCount(0);
  await expect(mate.getByRole('button', { name: 'Teklife Gönder', exact: true })).toHaveCount(0);
  await expect(mate.locator('textarea[name="text"]')).toHaveCount(0);
  await expect(mate.locator('input[type="file"]')).toHaveCount(0);
  expect((await mate.request.get(`/dosya/siparis/${fileId}`)).status()).toBe(200);
  // "Tüm aktif siparişler": görüntüleme rozetiyle; "Sıra bende": yok
  await mate.goto('/siparisler?view=all');
  await expect(mate.locator('body')).toContainText(orderNo);
  await expect(mate.locator('body')).toContainText('Görüntüleme · sorumlu: Fiyat Satışçı');
  await mate.goto('/siparisler');
  await expect(mate.locator('body')).not.toContainText(orderNo);
  await mate.context().close();
});

test('ekip arkadaşı doğrudan sunucu işlemi gönderse de sipariş değişmez (çizime gönder, teklife gönder, not)', async ({ browser }) => {
  const mate = await as(browser, MATE, TEAM_PW);
  await mate.goto(`/siparisler/${mateOrderId}`);
  const own = `/siparisler/${mateOrderId}`;
  const fields = {
    drawing: await actionField(mate, own, '>Çizim Ekibine Gönder</button>'),
    noDrawing: await actionField(mate, own, '>Teklife Gönder</button>'),
    note: await actionField(mate, own, 'name="requestKey"'),
  };
  const db = await prisma();
  const before = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const target = `/siparisler/${orderId}`;
  await forge(mate, target, fields.drawing, { id: orderId });
  await forge(mate, target, fields.noDrawing, { id: orderId });
  await forge(mate, target, fields.note, { id: orderId, text: 'ekip arkadaşı yazamaz', requestKey: 'ekip-gor-not-0000000001' });
  const after = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  expect([after.status, after.version, after.drawingTrack, after.salesUserId]).toEqual([before.status, before.version, before.drawingTrack, before.salesUserId]);
  const mateUser = await db.user.findUniqueOrThrow({ where: { email: MATE } });
  expect(await db.orderNote.count({ where: { orderId } })).toBe(0);
  expect(await db.orderEvent.count({ where: { orderId, userId: mateUser.id } })).toBe(0);
  expect(await db.orderNoteRead.count({ where: { orderId, userId: mateUser.id } })).toBe(0);
  await db.$disconnect();
  await mate.context().close();
});

test('farklı çizimciye bağlı satışçı: sipariş, dosya ve teklif 404; listede yok', async ({ browser }) => {
  const other = await as(browser, OTHER, TEAM_PW);
  expect((await other.goto(`/siparisler/${orderId}`))!.status()).toBe(404);
  expect((await other.request.get(`/dosya/siparis/${fileId}`)).status()).toBe(404);
  expect((await other.request.get(`/siparisler/${orderId}/teklif?format=pdf`)).status()).toBe(404);
  await other.goto('/siparisler?view=all');
  await expect(other.locator('body')).not.toContainText(orderNo);
  await other.context().close();
});

test('D-3: yönetici siparişin çizimcisini değiştirir; satış ve ekip arkadaşı bu kartı görmez', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${orderId}`);
  await expect(admin.locator('[data-drawer-assign]')).toBeVisible();
  const db = await prisma();
  const otherDrawer = await db.user.findUniqueOrThrow({ where: { email: OTHER_DRAWER } });
  await admin.selectOption('#cizimci-sec', otherDrawer.id);
  await admin.fill('#cizimci-gerekce', 'e2e izin');
  await admin.locator('[data-drawer-assign]').getByRole('button', { name: 'Çizimciyi değiştir' }).click();
  await expect(admin.getByText('Çizimci değiştirildi')).toBeVisible();
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  expect(o.assignedDrawerId).toBe(otherDrawer.id);
  expect(await db.orderEvent.count({ where: { orderId, event: 'DRAWER_ASSIGNED' } })).toBe(1);
  await db.$disconnect();
  await admin.context().close();
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${orderId}`);
  await expect(sales.locator('[data-drawer-assign]')).toHaveCount(0);
  await sales.context().close();
});
