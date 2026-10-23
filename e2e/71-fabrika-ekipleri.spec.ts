import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, TEAM_PW, as, assignOrderTo, newOrder } from './helpers';

// Fabrika Ekipleri (4.3.19, karar 304) — gerçek sunucuda: yönetici Ayarlar → Fabrika Ekipleri'nde var olan hesaplarla iki ekip
// kurar; aynı çizimci iki aktif ekibe bağlanamaz; pasif ekip seçilemez ve kullanıcı hesabı kapanmaz; sipariş sayfasında
// satışçı değiştirme formu kapalı başlar, bağımsız çizimci formu yoktur; müşteri ekip adını görmez. 70'in kullanıcılarını
// kullanır (A: fiyat-satis, B: ekip-b-satis / ekip-b-cizim).
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test';
const SALES_B = 'ekip-b-satis@e2e.test';
const DRAWER_B = 'ekip-b-cizim@e2e.test';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('yönetici iki fabrika ekibi kurar; çizimci çakışması reddedilir; pasifleştirme hesabı kapatmaz', async ({ browser }) => {
  const db = await prisma();
  const a = await db.user.findUniqueOrThrow({ where: { email: SALES } });
  const b = await db.user.findUniqueOrThrow({ where: { email: SALES_B } });
  const dB = await db.user.findUniqueOrThrow({ where: { email: DRAWER_B } });
  expect(a.defaultDrawerId, 'A ekibinin çizimcisi').toBeTruthy();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/entegrasyonlar/ekipler');
  await expect(admin.locator('[data-settings-tabs]')).toContainText('Fabrika Ekipleri');
  await expect(admin.locator('#ekipler')).toContainText('Henüz fabrika ekibi yok.');
  // A ekibi: var olan satışçı + var olan çizimcisi + var olan fiyat tablosu (bağlantılar değişmez)
  await admin.fill('#ek-name', 'Fabrika A');
  await admin.selectOption('#ek-sales', a.id);
  await admin.selectOption('#ek-drawer', a.defaultDrawerId!);
  if (a.priceTableId) await admin.selectOption('#ek-table', a.priceTableId);
  await admin.getByRole('button', { name: 'Ekibi oluştur' }).click();
  await expect(admin.getByText('Ekip oluşturuldu.')).toBeVisible();
  // B ekibi
  await admin.fill('#ek-name', 'Fabrika B');
  await admin.selectOption('#ek-sales', b.id);
  await admin.selectOption('#ek-drawer', dB.id);
  if (b.priceTableId && b.priceTableId !== a.priceTableId) await admin.selectOption('#ek-table', b.priceTableId);
  await admin.getByRole('button', { name: 'Ekibi oluştur' }).click();
  await expect(admin.getByText('Ekip oluşturuldu.')).toBeVisible();
  await expect(admin.locator('#ekipler tbody tr')).toHaveCount(2);
  const teamB = await db.factoryTeam.findUniqueOrThrow({ where: { salesUserId: b.id } });
  // Çakışma: B'ye A'nın çizimcisi verilemez (sunucu reddeder)
  await admin.goto(`/admin/entegrasyonlar/ekipler?duzenle=${teamB.id}`);
  await expect(admin.locator('#ekip-formu')).toHaveAttribute('data-team-form', 'edit');
  await admin.selectOption('#ek-drawer', a.defaultDrawerId!);
  await admin.getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin.locator('[data-team-error]')).toHaveAttribute('data-team-error', 'DRAWER_IN_TEAM');
  expect((await db.user.findUniqueOrThrow({ where: { id: b.id } })).defaultDrawerId).toBe(dB.id);
  // Pasif: kullanıcı hesabı açık kalır
  await admin.goto('/admin/entegrasyonlar/ekipler');
  await admin.locator(`tr[data-team="${teamB.id}"]`).getByRole('button', { name: 'Pasif yap' }).click();
  await expect(admin.locator(`tr[data-team="${teamB.id}"]`)).toHaveAttribute('data-team-active', '0');
  expect((await db.user.findUniqueOrThrow({ where: { id: b.id } })).isActive).toBe(true);
  // Satış bu ekranı açamaz
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto('/admin/entegrasyonlar/ekipler');
  await expect(sales.locator('#ekipler')).toHaveCount(0);
  await sales.context().close();
  await db.$disconnect();
  await admin.context().close();
});

test('sipariş sayfası: "Sorumlu satışçı · Değiştir" formu kapalı; pasif ekip seçilemez; bağımsız çizimci formu yok; müşteri ekibi görmez', async ({ browser }) => {
  const db = await prisma();
  const b = await db.user.findUniqueOrThrow({ where: { email: SALES_B } });
  // Yönlendirilebilir (teklif gönderilmemiş, çizim yok) A siparişi
  const c0 = await as(browser, CUSTOMER, CUST_PW);
  const orderId = await newOrder(c0, 'Fabrika ekibi kartı', 'fabrika-ekibi.pdf');
  await c0.context().close();
  await assignOrderTo(orderId, SALES);
  const o = { id: orderId };
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${o.id}`);
  await expect(admin.locator('[data-sales-owner]')).toBeVisible();
  await expect(admin.locator('[data-sales-drawer]')).toBeVisible();
  await expect(admin.locator('#sorumlu')).toContainText('Sorumlu satışçı');
  await expect(admin.locator('#sorumlu')).toContainText('Sorumlu çizimci');
  await expect(admin.locator('#sorumlu-satis')).toBeHidden();
  await expect(admin.locator('[data-drawer-assign]')).toHaveCount(0);
  await expect(admin.locator('#cizimci-sec')).toHaveCount(0);
  await admin.locator('[data-sales-change] > summary').click();
  await expect(admin.locator('#sorumlu-satis')).toBeVisible();
  await expect(admin.locator(`#sorumlu-satis option[value="${b.id}"]`)).toHaveCount(0);
  await admin.context().close();
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const html = await (await cust.request.get(`/siparisler/${o.id}`)).text();
  expect(html).not.toContain('Fabrika A');
  expect(html).not.toContain('Sorumlu satışçı');
  await cust.context().close();
  // Ekip tekrar aktif (sonraki koşular için)
  const teamB = await db.factoryTeam.findUniqueOrThrow({ where: { salesUserId: b.id } });
  const admin2 = await as(browser, ADMIN, ADMIN_PW);
  await admin2.goto('/admin/entegrasyonlar/ekipler');
  await admin2.locator(`tr[data-team="${teamB.id}"]`).getByRole('button', { name: 'Aktif yap' }).click();
  await expect(admin2.locator(`tr[data-team="${teamB.id}"]`)).toHaveAttribute('data-team-active', '1');
  await admin2.context().close();
  await db.$disconnect();
});
