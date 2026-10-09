import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, TEAM_PW, as } from './helpers';

// Paket 10 (kararlar 206–210) — sipariş finansı ekranı.
//  - yönetici: "Ödemeler ve avans" kartında FGO tahsilatı ve elle kayıtlar ayrı rozetlerle; elle ödeme kaydı (belge kesmez),
//    aynı müşteride aynı tutar → eşleşmeler + zorunlu onay kutusu, onaylanan risk "Önemli kararlar"da; geçersiz kılma gerekçeyle
//  - sonucu belirsiz FGO işi: Finans / FGO kartında uyarı, #belirsiz kutusunda karar (FGO kapalıyken "kaydet" FGO'ya gitmez;
//    "vazgeç" açık onayla)
//  - satış ve müşteri: kart yok, tutar yok, ödeme geçmişi yok; taklit form gönderimi kaydı değiştirmez
//  - mobilde (390 px) sayfa yana taşmaz
// FGO bu veritabanında KAPALIDIR ve kapalı kalır: hiçbir belge kesilmez, FGO'ya istek gitmez.
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)
const TITLE = `Finans e2e ${Date.now().toString(36)}`;
let orderId = '';
let orderNo = '';
let jobId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
async function actionField(page: Page, url: string, marker: string): Promise<string> {
  const html = await (await page.request.get(url)).text();
  const form = html.split('<form').find((chunk) => chunk.includes(marker));
  const m = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form) : null;
  expect(m, `sunucu işlemi alanı bulunamadı (${url}, ${marker})`).toBeTruthy();
  return m![0];
}
async function forge(page: Page, url: string, field: string, data: Record<string, string>) {
  const origin = new URL(page.url()).origin;
  return page.request.post(url, { multipart: { [field]: '', ...data }, headers: { origin } });
}
async function noOverflow(page: Page, what: string) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `${what}: mobilde sayfa yana taşmaz`).toBeLessThanOrEqual(iw + 1);
}

test('veri: müşterinin EUR cam siparişi, FGO proforması (kesilmiş, tahsilat yok) ve proformanın kayıtlı kuru', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const u = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  const last = await db.order.aggregate({ where: { customerId: u.customerId! }, _max: { customerOrderNo: true } });
  const no = Math.max(9400, (last._max.customerOrderNo ?? 0) + 1);
  const o = await db.order.create({
    data: {
      orderNo: `${u.customer!.prefix}${no}`, customerOrderNo: no, title: TITLE, orderTypeCode: 'GLASS_ORDER', customerId: u.customerId!, createdById: admin.id, status: 'URETIMDE',
      estimatedShipDate: new Date(Date.now() + 20 * 86_400_000),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
      price: { create: { amount: '100.00', setById: admin.id } },
    },
  });
  await db.fgoDocument.create({ data: { orderId: o.id, kind: 'PROFORMA', series: 'PRF', number: String(94000 + (no % 1000)), total: '605.00', paid: '0', issuedAt: new Date(), checkedAt: new Date() } });
  await db.glassBilling.create({ data: { orderId: o.id, fxRate: '5.0000', fxDate: new Date(), fxSource: 'BNR' } });
  orderId = o.id;
  orderNo = o.orderNo;
  await db.$disconnect();
});

test('yönetici: FGO ve elle kaynaklar ayrı; elle ödeme kaydı belge kesmez; aynı tutar → eşleşme + açık onay; geçersiz kılma gerekçeyle', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(`/siparisler/${orderId}`);
  const card = page.locator('#odemeler');
  await expect(card.getByRole('heading', { name: 'Ödemeler ve avans' })).toBeVisible();
  await expect(card.locator('[data-fin=fgoPaid]')).toContainText('FGO');
  await expect(card.locator('[data-fin=manual]')).toContainText('Elle');
  await expect(card.locator('[data-fin=total]')).toContainText('100,00 EUR');
  await expect(card.locator('[data-fin=match]')).toHaveAttribute('data-match', 'NONE');
  await expect(card.locator('[data-payments]')).toHaveCount(0);

  // Elle kayıt: 123,45 EUR × 5 (proformanın kuru) = 617,25 RON — FGO'ya / kuyruğa hiçbir şey gitmez. Tutar başka dosyaların
  // belgeleriyle (ör. 500 RON'luk avans faturası) "aynı müşteride aynı tutar" eşleşmesi doğurmasın diye sıra dışı seçildi.
  const form = card.locator('[data-payment-form]');
  await form.locator('#mp-amount').fill('123,45');
  await form.locator('#mp-currency').selectOption('EUR');
  await form.locator('#mp-ref').fill('OP 4401');
  await form.getByRole('button', { name: 'Ödemeyi kaydet' }).click();
  await expect(form.locator('[data-payment-ok]')).toBeVisible();
  await expect(form.locator('#mp-amount')).toHaveValue('');
  const rows = card.locator('[data-payments] tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('123,45 EUR');
  await expect(rows.first()).toContainText('617,25 RON');
  await expect(rows.first()).toContainText('Avans faturası kesilmedi');
  await expect(card.locator('[data-fin=manual]')).toContainText('617,25 RON');
  await expect(card.locator('[data-fin=required]')).toContainText('617,25 RON');
  await expect(card.locator('[data-fin=match]')).toHaveAttribute('data-match', 'MANUAL_ONLY');
  // Finans / FGO kartı: avans düğmesi elle kayda dayanır (FGO kapalı: istek kuyruğa girmez)
  await expect(page.locator('#finans #avans-durumu')).toContainText('617,25');
  await expect(page.locator('#finans').getByRole('button', { name: 'Avans Faturası Gönder' })).toBeVisible();
  const db = await prisma();
  expect(await db.manualPayment.count({ where: { orderId } })).toBe(1);
  expect(await db.notificationOutbox.count({ where: { orderId, type: 'FGO_GLASS' } })).toBe(0);
  expect(await db.auditLog.count({ where: { action: 'MANUAL_PAYMENT_RECORDED', details: { path: ['orderId'], equals: orderId } } })).toBe(1);

  // Aynı tutar yeniden: durur, eşleşme listelenir; kutu işaretlenip yeniden gönderilince kaydedilir
  await form.locator('#mp-amount').fill('123,45');
  await form.getByRole('button', { name: 'Ödemeyi kaydet' }).click();
  await expect(form.locator('[data-duplicate-risk]')).toBeVisible();
  await expect(form.locator('[data-duplicate-lines]')).toContainText('Elle ödeme');
  await expect(form.locator('[data-duplicate-lines]')).toContainText(orderNo);
  expect(await db.manualPayment.count({ where: { orderId } })).toBe(1);
  await form.locator('[data-duplicate-ack]').check();
  await form.getByRole('button', { name: 'Ödemeyi kaydet' }).click();
  await expect(form.locator('[data-payment-ok]')).toBeVisible();
  await expect(rows).toHaveCount(2);
  expect(await db.adminAlert.count({ where: { orderId, type: 'DUPLICATE_RISK' } })).toBe(1);

  // İkinci kayıt geçersiz kılınır (gerekçe zorunlu; satır silinmez, gerekçesiyle görünür)
  const second = rows.nth(1);
  await second.locator('summary').click();
  await second.locator('input[name=reason]').fill('Aynı havale iki kez girildi');
  await second.locator('form').getByRole('button', { name: 'Geçersiz kıl' }).click();
  await expect(page).toHaveURL(/finOk=voided/);
  await expect(card.locator('[data-payments] tbody tr')).toHaveCount(2);
  await expect(card.locator('[data-payments] tbody tr[data-voided="1"]')).toContainText('Aynı havale iki kez girildi');
  await expect(card.locator('[data-fin=manual]')).toContainText('617,25 RON');
  await db.$disconnect();

  // Önemli kararlar: onaylanan aynı tutar riski, siparişin Ödemeler kartına götürür
  await page.goto('/admin/kararlar');
  const alert = page.locator('tr', { has: page.locator('[data-duplicate-alert]') }).filter({ hasText: orderNo });
  await expect(alert).toHaveCount(1);
  await expect(alert.locator('a[data-finance-open]')).toHaveAttribute('href', `/siparisler/${orderId}#odemeler`);

  // Mobil: kart yana taşmaz
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/siparisler/${orderId}`);
  await expect(page.locator('#odemeler')).toBeVisible();
  await noOverflow(page, 'sipariş finansı');
  await page.context().close();
});

test('satış ve müşteri: Ödemeler kartı, tutarlar ve ödeme geçmişi yok; taklit "geçersiz kıl" kaydı değiştirmez', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const voidField = await actionField(admin, `/siparisler/${orderId}`, 'name="paymentId"');
  const db = await prisma();
  const live = await db.manualPayment.findFirstOrThrow({ where: { orderId, voidedAt: null } });
  for (const [who, email, pw] of [['satis', SALES, TEAM_PW], ['musteri', CUSTOMER, CUST_PW]] as const) {
    const p = await as(browser, email, pw);
    await p.goto(`/siparisler/${orderId}`);
    await expect(p.locator('#odemeler'), who).toHaveCount(0);
    await expect(p.locator('body'), who).not.toContainText('Elle kaydedilen');
    await expect(p.locator('body'), who).not.toContainText('OP 4401');
    await forge(p, `/siparisler/${orderId}`, voidField, { orderId, paymentId: live.id, reason: `taklit ${who}` });
    expect((await db.manualPayment.findUniqueOrThrow({ where: { id: live.id } })).voidedAt, `${who}: kayıt değişmedi`).toBeNull();
    await p.context().close();
  }
  expect(await db.manualPayment.count({ where: { orderId } })).toBe(2);
  await db.$disconnect();
  await admin.context().close();
});

test('sonucu belirsiz FGO işi: uyarı ve karar kutusu; FGO kapalıyken "kaydet" FGO\'ya gitmez; "vazgeç" açık onayla işi kapatır', async ({ browser }) => {
  const db = await prisma();
  const job = await db.notificationOutbox.create({
    data: {
      type: 'FGO_GLASS', orderId, status: 'PENDING', attempts: 1, availableAt: new Date('9999-12-31T00:00:00Z'), lastError: '[BELIRSIZ] FGO HTTP 504',
      payload: {
        kind: 'ADVANCE', orderNo, seq: 1, amount: 500, basis: 'MANUAL',
        uncertain: { at: new Date().toISOString(), target: 'GLASS', kind: 'ADVANCE', attempt: 1, error: 'FGO HTTP 504', idExtern: `${orderNo}-A`, series: 'GKH', expectedGross: 500, tolerance: 0.11, prepared: { kind: 'ADVANCE', seq: 1 } },
      },
    },
  });
  jobId = job.id;
  await db.adminAlert.create({ data: { type: 'FGO_UNCERTAIN', orderId, dedupeKey: `fgo-uncertain:${job.id}:1`, details: { target: 'GLASS', kind: 'ADVANCE', jobId: job.id, idExtern: `${orderNo}-A`, series: 'GKH', expectedGross: 500, orderNo } } });

  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(`/siparisler/${orderId}`);
  await expect(page.locator('#finans [data-fgo-uncertain]')).toBeVisible();
  await expect(page.locator('#finans').getByRole('button', { name: 'Avans Faturası Gönder' })).toHaveCount(0);
  const box = page.locator(`#belirsiz [data-uncertain-job="${jobId}"]`);
  await expect(box).toContainText(`${orderNo}-A`);
  await expect(box).toContainText('500,00 RON');
  // "FGO'da belge var": FGO kapalı → doğrulanamaz, hiçbir şey kaydedilmez
  await box.locator('[data-uncertain-record] input[name=number]').fill('123');
  await box.locator('[data-uncertain-record]').getByRole('button', { name: "Belgeyi FGO'dan doğrula ve kaydet" }).click();
  await expect(page).toHaveURL(/uncError=FGO_DISABLED/);
  await expect(page.locator('[data-uncertain-error="FGO_DISABLED"]')).toBeVisible();
  expect((await db.notificationOutbox.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('PENDING');
  // "Önemli kararlar": "Gördüm" yok, kayda götüren bağlantı var
  await page.goto('/admin/kararlar');
  const row = page.locator('tr', { has: page.locator('[data-uncertain-alert]') }).filter({ hasText: orderNo });
  await expect(row.getByRole('button', { name: 'Gördüm' })).toHaveCount(0);
  await expect(row.locator('a[data-finance-open]')).toHaveAttribute('href', `/siparisler/${orderId}#belirsiz`);
  // "FGO'da belge yok, vazgeç": açık onay kutusuyla
  await page.goto(`/siparisler/${orderId}`);
  const absent = page.locator(`#belirsiz [data-uncertain-job="${jobId}"] [data-uncertain-absent]`);
  await absent.locator('input[name=confirm]').check();
  await absent.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(page).toHaveURL(/uncOk=ABANDON/);
  expect((await db.notificationOutbox.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('FAILED');
  expect(await db.adminAlert.count({ where: { orderId, type: 'FGO_UNCERTAIN', resolvedAt: null } })).toBe(0);
  await expect(page.locator(`[data-uncertain-job="${jobId}"]`)).toHaveCount(0);
  await db.$disconnect();
  await page.context().close();
});
