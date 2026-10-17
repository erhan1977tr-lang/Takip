import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, as } from './helpers';

// DÜZELTME 10 M2 + M6 (3.97.x, karar 293) gerçek sunucuda:
//  - açılış bakiyesi: tedarikçi hesabında ayrı satır; sipariş borcuna eklenmez, kalanı değiştirir; iptal edilen kayıt bakiyeden çıkar
//  - nakliye: RON fatura + girilen kur → EUR; seçilen mal kabulüne gerçek teslim alınan ADETE göre dağıtılır (toplam kuruşu kuruşuna),
//    taşıyıcının borcu ayrı izlenir, tedarikçinin borcuna eklenmez; stok miktarı değişmez
// Tedarikçi siparişi ve mal kabulü test sürecinde servislerle hazırlanır (işçi çalıştırılmaz → e-posta yok).
test.describe.configure({ mode: 'serial' });

const SUP = 'E2E Nakliye Tedarik';
const CARRIER = 'E2E Taşıyıcı SRL';
let supplierId = '';
let receiptLabel = '';

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
    const orderId = (c as { id: string }).id;
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
    receiptLabel = `${o.orderNo}-${(r as { seq: number }).seq}`;
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

test('nakliye: RON + kur → EUR, adete göre dağıtım (toplam tam), taşıyıcı borcu ayrı, stok değişmez', async ({ browser }) => {
  const db = await prisma();
  try {
    const stock = [await level(db, 'MC12'), await level(db, 'MC16')];
    const admin = await as(browser, ADMIN, ADMIN_PW);
    await admin.goto('/admin/muhasebe/nakliye');
    const form = admin.locator('#yeni');
    await form.locator('#tr-carrier').fill(CARRIER);
    await form.locator('#tr-no').fill('NK-E2E-1');
    await form.locator('#tr-amount').fill('100');
    await form.locator('#tr-cur').selectOption('RON');
    await form.locator('#tr-fx').fill('5');
    await form.locator(`[data-receipt-option="${receiptLabel}"] input[type="checkbox"]`).check();
    await form.getByRole('button', { name: 'Kaydet ve dağıt' }).click();
    await expect(admin.getByText('Nakliye kaydedildi ve dağıtıldı.')).toBeVisible();
    await expect(admin.locator(`[data-carrier="${CARRIER}"]`)).toContainText('100');
    const tc = await db.transportCost.findFirstOrThrow({ where: { carrierName: CARRIER }, include: { allocations: { include: { product: true } } } });
    const by = Object.fromEntries(tc.allocations.map((a) => [a.product.code, [a.qty, Number(a.amountEur)]]));
    // 100 RON / 5 = 20 EUR; 10 adet → adet başına 2 EUR: MC12 3 adet = 6, MC16 7 adet = 14
    expect(by).toEqual({ MC12: [3, 6], MC16: [7, 14] });
    expect(tc.allocations.reduce((s, a) => s + Number(a.amountEur), 0)).toBe(20);
    expect([await level(db, 'MC12'), await level(db, 'MC16')]).toEqual(stock);
    // Tedarikçi hesabına taşıyıcı borcu eklenmez
    await admin.goto(`/admin/muhasebe/tedarikciler?t=${supplierId}`);
    await expect(admin.locator('main')).not.toContainText(CARRIER);
    await admin.context().close();
  } finally {
    await db.$disconnect();
  }
});
