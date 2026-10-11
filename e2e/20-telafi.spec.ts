import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, INSPECTOR_PW } from './helpers';

// Aşama 9 — kırık / telafi camı (karar 108–109), fonksiyonel paket 1 (karar 157) ve siparişi silme / geri yükleme (karar 110).
//  - teklif tablosunda yalnızca fiziksel cam satırında "Kırık / Telafi"; form: cam → adet → fiyat → hedef → özet + açık onay
//  - fiyat (karar 157, 251): üç karar — Bedelsiz · Aynı fiyat (kaynağın fiyatları; sunucu taşır) · Farklı fiyat (yanında
//    fiyat alanı: satışta SATIŞ fiyatı, yöneticide müşteri fiyatı). Satış hiçbir müşteri fiyatı tutarı görmez.
//  - Kaynakta müşteri fiyatı varsa her karar doğrudan müşteriye gider (yönetici onayı yok); yönetici "Önemli kararlar",
//    bildirim ve e-postayla haberdar olur (bekleyen karar / fiyat onayı yolu: test/db/compensation*.test.js)
//  - kaynak adedi: BEDELLİ telafi açılınca ana siparişte o camın adedi düşer (temiz siparişte; teklifin yeni sürümü);
//    BEDELSİZ telafide kaynak adedi hiç değişmez — ayrı ek üretimdir (karar 256)
//  - işlemler (karar 113, 251): CNC tek bir cama aittir — işlemsiz cam işlem miras almaz; işlemli tek camın işlemi telafiye
//    taşınır; fiyatı bedelsizde 0, aynı / farklı fiyatta kaynaktaki gibi
//  - siparişi sil: yalnızca yönetici, iki aşama (sipariş no + sonuç → sipariş numarasını yazarak son onay); sipariş olağan
//    ekranlardan kalkar; geri yüklenir (mali geçmişi olan siparişin silinmemesi: e2e/38-yonetici-paneli.spec.ts)
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

test('satış: bedelsiz → UNS7901-T doğrudan müşteride, kaynak 9 adet DEĞİŞMEZ (karar 256); işlemli tek cam aynı fiyatla → UNS7901-T2 (CNC fiyatıyla taşınır, kaynak 1 → 0); farklı fiyat → satış fiyatı girilir, yönetici onayı beklenmez (karar 251); satış müşteri fiyatını görmez', async ({ browser }) => {
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
  // Üç seçenek; satış kendi satış fiyatını görür (37), müşteri fiyatını görmez. "Farklı fiyat"ın yanında fiyat alanı;
  // "Önceki müşteri fiyatı", "Akış" satırları ve düğmelerin altındaki açıklamalar yok (karar 251)
  await expect(form.locator('label.chip')).toHaveText(['Bedelsiz — 0 EUR/m²', 'Aynı fiyat — 37,00 EUR/m²', 'Farklı fiyat']);
  await expect(form.locator('input[name=modeChoice][value=NORMAL]')).toBeChecked();
  const priceInput = form.locator('input[name=price]');
  await expect(priceInput).toHaveCount(1);
  await expect(priceInput).toBeDisabled();
  await expect(priceInput).toHaveAttribute('placeholder', 'Telafi fiyatı (EUR/m²)');
  await form.locator('label.chip', { hasText: 'Farklı fiyat' }).click();
  await expect(priceInput).toBeEnabled();
  await expect(form.locator('[data-mode-hint]')).toHaveCount(0);
  await expect(form).not.toContainText('Mevcut müşteri fiyatı');
  // Temiz kaynakta "adet düşmez" uyarısı yok
  await expect(form.locator('[data-source-kept]')).toHaveCount(0);
  // Cam seçimi fiziksel yapılandırmayı gösterir: işlemsiz camlar ve CNC'li tek cam ayrı seçeneklerdir
  await expect(form.locator('#comp-line option', { hasText: 'işlemsiz' })).toHaveCount(2);
  await expect(form.locator('#comp-line option', { hasText: 'CNC × 1' })).toHaveCount(1);
  await expect(form).not.toContainText('telafiye aynen taşınır'); // seçili cam işlemsiz
  const html = await page.content();
  expect(html).not.toContain('66,96');
  expect(html).not.toContain('66.96');
  expect(html).not.toContain('77.77');
  await form.locator('#comp-qty').fill('3');
  await form.locator('label.chip', { hasText: 'Bedelsiz' }).click();
  await expect(priceInput).toBeDisabled();
  // İki hedef seçeneği de her zaman var: müşterinin ileri tarihli siparişi ve yeni telafi siparişi
  await expect(form.getByText('Müşterinin ileri tarihli siparişine ekle')).toBeVisible();
  await expect(form.locator('select[name=destOrderId] option', { hasText: 'UNS7902' })).toHaveCount(1);
  const submit = form.getByRole('button', { name: 'Telafi camını ekle' });
  await expect(submit).toBeDisabled();
  await form.locator('input[name=destChoice][value=NEW]').check();
  await form.locator('#comp-day').fill(NEW_DAY);
  const summary = form.locator('.comp-summary');
  await expect(summary).toContainText('UNS7901');
  await expect(summary.locator('[data-sum=fiyat]')).toContainText('0,00 EUR/m² (Bedelsiz)');
  await expect(summary).toContainText('Yeni telafi siparişi (UNS7901-T)');
  await expect(summary).toContainText(dmy(NEW_DAY));
  // Bedelsiz telafi kaynaktan düşmez (karar 256): özet bunu söyler
  await expect(summary.locator('[data-sum=kaynak]')).toContainText('9 adet — değişmez (bedelsiz telafi ayrı ek üretimdir)');
  await expect(summary.locator('[data-source-free]')).toHaveCount(1);
  await expect(summary.locator('[data-sum=akis]')).toHaveCount(0);
  await expect(summary).not.toContainText('Önceki müşteri fiyatı');
  await expect(summary).toContainText('Yukarıdaki kararı onaylıyorum: 3 cam telafi olarak eklensin.');
  await expect(submit).toBeDisabled(); // açık onay olmadan eklenmez
  await shot(page, 'telafi-formu');
  await summary.locator('.comp-confirm input').check();
  await submit.click();
  await expect(page).toHaveURL(/telafiOk=sent/);
  await expect(page.locator('.alert-ok', { hasText: 'Telafi siparişi açıldı: UNS7901-T. Teklifi müşteriye gönderildi' })).toBeVisible();
  await expect(page.locator('[data-comp-source=FREE]')).toContainText('Bedelsiz telafi: kaynak siparişin adedi değişmedi');
  await expect(page.locator('[data-comp-source=dustu]')).toHaveCount(0);
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
  // Kaynak DEĞİŞMEDİ: yeni teklif sürümü yok, 9 cam aynen (bedelsiz telafi ayrı ek üretimdir)
  let src = await sentOffer(db, srcId);
  expect([src.versions, src.rows]).toEqual([1, [['Temper', 9], ['Temper', 1], ['CNC', 1], ['Lamine', 4], ['Sandık parası', 1]]]);
  expect([src.lines[0].id, src.lines[1].id, src.lines[3].id]).toEqual([line1, lineOp, line2]);

  // --- "Önemli kararlar" → aynı form; cam burada seçilir; önceki telafi gösterilir.
  // İşlemli TEK cam, AYNI FİYAT, yeni telafi siparişi: CNC kaynaktaki fiyatlarıyla taşınır (karar 251 — 0'a düşmez)
  await card.getByRole('link', { name: 'Kırık / Telafi Camı Oluştur' }).click();
  await expect(form).toBeVisible();
  await expect(form.locator('#comp-line')).toHaveValue('');
  await form.locator('#comp-line').selectOption(line1);
  await expect(form.locator('.comp-history')).toContainText('3 adet → UNS7901-T');
  await form.locator('#comp-line').selectOption(lineOp);
  await expect(form).toContainText('Bu camın işlemleri telafiye aynen taşınır: CNC × 1');
  await expect(form).toContainText('En çok 1'); // işlemli cam tek adettir
  await expect(form.locator('input[name=modeChoice][value=NORMAL]')).toBeChecked(); // "Aynı fiyat" seçili gelir
  await form.locator('input[name=destChoice][value=NEW]').check();
  await form.locator('#comp-day').fill(NEW_DAY);
  await expect(summary.locator('[data-sum=fiyat]')).toContainText('37,00 EUR/m²');
  await expect(summary).toContainText('Yeni telafi siparişi (UNS7901-T2)');
  await expect(summary.locator('[data-sum=islem]')).toContainText('CNC × 1');
  await expect(summary.locator('[data-sum=islem]')).toContainText('— kaynak fiyatlarıyla');
  await expect(summary.locator('[data-sum=kaynak]')).toContainText('1 → 0 adet');
  await shot(page, 'telafi-islemli-cam');
  await summary.locator('.comp-confirm input').check();
  await form.getByRole('button', { name: 'Telafi camını ekle' }).click();
  await expect(page.locator('.alert-ok', { hasText: 'Telafi siparişi açıldı: UNS7901-T2.' })).toBeVisible();
  await expect(page.locator('[data-comp-source=dustu]')).toContainText('1 → 0');
  const t2 = await db.order.findUniqueOrThrow({ where: { orderNo: 'UNS7901-T2' }, include: full });
  expect([t2.status, t2.offers[0].status]).toEqual(['URETIMDE', 'GONDERILDI']);
  // Cam ve CNC kaynaktaki fiyatlarıyla (satış 37 / 5, müşteri 66,96 / 8)
  expect(t2.offers[0].lines.map(lineRow)).toEqual([['CAM', 1, 37, 66.96, false, true], ['CNC', 1, 5, 8, false, true]]);
  // Kaynakta işlemli cam ve CNC satırı kalktı (telafiye taşındı)
  src = await sentOffer(db, srcId);
  expect([src.versions, src.rows]).toEqual([2, [['Temper', 9], ['Lamine', 4], ['Sandık parası', 1]]]);
  [line1, line2] = [src.lines[0].id, src.lines[1].id];

  // --- FARKLI FİYAT, yeni telafi siparişi: satış kendi satış fiyatını girer (39); müşteri fiyatı kaynağınki kalır. Yönetici
  // onayı beklenmez: teklif doğrudan müşteriye, sipariş üretime (karar 251)
  await card.getByRole('link', { name: 'Kırık / Telafi Camı Oluştur' }).click();
  await form.locator('#comp-line').selectOption(line1);
  await form.locator('label.chip', { hasText: 'Farklı fiyat' }).click();
  await form.locator('input[name=destChoice][value=NEW]').check();
  await form.locator('#comp-day').fill(NEW_DAY);
  await expect(summary).toHaveCount(0); // fiyat girilmeden özet / onay yok
  await priceInput.fill('39');
  await expect(summary).toContainText('Yeni telafi siparişi (UNS7901-T3)');
  await expect(summary.locator('[data-sum=fiyat]')).toContainText('39,00 EUR/m²');
  await expect(summary).not.toContainText('yönetici belirleyecek');
  await expect(summary.locator('[data-sum=kaynak]')).toContainText('9 → 8 adet');
  await summary.locator('.comp-confirm input').check();
  await form.getByRole('button', { name: 'Telafi camını ekle' }).click();
  await expect(page).toHaveURL(/telafiOk=sent/);
  await expect(page.locator('.alert-ok', { hasText: 'Telafi siparişi açıldı: UNS7901-T3. Teklifi müşteriye gönderildi' })).toBeVisible();
  entry = card.locator('.comp-entry').first();
  await expect(entry.locator('[data-comp-mode=CUSTOM]')).toHaveText('Farklı fiyat');
  await expect(entry).toContainText('Telafi fiyatı (satış): 39,00 EUR/m²');
  await expect(entry).not.toContainText('Müşteri fiyatını yönetici belirleyecek');
  const t3 = await db.order.findUniqueOrThrow({ where: { orderNo: 'UNS7901-T3' }, include: full });
  pricingId = t3.id;
  expect([t3.status, t3.offers[0].status, t3.offers[0].sentAt instanceof Date]).toEqual(['URETIMDE', 'GONDERILDI', true]);
  expect(t3.offers[0].lines.map(lineRow)).toEqual([['CAM', 1, 39, 66.96, false, true]]);
  src = await sentOffer(db, srcId);
  expect([src.versions, src.rows]).toEqual([3, [['Temper', 8], ['Lamine', 4], ['Sandık parası', 1]]]);
  [line1, line2] = [src.lines[0].id, src.lines[1].id];

  // --- FARKLI FİYAT, müşterinin ileri tarihli siparişine (teklifi müşteride): yönetici onayı beklenmez — yeni sürüm hemen gider
  await card.getByRole('link', { name: 'Kırık / Telafi Camı Oluştur' }).click();
  await form.locator('#comp-line').selectOption(line2);
  await expect(form.locator('.comp-history')).toHaveCount(0);
  await form.locator('input[name=destChoice][value=EXISTING]').check();
  const option = form.locator('select[name=destOrderId] option', { hasText: 'UNS7902' });
  await form.locator('label.chip', { hasText: 'Farklı fiyat' }).click();
  await priceInput.fill('43');
  await expect(option).toHaveText(`UNS7902 — ${dmy(FUTURE_DAY)}`); // "yönetici onayı gerekir" yazmaz
  await form.locator('select[name=destOrderId]').selectOption(futureId);
  await expect(summary).not.toContainText('karar yöneticinin onayını bekler');
  await summary.locator('.comp-confirm input').check();
  await form.getByRole('button', { name: 'Telafi camını ekle' }).click();
  await expect(page).toHaveURL(/telafiOk=updated/);
  await expect(page.locator('[data-comp-source=dustu]')).toContainText('4 → 3');
  await expect(card.locator('.comp-entry[data-status=PENDING]')).toHaveCount(0);
  await shot(page, 'telafi-kararlar');
  const f = await db.order.findUniqueOrThrow({ where: { id: futureId }, include: { offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  expect(f.offers.map((o) => o.status)).toEqual(['GONDERILDI', 'GONDERILDI']);
  expect(f.offers[0].lines.map((l) => [l.description, l.adet, Number(l.unitPrice), Number(l.offerPrice), !!l.compensationId])).toEqual([['Temper', 5, 37, 66.96, false], ['Lamine', 1, 43, 77.77, true]]);
  expect(f.offers[1].lines.length).toBe(1); // eski sürüm değişmedi
  src = await sentOffer(db, srcId);
  expect([src.versions, src.rows]).toEqual([4, [['Temper', 8], ['Lamine', 3], ['Sandık parası', 1]]]);
  line1 = src.lines[0].id;

  // "Önemli kararlar": telafi başına BİR kayıt (dört karar kaynakta); bekleyen karar yok
  expect(await db.adminAlert.count({ where: { type: 'COMPENSATION_PRICE', orderId: srcId } })).toBe(4);
  expect(await db.adminAlert.count({ where: { type: 'COMPENSATION_PENDING' } })).toBe(0);
  // Satış müşteri fiyatını hiçbir yerde görmedi
  const after = await page.content();
  for (const secret of ['66,96', '66.96', '77,77', '77.77']) expect(after, secret).not.toContain(secret);

  // Kapalı ("Yüklendi") sipariş: form kaynak adedinin düşmeyeceğini (ek üretim) kayıttan önce söyler
  await page.goto(`/siparisler/${closedId}?telafi=sec#telafi`);
  await expect(form.locator('[data-source-kept=CLOSED]')).toContainText('adedi düşürülmez; telafi ek üretim olarak açılır');
  await db.$disconnect();
  await page.context().close();
});

test('yönetici: her telafi "Önemli kararlar"da (karar, önceki → uygulanan fiyat, kaynak adedi); satışın farklı fiyatı bilgidir — müşteri fiyatını isterse "Teklifi güncelle" ile değiştirir; formunda müşteri fiyatları', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/kararlar');
  // Her telafi bir kayıt: kaynak sipariş, cam ve adet, karar, önceki → uygulanan fiyat, hedef, kaynak adedi
  const priceRows = admin.locator('.card').first().locator('tr', { hasText: 'Telafi camı: fiyat kararı' }).filter({ hasText: 'UNS7901' });
  await expect(priceRows).toHaveCount(4);
  const free = priceRows.filter({ hasText: 'Karar: Bedelsiz' });
  await expect(free).toContainText('3 × Temper 1000×1000 → UNS7901-T');
  await expect(free).toContainText('teklif doğrudan müşteriye gitti');
  await expect(free).toContainText('Önceki müşteri fiyatı: 66,96 EUR/m² → Telafi: Bedelsiz (müşteri fiyatı)');
  await expect(free).toContainText('Kaynak adedi değişmedi (bedelsiz telafi — kaynak adedi değişmez)');
  const same = priceRows.filter({ hasText: 'Karar: Aynı fiyat' });
  await expect(same).toContainText('Önceki müşteri fiyatı: 66,96 EUR/m² → Telafi: 66,96 EUR/m² (müşteri fiyatı)');
  await expect(same).toContainText('Kaynak siparişte kalan adet: 1 → 0');
  // Satışın farklı fiyatı: satış kademesinde (37 → 39); müşteri fiyatı değişmedi — yönetici isterse günceller
  const custom = priceRows.filter({ hasText: 'Karar: Farklı fiyat' }).filter({ hasText: 'UNS7901-T3' });
  await expect(custom).toContainText('Önceki satış fiyatı: 37,00 EUR/m² → Telafi: 39,00 EUR/m² — müşteri fiyatı değişmedi');
  await expect(custom).toContainText('teklif doğrudan müşteriye gitti');
  await expect(custom).toContainText('Kaynak siparişte kalan adet: 9 → 8');
  await expect(admin.locator('tr', { hasText: 'Telafi camı yönetici onayını bekliyor' })).toHaveCount(0);
  await shot(admin, 'telafi-onemli-kararlar');

  // Telafi siparişi müşteride; yönetici sipariş sayfasında satış kademesi bilgisini görür ve müşteri fiyatını olağan
  // "Teklifi güncelle" ile değiştirebilir (ayrı bir onay / fiyat sistemi yok)
  await admin.goto(`/siparisler/${srcId}#kararlar`);
  const entry = admin.locator('#kararlar .comp-entry', { hasText: 'UNS7901-T3' });
  await expect(entry.locator('[data-comp-sales-tier]')).toContainText('müşteri fiyatı kaynak teklifteki gibi kaldı');
  await admin.goto(`/siparisler/${pricingId}`);
  await expect(admin.locator('#teklif [data-comp-tag]')).toHaveText('Telafi UNS7901-T3');
  await expect(admin.getByRole('link', { name: 'Teklifi güncelle' })).toBeVisible();

  const db = await prisma();
  const comp = await db.compensation.findFirstOrThrow({ where: { destOrderId: pricingId } });
  expect([comp.priceMode, comp.priceTier, Number(comp.normalCost), Number(comp.unitCost), Number(comp.normalPrice), Number(comp.offerPrice)]).toEqual(['CUSTOM', 'SALES', 37, 39, 66.96, 66.96]);
  // Yöneticiye e-posta olayı (tutar yok, bekleyen fiyat yok) ve uygulama içi bildirim
  const mail = await db.notificationOutbox.findFirstOrThrow({ where: { type: 'ORDER_COMPENSATION_PRICE', orderId: pricingId } });
  expect([mail.payload && (mail.payload as Record<string, unknown>).mode, (mail.payload as Record<string, unknown>).pending]).toEqual(['CUSTOM', false]);
  expect(await db.notification.count({ where: { type: 'COMPENSATION_CUSTOM', dedupeKey: `comp:${comp.id}` } })).toBeGreaterThan(0);
  await db.$disconnect();

  // Müşteri telafi siparişinin teklifini kaynağın müşteri fiyatıyla görür; satış fiyatı (39) müşteriye gitmez
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/siparisler/${pricingId}`);
  await expect(cust.locator('#teklif')).toContainText('66,96');
  expect(await cust.content()).not.toContain('39,00');
  await cust.context().close();

  // Yöneticinin formu: düğmelerde müşteri fiyatları; "Farklı fiyat"ın yanındaki alan müşteri fiyatıdır
  await admin.goto(`/siparisler/${srcId}?telafi=${line1}#telafi`);
  const aform = admin.locator('#telafi');
  await expect(aform.locator('label.chip')).toHaveText(['Bedelsiz — 0 EUR/m²', 'Aynı fiyat — 66,96 EUR/m²', 'Farklı fiyat']);
  await expect(aform.locator('input[name=price]')).toBeDisabled();
  await aform.locator('label.chip', { hasText: 'Farklı fiyat' }).click();
  await expect(aform.locator('input[name=price]')).toBeEnabled();
  await expect(aform).not.toContainText('Mevcut müşteri fiyatı');
  await shot(admin, 'telafi-formu-yonetici');
  await admin.context().close();
});

test('müşteri, çizim ve denetimci: telafi düğmesi ve "Önemli kararlar" müşteride yok; müşteri gerçek telafi numarasını görür (karar 231); siparişi sil bölümü yalnızca yöneticide', async ({ browser }) => {
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
  // Telafi etiketi (karar 231): müşteri de görür — kaynak siparişin numarasıyla; iç "TELAFİ" rozeti yok
  await expect(cust.locator('#teklif [data-comp-tag]')).toHaveText('UNS7901 telafisi');
  expect(await cust.content()).not.toContain('TELAFİ');
  // Bedelsiz telafi siparişinin teklifi yöneticiye uğramadan müşterinin panelinde: gerçek telafi numarası; fiziksel ve
  // faturalanacak cam ayrı yazılır (bedelsiz cam faturalanmaz)
  await cust.goto(`/siparisler/${freeId}`);
  await expect(cust.locator('#teklif')).toContainText('Temper');
  await expect(cust.locator('#teklif [data-comp-tag]').first()).toHaveText('Telafi UNS7901-T');
  await expect(cust.locator('#teklif [data-physical]')).toContainText('Faturalanacak: 0 cam');
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

test('yönetici: siparişi sil iki aşamalıdır; sipariş olağan ekranlardan kalkar, kayıtlar durur; geri yüklenir — başka rol geri yükleyemez', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${removeId}`);
  const box = admin.locator('#sil');
  // 1. aşama (fonksiyonel paket 4): silinecek sipariş numarası ve sonucu; "Vazgeç" bölümü kapatır
  await expect(box.locator('[data-remove-step]')).toHaveCount(0);
  await box.getByRole('button', { name: 'Siparişi sil' }).click();
  const step1 = box.locator('[data-remove-step="1"]');
  await expect(step1).toContainText('Silinecek sipariş: UNS7903');
  await expect(step1).toContainText('Kayıtlar silinmez');
  await expect(step1.locator('[data-remove-blocked]')).toHaveCount(0);
  await step1.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(box.locator('[data-remove-step]')).toHaveCount(0);
  // 2. aşama: ayrı son onay — sipariş numarası yazılmadan (ya da yanlış yazılınca) kırmızı düğme çalışmaz; "Vazgeç" kapatır
  await box.getByRole('button', { name: 'Siparişi sil' }).click();
  await box.getByRole('button', { name: 'Devam et' }).click();
  const step2 = box.locator('[data-remove-step="2"]');
  const submit = step2.locator('button.btn-danger-solid');
  await expect(submit).toHaveText('Siparişi sil');
  await expect(submit).toBeDisabled();
  await step2.getByLabel('Silmeyi onaylamak için sipariş numarasını yazın: UNS7903').fill('UNS7904');
  await expect(submit).toBeDisabled();
  await step2.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(box.locator('[data-remove-step]')).toHaveCount(0);
  await box.getByRole('button', { name: 'Siparişi sil' }).click();
  await box.getByRole('button', { name: 'Devam et' }).click();
  await shot(admin, 'siparis-sil');
  await step2.getByLabel('Silmeyi onaylamak için sipariş numarasını yazın: UNS7903').fill('uns7903');
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
