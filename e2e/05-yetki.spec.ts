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
  // Beta Cam müşterisi, Ünsal Cam'in dosya ve çizimlerini (02 testlerinden) adresini bilerek istemeye çalışır
  const BETA = 'beta@betacam.test';
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const me = await db.user.findUniqueOrThrow({ where: { email: BETA } });
  const other = { order: { customerId: { not: me.customerId! } } };
  const mine = { order: { customerId: me.customerId! } };
  const foreignFile = await db.orderFile.findFirst({ where: other });
  const foreignDrawing = await db.drawing.findFirst({ where: other });
  const ownFile = await db.orderFile.findFirst({ where: { kind: 'CUSTOMER', ...mine } });
  const ownInternal = await db.orderFile.findFirst({ where: { kind: 'INTERNAL', ...mine } });
  await db.$disconnect();
  expect(foreignFile || foreignDrawing, 'başka firmanın dosyası ya da çizimi (02 testlerinden)').toBeTruthy();

  const cust = await as(browser, BETA, TEAM_PW);
  const status = async (url: string) => (await cust.request.get(url)).status();
  const anon = await browser.newContext();
  const anyForeign = foreignDrawing ? `/dosya/cizim/${foreignDrawing.id}` : `/dosya/siparis/${foreignFile!.id}`;
  const got = {
    ownFile: ownFile ? await status(`/dosya/siparis/${ownFile.id}`) : 'yok',
    ownInternal: ownInternal ? await status(`/dosya/siparis/${ownInternal.id}`) : 'yok',
    foreignFile: foreignFile ? await status(`/dosya/siparis/${foreignFile.id}`) : 'yok',
    foreignDrawing: foreignDrawing ? await status(`/dosya/cizim/${foreignDrawing.id}`) : 'yok',
    anonymous: (await anon.request.get(anyForeign)).status(),
  };
  await anon.close();
  await cust.context().close();
  expect(got).toEqual({
    ownFile: ownFile ? 200 : 'yok',
    ownInternal: ownInternal ? 404 : 'yok',
    foreignFile: foreignFile ? 404 : 'yok',
    foreignDrawing: foreignDrawing ? 404 : 'yok',
    anonymous: 401,
  });
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
