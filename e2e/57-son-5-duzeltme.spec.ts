import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, TEAM_PW, as, sampleFile } from './helpers';
import { PdfDoc } from '../server/pdf/pdf.js';
import { form } from '../test/fixtures/factory-pdf.js';

// 3.77.0 — son beş düzeltme, gerçek sunucuda (gerçek ClamAV ile):
//  - tireli müşteri sipariş numarası (karar 259): "UNS5701-1" yazılır → firma kodu atılır, "5701-1" metin olarak saklanır,
//    sipariş sayfasında ve aramada aynı değer
//  - silinen siparişin numarası (karar 260): yönetici siler → müşteri aynı numarayla yeniden sipariş açar; eski sipariş
//    silinmiş listede kalır, geri yükleme dolu numarayı reddeder
//  - aynı fabrika PDF'i (karar 263): satırlar durdukça engel; satırlar silinip kaydedilince aynı PDF ön izleme + onayla yeniden
//  - metraj 3 ondalık (karar 261): PDF'in 4,772 m²si aynen; satış metrajı elle düzeltir, kayıtta ve yeniden açılışta kalır
//  - normal / şekilli (karar 262): PDF'ten tanınır, satış değiştirir; fiyat / POZ / ölçü / işlem değişmez
// PDF'ler TAKİP'in PDF yazıcısıyla üretilen SENTETİK fabrika formlarıdır (gerçek müşteri / fiyat yok).
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı
const GLASS_LABEL = '10 MM TEMPER CAM — BRONZ'; // 07'nin kataloğu (55 ile aynı cam)
const GLASS_PDF = '10 mm Temperli Bronz Cam DR';

function factoryPdf(lines: { page: number; text: string }[]): Buffer {
  const doc = new PdfDoc({ title: 'Siparis Formu' });
  let page = doc.addPage();
  let y = 40;
  for (const l of lines) {
    if (y > 800) { page = doc.addPage(); y = 40; }
    page.text(20, y, l.text, { size: 7 });
    y += 12;
  }
  return Buffer.from(doc.toBuffer());
}
const file = (name: string, buffer: Buffer) => ({ name, mimeType: 'application/pdf', buffer });
async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

async function newGlassOrder(cust: Page, title: string, no?: string) {
  await cust.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await cust.fill('#title', title);
  if (no != null) await cust.fill('#no', no);
  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: GLASS_LABEL });
  await cust.setInputFiles('#files', sampleFile(`${title.replace(/\W+/g, '-')}.pdf`));
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
}

const values = (p: Page, label: string) => p.getByLabel(label, { exact: true }).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));

test('tireli numara ve silinen numaranın yeniden kullanımı: arayüz ve sunucu', async ({ browser }) => {
  test.setTimeout(120_000);
  const cust = await as(browser, CUSTOMER, CUST_PW);
  // Firma koduyla yazılan tireli numara: kod atılır, numara metin olarak saklanır (tire korunur)
  await newGlassOrder(cust, 'Tireli numara', 'UNS5701-1');
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/, { timeout: 45_000 });
  const firstUrl = new URL(cust.url()).pathname;
  await expect(cust.locator('.page-head .mono').first()).toHaveText('UNS5701-1');
  await expect(cust.locator('main')).toContainText('5701-1');
  // Arama: yazıldığı gibi
  await cust.goto('/siparisler?q=5701-1');
  await expect(cust.locator('main')).toContainText('UNS5701-1');
  // Geçersiz biçim sunucuda reddedilir (formun deseni atlanarak gönderilse de)
  await cust.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await cust.locator('#no').evaluate((el: HTMLInputElement) => el.removeAttribute('pattern'));
  await cust.fill('#title', 'Bozuk numara');
  await cust.fill('#no', '57--1');
  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: GLASS_LABEL });
  await cust.setInputFiles('#files', sampleFile('bozuk-numara.pdf'));
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(cust.locator('.alert-error')).toContainText('Sipariş numarası rakamlardan oluşmalı');
  // Etkin siparişin numarası yeniden kullanılamaz
  await newGlassOrder(cust, 'Aynı numara', '5701-1');
  await expect(cust.locator('.alert-error')).toContainText('UNS5701-1 numaralı bir sipariş zaten var');

  // Yönetici siparişi siler (iki aşamalı onay)
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(firstUrl);
  const box = admin.locator('#sil');
  await box.getByRole('button', { name: 'Siparişi sil' }).click();
  await box.getByRole('button', { name: 'Devam et' }).click();
  await box.locator('[data-remove-step="2"]').getByLabel('Silmeyi onaylamak için sipariş numarasını yazın: UNS5701-1').fill('UNS5701-1');
  await box.locator('[data-remove-step="2"] button.btn-danger-solid').click();
  await expect(admin).toHaveURL(/silindi=UNS5701-1/);

  // Müşteri aynı numarayla yeniden sipariş açar: kabul edilir, yeni sipariş (eski geçmiş taşınmaz)
  await newGlassOrder(cust, 'Yeniden aynı numara', '5701-1');
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/, { timeout: 45_000 });
  const secondUrl = new URL(cust.url()).pathname;
  expect(secondUrl).not.toBe(firstUrl);
  await expect(cust.locator('.page-head .mono').first()).toHaveText('UNS5701-1');
  const db = await prisma();
  try {
    const rows = await db.order.findMany({ where: { orderNo: 'UNS5701-1' }, orderBy: { createdAt: 'asc' }, include: { events: true } });
    expect(rows.map((r) => [r.customerOrderNo, !!r.removedAt, r.numberActive])).toEqual([['5701-1', true, null], ['5701-1', false, true]]);
    expect(rows[1].events.map((e) => e.event)).toEqual(['CREATED']);
  } finally {
    await db.$disconnect();
  }
  // Geri yükleme: numara yeni siparişte → reddedilir (iki etkin sipariş aynı numarayı taşıyamaz)
  await admin.goto('/siparisler#silinen');
  await admin.locator('#silinen > details > summary').click();
  await admin.locator('#silinen tr[data-removed="UNS5701-1"]').getByRole('button', { name: 'Geri yükle' }).click();
  await expect(admin.locator('#silinen .alert-error')).toContainText('numarası silindikten sonra yeni bir siparişe verildi');
  for (const p of [cust, admin]) await p.context().close();
});

test('PDF aktarımı: metraj 3 ondalık, normal / şekilli cam, satırlar silinince aynı PDF yeniden aktarılır', async ({ browser }) => {
  test.setTimeout(240_000);
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await newGlassOrder(cust, 'Son bes duzeltme PDF');
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/, { timeout: 45_000 });
  const orderUrl = new URL(cust.url()).pathname;
  const orderNo = (await cust.locator('.page-head .mono').first().textContent())!.trim();
  const [, code, no] = /^([A-Z]{3})(\d+)$/.exec(orderNo)!;
  // 1183 × 2017 = 2,386 m² (3 ondalık): 2 adet 4,772 m² × 60 = 286,32; şekilli cam 1,000 m²
  const pdf = factoryPdf(form({
    no: '97701', project: `MUSTERIX ${code} ${no}`,
    rows: [`1 ${GLASS_PDF}`, '1183 2017 2 2,386 4,772 60,00 TL 0,0 286,32 POZ-S1', `2 ${GLASS_PDF} - ŞEKİLLİ`, '1000 1000 1 1,000 1,000 60,00 TL 0,0 60,00 POZ-S2'],
    total: '3 5,772 346,32', sub: '346,32', vat: '69,26', grand: '415,58',
  }));

  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(orderUrl);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  const dlg = sales.locator('dialog.pdf-import[open]');
  const upload = async (name: string) => {
    await sales.getByRole('button', { name: "PDF'den Aktar" }).click();
    await expect(dlg).toBeVisible();
    await sales.setInputFiles('#pdf-files', [file(name, pdf)]);
    await dlg.getByRole('button', { name: 'Yükle ve ön izle' }).click();
    await expect(dlg.locator('[data-pdf-file="97701"]')).toBeVisible({ timeout: 60_000 });
  };
  await upload('fabrika-sekilli.pdf');
  await expect(dlg.locator('[data-pdf-shape]')).toHaveText(['Normal', 'Şekilli']);
  await expect(dlg.locator('[data-pdf-file="97701"] [data-check="b"]')).toHaveAttribute('data-diff', '0');
  await dlg.getByRole('button', { name: 'Teklif tablosuna aktar' }).click();
  await expect(sales).toHaveURL(/ok=pdf_imported/, { timeout: 45_000 });

  // Teklif tablosu: PDF metrajı aynen (4,772 — 2 ondalığa yuvarlanmadan), tür PDF'ten
  const m2 = sales.locator('[data-m2-input]');
  const shape = sales.locator('select[data-shape]');
  expect(await m2.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(['4,772', '1,000']);
  expect(await shape.evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value))).toEqual(['normal', 'shaped']);
  await expect(sales.locator('#offer-table tfoot')).toContainText('5,772 m²');

  // Satış: normal → şekilli, şekilli → normal; ikinci satırın metrajını elle 1,005 yapar; kaydeder ve yeniden açar
  const before = { price: await values(sales, 'Birim fiyat'), poz: await values(sales, 'Poz'), en: await values(sales, 'En'), adet: await values(sales, 'Adet') };
  await shape.nth(0).selectOption('shaped');
  await shape.nth(1).selectOption('normal');
  await m2.nth(1).fill('1,005');
  await m2.nth(1).blur();
  await expect(sales.locator('#offer-table tfoot')).toContainText('5,777 m²');
  await sales.getByRole('button', { name: 'Taslak olarak kaydet' }).click();
  await expect(sales).toHaveURL(/ok=offer_saved/);
  await sales.reload();
  expect(await sales.locator('select[data-shape]').evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value))).toEqual(['shaped', 'normal']);
  expect(await sales.locator('[data-m2-input]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(['4,772', '1,005']);
  expect({ price: await values(sales, 'Birim fiyat'), poz: await values(sales, 'Poz'), en: await values(sales, 'En'), adet: await values(sales, 'Adet') }).toEqual(before);

  // Aynı PDF: satırlar teklifte durdukça engellenir
  await upload('fabrika-sekilli-tekrar.pdf');
  await expect(dlg.locator('[data-pdf-file="97701"] [data-code="ALREADY_IMPORTED"]')).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Teklif tablosuna aktar' })).toBeDisabled();
  await dlg.getByRole('button', { name: 'Kapat' }).click();

  // Satış aktarılan satırların TAMAMINI siler ve kaydeder → aynı PDF yeniden yüklenir, ön izlenir ve onaylanır
  while (await sales.getByRole('button', { name: 'Satırı sil' }).count() > 0 && (await values(sales, 'En')).some(Boolean)) {
    await sales.getByRole('button', { name: 'Satırı sil' }).first().click();
  }
  await sales.getByRole('button', { name: 'Taslak olarak kaydet' }).click();
  await expect(sales).toHaveURL(/ok=offer_saved/);
  await upload('fabrika-sekilli-yeniden.pdf');
  await expect(dlg.locator('[data-pdf-file="97701"] [data-pdf-blocking]')).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Teklif tablosuna aktar' }).click();
  await expect(sales).toHaveURL(/ok=pdf_imported/, { timeout: 45_000 });
  expect(await values(sales, 'En')).toEqual(['1183', '1000']);
  expect(await sales.locator('select[data-shape]').evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value))).toEqual(['normal', 'shaped']);

  const db = await prisma();
  try {
    const imports = await db.offerImport.findMany({ where: { order: { orderNo } }, orderBy: { createdAt: 'asc' }, select: { id: true, status: true, checksum: true, storageKey: true } });
    // Aynı dosya: ilk aktarım (satırları silinmiş, geçmiş olarak durur) + yeniden aktarım — iki kayıt, özgün PDF saklanmaz
    expect(imports.map((i) => i.status)).toEqual(['APPLIED', 'APPLIED']);
    expect(new Set(imports.map((i) => i.checksum)).size).toBe(1);
    expect(imports.every((i) => i.storageKey === null)).toBe(true);
    const lines = await db.offerLine.findMany({ where: { importId: { not: null }, offer: { order: { orderNo } } }, orderBy: { sortOrder: 'asc' } });
    expect(lines.map((l) => [l.importId, Number(l.pieceM2), l.shaped])).toEqual([[imports[1].id, 2.386, false], [imports[1].id, 1, true]]);
  } finally {
    await db.$disconnect();
  }
  for (const p of [cust, sales]) await p.context().close();
});
