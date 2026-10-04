import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as } from './helpers';

// Aşama 9 — kırık / telafi camı (karar 108–109) ve siparişi silme / geri yükleme (karar 110).
//  - teklif tablosunda yalnızca fiziksel cam satırında "Kırık / Telafi"; form: cam → adet → fiyat → hedef → özet + açık onay
//  - fiyat (karar 112): satış yalnızca "Aynı fiyat" (yöneticinin müşteri fiyatı — sunucu taşır, satış tutarı GÖRMEZ) ya da
//    "Bedelsiz" seçer; bedelsiz telafi yeni telafi siparişi (UNS7901-T) açar
//  - işlemler (karar 113): CNC tek bir cama aittir — işlemsiz cam işlem miras almaz; işlemli tek cam işlemiyle AYNEN kopyalanır
//  - "Önemli kararlar" aynı formu açar; müşterinin ileri tarihli siparişi (teklifi müşteride) + satış → yönetici onayı bekler
//  - yönetici onaylar → TELAFİ satırı teklifin yeni sürümünde
//  - siparişi sil: yalnızca yönetici, iki adım (bölüm + onay kutusu); sipariş olağan ekranlardan kalkar; geri yüklenir
// FGO bu veritabanında KAPALIDIR: hiçbir belge kesilmez.
test.describe.configure({ mode: 'serial' });

const INSPECTOR = 'denetim@e2e.test';
const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const dmy = (k: string) => k.split('-').reverse().join('.');
const NEW_DAY = iso(48);
const FUTURE_DAY = iso(55);
let srcId = '', futureId = '', removeId = '', line1 = '', lineOp = '', line2 = '';

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

test('veri: yüklenmiş kaynak sipariş, müşterinin ileri tarihli siparişi ve silinecek sipariş', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const u = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  const glass = (i: number, extra: Record<string, unknown>) => ({ sortOrder: i, unit: 'm2', kind: 'CAM', ...extra });
  const order = (no: number, ship: Date, lines: Record<string, unknown>[]) => db.order.create({
    data: {
      orderNo: `${u.customer!.prefix}${no}`, customerOrderNo: no, title: `Telafi e2e ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: u.customer!.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: ship,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(), lines: { create: lines as never } } },
    },
    include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
  });
  const one = [glass(0, { description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 5, unitPrice: '37', offerPrice: '66.96' })];
  const src = await order(7901, new Date('2026-03-10T12:00:00Z'), [
    // 9 işlemsiz cam + AYNI camdan CNC'li TEK cam (işlem tek bir cama aittir)
    glass(0, { description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 9, unitPrice: '37', offerPrice: '66.96' }),
    glass(1, { description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 1, unitPrice: '37', offerPrice: '66.96' }),
    { sortOrder: 2, description: 'CNC', adet: 1, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '8' },
    glass(3, { description: 'Lamine', descriptionRo: 'Sticlă laminată', enMm: 800, boyMm: 600, adet: 4, unitPrice: '41', offerPrice: '77.77' }),
    { sortOrder: 4, description: 'Sandık parası', descriptionRo: 'Ambalaj (ladă)', adet: 1, unit: 'adet', kind: 'CAM', unitPrice: '25', offerPrice: '30' },
  ]);
  const future = await order(7902, new Date(`${FUTURE_DAY}T12:00:00Z`), one);
  const gone = await order(7903, new Date(`${iso(62)}T12:00:00Z`), one);
  await db.$disconnect();
  srcId = src.id;
  futureId = future.id;
  removeId = gone.id;
  line1 = src.offers[0].lines[0].id;
  lineOp = src.offers[0].lines[1].id;
  line2 = src.offers[0].lines[3].id;
});

test('satış: bedelsiz telafi → UNS7901-T (işlemsiz cam işlem almaz); "Önemli kararlar"dan aynı fiyatla ileri tarihli siparişe → yönetici onayı; işlemli tek cam aynı fiyatla → UNS7901-T2 (CNC aynen)', async ({ browser }) => {
  const page = await as(browser, SALES, TEAM_PW);
  await page.goto(`/siparisler/${srcId}`);
  const table = page.locator('#teklif');
  // Yalnızca fiziksel cam satırlarında: CNC ve sandık parası satırında düğme yok
  await expect(table.getByRole('link', { name: 'Kırık / Telafi' })).toHaveCount(3);
  await expect(table.locator('tr.sub-line').getByRole('link', { name: 'Kırık / Telafi' })).toHaveCount(0);
  await expect(table.locator('tr', { hasText: 'Sandık parası' }).getByRole('link', { name: 'Kırık / Telafi' })).toHaveCount(0);
  await table.locator('tr', { hasText: 'Temper' }).first().getByRole('link', { name: 'Kırık / Telafi' }).click();

  const form = page.locator('#telafi');
  await expect(form).toBeVisible();
  await expect(form.locator('#comp-line')).toHaveValue(line1);
  // Satışın iki seçeneği var: "Aynı fiyat" (yöneticinin müşteri fiyatı) ve "Bedelsiz" — yeni fiyat giremez.
  // Satış müşteri fiyatının tutarını görmez: müşteri fiyatları sayfada hiç yok
  await expect(form).toContainText('Mevcut müşteri fiyatı: yöneticinin kaynak teklifte belirlediği fiyat');
  await expect(form.locator('label.chip')).toHaveText(['Aynı fiyat', 'Bedelsiz']);
  await expect(form.locator('input[name=price]')).toHaveCount(0);
  // Cam seçimi fiziksel yapılandırmayı gösterir: işlemsiz camlar ve CNC'li tek cam ayrı seçeneklerdir
  await expect(form.locator('#comp-line option', { hasText: 'işlemsiz' })).toHaveCount(2);
  await expect(form.locator('#comp-line option', { hasText: 'CNC × 1' })).toHaveCount(1);
  await expect(form).not.toContainText('AYNEN kopyalanır'); // seçili cam işlemsiz
  const html = await page.content();
  expect(html).not.toContain('66,96');
  expect(html).not.toContain('66.96');
  expect(html).not.toContain('77.77');
  await form.locator('#comp-qty').fill('3');
  await form.locator('label.chip', { hasText: 'Bedelsiz' }).click();
  // İki hedef seçeneği de her zaman var: müşterinin ileri tarihli siparişi ve yeni telafi siparişi
  await expect(form.getByText('Müşterinin ileri tarihli siparişine ekle')).toBeVisible();
  await expect(form.locator('select[name=destOrderId] option', { hasText: 'UNS7902' })).toHaveCount(1);
  const submit = form.getByRole('button', { name: 'Telafi camını ekle' });
  await expect(submit).toBeDisabled();
  await form.locator('input[name=destChoice][value=NEW]').check();
  await form.locator('#comp-day').fill(NEW_DAY);
  const summary = form.locator('.comp-summary');
  await expect(summary).toContainText('UNS7901');
  await expect(summary).toContainText('Bedelsiz');
  await expect(summary).toContainText('Yeni telafi siparişi (UNS7901-T)');
  await expect(summary).toContainText(dmy(NEW_DAY));
  await expect(summary).toContainText('Yukarıdaki kararı onaylıyorum: 3 cam telafi olarak eklensin.');
  await expect(submit).toBeDisabled(); // açık onay olmadan eklenmez
  await shot(page, 'telafi-formu');
  await summary.locator('.comp-confirm input').check();
  await submit.click();
  await expect(page).toHaveURL(/telafiOk=created/);
  await expect(page.locator('.alert-ok', { hasText: 'Telafi camı eklendi: UNS7901-T.' })).toBeVisible();
  const card = page.locator('#kararlar');
  const entry = card.locator('.comp-entry').first();
  for (const text of ['UNS7901', 'TELAFİ', '3 adet telafi', 'Bedelsiz telafi', 'Kaynak cam: Temper · 1000×1000', 'Fiyat kararı: Bedelsiz', `Hedef: UNS7901-T / ${dmy(NEW_DAY)}`, 'Oluşturan:', 'Tarih:']) {
    await expect(entry).toContainText(text);
  }

  const db = await prisma();
  const t = await db.order.findUniqueOrThrow({ where: { orderNo: 'UNS7901-T' }, include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  expect([t.status, t.compSeq, t.compOfId, t.offers[0].status]).toEqual(['HAZIRLANIYOR', 1, srcId, 'YONETIMDE']);
  // Bedelsiz: müşteri fiyatı 0, fabrika maliyeti durur; işlemsiz cam CNC miras almaz (aynı camın CNC'li kardeşi olsa da)
  expect(t.offers[0].lines.map((l) => [l.kind, l.adet, Number(l.unitPrice), Number(l.offerPrice), l.free, !!l.compensationId])).toEqual([['CAM', 3, 37, 0, true, true]]);
  const src = await db.order.findUniqueOrThrow({ where: { id: srcId }, include: { offers: { include: { lines: true } } } });
  expect([src.offers.length, src.offers[0].lines.length]).toEqual([1, 5]); // kaynak değişmedi

  // --- "Önemli kararlar" → aynı form; cam burada seçilir; önceki telafi gösterilir
  await card.getByRole('link', { name: 'Kırık / Telafi Camı Oluştur' }).click();
  await expect(form).toBeVisible();
  await expect(form.locator('#comp-line')).toHaveValue('');
  await form.locator('#comp-line').selectOption(line1);
  await expect(form.locator('.comp-history')).toContainText('3 adet → UNS7901-T');
  await form.locator('#comp-line').selectOption(line2);
  await expect(form.locator('.comp-history')).toHaveCount(0);
  // "Aynı fiyat" seçili gelir: müşteri fiyatını (77,77) sunucu taşır, satış görmez
  await expect(form.locator('input[name=modeChoice][value=NORMAL]')).toBeChecked();
  await form.locator('input[name=destChoice][value=EXISTING]').check();
  await expect(form.locator('select[name=destOrderId] option', { hasText: 'UNS7902' })).toContainText(`UNS7902 — ${dmy(FUTURE_DAY)} · yönetici onayı gerekir`);
  await form.locator('select[name=destOrderId]').selectOption(futureId);
  await expect(form.locator('.comp-summary')).toContainText('yöneticinin onayını bekleyecek');
  await form.locator('.comp-confirm input').check();
  await form.getByRole('button', { name: 'Telafi camını ekle' }).click();
  await expect(page).toHaveURL(/telafiOk=pending/);
  await expect(page.locator('.alert-ok', { hasText: 'yöneticinin onayını bekliyor' })).toBeVisible();
  await expect(card.locator('.comp-entry[data-status=PENDING]')).toContainText('Yönetici onayı bekliyor');
  await shot(page, 'telafi-kararlar');
  // Onay beklerken hedef siparişin teklifi değişmedi; satış onay / ret düğmelerini görmez
  const f = await db.order.findUniqueOrThrow({ where: { id: futureId }, include: { offers: true } });
  expect(f.offers.length).toBe(1);
  await expect(card.getByRole('button', { name: 'Onayla ve teklife ekle' })).toHaveCount(0);
  expect(await page.content()).not.toContain('77.77');

  // --- İşlemli TEK cam, aynı fiyat, yeni telafi siparişi: CNC AYNEN kopyalanır; müşteri fiyatı yöneticinin fiyatıdır
  await card.getByRole('link', { name: 'Kırık / Telafi Camı Oluştur' }).click();
  await form.locator('#comp-line').selectOption(lineOp);
  await expect(form).toContainText('Bu camın işlemleri telafiye AYNEN kopyalanır: CNC × 1');
  await expect(form).toContainText('En çok 1'); // işlemli cam tek adettir
  await form.locator('input[name=destChoice][value=NEW]').check();
  await form.locator('#comp-day').fill(NEW_DAY);
  await expect(form.locator('.comp-summary')).toContainText('Aynı fiyat (yöneticinin belirlediği müşteri fiyatı)');
  await expect(form.locator('.comp-summary')).toContainText('Yeni telafi siparişi (UNS7901-T2)');
  await shot(page, 'telafi-islemli-cam');
  await form.locator('.comp-confirm input').check();
  await form.getByRole('button', { name: 'Telafi camını ekle' }).click();
  await expect(page.locator('.alert-ok', { hasText: 'Telafi camı eklendi: UNS7901-T2.' })).toBeVisible();
  const t2 = await db.order.findUniqueOrThrow({ where: { orderNo: 'UNS7901-T2' }, include: { offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  expect(t2.offers[0].lines.map((l) => [l.kind, l.adet, Number(l.unitPrice), Number(l.offerPrice), l.free, !!l.compensationId])).toEqual([['CAM', 1, 37, 66.96, false, true], ['CNC', 1, 5, 8, false, true]]);
  // Aynı fiyat "fiyat değişti" kararı açmaz: tek fiyat kararı bedelsiz telafidir
  expect(await db.adminAlert.count({ where: { type: 'COMPENSATION_PRICE', orderId: srcId } })).toBe(1);
  // Satış müşteri fiyatını hâlâ hiçbir yerde görmedi
  const after = await page.content();
  for (const secret of ['66,96', '66.96', '77,77', '77.77']) expect(after, secret).not.toContain(secret);
  await db.$disconnect();
  await page.context().close();
});

test('yönetici: fiyat kararı ve bekleyen telafi "Önemli kararlar"da; onaylayınca TELAFİ satırı teklifin yeni sürümünde; telafi siparişinde TELAFİ rozeti', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/kararlar');
  // Bedelsiz telafi önemli karardır: kaynak sipariş, cam ve adet, ÖNCEKİ MÜŞTERİ FİYATI → Bedelsiz, hedef. "Aynı fiyat" kararları burada yok.
  const priceRows = admin.locator('.card').first().locator('tr', { hasText: 'Telafi camı: bedelsiz / müşteri fiyatı kararı' });
  await expect(priceRows).toHaveCount(1);
  const priceRow = priceRows.first();
  await expect(priceRow).toContainText('UNS7901');
  await expect(priceRow).toContainText('3 × Temper 1000×1000 → UNS7901-T');
  await expect(priceRow).toContainText('Önceki müşteri fiyatı: 66,96 EUR/m² → Telafi: Bedelsiz (müşteri fiyatı)');
  const pend = admin.locator('tr', { hasText: 'Telafi camı yönetici onayını bekliyor' }).first();
  await expect(pend).toContainText('UNS7902');
  await pend.getByRole('link', { name: 'Siparişte karar ver' }).click();
  await expect(admin).toHaveURL(new RegExp(`/siparisler/${futureId}`));
  const entry = admin.locator('#kararlar .comp-entry[data-status=PENDING]');
  await expect(entry).toContainText('Kaynak sipariş: UNS7901');
  await expect(entry).toContainText('Önceki müşteri fiyatı: 77,77 EUR/m²');
  await expect(entry).toContainText('Telafi fiyatı: 77,77 EUR/m²');
  // Müşteri fiyatı kaynağın kayıtlı müşteri fiyatıyla hazır gelir (yönetici değiştirebilir)
  await expect(entry.locator('input[name=price]')).toHaveValue('77.77');
  await entry.getByRole('button', { name: 'Onayla ve teklife ekle' }).click();
  await expect(admin).toHaveURL(/telafiOk=applied/);
  await expect(admin.locator('#teklif tbody tr', { hasText: 'TELAFİ' })).toHaveCount(1);
  await expect(admin.locator('#teklif tbody tr', { hasText: 'TELAFİ' })).toContainText('Lamine');
  await expect(admin.locator('#kararlar .comp-entry[data-status=APPLIED]')).toHaveCount(1);

  const db = await prisma();
  const f = await db.order.findUniqueOrThrow({ where: { id: futureId }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  expect(f.offers.map((o) => o.status)).toEqual(['GONDERILDI', 'GONDERILDI']);
  expect(f.offers[0].lines.map((l) => [l.description, l.adet, Number(l.unitPrice), Number(l.offerPrice), !!l.compensationId])).toEqual([['Temper', 5, 37, 66.96, false], ['Lamine', 1, 41, 77.77, true]]);
  expect(f.offers[1].lines.length).toBe(1); // eski sürüm değişmedi
  const t = await db.order.findUniqueOrThrow({ where: { orderNo: 'UNS7901-T2' } });
  await db.$disconnect();
  // Bekleyen karar kapandı
  await admin.goto('/admin/kararlar');
  await expect(admin.locator('.card').first().locator('tr', { hasText: 'Telafi camı yönetici onayını bekliyor' })).toHaveCount(0);
  // Telafi siparişi (CNC'li tek cam) yöneticinin fiyat onayında: müşteri fiyatı hazır (66,96 / 8) — yeniden girilmez;
  // satırlar TELAFİ rozetli; işlemli cam tek adettir (adet kutusu kilitli)
  await admin.goto(`/siparisler/${t.id}`);
  await expect(admin.locator('h1')).toContainText('Telafi e2e 7901');
  await expect(admin.locator('.line-actions .badge', { hasText: 'TELAFİ' })).toHaveCount(2);
  await expect(admin.getByLabel('Adet', { exact: true })).toHaveAttribute('readonly', '');
  await expect(admin.locator('input[name=l_oprice]').first()).toHaveValue(/^66[.,]96$/);
  // Yöneticinin formu mevcut müşteri fiyatını tutarıyla gösterir; yeni müşteri fiyatı yalnızca yöneticide
  await admin.goto(`/siparisler/${srcId}?telafi=${line1}#telafi`);
  const aform = admin.locator('#telafi');
  await expect(aform).toContainText('Mevcut müşteri fiyatı: 66,96 EUR/m²');
  await expect(aform.locator('label.chip')).toHaveText(['Aynı fiyat — 66,96 EUR/m²', 'Bedelsiz — 0 EUR/m²', 'Başka fiyat (yönetici)']);
  await shot(admin, 'telafi-formu-yonetici');
  await admin.goto(`/siparisler/${t.id}`);
  await shot(admin, 'telafi-siparisi');
  await admin.context().close();
});

test('müşteri, çizim ve denetimci: telafi düğmesi, "Önemli kararlar" ve TELAFİ rozeti müşteride yok; siparişi sil bölümü yalnızca yöneticide', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/siparisler/${srcId}`);
  await expect(cust.locator('#teklif')).toBeVisible();
  await expect(cust.getByRole('link', { name: 'Kırık / Telafi' })).toHaveCount(0);
  await expect(cust.locator('#kararlar')).toHaveCount(0);
  await expect(cust.locator('#sil')).toHaveCount(0);
  // Taklit adres: form müşteriye açılmaz
  await cust.goto(`/siparisler/${srcId}?telafi=${line1}#telafi`);
  await expect(cust.locator('#telafi')).toHaveCount(0);
  await cust.goto(`/siparisler/${futureId}`);
  await expect(cust.locator('#teklif')).toContainText('Lamine'); // teklifin yeni sürümü müşteride
  expect(await cust.content()).not.toContain('TELAFİ');
  await cust.context().close();
  for (const [email, pw] of [[INSPECTOR, 'Denet1'], [DRAWER, TEAM_PW]] as const) {
    const p = await as(browser, email, pw);
    await p.goto(`/siparisler/${srcId}?telafi=${line1}`);
    await expect(p.getByRole('link', { name: 'Kırık / Telafi' })).toHaveCount(0);
    await expect(p.locator('#kararlar')).toHaveCount(0);
    await expect(p.locator('#telafi')).toHaveCount(0);
    await expect(p.locator('#sil')).toHaveCount(0);
    await p.context().close();
  }
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${removeId}`);
  await expect(sales.locator('#kararlar')).toBeVisible();
  await expect(sales.locator('#sil')).toHaveCount(0); // satış sipariş silemez
  await sales.context().close();
});

test('yönetici: siparişi sil iki adımlıdır; sipariş olağan ekranlardan kalkar, kayıtlar durur; geri yüklenir — başka rol geri yükleyemez', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${removeId}`);
  const box = admin.locator('#sil');
  // 1. adım: bölüm açılır; 2. adım: sonuçlar + onay kutusu — kutu işaretlenmeden kırmızı düğme çalışmaz
  await expect(box.getByText('Bu siparişin sistemden kaldırılacağını onaylıyorum.')).toHaveCount(0);
  await box.getByRole('button', { name: 'Siparişi sil' }).click();
  await expect(box).toContainText('Kayıtlar silinmez');
  const submit = box.locator('button.btn-danger-solid');
  await expect(submit).toHaveText('Siparişi sil');
  await expect(submit).toBeDisabled();
  await shot(admin, 'siparis-sil');
  await box.getByLabel('Bu siparişin sistemden kaldırılacağını onaylıyorum.').check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(admin).toHaveURL(/silindi=UNS7903/);
  await expect(admin.locator('#silinen .alert-ok')).toContainText('Sipariş silindi: UNS7903.');
  await expect(admin.locator('#silinen tr[data-removed=UNS7903]')).toBeVisible();
  await shot(admin, 'silinen-siparisler');
  // Olağan listelerde ve aramada yok (yalnızca "Silinen siparişler" bölümünde)
  await admin.goto('/siparisler?view=all&q=UNS7903');
  await expect(admin.locator('.card:not(#silinen) a', { hasText: 'UNS7903' })).toHaveCount(0);
  await admin.goto('/siparisler?view=archive&q=UNS7903');
  await expect(admin.locator('.card:not(#silinen) a', { hasText: 'UNS7903' })).toHaveCount(0);
  // Yönetici sipariş adresini açarsa yalnızca "silindi" bilgisi ve geri yükleme görünür
  await admin.goto(`/siparisler/${removeId}`);
  await expect(admin.locator('#silinen')).toContainText('Bu sipariş silindi');
  await expect(admin.locator('#teklif')).toHaveCount(0);

  // Müşteri ve satış: liste, arama ve doğrudan adres — sipariş yok (404)
  const cust = await as(browser, CUSTOMER, CUST_PW);
  for (const url of ['/siparisler', '/siparisler?view=archive', '/teklifler']) {
    await cust.goto(url);
    expect(await cust.content(), `müşteri ${url}`).not.toContain('UNS7903');
  }
  expect((await cust.request.get(`/siparisler/${removeId}`)).status()).toBe(404);
  const sales = await as(browser, SALES, TEAM_PW);
  for (const url of ['/siparisler?view=all', '/siparisler?view=archive', '/teklifler', `/yuklemeler?gun=${iso(62)}`]) {
    await sales.goto(url);
    expect(await sales.content(), `satış ${url}`).not.toContain('UNS7903');
  }
  await sales.goto('/siparisler?view=all');
  await expect(sales.locator('#silinen')).toHaveCount(0); // silinenler listesi yalnızca yöneticide
  expect((await sales.request.get(`/siparisler/${removeId}`)).status()).toBe(404);

  const db = await prisma();
  let o = await db.order.findUniqueOrThrow({ where: { id: removeId }, include: { offers: { include: { lines: true } }, events: true } });
  expect([o.status, o.removedStatus, !!o.removedAt, o.offers.length, o.offers[0].lines.length]).toEqual(['IPTAL', 'URETIMDE', true, 1, 1]);
  expect(o.events.map((e) => e.event)).toContain('REMOVED');
  expect(await db.auditLog.count({ where: { action: 'ORDER_REMOVED', entityId: removeId } })).toBe(1);

  // Taklit geri yükleme isteği (yöneticinin formundaki sunucu işlemiyle): satış ve müşteri geri yükleyemez
  const field = await actionField(admin, '/siparisler', `value="${removeId}"`);
  for (const p of [sales, cust]) {
    await forge(p, '/siparisler', field, { id: removeId });
    expect((await db.order.findUniqueOrThrow({ where: { id: removeId } })).removedAt).not.toBeNull();
  }
  await sales.context().close();

  // Geri yükle: sipariş önceki durumuna döner, herkes yeniden görür
  await admin.goto('/siparisler#silinen');
  await admin.locator('#silinen > details > summary').click();
  await admin.locator('#silinen tr[data-removed=UNS7903]').getByRole('button', { name: 'Geri yükle' }).click();
  await expect(admin).toHaveURL(new RegExp(`/siparisler/${removeId}\\?ok=restored`));
  await expect(admin.locator('.alert-ok', { hasText: 'Sipariş geri yüklendi' })).toBeVisible();
  await expect(admin.locator('#teklif')).toBeVisible();
  o = await db.order.findUniqueOrThrow({ where: { id: removeId }, include: { offers: { include: { lines: true } }, events: true } });
  expect([o.status, o.removedStatus, o.removedAt, o.offers.length, o.offers[0].lines.length]).toEqual(['URETIMDE', null, null, 1, 1]);
  expect(await db.auditLog.count({ where: { action: 'ORDER_RESTORED', entityId: removeId } })).toBe(1);
  await db.$disconnect();
  expect((await cust.request.get(`/siparisler/${removeId}`)).status()).toBe(200);
  await cust.context().close();
  await admin.context().close();
});
