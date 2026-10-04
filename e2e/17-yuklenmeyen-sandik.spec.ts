import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, INSPECTOR_PW } from './helpers';

// Aşama 7E — yüklenmeyen camın ileri güne aktarılması (karar 102) ve başka müşterinin sandığına fiziksel yerleşim (karar 103, 124).
//  - onayda cam satırı başına yüklenmeyen adet + neden; onaylı günde "Yüklenmeyen camlar" ve "Yeniden planla"
//  - aktarılan kalan yeni günde yalnızca kendi adediyle görünür; eski onay kaydı değişmez; fatura yalnızca yüklenenden
//  - özel durum (karar 124): YÖNETİCİ sipariş sayfasında yalnızca ev sahibi FİRMAYI seçer; SANDIĞI Yüklemeler ekranında SATIŞ
//    seçer; o zamana kadar kırmızı "sandık seçimi bekliyor" uyarısı. Müşterisi / faturası değişmez; müşteriler birbirinin
//    verisini görmez; sandık seçilince iki firmaya bildirim
//  - yetki sunucuda: firma seçimi yalnızca yönetici; satış yalnızca o firmanın sandığını seçebilir (taklit istekler reddedilir)
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

test('özel durum: yönetici sipariş sayfasında FİRMAYI seçer (sandık / sipariş seçmez); satış Yüklemeler ekranında sandığı seçer — müşterisi ve faturası değişmez; satış maskeli görür; müşteriler birbirinin verisini görmez', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(DAY_URL);
  // Sütunlar: 0 müşteri · 1 sipariş · 2 cam · 3 CNC · 4 delik · 5 metraj · 6 net kg · 7 sandık · 8 brüt kg
  const groupRow = (name: string) => page.locator('.card#gun tr.group-total', { hasText: name });
  const cells = async (row: ReturnType<typeof groupRow>) => (await row.locator('td').allInnerTexts()).slice(1, 9).map((s) => s.trim().split(/\s/)[0]);
  const foot = page.locator('.card#gun .load-table tfoot tr');
  // Yerleşimden önce: cam 20 kg/m² — Ünsal 10 m² = 200 kg (1 tahmini sandık, brüt 250); Beta 3 m² = 60 kg (kendi sandığı, brüt 110)
  const before = [['1', '10', '–', '–', '10,00', '200', '1', '250'], ['1', '3', '–', '–', '3,00', '60', '1', '110'], ['2', '13', '–', '–', '13,00', '260', '2', '360']];
  expect([await cells(groupRow(uns.name)), await cells(groupRow(beta.name)), await cells(foot)]).toEqual(before);
  await expect(page.locator('#gun .guest-waiting')).toHaveCount(0);

  // --- 1. Yönetici, sipariş sayfasında (teklif tablosunun hemen altında) yalnızca FİRMAYI seçer
  await page.goto(`/siparisler/${orderU}`);
  const special = page.locator('#ozel-durum');
  await expect(special.locator('label.check')).toContainText('Özel durum — başka firmanın yüklemesiyle gidecek');
  expect(await page.evaluate(() => {
    const offer = document.querySelector('#teklif');
    const box = document.querySelector('#ozel-durum');
    return !!offer && !!box && offer.nextElementSibling === box;
  }), 'özel durum kutusu teklif tablosunun hemen altında').toBe(true);
  // Kapalıyken yalnızca işaret kutusu: firma listesi yok
  await expect(special.locator('input[name=on]')).not.toBeChecked();
  await expect(special.locator('select')).toHaveCount(0);
  await special.locator('input[name=on]').check();
  const options = await special.locator('select#guest-host option').allInnerTexts();
  expect(options.filter((o) => o === beta.name), 'aynı yükleme gününün firması listede BİR kez').toHaveLength(1);
  expect(options.some((o) => o.includes(uns.name)), 'siparişin kendi firması listede yok').toBe(false);
  expect(options.some((o) => /BET7702|UNS7701|Sandık \d/.test(o)), 'listede sipariş / sandık yok: yalnızca firma').toBe(false);
  await expect(special.locator('select[name=crateId], select[name=orderId]'), 'yönetici sipariş ya da sandık seçmez').toHaveCount(0);
  await special.locator('select#guest-host').selectOption({ label: beta.name });
  await special.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page).toHaveURL(/ozel=set/);
  await expect(special.locator('.alert-ok')).toContainText('Özel durum kaydedildi');
  await expect(special.locator('.badge-danger')).toContainText('Sandık seçimi bekliyor');
  await shot(page, 'ozel-durum-firma-secimi');
  let db = await prisma();
  expect((await db.order.findUniqueOrThrow({ where: { id: orderU } })).guestHostId).toBe(beta.id);
  expect(await db.crateOrder.count({ where: { orderId: orderU } }), 'firma seçimi sandık atamaz').toBe(0);
  await db.$disconnect();

  // --- 2. Yüklemeler: kırmızı "sandık seçimi bekliyor" uyarısı; sayılar henüz değişmedi (hiçbir sandık kendiliğinden atanmaz)
  await page.goto(DAY_URL);
  const waiting = page.locator('#gun .guest-waiting');
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toHaveClass(/alert-error/);
  await expect(waiting).toContainText('Özel durum — sandık seçimi bekliyor');
  await expect(waiting).toContainText(`UNS7701 · ${uns.name}`);
  await expect(waiting).toContainText(`Hedef firma: ${beta.name}`);
  expect([await cells(groupRow(uns.name)), await cells(groupRow(beta.name)), await cells(foot)]).toEqual(before);
  await shot(page, 'ozel-durum-sandik-bekliyor');

  // --- 3. Satış: misafir yük ev sahibi firmanın sandık bölümünde kendiliğinden görünür; satış o firmanın sandığını seçer
  const sales = await as(browser, SALES2, TEAM_PW);
  await sales.goto(DAY_URL);
  const mask = (name: string) => `${name.slice(0, 3)}**********`;
  await expect(sales.locator('#gun .guest-waiting')).toContainText(`Hedef firma: ${mask(beta.name)}`);
  const pick = sales.locator(`#gun .guest-box[data-owner="${beta.id}"] form.guest-in[data-order="${orderU}"]`);
  await expect(sales.locator(`#gun .guest-box[data-owner="${beta.id}"]`)).toContainText('ÖZEL DURUM / MİSAFİR YÜK');
  await expect(pick).toContainText(`UNS7701 · ${mask(uns.name)}`);
  expect(await pick.locator('select[name=crateId] option').allInnerTexts(), 'yalnızca ev sahibi firmanın o günkü sandıkları').toEqual(['— sandık seçimi bekliyor —', '15']);
  await expect(pick.locator('select[name=crateId]')).toHaveValue('');
  await pick.locator('select[name=crateId]').selectOption(crateId);
  await pick.getByRole('button', { name: 'Kaydet' }).click();
  await expect(sales).toHaveURL(/sandik=assigned/);
  await expect(sales.locator('#gun .guest-waiting')).toHaveCount(0);
  await expect(sales.locator(`#gun .guest-box[data-owner="${beta.id}"] form.guest-in[data-order="${orderU}"] select[name=crateId]`)).toHaveValue(crateId);
  // Satış sipariş sayfasında "özel durum" denetimini görmez (firma kararı yöneticinin)
  await sales.goto(`/siparisler/${orderU}`);
  await expect(sales.locator('body')).toContainText('UNS7701');
  await expect(sales.locator('#ozel-durum')).toHaveCount(0);
  await sales.context().close();

  // --- 4. Yönetici: sipariş satırında fiziksel sandık + ev sahibi; ev sahibinin bölümünde misafir yük; sipariş sayfasında sandık
  await page.goto(DAY_URL);
  await expect(page.locator('#gun .guest-waiting')).toHaveCount(0);
  const orderRow = page.locator('#gun tr.sub', { hasText: 'UNS7701' }).first();
  await expect(orderRow.locator('.guest-badge')).toContainText(`#15 · ${beta.name}`);
  await expect(page.locator(`#gun .guest-box[data-owner="${uns.id}"] .guest-out`)).toContainText(`sipariş müşterisi: ${uns.name}`);
  await expect(page.locator(`#gun .guest-box[data-owner="${beta.id}"] form.guest-in[data-order="${orderU}"]`)).toContainText(`UNS7701 · ${uns.name}`);
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
  db = await prisma();
  expect((await db.order.findUniqueOrThrow({ where: { id: orderU } })).customerId).toBe(uns.id);
  expect((await db.crate.findUniqueOrThrow({ where: { id: crateId } })).customerId).toBe(beta.id);
  expect(await db.auditLog.count({ where: { action: 'CROSS_CUSTOMER_CRATE_ASSIGNED', entityId: orderU } })).toBe(1);
  expect(await db.auditLog.count({ where: { action: 'CROSS_CUSTOMER_HOST_SET', entityId: orderU } })).toBe(1);
  // Sandık seçimi iki firmaya bildirilecek: tek olay (işçi dağıtır); ticari kayıt yok
  expect(await db.notificationOutbox.count({ where: { orderId: orderU, type: 'GUEST_CRATE_ASSIGNED' } })).toBe(1);
  await db.$disconnect();
  await page.goto(`/siparisler/${orderU}`);
  await expect(page.locator('#ozel-durum .badge-ok')).toContainText('Sandık 15');
  // Nakliye listesi (PDF): yönetici indirir — misafir yük sandığın altında yazılır (içerik birim testinde)
  const pdf = await page.request.get(`/yuklemeler/nakliye?gun=${DAY}`);
  expect([pdf.status(), pdf.headers()['content-type']]).toEqual([200, 'application/pdf']);

  // Satış: ev sahibi adı maskeli; firma seçimi ve "Yeniden planla" yok
  const salesPage = await as(browser, SALES2, TEAM_PW);
  await salesPage.goto(DAY_URL);
  await expect(salesPage.locator('#gun tr.sub', { hasText: 'UNS7701' }).first().locator('.guest-badge')).toContainText(`#15 · ${beta.name.slice(0, 3)}**********`);
  await expect(salesPage.locator('.card#gun')).not.toContainText(beta.name);
  await expect(salesPage.locator('#gun select#guest-host, #gun select[name=hostId]'), 'satış firma seçemez').toHaveCount(0);
  await expect(salesPage.locator('#yuklenmeyen')).toContainText('UNS7701');
  await expect(salesPage.locator('#yuklenmeyen input[name=newDay]')).toHaveCount(0);
  const salesRows = (await (async () => {
    const res = await salesPage.request.get(`/yuklemeler/dokum?gun=${DAY}`);
    expect(res.status()).toBe(200);
    return readXlsx(await res.body()).rows as (string | number | null)[][];
  })());
  const salesGuest = salesRows.find((r) => r[0] === 'UNS7701')!;
  expect([salesGuest[1], salesGuest[9]], 'satış dökümünde adlar maskeli').toEqual([`${uns.name.slice(0, 3)}**********`, `#15 (${beta.name.slice(0, 3)}**********)`]);
  await salesPage.context().close();

  // Sipariş sahibi müşteri: kendi siparişi için yalnızca sandık numarası; ev sahibinin adı, siparişi, sandık ölçüsü yok
  const owner = await as(browser, CUSTOMER, CUST_PW);
  await owner.goto(DAY_URL);
  await expect(owner.locator('.load-table tr', { hasText: 'UNS7701' }).first().locator('.crate-nos')).toContainText('#15');
  const ownerHtml = await (await owner.request.get(DAY_URL)).text();
  for (const secret of [beta.name, 'BET7702', orderB, beta.id]) expect(ownerHtml, `sipariş sahibi: ${secret}`).not.toContain(secret);
  await expect(owner.locator('.guest-box')).toHaveCount(0);
  await expect(owner.locator('.guest-waiting')).toHaveCount(0);
  // Sipariş sayfasında "özel durum" denetimi müşteride yok; ev sahibi firmanın adı / kimliği sayfada bulunmaz
  await owner.goto(`/siparisler/${orderU}`);
  await expect(owner.locator('body')).toContainText('UNS7701');
  await expect(owner.locator('#ozel-durum')).toHaveCount(0);
  const ownerOrderHtml = await (await owner.request.get(`/siparisler/${orderU}`)).text();
  for (const secret of [beta.name, beta.id]) expect(ownerOrderHtml, `sipariş sayfası: ${secret}`).not.toContain(secret);
  await expect(owner.locator('.crate-table'), 'ev sahibinin sandık ölçüleri görünmez').toHaveCount(0);
  expect((await owner.request.get(`/siparisler/${orderB}`)).status()).toBe(404);
  await owner.context().close();

  // Ev sahibi müşteri: kendi sandığını görür; içindeki başka müşteri siparişinden hiçbir iz yok, o siparişe erişemez
  const host = await as(browser, BETA, TEAM_PW);
  await host.goto(DAY_URL);
  await expect(host.locator('.load-table .crate-table')).toContainText('2400');
  const hostHtml = await (await host.request.get(DAY_URL)).text();
  for (const secret of ['UNS7701', uns.name, orderU]) expect(hostHtml, `ev sahibi: ${secret}`).not.toContain(secret);
  // Sandık paylaşımı siparişe erişim vermez (IDOR yok): sipariş, teklif PDF'i ve dosyaları ev sahibine kapalı
  expect((await host.request.get(`/siparisler/${orderU}`)).status()).toBe(404);
  expect((await host.request.get(`/siparisler/${orderU}/teklif`)).status(), 'misafir siparişin teklifi').not.toBe(200);
  await host.context().close();
  // Denetimci: salt okunur — firma seçimi denetimi yok
  const inspector = await as(browser, INSPECTOR, INSPECTOR_PW);
  await inspector.goto(`/siparisler/${orderU}`);
  await expect(inspector.locator('body')).toContainText('UNS7701');
  await expect(inspector.locator('#ozel-durum')).toHaveCount(0);
  await inspector.context().close();
  await page.context().close();
});

test('yetkisiz roller: taklit form gönderimiyle aktarım yapılamaz, ev sahibi firma seçilemez / değiştirilemez; satış yalnızca o firmanın sandığını seçebilir', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const replanField = await actionField(admin, DAY_URL, 'name="newDay"');
  const guestField = await actionField(admin, DAY_URL, 'name="crateId"');
  const hostField = await actionField(admin, `/siparisler/${orderU}`, 'id="ozel-durum"');
  const db = await prisma();
  const item = await db.loadingConfirmationItem.findFirstOrThrow({ where: { orderId: orderU, status: 'NOT_LOADED' } });
  const replanDays = async () => (await db.loadingReplan.findMany({ where: { orderId: orderU }, orderBy: { createdAt: 'asc' } })).map((r) => `${r.status}:${r.shipDay.toISOString().slice(0, 10)}`);
  const links = () => db.crateOrder.count({ where: { orderId: orderU, crateId } });
  const hostOf = async () => (await db.order.findUniqueOrThrow({ where: { id: orderU } })).guestHostId;
  // Başka bir firmanın (ev sahibi OLMAYAN) aynı günkü sandığı: satış taklit istekle bunu seçemez
  const third = await db.customer.findFirstOrThrow({ where: { type: 'CUSTOMER', id: { notIn: [uns.id, beta.id] } } });
  const foreign = await db.crate.create({ data: { shipDay: new Date(`${DAY}T00:00:00Z`), customerId: third.id, crateNo: 99 } });
  for (const [who, email, pw] of [['musteri', CUSTOMER, CUST_PW], ['ev-sahibi', BETA, TEAM_PW], ['satis', SALES2, TEAM_PW], ['cizim', DRAWER, TEAM_PW], ['denetim', INSPECTOR, INSPECTOR_PW]] as const) {
    const p = await as(browser, email, pw);
    const r1 = await forge(p, DAY_URL, replanField, { day: DAY, itemId: item.id, quantity: '2', newDay: OTHER_DAY });
    expect(r1.url(), `${who}: taklit aktarım`).toMatch(/\/siparisler$/);
    // Ev sahibi firmayı seçmek / değiştirmek / kaldırmak yalnızca yöneticinin: satış dahil herkes reddedilir
    const attempts: Record<string, string>[] = [{ orderId: orderU, on: 'on', hostId: third.id }, { orderId: orderU }];
    for (const data of attempts) {
      const rh = await forge(p, `/siparisler/${orderU}`, hostField, data);
      expect(rh.url(), `${who}: taklit firma seçimi`).toMatch(/\/siparisler$/);
    }
    expect(await hostOf(), `${who}: ev sahibi firma değişmedi`).toBe(beta.id);
    if (who === 'satis') {
      // Satış sandık seçebilir ama yalnızca yöneticinin seçtiği firmanın sandığını: başka firmanın sandığı reddedilir
      const rf = await forge(p, DAY_URL, guestField, { day: DAY, orderId: orderU, crateId: foreign.id, current: crateId });
      expect(rf.url(), 'satış: başka firmanın sandığı').toContain('sandikHata=NOT_HOST_CRATE');
      // Firması seçilmemiş siparişi (BET7702) başka firmanın sandığına koyamaz
      const rn = await forge(p, DAY_URL, guestField, { day: DAY, orderId: orderB, crateId: foreign.id });
      expect(rn.url(), 'satış: firması seçilmemiş sipariş').toContain('sandikHata=NO_HOST');
    } else {
      const r2 = await forge(p, DAY_URL, guestField, { day: DAY, orderId: orderU, crateId, do: 'remove' });
      expect(r2.url(), `${who}: taklit sandık işlemi`).toMatch(/\/siparisler$/);
    }
    expect(await replanDays(), `${who}: aktarım değişmedi`).toEqual([`ACTIVE:${NEW_DAY}`]);
    expect(await links(), `${who}: sandık yerleşimi değişmedi`).toBe(1);
    expect(await db.crateOrder.count({ where: { crateId: foreign.id } }), `${who}: başka firmanın sandığına hiçbir şey konmadı`).toBe(0);
    await p.context().close();
  }
  await db.crate.delete({ where: { id: foreign.id } });
  // Karşı kontrol: aynı istekler yönetici oturumuyla işlemi çalıştırır (engel yetki kontrolüdür)
  const again = await forge(admin, DAY_URL, replanField, { day: DAY, itemId: item.id, quantity: '2', newDay: NEW_DAY });
  expect(again.url()).toContain('aktarHata=ALREADY_PLANNED');
  const more = await forge(admin, DAY_URL, replanField, { day: DAY, itemId: item.id, quantity: '5', newDay: OTHER_DAY });
  expect(more.url(), 'kalandan fazlası aktarılamaz (kalanın tamamı zaten aktarılmış)').toContain('aktarHata=NO_REMAINDER');
  // Aynı sandığı yeniden seçmek değişiklik değildir: hata da, ikinci bildirim olayı da üretmez
  const dup = await forge(admin, DAY_URL, guestField, { day: DAY, orderId: orderU, crateId });
  expect(dup.url()).not.toContain('sandikHata');
  expect(await db.notificationOutbox.count({ where: { orderId: orderU, type: 'GUEST_CRATE_ASSIGNED' } })).toBe(1);
  expect(await links()).toBe(1);
  // Bu testin bildirim olayları sonraki testlerin bildirim sayılarına karışmasın (dağıtım kuralları veritabanı testlerinde)
  await db.notificationOutbox.updateMany({ where: { orderId: orderU, type: { in: ['GUEST_CRATE_ASSIGNED', 'GUEST_CRATE_REMOVED'] }, inAppAt: null }, data: { inAppAt: new Date() } });
  expect(await replanDays()).toEqual([`ACTIVE:${NEW_DAY}`]);
  expect(await db.billingBatch.count({ where: { customerId: { in: [uns.id, beta.id] } } }), 'hiçbir belge oluşmadı').toBe(0);
  await db.$disconnect();
  await admin.context().close();
});
