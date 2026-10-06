import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CUSTOMER, CUST_PW, SALES, TEAM_PW, as } from './helpers';
import { readXls } from '../server/files/xls.js';
import { writeXlsx } from '../server/files/xlsx.js';
import { writeZip } from '../server/files/zip.js';

// Teklif tablosuna Excel'den aktarma (AUD-3, karar 140): olağan .xls / .xlsx dosyaları eskisi gibi okunur, sütun eşlemesi
// çalışır; 5 MB'tan büyük Excel dosyası siparişe YÜKLENEBİLİR (sipariş dosyası sınırı 100 MB) ama teklife aktarılırken
// okunmadan, açık bir mesajla reddedilir. (07–08 testlerinin yüklediği katalog ve fiyat tablosuyla çalışır.)
test('Excel\'den aktar: .xls ve .xlsx okunur, genişlik / yükseklik / adet eşlenir; 5 MB\'tan büyük dosya açık mesajla reddedilir', async ({ browser }) => {
  test.setTimeout(120_000);
  const xls = fs.readFileSync(path.join('test', 'fixtures', 'olculer.xls'));
  const rows = readXls(xls).rows.map((r) => r.map((v) => (v == null ? '' : (v as string | number))));
  const xlsx = writeXlsx({ sheetName: 'Ölçüler', rows: rows as (string | number)[][] });
  // Geçerli bir .xlsx ama 5 MB'tan büyük: sıkışmayan (rastgele) bir ek parça taşır
  const big = writeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>' },
    { name: 'xl/media/buyuk.bin', data: crypto.randomBytes(5.5 * 1024 * 1024) },
  ]);
  expect(big.length).toBeGreaterThan(5 * 1024 * 1024);
  const file = (name: string, buffer: Buffer) => ({ name, mimeType: 'application/octet-stream', buffer });

  // Müşteri: üç Excel dosyasıyla sipariş (büyük dosya da olağan yükleme yolundan geçer)
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await cust.fill('#title', 'Excel aktarma');
  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: '10 MM TEMPER CAM — BRONZ' });
  await cust.setInputFiles('#files', [file('olculer.xls', xls), file('olculer.xlsx', xlsx), file('buyuk.xlsx', big)]);
  await expect(cust.locator('#secilen-dosyalar .file-row')).toHaveCount(3);
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/, { timeout: 45_000 });
  const orderUrl = new URL(cust.url()).pathname;
  await cust.context().close();

  // Satış: teklif tablosu → "Excel'den Aktar"
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(orderUrl);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.getByLabel('Açıklama').first()).toHaveValue('10 MM TEMPER CAM — BRONZ');
  await sales.getByRole('button', { name: "Excel'den Aktar" }).click();
  const dlg = sales.locator('dialog.modal[open]');
  await expect(dlg).toBeVisible();
  // Pencere açılınca ilk dosya kendiliğinden okunur: sonuç (ön izleme ya da hata) gelene kadar beklenir
  await expect(dlg.locator('.import-preview, .alert-error').first()).toBeVisible();
  const pick = (name: string) => dlg.locator('#xl-file').selectOption({ label: name });

  // 5 MB'tan büyük dosya: okunmaz; teknik olmayan, açık mesaj (genel "okunamadı" değil)
  await pick('buyuk.xlsx');
  await expect(dlg.locator('.alert-error')).toContainText('Excel dosyası çok büyük (en fazla 5 MB).');
  await expect(dlg.locator('.import-preview')).toHaveCount(0);
  await expect(dlg.getByRole('button', { name: 'Teklif Tablosuna Aktar' })).toBeDisabled();

  // Olağan .xls ve .xlsx: aynı satırlar, aynı eşleme sonucu
  for (const name of ['olculer.xls', 'olculer.xlsx']) {
    await pick(name);
    // Yeni dosya okununca sütun seçimi sıfırlanır (önceki dosyanın seçimi kalmaz)
    await expect(dlg.locator('#xl-width')).toHaveValue('-1');
    await expect(dlg.locator('.alert-error')).toHaveCount(0);
    const preview = dlg.locator('.import-preview');
    await expect(preview.locator('tbody tr').first()).toContainText('Lățime');
    await expect(preview.locator('tbody tr').nth(1)).toContainText('K1');
    await expect(preview.locator('tbody tr').nth(1)).toContainText('Şeffaf');
    await dlg.locator('#xl-width').selectOption('1');
    await dlg.locator('#xl-height').selectOption('2');
    await dlg.locator('#xl-qty').selectOption('3');
    await expect(dlg.getByText('2 geçerli satır')).toBeVisible();
    await expect(dlg.getByText('2 geçersiz satır (aktarılmaz)')).toBeVisible();
  }

  // Aktarılan satırlar teklif tablosunun sonuna eklenir: 1000 × 2000 × 2 ve 851 × 1950 × 1
  await dlg.getByRole('button', { name: 'Teklif Tablosuna Aktar' }).click();
  await expect(sales.locator('dialog.modal[open]')).toHaveCount(0);
  const table = sales.locator('#teklif .offer-table');
  const last2 = async (label: string) => (await table.getByLabel(label, { exact: true }).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).slice(-2);
  await expect.poll(() => last2('En')).toEqual(['1000', '851']);
  expect(await last2('Boy')).toEqual(['2000', '1950']);
  expect(await last2('Adet')).toEqual(['2', '1']);
  await sales.context().close();
});
