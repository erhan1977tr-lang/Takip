import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, INSPECTOR_PW, as } from './helpers';

const INSPECTOR = 'denetim@e2e.test'; // 05'te açıldı

// Profil siparişi silme (3.86.0, karar 281) — gerçek sunucuda: yönetici onay penceresinde sipariş numarasını, stoğa geri
// eklenecek miktarı (stoktan düşülmemiş sipariş: "stok değişmez") ve FGO doğrulaması notunu görür. E2E veritabanında FGO
// KAPALIDIR (açılmaz): silme sunucuda FGO doğrulanamadığı için reddedilir, sipariş ve stok değişmez, deneme denetime
// yazılır. Müşteri ve denetimci silme düğmesini görmez. FGO'ya hiçbir istek gitmez (FGO kapalı → ağ çağrısı yok).
test.describe.configure({ mode: 'serial' });

test('profil siparişi: onay penceresi iade / FGO bilgisini gösterir; FGO doğrulanamazsa silinmez', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto('/siparisler/yeni?tip=PROFILE_ORDER');
  await cust.locator('tr', { hasText: 'AD45' }).locator('input.qty-input').fill('1');
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  const warn = cust.locator('#stok-uyari').getByRole('button', { name: 'Yine de gönder' });
  if (await warn.isVisible().catch(() => false)) await warn.click();
  else await warn.click({ timeout: 5000 }).catch(() => {});
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=profile_(created|direct)/);
  const id = new URL(cust.url()).pathname.split('/').pop()!;
  await expect(cust.locator('#sil')).toHaveCount(0); // müşteri silemez
  await cust.context().close();

  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const order = await db.order.findUniqueOrThrow({ where: { id } });
    const no = order.orderNo;
    const inspector = await as(browser, INSPECTOR, INSPECTOR_PW);
    await inspector.goto(`/siparisler/${id}`);
    await expect(inspector.locator('#sil')).toHaveCount(0); // denetimci silemez
    await inspector.context().close();

    const admin = await as(browser, ADMIN, ADMIN_PW);
    await admin.goto(`/siparisler/${id}`);
    const box = admin.locator('#sil');
    await box.getByRole('button', { name: 'Siparişi sil' }).click();
    const step1 = box.locator('[data-remove-step="1"]');
    await expect(step1).toContainText(`Silinecek sipariş: ${no}`);
    const stock = step1.locator('[data-remove-stock]');
    await expect(stock).toContainText('Stoğa geri eklenecek profil miktarları');
    await expect(stock.locator('[data-stock-none]')).toContainText('stoktan düşülmüş miktar yok');
    await expect(stock.locator('[data-fgo-note]')).toContainText('FGO canlı olarak doğrulanır');
    await box.getByRole('button', { name: 'Devam et' }).click();
    const step2 = box.locator('[data-remove-step="2"]');
    await step2.getByLabel(`Silmeyi onaylamak için sipariş numarasını yazın: ${no}`).fill(no);
    const moves = await db.stockMovement.count();
    await step2.locator('button.btn-danger-solid').click();
    await expect(box.locator('.alert-error')).toContainText('FGO doğrulanamadı');
    const after = await db.order.findUniqueOrThrow({ where: { id } });
    expect(after.removedAt).toBeNull();
    expect(after.status).toBe(order.status);
    expect(await db.stockMovement.count()).toBe(moves);
    const blocked = await db.auditLog.findFirst({ where: { entityId: id, action: 'ORDER_REMOVE_BLOCKED' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(blocked?.details)).toContain('FGO_UNVERIFIED');
    await admin.context().close();
  } finally {
    await db.$disconnect();
  }
});
