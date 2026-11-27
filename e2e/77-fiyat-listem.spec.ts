import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, as, login } from './helpers';

// Müşteri "Fiyat listem" (4.3.0, karar 333) — gerçek sunucu:
//  - müşteri yalnızca KENDİ firmasına bağlı müşteri fiyat tablosunu görür (fiyatı dolu, aktif cam), seçili dilde;
//  - başka firmanın fiyatı ve fabrika / satış fiyatları (kind SALES) sayfada ve kaynağında asla yok;
//  - fabrika tablosu yanlışlıkla bağlanmış firma boş liste görür; adres parametresi firmayı değiştiremez;
//  - iç roller sayfayı açamaz, menüde yalnızca müşteride görünür.
// Kendi firmaları / kullanıcıları / camlarıyla çalışır; diğer testlerin verisine dokunmaz.
test.describe.configure({ mode: 'serial' });
const PW = 'FiyatListem2026';
const U1 = 'fiyat1@e2e.test';
const U2 = 'fiyat2@e2e.test';
const U3 = 'fiyat3@e2e.test';
const STAFF = 'fiyat-listem-satis@e2e.test'; // bu dosyaya özel satışçı (satis@e2e.test 05'te bilerek kilitleniyor)
const FACTORY_PRICES = ['17,17', '18,18', '19,19'];

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test.beforeAll(async () => {
  const db = await prisma();
  try {
    const { hashPassword } = await import('../server/auth/password-hash.js');
    const g = await Promise.all([
      ['E2E LİSTE CAM 8', 'E2E Listă sticlă 8', true], ['E2E LİSTE CAM 10', 'E2E Listă sticlă 10', true],
      ['E2E LİSTE CAM 6', 'E2E Listă sticlă 6', true], ['E2E LİSTE PASİF', 'E2E Listă inactivă', false],
    ].map(([tr, ro, active], i) => db.glassProduct.create({ data: { nameTr: String(tr), nameRo: String(ro), colorTr: 'ŞEFFAF', colorRo: 'Clar', isActive: Boolean(active), sortOrder: 9000 + i } })));
    const items = (prices: (string | null)[]) => ({ create: prices.flatMap((p, i) => (p == null ? [] : [{ glassProductId: g[i].id, unitPrice: p }])) });
    const factory = await db.priceTable.create({ data: { kind: 'SALES', name: 'E2E Fabrika Liste', currency: 'EUR', items: items(['17.17', '18.18', '19.19']) } });
    const t1 = await db.priceTable.create({ data: { kind: 'CUSTOMER', name: 'E2E Liste Firma 1', currency: 'EUR', holePrice: '3.33', items: items(['45.50', '39.00', '0', '50.00']) } });
    const t2 = await db.priceTable.create({ data: { kind: 'CUSTOMER', name: 'E2E Liste Firma 2', currency: 'RON', items: items([null, null, '210.00']) } });
    const firms = await Promise.all([
      db.customer.create({ data: { name: 'Liste Bir SRL', prefix: 'LBR', priceTableId: t1.id } }),
      db.customer.create({ data: { name: 'Liste İki SRL', prefix: 'LIK', priceTableId: t2.id } }),
      db.customer.create({ data: { name: 'Liste Üç SRL', prefix: 'LUC', priceTableId: factory.id } }),
    ]);
    const hash = await hashPassword(PW);
    for (const [email, firm] of [[U1, firms[0]], [U2, firms[1]], [U3, firms[2]]] as const) {
      await db.user.create({ data: { email, name: email, type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firm.id, passwordHash: hash, fixedLanguage: null, language: 'tr' } });
    }
    const factoryFirm = await db.customer.findFirstOrThrow({ where: { type: 'FACTORY' } });
    await db.user.create({ data: { email: STAFF, name: 'Fiyat Listem Satış', type: 'INTERNAL', appRole: 'SATIS', customerId: factoryFirm.id, passwordHash: hash, fixedLanguage: null, language: 'tr' } });
  } finally {
    await db.$disconnect();
  }
});

test('müşteri kendi listesini görür: fiyatlı aktif camlar, seçili dilde; fabrika ve başka firmanın fiyatı yok', async ({ browser }) => {
  const page = await as(browser, U1, PW);
  await expect(page.locator('a[href="/fiyat-listem"]').first()).toBeVisible();
  await page.goto('/fiyat-listem');
  const rows = page.locator('[data-price-row]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('E2E LİSTE CAM 8 — ŞEFFAF');
  await expect(rows.nth(0)).toContainText('45,50');
  await expect(rows.nth(1)).toContainText('E2E LİSTE CAM 10 — ŞEFFAF');
  await expect(rows.nth(1)).toContainText('39,00');
  await expect(page.locator('#fiyat-listem th').last()).toContainText('EUR');
  const html = await page.content();
  for (const s of [...FACTORY_PRICES, '17.17', '210', 'E2E Fabrika Liste', 'E2E Liste Firma 1', 'E2E LİSTE CAM 6', 'E2E LİSTE PASİF', '3,33']) expect(html, s).not.toContain(s);
  // Adres parametresi firmayı / tabloyu seçemez
  await page.goto('/fiyat-listem?customerId=x&tableId=y&kind=SALES');
  await expect(page.locator('[data-price-row]')).toHaveCount(2);
  // Romence
  await page.selectOption('select.lang-select', 'ro');
  await page.waitForLoadState('networkidle');
  await page.goto('/fiyat-listem');
  await expect(page.locator('h1')).toHaveText('Lista mea de prețuri');
  await expect(page.locator('[data-price-row]').nth(0)).toContainText('E2E Listă sticlă 8 — Clar');
  await page.context().close();
});

test('her firmanın listesi ayrı; fabrika tablosu bağlı firma boş liste görür', async ({ browser }) => {
  const p2 = await as(browser, U2, PW);
  await p2.goto('/fiyat-listem');
  await expect(p2.locator('[data-price-row]')).toHaveCount(1);
  await expect(p2.locator('[data-price-row]')).toContainText('210,00');
  expect(await p2.content()).not.toContain('45,50');
  await p2.context().close();
  const p3 = await as(browser, U3, PW);
  await p3.goto('/fiyat-listem');
  await expect(p3.locator('[data-price-list-empty]')).toBeVisible();
  const html = await p3.content();
  for (const s of FACTORY_PRICES) expect(html, s).not.toContain(s);
  await p3.context().close();
});

test('iç roller sayfayı açamaz ve menüde görmez', async ({ browser }) => {
  for (const [email, pw] of [[ADMIN, ADMIN_PW], [STAFF, PW]]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, email, pw);
    await expect(page.locator('a[href="/fiyat-listem"]')).toHaveCount(0);
    await page.goto('/fiyat-listem');
    await expect(page).toHaveURL(/\/siparisler/);
    await ctx.close();
  }
});
