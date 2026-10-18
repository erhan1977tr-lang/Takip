import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, INSPECTOR_PW, as } from './helpers';

// DÜZELTME 10 M8 — profil iadesi (3.99.x, karar 296) gerçek sunucuda:
//  - yönetici teslim edilmiş profil siparişinde kısmi iade açar; iade açılınca stok DEĞİŞMEZ
//  - depo, tek kullanımlık bağlantıyla (giriş yok) teslimi onaylar: sağlam → stok (IADE), hasarlı → bloke stok
//  - bağlantı ikinci kez kullanılamaz; iade edilen miktar ikinci kez iade edilemez (kalan azalır)
//  - müşteri ve denetimci iade kartını / formunu görmez; FGO'ya hiçbir belge gitmez ("doğrulama bekliyor" notu)
// FGO bu veritabanında KAPALIDIR; işçi çalıştırılmaz (e-posta yok) — depo bağlantısının özeti doğrudan yazılır.
test.describe.configure({ mode: 'serial' });

const INSPECTOR = 'denetim@e2e.test';
let orderId = '';
let returnId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const level = async (db: import('@prisma/client').PrismaClient, code: string) => {
  const p = await db.profileProduct.findUniqueOrThrow({ where: { code } });
  const a = await db.stockMovement.aggregate({ where: { productId: p.id }, _sum: { qty: true } });
  return Number(a._sum.qty ?? 0);
};
const blocked = async (db: import('@prisma/client').PrismaClient, code: string) => {
  const p = await db.profileProduct.findUniqueOrThrow({ where: { code } });
  const a = await db.blockedStockMovement.aggregate({ where: { productId: p.id }, _sum: { qty: true } });
  return Number(a._sum.qty ?? 0);
};

test('veri: Ünsal\'ın profil siparişi teslim edildi (gerçek servislerle)', async () => {
  const db = await prisma();
  try {
    const { createProfileOrder } = await import('../server/profile/create.js');
    const { profileOrderItems } = await import('../server/profile/rules.js');
    const { runProfileAction } = await import('../server/profile/transitions.js');
    const { earliestPickup } = await import('../server/profile/dates.js');
    const { suggestNextNo } = await import('../server/orders/create.js');
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
    const act = (u: { id: string; appRole: string; canApprove: boolean; customerId: string | null }) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
    const products = await db.profileProduct.findMany({ where: { code: 'AD45' }, include: { category: true } });
    const items = profileOrderItems([{ productId: products[0].id, qty: 3 }], products);
    if (!items.ok) throw new Error(`kalemler: ${items.code}`);
    const next = await suggestNextNo(db, cust.customerId!, 'PROFILE_ORDER');
    const created = await createProfileOrder(db, { actor: act(cust), firm: { id: cust.customer!.id, prefix: cust.customer!.prefix! }, title: 'İade paketi', requestedNo: next, suggestedNo: next, items: items.items });
    orderId = created.id;
    const offer = await db.offer.findFirstOrThrow({ where: { orderId }, include: { lines: true } });
    await runProfileAction(db, { orderId, action: 'send_profile_offer', actor: act(admin), payload: { lines: offer.lines.map((l) => ({ id: l.id, offerPrice: '10' })) } });
    const sent = await db.offer.findFirstOrThrow({ where: { orderId, status: 'GONDERILDI' } });
    await runProfileAction(db, { orderId, action: 'approve_profile_offer', actor: act(cust), payload: { offerId: sent.id, pickupDate: earliestPickup({ now: new Date(Date.now() + 5 * 60_000) }), phone: '0723000000', plate: 'B 67 IAD' } });
    await runProfileAction(db, { orderId, action: 'mark_proforma', actor: act(admin), payload: { proformaNo: 'PF-IADE' } });
    await runProfileAction(db, { orderId, action: 'send_to_warehouse', actor: act(admin), payload: {} });
    await runProfileAction(db, { orderId, action: 'mark_delivered', actor: act(admin), payload: {} });
    expect((await db.profileOrder.findUniqueOrThrow({ where: { orderId } })).stage).toBe('TESLIM_EDILDI');
  } finally {
    await db.$disconnect();
  }
});

test('müşteri ve denetimci iade kartını görmez', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/siparisler/${orderId}`);
  await expect(cust.locator('#iade')).toHaveCount(0);
  await cust.context().close();
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(`/siparisler/${orderId}`);
  await expect(insp.locator('#iade')).toHaveCount(0);
  await insp.context().close();
});

test('yönetici kısmi iade açar: stok değişmez; FGO belgesi kesilmez', async ({ browser }) => {
  const db = await prisma();
  try {
    const before = await level(db, 'AD45');
    const admin = await as(browser, ADMIN, ADMIN_PW);
    await admin.goto(`/siparisler/${orderId}`);
    const card = admin.locator('#iade');
    await expect(card.locator('[data-no-returns]')).toBeVisible();
    await card.locator('[data-return-new] summary').click();
    const row = card.locator('[data-returnable="AD45"]');
    await expect(row.locator('td').nth(1)).toHaveText('3');
    await expect(row.locator('td').nth(3)).toHaveText('3');
    await row.locator('input.qty-input').fill('2');
    await card.locator('#ret-reason').fill('Müşteri fazla sipariş verdi');
    await card.getByRole('button', { name: 'İadeyi aç' }).click();
    await expect(admin).toHaveURL(/rok=opened/);
    await expect(card.locator('[data-return="1"]')).toHaveAttribute('data-return-status', 'ACIK');
    await expect(card.locator('[data-return="1"] [data-fgo-pending]')).toBeVisible();
    expect(await level(db, 'AD45')).toBe(before);
    expect(await db.fgoDocument.count({ where: { orderId } })).toBe(0);
    // Kalan: 3 − 2 = 1 (aynı mal iki kez iade edilemez)
    await card.locator('[data-return-new] summary').click();
    await expect(card.locator('[data-returnable="AD45"] td').nth(2)).toHaveText('2');
    await expect(card.locator('[data-returnable="AD45"] td').nth(3)).toHaveText('1');
    const r = await db.profileReturn.findFirstOrThrow({ where: { orderId } });
    returnId = r.id;
    await admin.context().close();
  } finally {
    await db.$disconnect();
  }
});

test('depo bağlantısı: sağlam stoğa, hasarlı bloke stoğa; bağlantı bir kez kullanılır', async ({ browser }) => {
  const db = await prisma();
  try {
    const { hashToken } = await import('../server/profile/warehouse.js');
    const token = crypto.randomBytes(32).toString('base64url');
    await db.profileReturn.update({ where: { id: returnId }, data: { depotTokenHash: hashToken(token), depotTokenExpiresAt: new Date(Date.now() + 7 * 86_400_000) } });
    const [stock0, blocked0] = [await level(db, 'AD45'), await blocked(db, 'AD45')];
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept());
    await page.goto(`/depo-iade/${token}`);
    const line = page.locator('form label', { hasText: 'Hasarlı' }).locator('input');
    await line.fill('1');
    await page.locator('form label', { hasText: 'Sağlam' }).locator('input').fill('1');
    await page.getByRole('button', { name: 'Teslimi onayla' }).click();
    await expect(page.locator('[data-return-done]')).toBeVisible();
    expect(await level(db, 'AD45')).toBe(stock0 + 1);
    expect(await blocked(db, 'AD45')).toBe(blocked0 + 1);
    const r = await db.profileReturn.findUniqueOrThrow({ where: { id: returnId } });
    expect([r.status, r.receivedVia, r.depotTokenHash]).toEqual(['TESLIM_ALINDI', 'DEPOT_LINK', null]);
    // Bağlantı kapandı: ikinci kullanım geçersiz, stok yine değişmez
    await page.goto(`/depo-iade/${token}`);
    await expect(page.locator('.alert-error')).toBeVisible();
    expect(await level(db, 'AD45')).toBe(stock0 + 1);
    await ctx.close();
    // Yönetici ekranı: teslim alındı, sağlam / hasarlı ayrı
    const admin = await as(browser, ADMIN, ADMIN_PW);
    await admin.goto(`/siparisler/${orderId}`);
    const item = admin.locator('#iade [data-return="1"]');
    await expect(item).toHaveAttribute('data-return-status', 'TESLIM_ALINDI');
    await expect(item.locator('[data-good]')).toHaveText('1');
    await expect(item.locator('[data-damaged]')).toHaveText('1');
    await admin.context().close();
  } finally {
    await db.$disconnect();
  }
});
