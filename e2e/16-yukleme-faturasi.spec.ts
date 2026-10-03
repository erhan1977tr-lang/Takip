import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as } from './helpers';

// Onaylı yüklemeden müşteri faturası (Aşama 7D-3, karar 101): Yüklemeler → onaylı gün → "Faturalama".
//  - müşteri başına fatura önizlemesi yalnızca YÜKLENEN (LOADED) adetlerden; kısmi yüklemede 10 adedin 8'i
//  - müşteri proformasındaki sipariş ayrı grupta (proformanın kuru); proformada avansı kesilmemiş tahsilat varken
//    fatura düğmesi yok, "Avans faturası kes" var
//  - yalnızca yönetici: diğer dört rol bölümü göremez, taklit form gönderimiyle fatura / avans oluşturamaz
// FGO bu veritabanında KAPALIDIR: hiçbir belge kesilmez (düğmeler FGO_DISABLED ile durur, parti oluşmaz).
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test';
const INSPECTOR = 'denetim@e2e.test';
const DAY = '2026-02-10'; // geçmiş bir yükleme günü (bu testin onay kaydı)
const URL = `/yuklemeler?gun=${DAY}`;
let firmId = '';
let otherId = '';

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

test('veri: iki müşteri, onaylı yükleme (biri kısmi), bir müşteri proforması (tahsilatlı), günün BT kuru', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const ship = new Date(`${DAY}T12:00:00Z`);
  const firm = await db.customer.create({ data: { name: 'Fatura E2E SRL', prefix: 'FTR', email: 'ftr@e2e.test', taxId: '667788', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. Fatura 1' } });
  const other = await db.customer.create({ data: { name: 'Fatura Doi SRL', prefix: 'FTD', email: 'ftd@e2e.test', taxId: '667799', county: 'Bihor', city: 'Oradea', address: 'Str. Doi 2' } });
  const order = (c: { id: string; prefix: string | null }, no: number, pieces: number, cnc: boolean) => db.order.create({
    data: {
      orderNo: `${c.prefix}${no}`, customerOrderNo: no, title: `Fatura e2e ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: ship,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [
          { sortOrder: 0, description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: pieces, unit: 'm2', unitPrice: '37', offerPrice: '50', kind: 'CAM' },
          ...(cnc ? [{ sortOrder: 1, description: 'CNC', adet: 2, unit: 'adet', unitPrice: '7', offerPrice: '10', kind: 'CNC' }] : []),
        ] } } },
    },
    include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
  });
  const o1 = await order(firm, 1, 2, true);
  const o2 = await order(firm, 2, 10, false); // 10 adedin 8'i yüklendi
  const o3 = await order(firm, 3, 2, true); // müşteri proformasında
  const d1 = await order(other, 1, 3, false);

  // Onaylı yükleme (7C kaydı) — doğrudan veritabanına: teklif satırlarının kopyası, fiilen yüklenen adetle
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${DAY}T00:00:00Z`), confirmedById: admin.id, note: 'e2e fatura' } });
  type Ord = Awaited<ReturnType<typeof order>>;
  const item = (o: Ord, i: number, qty: number, status: 'LOADED' | 'NOT_LOADED' = 'LOADED') => {
    const l = o.offers[0].lines[i];
    const glass = l.kind === 'CAM';
    return {
      confirmationId: conf.id, orderId: o.id, customerId: o.customerId, offerLineId: l.id, sortOrder: l.sortOrder, kind: l.kind, unit: l.unit,
      description: l.description, descriptionRo: l.descriptionRo, enMm: l.enMm, boyMm: l.boyMm, quantity: qty, m2: glass ? qty : 0, currency: 'EUR',
      unitCost: l.unitPrice, unitSale: l.offerPrice, costAmount: qty * Number(l.unitPrice), saleAmount: qty * Number(l.offerPrice), status,
      notLoadedReason: status === 'NOT_LOADED' ? 'e2e' : null,
    };
  };
  await db.loadingConfirmationItem.createMany({
    data: [item(o1, 0, 2), item(o1, 1, 2), item(o2, 0, 8), item(o2, 0, 2, 'NOT_LOADED'), item(o3, 0, 2), item(o3, 1, 2), item(d1, 0, 3)],
  });

  // Kesilmiş müşteri proforması PRF88002 (FTR3; kur 5,0000) ve FGO'da görünen 300 RON tahsilat — yalnızca veritabanı
  const day = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const batch = await db.billingBatch.create({
    data: {
      customerId: firm.id, kind: 'PROFORMA', status: 'ISSUED', currency: 'EUR', loadingDays: [new Date(`${DAY}T00:00:00Z`)], selectionKey: 'e2e-ftr', sourceTotal: '120.00', ronNet: '600.00',
      fxRate: '5.0000', fxDate: day, fxSource: 'MANUAL_DAY', fxPolicy: 'BT_UNIT_SELL', fxCurrency: 'EUR', fxBaseRate: '5.0000', fxSourceDate: day, fxResolvedAt: new Date(), fxManual: true,
      createdById: admin.id, issuedAt: new Date(),
      orders: { create: [{ orderId: o3.id, orderNo: o3.orderNo, offerId: o3.offers[0].id, loadingDay: new Date(`${DAY}T00:00:00Z`), sourceAmount: '120.00', activeKey: `PROFORMA:${o3.id}` }] },
      lines: { create: [{ orderId: o3.id, sortOrder: 0, name: `Comanda ${o3.orderNo} — Sticlă securizată 10 mm`, unit: 'mp', quantity: '2', unitPrice: '50.00', amount: '100.00' }] },
    },
  });
  await db.fgoDocument.create({ data: { batchId: batch.id, kind: 'PROFORMA', series: 'PRF', number: '88002', issuedAt: new Date(), total: '726.00', paid: '300.00', checkedAt: new Date() } });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await db.integrationSetting.upsert({ where: { key: 'fx.daily' }, create: { key: 'fx.daily', value: { day: today, rate: 5.1 } }, update: { value: { day: today, rate: 5.1 } } });
  await db.$disconnect();
  firmId = firm.id;
  otherId = other.id;
});

test('yönetici: onaylı günün Faturalama bölümü — müşteri başına önizleme, yalnızca yüklenen adetler, zincir ve avans; FGO kapalıyken belge oluşmaz', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(URL);
  const box = page.locator('#faturalama');
  await expect(box).toBeVisible();
  await expect(box.locator('section.bill-customer')).toHaveCount(2);

  // Müşteri 1: iki fatura grubu — proformasız (FTR1 + FTR2) ve müşteri proforması zinciri (FTR3)
  const firm = box.locator(`section.bill-customer[data-customer="${firmId}"]`);
  await expect(firm.locator('.bill-group')).toHaveCount(2);
  const direct = firm.locator('.bill-group', { hasText: 'FTR1' });
  await expect(direct.locator('tr.sub:not(.glass-row) a.order-no')).toHaveText(['FTR1', 'FTR2']);
  // Satır = FGO açıklaması: kaynak sipariş numarasıyla; CNC ait olduğu cam satırına eklenir (fatura kuralı)
  const rows = direct.locator('tr.glass-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Comanda FTR1 — Sticlă securizată 10 mm');
  await expect(rows.nth(0)).toContainText('120,00');
  // Kısmi yükleme: 10 adedin yalnızca yüklenen 8'i (8 m², 400 EUR)
  await expect(rows.nth(1)).toContainText('Comanda FTR2 — Sticlă securizată 10 mm');
  await expect(rows.nth(1).locator('td').nth(1)).toHaveText('8');
  await expect(rows.nth(1)).toContainText('400,00');
  // 520 EUR × 5,1000 → 2.652,00 + TVA = 3.208,92 RON
  await expect(direct.locator('.stats')).toContainText('520,00');
  await expect(direct.locator('.stats')).toContainText('3.208,92');
  await expect(direct.locator('.fx-info')).toContainText('5,1000');
  await expect(direct.getByRole('button', { name: 'Fatura oluştur' })).toBeVisible();

  // Zincir: proformanın kuru (5,0000), tahsilat 300 → önce avans faturası; fatura düğmesi yok
  const chain = firm.locator('.bill-group', { hasText: 'FTR3' });
  await expect(chain).toContainText('PRF88002');
  await expect(chain.locator('.stats')).toContainText('726,00');
  await expect(chain.locator('.fx-info')).toContainText('5,0000');
  await expect(chain.locator('.alert-warn')).toContainText('300,00');
  await expect(chain.getByRole('button', { name: /Avans faturası kes/ })).toBeVisible();
  await expect(chain.getByRole('button', { name: 'Fatura oluştur' })).toHaveCount(0);

  // Müşteri 2: kendi faturası, yalnızca kendi siparişi
  const other = box.locator(`section.bill-customer[data-customer="${otherId}"]`);
  await expect(other.locator('.bill-group')).toHaveCount(1);
  await expect(other).toContainText('Comanda FTD1');
  await expect(other).not.toContainText('FTR');
  await expect(firm).not.toContainText('FTD1');
  // Fabrika maliyeti (37 / 7) bölümde yok
  await expect(box).not.toContainText('37,00');
  await expect(box).not.toContainText('74,00');
  await shot(page, 'yukleme-faturalama');

  // "Fatura oluştur" ve "Avans faturası kes": FGO kapalı → hiçbir parti / belge oluşmaz (gerçek FGO'ya hiçbir şey gitmez)
  await direct.getByRole('button', { name: 'Fatura oluştur' }).click();
  await expect(page).toHaveURL(/faturaHata=FGO_DISABLED/);
  await expect(box.locator('.alert-error').first()).toBeVisible();
  await page.locator('#faturalama .bill-group', { hasText: 'FTR3' }).getByRole('button', { name: /Avans faturası kes/ }).click();
  await expect(page).toHaveURL(/faturaHata=FGO_DISABLED/);
  const db = await prisma();
  expect(await db.billingBatch.count({ where: { kind: { in: ['INVOICE', 'ADVANCE'] } } })).toBe(0);
  expect(await db.notificationOutbox.count({ where: { type: 'FGO_BATCH' } })).toBe(0);
  expect(await db.loadingConfirmationItem.count({ where: { confirmation: { shipDay: new Date(`${DAY}T00:00:00Z`) } } }), 'yükleme onayı değişmedi').toBe(7);
  await db.$disconnect();
  await page.context().close();
});

test('yetkisiz roller: Faturalama bölümü görünmez; taklit form gönderimiyle fatura / avans oluşturulamaz', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const html = await (await admin.request.get(URL)).text();
  const invoiceField = await actionField(admin, URL, 'name="previewKey"');
  const advanceField = await actionField(admin, URL, 'name="proformaBatchId"');
  const form = html.split('<form').find((chunk) => chunk.includes('name="previewKey"')) ?? '';
  const value = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(form)?.[1] ?? '';
  const invoice = { day: DAY, groupKey: value('groupKey'), previewKey: value('previewKey'), fxRate: '' };
  expect(invoice.groupKey).toMatch(/^INVOICE:/);
  expect(invoice.previewKey).toHaveLength(64);
  const proformaBatchId = /name="proformaBatchId" value="([^"]+)"/.exec(html)?.[1] ?? '';
  expect(proformaBatchId).not.toBe('');
  const db = await prisma();
  const count = () => db.billingBatch.count({ where: { kind: { in: ['INVOICE', 'ADVANCE'] } } });
  for (const [who, email, pw] of [['musteri', CUSTOMER, CUST_PW], ['satis', SALES2, TEAM_PW], ['cizim', DRAWER, TEAM_PW], ['denetim', INSPECTOR, 'Denet1']] as const) {
    const p = await as(browser, email, pw);
    const res = await p.request.get(URL);
    const body = await res.text();
    expect(body, `${who}: Faturalama bölümü yok`).not.toContain('id="faturalama"');
    expect(body, `${who}: fatura önizlemesi sızmaz`).not.toContain('Comanda FTR1');
    expect(body, `${who}: tutar sızmaz`).not.toContain('3.208,92');
    const r1 = await forge(p, URL, invoiceField, invoice);
    expect(r1.url(), `${who}: taklit fatura isteği`).toMatch(/\/siparisler$/);
    const r2 = await forge(p, URL, advanceField, { day: DAY, proformaBatchId });
    expect(r2.url(), `${who}: taklit avans isteği`).toMatch(/\/siparisler$/);
    expect(await count(), `${who}: parti oluşmadı`).toBe(0);
    await p.context().close();
  }
  // Karşı kontrol: aynı istekler yönetici oturumuyla işlemi çalıştırır (engel yetki kontrolüdür); FGO kapalı → parti yine oluşmaz
  const ok1 = await forge(admin, URL, invoiceField, invoice);
  expect(ok1.url()).toContain('faturaHata=FGO_DISABLED');
  const ok2 = await forge(admin, URL, advanceField, { day: DAY, proformaBatchId });
  expect(ok2.url()).toContain('faturaHata=FGO_DISABLED');
  expect(await count()).toBe(0);
  expect(await db.fgoDocument.count({ where: { batch: { kind: { in: ['INVOICE', 'ADVANCE'] } } } })).toBe(0);
  await db.$disconnect();
  await admin.context().close();
});
