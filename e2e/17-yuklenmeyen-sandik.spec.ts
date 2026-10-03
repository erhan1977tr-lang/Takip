import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as } from './helpers';

// Aşama 7E — yüklenmeyen camın ileri güne aktarılması (karar 102) ve başka müşterinin sandığına fiziksel yerleşim (karar 103).
//  - onayda cam satırı başına yüklenmeyen adet + neden; onaylı günde "Yüklenmeyen camlar" ve "Yeniden planla"
//  - aktarılan kalan yeni günde yalnızca kendi adediyle görünür; eski onay kaydı değişmez; fatura yalnızca yüklenenden
//  - sipariş başka müşterinin sandığına konur: müşterisi / faturası değişmez; müşteriler birbirinin verisini görmez
//  - yalnızca yönetici: diğer dört rol taklit form gönderimiyle aktaramaz / sandığa koyamaz
// FGO bu veritabanında KAPALIDIR: hiçbir belge kesilmez.
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test';
const INSPECTOR = 'denetim@e2e.test';
const BETA = 'beta@betacam.test';
const DAY = '2026-02-17'; // geçmiş bir yükleme günü (bu testin onayı)
const DAY_URL = `/yuklemeler?gun=${DAY}`;
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const NEW_DAY = iso(20);
const OTHER_DAY = iso(27);
const dmy = (k: string) => k.split('-').reverse().join('.');
let uns = { id: '', name: '' };
let beta = { id: '', name: '' };
let orderU = '';
let orderB = '';
let crateId = '';

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

test('veri: iki müşterinin aynı güne planlı siparişleri ve ev sahibi müşterinin sandığı', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const u = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  const b = await db.user.findUniqueOrThrow({ where: { email: BETA }, include: { customer: true } });
  uns = { id: u.customer!.id, name: u.customer!.name };
  beta = { id: b.customer!.id, name: b.customer!.name };
  const ship = new Date(`${DAY}T12:00:00Z`);
  const order = (c: { id: string; prefix: string | null }, no: number, pieces: number) => db.order.create({
    data: {
      orderNo: `${c.prefix}${no}`, customerOrderNo: no, title: `Aktarım e2e ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: ship,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: pieces, unit: 'm2', unitPrice: '37', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
  const ou = await order(u.customer!, 7701, 10);
  const ob = await order(b.customer!, 7702, 3);
  const crate = await db.crate.create({
    // Ağırlık girilmemiş sandık: net = içindeki camın ağırlığı, brüt = net + 50 kg dara (fiziksel ağırlık camdan hesaplanır)
    data: { shipDay: new Date(`${DAY}T00:00:00Z`), customerId: beta.id, crateNo: 15, lengthMm: 2400, widthMm: 1600, heightMm: 900, orders: { create: [{ orderId: ob.id }] } },
  });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await db.integrationSetting.upsert({ where: { key: 'fx.daily' }, create: { key: 'fx.daily', value: { day: today, rate: 5.1 } }, update: { value: { day: today, rate: 5.1 } } });
  await db.$disconnect();
  orderU = ou.id;
  orderB = ob.id;
  crateId = crate.id;
});

test('yönetici: 10 adedin 2\'si kırık → onay 8 / 2; kalan 2 ileri güne aktarılır ve orada yalnızca 2 adetle görünür; fatura önizlemesi 8 adet', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(DAY_URL);
  const box = page.locator('#onay');
  await expect(box).toContainText('Onaylanmadı');
  // Yüklenmeyen cam girişi: sipariş satırı başına adet + neden
  await box.locator('#yuklenmeyen-giris > summary').click();
  const entry = box.locator('#yuklenmeyen-giris tr', { hasText: 'UNS7701' });
  await expect(entry.locator('td').nth(2)).toHaveText('10');
  await entry.locator('input.nl-qty').fill('2');
  await entry.locator('select').selectOption('BROKEN');
  await shot(page, 'yuklenmeyen-giris');
  await box.getByRole('button', { name: 'Eksiksiz Yüklendi' }).click();
  await expect(page).toHaveURL(/onay=ok/);
  await expect(box.locator('.alert-warn').first()).toContainText('yüklenmeyen adet kaydedildi');
  // Onay kaydı: yalnızca yüklenen 8 adet sayılır
  await expect(box.locator('tr.sub', { hasText: 'UNS7701' }).first().locator('td').nth(1)).toHaveText('8');
  // Yüklenmeyenler: planlanan 10 · yüklenen 8 · kalan 2 · Kırık · aktarılmadı
  const row = page.locator('#yuklenmeyen tbody tr', { hasText: 'UNS7701' });
  await expect(row.locator('td').nth(2)).toHaveText('10');
  await expect(row.locator('td').nth(3)).toHaveText('8');
  await expect(row.locator('td').nth(4)).toHaveText('2');
  await expect(row).toContainText('Kırık');
  await expect(row).toContainText('Aktarılmadı');
  // Fatura önizlemesi: yalnızca yüklenen 8 adet (400 EUR), kırık 2 adet yok
  const bill = page.locator(`#faturalama section.bill-customer[data-customer="${uns.id}"] tr.glass-row`).first();
  await expect(bill.locator('td').nth(1)).toHaveText('8');
  await expect(bill).toContainText('400,00');

  // Yeniden planla → ileri gün
  await row.locator('input[name=newDay]').fill(NEW_DAY);
  await row.getByRole('button', { name: 'Yeniden planla' }).click();
  await expect(page).toHaveURL(/aktar=planned/);
  await expect(page.locator('#yuklenmeyen .alert-ok')).toBeVisible();
  await expect(page.locator('#yuklenmeyen tbody tr', { hasText: 'UNS7701' })).toContainText(`${dmy(NEW_DAY)} yüklemesine aktarıldı`);
  await shot(page, 'yuklenmeyen-aktarildi');
  // Eski gün satırında not: 2 adet yüklenmedi → yeni gün
  await expect(page.locator('#gun tr', { hasText: 'UNS7701' }).first()).toContainText('2 adet yüklenmedi');

  // Yeni gün: sipariş yalnızca kalan 2 adetle, "… yüklemesinden aktarıldı" notuyla
  await page.goto(`/yuklemeler?gun=${NEW_DAY}`);
  const carried = page.locator('#gun tr.sub', { hasText: 'UNS7701' });
  await expect(carried).toContainText(`${dmy(DAY)} yüklemesinden aktarıldı`);
  await expect(carried.locator('td').nth(2)).toHaveText('2');
  await shot(page, 'aktarilan-kalan-yeni-gun');

  const db = await prisma();
  // Eski onay kaydı değişmedi: 8 yüklendi, 2 yüklenmedi
  const items = await db.loadingConfirmationItem.findMany({ where: { orderId: orderU }, orderBy: { status: 'asc' } });
  expect(items.map((i) => [i.status, i.quantity, i.notLoadedReason])).toEqual([['LOADED', 8, null], ['NOT_LOADED', 2, 'BROKEN']]);
  const replans = await db.loadingReplan.findMany({ where: { orderId: orderU } });
  expect(replans.map((r) => [r.status, r.quantity, r.customerId, r.shipDay.toISOString().slice(0, 10)])).toEqual([['ACTIVE', 2, uns.id, NEW_DAY]]);
  expect(await db.auditLog.count({ where: { action: 'REPLAN_NOT_LOADED', entityId: orderU } })).toBe(1);
  expect(await db.order.count({ where: { customerId: uns.id, customerOrderNo: 7701 } }), 'kopya sipariş açılmadı').toBe(1);
  await db.$disconnect();
  await page.context().close();
});

test('yönetici: sipariş başka müşterinin sandığına konur — müşterisi ve faturası değişmez; satış maskeli görür; müşteriler birbirinin verisini görmez', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(DAY_URL);
  // Sütunlar: 0 müşteri · 1 sipariş · 2 cam · 3 CNC · 4 delik · 5 metraj · 6 net kg · 7 sandık · 8 brüt kg
  const groupRow = (name: string) => page.locator('.card#gun tr.group-total', { hasText: name });
  const cells = async (row: ReturnType<typeof groupRow>) => (await row.locator('td').allInnerTexts()).slice(1, 9).map((s) => s.trim().split(/\s/)[0]);
  const foot = page.locator('.card#gun .load-table tfoot tr');
  // Yerleşimden önce: cam 20 kg/m² — Ünsal 10 m² = 200 kg (1 tahmini sandık, brüt 250); Beta 3 m² = 60 kg (kendi sandığı, brüt 110)
  expect(await cells(groupRow(uns.name))).toEqual(['1', '10', '–', '–', '10,00', '200', '1', '250']);
  expect(await cells(groupRow(beta.name))).toEqual(['1', '3', '–', '–', '3,00', '60', '1', '110']);
  expect(await cells(foot)).toEqual(['2', '13', '–', '–', '13,00', '260', '2', '360']);
  const guestBox = page.locator(`#gun .guest-box[data-owner="${uns.id}"]`);
  await guestBox.locator('.guest-assign > summary').click();
  await guestBox.locator('select[name=orderId]').selectOption(orderU);
  await guestBox.locator('select[name=crateId]').selectOption(crateId);
  await guestBox.getByRole('button', { name: 'Bu sandığa koy' }).click();
  await expect(page).toHaveURL(/sandik=assigned/);
  // Sipariş satırında fiziksel sandık + ev sahibi; ev sahibinin bölümünde misafir sipariş
  const orderRow = page.locator('#gun tr.sub', { hasText: 'UNS7701' }).first();
  await expect(orderRow.locator('.guest-badge')).toContainText(`#15 · ${beta.name}`);
  await expect(page.locator(`#gun .guest-box[data-owner="${uns.id}"] .guest-out`)).toContainText(`sipariş müşterisi: ${uns.name}`);
  await expect(page.locator(`#gun .guest-box[data-owner="${beta.id}"] .guest-in`)).toContainText('Sandık 15 ← UNS7701');
  // Fiziksel ağırlık ev sahibinin sandığında: Beta'nın sandığı artık 60 + 200 = 260 kg net, 310 kg brüt; Ünsal için ayrıca
  // sandık / ağırlık oluşmaz. Ticari sayılar değişmedi: Ünsal 1 sipariş · 10 cam · 10 m²; Beta 1 sipariş · 3 cam · 3 m².
  expect(await cells(groupRow(uns.name))).toEqual(['1', '10', '–', '–', '10,00', '0', '0', '0']);
  expect(await cells(groupRow(beta.name))).toEqual(['1', '3', '–', '–', '3,00', '260', '1', '310']);
  expect(await cells(foot), 'gün toplamı: cam ağırlığı aynı, tek sandık').toEqual(['2', '13', '–', '–', '13,00', '260', '1', '310']);
  await shot(page, 'baska-musterinin-sandigi');
  // Fatura: sipariş gerçek müşterisinin bölümünde; ev sahibinin faturasında yok
  await expect(page.locator(`#faturalama section.bill-customer[data-customer="${uns.id}"]`)).toContainText('Comanda UNS7701');
  await expect(page.locator(`#faturalama section.bill-customer[data-customer="${beta.id}"]`)).not.toContainText('UNS7701');
  // Yükleme dökümü (Excel): satırlar gerçek müşteride; fiziksel sandık sütununda ev sahibi; sevk ağırlığı fiziksel sandıktan
  const { readXlsx } = await import('../server/files/xlsx.js');
  const sheet = async (p: Page) => {
    const res = await p.request.get(`/yuklemeler/dokum?gun=${DAY}`);
    expect(res.status()).toBe(200);
    return readXlsx(await res.body()).rows as (string | number | null)[][];
  };
  const rows = await sheet(page);
  const stat = (k: string) => rows.find((r) => r[0] === k)?.[1];
  expect([stat('Cam ağırlığı'), stat('Sandık'), stat('Sevk ağırlığı')]).toEqual(['260 kg', '1', '310 kg']);
  const guestRow = rows.find((r) => r[0] === 'UNS7701')!;
  expect([guestRow[1], guestRow[4], guestRow[6], guestRow[9]]).toEqual([uns.name, 10, 10, `#15 (${beta.name})`]);
  const hostRow = rows.find((r) => r[0] === 'BET7702')!;
  expect([hostRow[1], hostRow[4], hostRow[6], hostRow[9]], 'ev sahibinin satırına misafir cam eklenmez').toEqual([beta.name, 3, 3, '#15']);
  const db = await prisma();
  expect((await db.order.findUniqueOrThrow({ where: { id: orderU } })).customerId).toBe(uns.id);
  expect((await db.crate.findUniqueOrThrow({ where: { id: crateId } })).customerId).toBe(beta.id);
  expect(await db.auditLog.count({ where: { action: 'CROSS_CUSTOMER_CRATE_ASSIGNED', entityId: orderU } })).toBe(1);
  await db.$disconnect();

  // Satış: ev sahibi adı maskeli; atama formu ve "Yeniden planla" yok
  const sales = await as(browser, SALES2, TEAM_PW);
  await sales.goto(DAY_URL);
  await expect(sales.locator('#gun tr.sub', { hasText: 'UNS7701' }).first().locator('.guest-badge')).toContainText(`#15 · ${beta.name.slice(0, 3)}**********`);
  await expect(sales.locator('.card#gun')).not.toContainText(beta.name);
  await expect(sales.locator('.guest-assign')).toHaveCount(0);
  await expect(sales.locator('#yuklenmeyen')).toContainText('UNS7701');
  await expect(sales.locator('#yuklenmeyen input[name=newDay]')).toHaveCount(0);
  const salesRows = (await (async () => {
    const res = await sales.request.get(`/yuklemeler/dokum?gun=${DAY}`);
    expect(res.status()).toBe(200);
    return readXlsx(await res.body()).rows as (string | number | null)[][];
  })());
  const salesGuest = salesRows.find((r) => r[0] === 'UNS7701')!;
  expect([salesGuest[1], salesGuest[9]], 'satış dökümünde adlar maskeli').toEqual([`${uns.name.slice(0, 3)}**********`, `#15 (${beta.name.slice(0, 3)}**********)`]);
  await sales.context().close();

  // Sipariş sahibi müşteri: kendi siparişi için yalnızca sandık numarası; ev sahibinin adı, siparişi, sandık ölçüsü yok
  const owner = await as(browser, CUSTOMER, CUST_PW);
  await owner.goto(DAY_URL);
  await expect(owner.locator('.load-table tr', { hasText: 'UNS7701' }).first().locator('.crate-nos')).toContainText('#15');
  const ownerHtml = await (await owner.request.get(DAY_URL)).text();
  for (const secret of [beta.name, 'BET7702', orderB]) expect(ownerHtml, `sipariş sahibi: ${secret}`).not.toContain(secret);
  await expect(owner.locator('.guest-box')).toHaveCount(0);
  await expect(owner.locator('.crate-table'), 'ev sahibinin sandık ölçüleri görünmez').toHaveCount(0);
  expect((await owner.request.get(`/siparisler/${orderB}`)).status()).toBe(404);
  await owner.context().close();

  // Ev sahibi müşteri: kendi sandığını görür; içindeki başka müşteri siparişinden hiçbir iz yok, o siparişe erişemez
  const host = await as(browser, BETA, TEAM_PW);
  await host.goto(DAY_URL);
  await expect(host.locator('.load-table .crate-table')).toContainText('2400');
  const hostHtml = await (await host.request.get(DAY_URL)).text();
  for (const secret of ['UNS7701', uns.name, orderU]) expect(hostHtml, `ev sahibi: ${secret}`).not.toContain(secret);
  expect((await host.request.get(`/siparisler/${orderU}`)).status()).toBe(404);
  await host.context().close();
  await page.context().close();
});

test('yetkisiz roller: taklit form gönderimiyle aktarım yapılamaz, sandık yerleşimi değiştirilemez', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const replanField = await actionField(admin, DAY_URL, 'name="newDay"');
  const guestField = await actionField(admin, DAY_URL, 'name="crateId"');
  const db = await prisma();
  const item = await db.loadingConfirmationItem.findFirstOrThrow({ where: { orderId: orderU, status: 'NOT_LOADED' } });
  const replanDays = async () => (await db.loadingReplan.findMany({ where: { orderId: orderU }, orderBy: { createdAt: 'asc' } })).map((r) => `${r.status}:${r.shipDay.toISOString().slice(0, 10)}`);
  const links = () => db.crateOrder.count({ where: { orderId: orderU, crateId } });
  for (const [who, email, pw] of [['musteri', CUSTOMER, CUST_PW], ['ev-sahibi', BETA, TEAM_PW], ['satis', SALES2, TEAM_PW], ['cizim', DRAWER, TEAM_PW], ['denetim', INSPECTOR, 'Denet1']] as const) {
    const p = await as(browser, email, pw);
    const r1 = await forge(p, DAY_URL, replanField, { day: DAY, itemId: item.id, quantity: '2', newDay: OTHER_DAY });
    expect(r1.url(), `${who}: taklit aktarım`).toMatch(/\/siparisler$/);
    const r2 = await forge(p, DAY_URL, guestField, { day: DAY, orderId: orderU, crateId, do: 'remove' });
    expect(r2.url(), `${who}: taklit sandık işlemi`).toMatch(/\/siparisler$/);
    expect(await replanDays(), `${who}: aktarım değişmedi`).toEqual([`ACTIVE:${NEW_DAY}`]);
    expect(await links(), `${who}: sandık yerleşimi değişmedi`).toBe(1);
    await p.context().close();
  }
  // Karşı kontrol: aynı istekler yönetici oturumuyla işlemi çalıştırır (engel yetki kontrolüdür)
  const again = await forge(admin, DAY_URL, replanField, { day: DAY, itemId: item.id, quantity: '2', newDay: NEW_DAY });
  expect(again.url()).toContain('aktarHata=ALREADY_PLANNED');
  const more = await forge(admin, DAY_URL, replanField, { day: DAY, itemId: item.id, quantity: '5', newDay: OTHER_DAY });
  expect(more.url(), 'kalandan fazlası aktarılamaz').toContain('aktarHata=BAD_QUANTITY');
  const dup = await forge(admin, DAY_URL, guestField, { day: DAY, orderId: orderU, crateId });
  expect(dup.url()).toContain('sandikHata=ALREADY_ASSIGNED');
  expect(await replanDays()).toEqual([`ACTIVE:${NEW_DAY}`]);
  expect(await db.billingBatch.count({ where: { customerId: { in: [uns.id, beta.id] } } }), 'hiçbir belge oluşmadı').toBe(0);
  await db.$disconnect();
  await admin.context().close();
});
