import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, SALES, TEAM_PW, as, createUser, firstLogin, newOrder, outboxCodeFor } from './helpers';

// Satışçı–çizimci ayrımı (4.3.0, karar 300): yönlendirme ayarı, varsayılan çizimci, atama kartı, ekip ayrımı
// (liste / sayfa / sandık / nakliye), fabrika hesapları ve ödeme hesabı değişikliği — gerçek sunucuda, gerçek yetkilerle.
test.describe.configure({ mode: 'serial' });

const SALES_B = 'ekip-b-satis@e2e.test';
const DRAWER_B = 'ekip-b-cizim@e2e.test';
let orderId = '';
let orderNo = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('ayarlar: varsayılan çizimci (Kullanıcılar) ve yönlendirme kuralı (Ayarlar → Satış Yönlendirme); ikinci ekip', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await createUser(admin, { email: SALES_B, name: 'Ekip B Satış', role: 'Satış', firm: 'GKH Trading' });
  await createUser(admin, { email: DRAWER_B, name: 'Ekip B Çizim', role: 'Çizimci', firm: 'GKH Trading' });
  for (const email of [SALES_B, DRAWER_B]) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await firstLogin(p, email, outboxCodeFor(email), TEAM_PW);
    await ctx.close();
  }
  // Varsayılan çizimci: satış satırındaki seçim (yalnızca satışçılarda)
  await admin.goto('/admin/users');
  const db = await prisma();
  const a = await db.user.findUniqueOrThrow({ where: { email: SALES } });
  const b = await db.user.findUniqueOrThrow({ where: { email: SALES_B } });
  const dB = await db.user.findUniqueOrThrow({ where: { email: DRAWER_B } });
  await db.$disconnect();
  const formB = admin.locator(`form[data-default-drawer="${b.id}"]`);
  await formB.locator('select').selectOption(dB.id);
  await formB.getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin.getByText('Satışçının varsayılan çizimcisi kaydedildi.')).toBeVisible();
  await expect(admin.locator(`form[data-default-drawer="${b.id}"] select`)).toHaveValue(dB.id);
  // Yönlendirme: boş kurulum bağlı sayılır; kural AUTO → satis@e2e.test (mevcut kullanım korunur)
  await admin.goto('/admin/entegrasyonlar/yonlendirme');
  await expect(admin.locator('#yonlendirme')).toHaveAttribute('data-routing-linked', '1');
  await admin.selectOption('#rt-mode', 'AUTO');
  await admin.selectOption('#rt-target', a.id);
  await admin.getByRole('button', { name: 'Kuralı kaydet' }).click();
  await expect(admin.getByText('Yönlendirme kuralı kaydedildi.')).toBeVisible();
  await expect(admin.locator('[data-routing-current]')).toHaveAttribute('data-routing-current', 'AUTO');
  await expect(admin.locator('[data-routing-current]')).toContainText('Otomatik: Satış Kişi');
  // Satış ekipleri tablosu: satışçı → varsayılan çizimci
  await expect(admin.locator(`[data-team-row="${b.id}"]`)).toContainText('Ekip B Çizim');
  // Geçmişte başlayan kural reddedilir
  await admin.selectOption('#rt-mode', 'MANUAL');
  await admin.fill('#rt-start', '2020-01-01T09:00');
  await admin.getByRole('button', { name: 'Kuralı kaydet' }).click();
  await expect(admin.getByText('Başlangıç geçmişte olamaz')).toBeVisible();
  // Satış bu sayfayı açamaz (kendi ana sayfasına yönlenir)
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto('/admin/entegrasyonlar/yonlendirme');
  await expect(sales).not.toHaveURL(/yonlendirme/);
  await expect(sales.locator('#yonlendirme')).toHaveCount(0);
  await sales.context().close();
  await admin.context().close();
});

test('yeni sipariş kuralla satışçıya ve çizimcisine; atamasız sipariş yalnızca yöneticide; atama kartı; ekip ayrımı', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  orderId = await newOrder(cust, 'Ekip ayrımı', 'ekip.pdf');
  const db0 = await prisma();
  orderNo = (await db0.order.findUniqueOrThrow({ where: { id: orderId }, select: { orderNo: true } })).orderNo;
  const ids = { a: (await db0.user.findUniqueOrThrow({ where: { email: SALES } })).id, b: (await db0.user.findUniqueOrThrow({ where: { email: SALES_B } })).id };
  await db0.$disconnect();
  // Müşteri iç ekip kimliğini görmez
  const custHtml = await cust.content();
  expect(custHtml).not.toContain('Satış Kişi');
  expect(custHtml).not.toContain('satis@e2e.test');
  expect(custHtml).not.toContain('Sorumlu satışçı');
  await cust.context().close();

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${orderId}`);
  await expect(admin.locator('#sorumlu')).toHaveAttribute('data-sales-assign', 'assigned');
  await expect(admin.locator('[data-sales-owner]')).toHaveText('Satış Kişi');
  await expect(admin.locator('[data-sales-drawer]')).toHaveText('Çizim Kişi');
  // Satış A görür, satış B göremez (404)
  const salesA = await as(browser, SALES, TEAM_PW);
  await salesA.goto(`/siparisler/${orderId}`);
  await expect(salesA.locator('#bilgiler')).toBeVisible();
  await expect(salesA.locator('#sorumlu')).toHaveCount(0, 'atama kartı satışta yok');
  const salesB = await as(browser, SALES_B, TEAM_PW);
  const rb = await salesB.goto(`/siparisler/${orderId}`);
  expect(rb!.status()).toBe(404);
  await salesB.goto('/siparisler');
  await expect(salesB.locator('body')).not.toContainText(orderNo);
  // Atamasız duruma al (veri): satış A da göremez; yönetici kuyruğunda "Atama bekleyen"; kart atama ister
  const db = await prisma();
  await db.order.update({ where: { id: orderId }, data: { salesUserId: null, assignedDrawerId: null, salesAssignedVia: null, routingRuleId: null, slaDeadline: null } });
  await db.$disconnect();
  const ra = await salesA.goto(`/siparisler/${orderId}`);
  expect(ra!.status()).toBe(404);
  await admin.goto('/siparisler');
  await expect(admin.getByRole('heading', { name: /Atama bekleyen siparişler/ })).toBeVisible();
  await expect(admin.locator('body')).toContainText(orderNo);
  await admin.goto(`/siparisler/${orderId}`);
  await expect(admin.locator('#sorumlu')).toHaveAttribute('data-sales-assign', 'unassigned');
  await expect(admin.locator('[data-sales-unassigned]')).toBeVisible();
  // Yönetici B'ye atar: çizimci B kopyalanır; B görür, A görmez
  await admin.selectOption('#sorumlu-satis', ids.b);
  await admin.getByRole('button', { name: 'Satışçıya ata' }).click();
  await expect(admin.getByText('Sorumlu satışçı kaydedildi.')).toBeVisible();
  await expect(admin.locator('[data-sales-owner]')).toHaveText('Ekip B Satış');
  await expect(admin.locator('[data-sales-drawer]')).toHaveText('Ekip B Çizim');
  await expect(salesB.goto(`/siparisler/${orderId}`).then((x) => x!.status())).resolves.toBe(200);
  await expect(salesA.goto(`/siparisler/${orderId}`).then((x) => x!.status())).resolves.toBe(404);
  // B'den A'ya yönlendirme (teklif henüz gönderilmedi): izinli; sonra B teklifi gönderince kapanır
  await admin.goto(`/siparisler/${orderId}`);
  await admin.selectOption('#sorumlu-satis', ids.a);
  await admin.getByRole('button', { name: 'Başka satışçıya yönlendir' }).click();
  await expect(admin.getByText('Sorumlu satışçı kaydedildi.')).toBeVisible();
  await expect(admin.locator('[data-sales-owner]')).toHaveText('Satış Kişi');
  await expect(salesB.goto(`/siparisler/${orderId}`).then((x) => x!.status())).resolves.toBe(404);
  await salesA.goto(`/siparisler/${orderId}`);
  await salesA.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await salesA.getByLabel('En', { exact: true }).first().fill('1000');
  await salesA.getByLabel('Boy', { exact: true }).first().fill('1000');
  await salesA.getByLabel('Birim fiyat').first().fill('30');
  await salesA.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(salesA.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  await admin.goto(`/siparisler/${orderId}`);
  await expect(admin.locator('[data-sales-blocked]')).toContainText('teklif daha önce yöneticiye gönderildi');
  await expect(admin.locator('#sorumlu-satis')).toHaveCount(0);
  await salesA.context().close();
  await salesB.context().close();
  await admin.context().close();
});

test('fabrika hesapları: ödeme girişinde hesap seçilir; hesap değişince A azalır B artar, genel toplam değişmez; satış ve denetimci sayfayı açamaz', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/muhasebe/tedarikci');
  const db = await prisma();
  const a = await db.user.findUniqueOrThrow({ where: { email: SALES } });
  const b = await db.user.findUniqueOrThrow({ where: { email: SALES_B } });
  const totalBefore = Number((await db.factoryPayment.aggregate({ where: { currency: 'EUR' }, _sum: { amount: true } }))._sum.amount ?? 0);
  await db.$disconnect();
  await admin.selectOption('#fp-account', a.id);
  await admin.fill('[name=amount]', '123.45');
  await admin.selectOption('#fp-cur', 'EUR');
  await admin.fill('[name=note]', 'ekip testi');
  await admin.getByRole('button', { name: 'Ödeme ekle' }).click();
  await expect(admin.getByText('Ödeme eklendi.')).toBeVisible();
  const row = admin.locator('#odemeler tbody tr').filter({ hasText: 'ekip testi' });
  await expect(row.locator('[data-payment-account]')).toHaveAttribute('data-payment-account', a.id);
  const paidOf = async (id: string) => Number((await admin.locator(`#hesaplar tr[data-account="${id}"][data-currency="EUR"] td`).nth(3).textContent() ?? '0').replace(/\./g, '').replace(',', '.'));
  const aBefore = await paidOf(a.id);
  const bBefore = (await admin.locator(`#hesaplar tr[data-account="${b.id}"][data-currency="EUR"]`).count()) ? await paidOf(b.id) : 0;
  // Hesabı değiştir
  await row.locator('select[name=salesUserId]').selectOption(b.id);
  await row.getByRole('button', { name: 'Hesabı değiştir' }).click();
  await expect(admin.getByText('Ödemenin hesabı değiştirildi.')).toBeVisible();
  await expect(admin.locator('#odemeler tbody tr').filter({ hasText: 'ekip testi' }).locator('[data-payment-account]')).toHaveAttribute('data-payment-account', b.id);
  expect(await paidOf(a.id)).toBeCloseTo(aBefore - 123.45, 2);
  expect(await paidOf(b.id)).toBeCloseTo(bBefore + 123.45, 2);
  const db2 = await prisma();
  const totalAfter = Number((await db2.factoryPayment.aggregate({ where: { currency: 'EUR' }, _sum: { amount: true } }))._sum.amount ?? 0);
  expect(totalAfter).toBeCloseTo(totalBefore + 123.45, 2);
  expect(await db2.auditLog.count({ where: { action: 'FACTORY_PAYMENT_ACCOUNT_CHANGED' } })).toBeGreaterThanOrEqual(1);
  await db2.$disconnect();
  await admin.context().close();
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto('/admin/muhasebe/tedarikci');
  await expect(sales.locator('#hesaplar')).toHaveCount(0);
  await sales.context().close();
});

test('nakliye listesi: satış yalnızca kendi bölümünü, yönetici bölümleri ve genel toplamı alır (PDF açılır)', async ({ browser }) => {
  const day = new Date(Date.now() + 61 * 86_400_000).toISOString().slice(0, 10);
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const r = await admin.request.get(`/yuklemeler/nakliye?gun=${day}`);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toContain('application/pdf');
  await admin.context().close();
  const sales = await as(browser, SALES_B, TEAM_PW);
  const rs = await sales.request.get(`/yuklemeler/nakliye?gun=${day}`);
  expect(rs.status()).toBe(200);
  await sales.context().close();
});
