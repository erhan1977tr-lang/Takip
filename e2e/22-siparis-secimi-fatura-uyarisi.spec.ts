import { test, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, TEAM_PW, as } from './helpers';
import { fakeFgo } from './fake-fgo';

// Sipariş seçimi (karar 125) ve "fatura bekliyor" uyarısı (karar 126) — tarayıcıda.
//  - müşteri proforması: uygun siparişler tek tek seçilir; önizleme / tutarlar yalnızca seçilenlerden; seçilmeyen sipariş
//    belge kesildikten sonra da uygun kalır
//  - onaylı yüklemenin faturası: seçim fatura grubu başınadır; yalnızca seçilen siparişlerin fiilen yüklenen adedi
//    faturalanır; kalan sipariş aynı onaydan sonradan faturalanabilir
//  - Yönetici → Entegrasyonlar → "Fatura edilmemiş sipariş uyarısı" (0–60) ve Cam Tahsilat'taki kalıcı "FATURA BEKLİYOR"
//    listesi: proforma, avans faturası ve kuyruktaki fatura isteği uyarıyı kapatmaz; yalnızca KESİLMİŞ kapanış faturası kapatır
// FGO bu veritabanında KAPALIDIR ve kapalı kalır: tarayıcıdan "oluştur" düğmeleri FGO_DISABLED ile durur. Belgenin
// kesilmiş hâli gereken adımlarda belge, sayfanın gösterdiği önizleme anahtarı ve seçimle, uygulamanın gerçek servisleri
// üzerinden SAHTE FGO ile kesilir (e2e/fake-fgo.ts) — gerçek FGO / ANAF / BNR'ye hiçbir istek gitmez.
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test';
const PROFORMA = '/admin/muhasebe/cam/proforma';
const RECEIVABLES = '/admin/muhasebe/cam';
const SETTINGS = '/admin/entegrasyonlar';
const FIRM = 'Secim E2E SRL';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plus = (day: string, k: number) => new Date(Date.parse(`${day}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const dmy = (day: string) => day.split('-').reverse().join('.');
const [P1, P2] = [plus(today, 40), plus(today, 47)]; // gelecekteki yükleme günleri (proforma)
const DAY = '2026-02-03'; // geçmiş bir yükleme günü (bu testin onay kaydı)
const RECENT = plus(today, -3); // üç gün önce onaylanmış yükleme (uyarı günü sınaması)
const DAY_URL = `/yuklemeler?gun=${DAY}`;
const SINCE = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${DAY}T00:00:00Z`)) / 86_400_000);
let firmId = '';
let adminId = '';
let chainBatchId = '';
const ids: Record<string, string> = {}; // sipariş no → kimlik

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
const actor = () => ({ id: adminId, role: 'ADMIN', ip: '127.0.0.1' });
/** Formdaki gizli alanın değerleri (sayfanın sunucuya göndereceği değerler) */
const hidden = (form: Locator, name: string) => form.locator(`input[type=hidden][name="${name}"]`).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const previewUrl = (extra = '') => `${PROFORMA}?musteri=${firmId}&gun=${P1}&gun=${P2}${extra}`;
const orderRow = (scope: Locator, no: string) => scope.locator(`tr.sub[data-order="${ids[no]}"]`);

test('veri: müşteri; gelecekteki günlere planlı üç sipariş; onaylı yükleme (kısmi yükleme, RON sipariş, müşteri proformasındaki sipariş); üç gün önceki yükleme', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  adminId = admin.id;
  const firm = await db.customer.create({ data: { name: FIRM, prefix: 'SCM', email: 'scm@e2e.test', taxId: '445566', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. Secim 1' } });
  firmId = firm.id;
  const order = async (no: number, pieces: number, ship: string, currency = 'EUR') => {
    const o = await db.order.create({
      data: {
        orderNo: `SCM${no}`, customerOrderNo: no, title: `Seçim e2e ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: new Date(`${ship}T12:00:00Z`),
        offers: { create: { status: 'GONDERILDI', currency, amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(),
          lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: pieces, unit: 'm2', unitPrice: '37', offerPrice: '50', kind: 'CAM' }] } } },
      },
      include: { offers: { include: { lines: true } } },
    });
    ids[o.orderNo] = o.id;
    return o;
  };
  // Proforma: SCM1 + SCM2 (ilk gün), SCM3 (ikinci gün) — her biri 2 m² × 50 = 100 EUR
  await order(1, 2, P1);
  await order(2, 2, P1);
  await order(3, 2, P2);
  // Onaylı yükleme (DAY): SCM51 (2), SCM52 (10 adedin 8'i yüklendi), SCM53 (2) — proformasız EUR grubu;
  // SCM54 RON (ayrı grup); SCM55 müşteri proformasında (ayrı grup: proformanın kuru)
  const o51 = await order(51, 2, DAY);
  const o52 = await order(52, 10, DAY);
  const o53 = await order(53, 2, DAY);
  const o54 = await order(54, 2, DAY, 'RON');
  const o55 = await order(55, 2, DAY);
  const o61 = await order(61, 2, RECENT); // üç gün önce yüklendi
  type Ord = Awaited<ReturnType<typeof order>>;
  const item = (confirmationId: string, o: Ord, qty: number, status: 'LOADED' | 'NOT_LOADED' = 'LOADED') => {
    const l = o.offers[0].lines[0];
    return {
      confirmationId, orderId: o.id, customerId: o.customerId, offerLineId: l.id, scopeKey: `l:${l.id}`, sortOrder: l.sortOrder, kind: l.kind, unit: l.unit,
      description: l.description, descriptionRo: l.descriptionRo, enMm: l.enMm, boyMm: l.boyMm, quantity: qty, m2: qty, currency: o.offers[0].currency,
      unitCost: l.unitPrice, unitSale: l.offerPrice, costAmount: qty * Number(l.unitPrice), saleAmount: qty * Number(l.offerPrice), status,
      notLoadedReason: status === 'NOT_LOADED' ? 'e2e' : null,
    };
  };
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${DAY}T00:00:00Z`), confirmedById: admin.id, note: 'e2e seçim' } });
  const recent = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${RECENT}T00:00:00Z`), confirmedById: admin.id, note: 'e2e uyarı günü' } });
  await db.loadingConfirmationItem.createMany({
    data: [item(conf.id, o51, 2), item(conf.id, o52, 8), item(conf.id, o52, 2, 'NOT_LOADED'), item(conf.id, o53, 2), item(conf.id, o54, 2), item(conf.id, o55, 2), item(recent.id, o61, 2)],
  });
  // Kesilmiş müşteri proforması PRF88022 (SCM55; kur 5,0000; henüz tahsilat yok) — yalnızca veritabanı kaydı
  const day0 = new Date(`${today}T00:00:00Z`);
  const batch = await db.billingBatch.create({
    data: {
      customerId: firm.id, kind: 'PROFORMA', status: 'ISSUED', currency: 'EUR', loadingDays: [new Date(`${DAY}T00:00:00Z`)], selectionKey: 'e2e-scm', sourceTotal: '100.00', ronNet: '500.00',
      fxRate: '5.0000', fxDate: day0, fxSource: 'MANUAL_DAY', fxPolicy: 'BT_UNIT_SELL', fxCurrency: 'EUR', fxBaseRate: '5.0000', fxSourceDate: day0, fxResolvedAt: new Date(), fxManual: true,
      createdById: admin.id, issuedAt: new Date(),
      orders: { create: [{ orderId: o55.id, orderNo: o55.orderNo, offerId: o55.offers[0].id, loadingDay: new Date(`${DAY}T00:00:00Z`), sourceAmount: '100.00', activeKey: `PROFORMA:${o55.id}` }] },
      lines: { create: [{ orderId: o55.id, sortOrder: 0, name: `Comanda ${o55.orderNo} — Sticlă securizată 10 mm`, unit: 'mp', quantity: '2', unitPrice: '50.00', amount: '100.00' }] },
    },
  });
  chainBatchId = batch.id;
  await db.fgoDocument.create({ data: { batchId: batch.id, kind: 'PROFORMA', series: 'PRF', number: '88022', issuedAt: new Date(), total: '605.00', paid: '0', checkedAt: new Date() } });
  // Günün BT kuru (müşterinin varsayılan kur politikası BT): önizleme ve belge ağa çıkmadan kur bulur
  await db.integrationSetting.upsert({ where: { key: 'fx.daily' }, create: { key: 'fx.daily', value: { day: today, rate: 5.1 } }, update: { value: { day: today, rate: 5.1 } } });
  await db.$disconnect();
});

test('proforma: uygun siparişler tek tek seçilir; önizleme ve tutarlar yalnızca seçilenlerden; belge yalnızca seçilenlerden kesilir; seçilmeyen sipariş sonra da uygun', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(previewUrl());
  const prev = page.locator('#onizleme');
  // Seçim yapılmadan: uygun siparişlerin hepsi işaretli (eski davranış) — 3 × 100 EUR = 300; kur 5,1000 → 1.530,00 RON
  const boxes = prev.locator('input[type=checkbox][name=sip]');
  await expect(boxes).toHaveCount(3);
  for (const no of ['SCM1', 'SCM2', 'SCM3']) await expect(orderRow(prev, no).locator('input[name=sip]')).toBeChecked();
  await expect(prev.locator('tr.glass-row')).toHaveCount(3);
  await expect(prev.locator('.stats')).toContainText('300,00');
  await expect(prev.locator('.stats')).toContainText('1.530,00');

  // SCM2'nin işareti kaldırılır → "Seçimi uygula": önizleme ve tutarlar yalnızca SCM1 + SCM3
  await orderRow(prev, 'SCM2').locator('input[name=sip]').uncheck();
  await prev.getByRole('button', { name: 'Seçimi uygula' }).click();
  await expect(page).toHaveURL(/sec=1/);
  expect(new URL(page.url()).searchParams.getAll('sip').sort()).toEqual([ids.SCM1, ids.SCM3].sort());
  await expect(orderRow(prev, 'SCM1').locator('input[name=sip]')).toBeChecked();
  await expect(orderRow(prev, 'SCM2').locator('input[name=sip]')).not.toBeChecked();
  await expect(orderRow(prev, 'SCM3').locator('input[name=sip]')).toBeChecked();
  await expect(orderRow(prev, 'SCM2')).toContainText('seçilmedi — bu belgeye girmez');
  await expect(prev.locator('tr.glass-row')).toHaveCount(2);
  await expect(prev.locator('tr.glass-row').nth(0)).toContainText('Comanda SCM1 — Sticlă securizată 10 mm');
  await expect(prev.locator('tr.glass-row').nth(1)).toContainText('Comanda SCM3 — Sticlă securizată 10 mm');
  await expect(prev.locator('tr.glass-row', { hasText: 'SCM2' })).toHaveCount(0);
  await expect(prev.locator('.stats')).toContainText('200,00');
  await expect(prev.locator('.stats')).toContainText('1.020,00'); // 200 × 5,1000 (TVA hariç)
  await expect(prev.locator('.stats')).toContainText('1.234,20'); // TVA dahil
  await expect(prev.locator('.stats')).not.toContainText('1.530,00');
  await expect(prev.locator('.stats .stat').first()).toContainText('2');
  // Gönderilecek seçim = önizlenen seçim
  expect((await hidden(page.locator('#olustur'), 'orderId')).sort()).toEqual([ids.SCM1, ids.SCM3].sort());
  await shot(page, 'proforma-siparis-secimi');

  // Hiç sipariş seçilmezse ya da uygun olmayan sipariş seçilirse belge düğmesi yok (neden yazılır)
  await page.goto(previewUrl('&sec=1'));
  await expect(prev.locator('.alert-warn', { hasText: 'Hiç sipariş seçilmedi' })).toBeVisible();
  await expect(page.locator('#olustur')).toHaveCount(0);
  await page.goto(previewUrl(`&sec=1&sip=${ids.SCM1}&sip=${ids.SCM51}`)); // SCM51 bu günlerin uygun siparişi değil
  await expect(prev.locator('.alert-warn', { hasText: 'uygun değil' })).toBeVisible();
  await expect(page.locator('#olustur')).toHaveCount(0);

  // Tarayıcıdan "Proforma oluştur": FGO kapalı → parti oluşmaz, seçim korunur (gerçek FGO'ya hiçbir şey gitmez)
  await page.goto(previewUrl(`&sec=1&sip=${ids.SCM1}&sip=${ids.SCM3}`));
  await page.locator('#olustur button').click();
  await expect(page).toHaveURL(/error=FGO_DISABLED/);
  expect(new URL(page.url()).searchParams.getAll('sip').sort()).toEqual([ids.SCM1, ids.SCM3].sort());
  const db = await prisma();
  expect(await db.billingBatch.count({ where: { customerId: firmId, kind: 'PROFORMA' } }), 'yalnızca tohumlanan parti').toBe(1);

  // Belge: sayfanın önizleme anahtarı ve seçimiyle, gerçek servis + SAHTE FGO
  await page.goto(previewUrl(`&sec=1&sip=${ids.SCM1}&sip=${ids.SCM3}`));
  const key = (await hidden(page.locator('#olustur'), 'key'))[0];
  const orderIds = await hidden(page.locator('#olustur'), 'orderId');
  const fgo = await fakeFgo(db, 990100);
  // Önizlenenden farklı seçim reddedilir; başka belgeye girecek sipariş yok
  expect(await fgo.createProforma({ customerId: firmId, days: [P1, P2], orderIds: [ids.SCM1, ids.SCM2, ids.SCM3], key, actor: actor() })).toEqual({ ok: false, code: 'STALE_PREVIEW' });
  const made = await fgo.createProforma({ customerId: firmId, days: [P1, P2], orderIds, key, actor: actor() });
  expect(made).toMatchObject({ ok: true, orders: 2 });
  if (!made.ok) throw new Error(made.code);
  const doc = await fgo.issue(made.batchId);
  expect(fgo.calls).toHaveLength(1);
  expect(fgo.names(fgo.calls[0])).toEqual(['Comanda SCM1 — Sticlă securizată 10 mm', 'Comanda SCM3 — Sticlă securizată 10 mm']);
  expect(JSON.stringify(fgo.calls[0])).not.toContain('SCM2');
  expect(`${doc.series}${doc.number}`).toBe('PRF990101');

  // Sonrası (tarayıcı): kesilen proforma listede; SCM2 hâlâ uygun ve tek başına seçilebilir; SCM1 / SCM3 nedeniyle dışarıda
  await page.goto(previewUrl());
  const issued = page.locator('#partiler tr', { hasText: 'PRF990101' });
  await expect(issued).toContainText('SCM1');
  await expect(issued).toContainText('SCM3');
  await expect(issued).not.toContainText('SCM2');
  await expect(prev.locator('input[type=checkbox][name=sip]')).toHaveCount(1);
  await expect(orderRow(prev, 'SCM2').locator('input[name=sip]')).toBeChecked();
  await expect(prev.locator('tr.glass-row')).toHaveCount(1);
  await expect(prev.locator('.stats')).toContainText('100,00');
  await expect(prev.locator('#disarida')).toContainText('SCM1');
  await expect(prev.locator('#disarida')).toContainText('SCM3');
  await expect(prev.locator('#disarida')).toContainText('PRF990101');
  expect(await hidden(page.locator('#olustur'), 'orderId')).toEqual([ids.SCM2]);
  // Belgeye girmiş sipariş yeniden seçilemez
  await page.goto(previewUrl(`&sec=1&sip=${ids.SCM1}&sip=${ids.SCM2}`));
  await expect(prev.locator('.alert-warn', { hasText: 'uygun değil' })).toBeVisible();
  await expect(page.locator('#olustur')).toHaveCount(0);
  expect(await db.billingBatchOrder.count({ where: { orderId: ids.SCM2, activeKey: { not: null } } }), 'seçilmeyen sipariş hiçbir partide değil').toBe(0);
  expect((await db.billingBatchOrder.findMany({ where: { batchId: made.batchId }, orderBy: { orderNo: 'asc' } })).map((o) => o.orderNo)).toEqual(['SCM1', 'SCM3']);
  await db.$disconnect();
  await page.context().close();
});

test('fatura: seçim fatura grubu başınadır; yalnızca seçilen siparişlerin yüklenen adedi faturalanır; kalan sipariş aynı onaydan sonra faturalanabilir', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(DAY_URL);
  const firm = page.locator(`#faturalama section.bill-customer[data-customer="${firmId}"]`);
  // Üç fatura grubu: proformasız EUR (SCM51–53), RON (SCM54), müşteri proforması zinciri (SCM55)
  await expect(firm.locator('.bill-group')).toHaveCount(3);
  const direct = firm.locator('.bill-group', { hasText: 'SCM51' });
  const ron = firm.locator('.bill-group', { hasText: 'SCM54' });
  const chain = firm.locator('.bill-group', { hasText: 'SCM55' });
  // Seçim kutuları yalnızca birden çok uygun siparişi olan grupta; hepsi işaretli (eski davranış)
  await expect(direct.locator('input[type=checkbox][name=fs]')).toHaveCount(3);
  await expect(ron.locator('input[type=checkbox][name=fs]')).toHaveCount(0);
  await expect(chain.locator('input[type=checkbox][name=fs]')).toHaveCount(0);
  // 100 + 400 (10 adedin yüklenen 8'i) + 100 = 600 EUR → 3.702,60 RON (TVA dahil)
  await expect(direct.locator('.stats')).toContainText('600,00');
  await expect(direct.locator('.stats')).toContainText('3.702,60');

  // SCM53'ün işareti kaldırılır → "Seçimi uygula": yalnızca bu grup yeniden hesaplanır
  await orderRow(direct, 'SCM53').locator('input[name=fs]').uncheck();
  await direct.getByRole('button', { name: 'Seçimi uygula' }).click();
  await expect(page).toHaveURL(/fsec=1/);
  expect(new URL(page.url()).searchParams.getAll('fs').sort()).toEqual([ids.SCM51, ids.SCM52].sort());
  await expect(orderRow(direct, 'SCM51').locator('input[name=fs]')).toBeChecked();
  await expect(orderRow(direct, 'SCM52').locator('input[name=fs]')).toBeChecked();
  await expect(orderRow(direct, 'SCM53').locator('input[name=fs]')).not.toBeChecked();
  await expect(orderRow(direct, 'SCM53')).toContainText('seçilmedi — bu belgeye girmez');
  const rows = direct.locator('tr.glass-row:not(.bill-storno)');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Comanda SCM51 — Sticlă securizată 10 mm');
  // Kısmi yükleme: SCM52'nin yalnızca yüklenen 8 adedi (400 EUR)
  await expect(rows.nth(1)).toContainText('Comanda SCM52 — Sticlă securizată 10 mm');
  await expect(rows.nth(1).locator('td').nth(1)).toHaveText('8');
  await expect(rows.nth(1)).toContainText('400,00');
  await expect(direct.locator('.stats')).toContainText('500,00');
  await expect(direct.locator('.stats')).toContainText('3.085,50'); // 500 × 5,1000 × 1,21
  await expect(direct.locator('.stats')).not.toContainText('3.702,60');
  // Öbür gruplar seçimden etkilenmez
  await expect(ron.locator('tr.glass-row')).toContainText('Comanda SCM54');
  await expect(chain).toContainText('PRF88022');
  await expect(chain.locator('tr.glass-row')).toContainText('Comanda SCM55');
  const form = direct.locator('form', { has: page.locator('input[name=previewKey]') });
  expect((await hidden(form, 'orderId')).sort()).toEqual([ids.SCM51, ids.SCM52].sort());
  await shot(page, 'fatura-siparis-secimi');

  // Tarayıcıdan "Fatura oluştur": FGO kapalı → parti oluşmaz, seçim korunur
  const groupKey = (await hidden(form, 'groupKey'))[0];
  const previewKey = (await hidden(form, 'previewKey'))[0];
  const orderIds = await hidden(form, 'orderId');
  await direct.getByRole('button', { name: 'Fatura oluştur' }).click();
  await expect(page).toHaveURL(/faturaHata=FGO_DISABLED/);
  expect(new URL(page.url()).searchParams.getAll('fs').sort()).toEqual([ids.SCM51, ids.SCM52].sort());
  const db = await prisma();
  const invoices = () => db.billingBatch.count({ where: { customerId: firmId, kind: 'INVOICE' } });
  expect(await invoices()).toBe(0);
  const itemsBefore = await db.loadingConfirmationItem.count({ where: { confirmation: { shipDay: new Date(`${DAY}T00:00:00Z`) } } });

  // Fatura: sayfanın grup / önizleme anahtarı ve seçimiyle, gerçek servis + SAHTE FGO
  const fgo = await fakeFgo(db, 990200);
  // Grupta olmayan sipariş (RON grubundaki SCM54) ve önizlenenden farklı seçim reddedilir
  expect(await fgo.createInvoice({ day: DAY, groupKey, previewKey, orderIds: [ids.SCM51, ids.SCM54], actor: actor() })).toEqual({ ok: false, code: 'NOT_ELIGIBLE' });
  expect(await fgo.createInvoice({ day: DAY, groupKey, previewKey, orderIds: null, actor: actor() })).toEqual({ ok: false, code: 'STALE_PREVIEW' });
  const made = await fgo.createInvoice({ day: DAY, groupKey, previewKey, orderIds, actor: actor() });
  expect(made).toMatchObject({ ok: true, orders: 2 });
  if (!made.ok) throw new Error(made.code);
  const doc = await fgo.issue(made.batchId);
  expect(fgo.calls).toHaveLength(1);
  const sent = fgo.calls[0];
  expect(fgo.names(sent)).toEqual(['Comanda SCM51 — Sticlă securizată 10 mm', 'Comanda SCM52 — Sticlă securizată 10 mm']);
  expect([sent['Continut[0][NrProduse]'], sent['Continut[1][NrProduse]'], sent['Continut[1][PretTotal]']], 'SCM52: yalnızca yüklenen 8 adet').toEqual(['2', '8', '2468.40']);
  for (const no of ['SCM53', 'SCM54', 'SCM55']) expect(JSON.stringify(sent), `${no} faturada yok`).not.toContain(no);
  expect(`${doc.series}${doc.number}`).toBe('GKH990201');

  // Sonrası (tarayıcı): kesilen fatura bölümde; SCM53 aynı onaydan hâlâ faturalanabilir; öbür gruplar yerinde
  await page.goto(DAY_URL);
  const done = firm.locator('.bill-issued', { hasText: 'GKH990201' });
  await expect(done).toContainText('SCM51, SCM52');
  await expect(done).not.toContainText('SCM53');
  await expect(firm.locator('.bill-group')).toHaveCount(3);
  const rest = firm.locator('.bill-group', { hasText: 'SCM53' });
  await expect(rest.locator('tr.sub:not(.glass-row) a.order-no')).toHaveText(['SCM53']);
  await expect(rest.locator('.stats')).toContainText('100,00');
  await expect(rest.locator('.stats')).toContainText('617,10');
  await expect(rest.getByRole('button', { name: 'Fatura oluştur' })).toBeVisible();
  await expect(firm.locator('.bill-group', { hasText: 'SCM54' })).toHaveCount(1);
  await expect(firm.locator('.bill-group', { hasText: 'SCM55' })).toHaveCount(1);
  // Faturalanmış sipariş yeniden seçilemez (kapsam iki kez faturalanmaz)
  const restForm = rest.locator('form', { has: page.locator('input[name=previewKey]') });
  const restKey = (await hidden(restForm, 'previewKey'))[0];
  expect(await fgo.createInvoice({ day: DAY, groupKey, previewKey: restKey, orderIds: [ids.SCM51, ids.SCM53], actor: actor() })).toEqual({ ok: false, code: 'NOT_ELIGIBLE' });
  expect(await invoices()).toBe(1);
  const lines = await db.billingBatchLine.findMany({ where: { batchId: made.batchId }, orderBy: { sortOrder: 'asc' } });
  expect(lines.map((l) => [l.orderId, l.pieces])).toEqual([[ids.SCM51, 2], [ids.SCM52, 8]]);
  expect(await db.billingBatchOrder.count({ where: { orderId: ids.SCM53, activeKey: { startsWith: 'INVOICE:' } } }), 'seçilmeyen sipariş faturada değil').toBe(0);
  expect(await db.loadingConfirmationItem.count({ where: { confirmation: { shipDay: new Date(`${DAY}T00:00:00Z`) } } }), 'yükleme onayı değişmedi').toBe(itemsBefore);
  await db.$disconnect();
  await page.context().close();
});

test('ayar: Yönetici → Entegrasyonlar → "Fatura edilmemiş sipariş uyarısı" — varsayılan 6, 0–60 kaydedilir, sınır dışı değer sunucuda reddedilir, yalnızca yönetici', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(SETTINGS);
  const card = page.locator('form#muhasebe');
  const input = card.locator('input[name=uninvoicedDays]');
  await expect(card.locator('h2')).toHaveText('Fatura edilmemiş sipariş uyarısı');
  await expect(input).toHaveValue('6'); // varsayılan
  await expect(input).toHaveAttribute('min', '0');
  await expect(input).toHaveAttribute('max', '60');
  const save = async (value: string) => {
    await page.goto(SETTINGS);
    await input.fill(value);
    await card.getByRole('button', { name: 'Kaydet' }).click();
  };
  // Geçerli uçlar ve ara değer: 0, 60, 14
  for (const value of ['0', '60', '14']) {
    await save(value);
    await expect(page).toHaveURL(/ok=accounting/);
    await expect(page.locator('.alert-ok', { hasText: 'Fatura uyarısı ayarı kaydedildi.' })).toBeVisible();
    await expect(input).toHaveValue(value);
  }
  // Tarayıcı sınır dışı değeri göndermez (min / max)
  await save('61');
  await expect(page).not.toHaveURL(/accounting/);
  expect(await input.evaluate((el) => (el as HTMLInputElement).checkValidity())).toBe(false);
  // Sunucu da reddeder (taklit istek): değer değişmez
  const field = await actionField(page, SETTINGS, 'id="muhasebe"');
  const db = await prisma();
  const stored = async () => ((await db.integrationSetting.findUnique({ where: { key: 'accounting' } }))?.value as { uninvoicedDays?: number } | null)?.uninvoicedDays;
  for (const bad of ['61', '-1', '6.5', 'abc', '600']) {
    const r = await forge(page, SETTINGS, field, { uninvoicedDays: bad });
    expect(r.url(), `geçersiz: ${bad}`).toContain('error=accounting');
    expect(await stored(), `geçersiz: ${bad}`).toBe(14);
  }
  await page.goto(`${SETTINGS}?error=accounting#muhasebe`);
  await expect(page.locator('.alert-error', { hasText: 'Gün sayısı geçersiz' })).toBeVisible();
  // Yetki sunucuda: satış ayarı değiştiremez
  const sales = await as(browser, SALES2, TEAM_PW);
  const forged = await forge(sales, SETTINGS, field, { uninvoicedDays: '1' });
  expect(forged.url()).toMatch(/\/siparisler$/);
  expect(await stored()).toBe(14);
  await sales.context().close();
  // Boş değer varsayılana döner; ayar değişikliği denetim kaydına yazılır; FGO ayarına dokunulmaz
  const empty = await forge(page, SETTINGS, field, { uninvoicedDays: '' });
  expect(empty.url()).toContain('ok=accounting');
  expect(await stored()).toBe(6);
  expect(await db.auditLog.count({ where: { action: 'SETTINGS_UPDATE', entityId: 'accounting' } })).toBeGreaterThanOrEqual(4);
  const fgoRow = await db.integrationSetting.findUnique({ where: { key: 'fgo' } });
  expect((fgoRow?.value as { enabled?: boolean } | null)?.enabled ?? false, 'FGO kapalı kaldı').toBe(false);
  await db.$disconnect();
  await page.context().close();
});

test('Cam Tahsilat: kalıcı "FATURA BEKLİYOR" listesi — uyarı günü ayara göre; proforma, avans ve kuyruktaki fatura kapatmaz; yalnızca kesilmiş kapanış faturası kapatır', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await as(browser, ADMIN, ADMIN_PW);
  const db = await prisma();
  const box = page.locator('#fatura-bekliyor');
  const row = (no: string) => box.locator(`tr[data-overdue="${no}"]`);
  const setDays = async (value: string) => {
    await page.goto(SETTINGS);
    await page.locator('form#muhasebe input[name=uninvoicedDays]').fill(value);
    await page.locator('form#muhasebe').getByRole('button', { name: 'Kaydet' }).click();
    await expect(page).toHaveURL(/ok=accounting/);
    await page.goto(RECEIVABLES);
  };

  // Ayar 6 gün: şubattaki yüklemenin faturalanmamış kapsamları listede; faturası kesilenler ve üç gün önceki yükleme yok
  await page.goto(RECEIVABLES);
  await expect(box.locator('h2')).toContainText('FATURA BEKLİYOR');
  await expect(row('SCM53')).toContainText(`SCM53 · ${FIRM}`);
  await expect(row('SCM53')).toContainText(`Yükleme: ${dmy(DAY)}`);
  await expect(row('SCM53')).toContainText(`${SINCE} gündür fatura edilmedi`);
  await expect(row('SCM53').getByRole('link', { name: 'Faturalamayı aç' })).toHaveAttribute('href', `/yuklemeler?gun=${DAY}#faturalama`);
  await expect(row('SCM54')).toHaveCount(1);
  await expect(row('SCM51'), 'faturası kesildi').toHaveCount(0);
  await expect(row('SCM52'), 'faturası kesildi (yüklenmeyen 2 adet uyarı üretmez)').toHaveCount(0);
  await expect(row('SCM61'), 'uyarı günü gelmedi (3 < 6)').toHaveCount(0);
  // Kesilmiş müşteri proforması uyarıyı kapatmaz
  await expect(row('SCM55')).toContainText(`${SINCE} gündür fatura edilmedi`);
  await shot(page, 'fatura-bekliyor');

  // Uyarı günü = onaylı yükleme günü + ayardaki gün: 3 gün önceki yükleme 3'te görünür, 4'te görünmez, 0'da görünür
  await setDays('3');
  await expect(row('SCM61')).toContainText('3 gündür fatura edilmedi');
  await expect(row('SCM61')).toContainText(`Yükleme: ${dmy(RECENT)}`);
  await setDays('4');
  await expect(row('SCM61')).toHaveCount(0);
  await expect(row('SCM53'), 'eski yükleme her ayarda bekliyor').toHaveCount(1);
  await setDays('0');
  await expect(row('SCM61')).toHaveCount(1);
  await setDays('60');
  await expect(row('SCM61')).toHaveCount(0);
  await expect(row('SCM53')).toHaveCount(1);
  await setDays('6');

  // Proformaya tahsilat gelir ve AVANS FATURASI kesilir (sahte FGO): uyarı kapanmaz
  const fgo = await fakeFgo(db, 990300);
  await db.fgoDocument.update({ where: { batchId: chainBatchId }, data: { paid: '300.00' } });
  const advance = await fgo.createAdvance({ proformaBatchId: chainBatchId, actor: actor() });
  expect(advance).toMatchObject({ ok: true, amount: 300 });
  if (!advance.ok) throw new Error(advance.code);
  const advDoc = await fgo.issue(advance.batchId);
  expect([advDoc.kind, fgo.names(fgo.calls[0])]).toEqual(['ADVANCE', ['Avans marfă conform proformă PRF88022']]);
  await page.goto(RECEIVABLES);
  await expect(row('SCM55'), 'avans faturası uyarıyı kapatmaz').toHaveCount(1);

  // Kapanış faturası isteği KUYRUKTA (henüz kesilmedi): uyarı durur, nedeni yazar
  await page.goto(DAY_URL);
  const chain = page.locator(`#faturalama section.bill-customer[data-customer="${firmId}"] .bill-group`, { hasText: 'SCM55' });
  await expect(chain.locator('tr.bill-storno')).toContainText('Stornare avans conform factură GKH990301');
  const form = chain.locator('form', { has: page.locator('input[name=previewKey]') });
  const queued = await fgo.createInvoice({ day: DAY, groupKey: (await hidden(form, 'groupKey'))[0], previewKey: (await hidden(form, 'previewKey'))[0], orderIds: await hidden(form, 'orderId'), actor: actor() });
  expect(queued).toMatchObject({ ok: true, orders: 1 });
  if (!queued.ok) throw new Error(queued.code);
  await page.goto(RECEIVABLES);
  await expect(row('SCM55')).toContainText('fatura isteği kuyrukta');
  // Kapanış faturası KESİLDİ: uyarı kendiliğinden kalkar
  const invDoc = await fgo.issue(queued.batchId);
  expect(invDoc.kind).toBe('INVOICE');
  expect(fgo.names(fgo.calls[1])).toEqual(['Comanda SCM55 — Sticlă securizată 10 mm', 'Stornare avans conform factură GKH990301']);
  await page.goto(RECEIVABLES);
  await expect(row('SCM55')).toHaveCount(0);

  // Seçilmeyip kalan SCM53: sonradan aynı onaydan faturalanır → o da kalkar; faturalanmayan SCM54 (RON) beklemeye devam eder
  await page.goto(DAY_URL);
  const rest = page.locator(`#faturalama section.bill-customer[data-customer="${firmId}"] .bill-group`, { hasText: 'SCM53' });
  const restForm = rest.locator('form', { has: page.locator('input[name=previewKey]') });
  const later = await fgo.createInvoice({ day: DAY, groupKey: (await hidden(restForm, 'groupKey'))[0], previewKey: (await hidden(restForm, 'previewKey'))[0], orderIds: await hidden(restForm, 'orderId'), actor: actor() });
  expect(later).toMatchObject({ ok: true, orders: 1 });
  if (!later.ok) throw new Error(later.code);
  await fgo.issue(later.batchId);
  expect(fgo.names(fgo.calls[2])).toEqual(['Comanda SCM53 — Sticlă securizată 10 mm']);
  await page.goto(RECEIVABLES);
  await expect(row('SCM53')).toHaveCount(0);
  await expect(row('SCM54')).toHaveCount(1);
  await expect(box.locator('h2')).toContainText('FATURA BEKLİYOR');
  // Aynı onaydan iki ayrı fatura: her siparişin kapsamı tek faturada; FGO'ya gerçek istek yok, ayar kapalı
  expect(await db.billingBatch.count({ where: { customerId: firmId, kind: 'INVOICE', status: 'ISSUED' } })).toBe(3);
  expect(await db.billingBatchOrder.count({ where: { orderId: { in: [ids.SCM51, ids.SCM52, ids.SCM53, ids.SCM55] }, activeKey: { startsWith: 'INVOICE:' } } })).toBe(4);
  expect(await db.billingBatch.count({ where: { customerId: firmId, status: { not: 'ISSUED' } } }), 'kuyrukta / kesilemeyen parti kalmadı').toBe(0);
  const docs = await db.fgoDocument.findMany({ where: { batch: { customerId: firmId } }, select: { id: true, link: true } });
  expect(docs).toHaveLength(6); // tohumlanan proforma + sahte FGO'dan: proforma, avans, üç fatura
  for (const d of docs) {
    expect(d.link ?? 'https://fgo.example/', 'belge bağlantısı sahte adres').toContain('fgo.example');
    expect(await db.notificationOutbox.count({ where: { type: 'FGO_DOC_EMAIL', status: 'PENDING', payload: { path: ['docId'], equals: d.id } } }), 'müşteri e-postası işi açık kalmadı').toBe(0);
  }
  const fgoRow = await db.integrationSetting.findUnique({ where: { key: 'fgo' } });
  expect((fgoRow?.value as { enabled?: boolean } | null)?.enabled ?? false, 'FGO kapalı kaldı').toBe(false);
  await db.$disconnect();
  await page.context().close();
});
