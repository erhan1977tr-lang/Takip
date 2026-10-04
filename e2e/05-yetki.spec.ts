import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, SALES, TEAM_PW, as, createUser, crawlForLeaks, customerSecrets, login, outboxCodeFor } from './helpers';
import crypto from 'node:crypto';

// Aşama 1 — yetki, maskeleme ve giriş güvenliği (01–02 testlerinin oluşturduğu veriyle çalışır).
test.describe.configure({ mode: 'serial' });

const INSPECTOR = 'denetim@e2e.test';

test('maskeleme: satış ve çizim yanıtlarında müşteri firmalarının adı, iletişim / fatura bilgisi, mali belge e-postası ve kur politikası yok', async ({ browser }) => {
  // SEC-07: firmanın bütün özel alanları dolu olsun (tarama yalnızca dolu alanı yakalayabilir); test sonunda eski hâline döner
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const firm = await db.customer.findFirstOrThrow({ where: { name: 'Ünsal Cam' } });
  const original = { email: firm.email, billingEmail: firm.billingEmail, regCom: firm.regCom, county: firm.county, city: firm.city, fxPolicy: firm.fxPolicy, fxMarkupPercent: firm.fxMarkupPercent };
  const PRIVATE = { email: 'ofis-gizli@unsal.test', billingEmail: 'facturi-gizli@unsal.test', regCom: 'J40/98765/2020', county: 'JudetGizli', city: 'OrasGizli' };
  const PERCENT = '17.293';
  await db.customer.update({ where: { id: firm.id }, data: { ...PRIVATE, fxPolicy: 'BNR_PLUS_PERCENT', fxMarkupPercent: PERCENT } });
  try {
    const secrets = [...(await customerSecrets()), 'BNR_PLUS_PERCENT'];
    expect(secrets).toContain('Ünsal Cam');
    for (const s of [...Object.values(PRIVATE), PERCENT]) expect(secrets, s).toContain(s);
    for (const email of [SALES, DRAWER]) {
      const page = await as(browser, email, TEAM_PW);
      const { pages, leaks } = await crawlForLeaks(page, secrets);
      expect(pages, `${email} için taranan sayfa`).toBeGreaterThan(3);
      expect(leaks, email).toEqual([]);
      await page.context().close();
    }
    // Müşterinin kendisi: kendi adını ve bilgilerini görür, ama müşteriye özel kur yüzdesi (ticari iç bilgi, karar 99)
    // ona giden hiçbir yanıtta yoktur
    const own = await as(browser, CUSTOMER, CUST_PW);
    const res = await crawlForLeaks(own, [PERCENT]);
    expect(res.pages, 'müşteri için taranan sayfa').toBeGreaterThan(3);
    expect(res.leaks, 'müşteri: kur yüzdesi').toEqual([]);
    await own.context().close();
  } finally {
    await db.customer.update({ where: { id: firm.id }, data: original });
    await db.$disconnect();
  }
});

test('denetimci: yönetici ekler; tüm siparişleri tam firma adıyla görür, hiçbir işlem yapamaz', async ({ browser, page }) => {
  await login(page, ADMIN, ADMIN_PW);
  await createUser(page, { email: INSPECTOR, name: 'Denetim Kişi', role: 'Denetimci', firm: 'GKH Trading' });
  const ctx = await browser.newContext();
  const insp = await ctx.newPage();
  // SEC-04: yeni şifre en az 10 karakter. Tarayıcıdaki denetim atlansa da sunucu reddeder (eski kural: 6 karakter).
  await insp.goto(`/setup?email=${encodeURIComponent(INSPECTOR)}`);
  await insp.fill('#code', outboxCodeFor(INSPECTOR));
  await insp.click('button[type=submit]');
  await expect(insp.getByRole('heading', { name: 'Şifrenizi belirleyin', exact: true })).toBeVisible();
  await expect(insp.locator('#password')).toHaveAttribute('minlength', '10');
  for (const weak of ['Denet1', 'abc123def', 'aaaaaaaaaaaa']) {
    await insp.evaluate(() => document.querySelectorAll('input[type=password]').forEach((i) => i.removeAttribute('minlength')));
    await insp.fill('#password', weak);
    await insp.fill('#password2', weak);
    await insp.click('button[type=submit]');
    await expect(insp, weak).toHaveURL(/error=weak/);
    await expect(insp.getByText('Şifre en az 10 karakter olmalı'), weak).toBeVisible();
  }
  await insp.fill('#password', INSPECTOR_PW);
  await insp.fill('#password2', INSPECTOR_PW);
  await insp.click('button[type=submit]');
  await expect(insp).toHaveURL(/\/siparisler/);
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
  const foreignDrawing = await db.drawingFile.findFirst({ where: { drawing: other } });
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

test('SEC-04: eski kuraldan kalan kısa şifreyle giriş sürer (kural yalnızca şifre belirlenirken uygulanır)', async ({ browser }) => {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const user = await db.user.findUniqueOrThrow({ where: { email: INSPECTOR } });
  // 6 karakterlik eski şifrenin kayıtlı özeti (scrypt; uygulamanın biçimi)
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync('Eski12', salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const legacy = ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
  await db.user.update({ where: { id: user.id }, data: { passwordHash: legacy } });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, INSPECTOR, 'Eski12');
    await expect(page.getByRole('heading', { name: 'Tüm siparişler (denetim)' })).toBeVisible();
    await ctx.close();
  } finally {
    await db.user.update({ where: { id: user.id }, data: { passwordHash: user.passwordHash } });
    await db.$disconnect();
  }
  const again = await as(browser, INSPECTOR, INSPECTOR_PW);
  await again.context().close();
});

test('SEC-01: sahte IP başlıkları giriş sınırını aşamaz; sınır ve denetim kaydı aynı güvenilir adresi kullanır', async ({ browser }) => {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  /** Verilen başlıklarla bir giriş denemesi → sonuç kodu (invalid | locked) */
  const attempt = async (headers: Record<string, string>, email: string) => {
    const ctx = await browser.newContext({ extraHTTPHeaders: headers });
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.fill('#email', email);
    await page.fill('#password', 'yanlis-sifre');
    await page.click('button[type=submit]');
    await page.waitForURL(/error=/);
    const code = new URL(page.url()).searchParams.get('error');
    await ctx.close();
    return code;
  };
  const SIX = ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'locked'];
  const ipsOf = async (email: string) => [...new Set((await db.authFailure.findMany({ where: { email } })).map((f) => f.ip))];
  try {
    // 1. Her denemede başka bir sahte CF-Connecting-IP / X-Real-IP / True-Client-IP: güvenilir adres (vekilin yazdığı
    //    X-Forwarded-For) aynı kaldığı için beşinci hatadan sonra kilit
    const CF = 'sahte-cf@e2e.test', REAL = '86.121.10.30';
    const viaCf: (string | null)[] = [];
    for (let i = 1; i <= 6; i++) viaCf.push(await attempt({ 'x-forwarded-for': REAL, 'cf-connecting-ip': `10.9.0.${i}`, 'x-real-ip': `10.9.1.${i}`, 'true-client-ip': `10.9.2.${i}` }, CF));
    expect(viaCf).toEqual(SIX);
    expect(await ipsOf(CF)).toEqual([REAL]);

    // 2. İstemcinin X-Forwarded-For'a önceden yazdığı sahte adresler: sayılan, en yakın vekilin eklediği SON adrestir
    const XFF = 'sahte-xff@e2e.test', REAL2 = '86.121.10.31';
    const viaXff: (string | null)[] = [];
    for (let i = 1; i <= 6; i++) viaXff.push(await attempt({ 'x-forwarded-for': `10.8.0.${i}, 10.8.1.${i}, ${REAL2}` }, XFF));
    expect(viaXff).toEqual(SIX);
    expect(await ipsOf(XFF)).toEqual([REAL2]);

    // 3. Vekilin ilettiği gerçek adres çalışır: kilit e-posta + adres içindir — başka adresten gelen aynı e-posta kilitli değil
    expect(await attempt({ 'x-forwarded-for': '86.121.10.32' }, CF)).toBe('invalid');
    expect((await ipsOf(CF)).sort()).toEqual([REAL, '86.121.10.32']);

    // 4. Denetim kaydı aynı kaynağı yazar; sahte adresler hiçbir kayda girmez
    const locked = await db.auditLog.findFirstOrThrow({ where: { action: 'LOGIN_LOCKED', ip: REAL }, orderBy: { createdAt: 'desc' } });
    expect((locked.details as { ip: string }).ip).toBe(REAL);
    expect(await attempt({ 'x-forwarded-for': '86.121.10.33', 'cf-connecting-ip': '10.9.9.9', 'x-real-ip': '10.9.9.9' }, DRAWER)).toBe('invalid');
    const failed = await db.auditLog.findFirstOrThrow({ where: { action: 'LOGIN_FAILED', user: { email: DRAWER } }, orderBy: { createdAt: 'desc' } });
    expect([failed.ip, (failed.details as { ip: string }).ip]).toEqual(['86.121.10.33', '86.121.10.33']);
    expect(await db.auditLog.count({ where: { OR: [{ ip: { startsWith: '10.9.' } }, { ip: { startsWith: '10.8.' } }] } })).toBe(0);
    expect(await db.authFailure.count({ where: { OR: [{ ip: { startsWith: '10.9.' } }, { ip: { startsWith: '10.8.' } }] } })).toBe(0);
    // Çizimci hesabı kilitlenmedi (tek hata, başka adres): girişi çalışır
    const ok = await as(browser, DRAWER, TEAM_PW);
    await ok.context().close();
  } finally {
    await db.$disconnect();
  }
});

test('SEC-15: /dil (GET) yalnızca dil çerezini yazar — kayıt değiştirmez; kullanıcının dili paneldeki seçimle (sunucu işlemi) kaydedilir', async ({ browser }) => {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const lang = async () => (await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } })).language;
  const page = await as(browser, CUSTOMER, CUST_PW);
  const before = await lang();
  expect(before).toBe('tr');
  try {
    // GET: ekran Romence açılır (çerez), ama veritabanındaki kayıt aynı kalır — başka bir siteye gömülü bağlantı da kaydı değiştiremez
    await page.goto('/dil?l=ro&next=/yuklemeler');
    await expect(page).toHaveURL(/\/yuklemeler$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ro');
    expect(await lang()).toBe('tr');
    expect((await page.request.get('/dil?l=ro&next=/siparisler', { maxRedirects: 0 })).status()).toBe(303);
    expect(await lang()).toBe('tr');
    // Paneldeki seçim: aynı sayfada kalır, ekran dili değişir
    await page.locator('.lang-select').selectOption('tr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(page).toHaveURL(/\/yuklemeler$/);
    // … ve kayıt sunucu işlemiyle değişir
    await page.locator('.lang-select').selectOption('ro');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ro');
    await expect.poll(lang).toBe('ro');
    await page.locator('.lang-select').selectOption('tr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect.poll(lang).toBe('tr');
  } finally {
    await db.user.update({ where: { email: CUSTOMER }, data: { language: before } });
    await db.$disconnect();
    await page.context().close();
  }
});
