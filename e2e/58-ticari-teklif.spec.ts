import { test, expect, type Page } from '@playwright/test';
import zlib from 'node:zlib';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, TEAM_PW, as, reportSheet } from './helpers';
import { FONTS } from '../server/pdf/fonts.js';

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

test('3.100.0: cam bölümünde CNC / delik (adet camdan bağımsız) ve sandık parası — canlı toplam, kayıt, yeniden açma, PDF ve iç Excel', async ({ browser }) => {
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
