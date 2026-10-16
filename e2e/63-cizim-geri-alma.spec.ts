import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, newOrder } from './helpers';

// 3.90.0–3.90.2 — DWG kararının güvenli geri alınması (karar 285), gerçek sunucuda. İzole test siparişleri (bu dosyanın
// kendi siparişleri); gerçek SMTP yok (e-posta yalnızca giden kuyrukta), FGO / Google çağrısı yok.
//  - "Üretime almayı geri al": kararı veren çizimci (3.90.2) → karar yeniden bekleniyor; eski kayıt "karar geri alındı"
//    olarak geçmişte, dosya yerinde
//  - "Çizim hatalı kararını geri al": müşterinin kırmızı uyarısı kalkar; müşteri satırı görür, gerekçeyi görmez
//  - geri alma bölümü yalnızca çizim yetkisinde (çizimci, yönetici); satış ve müşteri görmez
//  - Romence arayüz
test.describe.configure({ mode: 'serial' });
const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)

async function toDrawing(admin: Page, id: string) {
  await admin.goto(`/siparisler/${id}`);
  await admin.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(admin.getByText('Sipariş çizim ekibine yönlendirildi.')).toBeVisible();
}
async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('Üretime almayı geri al (kararı veren çizimci): gerekçe zorunlu, onay penceresi; karar yeniden bekleniyor; kayıt ve dosya korunur; satış / müşteri bölümü görmez', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Geri al hazır', 'geri-al-hazir.dwg');
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await toDrawing(admin, id);
  const drawer = await as(browser, DRAWER, TEAM_PW);
  await drawer.goto(`/siparisler/${id}`);
  await expect(drawer.locator('#dwg-geri-al')).toHaveCount(0); // karar verilmeden geri alınacak bir şey yok
  await drawer.locator('#dwg-karar').getByRole('button', { name: 'Üretime Hazır' }).click();
  await expect(drawer.locator('.alert-ok', { hasText: 'üretime hazır kabul edildi' })).toBeVisible();

  // Kararı veren çizimci kendi "Üretime Hazır" kararını geri alır (3.90.2)
  const box = drawer.locator('#dwg-geri-al');
  await expect(box).toHaveAttribute('data-dwg-undo', 'READY');
  await expect(box).toHaveAttribute('data-undo-block', '');
  await expect(box.locator('[data-undo-decision]')).toContainText('Üretime Hazır');
  await expect(box.locator('[data-undo-target]')).toContainText('karar yeniden bekleniyor');
  // Yönetici de görür (aynı karar)
  await admin.goto(`/siparisler/${id}`);
  await expect(admin.locator('#dwg-geri-al')).toHaveAttribute('data-dwg-undo', 'READY');
  await box.locator('summary', { hasText: 'Üretime almayı geri al' }).click();
  await expect(box.locator('textarea[name=reason]')).toHaveAttribute('required', '');
  await box.locator('textarea[name=reason]').fill('Yanlış siparişte karar verildi');
  await box.getByRole('button', { name: 'Üretime almayı geri al' }).click();
  await expect(drawer.locator('.alert-ok', { hasText: '“Üretime hazır” kararı geri alındı' })).toBeVisible();
  await expect(drawer.locator('#dwg-geri-al')).toHaveCount(0);
  // Karar yeniden bekleniyor; eski kayıt geçmişte "karar geri alındı" + gerekçe (iç ekip)
  await expect(drawer.locator('#dwg-karar')).toContainText('kararınız bekleniyor');
  const old = drawer.locator('[data-dwg-status="GERI_CEKILDI"]');
  await expect(old).toContainText('karar geri alındı');
  await expect(old.locator('[data-undo-reason]')).toContainText('Yanlış siparişte karar verildi');

  // Satış ve müşteri geri alma bölümünü görmez; müşteri gerekçeyi görmez
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${id}`);
  await expect(sales.locator('#cizim')).toBeVisible();
  await expect(sales.locator('#dwg-geri-al')).toHaveCount(0);
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.locator('#dwg-geri-al')).toHaveCount(0);
  await expect(cust.locator('[data-dwg-status="GERI_CEKILDI"]')).toBeVisible();
  expect(await cust.content()).not.toContain('Yanlış siparişte karar verildi');

  const db = await prisma();
  try {
    const o = await db.order.findUniqueOrThrow({ where: { id }, include: { drawings: { orderBy: { version: 'asc' } }, files: true } });
    expect([o.status, o.drawingTrack, o.drawings.map((d) => [d.version, d.status])]).toEqual(['HAZIRLANIYOR', 'GEREKLI', [[1, 'GERI_CEKILDI'], [2, 'BEKLIYOR']]]);
    expect(o.files.some((f) => f.name === 'geri-al-hazir.dwg')).toBe(true);
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: id, details: { path: ['action'], equals: 'dwg_ready_undo' } } });
    expect((audit.details as { reason?: string }).reason).toBe('Yanlış siparişte karar verildi');
    expect(audit.actorRole).toBe('CIZIM');
  } finally {
    await db.$disconnect();
  }
  for (const p of [cust, admin, drawer, sales]) await p.context().close();
});

test('Çizim hatalı kararını geri al: müşterinin uyarısı kalkar, satır kalır; Romence arayüz', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Geri al hatalı', 'geri-al-hatali.dxf');
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await toDrawing(admin, id);
  const drawer = await as(browser, DRAWER, TEAM_PW);
  await drawer.goto(`/siparisler/${id}`);
  const decide = drawer.locator('#dwg-karar');
  await decide.locator('summary', { hasText: 'Çizim Hatalı' }).click();
  await decide.locator('textarea[name=note]').fill('Katman eksik');
  await decide.getByRole('button', { name: 'Hatalı olarak bildir' }).click();
  await expect(drawer.locator('.alert-ok', { hasText: 'Çizim hatalı olarak işaretlendi ve müşteriye bildirildi.' })).toBeVisible();
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.locator('#cizim-hatali')).toBeVisible();

  // Romence arayüz (çizimci): metinler ve düğme
  await drawer.goto(`/dil?l=ro&next=${encodeURIComponent(`/siparisler/${id}`)}`);
  const box = drawer.locator('#dwg-geri-al');
  await expect(box).toHaveAttribute('data-dwg-undo', 'FAULTY');
  await expect(box.locator('h3')).toHaveText('Anulează decizia');
  await expect(box.locator('[data-undo-decision]')).toContainText('Desen eronat');
  await box.locator('summary', { hasText: 'Anulează decizia „desen eronat”' }).click();
  await box.locator('textarea[name=reason]').fill('Fișierul era corect');
  await box.getByRole('button', { name: 'Anulează decizia „desen eronat”' }).click();
  await expect(drawer.locator('.alert-ok', { hasText: 'Decizia „desen eronat” a fost anulată' })).toBeVisible();
  await drawer.goto(`/dil?l=tr&next=${encodeURIComponent(`/siparisler/${id}`)}`);

  // Müşteri: kırmızı uyarı yok, düzeltme formu yok; hatalı kaydı geçmişte "karar geri alındı"
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.locator('#cizim-hatali')).toHaveCount(0);
  await expect(cust.locator('[data-dwg-status="GERI_CEKILDI"]')).toBeVisible();
  expect(await cust.content()).not.toContain('Fișierul era corect');
  const db = await prisma();
  try {
    expect(await db.notificationOutbox.count({ where: { orderId: id, type: 'ORDER_DWG_FAULTY_UNDONE' } })).toBe(1);
  } finally {
    await db.$disconnect();
  }
  for (const p of [cust, admin, drawer]) await p.context().close();
});
