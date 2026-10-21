import { test, expect, type Page } from '@playwright/test';
import zlib from 'node:zlib';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, GLASS, TEAM_PW, as, reportSheet } from './helpers';
import { FONTS } from '../server/pdf/fonts.js';
import { writeXlsx } from '../server/files/xlsx.js';

// Bağımsız yönetici ticari teklifi (3.83.0, karar 277):
//  - menü: "Teklif Oluştur" ve "Teklifler" Çizim Ekibi ile Muhasebe arasında
//  - cam (ölçü → otomatik m², €/m²) + profil (yalnızca metre → miktarlar mevcut profil hesaplayıcısından) tek teklifte
//  - canlı ara toplam, iç maliyet / kâr / marj (yalnızca yönetici ekranı ve iç Excel); müşteri PDF'i Romence, maliyetsiz
//  - kesinleştir → sürüm değişmez; kabul yalnızca kayıt: sipariş / teklif / FGO / stok / bildirim YAZILMAZ
//  - satış ve müşteri: sayfa, PDF / Excel ve sunucu işlemi kapalı
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)

let offerUrl = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const REVERSE = Object.fromEntries((['Regular', 'Bold'] as const).map((k) => [k, new Map((FONTS[k].map as [number, number][]).map(([cp, gid]) => [gid, cp]))]));
/** PDF içerik akışlarındaki metinler (birim testindeki okuyucu) */
function pdfText(pdf: Buffer): string {
  const out: string[] = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  const s = pdf.toString('latin1');
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length;
    let ops: string;
    try { ops = zlib.inflateSync(pdf.subarray(start, start + Number(m[1]))).toString('latin1'); } catch { continue; }
    for (const t of ops.matchAll(/\/(F1|F2) [\d.]+ Tf [\d.-]+ [\d.-]+ Td <([0-9a-f]*)> Tj/g)) {
      const map = REVERSE[t[1] === 'F2' ? 'Bold' : 'Regular'];
      out.push((t[2].match(/.{4}/g) ?? []).map((h) => String.fromCodePoint(map.get(parseInt(h, 16)) ?? 63)).join(''));
    }
  }
  return out.join('\n');
}
const OTHER = ['order', 'offer', 'offerLine', 'price', 'notificationOutbox', 'notification', 'stockMovement', 'fgoDocument', 'billingBatch', 'profileOrder'] as const;
async function others() {
  const db = await prisma();
  try {
    return Object.fromEntries(await Promise.all(OTHER.map(async (m) => [m, await (db as unknown as Record<string, { count: () => Promise<number> }>)[m].count()])));
  } finally {
    await db.$disconnect();
  }
}
async function pickOption(page: Page, select: string, text: string) {
  const value = await page.locator(`${select} option`, { hasText: text }).first().getAttribute('value');
  await page.locator(select).selectOption(value!);
}

test('yönetici: menüde Ticari Teklif bölümü (Çizim Ekibi ile Muhasebe arasında); teklif oluştur — cam + profil hesaplayıcısı, canlı toplam, maliyet / kâr', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const side = admin.locator('.sidebar');
  const texts = await side.locator('a, .nav-section').allInnerTexts();
  const at = (s: string) => texts.findIndex((x) => x.trim().startsWith(s));
  expect(at('Teklif Oluştur')).toBeGreaterThan(at('Çizim Paneli'));
  expect(at('Teklif Oluştur')).toBeLessThan(at('Profil Tahsilat'));
  await expect(side.getByRole('link', { name: 'Teklif Oluştur' })).toHaveAttribute('href', '/admin/ticari-teklifler/yeni');
  await expect(side.getByRole('link', { name: 'Teklifler', exact: true }).last()).toHaveAttribute('href', '/admin/ticari-teklifler');

  const before = await others();
  await side.getByRole('link', { name: 'Teklif Oluştur' }).click();
  await expect(admin.getByRole('heading', { name: 'Teklif oluştur', level: 1 })).toBeVisible();
  await admin.fill('#co-firm', 'E2E Trademark Glass');
  // Cam: 1000 × 970 × 280 → 271,600 m²; 63,10 €/m² → 17.137,96 €
  await admin.getByRole('button', { name: '+ Cam ekle' }).click();
  const g = admin.locator('[data-glass-line="1"]');
  const gv = await g.locator('select option', { hasText: '66.3 Temper Lamine Cam' }).first().getAttribute('value');
  await g.locator('select').selectOption(gv!);
  await g.getByLabel('En (mm) 1').fill('1000');
  await g.getByLabel('Boy (mm) 1').fill('970');
  await g.getByLabel('Adet 1').fill('280');
  await g.getByLabel('Satış €/m² 1').fill('63,10');
  await g.getByLabel('Maliyet €/m² 1').fill('50');
  await expect(g.locator('[data-m2]')).toHaveText('271,600');
  await expect(g.locator('[data-amount]')).toHaveText('17.137,96 €');
  await admin.fill('#co-extra', '1700');
  // Profil: yalnızca metre — miktarlar profil hesaplayıcısından
  await pickOption(admin, '#cc-profile', 'FBL115');
  await admin.locator('#cc-color').selectOption('RAL7016');
  await pickOption(admin, '#cc-thickness', '8+8');
  await admin.fill('#cc-meters', '300');
  await admin.locator('[data-calc-run]').click();
  await expect(admin.getByRole('status').filter({ hasText: 'ürün eklendi' })).toBeVisible();
  const fbl = admin.locator('tr[data-code="FBL115-7016"]');
  await expect(fbl.locator('[data-meters]')).toHaveValue('300');
  await expect(fbl.locator('[data-bill]')).toContainText('300 ML');
  await expect(fbl.locator('[data-bill]')).toContainText('50');
  await fbl.getByLabel(/Satış € \/ birim/).fill('28,15');
  await fbl.getByLabel(/Maliyet € \/ birim/).fill('22,12');
  await expect(fbl.locator('[data-amount]')).toHaveText('8.445,00 €');
  // Hesaplayıcının diğer ürünleri (poşetler): fiyat zorunlu
  const rows = admin.locator('[data-section="profile"] tbody tr[data-profile-line]');
  const n = await rows.count();
  expect(n).toBeGreaterThan(1);
  for (let i = 0; i < n; i++) {
    const price = rows.nth(i).getByLabel(/Satış € \/ birim/);
    if (!(await price.inputValue())) await price.fill('1');
  }
  await expect(admin.locator('[data-total="glass"]')).toHaveText('17.137,96 €');
  await expect(admin.locator('[data-total="cost"]')).not.toHaveText('—');
  await expect(admin.locator('[data-total="margin"]')).toContainText('%');
  await admin.locator('[data-save]').click();
  await expect(admin).toHaveURL(/\/admin\/ticari-teklifler\/[a-z0-9]+\?ok=created/);
  await expect(admin.getByText('Teklif oluşturuldu.')).toBeVisible();
  offerUrl = new URL(admin.url()).pathname;
  await expect(admin.getByText('Taslak', { exact: true }).first()).toBeVisible();
  // Kayıttan sonra aynı hesap (sunucu yeniden doğruladı)
  await expect(admin.locator('[data-total="glass"]')).toHaveText('17.137,96 €');
  expect(await others()).toEqual(before);
  await admin.context().close();
});

test('müşteri PDF: Romence, maliyet / kâr yok, taslak damgası; iç Excel: maliyet ve kâr var', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const pdf = await admin.request.get(`${offerUrl}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect(pdf.headers()['content-disposition']).toMatch(/Ticari-Teklif-\d{4}\.pdf/);
  const text = pdfText(Buffer.from(await pdf.body()));
  for (const s of ['OFERTA', 'E2E Trademark Glass', '1000  x  970', '271.600', '63.10 €', '17,137.96 €', 'FBL115-7016', '8,445.00 €', 'TOTAL FĂRĂ TVA', 'CIORNĂ']) expect(text).toContain(s);
  for (const s of ['22.12', '13,580', '1,700', 'Maliyet', 'Cost', 'Profit']) expect(text).not.toContain(s);
  const xlsx = await admin.request.get(`${offerUrl}/excel`);
  expect(xlsx.status()).toBe(200);
  const flat = (await reportSheet(Buffer.from(await xlsx.body()), 1)).flat();
  for (const v of [17137.96, 13580, 1700, 8445]) expect(flat).toContain(v);
  await admin.context().close();
});

test('kesinleştir → sürüm değişmez; kabul yalnızca kayıt (sipariş açılmaz); yeni sürüm reddedilir', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const before = await others();
  await admin.goto(offerUrl);
  await admin.getByRole('button', { name: 'Kesinleştir (Hazır)' }).click();
  await expect(admin.getByText('Sürüm kesinleştirildi.')).toBeVisible();
  await expect(admin.getByText('Hazır', { exact: true }).first()).toBeVisible();
  await expect(admin.locator('[data-save]')).toHaveCount(0);
  await expect(admin.locator('#co-firm')).toBeDisabled();
  const pdf = pdfText(Buffer.from(await (await admin.request.get(`${offerUrl}/pdf`)).body()));
  expect(pdf).not.toContain('CIORNĂ');
  await admin.getByRole('button', { name: 'Kabul edildi olarak işaretle' }).click();
  await expect(admin.getByText('Durum kaydedildi.')).toBeVisible();
  await expect(admin.getByText('Kabul edildi', { exact: true }).first()).toBeVisible();
  await expect(admin.locator('[data-history="COMMERCIAL_OFFER_STATUS"]')).toBeVisible();
  expect(await others()).toEqual(before);
  // Liste: numara, durum, maliyet ve marj (yalnızca yönetici)
  await admin.goto('/admin/ticari-teklifler');
  const row = admin.locator('tr[data-commercial-offer]').first();
  await expect(row).toContainText('E2E Trademark Glass');
  await expect(row.locator('[data-cost]')).not.toHaveText('—');
  await admin.context().close();
});

test('4.0.0: cam bölümünde CNC / delik (adet camdan bağımsız) ve sandık parası — canlı toplam, kayıt, yeniden açma, PDF ve iç Excel', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const before = await others();
  await admin.goto('/admin/ticari-teklifler/yeni');
  await admin.fill('#co-firm', 'E2E İşlemli Cam');
  await admin.getByRole('button', { name: '+ Cam ekle' }).click();
  const g = admin.locator('[data-glass-line="1"]');
  const gv = await g.locator('select option', { hasText: '66.3 Temper Lamine Cam' }).first().getAttribute('value');
  await g.locator('select').selectOption(gv!);
  await g.getByLabel('En (mm) 1').fill('1000');
  await g.getByLabel('Boy (mm) 1').fill('970');
  await g.getByLabel('Adet 1').fill('66');
  await g.getByLabel('Satış €/m² 1').fill('63,10');
  await g.getByLabel('Maliyet €/m² 1').fill('50');
  // 66 cam altında 80 CNC ve 100 delik: kısıt yok, cam bölünmez
  await g.locator('[data-add-op="CNC"]').click();
  await g.locator('[data-add-op="DELIK"]').click();
  const cnc = admin.locator('tr[data-op-line="CNC"][data-parent="1"]');
  const hole = admin.locator('tr[data-op-line="DELIK"][data-parent="1"]');
  await cnc.getByLabel('CNC Adet 1').fill('80');
  await cnc.getByLabel('CNC € / adet 1').fill('5,25');
  await cnc.getByLabel('CNC Maliyet € / birim 1').fill('3');
  await hole.getByLabel('Delik Adet 1').fill('100');
  await hole.getByLabel('Delik € / adet 1').fill('1,5');
  await hole.getByLabel('Delik Maliyet € / birim 1').fill('1');
  await expect(cnc.locator('[data-amount]')).toHaveText('420,00 €');
  await expect(hole.locator('[data-amount]')).toHaveText('150,00 €');
  // Sandık parası: yalnızca düğmeyle; ayrı, numaralı kalem; maliyet 0 € (sabit)
  await expect(admin.locator('[data-crate-line]')).toHaveCount(0);
  await admin.locator('[data-add-crate]').click();
  const crate = admin.locator('tr[data-crate-line][data-glass-line="2"]');
  await crate.getByLabel('Sandık parası Adet 2').fill('2');
  await crate.getByLabel('Sandık parası € / adet 2').fill('45');
  await expect(crate.locator('[data-amount]')).toHaveText('90,00 €');
  await expect(crate.locator('[data-crate-cost]')).toBeVisible();
  // Cam adedi ve m² değişmez: 66 × 0,970 = 64,020 m² → 4.039,66 €; cam bölümü + 660 €
  await expect(g.locator('[data-m2]')).toHaveText('64,020');
  await expect(g.locator('[data-amount]')).toHaveText('4.039,66 €');
  await expect(admin.locator('[data-total="glassM2"]')).toHaveText('64,020');
  await expect(admin.locator('[data-total="glass"]')).toHaveText('4.699,66 €');
  await expect(admin.locator('[data-total="ops"]')).toHaveText('570,00 €');
  await expect(admin.locator('[data-total="crate"]')).toHaveText('90,00 €');
  await expect(admin.locator('[data-total="counts"]')).toHaveText('66 cam · 80 CNC · 100 delik · 2 sandık');
  // Maliyet: 64,02 × 50 = 3.201,00 + 240 + 100 + sandık 0
  await expect(admin.locator('[data-total="cost"]')).toHaveText('3.541,00 €');
  await admin.locator('[data-save]').click();
  await expect(admin).toHaveURL(/\/admin\/ticari-teklifler\/[a-z0-9]+\?ok=created/);
  const url = new URL(admin.url()).pathname;
  // Yeniden açma: satırlar ve toplamlar aynı
  await admin.goto(url);
  await expect(admin.locator('tr[data-op-line="CNC"] input').nth(1)).toHaveValue('80');
  await expect(admin.locator('tr[data-op-line="DELIK"] input').nth(1)).toHaveValue('100');
  await expect(admin.locator('[data-crate-line] [data-amount]')).toHaveText('90,00 €');
  await expect(admin.locator('[data-total="glass"]')).toHaveText('4.699,66 €');
  await expect(admin.locator('[data-unsaved]')).toHaveCount(0);
  // Müşteri PDF: işlemler camın altında, sandık ayrı kalem; maliyet yok
  const text = pdfText(Buffer.from(await (await admin.request.get(`${url}/pdf`)).body()));
  for (const s of ['CNC', 'Găuri', 'Ambalaj (ladă)', 'BUC', '420.00 €', '150.00 €', '90.00 €', '64.020', '4,699.66 €']) expect(text).toContain(s);
  for (const s of ['3,541', '240.00', 'Cost', 'Profit']) expect(text).not.toContain(s);
  // İç Excel: işlem ve sandık satırları, maliyet ve kâr
  const flat = (await reportSheet(Buffer.from(await (await admin.request.get(`${url}/excel`)).body()), 1)).flat();
  for (const v of [420, 150, 90, 240, 180, 'Delik', 'Sandık parası', 570]) expect(flat).toContain(v);
  expect(await others()).toEqual(before);
  await admin.context().close();
});

test('4.1.0: cam bölümüne Excel\'den aktarma — sütun eşleştirme, cam eşleştirme / varsayılan / elle seçim, mevcut CNC ve sandık korunur, satış fiyatı boş, tekrar uyarısı, kayıt ve çıktılar', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const before = await others();
  await admin.goto('/admin/ticari-teklifler/yeni');
  await admin.fill('#co-firm', 'E2E Excel Aktarım');
  // Mevcut satırlar: 1 cam (+ CNC) ve sandık parası — aktarımda aynen kalmalı
  await admin.getByRole('button', { name: '+ Cam ekle' }).click();
  const g = admin.locator('[data-glass-line="1"]');
  const gv = await g.locator('select option', { hasText: '66.3 Temper Lamine Cam' }).first().getAttribute('value');
  await g.locator('select').selectOption(gv!);
  await g.getByLabel('En (mm) 1').fill('1000');
  await g.getByLabel('Boy (mm) 1').fill('970');
  await g.getByLabel('Adet 1').fill('2');
  // m² fiyattan bağımsız: fiyat girilmeden görünür, ölçü / adet değişince anında yeniden hesaplanır (en × boy × adet / 10⁶)
  await expect(g.getByLabel('Satış €/m² 1')).toHaveValue('');
  await expect(g.locator('[data-m2]')).toHaveText('1,940');
  await g.getByLabel('Adet 1').fill('3');
  await expect(g.locator('[data-m2]')).toHaveText('2,910');
  await g.getByLabel('Boy (mm) 1').fill('1001');
  await expect(g.locator('[data-m2]')).toHaveText('3,003');
  await g.getByLabel('Boy (mm) 1').fill('970');
  await g.getByLabel('Adet 1').fill('2');
  await expect(g.locator('[data-m2]')).toHaveText('1,940');
  await g.getByLabel('Satış €/m² 1').fill('60');
  await expect(g.locator('[data-m2]')).toHaveText('1,940');
  await g.locator('[data-add-op="CNC"]').click();
  const cnc = admin.locator('tr[data-op-line="CNC"][data-parent="1"]');
  await cnc.getByLabel('CNC Adet 1').fill('5');
  await cnc.getByLabel('CNC € / adet 1').fill('4');
  await admin.locator('[data-add-crate]').click();
  await admin.locator('tr[data-crate-line]').getByLabel('Sandık parası € / adet 2').fill('45');

  // Hatalı dosyalar: desteklenmeyen tür ve 1,5 MB üstü — anlaşılır hata, satır eklenmez
  await admin.locator('[data-excel-import]').click();
  const dialog = admin.locator('[data-excel-dialog]');
  await dialog.locator('[data-excel-file]').setInputFiles({ name: 'olculer.csv', mimeType: 'text/csv', buffer: Buffer.from('En;Boy\n1;2') });
  await expect(dialog.locator('[data-excel-error]')).toContainText('.xls ve .xlsx');
  await dialog.locator('[data-excel-file]').setInputFiles({ name: 'buyuk.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.alloc(Math.ceil(1.6 * 1024 * 1024), 1) });
  await expect(dialog.locator('[data-excel-error]')).toContainText('1,5 MB');
  await dialog.locator('[data-excel-file]').setInputFiles({ name: 'bozuk.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK\u0003\u0004bozuk') });
  await expect(dialog.locator('[data-excel-error]')).toContainText('okunamadı');

  // Gerçek .xlsx: Türkçe büyük harfle yazılmış cam (eşleşir), boş cam (varsayılan), bilinmeyen cam (elle), geçersiz ölçü
  const xlsx = writeXlsx({ sheetName: 'Ölçüler', rows: [
    ['Cam tipi', 'En', 'Boy', 'Adet'],
    [GLASS.toLocaleUpperCase('tr-TR'), 1000, 970, 2],
    ['', '1.200', '850,5', 1],
    ['Bilinmeyen cam', 500, 500, 1],
    ['', 0, 500, 1],
  ] });
  const file = { name: 'olculer.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx };
  await dialog.locator('[data-excel-file]').setInputFiles(file);
  await expect(dialog.locator('#cx-width')).toBeVisible();
  await dialog.locator('#cx-glass').selectOption('0');
  await dialog.locator('#cx-width').selectOption('1');
  await dialog.locator('#cx-height').selectOption('2');
  await dialog.locator('#cx-qty').selectOption('3');
  // Başlık satırı önerisi: ilk satır (ölçü sütunları metin) — 4.2.0'dan beri seçilebilir satır
  await expect(dialog.locator('#cx-header')).toHaveValue('0');
  await expect(dialog.locator('[data-excel-row="1"]')).toHaveAttribute('data-excel-state', 'header');
  await expect(dialog.locator('[data-stat="ready"]')).toHaveText('1 satır aktarılacak');
  await expect(dialog.locator('[data-stat="invalid"]')).toHaveText('1 geçersiz satır');
  await expect(dialog.locator('[data-stat="needsGlass"]')).toHaveText('2 satırda cam tipi belirlenmedi');
  await expect(dialog.locator('[data-excel-row="2"]')).toHaveAttribute('data-glass-status', 'MATCH');
  await expect(dialog.locator('[data-excel-row="3"]')).toHaveAttribute('data-glass-status', 'MISSING');
  await expect(dialog.locator('[data-excel-row="4"]')).toHaveAttribute('data-glass-status', 'NONE');
  await expect(dialog.locator('[data-excel-row="5"]')).toContainText('en geçersiz');
  // Varsayılan yalnızca boş hücreye uygulanır; bilinmeyen cam varsayılana geçmez → elle seçilir
  await dialog.locator('#cx-default').selectOption(gv!);
  await expect(dialog.locator('[data-excel-row="3"]')).toHaveAttribute('data-glass-status', 'DEFAULT');
  await expect(dialog.locator('[data-excel-row="4"]')).toHaveAttribute('data-glass-status', 'NONE');
  await dialog.locator('[data-excel-pick="4"]').selectOption(gv!);
  await expect(dialog.locator('[data-stat="ready"]')).toHaveText('3 satır aktarılacak');
  // Satır 2, tablodaki 1. satırla aynı (cam, ölçü, adet) → uyarı + onay olmadan aktarılmaz
  await expect(dialog.locator('[data-excel-duplicate]')).toBeVisible();
  await expect(dialog.locator('[data-excel-apply]')).toBeDisabled();
  await dialog.locator('[data-excel-confirm]').check();
  await dialog.locator('[data-excel-apply]').click();
  // 4.2.0: önce özet; düzenleyiciye yalnızca onayla eklenir
  await expect(dialog.locator('[data-excel-summary]')).toContainText('3 satır teklif tablosuna eklenecek');
  await expect(admin.locator('[data-glass-line]')).toHaveCount(2);
  await dialog.locator('[data-excel-commit]').click();
  await expect(admin.locator('[data-excel-applied]')).toContainText('3 satır eklendi');

  // Sona eklendi; mevcut cam, CNC ve sandık aynen; satış fiyatı boş
  await expect(admin.locator('[data-glass-line]')).toHaveCount(5);
  await expect(admin.locator('tr[data-crate-line][data-glass-line="2"]')).toHaveCount(1);
  await expect(admin.locator('tr[data-op-line="CNC"][data-parent="1"]')).toHaveCount(1);
  for (const n of [3, 4, 5]) {
    const row = admin.locator(`[data-glass-line="${n}"]`);
    await expect(row.getByLabel(`Satış €/m² ${n}`)).toHaveValue('');
    await expect(row.locator('select').first()).toHaveValue(gv!);
  }
  await expect(admin.locator('[data-glass-line="4"]').getByLabel('En (mm) 4')).toHaveValue('1200');
  await expect(admin.locator('[data-glass-line="4"]').getByLabel('Boy (mm) 4')).toHaveValue('851');
  // Aktarılan satırın m²'si satış fiyatı boşken de görünür (1200 × 851 = 1,021 m²; 500 × 500 = 0,250 m²)
  await expect(admin.locator('[data-glass-line="4"] [data-m2]')).toHaveText('1,021');
  await expect(admin.locator('[data-glass-line="5"] [data-m2]')).toHaveText('0,250');

  // Aynı dosya tekrar: uyarı; vazgeçilir
  await admin.locator('[data-excel-import]').click();
  await dialog.locator('[data-excel-file]').setInputFiles(file);
  await dialog.locator('#cx-width').selectOption('1');
  await dialog.locator('#cx-height').selectOption('2');
  await dialog.locator('#cx-qty').selectOption('3');
  await expect(dialog.locator('[data-excel-duplicate]')).toContainText('daha önce aktarıldı');
  await expect(dialog.locator('[data-excel-apply]')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(admin.locator('[data-glass-line]')).toHaveCount(5);

  // Satış fiyatlarını yönetici girer → kaydet → yeniden aç
  for (const n of [3, 4, 5]) await admin.locator(`[data-glass-line="${n}"]`).getByLabel(`Satış €/m² ${n}`).fill('60');
  // Fiyat girildikten sonra m² aynı
  await expect(admin.locator('[data-glass-line="4"] [data-m2]')).toHaveText('1,021');
  // m²: 2 × 0,970 + 2 × 0,970 + 1,021 + 0,250 = 5,151; nakliye payı yalnızca camdan
  await expect(admin.locator('[data-total="glassM2"]')).toHaveText('5,151');
  await admin.locator('[data-save]').click();
  await expect(admin).toHaveURL(/\/admin\/ticari-teklifler\/[a-z0-9]+\?ok=created/);
  const url = new URL(admin.url()).pathname;
  await admin.goto(url);
  await expect(admin.locator('[data-glass-line]')).toHaveCount(5);
  await expect(admin.locator('[data-total="glassM2"]')).toHaveText('5,151');
  await expect(admin.locator('tr[data-op-line="CNC"]')).toHaveCount(1);
  const text = pdfText(Buffer.from(await (await admin.request.get(`${url}/pdf`)).body()));
  for (const s of ['1200  x  851', '500  x  500', 'CNC', 'Ambalaj (ladă)', '5.151']) expect(text).toContain(s);
  const flat = (await reportSheet(Buffer.from(await (await admin.request.get(`${url}/excel`)).body()), 1)).flat();
  expect(flat).toContain(1200);
  expect(await others()).toEqual(before);
  await admin.context().close();
});

test('4.2.0: Excel ön izlemesi satış ekranı düzeninde — gerçek hücreler, başlık satırı seçimi, geçerli / hatalı satırlar, onayla ekleme; yönetici yardımcısı kullanır', async ({ browser }) => {
  const DEPUTY = `ticari-yardimci-${Date.now().toString(36)}@e2e.test`;
  const DEPUTY_PW = 'Yardimci2026ticari';
  const db = await prisma();
  try {
    const { hashPassword } = await import('../server/auth/password-hash.js');
    const factory = await db.customer.findFirstOrThrow({ where: { type: 'FACTORY' } });
    await db.user.create({ data: { email: DEPUTY, name: 'Ticari Yardımcı', type: 'INTERNAL', appRole: 'YONETICI_YARDIMCISI', customerId: factory.id, passwordHash: await hashPassword(DEPUTY_PW) } });
  } finally {
    await db.$disconnect();
  }
  const before = await others();
  // Başlığın üstünde firma / proje satırları; başlık 4. satırda; bir hatalı ve bir camı bilinmeyen satır
  const xlsx = writeXlsx({ sheetName: 'Liste', rows: [
    ['ZXQ GKH ölçü listesi', '', '', ''],
    ['Proje: Villa Deniz', '', '', ''],
    ['', '', '', ''],
    ['Tip', 'Genişlik', 'Yükseklik', 'Bucăți'],
    [GLASS, 1500, 700, 2],
    ['', 900, 600, 1],
    ['Bilinmeyen cam', 800, 600, 1],
    ['', 'yok', 600, 1],
  ] });
  const file = { name: 'liste.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx };

  const page = await as(browser, DEPUTY, DEPUTY_PW);
  await page.goto('/admin/ticari-teklifler/yeni');
  await page.fill('#co-firm', 'E2E Ön İzleme');
  await page.getByRole('button', { name: '+ Cam ekle' }).click();
  const first = page.locator('[data-glass-line="1"]');
  const gv = await first.locator('select option', { hasText: '66.3 Temper Lamine Cam' }).first().getAttribute('value');
  await first.locator('select').selectOption(gv!);
  await first.getByLabel('En (mm) 1').fill('1000');
  await first.getByLabel('Boy (mm) 1').fill('1000');
  await first.getByLabel('Adet 1').fill('1');
  await first.locator('[data-add-op="DELIK"]').click();
  await page.locator('tr[data-op-line="DELIK"][data-parent="1"]').getByLabel('Delik Adet 1').fill('4');
  await page.locator('[data-add-crate]').click();

  await page.locator('[data-excel-import]').click();
  const dialog = page.locator('[data-excel-dialog]');
  await dialog.locator('[data-excel-file]').setInputFiles(file);
  // Gerçek hücreler: başlığın üstündeki satırlar dahil, eşleştirmeden önce görünür
  const preview = dialog.locator('[data-excel-preview]');
  await expect(preview.locator('[data-excel-row="1"]')).toContainText('ZXQ GKH ölçü listesi');
  await expect(preview.locator('[data-excel-row="4"]')).toContainText('Genişlik');
  await expect(preview.locator('thead')).toContainText('A');
  await expect(dialog.locator('[data-excel-hint]')).toBeVisible();
  await expect(dialog.locator('[data-excel-apply]')).toBeDisabled();
  // Sütun seçimleri; başlık satırı önerisi 4. satır (üstteki not satırları başlık sayılmaz)
  await dialog.locator('#cx-glass').selectOption('0');
  await dialog.locator('#cx-width').selectOption('1');
  await dialog.locator('#cx-height').selectOption('2');
  await dialog.locator('#cx-qty').selectOption('3');
  await expect(dialog.locator('#cx-header')).toHaveValue('3');
  await expect(dialog.locator('#cx-width option:checked')).toHaveText('B — Genişlik');
  for (const n of [1, 2]) await expect(preview.locator(`[data-excel-row="${n}"]`)).toHaveAttribute('data-excel-state', 'skipped');
  await expect(preview.locator('[data-excel-row="4"]')).toHaveAttribute('data-excel-state', 'header');
  await expect(preview.locator('[data-excel-row="5"]')).toHaveAttribute('data-excel-state', 'ok');
  await expect(preview.locator('[data-excel-row="5"]')).toContainText('1500 × 700 mm · 2 adet');
  await expect(preview.locator('[data-excel-row="7"]')).toHaveAttribute('data-excel-state', 'glass');
  await expect(preview.locator('[data-excel-row="8"]')).toHaveAttribute('data-excel-state', 'invalid');
  await expect(preview.locator('[data-excel-row="8"]')).toHaveClass(/row-invalid/);
  await expect(dialog.locator('[data-stat="ready"]')).toHaveText('1 satır aktarılacak');
  await expect(dialog.locator('[data-stat="invalid"]')).toHaveText('1 geçersiz satır');
  await expect(dialog.locator('[data-stat="needsGlass"]')).toHaveText('2 satırda cam tipi belirlenmedi');
  await expect(dialog.locator('[data-excel-invalid-list]')).toContainText('8: en geçersiz');
  // Süzgeç: yalnızca hatalı satırlar / yalnızca aktarılacaklar
  await dialog.locator('[data-excel-filter="invalid"]').check({ force: true });
  await expect(preview.locator('tbody tr')).toHaveCount(1);
  await expect(preview.locator('tbody tr')).toHaveAttribute('data-excel-row', '8');
  await dialog.locator('[data-excel-filter="ok"]').check({ force: true });
  await expect(preview.locator('tbody tr')).toHaveCount(1);
  await dialog.locator('[data-excel-filter="all"]').check({ force: true });
  for (const n of [1, 4, 5, 8]) await expect(preview.locator(`[data-excel-row="${n}"]`)).toBeVisible();
  // Başlık elle değiştirilebilir: 1. satır seçilirse 2–4 hatalı / camsız satır olur; geri alınır
  await dialog.locator('#cx-header').selectOption('0');
  await expect(preview.locator('[data-excel-row="4"]')).toHaveAttribute('data-excel-state', 'invalid');
  await dialog.locator('#cx-header').selectOption('3');
  await expect(dialog.locator('[data-stat="ready"]')).toHaveText('1 satır aktarılacak');
  // Varsayılan cam + elle seçim → 3 satır; hatalı satır eklenmez
  await dialog.locator('#cx-default').selectOption(gv!);
  await dialog.locator('[data-excel-pick="7"]').selectOption(gv!);
  await expect(dialog.locator('[data-stat="ready"]')).toHaveText('3 satır aktarılacak');
  // Onay adımı: özet + geri dönülebilir; onaylanmadan tabloya hiçbir şey eklenmez
  await dialog.locator('[data-excel-apply]').click();
  const summary = dialog.locator('[data-excel-summary]');
  await expect(summary).toContainText('3 satır teklif tablosuna eklenecek');
  await expect(summary).toContainText('1 hatalı satır eklenmeyecek');
  await expect(page.locator('[data-glass-line]')).toHaveCount(2);
  await dialog.locator('[data-excel-back]').click();
  await expect(summary).toHaveCount(0);
  await dialog.locator('[data-excel-apply]').click();
  await dialog.locator('[data-excel-commit]').click();
  await expect(page.locator('[data-excel-applied]')).toContainText('3 satır eklendi');
  // Mevcut cam, delik ve sandık aynen; eklenen satırların satış fiyatı boş, m² görünür
  await expect(page.locator('[data-glass-line]')).toHaveCount(5);
  await expect(page.locator('tr[data-op-line="DELIK"][data-parent="1"]')).toHaveCount(1);
  await expect(page.locator('tr[data-crate-line][data-glass-line="2"]')).toHaveCount(1);
  await expect(page.locator('[data-glass-line="3"]').getByLabel('En (mm) 3')).toHaveValue('1500');
  await expect(page.locator('[data-glass-line="3"] [data-m2]')).toHaveText('2,100');
  await expect(page.locator('[data-glass-line="4"] [data-m2]')).toHaveText('0,540');
  for (const n of [3, 4, 5]) await expect(page.locator(`[data-glass-line="${n}"]`).getByLabel(`Satış €/m² ${n}`)).toHaveValue('');
  for (const n of [1, 3, 4, 5]) await page.locator(`[data-glass-line="${n}"]`).getByLabel(`Satış €/m² ${n}`).fill('50');
  await page.locator('tr[data-op-line="DELIK"][data-parent="1"]').getByLabel('Delik € / adet 1').fill('3');
  await page.locator('tr[data-crate-line]').getByLabel('Sandık parası € / adet 2').fill('40');
  // m²: 1,000 + 2,100 + 0,540 + 0,480 = 4,120; cam 206,00 + delik 12,00 + sandık 40,00
  await expect(page.locator('[data-total="glassM2"]')).toHaveText('4,120');
  await page.locator('[data-save]').click();
  await expect(page).toHaveURL(/\/admin\/ticari-teklifler\/[a-z0-9]+\?ok=created/);
  await expect(page.locator('[data-glass-line]')).toHaveCount(5);
  await expect(page.locator('[data-total="glassM2"]')).toHaveText('4,120');

  // Satış / müşteri: sayfa ve sunucu işlemi kapalı — aşağıdaki testte ve birim testindeki yapı denetiminde
  // (readCommercialExcelAction'ın ilk satırı requirePermission(COMMERCIAL_OFFER_MANAGE))
  expect(await others()).toEqual(before);
  await page.context().close();
});

test('satış ve müşteri: sayfalar, PDF / Excel ve sunucu işlemi kapalı (teklif oluşmaz)', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const html = await (await admin.request.get('/admin/ticari-teklifler/yeni')).text();
  const form = html.split('<form').find((c) => c.includes('name="offer"'));
  const field = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form)?.[0] : undefined;
  expect(field).toBeTruthy();
  const origin = new URL(admin.url()).origin;
  await admin.context().close();
  const db = await prisma();
  try {
    const count = await db.commercialOffer.count();
    for (const [email, pw] of [[SALES, TEAM_PW], [CUSTOMER, CUST_PW]]) {
      const page = await as(browser, email, pw);
      await expect(page.locator('.sidebar').getByRole('link', { name: 'Teklif Oluştur' })).toHaveCount(0);
      await page.goto('/admin/ticari-teklifler');
      await expect(page).not.toHaveURL(/ticari-teklifler/);
      await page.goto(`${offerUrl}`);
      await expect(page).not.toHaveURL(/ticari-teklifler/);
      expect((await page.request.get(`${offerUrl}/pdf`)).status()).toBe(404);
      expect((await page.request.get(`${offerUrl}/excel`)).status()).toBe(404);
      const offer = JSON.stringify({ date: '2026-10-06', firmName: 'Saldırı', validityDays: '5', terms: [], glass: [], profile: [] });
      const res = await page.request.post('/admin/ticari-teklifler/yeni', { multipart: { [field!]: '', offer }, headers: { origin }, maxRedirects: 0 });
      expect(res.status()).toBeLessThan(500);
      await page.context().close();
    }
    expect(await db.commercialOffer.count()).toBe(count);
    expect(await db.commercialOffer.count({ where: { firmName: 'Saldırı' } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});
