import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, INSPECTOR_PW, firmWithOrder, openFirm } from './helpers';

// Aşama 7F-1 — onaylı yüklemenin düzeltilmesi (karar 105), kısmi aktarım (karar 106) ve sipariş başına avans (karar 104).
//  - "Düzelt": giriş → önizleme (önce / sonra, aktarımlar, finansal etki) → kayıt; "Düzeltildi" rozeti ve tarihçe;
//    onay anındaki kalemler veritabanında aynen durur
//  - yüklenmeyen 2 adet iki ayrı güne 1'er adet aktarılır
//  - yüklenmiş siparişte FGO'da avansı kesilmemiş tahsilat: avans faturası düğmesi görünür, fatura engellenir, tutar yazılamaz
//  - yalnızca yönetici: diğer roller taklit form gönderimiyle düzeltme kaydedemez
// FGO bu veritabanında KAPALIDIR: hiçbir belge kesilmez.
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test';
const INSPECTOR = 'denetim@e2e.test';
const DAY = '2026-02-24'; // geçmiş bir yükleme günü (bu testin onayı)
const DAY_URL = `/yuklemeler?gun=${DAY}`;
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const NEW_DAY = iso(34);
const OTHER_DAY = iso(41);
const dmy = (k: string) => k.split('-').reverse().join('.');
let orderId = '';
let lineId = '';
let financeOrderId = '';

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
const pack = (rows: string[][]) => Buffer.from(JSON.stringify(rows)).toString('base64url');

test('veri: yüklenecek sipariş ve yüklenmiş, proforması kısmen ödenmiş sipariş', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const u = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  const order = (no: number, ship: Date) => db.order.create({
    data: {
      orderNo: `${u.customer!.prefix}${no}`, customerOrderNo: no, title: `Düzeltme e2e ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: u.customer!.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: ship,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 10, unit: 'm2', unitPrice: '37', offerPrice: '50', kind: 'CAM' }] } } },
    },
    include: { offers: { include: { lines: true } } },
  });
  const o = await order(7801, new Date(`${DAY}T12:00:00Z`));
  // Yüklenmiş sipariş (yükleme günü çok önce): proforma 600, FGO'da tahsilat 400; avansı kesilen 150 → avansı kesilecek 250
  const f = await order(7802, new Date('2026-01-13T12:00:00Z'));
  await db.fgoDocument.create({ data: { orderId: f.id, kind: 'PROFORMA', series: 'PRF', number: '78001', total: '600.00', paid: '400.00', issuedAt: new Date('2026-01-05T10:00:00Z'), checkedAt: new Date() } });
  await db.fgoDocument.create({ data: { orderId: f.id, kind: 'ADVANCE', seq: 1, advanced: '150.00', series: 'GKH', number: '78002', total: '150.00', paid: '0', issuedAt: new Date('2026-01-08T10:00:00Z'), checkedAt: new Date() } });
  // "Yüklenmiş" = onaylı yükleme kaydı (karar 239: tarih değil) — teklif satırının kopyası, 10 adet yüklendi
  const fl = f.offers[0].lines[0];
  const fc = await db.loadingConfirmation.create({ data: { shipDay: new Date('2026-01-13T00:00:00Z'), confirmedById: admin.id, note: 'e2e avans' } });
  await db.loadingConfirmationItem.create({
    data: {
      confirmationId: fc.id, orderId: f.id, customerId: f.customerId, offerLineId: fl.id, scopeKey: `l:${fl.id}`, sortOrder: fl.sortOrder, kind: fl.kind, unit: fl.unit,
      description: fl.description, descriptionRo: fl.descriptionRo, enMm: fl.enMm, boyMm: fl.boyMm, quantity: 10, m2: 10, currency: 'EUR',
      unitCost: fl.unitPrice, unitSale: fl.offerPrice, costAmount: 370, saleAmount: 500, status: 'LOADED',
    },
  });
  await db.$disconnect();
  orderId = o.id;
  lineId = o.offers[0].lines[0].id;
  financeOrderId = f.id;
});

test('yönetici: "Yükleme yapıldı" ile kaydedilen yükleme düzeltilir (10 → 8 + 2): önizleme, kayıt, rozet, tarihçe; 2 adet iki ayrı güne 1\'er aktarılır', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(DAY_URL);
  const box = page.locator('#onay');
  await box.getByRole('button', { name: 'Yükleme yapıldı' }).click();
  await expect(page).toHaveURL(/onay=ok/);
  await expect(box.locator('tr.sub', { hasText: 'UNS7801' }).first().locator('td').nth(1)).toHaveText('10');
  await expect(box).not.toContainText('Düzeltildi');
  await expect(page.locator('#yuklenmeyen')).toHaveCount(0);

  // Düzelt → giriş: geçerli durum 10 yüklendi; yeni yüklenmeyen adet 2 + neden
  await box.locator('#duzelt-giris > summary').click();
  const entry = box.locator('#duzelt-giris tr', { hasText: 'UNS7801' });
  await expect(entry.locator('td').nth(2)).toHaveText('10');
  await expect(entry.locator('td').nth(3)).toHaveText('10');
  await expect(entry.locator('td').nth(4)).toHaveText('0');
  await entry.locator('input.nl-qty').fill('2');
  await entry.locator('select').selectOption('BROKEN');
  await box.locator('#duzelt-giris input[name=reason]').fill('2 cam kırık çıktı');
  await shot(page, 'duzeltme-giris');
  await box.getByRole('button', { name: 'Önizle' }).click();

  // Önizleme: önce → sonra, aktarım yok, finansal etki; henüz kayıt yok
  await expect(page).toHaveURL(/dz=/);
  const preview = page.locator('#duzelt-onizleme');
  await expect(preview).toContainText('1. düzeltme');
  await expect(preview).toContainText('10 yüklendi · 0 yüklenmedi');
  await expect(preview).toContainText('8 yüklendi · 2 yüklenmedi');
  await expect(preview).toContainText('Etkilenen aktarım yok.');
  await expect(preview).toContainText('bu yüklemeden fatura kesilmemiş');
  await expect(preview.locator('input[name=reason]')).toHaveValue('2 cam kırık çıktı');
  await shot(page, 'duzeltme-onizleme');
  const db = await prisma();
  expect(await db.loadingCorrection.count({ where: { confirmation: { shipDay: new Date(`${DAY}T00:00:00Z`) } } })).toBe(0);
  await preview.getByRole('button', { name: 'Düzeltmeyi kaydet' }).click();

  // Kayıt: rozet, geçerli durum 8 adet, tarihçe (ilk onay kaydı + 1. düzeltme)
  await expect(page).toHaveURL(/duzeltme=ok&rev=1/);
  await expect(box.locator('.alert-ok').first()).toContainText('1. düzeltme kaydedildi');
  await expect(box.locator('h2')).toContainText('Düzeltildi #1');
  await expect(box.locator('#gecerli-durum')).toContainText('GEÇERLİ durum');
  await expect(box.locator('table.confirm-table').first().locator('tr.sub', { hasText: 'UNS7801' }).first().locator('td').nth(1)).toHaveText('8');
  await box.locator('#duzeltme-gecmisi > summary').click();
  const history = box.locator('#duzeltme-gecmisi');
  await expect(history).toContainText('İlk onay kaydı (değişmez)');
  await expect(history.locator('tr.sub', { hasText: 'UNS7801' }).first().locator('td').nth(1)).toHaveText('10');
  await expect(history.locator('.correction-rev')).toContainText('1. düzeltme');
  await expect(history.locator('.correction-rev')).toContainText('Neden: 2 cam kırık çıktı');
  await expect(history.locator('.correction-rev')).toContainText('10 yüklendi · 0 yüklenmedi → 8 yüklendi · 2 yüklenmedi');
  await shot(page, 'duzeltme-gecmisi');
  // Fatura önizlemesi geçerli durumdan: 8 adet
  const bill = page.locator('#faturalama tr.glass-row', { hasText: 'Comanda UNS7801' });
  await expect(bill.locator('td').nth(1)).toHaveText('8');

  // Kısmi aktarım: 2 yüklenmeyenin 1'i NEW_DAY'e, 1'i OTHER_DAY'e
  const row = page.locator('#yuklenmeyen tbody tr', { hasText: 'UNS7801' });
  await expect(row.locator('td').nth(4)).toHaveText('2');
  await expect(row.locator('form.nl-new input[name=quantity]')).toHaveValue('2');
  await row.locator('form.nl-new input[name=quantity]').fill('1');
  await row.locator('form.nl-new input[name=newDay]').fill(NEW_DAY);
  await row.locator('form.nl-new').getByRole('button', { name: 'Yeniden planla' }).click();
  await expect(page).toHaveURL(/aktar=planned/);
  await expect(row).toContainText(`1 adet → ${dmy(NEW_DAY)} yüklemesine aktarıldı`);
  await expect(row).toContainText('Aktarılmamış: 1 adet');
  await expect(row.locator('form.nl-new input[name=quantity]')).toHaveValue('1');
  await row.locator('form.nl-new input[name=newDay]').fill(OTHER_DAY);
  await row.locator('form.nl-new').getByRole('button', { name: 'Yeniden planla' }).click();
  await expect(page).toHaveURL(/aktar=planned/);
  await expect(row).toContainText(`1 adet → ${dmy(OTHER_DAY)} yüklemesine aktarıldı`);
  await expect(row.locator('.nl-replan')).toHaveCount(2);
  await expect(row.locator('form.nl-new')).toHaveCount(0);
  await shot(page, 'kismi-aktarim');
  // Her yeni günde yalnızca kendi adedi (firmanın alt sipariş satırında cam adedi)
  for (const d of [NEW_DAY, OTHER_DAY]) {
    await page.goto(`/yuklemeler?gun=${d}`);
    const orders = await openFirm(firmWithOrder(page, orderId));
    await expect(orders.locator(`tr[data-order="${orderId}"]`).first().locator('td').nth(1)).toHaveText('1');
  }

  // Veritabanı: onay anındaki kalem aynen; düzeltme ve yeni kalemler eklendi; iki etkin aktarım; hiçbir belge oluşmadı
  const items = await db.loadingConfirmationItem.findMany({ where: { orderId }, orderBy: [{ revision: 'asc' }, { status: 'asc' }] });
  expect(items.map((i) => [i.revision, i.status, i.quantity])).toEqual([[0, 'LOADED', 10], [1, 'LOADED', 8], [1, 'NOT_LOADED', 2]]);
  const fix = await db.loadingCorrection.findMany({ where: { confirmationId: items[0].confirmationId } });
  expect(fix.map((c) => [c.revision, c.reason])).toEqual([[1, '2 cam kırık çıktı']]);
  const replans = await db.loadingReplan.findMany({ where: { orderId }, orderBy: { shipDay: 'asc' } });
  expect(replans.map((r) => [r.status, r.quantity, r.shipDay.toISOString().slice(0, 10)])).toEqual([['ACTIVE', 1, NEW_DAY], ['ACTIVE', 1, OTHER_DAY]]);
  expect(await db.auditLog.count({ where: { action: 'LOADING_CORRECTED', entityId: items[0].confirmationId } })).toBe(1);
  expect(await db.billingBatch.count({ where: { orders: { some: { orderId } } } })).toBe(0);
  expect(await db.fgoDocument.count({ where: { orderId } })).toBe(0);
  await db.$disconnect();
  await page.context().close();
});

test('yönetici: yüklenmiş siparişte FGO tahsilatının avansı kesilmemiş kısmı için avans faturası düğmesi; fatura engelli; tutar yazılamaz', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(`/siparisler/${financeOrderId}`);
  const card = page.locator('#finans');
  const chain = card.locator('#avans-durumu');
  await expect(chain).toContainText('FGO tahsilatı');
  await expect(chain).toContainText('400,00');
  await expect(chain).toContainText('Avansı kesilen');
  await expect(chain).toContainText('150,00');
  await expect(chain).toContainText('Avansı kesilecek');
  await expect(chain).toContainText('250,00');
  await expect(card.locator('#fatura-engeli')).toContainText('250,00');
  await expect(card.getByRole('button', { name: 'Avans Faturası Gönder' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Fatura Gönder', exact: true })).toHaveCount(0);
  // Nihai fatura yükleme gününün Faturalama kartından (karar 239): onaylı yükleme açık kapsam olarak listelenir
  const fin = card.locator('#nihai-fatura [data-loading-day="2026-01-13"]');
  await expect(fin).toHaveAttribute('data-invoice-state', 'OPEN');
  await expect(fin.locator('a[href="/yuklemeler?gun=2026-01-13#faturalama"]')).toHaveCount(1);
  await expect(card.locator('input[name=amount]')).toHaveCount(0);
  await shot(page, 'siparis-avans-yukleme-sonrasi');
  await page.context().close();
});

test('yetkisiz roller: taklit form gönderimiyle yükleme düzeltmesi kaydedilemez', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  // Önizleme adresi: aynı kapsam için yeni yüklenmeyen adet 3 (sunucu işlemi alanı yöneticinin önizleme sayfasından)
  const dz = pack([[`l:${lineId}`, '3', 'BROKEN', '']]);
  const field = await actionField(admin, `${DAY_URL}&dz=${dz}`, 'name="dz"');
  const db = await prisma();
  const corrections = () => db.loadingCorrection.count({ where: { items: { some: { orderId } } } });
  for (const [who, email, pw] of [['musteri', CUSTOMER, CUST_PW], ['satis', SALES2, TEAM_PW], ['cizim', DRAWER, TEAM_PW], ['denetim', INSPECTOR, INSPECTOR_PW]] as const) {
    const p = await as(browser, email, pw);
    const r = await forge(p, DAY_URL, field, { day: DAY, dz, key: 'x', reason: `Taklit ${who}` });
    expect(r.url(), `${who}: taklit düzeltme`).toMatch(/\/siparisler$/);
    expect(await corrections(), `${who}: düzeltme kaydı oluşmadı`).toBe(1);
    await p.context().close();
  }
  // Karşı kontrol: aynı istek yönetici oturumuyla işlemi çalıştırır (önizleme parmak izi tutmadığı için reddedilir)
  const again = await forge(admin, DAY_URL, field, { day: DAY, dz, key: 'x', reason: 'Yönetici' });
  expect(again.url()).toContain('duzeltHata=STALE_PREVIEW');
  const none = await forge(admin, DAY_URL, field, { day: DAY, dz, key: 'x', reason: '' });
  expect(none.url()).toContain('duzeltHata=REASON_REQUIRED');
  expect(await corrections()).toBe(1);
  await db.$disconnect();
  await admin.context().close();
});
