import { test, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, INSPECTOR_PW, firmOf, openFirm, reportSheet, summaryBlock } from './helpers';

// Aşama 7E — yüklenmeyen camın ileri güne aktarılması (karar 102) ve başka müşterinin sandığına fiziksel yerleşim (karar 103, 124),
// Paket 7 firma tablosu ve misafir yük kuralları (karar 186–189).
//  - "Yükleme yapıldı" önizlemedeki her şeyi kaydeder (onayda yüklenmeyen cam girişi yok); kırık cam sonra "Düzelt" ile;
//    onaylı günde "Yüklenmeyen camlar" ve "Yeniden planla"
//  - aktarılan kalan yeni günde yalnızca kendi adediyle görünür; eski onay kaydı değişmez; fatura yalnızca yüklenenden
//  - özel durum (karar 124): YÖNETİCİ sipariş sayfasında yalnızca ev sahibi FİRMAYI seçer; SANDIĞI Yüklemeler ekranında SATIŞ
//    seçer; o zamana kadar kırmızı "sandık seçimi bekliyor" uyarısı. Sipariş ticari sahibinin satırında kalır; sandık ve ağırlık
//    ev sahibinde (bir kez); sahibine sandık açılmaz ("+ Sandık ekle" kapalı, sunucu da reddeder); müşteriler birbirinin
//    verisini görmez; sandık seçilince iki firmaya bildirim; ilişki kaldırılınca normal sandık yönetimi
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
      // Teklif tutarları satırlardan: fabrika satış 37 / m², müşteri fiyatı 50 / m² (1 m² cam)
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: (pieces * 37).toFixed(2), offerAmount: (pieces * 50).toFixed(2), createdById: admin.id, sentAt: new Date(),
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

test('yönetici: "Yükleme yapıldı" hepsini kaydeder; 10 adedin 2\'si kırık → "Düzelt" ile 8 / 2; kalan 2 ileri güne aktarılır ve orada yalnızca 2 adetle görünür; fatura önizlemesi 8 adet', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(DAY_URL);
  const box = page.locator('#onay');
  await expect(box).toContainText('Onaylanmadı');
  // Paket 7: onayda "Yüklenmeyen cam var" girişi yok — "Yükleme yapıldı" önizlemedeki her şeyi YÜKLENDİ olarak kaydeder
  await expect(box.locator('#yuklenmeyen-giris')).toHaveCount(0);
  await expect(box.locator('input.nl-qty')).toHaveCount(0);
  await expect(box).not.toContainText('Yüklenmeyen cam var');
  await expect(box.getByRole('button', { name: 'Eksiksiz Yüklendi' })).toHaveCount(0);
  await box.getByRole('button', { name: 'Yükleme yapıldı' }).click();
  await expect(page).toHaveURL(/onay=ok/);
  await expect(box.locator('.alert-ok').first()).toContainText('Yükleme yapıldı olarak kaydedildi');
  await expect(box.locator('tr.sub', { hasText: 'UNS7701' }).first().locator('td').nth(1)).toHaveText('10');
  // Kırık 2 adet kayıttan sonra "Düzelt" ile girilir (onay kaydı değişmez; düzeltme ayrı kayıt)
  await box.locator('#duzelt-giris > summary').click();
  const entry = box.locator('#duzelt-giris tr', { hasText: 'UNS7701' });
  await expect(entry.locator('td').nth(2)).toHaveText('10');
  await entry.locator('input.nl-qty').fill('2');
  await entry.locator('select').selectOption('BROKEN');
  await box.locator('#duzelt-giris input[name=reason]').fill('2 cam kırık çıktı');
  await shot(page, 'yuklenmeyen-giris');
  await box.getByRole('button', { name: 'Önizle' }).click();
  await expect(page).toHaveURL(/dz=/);
  await page.locator('#duzelt-onizleme').getByRole('button', { name: 'Düzeltmeyi kaydet' }).click();
  await expect(page).toHaveURL(/duzeltme=ok&rev=1/);
  // Geçerli durum: yalnızca yüklenen 8 adet sayılır
  await expect(box.locator('table.confirm-table').first().locator('tr.sub', { hasText: 'UNS7701' }).first().locator('td').nth(1)).toHaveText('8');
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
  // Eski gün: firmanın alt sipariş satırında not — 2 adet yüklenmedi → yeni gün
  const oldDay = await openFirm(firmOf(page, uns.name));
  await expect(oldDay.locator(`tr[data-order="${orderU}"]`).first()).toContainText('2 adet yüklenmedi');

  // Yeni gün: sipariş yalnızca kalan 2 adetle, "… yüklemesinden aktarıldı" notuyla (firma satırı ve alt sipariş aynı sayı)
  await page.goto(`/yuklemeler?gun=${NEW_DAY}`);
  const carried = (await openFirm(firmOf(page, uns.name))).locator(`tr[data-order="${orderU}"]`);
  await expect(carried).toContainText(`${dmy(DAY)} yüklemesinden aktarıldı`);
  await expect(carried.locator('td').nth(1)).toHaveText('2');
  await shot(page, 'aktarilan-kalan-yeni-gun');

  const db = await prisma();
  // Onay anındaki kayıt değişmedi (10 yüklendi); düzeltme yeni kayıt ekledi: geçerli durum 8 yüklendi, 2 yüklenmedi
  const items = await db.loadingConfirmationItem.findMany({ where: { orderId: orderU }, orderBy: [{ revision: 'asc' }, { status: 'asc' }] });
  expect(items.map((i) => [i.revision, i.status, i.quantity, i.notLoadedReason])).toEqual([[0, 'LOADED', 10, null], [1, 'LOADED', 8, null], [1, 'NOT_LOADED', 2, 'BROKEN']]);
  // "Yükleme yapıldı" sipariş durumunu değiştirmez (otomatik "Yüklendi" yok)
  expect((await db.order.findUniqueOrThrow({ where: { id: orderU } })).status).toBe('URETIMDE');
  const replans = await db.loadingReplan.findMany({ where: { orderId: orderU } });
  expect(replans.map((r) => [r.status, r.quantity, r.customerId, r.shipDay.toISOString().slice(0, 10)])).toEqual([['ACTIVE', 2, uns.id, NEW_DAY]]);
  expect(await db.auditLog.count({ where: { action: 'REPLAN_NOT_LOADED', entityId: orderU } })).toBe(1);
  expect(await db.order.count({ where: { customerId: uns.id, customerOrderNo: 7701 } }), 'kopya sipariş açılmadı').toBe(1);
  await db.$disconnect();
  await page.context().close();
});

test('özel durum: yönetici sipariş sayfasında FİRMAYI seçer (sandık / sipariş seçmez); satış Yüklemeler ekranında sandığı seçer — sipariş ticari sahibinin satırında, sandık ve ağırlık ev sahibinde; sahibine sandık açılmaz; satış maskeli görür; müşteriler birbirinin verisini görmez', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(DAY_URL);
  // Firma satırının sayı sütunları (data-col): sipariş · cam · CNC · delik · m² · net kg · sandık · brüt kg (tutarlar ayrı sütunlarda)
  const COLS = ['orders', 'glass', 'cnc', 'holes', 'm2', 'net', 'crates', 'gross'];
  const cells = async (row: Locator) => Promise.all(COLS.map(async (c) => (await row.locator(`td[data-col="${c}"]`).innerText()).trim().split(/\s/)[0]));
  const firmRow = (p: Page, name: string) => firmOf(p, name).locator('tr.firm-row');
  const foot = (p: Page) => p.locator('.card#gun .firm-table > tfoot tr');
  const numbers = async (p: Page, a: string, b: string) => [await cells(firmRow(p, a)), await cells(firmRow(p, b)), await cells(foot(p))];
  // Yerleşimden önce: cam 20 kg/m² — Ünsal 10 m² = 200 kg (1 tahmini sandık, brüt 250); Beta 3 m² = 60 kg (kendi sandığı, brüt 110)
  const before = [['1', '10', '–', '–', '10,000', '200', '1', '250'], ['1', '3', '–', '–', '3,000', '60', '1', '110'], ['2', '13', '–', '–', '13,000', '260', '2', '360']];
  // Ev sahibi seçildikten sonra (sandık seçilmeden de): sipariş Ünsal'ın satırında kalır (1 sipariş · 10 cam · 10 m²); camı Beta'nın
  // sandıklarıyla gider — ağırlık Beta'da, Ünsal'a sandık açılmaz; gün toplamında tek sandık, cam ağırlığı bir kez
  const hosted = [['1', '10', '–', '–', '10,000', '0', '0', '0'], ['1', '3', '–', '–', '3,000', '260', '1', '310'], ['2', '13', '–', '–', '13,000', '260', '1', '310']];
  expect(await numbers(page, uns.name, beta.name)).toEqual(before);
  await expect(page.locator('#gun .guest-waiting')).toHaveCount(0);
  await expect(page.locator('.cal-day.sel .cal-count')).toHaveText('2');
  await expect(page.locator('.cal-day.sel .cal-guests'), 'misafir yük yok: kırmızı gösterge yok').toHaveCount(0);

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

  // --- 2. Yüklemeler: kırmızı "sandık seçimi bekliyor" uyarısı; hiçbir sandık kendiliğinden atanmaz. Sipariş Ünsal'ın satırında
  // kalır, ağırlığı ev sahibine yazılır (Ünsal için tahmini sandık açılmaz); takvimde kırmızı misafir göstergesi
  await page.goto(DAY_URL);
  const waiting = page.locator('#gun .guest-waiting');
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toHaveClass(/alert-error/);
  await expect(waiting).toContainText('Özel durum — sandık seçimi bekliyor');
  await expect(waiting).toContainText(`UNS7701 · ${uns.name}`);
  await expect(waiting).toContainText(`Hedef firma: ${beta.name}`);
  expect(await numbers(page, uns.name, beta.name)).toEqual(hosted);
  await expect(firmRow(page, uns.name).locator('[data-guest-out="1"]')).toContainText(`1 sipariş başka firmanın sandığıyla: ${beta.name}`);
  await expect(firmRow(page, uns.name).locator('.guest-badge')).toContainText('1 misafir yük sandık bekliyor');
  await expect(firmRow(page, beta.name).locator('[data-guest-in="1"]')).toContainText('+1 misafir yük bu firmanın sandıklarında');
  await expect(page.locator('.cal-day.sel .cal-guests')).toHaveText('1');
  await expect(page.locator('.cal-day.sel .cal-guests')).toHaveAttribute('title', 'Misafir yük: 1 sipariş');
  await shot(page, 'ozel-durum-sandik-bekliyor');

  // --- 3. Satış: uyarıdaki bağlantı ev sahibi firmanın sandık bölümünü açar; misafir yük orada; satış o firmanın sandığını seçer
  const sales = await as(browser, SALES2, TEAM_PW);
  await sales.goto(DAY_URL);
  const mask = (name: string) => `${name.slice(0, 3)}**********`;
  const salesWaiting = sales.locator('#gun .guest-waiting');
  await expect(salesWaiting).toContainText(`Hedef firma: ${mask(beta.name)}`);
  await expect(salesWaiting).toContainText(`UNS7701 · ${mask(uns.name)}`);
  // Misafir siparişin kendi firması: açık uyarı; bu firmaya sandık açılmaz ("+ Sandık ekle" kapalı)
  const own = await openFirm(firmOf(sales, mask(uns.name)), 'crates');
  const note = own.locator(`.guest-note[data-order="${orderU}"]`);
  await expect(note).toContainText(`UNS7701 — Bu sipariş ${mask(beta.name)} firmasının sandıkları ile gelecektir.`);
  await expect(note).toContainText('Sandık seçimi bekliyor');
  await expect(own.getByRole('button', { name: '+ Sandık ekle' })).toBeDisabled();
  await expect(own.locator('.crate-locked')).toContainText('"+ Sandık ekle" kapalı');
  // Sunucu da reddeder: formun gizli alanı değiştirilip gönderilse de misafir sipariş bu firmanın sandığına konamaz ve bu firmaya
  // yeni sandık açılamaz
  const forgeCrates = (rows: object[]) => own.locator('form.crate-editor').evaluate((f: HTMLFormElement, json: string) => {
    (f.querySelector('input[name=rows]') as HTMLInputElement).value = json;
    f.requestSubmit();
  }, JSON.stringify(rows));
  const crateRow = (orderIds: string[]) => ({ crateNo: '31', lengthMm: '2400', widthMm: '800', heightMm: '900', netKg: '', grossKg: '', note: '', orderIds });
  // Formdan gelen sipariş seçimi yok sayılır (karar 234): misafir siparişi gizli alana yazmak da sandığa bağlamaz
  await forgeCrates([crateRow([orderU])]);
  await expect(own.locator('.crate-editor .alert-error')).toContainText('yeni sandık açılamaz');
  await forgeCrates([crateRow([])]);
  await expect(own.locator('.crate-editor .alert-error')).toContainText('yeni sandık açılamaz');
  db = await prisma();
  expect(await db.crate.count({ where: { customerId: uns.id, shipDay: new Date(`${DAY}T00:00:00Z`) } }), 'misafir siparişin firmasına sandık açılmadı').toBe(0);
  await db.$disconnect();
  await salesWaiting.getByRole('link', { name: 'Ev sahibi firmanın sandıklarını aç →' }).click();
  await expect(sales).toHaveURL(new RegExp(`acik=${beta.id}`));
  const hostBox = sales.locator(`.firm-crates-box[data-owner="${beta.id}"]`);
  await expect(hostBox).toBeVisible();
  const pick = hostBox.locator(`.guest-box form.guest-in[data-order="${orderU}"]`);
  await expect(hostBox.locator('.guest-box')).toContainText('ÖZEL DURUM / MİSAFİR YÜK');
  await expect(pick).toContainText(`UNS7701 · ${mask(uns.name)}`);
  await expect(pick).toContainText('10 cam · 10,000 m²');
  expect(await pick.locator('select[name=crateId] option').allInnerTexts(), 'yalnızca ev sahibi firmanın o günkü sandıkları').toEqual(['— sandık seçimi bekliyor —', '15']);
  await expect(pick.locator('select[name=crateId]')).toHaveValue('');
  await pick.locator('select[name=crateId]').selectOption(crateId);
  await pick.getByRole('button', { name: 'Kaydet' }).click();
  await expect(sales).toHaveURL(/sandik=assigned/);
  await expect(sales.locator('#gun .guest-waiting')).toHaveCount(0);
  await expect(sales.locator(`.firm-crates-box[data-owner="${beta.id}"] .guest-box form.guest-in[data-order="${orderU}"] select[name=crateId]`)).toHaveValue(crateId);
  // Ev sahibinin sandık listesinde misafir camın sipariş / cam bilgisi (sandık 15'in satırında); sandık silinemez
  await expect(sales.locator(`.firm-crates-box[data-owner="${beta.id}"] .crate-guests[data-crate="15"]`)).toContainText(`Misafir yük: UNS7701 · ${mask(uns.name)} · 10 cam · 10,000 m²`);
  // Satış sipariş sayfasında "özel durum" denetimini görmez (firma kararı yöneticinin)
  await sales.goto(`/siparisler/${orderU}`);
  await expect(sales.locator('body')).toContainText('UNS7701');
  await expect(sales.locator('#ozel-durum')).toHaveCount(0);
  await sales.context().close();

  // --- 4. Yönetici: alt siparişte fiziksel sandık + ev sahibi; sahibinin sandık bölümünde açık uyarı; ev sahibinin bölümünde misafir yük
  await page.goto(DAY_URL);
  await expect(page.locator('#gun .guest-waiting')).toHaveCount(0);
  const uOrders = await openFirm(firmOf(page, uns.name));
  await expect(uOrders.locator(`tr[data-order="${orderU}"] .guest-badge`)).toContainText(`#15 · ${beta.name}`);
  const uCrates = await openFirm(firmOf(page, uns.name), 'crates');
  await expect(uCrates.locator(`.guest-note[data-order="${orderU}"]`)).toContainText(`Bu sipariş ${beta.name} firmasının sandıkları ile gelecektir.`);
  await expect(uCrates.locator(`.guest-note[data-order="${orderU}"]`)).toContainText('Sandık 15');
  await expect(uCrates.getByRole('button', { name: '+ Sandık ekle' })).toBeDisabled();
  const bCrates = await openFirm(firmOf(page, beta.name), 'crates');
  await expect(bCrates.locator(`.guest-box form.guest-in[data-order="${orderU}"]`)).toContainText(`UNS7701 · ${uns.name}`);
  await expect(bCrates.locator('.crate-guests[data-crate="15"]')).toContainText(`Misafir yük: UNS7701 · ${uns.name} · 10 cam · 10,000 m²`);
  // Fiziksel ağırlık ev sahibinin sandığında (60 + 200 = 260 kg net, 310 kg brüt); Ünsal için ayrıca sandık / ağırlık oluşmaz.
  // Ticari sayılar değişmedi. Aynı sandık bir kez sayılır, brüt iki kez hesaplanmaz.
  expect(await numbers(page, uns.name, beta.name)).toEqual(hosted);
  // Ana satır = alt siparişlerin toplamı
  await expect(uOrders.locator('tfoot')).toContainText('Toplam · 1 sipariş');
  expect((await uOrders.locator('tfoot td').allInnerTexts()).slice(1, 5).map((s) => s.trim())).toEqual(['10', '–', '–', '10,000']);
  await shot(page, 'baska-musterinin-sandigi');
  // Fatura: sipariş gerçek müşterisinin bölümünde; ev sahibinin faturasında yok
  await expect(page.locator(`#faturalama section.bill-customer[data-customer="${uns.id}"]`)).toContainText('Comanda UNS7701');
  await expect(page.locator(`#faturalama section.bill-customer[data-customer="${beta.id}"]`)).not.toContainText('UNS7701');

  // Yükleme Özeti (Excel): firma bazlı özet — misafir sipariş ticari sahibinin satırında, sandık ve ağırlık ev sahibinde; fiziksel
  // sandık ilişkisi ayrı tabloda; "Sandık (Fiziksel)" sütunu yok; sipariş blokları aynı sayfada gerçek müşteride (karar 233)
  const { readXlsx } = await import('../server/files/xlsx.js');
  type Rows = (string | number | null)[][];
  const summary = async (p: Page) => {
    const res = await p.request.get(`/yuklemeler/dokum?gun=${DAY}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toContain(`filename="Yukleme-Ozeti-${DAY}.xlsx"`);
    const buf = await res.body();
    return { firms: readXlsx(buf).rows as Rows, lines: await reportSheet(buf, 1) };
  };
  const { firms, lines } = await summary(page);
  const stat = (k: string) => firms.find((r) => r[0] === k)?.[1];
  // Onaylı gün (karar 233, düzeltme): üst özet de yalnızca YÜKLENEN miktardan — UNS7701'in 10 camından 8'i yüklendi
  // (2 kırık, "Düzelt" ile). Cam 20 kg/m²: Ünsal 8 m² (ağırlığı Beta'nın sandığında) + Beta 3 m² = 220 kg, brüt 270
  expect(firms.find((r) => r[0] === 'Kaynak')?.[1]).toBe('Onaylı yükleme — yalnızca fiilen yüklenen kalemler');
  expect(String(firms[0][0])).toContain('· YÜKLENEN');
  expect([stat('Cam ağırlığı'), stat('Sandık'), stat('Sevk ağırlığı')]).toEqual(['220 kg', 1, '270 kg']);
  const firmLine = (rows: Rows, name: string) => rows.find((r) => r[0] === name)?.slice(0, 9);
  expect(firmLine(firms, uns.name)).toEqual([uns.name, 1, 8, 0, 0, 8, 0, 0, 0]);
  expect(firmLine(firms, beta.name)).toEqual([beta.name, 1, 3, 0, 0, 3, 220, 1, 270]);
  expect(firmLine(firms, 'TOPLAM')).toEqual(['TOPLAM', 2, 11, 0, 0, 11, 220, 1, 270]);
  // Genel toplam da yüklenen: 11 cam · 11 m² · 11 × 50 = 550 EUR (planlanan 13 / 650 hiçbir yerde yok)
  expect(firms.find((r) => r[0] === 'TOPLAM (EUR)')?.filter((v) => v != null && v !== '')).toEqual(['TOPLAM (EUR)', 11, 11, 550]);
  expect(firms.flat().filter((v) => v === 13 || v === 650), 'planlanan miktar karışmaz').toEqual([]);
  const relation = firms.find((r) => r[0] === 'UNS7701')!;
  expect([relation[1], relation[5], relation[8]], 'ticari sahip · fiziksel sandık sahibi · sandık').toEqual([uns.name, beta.name, '#15']);
  expect([...firms, ...lines].flat(), 'fiziksel sandık sütunu kaldırıldı').not.toContain('SANDIK (FİZİKSEL)');
  // Onaylı gün: yalnızca yüklenen kalemler; misafir siparişin bloğu ticari sahibinde, ev sahibinin bloğuna misafir cam eklenmez
  expect(lines.some((r) => r[0] === 'Kaynak' && String(r[1]).startsWith('Onaylı yükleme'))).toBe(true);
  // Onaylı gün: gerçek sevk miktarı — 10 camdan 2'si kırık ("Düzelt" ile 8 / 2), dökümde yüklenen 8 adet / 8 m²
  const guestLine = summaryBlock(lines, `${uns.name} · UNS7701`)!.rows[0];
  expect([guestLine[4], guestLine[6]]).toEqual([8, 8]);
  const hostLine = summaryBlock(lines, `${beta.name} · BET7702`)!.rows[0];
  expect([hostLine[4], hostLine[6]], 'ev sahibinin satırına misafir cam eklenmez').toEqual([3, 3]);
  // Firma çıktısı (yalnızca o firma ve gün; finansal olarak yalnızca teklif tutarı): misafir siparişte yalnızca sandık NUMARASI
  const firmXlsx = async (p: Page, id: string) => {
    const res = await p.request.get(`/yuklemeler/firma?gun=${DAY}&firma=${id}&bicim=xlsx`);
    expect(res.status()).toBe(200);
    return { name: res.headers()['content-disposition'], rows: readXlsx(await res.body()).rows as Rows };
  };
  const ux = await firmXlsx(page, uns.id);
  expect(ux.name).toContain(`filename="Yukleme-UNS-${DAY}.xlsx"`);
  expect(ux.rows.find((r) => r[0] === 'UNS7701')?.slice(0, 7), 'sipariş · proje · cam · CNC · delik · m² · teklif (10 × 50)').toEqual(['UNS7701', 'Aktarım e2e 7701', 10, 0, 0, 10, 500]);
  expect(ux.rows.flat()).toContain('Teklif tutarı (EUR)');
  expect(ux.rows.flat(), 'fabrika satış tutarı (10 × 37) yok').not.toContain(370);
  expect(ux.rows.flat().some((c) => typeof c === 'string' && /fabrika/i.test(c))).toBe(false);
  expect(ux.rows.flat()).toContain('UNS7701: başka firmanın sandığıyla gidiyor — Sandık 15');
  for (const s of [beta.name, 'BET7702']) expect(JSON.stringify(ux.rows), `sahibinin çıktısında ev sahibi yok: ${s}`).not.toContain(s);
  const bx = await firmXlsx(page, beta.id);
  expect(bx.rows.find((r) => r[0] === 15), 'ev sahibinin sandığı: yalnızca kendi siparişi').toContain('BET7702');
  for (const s of ['UNS7701', uns.name]) expect(JSON.stringify(bx.rows), `ev sahibinin çıktısında misafir sipariş yok: ${s}`).not.toContain(s);
  const pdf = await page.request.get(`/yuklemeler/firma?gun=${DAY}&firma=${uns.id}&bicim=pdf`);
  expect([pdf.status(), pdf.headers()['content-type']]).toEqual([200, 'application/pdf']);
  expect(pdf.headers()['content-disposition']).toContain(`filename="Yukleme-UNS-${DAY}.pdf"`);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
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
  const transport = await page.request.get(`/yuklemeler/nakliye?gun=${DAY}`);
  expect([transport.status(), transport.headers()['content-type']]).toEqual([200, 'application/pdf']);
  expect(transport.headers()['content-disposition']).toContain(`filename="Nakliye-Listesi-${DAY}.pdf"`);

  // Satış: adlar maskeli (ekran, uyarı, sandık ekranı, Excel); firma seçimi ve "Yeniden planla" yok; teklif tutarı yok
  const salesPage = await as(browser, SALES2, TEAM_PW);
  await salesPage.goto(DAY_URL);
  const sOrders = await openFirm(firmOf(salesPage, mask(uns.name)));
  await expect(sOrders.locator(`tr[data-order="${orderU}"] .guest-badge`)).toContainText(`#15 · ${mask(beta.name)}`);
  for (const s of [beta.name, uns.name]) await expect(salesPage.locator('.card#gun'), `satış tam adı görmez: ${s}`).not.toContainText(s);
  await expect(salesPage.locator('#gun select#guest-host, #gun select[name=hostId]'), 'satış firma seçemez').toHaveCount(0);
  await expect(salesPage.locator('.firm-table th', { hasText: 'Teklif tutarı' }), 'satış teklif tutarını görmez').toHaveCount(0);
  await expect(salesPage.locator('#yuklenmeyen')).toContainText('UNS7701');
  await expect(salesPage.locator('#yuklenmeyen input[name=newDay]')).toHaveCount(0);
  const s = await summary(salesPage);
  const sRelation = s.firms.find((r) => r[0] === 'UNS7701')!;
  expect([sRelation[1], sRelation[5]], 'satış özetinde adlar maskeli').toEqual([mask(uns.name), mask(beta.name)]);
  expect(s.lines.find((r) => r[0] === 'UNS7701')![1]).toBe(mask(uns.name));
  for (const x of [uns.name, beta.name]) expect(JSON.stringify([s.firms, s.lines]), `satış Excel'inde tam ad yok: ${x}`).not.toContain(x);
  expect(s.firms.flat().some((c) => typeof c === 'string' && c.startsWith('Teklif tutarı')), 'satış Excel\'inde teklif tutarı yok').toBe(false);
  // Firma PDF / Excel satışa kapalı (Yönetici Paneli Paketi 1, karar 215): satış firma satırında yalnızca "Sandık"ı görür
  for (const f of ['pdf', 'xlsx']) expect((await salesPage.request.get(`/yuklemeler/firma?gun=${DAY}&firma=${uns.id}&bicim=${f}`)).status(), `satış: ${f}`).toBe(403);
  await salesPage.context().close();

  // Sipariş sahibi müşteri: kendi siparişi için yalnızca sandık numarası; ev sahibinin adı, siparişi, sandık ölçüsü yok
  const owner = await as(browser, CUSTOMER, CUST_PW);
  await owner.goto(DAY_URL);
  await expect(owner.locator('.load-table tr', { hasText: 'UNS7701' }).first().locator('.crate-nos')).toContainText('#15');
  const ownerHtml = await (await owner.request.get(DAY_URL)).text();
  for (const secret of [beta.name, 'BET7702', orderB, beta.id]) expect(ownerHtml, `sipariş sahibi: ${secret}`).not.toContain(secret);
  await expect(owner.locator('.guest-box')).toHaveCount(0);
  await expect(owner.locator('.guest-waiting')).toHaveCount(0);
  await expect(owner.locator('.cal-guests'), 'müşteri takviminde misafir göstergesi yok').toHaveCount(0);
  // Firma çıktısı ve özet iç ekibindir: müşteri erişemez
  expect((await owner.request.get(`/yuklemeler/firma?gun=${DAY}&firma=${uns.id}&bicim=xlsx`)).status()).toBe(403);
  expect((await owner.request.get(`/yuklemeler/ozet?gun=${DAY}&firma=${uns.id}`)).url(), 'özet: müşteri kendi ana sayfasına yönlenir').toMatch(/\/siparisler$/);
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

test('özel durum kaldırılınca normal sandık yönetimi: misafir yerleşim kalkar, sandık ve ağırlık siparişin kendi firmasına döner, "+ Sandık ekle" açılır', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${orderU}`);
  const special = admin.locator('#ozel-durum');
  // İstemci bileşeni: sayfa etkileşime hazır olana kadar yinelenir (işaret kaldırılınca "Özel durumu kaldır" düğmesi çıkar)
  const on = special.locator('input[name=on]');
  await expect(async () => {
    if (!(await on.isChecked())) await on.check();
    await on.uncheck();
    await expect(special.getByRole('button', { name: 'Özel durumu kaldır' })).toBeVisible({ timeout: 1000 });
  }).toPass();
  await special.getByRole('button', { name: 'Özel durumu kaldır' }).click();
  await expect(admin).toHaveURL(/ozel=removed/);
  const db = await prisma();
  expect((await db.order.findUniqueOrThrow({ where: { id: orderU } })).guestHostId).toBeNull();
  expect(await db.crateOrder.count({ where: { orderId: orderU } }), 'misafir sandık yerleşimi kalktı').toBe(0);
  expect(await db.auditLog.count({ where: { action: 'CROSS_CUSTOMER_HOST_REMOVED', entityId: orderU } })).toBe(1);
  // Bu testin bildirim olayları sonraki testlerin bildirim sayılarına karışmasın
  await db.notificationOutbox.updateMany({ where: { orderId: orderU, type: { in: ['GUEST_CRATE_ASSIGNED', 'GUEST_CRATE_REMOVED'] }, inAppAt: null }, data: { inAppAt: new Date() } });
  await db.$disconnect();

  await admin.goto(DAY_URL);
  // Sayılar yerleşimden önceki hâline döner: Ünsal'ın camı kendi (tahmini) sandığıyla; Beta yalnızca kendi camıyla
  const COLS = ['orders', 'glass', 'cnc', 'holes', 'm2', 'net', 'crates', 'gross'];
  const cells = async (row: Locator) => Promise.all(COLS.map(async (c) => (await row.locator(`td[data-col="${c}"]`).innerText()).trim().split(/\s/)[0]));
  expect([
    await cells(firmOf(admin, uns.name).locator('tr.firm-row')), await cells(firmOf(admin, beta.name).locator('tr.firm-row')), await cells(admin.locator('.card#gun .firm-table > tfoot tr')),
  ]).toEqual([['1', '10', '–', '–', '10,000', '200', '1', '250'], ['1', '3', '–', '–', '3,000', '60', '1', '110'], ['2', '13', '–', '–', '13,000', '260', '2', '360']]);
  await expect(admin.locator('#gun .guest-waiting')).toHaveCount(0);
  await expect(admin.locator('.cal-day.sel .cal-guests'), 'misafir yük kalmadı: kırmızı gösterge yok').toHaveCount(0);
  const own = await openFirm(firmOf(admin, uns.name), 'crates');
  await expect(own.locator('.guest-note')).toHaveCount(0);
  await expect(own.locator('.crate-locked')).toHaveCount(0);
  await expect(own.getByRole('button', { name: '+ Sandık ekle' })).toBeEnabled();
  const host = await openFirm(firmOf(admin, beta.name), 'crates');
  await expect(host.locator('.guest-box')).toHaveCount(0);
  await expect(host.locator('.crate-guests')).toHaveCount(0);
  await admin.context().close();
});
