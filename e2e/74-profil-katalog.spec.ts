import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, TEAM_PW, as, createUser, firstLogin, outboxCodeFor } from './helpers';

// Çoklu profil fiyat kataloğu (4.2.17, karar 312), gerçek sunucuda. FGO e2e veritabanında KAPALIDIR.
//  - yönetici: bir firmaya ikinci katalog "ek katalog olarak" bağlanır; varsayılan korunur
//  - müşteri: formun üstünde "Fiyat Kataloğu" seçimi (varsayılan seçili); seçim değişince fiyat, satır tutarı ve toplam
//    SAYFA YENİLENMEDEN değişir; adetler ve not korunur; sipariş seçilen katalogdaki fiyatlarla açılır, katalog siparişe yazılır
//  - başka firmanın müşterisi bu katalogları görmez; tek kataloglu müşteride seçim yok
test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const CUST = `pk-musteri-${RUN}@pkfirma.test`;
const OTHER = `pk-diger-${RUN}@pkdiger.test`;
const FIRM = `ATICO Katalog ${RUN}`;
const FIRM2 = `Diger Katalog ${RUN}`;
const T1 = `ATICO ${RUN}`;
const T2 = `ATICO - MTM ${RUN}`;
let prefix = '';
let orderId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('veri: iki firma, iki katalog (GK15: 137 / 125 EUR; SPIGOTI yalnızca ilkinde), iki müşteri kullanıcısı', async ({ browser }) => {
  const db = await prisma();
  try {
    const taken = new Set((await db.customer.findMany({ select: { prefix: true } })).map((c) => c.prefix));
    const free = ['PKA', 'PKB', 'PKC', 'PKD', 'PKE', 'PKF'].filter((p) => !taken.has(p));
    prefix = free[0];
    const firm = await db.customer.create({ data: { name: FIRM, prefix } });
    const firm2 = await db.customer.create({ data: { name: FIRM2, prefix: free[1] } });
    const gk = await db.profileProduct.findUniqueOrThrow({ where: { code: 'GK15' } });
    const sp = await db.profileProduct.findUniqueOrThrow({ where: { code: 'SPIGOTI' } });
    const t1 = await db.profilePriceTable.create({ data: { name: T1, items: { create: [{ productId: gk.id, unitPrice: '137.00' }, { productId: sp.id, unitPrice: '3.00' }] } } });
    await db.profilePriceTable.create({ data: { name: T2, items: { create: [{ productId: gk.id, unitPrice: '125.00' }] } } });
    await db.customer.update({ where: { id: firm.id }, data: { profilePriceTableId: t1.id } });
    await db.customer.update({ where: { id: firm2.id }, data: { profilePriceTableId: t1.id } }); // diğer firma yalnızca ATICO kataloğuna bağlı
  } finally {
    await db.$disconnect();
  }
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await createUser(admin, { email: CUST, name: 'PK Müşteri', role: 'Müşteri', firm: FIRM, canApprove: true });
  await createUser(admin, { email: OTHER, name: 'PK Diğer', role: 'Müşteri', firm: FIRM2, canApprove: true });
  await admin.context().close();
  for (const email of [CUST, OTHER]) {
    const fresh = await (await browser.newContext()).newPage();
    await firstLogin(fresh, email, outboxCodeFor(email), TEAM_PW);
    await fresh.context().close();
  }
});

test('yönetici: ikinci katalog ek katalog olarak bağlanır; varsayılan ve fiyatlar korunur', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/profil-fiyatlari');
  await admin.locator('tr', { hasText: T2 }).getByRole('link', { name: 'Düzenle' }).click();
  const row = admin.locator(`tr[data-firm-row="${prefix}"]`);
  await expect(row.locator('[data-default-table]')).toHaveText(T1);
  await expect(row.locator('[data-extra-tables]')).toHaveText('—');
  await row.locator('button[data-assign="extra"]').click();
  await expect(admin).toHaveURL(/ok=assigned/);
  const row2 = admin.locator(`tr[data-firm-row="${prefix}"]`);
  await expect(row2.locator('[data-default-table]')).toHaveText(T1);
  await expect(row2.locator('[data-extra-tables]')).toHaveText(T2);
  await expect(row2.locator('button[data-assign="unassign"]')).toHaveText('Ek bağlantıyı kaldır');
  await admin.context().close();
});

test('müşteri: katalog seçimi — fiyat, tutar ve toplam yenilenmeden değişir; adet ve not korunur; sipariş seçilen fiyatlarla', async ({ browser }) => {
  const page = await as(browser, CUST, TEAM_PW);
  await page.goto('/siparisler/yeni?tip=PROFILE_ORDER');
  const card = page.locator('#dogrudan');
  const select = page.locator('#dg-catalog');
  await expect(select).toBeVisible();
  const options = select.locator('option');
  await expect(options).toHaveCount(2);
  await expect(options.first()).toHaveText(`${T1} — varsayılan`);
  const t1Id = await options.first().getAttribute('value');
  const t2Id = await options.nth(1).getAttribute('value');
  await expect(select).toHaveValue(t1Id!);
  const gkRow = page.locator('tr', { has: page.locator('.mono', { hasText: 'GK15' }) }).first();
  const spRow = page.locator('tr', { has: page.locator('.mono', { hasText: 'SPIGOTI' }) }).first();
  await expect(gkRow.locator('td[data-price]')).toHaveAttribute('data-price', '137');
  await expect(spRow.locator('td[data-price]')).toHaveAttribute('data-price', '3');
  await gkRow.locator('input[name=p_qty]').fill('2');
  await spRow.locator('input[name=p_qty]').fill('4');
  await page.locator('#note').fill(`Not ${RUN}`);
  await expect(card.locator('[data-direct-total]')).toHaveAttribute('data-direct-total', '286.00'); // 2×137 + 4×3
  // Katalog değişir: sayfa yenilenmez (aynı URL, aynı DOM), fiyatlar / tutarlar / toplam anında; adet ve not aynen
  const marker = await page.evaluate(() => { (window as unknown as { __pk?: number }).__pk = 1; return 1; });
  expect(marker).toBe(1);
  await select.selectOption(t2Id!);
  await expect(gkRow.locator('td[data-price]')).toHaveAttribute('data-price', '125');
  await expect(spRow.locator('td[data-price]')).toHaveAttribute('data-price', '3.25', { timeout: 5000 }); // MTM'de yok → liste fiyatı
  await expect(card.locator('[data-direct-total]')).toHaveAttribute('data-direct-total', '263.00'); // 2×125 + 4×3,25
  await expect(gkRow.locator('input[name=p_qty]')).toHaveValue('2');
  await expect(spRow.locator('input[name=p_qty]')).toHaveValue('4');
  await expect(page.locator('#note')).toHaveValue(`Not ${RUN}`);
  expect(await page.evaluate(() => (window as unknown as { __pk?: number }).__pk)).toBe(1); // yenilenmedi
  expect(page.url()).toContain('/siparisler/yeni?tip=PROFILE_ORDER');
  // Geri ATICO: eski fiyatlar; tekrar MTM ile gönder
  await select.selectOption(t1Id!);
  await expect(card.locator('[data-direct-total]')).toHaveAttribute('data-direct-total', '286.00');
  await select.selectOption(t2Id!);
  await expect(card.locator('[data-direct-total]')).toHaveAttribute('data-direct-total', '263.00');
  await page.locator('.submit-bar').getByRole('button', { name: 'Siparişi gönder' }).click();
  const anyway = page.getByRole('button', { name: 'Yine de gönder' });
  await expect(async () => {
    if (await anyway.isVisible()) await anyway.click();
    await expect(page).toHaveURL(/ok=profile_direct/, { timeout: 2000 });
  }).toPass();
  orderId = new URL(page.url()).pathname.split('/').pop()!;
  const db = await prisma();
  try {
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { profile: true, offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } }, price: true, notes: true } });
    expect([o.profile!.stage, o.profile!.direct, o.profile!.priceTableName, String(o.price!.amount)]).toEqual(['ONAYLANDI', true, T2, '263']);
    expect(o.offers[0].lines.map((l) => [l.adet, String(l.offerPrice)])).toEqual([[2, '125'], [4, '3.25']]);
    expect(o.notes.map((n) => n.text)).toEqual([`Not ${RUN}`]);
    expect(await db.notificationOutbox.count({ where: { orderId, type: 'FGO_PROFORMA' } })).toBe(0);
    // Katalog fiyatı sonradan değişir: sipariş satırları aynen
    const t2 = await db.profilePriceTable.findUniqueOrThrow({ where: { name: T2 } });
    const gk = await db.profileProduct.findUniqueOrThrow({ where: { code: 'GK15' } });
    await db.profilePriceItem.update({ where: { tableId_productId: { tableId: t2.id, productId: gk.id } }, data: { unitPrice: '100.00' } });
    const again = await db.offer.findUniqueOrThrow({ where: { id: o.offers[0].id }, include: { lines: true } });
    expect(again.lines.map((l) => String(l.offerPrice)).sort()).toEqual(['125', '3.25']);
    await db.profilePriceItem.update({ where: { tableId_productId: { tableId: t2.id, productId: gk.id } }, data: { unitPrice: '125.00' } });
  } finally {
    await db.$disconnect();
  }
  // Sipariş sayfasında seçilen katalogdaki fiyatlar
  await expect(page.locator('body')).toContainText('263,00');
  await page.context().close();
});

test('tek kataloglu diğer müşteri: seçim kutusu yok, başka firmanın kataloğu görünmez; sahte katalog kimliği reddedilir', async ({ browser }) => {
  const page = await as(browser, OTHER, TEAM_PW);
  await page.goto('/siparisler/yeni?tip=PROFILE_ORDER');
  await expect(page.locator('#dogrudan')).toContainText(T1);
  await expect(page.locator('#dg-catalog')).toHaveCount(0);
  const html = await page.content();
  expect(html).not.toContain(T2);
  // Formdaki gizli katalog kimliğini başka firmanın (MTM) kimliğiyle değiştirip gönder → sunucu reddeder, sipariş açılmaz
  const db = await prisma();
  let t2Id = '';
  let before = 0;
  try {
    t2Id = (await db.profilePriceTable.findUniqueOrThrow({ where: { name: T2 } })).id;
    before = await db.order.count({ where: { customer: { name: FIRM2 } } });
  } finally { await db.$disconnect(); }
  const gkRow = page.locator('tr', { has: page.locator('.mono', { hasText: 'GK15' }) }).first();
  await gkRow.locator('input[name=p_qty]').fill('1');
  await page.evaluate((id) => { const el = document.querySelector('input[name=priceTableId]') as HTMLInputElement; el.value = id; }, t2Id);
  await page.locator('.submit-bar').getByRole('button', { name: 'Siparişi gönder' }).click();
  const anyway = page.getByRole('button', { name: 'Yine de gönder' });
  await expect(async () => {
    if (await anyway.isVisible()) await anyway.click();
    await expect(page.getByText('Seçilen fiyat kataloğu firmanıza tanımlı değil')).toBeVisible({ timeout: 2000 });
  }).toPass();
  const db2 = await prisma();
  try { expect(await db2.order.count({ where: { customer: { name: FIRM2 } } })).toBe(before); } finally { await db2.$disconnect(); }
  await page.context().close();
});
