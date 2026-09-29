import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, SALES, TEAM_PW, as, createUser, crawlForLeaks, customerSecrets, firstLogin, login, outboxCodeFor } from './helpers';

// Aşama 1 — yetki, maskeleme ve giriş güvenliği (01–02 testlerinin oluşturduğu veriyle çalışır).
test.describe.configure({ mode: 'serial' });

const INSPECTOR = 'denetim@e2e.test';

test('maskeleme: satış ve çizim yanıtlarında müşteri firmalarının adı ve iletişim bilgisi yok', async ({ browser }) => {
  const secrets = await customerSecrets();
  expect(secrets).toContain('Ünsal Cam');
  for (const email of [SALES, DRAWER]) {
    const page = await as(browser, email, TEAM_PW);
    const { pages, leaks } = await crawlForLeaks(page, secrets);
    expect(pages, `${email} için taranan sayfa`).toBeGreaterThan(3);
    expect(leaks, email).toEqual([]);
    await page.context().close();
  }
});

test('denetimci: yönetici ekler; tüm siparişleri tam firma adıyla görür, hiçbir işlem yapamaz', async ({ browser, page }) => {
  await login(page, ADMIN, ADMIN_PW);
  await createUser(page, { email: INSPECTOR, name: 'Denetim Kişi', role: 'Denetimci', firm: 'GKH Trading' });
  const ctx = await browser.newContext();
  const insp = await ctx.newPage();
  await firstLogin(insp, INSPECTOR, outboxCodeFor(INSPECTOR), 'Denet1');
  await expect(insp.getByRole('heading', { name: 'Tüm siparişler (denetim)' })).toBeVisible();
  await expect(insp.getByText('Ünsal Cam').first()).toBeVisible();
  // Menü: Siparişler, Teklifler, Yüklemeler; yönetim yok
  await expect(insp.locator('.sidebar').getByRole('link', { name: 'Teklifler' })).toBeVisible();
  await expect(insp.locator('.sidebar').getByRole('link', { name: 'Kullanıcılar' })).toHaveCount(0);

  const first = insp.locator('a.order-no').first();
  await first.click();
  await expect(insp).toHaveURL(/\/siparisler\/[^/]+$/);
  const actionForms = insp.locator('form').filter({ hasNot: insp.getByRole('button', { name: 'Çıkış' }) });
  await expect(actionForms).toHaveCount(0);
  await expect(insp.locator('textarea, input[type=file]')).toHaveCount(0);

  for (const url of ['/admin/users', '/admin/firms', '/siparisler/yeni']) {
    await insp.goto(url);
    await expect(insp, url).toHaveURL(/\/siparisler$/);
  }
  await ctx.close();
});

test('dosyalar: müşteri başka firmanın ya da iç ekibin dosyasını adresini bilse de indiremez', async ({ browser }) => {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const me = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  const foreign = await db.orderFile.findFirst({ where: { order: { customerId: { not: me.customerId! } } } });
  const internal = await db.orderFile.findFirst({ where: { kind: 'INTERNAL', order: { customerId: me.customerId! } } });
  const own = await db.orderFile.findFirst({ where: { kind: 'CUSTOMER', order: { customerId: me.customerId! } } });
  const foreignDrawing = await db.drawing.findFirst({ where: { order: { customerId: { not: me.customerId! } } } });
  await db.$disconnect();
  expect(foreign, 'başka firmanın dosyası (02 testlerinden)').toBeTruthy();

  const cust = await as(browser, CUSTOMER, CUST_PW);
  if (own) expect((await cust.request.get(`/dosya/siparis/${own.id}`)).status()).toBe(200);
  expect((await cust.request.get(`/dosya/siparis/${foreign!.id}`)).status()).toBe(404);
  if (internal) expect((await cust.request.get(`/dosya/siparis/${internal.id}`)).status()).toBe(404);
  if (foreignDrawing) expect((await cust.request.get(`/dosya/cizim/${foreignDrawing.id}`)).status()).toBe(404);
  await cust.context().close();

  const anon = await browser.newContext();
  expect((await anon.request.get(`/dosya/siparis/${foreign!.id}`)).status()).toBe(401);
  await anon.close();
});

test('giriş: 5 hatalı denemeden sonra kilit, doğru şifre de açmaz; mesaj iki dilde', async ({ page }) => {
  const email = SALES;
  for (let i = 0; i < 5; i++) {
    await page.goto(`/login`);
    await page.fill('#email', email);
    await page.fill('#password', `yanlis${i}`);
    await page.click('button[type=submit]');
    await expect(page.getByText('E-posta veya şifre hatalı.')).toBeVisible();
  }
  await page.fill('#password', TEAM_PW);
  await page.click('button[type=submit]');
  await expect(page.getByText(/Çok fazla hatalı deneme yapıldı\. Güvenliğiniz için giriş \d+ dakika kilitlendi\./)).toBeVisible();
  await expect(page).toHaveURL(/error=locked/);

  await page.goto(`/dil?l=ro&next=${encodeURIComponent(new URL(page.url()).pathname + new URL(page.url()).search)}`);
  await expect(page.getByText(/Prea multe încercări greșite\./)).toBeVisible();
  await page.goto('/dil?l=tr&next=/login');

  // Kilit yalnızca o e-posta + IP için: başka hesap girebilir
  await login(page, CUSTOMER, CUST_PW);
});
