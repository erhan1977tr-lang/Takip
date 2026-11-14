import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, as } from './helpers';

// DÜZELTME 10 M2 + M6 (3.97.x, karar 293) gerçek sunucuda:
//  - açılış bakiyesi: tedarikçi hesabında ayrı satır; sipariş borcuna eklenmez, kalanı değiştirir; iptal edilen kayıt bakiyeden çıkar
//  - nakliye (3.97.6: yalnızca tedarikçi siparişinin sayfasında "Transport ekle"; ayrı Nakliye Giderleri ekranı yok;
//    4.2.19, karar 319: siparişin ürünleri listelenir, her ürüne ayrı tutar; fatura tutarı = toplam): RON fatura + girilen kur
//    → EUR, ürün payı o ürünün net teslim alınan ADEDİNE dağıtılır (toplam kuruşu kuruşuna); tedarikçinin borcuna eklenmez,
//    taşıyıcı bakiyeleri Tedarikçi Hesapları ekranında gösterilmez; stok miktarı değişmez
// Tedarikçi siparişi ve mal kabulü test sürecinde servislerle hazırlanır (işçi çalıştırılmaz → e-posta yok).
test.describe.configure({ mode: 'serial' });

const SUP = 'E2E Nakliye Tedarik';
const CARRIER = 'E2E Taşıyıcı SRL';
let supplierId = '';
let orderId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const level = async (db: Awaited<ReturnType<typeof prisma>>, code: string) => {
  const p = await db.profileProduct.findUniqueOrThrow({ where: { code } });
  return Number((await db.stockMovement.aggregate({ where: { productId: p.id }, _sum: { qty: true } }))._sum.qty ?? 0);
};

test('hazırlık: tedarikçi, onaylı sipariş ve mal kabulü (MC12 × 3, MC16 × 7)', async () => {
  const db = await prisma();
  try {
    const svc = await import('../server/suppliers/service.js');
    const { receiveGoods } = await import('../server/suppliers/receipt.js');
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const actor = { id: admin.id, role: admin.appRole, ip: '127.0.0.1' };
    const tz = { timeZone: 'Europe/Bucharest' };
    const today = new Intl.DateTimeFormat('en-CA', tz).format(new Date());
    const s = await svc.saveSupplier(db, { name: SUP, emails: [{ email: 'siparis@e2e-nakliye.test', isPrimary: true }], currency: 'EUR' }, actor);
    expect(s.ok).toBe(true);
    supplierId = (s as { id: string }).id;
    const c = await svc.createDraftOrder(db, { supplierId }, actor, tz);
    orderId = (c as { id: string }).id;
    const ids = await Promise.all(['MC12', 'MC16'].map(async (code) => (await db.profileProduct.findUniqueOrThrow({ where: { code } })).id));
    let o = await db.supplierOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect((await svc.saveDraft(db, { orderId, version: o.version, orderDate: today, note: '', lines: [{ productId: ids[0], qty: 3, unitPrice: '2' }, { productId: ids[1], qty: 7, unitPrice: '3' }] }, actor, tz)).ok).toBe(true);
    for (const code of ['MC12', 'MC16']) await db.profileProduct.updateMany({ where: { code, supplierCode: null }, data: { supplierCode: `TED-${code}` } });
    o = await db.supplierOrder.findUniqueOrThrow({ where: { id: orderId } });
    expect((await svc.approveAndSend(db, { orderId, version: o.version }, actor)).ok).toBe(true);
    const rev = await db.supplierOrderRevision.findFirstOrThrow({ where: { orderId, finalizedAt: { not: null } }, include: { lines: true } });
    const q = Object.fromEntries(rev.lines.map((l) => [l.id, l.qty]));
    const r = await receiveGoods(db, { orderId, receivedOn: today, requestKey: `e2e-nakliye-${Date.now()}`, quantities: q }, actor, tz);
    expect(r.ok).toBe(true);
    // İşçi çalıştırılmaz: kuyruktaki e-posta işleri bu testte gönderilmez
  } finally {
    await db.$disconnect();
  }
});

test('açılış bakiyesi: ayrı satır, kalanı değiştirir, sipariş borcu değişmez; iptal bakiyeden çıkarır', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/admin/muhasebe/tedarikciler?t=${supplierId}`);
  await admin.locator('#op-amount').fill('100');
  await admin.locator('#op-note').fill('2025 devir');
  await admin.getByRole('button', { name: 'Açılış kaydını ekle' }).click();
  await expect(admin.getByText('Açılış bakiyesi kaydedildi.')).toBeVisible();
  const eur = admin.locator('tr', { has: admin.locator('td b', { hasText: 'EUR' }) }).first();
  await expect(eur.locator('[data-opening]')).toContainText('100');
  await expect(eur).toContainText('27'); // sipariş borcu 3×2 + 7×3 = 27,00 (açılış eklenmez)
  await expect(eur).toContainText('127'); // kalan = açılış + borç
  const row = admin.locator('[data-opening-row="100"]');
  await row.locator('input[name="reason"]').fill('yanlış tutar');
  await row.locator('button[type="submit"]').click();
  await expect(admin.getByText('Açılış kaydı iptal edildi.')).toBeVisible();
  await admin.context().close();
});

test('nakliye: ürün başına tutar, RON + kur → EUR, adete göre dağıtım (toplam tam), taşıyıcı bölümü yok, stok değişmez', async ({ browser }) => {
  const db = await prisma();
  try {
    const stock = [await level(db, 'MC12'), await level(db, 'MC16')];
    const admin = await as(browser, ADMIN, ADMIN_PW);
    // Ayrı ekran ve menü yok
    await admin.goto('/siparisler/tedarik');
    await expect(admin.locator('.sidebar').getByRole('link', { name: 'Nakliye Giderleri' })).toHaveCount(0);
    await expect(admin.locator('.sidebar').getByRole('link', { name: 'Cam Fabrika Hesap Durumu' })).toBeVisible();
    expect((await admin.request.get('/admin/muhasebe/nakliye')).status()).toBe(404);
    await admin.goto(`/siparisler/tedarik/${orderId}`);
    const card = admin.locator('#transport');
    await card.locator('summary', { hasText: 'Transport ekle' }).click();
    await card.locator('#tr-carrier').fill(CARRIER);
    await card.locator('#tr-no').fill('NK-E2E-1');
    await card.locator('#tr-cur').selectOption('RON');
    await card.locator('#tr-fx').fill('5');
    // Siparişin ürünleri listelenir; mal kabulü seçimi ve tek tutar alanı yok
    await expect(card.locator('[data-transport-line]')).toHaveCount(2);
    await expect(card.locator('#tr-amount')).toHaveCount(0);
    await card.locator('[data-transport-line="MC12"] input[data-tr-amount]').fill('30');
    await card.locator('[data-transport-line="MC16"] input[data-tr-amount]').fill('70');
    await expect(card.locator('[data-transport-total]')).toHaveAttribute('data-transport-total', '100.00');
    await expect(card.locator('[data-transport-total]')).toContainText('RON');
    await card.getByRole('button', { name: 'Kaydet ve dağıt' }).click();
    await expect(admin.getByText('Nakliye kaydedildi ve dağıtıldı.')).toBeVisible();
    const listed = admin.locator('#transport [data-transport="NK-E2E-1"]');
    await expect(listed).toContainText('100');
    await expect(listed.locator('[data-eur]')).toContainText('20');
    await expect(listed.locator('[data-transport-product="MC12"]')).toContainText('6');
    await expect(listed.locator('[data-transport-product="MC16"]')).toContainText('14');
    const tc = await db.transportCost.findFirstOrThrow({ where: { carrierName: CARRIER }, include: { allocations: { include: { product: true } } } });
    const by = Object.fromEntries(tc.allocations.map((a) => [a.product.code, [a.qty, Number(a.amountEur)]]));
    // 100 RON / 5 = 20 EUR; MC12 30 RON → 6 EUR (3 adet → 2 / adet), MC16 70 RON → 14 EUR (7 adet → 2 / adet)
    expect(by).toEqual({ MC12: [3, 6], MC16: [7, 14] });
    expect(tc.allocations.reduce((s, a) => s + Number(a.amountEur), 0)).toBe(20);
    expect([await level(db, 'MC12'), await level(db, 'MC16')]).toEqual(stock);
    // Taşıyıcı bakiyeleri Tedarikçi Hesapları ekranında gösterilmez; tedarikçi hesabına taşıyıcı borcu eklenmez
    await admin.goto('/admin/muhasebe/tedarikciler');
    await expect(admin.locator('#tasiyicilar')).toHaveCount(0);
    await expect(admin.locator('main')).not.toContainText(CARRIER);
    await admin.goto(`/admin/muhasebe/tedarikciler?t=${supplierId}`);
    await expect(admin.locator('main')).not.toContainText(CARRIER);
    await admin.context().close();
  } finally {
    await db.$disconnect();
  }
});

test('siparişten fazla mal kabulü (4.2.19, karar 318): fazla adet stoğa girer, ekranda gösterilir; tedarikçi borcu güncel adetle', async ({ browser }) => {
  const db = await prisma();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  try {
    const svc = await import('../server/suppliers/service.js');
    const user = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const actor = { id: user.id, role: user.appRole, ip: '127.0.0.1' };
    const tz = { timeZone: 'Europe/Bucharest' };
    const today = new Intl.DateTimeFormat('en-CA', tz).format(new Date());
    const c = await svc.createDraftOrder(db, { supplierId }, actor, tz);
    const id = (c as { id: string }).id;
    const ids = await Promise.all(['MC12', 'MC16'].map(async (code) => (await db.profileProduct.findUniqueOrThrow({ where: { code } })).id));
    let o = await db.supplierOrder.findUniqueOrThrow({ where: { id } });
    expect((await svc.saveDraft(db, { orderId: id, version: o.version, orderDate: today, note: '', lines: [{ productId: ids[0], qty: 2, unitPrice: '2' }, { productId: ids[1], qty: 5, unitPrice: '3' }] }, actor, tz)).ok).toBe(true);
    o = await db.supplierOrder.findUniqueOrThrow({ where: { id } });
    expect((await svc.approveAndSend(db, { orderId: id, version: o.version }, actor)).ok).toBe(true);
    const before = await level(db, 'MC12');
    await admin.goto(`/siparisler/tedarik/${id}`);
    const box = admin.locator('#mal-kabul');
    await box.locator('tr[data-receipt-line="MC12"] input[type="number"]').fill('5');
    await box.locator('tr[data-receipt-line="MC16"] input[type="number"]').fill('1');
    await box.getByRole('button', { name: 'Mal kabulünü kaydet' }).click();
    await expect(admin).toHaveURL(/ok=receivedPart/);
    await expect(admin.locator('#mal-kabul tr[data-receipt-line="MC12"] [data-over="3"]')).toBeVisible();
    expect(await level(db, 'MC12')).toBe(before + 5);
    // Borç: MC12 5 × 2 + MC16 5 × 3 = 25 (sipariş tutarı 19; fazla 3 × 2 = 6)
    await admin.goto(`/admin/muhasebe/tedarikciler?t=${supplierId}`);
    const row = admin.locator('tr', { has: admin.locator(`a[href="/siparisler/tedarik/${id}"]`) });
    await expect(row.locator('[data-over-debt="3"]')).toContainText('19');
    await expect(row).toContainText('25');
  } finally {
    await db.$disconnect();
    await admin.context().close();
  }
});
