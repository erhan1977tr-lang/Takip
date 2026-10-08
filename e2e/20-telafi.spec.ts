import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, INSPECTOR_PW } from './helpers';

// Aşama 9 — kırık / telafi camı (karar 108–109), fonksiyonel paket 1 (karar 157) ve siparişi silme / geri yükleme (karar 110).
//  - teklif tablosunda yalnızca fiziksel cam satırında "Kırık / Telafi"; form: cam → adet → fiyat → hedef → özet + açık onay
//  - fiyat (karar 157): satış üç kararı seçer — Bedelsiz · Aynı fiyat (yöneticinin kaynak teklifteki fiyatı; sunucu taşır) ·
//    Farklı fiyat (fiyatı yönetici belirler). Satışın formunda FİYAT ALANI YOKTUR ve satış hiçbir müşteri fiyatı tutarı görmez.
//  - Bedelsiz / Aynı fiyat: teklif doğrudan müşteriye gider (yeni telafi siparişi üretime geçer); Farklı fiyat: yöneticinin
//    fiyatlandırmasına gider (yeni sipariş → fiyat onayı; teklifi müşteride olan sipariş → yönetici onayı)
//  - kaynak adedi: telafi açılınca ana siparişte o camın adedi düşer (temiz siparişte; teklifin yeni sürümü)
//  - işlemler (karar 113, 157): CNC tek bir cama aittir — işlemsiz cam işlem miras almaz; işlemli tek camın işlemi telafiye
//    taşınır ve telafide müşteri fiyatı 0'dır
//  - siparişi sil: yalnızca yönetici, iki adım (bölüm + onay kutusu); sipariş olağan ekranlardan kalkar; geri yüklenir
// FGO bu veritabanında KAPALIDIR: hiçbir belge kesilmez.
test.describe.configure({ mode: 'serial' });

const INSPECTOR = 'denetim@e2e.test';
const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const dmy = (k: string) => k.split('-').reverse().join('.');
const NEW_DAY = iso(48);
const FUTURE_DAY = iso(55);
let srcId = '', futureId = '', removeId = '', closedId = '', freeId = '', pricingId = '', line1 = '', lineOp = '', line2 = '';

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
type Db = Awaited<ReturnType<typeof prisma>>;
/**
 * Siparişin müşterideki (en yeni) teklifi. Kaynak adedi düşünce teklifin YENİ sürümü açılır; satır kimlikleri değişir —
 * sonraki adım güncel satırı kullanır.
 */
async function sentOffer(db: Db, orderId: string) {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  return { versions: o.offers.length, lines: o.offers[0].lines, rows: o.offers[0].lines.map((l) => [l.description, l.adet]) };
}
const lineRow = (l: { kind: string; adet: number; unitPrice: unknown; offerPrice: unknown; free: boolean; compensationId: string | null }) =>
  [l.kind, l.adet, Number(l.unitPrice), l.offerPrice == null ? null : Number(l.offerPrice), l.free, !!l.compensationId];
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

test('veri: temiz kaynak sipariş, kapalı sipariş, müşterinin ileri tarihli siparişi ve silinecek sipariş', async () => {
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
  // Kaynak: üretimde, yüklemesi onaylanmamış, belgesi yok (TEMİZ) — telafi açılınca adedi düşer
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
  // Kapalı ("Yüklendi") sipariş: telafi açılır ama adedi düşmez (ek üretim) — form bunu kayıttan önce söyler
  const closed = await order(7904, new Date('2026-03-12T12:00:00Z'), one);
  await db.order.update({ where: { id: closed.id }, data: { status: 'YUKLENDI' } });
  await db.$disconnect();
  srcId = src.id;
  futureId = future.id;
  removeId = gone.id;
  closedId = closed.id;
  line1 = src.offers[0].lines[0].id;
  lineOp = src.offers[0].lines[1].id;
  line2 = src.offers[0].lines[3].id;
});

test('satış: bedelsiz → UNS7901-T doğrudan müşteride, kaynak 9 → 6; işlemli tek cam aynı fiyatla → UNS7901-T2 (CNC taşınır, müşteri fiyatı 0); farklı fiyat → yöneticinin fiyatlandırması / onayı; satış fiyat giremez ve görmez', async ({ browser }) => {
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
  // Satışın üç seçeneği var: Bedelsiz, Aynı fiyat (yöneticinin müşteri fiyatı) ve Farklı fiyat — hiçbirinde fiyat GİREMEZ.
  // Satış müşteri fiyatının tutarını görmez: müşteri fiyatları sayfada hiç yok
  await expect(form).toContainText('Mevcut müşteri fiyatı: yöneticinin kaynak teklifte belirlediği fiyat');
  await expect(form.locator('label.chip')).toHaveText(['Bedelsiz', 'Aynı fiyat', 'Farklı fiyat']);
  await expect(form.locator('input[name=modeChoice][value=NORMAL]')).toBeChecked();
  await expect(form.locator('input[name=price]')).toHaveCount(0);
  await form.locator('label.chip', { hasText: 'Farklı fiyat' }).click();
  await expect(form.locator('input[name=price]')).toHaveCount(0); // "farklı fiyat"ta da fiyat alanı yok: fiyatı yönetici belirler
  await expect(form).toContainText('Farklı fiyat: müşteri fiyatını yönetici belirler.');
  // Temiz kaynakta "adet düşmez" uyarısı yok
  await expect(form.locator('[data-source-kept]')).toHaveCount(0);
  // Cam seçimi fiziksel yapılandırmayı gösterir: işlemsiz camlar ve CNC'li tek cam ayrı seçeneklerdir
  await expect(form.locator('#comp-line option', { hasText: 'işlemsiz' })).toHaveCount(2);
  await expect(form.locator('#comp-line option', { hasText: 'CNC × 1' })).toHaveCount(1);
  await expect(form).not.toContainText('telafiye taşınır'); // seçili cam işlemsiz
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
  // Kaynak adedi ve teklifin yolu kayıttan ÖNCE görünür
  await expect(summary.locator('[data-sum=kaynak]')).toContainText('9 → 6 adet');
  await expect(summary.locator('[data-sum=akis]')).toContainText('Teklif doğrudan müşteriye gider');
  await expect(summary).toContainText('Yukarıdaki kararı onaylıyorum: 3 cam telafi olarak eklensin.');
  await expect(submit).toBeDisabled(); // açık onay olmadan eklenmez
  await shot(page, 'telafi-formu');
  await summary.locator('.comp-confirm input').check();
  await submit.click();
  await expect(page).toHaveURL(/telafiOk=sent/);
  await expect(page.locator('.alert-ok', { hasText: 'Telafi siparişi açıldı: UNS7901-T. Teklifi müşteriye gönderildi' })).toBeVisible();
  await expect(page.locator('[data-comp-source=dustu]')).toContainText('Kaynak siparişte bu camın adedi 9 → 6 oldu');
  const card = page.locator('#kararlar');
  let entry = card.locator('.comp-entry').first();
  for (const text of ['UNS7901', 'TELAFİ', '3 adet telafi', 'Kaynak cam: Temper · 1000×1000', 'Fiyat kararı: Bedelsiz', `Hedef: UNS7901-T / ${dmy(NEW_DAY)}`, 'Oluşturan:', 'Tarih:']) {
    await expect(entry).toContainText(text);
  }
  await expect(entry.locator('[data-comp-mode=FREE]')).toHaveText('Bedelsiz');

  const db = await prisma();
  const full = { offers: { orderBy: { createdAt: 'desc' as const }, include: { lines: { orderBy: { sortOrder: 'asc' as const } } } } };
  const t = await db.order.findUniqueOrThrow({ where: { orderNo: 'UNS7901-T' }, include: full });
  freeId = t.id;
  // Bedelsiz: teklif yöneticiye uğramadan müşteride; çizim gerekmediği için sipariş üretimde
  expect([t.status, t.compSeq, t.compOfId, t.offers.length, t.offers[0].status]).toEqual(['URETIMDE', 1, srcId, 1, 'GONDERILDI']);
  // Müşteri fiyatı 0, fabrika maliyeti durur; işlemsiz cam CNC miras almaz (aynı camın CNC'li kardeşi olsa da)
  expect(t.offers[0].lines.map(lineRow)).toEqual([['CAM', 3, 37, 0, true, true]]);
  // Kaynak: teklifin yeni sürümü — 9 camdan 6'sı kaldı; öteki satırlar aynen. Eski sürüm duruyor.
  let src = await sentOffer(db, srcId);
  expect([src.versions, src.rows]).toEqual([2, [['Temper', 6], ['Temper', 1], ['CNC', 1], ['Lamine', 4], ['Sandık parası', 1]]]);
  [line1, lineOp, line2] = [src.lines[0].id, src.lines[1].id, src.lines[3].id];

  // --- "Önemli kararlar" → aynı form; cam burada seçilir; önceki telafi gösterilir.
  // İşlemli TEK cam, AYNI FİYAT, yeni telafi siparişi: CNC telafiye taşınır (müşteri fiyatı 0); cam fiyatı yöneticinin fiyatıdır
  await card.getByRole('link', { name: 'Kırık / Telafi Camı Oluştur' }).click();
  await expect(form).toBeVisible();
  await expect(form.locator('#comp-line')).toHaveValue('');
  await form.locator('#comp-line').selectOption(line1);
  await expect(form.locator('.comp-history')).toContainText('3 adet → UNS7901-T');
  await form.locator('#comp-line').selectOption(lineOp);
  await expect(form).toContainText('Bu camın işlemleri telafiye taşınır; telafide müşteri fiyatları 0\'dır: CNC × 1');
  await expect(form).toContainText('En çok 1'); // işlemli cam tek adettir
  await expect(form.locator('input[name=modeChoice][value=NORMAL]')).toBeChecked(); // "Aynı fiyat" seçili gelir
  await form.locator('input[name=destChoice][value=NEW]').check();
  await form.locator('#comp-day').fill(NEW_DAY);
  await expect(summary).toContainText('Aynı fiyat (yöneticinin belirlediği müşteri fiyatı)');
  await expect(summary).toContainText('Yeni telafi siparişi (UNS7901-T2)');
  await expect(summary.locator('[data-sum=islem]')).toContainText('CNC × 1');
  await expect(summary.locator('[data-sum=islem]')).toContainText('müşteri fiyatı 0');
  await expect(summary.locator('[data-sum=kaynak]')).toContainText('1 → 0 adet');
  await shot(page, 'telafi-islemli-cam');
  await summary.locator('.comp-confirm input').check();
  await form.getByRole('button', { name: 'Telafi camını ekle' }).click();
  await expect(page.locator('.alert-ok', { hasText: 'Telafi siparişi açıldı: UNS7901-T2.' })).toBeVisible();
  await expect(page.locator('[data-comp-source=dustu]')).toContainText('1 → 0');
  const t2 = await db.order.findUniqueOrThrow({ where: { orderNo: 'UNS7901-T2' }, include: full });
  expect([t2.status, t2.offers[0].status]).toEqual(['URETIMDE', 'GONDERILDI']);
  // Cam: kaynağın yönetici fiyatı (66,96). CNC: telafiye taşındı, müşteri fiyatı 0 (kaynakta 8 idi), maliyeti (5) durur
  expect(t2.offers[0].lines.map(lineRow)).toEqual([['CAM', 1, 37, 66.96, false, true], ['CNC', 1, 5, 0, true, true]]);
  // Kaynakta işlemli cam ve CNC satırı kalktı (telafiye taşındı)
  src = await sentOffer(db, srcId);
  expect([src.versions, src.rows]).toEqual([3, [['Temper', 6], ['Lamine', 4], ['Sandık parası', 1]]]);
  [line1, line2] = [src.lines[0].id, src.lines[1].id];

  // --- FARKLI FİYAT, yeni telafi siparişi: satış fiyat girmez; sipariş yöneticinin fiyatlandırmasına gider (müşteriye gitmez)
  await card.getByRole('link', { name: 'Kırık / Telafi Camı Oluştur' }).click();
  await form.locator('#comp-line').selectOption(line1);
  await form.locator('label.chip', { hasText: 'Farklı fiyat' }).click();
  await expect(form.locator('input[name=price]')).toHaveCount(0);
  await form.locator('input[name=destChoice][value=NEW]').check();
  await form.locator('#comp-day').fill(NEW_DAY);
  await expect(summary).toContainText('Yeni telafi siparişi (UNS7901-T3)');
  await expect(summary).toContainText('yönetici belirleyecek');
  await expect(summary.locator('[data-sum=akis]')).toContainText('Yöneticinin fiyatlandırmasına gider');
  await expect(summary.locator('[data-sum=kaynak]')).toContainText('6 → 5 adet');
  await summary.locator('.comp-confirm input').check();
  await form.getByRole('button', { name: 'Telafi camını ekle' }).click();
  await expect(page).toHaveURL(/telafiOk=pricing/);
  await expect(page.locator('.alert-ok', { hasText: 'Telafi siparişi açıldı: UNS7901-T3. Müşteri fiyatını yönetici belirleyecek' })).toBeVisible();
  entry = card.locator('.comp-entry').first();
  await expect(entry.locator('[data-comp-mode=CUSTOM]')).toHaveText('Farklı fiyat');
  await expect(entry).toContainText('Müşteri fiyatını yönetici belirleyecek');
  const t3 = await db.order.findUniqueOrThrow({ where: { orderNo: 'UNS7901-T3' }, include: full });
  pricingId = t3.id;
  expect([t3.status, t3.offers[0].status, t3.offers[0].sentAt]).toEqual(['HAZIRLANIYOR', 'YONETIMDE', null]);
  expect(t3.offers[0].lines.map(lineRow)).toEqual([['CAM', 1, 37, null, false, true]]);
  src = await sentOffer(db, srcId);
  expect([src.versions, src.rows]).toEqual([4, [['Temper', 5], ['Lamine', 4], ['Sandık parası', 1]]]);
  [line1, line2] = [src.lines[0].id, src.lines[1].id];

  // --- FARKLI FİYAT, müşterinin ileri tarihli siparişine (teklifi müşteride): karar yöneticinin onayını bekler
  await card.getByRole('link', { name: 'Kırık / Telafi Camı Oluştur' }).click();
  await form.locator('#comp-line').selectOption(line2);
  await expect(form.locator('.comp-history')).toHaveCount(0);
  await form.locator('input[name=destChoice][value=EXISTING]').check();
  // Bedelsiz / aynı fiyat yönetici onayı beklemez; yalnızca "farklı fiyat" bekler
  const option = form.locator('select[name=destOrderId] option', { hasText: 'UNS7902' });
  await expect(option).toHaveText(`UNS7902 — ${dmy(FUTURE_DAY)}`);
  await form.locator('label.chip', { hasText: 'Farklı fiyat' }).click();
  await expect(option).toContainText(`UNS7902 — ${dmy(FUTURE_DAY)} · yönetici onayı gerekir`);
  await form.locator('select[name=destOrderId]').selectOption(futureId);
  await expect(summary).toContainText('karar yöneticinin onayını bekler');
  await expect(summary).toContainText('yönetici belirleyecek');
  await summary.locator('.comp-confirm input').check();
  await form.getByRole('button', { name: 'Telafi camını ekle' }).click();
  await expect(page).toHaveURL(/telafiOk=pending/);
  await expect(page.locator('.alert-ok', { hasText: 'yöneticinin onayını bekliyor' })).toBeVisible();
  await expect(page.locator('[data-comp-source=PENDING]')).toContainText('yönetici kararı onayladığında düşer');
  await expect(card.locator('.comp-entry[data-status=PENDING]')).toContainText('Yönetici onayı bekliyor');
  await shot(page, 'telafi-kararlar');
  // Onay beklerken hedef siparişin teklifi ve kaynağın adedi değişmedi; satış onay / ret düğmelerini görmez
  const f = await db.order.findUniqueOrThrow({ where: { id: futureId }, include: { offers: true } });
  expect(f.offers.length).toBe(1);
  src = await sentOffer(db, srcId);
  expect([src.versions, src.rows]).toEqual([4, [['Temper', 5], ['Lamine', 4], ['Sandık parası', 1]]]);
  await expect(card.getByRole('button', { name: 'Onayla ve teklife ekle' })).toHaveCount(0);

  // "Önemli kararlar": telafi başına BİR kayıt (üç fiyat kararı kaynakta, bekleyen karar hedefte)
  expect(await db.adminAlert.count({ where: { type: 'COMPENSATION_PRICE', orderId: srcId } })).toBe(3);
  expect(await db.adminAlert.count({ where: { type: 'COMPENSATION_PENDING', orderId: futureId } })).toBe(1);
  // Satış müşteri fiyatını hiçbir yerde görmedi
  const after = await page.content();
  for (const secret of ['66,96', '66.96', '77,77', '77.77']) expect(after, secret).not.toContain(secret);

  // Kapalı ("Yüklendi") sipariş: form kaynak adedinin düşmeyeceğini (ek üretim) kayıttan önce söyler
  await page.goto(`/siparisler/${closedId}?telafi=sec#telafi`);
  await expect(form.locator('[data-source-kept=CLOSED]')).toContainText('adedi düşürülmez; telafi ek üretim olarak açılır');
  await db.$disconnect();
  await page.context().close();
});

test('yönetici: her telafi "Önemli kararlar"da (karar, önceki → uygulanan fiyat, kaynak adedi); bekleyen kararı fiyat girerek onaylar; "farklı fiyat" siparişini fiyat onayında fiyatlandırır', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/kararlar');
  // Her telafi bir kayıt: kaynak sipariş, cam ve adet, karar, ÖNCEKİ MÜŞTERİ FİYATI → uygulanan, hedef, kaynak adedi
  const priceRows = admin.locator('.card').first().locator('tr', { hasText: 'Telafi camı: fiyat kararı' }).filter({ hasText: 'UNS7901' });
  await expect(priceRows).toHaveCount(3);
  const free = priceRows.filter({ hasText: 'Karar: Bedelsiz' });
  await expect(free).toContainText('3 × Temper 1000×1000 → UNS7901-T');
  await expect(free).toContainText('teklif doğrudan müşteriye gitti');
  await expect(free).toContainText('Önceki müşteri fiyatı: 66,96 EUR/m² → Telafi: Bedelsiz (müşteri fiyatı)');
  await expect(free).toContainText('Kaynak siparişte kalan adet: 9 → 6');
  const same = priceRows.filter({ hasText: 'Karar: Aynı fiyat' });
  await expect(same).toContainText('Önceki müşteri fiyatı: 66,96 EUR/m² → Telafi: 66,96 EUR/m² (müşteri fiyatı)');
  await expect(same).toContainText('Kaynak siparişte kalan adet: 1 → 0');
  const custom = priceRows.filter({ hasText: 'Karar: Farklı fiyat' });
  await expect(custom).toContainText('Telafi: yönetici belirleyecek');
  await expect(custom).toContainText('Kaynak siparişte kalan adet: 6 → 5');
  await shot(admin, 'telafi-onemli-kararlar');
  const pend = admin.locator('tr', { hasText: 'Telafi camı yönetici onayını bekliyor' }).first();
  await expect(pend).toContainText('UNS7902');
  await expect(pend).toContainText('Karar: Farklı fiyat');
  await expect(pend).toContainText('Kaynak adedi onayla birlikte düşer');
  await pend.getByRole('link', { name: 'Siparişte karar ver' }).click();
  await expect(admin).toHaveURL(new RegExp(`/siparisler/${futureId}`));
  const entry = admin.locator('#kararlar .comp-entry[data-status=PENDING]');
  await expect(entry).toContainText('Kaynak sipariş: UNS7901');
  await expect(entry).toContainText('Önceki müşteri fiyatı: 77,77 EUR/m²');
  await expect(entry).toContainText('Müşteri fiyatını yönetici belirleyecek');
  // Fiyatı yönetici girer: alan boş gelir (önceki fiyat yalnızca ipucu); fiyatsız onaylanamaz
  await expect(entry.locator('input[name=price]')).toHaveValue('');
  await expect(entry.locator('input[name=price]')).toHaveAttribute('placeholder', '77.77');
  await entry.getByRole('button', { name: 'Onayla ve teklife ekle' }).click();
  await expect(admin).toHaveURL(/telafiHata=PRICE_REQUIRED/);
  await expect(admin.locator('#kararlar .alert-error')).toContainText('telafi satırının müşteri fiyatı olmalı');
  await entry.locator('input[name=price]').fill('70');
  await entry.getByRole('button', { name: 'Onayla ve teklife ekle' }).click();
  await expect(admin).toHaveURL(/telafiOk=applied/);
  // Kaynak adedi onayla birlikte düştü (4 → 3)
  await expect(admin.locator('[data-comp-source=dustu]')).toContainText('4 → 3');
  await expect(admin.locator('#teklif tbody tr', { hasText: 'TELAFİ' })).toHaveCount(1);
  await expect(admin.locator('#teklif tbody tr', { hasText: 'TELAFİ' })).toContainText('Lamine');
  await expect(admin.locator('#kararlar .comp-entry[data-status=APPLIED]')).toHaveCount(1);

  const db = await prisma();
  const f = await db.order.findUniqueOrThrow({ where: { id: futureId }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  expect(f.offers.map((o) => o.status)).toEqual(['GONDERILDI', 'GONDERILDI']);
  expect(f.offers[0].lines.map((l) => [l.description, l.adet, Number(l.unitPrice), Number(l.offerPrice), !!l.compensationId])).toEqual([['Temper', 5, 37, 66.96, false], ['Lamine', 1, 41, 70, true]]);
  expect(f.offers[1].lines.length).toBe(1); // eski sürüm değişmedi
  const src = await sentOffer(db, srcId);
  expect([src.versions, src.rows]).toEqual([5, [['Temper', 5], ['Lamine', 3], ['Sandık parası', 1]]]);
  line1 = src.lines[0].id;
  // Bekleyen karar kapandı
  await admin.goto('/admin/kararlar');
  await expect(admin.locator('.card').first().locator('tr', { hasText: 'Telafi camı yönetici onayını bekliyor' }).filter({ hasText: 'UNS7902' })).toHaveCount(0);

  // "Farklı fiyat" telafi siparişi yöneticinin fiyat onayında: cam TELAFİ rozetli, müşteri fiyatı BOŞ — yönetici girer ve
  // olağan düğmeyle müşteriye gönderir (ayrı bir fiyat sistemi yok)
  await admin.goto(`/siparisler/${pricingId}`);
  await expect(admin.locator('h1')).toContainText('Telafi e2e 7901');
  await expect(admin.locator('.line-actions .badge', { hasText: 'TELAFİ' })).toHaveCount(1);
  const price = admin.getByLabel('Müşteri fiyatı', { exact: true });
  await expect(price).toHaveCount(1);
  await expect(price).toHaveValue('');
  await shot(admin, 'telafi-siparisi');
  // Fiyatlandırma penceresi: yönetici fiyatı TASLAK olarak kaydetti, henüz göndermedi. Onaylanmamış fiyat müşteriye hiçbir
  // yoldan gitmez (sayfa HTML'i, RSC verisi, sipariş / teklif / yükleme listeleri, bildirim akışı); telafi siparişinin teklifi
  // müşteride görünmez. Kaynak sipariş müşteride kendi güncel (adedi düşmüş) sürümüyle durur.
  await price.fill('81.37');
  await admin.getByRole('button', { name: 'Taslak olarak kaydet' }).click();
  await expect(admin).toHaveURL(/ok=offer_saved/);
  await expect(price).toHaveValue('81.37');
  const cust = await as(browser, CUSTOMER, CUST_PW);
  for (const url of [`/siparisler/${pricingId}`, `/siparisler/${srcId}`, '/teklifler', '/siparisler', '/yuklemeler', '/bildirimler/akis']) {
    for (const rsc of [false, true]) {
      const res = await cust.request.get(rsc ? `${url}?_rsc=1` : url, { headers: rsc ? { RSC: '1' } : {}, maxRedirects: 0 });
      expect(res.status(), url).toBe(200);
      const body = await res.text();
      for (const secret of ['81,37', '81.37']) expect(body, `${url}${rsc ? ' (RSC)' : ''}: ${secret}`).not.toContain(secret);
    }
  }
  await cust.goto(`/siparisler/${pricingId}`);
  await expect(cust.locator('h1')).toContainText('Telafi e2e 7901');
  await expect(cust.locator('#teklif')).toHaveCount(0);
  await price.fill('72');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText(/Fiyat onaylandı|üretime alındı/).first()).toBeVisible();
  // Yönetici fiyatlandırmayı tamamladı: müşteri nihai teklifi (yöneticinin onayladığı fiyatla) görür; taslaktaki fiyat hiç gitmedi
  await cust.goto(`/siparisler/${pricingId}`);
  await expect(cust.locator('#teklif')).toContainText('72,00');
  expect(await cust.content()).not.toContain('81,37');
  await cust.context().close();
  const t3 = await db.order.findUniqueOrThrow({ where: { id: pricingId }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: true } } } });
  expect([t3.status, t3.offers[0].status, t3.offers[0].lines.map(lineRow)]).toEqual(['URETIMDE', 'GONDERILDI', [['CAM', 1, 37, 72, false, true]]]);
  // Yöneticinin belirlediği fiyat telafi kaydına da yazıldı (uygulanan fiyat izlenebilir)
  const comp = await db.compensation.findFirstOrThrow({ where: { destOrderId: pricingId } });
  expect([comp.priceMode, Number(comp.normalPrice), Number(comp.offerPrice)]).toEqual(['CUSTOM', 66.96, 72]);
  await db.$disconnect();

  // Yöneticinin formu mevcut müşteri fiyatını tutarıyla gösterir; farklı fiyatın tutarı yalnızca yöneticide girilir
  await admin.goto(`/siparisler/${srcId}?telafi=${line1}#telafi`);
  const aform = admin.locator('#telafi');
  await expect(aform).toContainText('Mevcut müşteri fiyatı: 66,96 EUR/m²');
  await expect(aform.locator('label.chip')).toHaveText(['Bedelsiz — 0 EUR/m²', 'Aynı fiyat — 66,96 EUR/m²', 'Farklı fiyat']);
  await expect(aform.locator('input[name=price]')).toHaveCount(0);
  await aform.locator('label.chip', { hasText: 'Farklı fiyat' }).click();
  await expect(aform.locator('input[name=price]')).toHaveCount(1);
  await shot(admin, 'telafi-formu-yonetici');
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
  // Bedelsiz telafi siparişinin teklifi yöneticiye uğramadan müşterinin panelinde (olağan sipariş; TELAFİ rozeti yok)
  await cust.goto(`/siparisler/${freeId}`);
  await expect(cust.locator('#teklif')).toContainText('Temper');
  expect(await cust.content()).not.toContain('TELAFİ');
  // Telafi siparişleri müşterinin "Tekliflerim" listesinde olağan sipariş olarak görünür
  await cust.goto('/teklifler');
  await expect(cust.locator('tr', { hasText: 'UNS7901-T' }).first()).toBeVisible();
  await cust.context().close();
  for (const [email, pw] of [[INSPECTOR, INSPECTOR_PW], [DRAWER, TEAM_PW]] as const) {
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
