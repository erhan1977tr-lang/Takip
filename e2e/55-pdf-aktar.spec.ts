import { test, expect } from '@playwright/test';
import { CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as, sampleFile } from './helpers';
import { PdfDoc } from '../server/pdf/pdf.js';
import { readXlsx } from '../server/files/xlsx.js';
import { form } from '../test/fixtures/factory-pdf.js';

// Fabrika PDF'i aktarımı (karar 255) — gerçek sunucuda, gerçek ClamAV ile: satış birden çok fabrika PDF'ini yükler, ön izler,
// yanlış projeyi dışarıda bırakıp onaylar; satırlar (Poz, ölçü, adet, alış fiyatı) teklif tablosuna gelir, müşteri fiyatı
// yoktur, teklif yöneticiye KENDİLİĞİNDEN gitmez — satış elle gönderir. Özgün PDF saklanmaz (okunduktan sonra silinir).
// PDF'ler bu testte TAKİP'in PDF yazıcısıyla üretilen SENTETİK fabrika formlarıdır (gerçek müşteri / fiyat yok).
const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)
const INSPECTOR = 'denetim@e2e.test';
const GLASS_LABEL = '10 MM TEMPER CAM — BRONZ'; // 07'nin kataloğu (26-excel-aktar ile aynı cam)
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

test.describe.configure({ mode: 'serial' });

test('PDF’den aktar: çoklu PDF, ön izleme, yanlış proje engeli, mükerrer engeli, aktarma ve elle yöneticiye gönderme; özgün PDF saklanmaz; müşteri / denetimci aktarımı görmez', async ({ browser }) => {
  test.setTimeout(180_000);
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await cust.fill('#title', 'PDF aktarma');
  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: GLASS_LABEL });
  await cust.setInputFiles('#files', sampleFile('cizim-pdf-aktar.pdf'));
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/, { timeout: 45_000 });
  const orderUrl = new URL(cust.url()).pathname;
  const orderNo = (await cust.locator('.page-head .mono').first().textContent())!.trim();
  const [, code, no] = /^([A-Z]{3})(\d+)$/.exec(orderNo)!;

  const pdf1 = factoryPdf(form({
    no: '97001', project: `MUSTERIX ${code} ${no}`,
    rows: [`1 ${GLASS_PDF}`, '1000 2000 1 2,000 2,000 60,00 TL 0,0 120,00 POZ-A', 'CNC İŞLEMİ ADET 1,000 1,000 4,00 TL 0,0 4,00',
      `2 ${GLASS_PDF}`, '1500 1000 2 1,500 3,000 60,00 TL 0,0 180,00 POZ-A'],
    total: '3 5,000 304,00', sub: '304,00', vat: '60,80', grand: '364,80',
  }));
  const pdf2 = factoryPdf(form({ no: '97002', project: `MUSTERIX ${code} ${no}`, rows: [`1 ${GLASS_PDF} 700 800 1 0,560 0,560 60,00 TL 0,0 33,60 POZ-B`], total: '1 0,560 33,60', sub: '33,67', grand: '40,40' }));
  const wrong = factoryPdf(form({ no: '97003', project: `MUSTERIX ${code} ${Number(no) + 900}`, rows: [`1 ${GLASS_PDF} 700 800 1 0,560 0,560 60,00 TL 0,0 33,60 POZ-C`], total: '1 0,560 33,60', sub: '33,60', grand: '40,32' }));

  // Satış: teklif tablosu → "PDF'den Aktar"
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(orderUrl);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.getByLabel('Açıklama').first()).toHaveValue(GLASS_LABEL);
  await sales.getByRole('button', { name: "PDF'den Aktar" }).click();
  const dlg = sales.locator('dialog.pdf-import[open]');
  await expect(dlg).toBeVisible();
  await sales.setInputFiles('#pdf-files', [file('fabrika-1.pdf', pdf1), file('fabrika-2.pdf', pdf2), file('fabrika-yanlis.pdf', wrong)]);
  await dlg.getByRole('button', { name: 'Yükle ve ön izle' }).click();
  await expect(dlg.locator('[data-pdf-file]')).toHaveCount(3, { timeout: 60_000 });
  await expect(dlg.locator('[data-pdf-file="97001"] [data-factory-no]')).toHaveText('97001');
  await expect(dlg.locator('[data-pdf-file="97001"] [data-project]')).toHaveText(`${code} ${no}`);
  await expect(dlg.locator('[data-pdf-file="97001"] [data-check="a"]')).toContainText('tutuyor');
  await expect(dlg.locator('[data-pdf-file="97001"] [data-check="b"]')).toHaveAttribute('data-diff', '0');
  await expect(dlg.locator('[data-pdf-file="97001"] [data-check="vat"]')).toContainText('kullanılmaz');
  await expect(dlg.locator('[data-pdf-file="97003"] [data-pdf-blocking] [data-code="WRONG_PROJECT"]')).toBeVisible();
  // Ara Toplam (33,67) satır toplamından (33,60) 0,07 farklı: yalnız uyarı (karar 266) — engel yok, Ara Toplam aynen
  await expect(dlg.locator('[data-pdf-file="97002"] [data-check="a"]')).toContainText('Ara Toplam aynen saklanır');
  await expect(dlg.locator('[data-pdf-file="97002"] [data-code="SUBTOTAL_DIFFERENCE"]')).toBeVisible();
  await expect(dlg.locator('[data-pdf-file="97002"] [data-pdf-blocking]')).toHaveCount(0);
  // Satış firma adını göremez: PDF'teki "Proje / Müşterisi" metni (müşteri adı) ön izlemeye gelmez
  await expect(dlg).not.toContainText('MUSTERIX');
  await expect(dlg.getByRole('button', { name: 'Teklif tablosuna aktar' })).toBeDisabled();
  // Yanlış projenin PDF'i aktarımın dışında bırakılınca onay açılır
  await dlg.locator('[data-pdf-file="97003"]').getByLabel('Bu PDF’i aktar').uncheck();
  await expect(dlg.locator('[data-pdf-file]')).toHaveCount(2);
  await expect(dlg.getByRole('button', { name: 'Teklif tablosuna aktar' })).toBeEnabled();
  await dlg.getByRole('button', { name: 'Teklif tablosuna aktar' }).click();
  await expect(sales).toHaveURL(/ok=pdf_imported/, { timeout: 45_000 });

  // Teklif tablosu: ilk ölçüsüz satır kaldırıldı (ön izlemede işaretliydi); satırlar sırayla; Poz PDF'ten; alış fiyatı satış fiyatında
  const poz = sales.getByLabel('Poz', { exact: true });
  await expect(poz).toHaveCount(4); // 3 cam satırı (1000×2000, 1500×1000 ×2 — işlemsiz, tek satır —, 700×800) + 1 CNC satırı
  await expect(sales.getByLabel('En', { exact: true })).toHaveCount(3);
  expect(await sales.getByLabel('En', { exact: true }).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(['1000', '1500', '700']);
  expect(await sales.getByLabel('Adet', { exact: true }).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(['1', '2', '1']);
  expect(await sales.getByLabel('CNC fiyatı').inputValue()).toBe('4.00');
  expect(await sales.getByLabel('Birim fiyat', { exact: true }).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(['60.00', '60.00', '60.00']);
  const pozValues = await poz.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(pozValues.filter(Boolean)).toEqual(['POZ-A', 'POZ-A', 'POZ-B']); // her satır kendi PDF satırının Poz değeri (3.79.1)
  // Teklif hâlâ satışta (yöneticiye kendiliğinden gitmedi)
  await expect(sales.locator('#teklif h2 .badge')).toHaveText('satışta hazırlanıyor');

  // Mükerrer: aynı PDF yeniden yüklenince ön izleme engeller; kaydedilmemiş değişiklik varken aktarma kapalı
  await sales.getByLabel('Adet', { exact: true }).nth(1).fill('3');
  await sales.getByRole('button', { name: "PDF'den Aktar" }).click();
  await expect(dlg.locator('[data-pdf-dirty]')).toBeVisible();
  await sales.setInputFiles('#pdf-files', [file('fabrika-1-tekrar.pdf', pdf1)]);
  await dlg.getByRole('button', { name: 'Yükle ve ön izle' }).click();
  await expect(dlg.locator('[data-pdf-file="97001"] [data-code="ALREADY_IMPORTED"]')).toBeVisible({ timeout: 60_000 });
  await expect(dlg.getByRole('button', { name: 'Teklif tablosuna aktar' })).toBeDisabled();
  // Özgün PDF saklanmaz (3.75.3): önceki PDF'ler yalnızca adlarıyla listelenir, indirme bağlantısı yok
  await expect(dlg.locator('[data-previous-pdf]').first()).toHaveText('fabrika-1.pdf');
  await expect(dlg.locator('a[href^="/dosya/fabrika/"]')).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Kapat' }).click();
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const rows = await db.offerImport.findMany({ where: { order: { orderNo } }, select: { id: true, storageKey: true, parsed: true, factoryOrderNo: true } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.storageKey === null && r.parsed !== null)).toBe(true);
    // Eski bir indirme adresi bile hiçbir role dosya vermez
    for (const p of [sales, cust]) expect((await p.request.get(`/dosya/fabrika/${rows[0].id}?ac=1`)).status()).toBe(404);
  } finally {
    await db.$disconnect();
  }
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  const drawer = await as(browser, DRAWER, TEAM_PW);
  // Müşterinin ve denetimcinin sipariş sayfası fabrika PDF'ini / aktarım kaydını göstermez
  for (const p of [cust, insp]) {
    await p.goto(orderUrl);
    const html = await p.content();
    expect(html).not.toContain('/dosya/fabrika/');
    expect(html).not.toContain('97001');
  }

  // Satış satırı düzenleyip kaydeder ve teklifi ELLE yöneticiye gönderir (mevcut düğme)
  await sales.getByRole('button', { name: 'Taslak olarak kaydet' }).click();
  await expect(sales).toHaveURL(/ok=offer_saved/);
  // Kayıt aktarılan satırları korur (düzenleyici kayıtlı satırlarla yeniden kurulur); değişen adet yazıldı
  await expect(sales.getByLabel('Poz', { exact: true })).toHaveCount(4);
  expect(await sales.getByLabel('Adet', { exact: true }).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(['1', '3', '1']);
  // Satışın teklif tablosu indirmesi (karar 267): PDF + Excel, satışın KENDİ fiyatıyla; müşteri fiyatı yok; m² 3 ondalık
  await expect(sales.locator('[data-offer-export="pdf"]')).toBeVisible();
  await expect(sales.locator('[data-offer-export="xlsx"]')).toBeVisible();
  const xr = await sales.request.get(`${orderUrl}/teklif?format=xlsx`);
  expect(xr.status()).toBe(200);
  const xrows = readXlsx(Buffer.from(await xr.body())).rows;
  expect(xrows.some((r) => r.length === 9)).toBe(true);
  const xglass = xrows.filter((r) => /^\d+$/.test(String(r[0] ?? '')) && r[3] != null);
  expect(xglass.map((r) => [String(r[2]), Number(r[3]), Number(r[5]), Number(r[6]), Number(r[7]), Number(r[8])])).toEqual([
    ['POZ-A', 1000, 1, 2, 60, 120], ['POZ-A', 1500, 3, 4.5, 60, 270], ['POZ-B', 700, 1, 0.56, 60, 33.6],
  ]);
  const xtotal = xrows.find((r) => r[0] === 'Toplam')!;
  expect([Number(xtotal[6]), Number(xtotal[8])]).toEqual([7.06, 427.6]);
  // Firma adı satışa maskeli gelir: tam firma adı ve PDF'teki müşteri adı dosyada yok
  const cells = xrows.flat().filter((v) => v != null && v !== '').map(String);
  expect(cells.some((v) => /Ünsal|MUSTERIX/.test(v))).toBe(false);
  const pr = await sales.request.get(`${orderUrl}/teklif?format=pdf`);
  expect(pr.status()).toBe(200);
  expect(pr.headers()['content-type']).toContain('application/pdf');
  expect((await drawer.request.get(`${orderUrl}/teklif?format=xlsx`)).status()).not.toBe(200);
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales).toHaveURL(/ok=offer_submit/);
  // Teklif yöneticideyken de satış kendi tablosunu (kendi fiyatıyla) indirebilir
  await expect(sales.locator('#teklif a[href$="format=xlsx"]')).toBeVisible();
  expect((await sales.request.get(`${orderUrl}/teklif?format=xlsx`)).status()).toBe(200);
  for (const p of [cust, insp, drawer, sales]) await p.context().close();
});
