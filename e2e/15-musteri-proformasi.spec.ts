import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as } from './helpers';

// Müşteri düzeyinde yükleme öncesi proforma (Aşama 7D-2, karar 100): Muhasebe → Cam Tahsilat → "Müşteri proforması".
//  - müşteri → gelecekteki yükleme günleri → önizleme (gün → sipariş → satır, toplamlar, kur) → "Proforma oluştur"
//  - seçilmeyen gün ve başka bir belgeyle karşılanan sipariş önizlemeye girmez
//  - yalnızca yönetici: diğer dört rol sayfayı açamaz, taklit form gönderimiyle parti oluşturamaz
// FGO bu veritabanında KAPALIDIR: hiçbir belge kesilmez ("Proforma oluştur" FGO_DISABLED ile durur, parti oluşmaz).
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test';
const INSPECTOR = 'denetim@e2e.test';
const PAGE = '/admin/muhasebe/cam/proforma';
const noon = (offset: number) => new Date(`${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`);
const key = (d: Date) => d.toISOString().slice(0, 10);
const dmy = (d: Date) => key(d).split('-').reverse().join('.');
const [D1, D2, D3] = [noon(10), noon(17), noon(24)];
let firmId = '';
let covered = ''; // müşteri proformasında olan sipariş (kayıt doğrudan veritabanına yazılır; FGO'ya gidilmez)

async function shot(page: Page, name: string) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const before = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `masaustu-${name}.png`), fullPage: true });
  if (before) await page.setViewportSize(before);
}
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
// Taklit istek için tek günlük önizleme (form alanları tekil)
const previewUrl = () => `${PAGE}?musteri=${firmId}&gun=${key(D1)}`;

test('veri: müşteri, üç yükleme gününe planlı siparişler, günün BT kuru, bir müşteri proforması kaydı', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const firm = await db.customer.create({ data: { name: 'Lot E2E SRL', prefix: 'LOT', email: 'lot@e2e.test', taxId: '778899', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. Lot 1' } });
  const order = (no: number, ship: Date) => db.order.create({
    data: {
      orderNo: `LOT${no}`, customerOrderNo: no, title: `Lot e2e ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: ship,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [
          { sortOrder: 0, description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' },
          { sortOrder: 1, description: 'CNC', adet: 2, unit: 'adet', unitPrice: '5', offerPrice: '10', kind: 'CNC' },
        ] } } },
    },
  });
  await order(1, D1);
  await order(2, D1);
  await order(4, D2);
  await order(5, D3); // seçilmeyecek gün
  const c = await order(6, D2); // zaten bir müşteri proformasında
  // Kesilmiş bir müşteri proforması (PRF88001): parti + belge kaydı (yalnızca veritabanı; FGO'ya hiçbir şey gitmez)
  const day = new Date(`${key(new Date())}T00:00:00Z`);
  const batch = await db.billingBatch.create({
    data: {
      customerId: firm.id, kind: 'PROFORMA', status: 'ISSUED', currency: 'EUR', loadingDays: [new Date(`${key(D2)}T00:00:00Z`)], selectionKey: 'e2e', sourceTotal: '120.00', ronNet: '600.00',
      fxRate: '5.0000', fxDate: day, fxSource: 'MANUAL_DAY', fxPolicy: 'BT_UNIT_SELL', fxCurrency: 'EUR', fxBaseRate: '5.0000', fxSourceDate: day, fxResolvedAt: new Date(), fxManual: true,
      createdById: admin.id, issuedAt: new Date(),
      orders: { create: [{ orderId: c.id, orderNo: c.orderNo, offerId: 'e2e', loadingDay: new Date(`${key(D2)}T00:00:00Z`), sourceAmount: '120.00', activeKey: `PROFORMA:${c.id}` }] },
      lines: { create: [{ orderId: c.id, sortOrder: 0, name: `Comanda ${c.orderNo} — Sticlă securizată 10 mm`, unit: 'mp', quantity: '2', unitPrice: '50.00', amount: '100.00' }] },
    },
  });
  await db.fgoDocument.create({ data: { batchId: batch.id, kind: 'PROFORMA', series: 'PRF', number: '88001', issuedAt: new Date(), total: '726.00', paid: '0', checkedAt: new Date() } });
  // Günün BT kuru (müşterinin varsayılan kur politikası BT): önizleme ağa çıkmadan kur gösterir
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await db.integrationSetting.upsert({ where: { key: 'fx.daily' }, create: { key: 'fx.daily', value: { day: today, rate: 5.1 } }, update: { value: { day: today, rate: 5.1 } } });
  await db.$disconnect();
  firmId = firm.id;
  covered = c.id;
});

test('yönetici: müşteri → yükleme günleri → önizleme (tek proforma); seçilmeyen gün ve karşılanmış sipariş dışarıda', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto('/admin/muhasebe/cam');
  await page.locator(`a[href="${PAGE}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
  await page.selectOption('select[name=musteri]', firmId);
  await page.locator('#musteri button').click();
  // Gelecekteki yükleme günleri ayrı ayrı; bir ya da birkaçı seçilir
  const chips = page.locator('#gunler label.chip');
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toContainText(dmy(D1));
  await expect(chips.nth(1)).toContainText(dmy(D2));
  await chips.nth(0).click();
  await chips.nth(1).click();
  await page.locator('#gunler button').click();

  const prev = page.locator('#onizleme');
  await expect(prev).toBeVisible();
  // Gün → sipariş → satır; her satır kaynak sipariş numarasıyla
  await expect(prev.locator('tr.group-total')).toHaveCount(2);
  await expect(prev.locator('tr.sub:not(.glass-row) a.order-no')).toHaveText(['LOT1', 'LOT2', 'LOT4']);
  await expect(prev.locator('tr.glass-row')).toHaveCount(6);
  await expect(prev.locator('tr.glass-row').first()).toContainText('Comanda LOT1 — Sticlă securizată 10 mm');
  await expect(prev.locator('tr.glass-row').nth(1)).toContainText('Comanda LOT1 — Prelucrare CNC');
  await expect(prev).not.toContainText('LOT5');
  // Karşılanmış sipariş nedeniyle dışarıda
  await expect(prev.locator('#disarida')).toContainText('LOT6');
  await expect(prev.locator('#disarida')).toContainText('PRF88001');
  // Toplam: 3 × (100 + 20) = 360 EUR; kur 5,1000 → 1.836,00 RON (TVA hariç)
  await expect(prev.locator('.stats')).toContainText('360,00');
  await expect(prev.locator('.stats')).toContainText('1.836,00');
  await expect(prev.locator('#kur .fx-info')).toContainText('5,1000');
  // Fabrika maliyeti (satış fiyatı 30 / 5) önizlemede yok
  await expect(prev).not.toContainText('30,00');
  await shot(page, 'musteri-proformasi');

  // Elle kur: önizleme ve tutarlar elle kurla (ELLE / MANUAL işaretli)
  await page.fill('#lot-kur', '5,2000');
  await page.locator('#kur button').click();
  await expect(page.locator('#onizleme .stats')).toContainText('1.872,00');
  await expect(page.locator('#kur .fx-info .badge')).toBeVisible();

  // "Proforma oluştur": FGO kapalı → parti oluşmaz, neden yazılır (gerçek FGO'ya hiçbir şey gitmez)
  await page.locator('#olustur button').click();
  await expect(page).toHaveURL(/error=FGO_DISABLED/);
  await expect(page.locator('.alert-error')).toBeVisible();
  const db = await prisma();
  expect(await db.billingBatch.count({ where: { customerId: firmId } }), 'yalnızca tohumlanan parti').toBe(1);
  expect(await db.notificationOutbox.count({ where: { type: 'FGO_BATCH' } })).toBe(0);
  await db.$disconnect();
  await page.context().close();
});

test('Cam Tahsilat: müşteri proforması bir kez, kaynak siparişleri ve günleriyle; kapsanan siparişte sipariş başına belge düğmesi yok', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto('/admin/muhasebe/cam');
  const row = page.locator('table.acc-table tr', { hasText: 'PRF88001' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('LOT6');
  await expect(row).toContainText('Lot E2E SRL');
  await expect(row).toContainText(dmy(D2));
  await expect(row).toContainText('726,00');
  await shot(page, 'cam-tahsilat-musteri-proformasi');
  await page.goto(`/siparisler/${covered}`);
  await expect(page.locator('#musteri-proformasi')).toContainText('PRF88001');
  await expect(page.locator('#finans input[name=kind]')).toHaveCount(0);
  // Parti listesi
  await page.goto(`${PAGE}?musteri=${firmId}`);
  await expect(page.locator('#partiler tbody tr')).toHaveCount(1);
  await expect(page.locator('#partiler')).toContainText('PRF88001');
  await page.context().close();
});

test('yetkisiz roller: sayfa açılmaz, taklit form gönderimiyle parti oluşturulamaz', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const field = await actionField(admin, previewUrl(), 'name="key"');
  const html = await (await admin.request.get(previewUrl())).text();
  const keyValue = /name="key" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? '';
  expect(keyValue).not.toBe('');
  const data = { customerId: firmId, day: key(D1), fxRate: '', key: keyValue };
  const db = await prisma();
  const count = () => db.billingBatch.count({ where: { customerId: firmId } });
  for (const [who, email, pw] of [['musteri', CUSTOMER, CUST_PW], ['satis', SALES2, TEAM_PW], ['cizim', DRAWER, TEAM_PW], ['denetim', INSPECTOR, 'Denet1']] as const) {
    const p = await as(browser, email, pw);
    await p.goto(previewUrl());
    await expect(p, `${who}: sayfa`).toHaveURL(/\/siparisler$/);
    const res = await p.request.get(previewUrl());
    expect(await res.text(), `${who}: önizleme içeriği sızmaz`).not.toContain('Comanda LOT1');
    const r = await forge(p, PAGE, field, data);
    expect(r.url(), `${who}: taklit istek`).toMatch(/\/siparisler$/);
    expect(await count(), `${who}: parti oluşmadı`).toBe(1);
    await p.context().close();
  }
  // Karşı kontrol: aynı istek yönetici oturumuyla işlemi çalıştırır (engel yetki kontrolüdür); FGO kapalı olduğu için parti yine oluşmaz
  const ok = await forge(admin, PAGE, field, data);
  expect(ok.url()).toContain('error=FGO_DISABLED');
  expect(await count()).toBe(1);
  expect(await db.auditLog.count({ where: { action: 'BILLING_BATCH_CREATED' } })).toBe(0);
  await db.$disconnect();
  await admin.context().close();
});
