import { test, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as, firmOf, openFirm, reportSheet, summaryBlock } from './helpers';

// Paket 7 — Yüklemeler firma tablosu, firma işlemleri, takvim göstergeleri, maskeleme ve dosya adları (karar 186–191).
//  - firma başına tek satır; açılınca alt siparişler; ana satır = alt siparişlerin toplamı; sipariş adedi ≠ cam adedi;
//    fabrika satış ve teklif tutarı ayrı sütun, farklı para birimleri toplanmaz
//  - firma satırı işlemleri: Sandık / PDF / Excel / Özet — yalnızca o firma ve gün; çıktılarda yalnızca müşteri teklif tutarı;
//    Özet'in tutarları yalnızca yöneticide; yetki sunucuda
//  - takvim: sağ üstte iki eşit yuvarlak (sarı = sipariş, kırmızı = misafir yük; misafir yoksa yok), sayı yuvarlağın içinde
//  - satış: firma adları her yerde ilk 3 karakter + 10 yıldız; dosya adları panel dilinde
// FGO bu veritabanında KAPALIDIR: hiçbir belge kesilmez.
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test';
const INSPECTOR = 'denetim@e2e.test';
const BETA = 'beta@betacam.test';
const DAY = new Date(Date.now() + 97 * 86_400_000).toISOString().slice(0, 10); // ileri bir yükleme günü (yalnızca bu test)
const DAY_URL = `/yuklemeler?gun=${DAY}`;
const dmy = (k: string) => k.split('-').reverse().join('.');
const mask = (name: string) => `${name.slice(0, 3)}**********`;
let uns = { id: '', name: '' };
let beta = { id: '', name: '' };
const ids: Record<string, string> = {}; // sipariş no → kimlik
type Rows = (string | number | null)[][];

async function shot(page: Page, name: string, mobile = false) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const before = page.viewportSize();
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `${mobile ? 'mobil' : 'masaustu'}-${name}.png`), fullPage: true });
  if (before) await page.setViewportSize(before);
}
async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
async function xlsx(page: Page, url: string): Promise<{ name: string; rows: Rows; buf: Buffer }> {
  const { readXlsx } = await import('../server/files/xlsx.js');
  const res = await page.request.get(url);
  expect(res.status(), url).toBe(200);
  const buf = await res.body();
  return { name: res.headers()['content-disposition'] ?? '', rows: readXlsx(buf).rows as Rows, buf };
}
/** Firma satırının sayı / tutar hücreleri (data-col) */
const cells = (firm: Locator, cols: string[]) => Promise.all(cols.map(async (c) => (await firm.locator(`tr.firm-row td[data-col="${c}"]`).innerText()).trim()));
const NUM = ['orders', 'glass', 'cnc', 'holes', 'm2', 'net', 'crates', 'gross'];
/** Başlık hücrelerinin metni (ekranda CSS ile büyük harf yazılır — içerik karşılaştırılır) */
const heads = async (l: Locator) => (await l.allTextContents()).map((s) => s.trim());

test('veri: Ünsal\'ın üç siparişi (biri CNC / delikli, biri Beta\'nın sandıklarıyla gidecek) ve Beta\'nın RON siparişi — aynı yükleme günü', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const u = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  const b = await db.user.findUniqueOrThrow({ where: { email: BETA }, include: { customer: true } });
  uns = { id: u.customer!.id, name: u.customer!.name };
  beta = { id: b.customer!.id, name: b.customer!.name };
  type Line = { description: string; adet: number; unit: string; kind: string; unitPrice: string; offerPrice: string; enMm?: number; boyMm?: number };
  // Cam: 20 kg/m² (açıklamadan); fabrika satış 37, müşteri fiyatı 50 / m²
  const glass = (adet: number, enMm = 1000, boyMm = 1000, prices = { unitPrice: '37', offerPrice: '50' }): Line => ({ description: 'Temper', enMm, boyMm, adet, unit: 'm2', kind: 'CAM', ...prices });
  const order = async (c: { id: string; prefix: string | null }, no: number, lines: Line[], o: { amount: string; offer: string; currency?: string; guestHostId?: string }) => {
    const created = await db.order.create({
      data: {
        orderNo: `${c.prefix}${no}`, customerOrderNo: no, title: `Firma tablosu ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE',
        estimatedShipDate: new Date(`${DAY}T12:00:00Z`), guestHostId: o.guestHostId ?? null,
        offers: { create: { status: 'GONDERILDI', currency: o.currency ?? 'EUR', amount: o.amount, offerAmount: o.offer, createdById: admin.id, sentAt: new Date(),
          lines: { create: lines.map((l, i) => ({ sortOrder: i, descriptionRo: l.kind === 'CAM' ? 'Sticlă securizată' : null, ...l })) } } },
      },
    });
    ids[created.orderNo] = created.id;
  };
  // UNS8601: 1 cam (CNC 2 + delik 4) + 2 cam = 3 m²; fabrika 3×37 + 2×5 + 4×2 = 129; teklif 3×50 + 2×10 + 4×5 = 190
  await order(u.customer!, 8601, [glass(1), { description: 'CNC', adet: 2, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '10' }, { description: 'Delik', adet: 4, unit: 'adet', kind: 'DELIK', unitPrice: '2', offerPrice: '5' }, glass(2)], { amount: '129.00', offer: '190.00' });
  await order(u.customer!, 8602, [glass(2, 2000, 1000)], { amount: '148.00', offer: '200.00' }); // 4 m²
  await order(u.customer!, 8603, [glass(1)], { amount: '37.00', offer: '50.00', guestHostId: beta.id }); // Beta'nın sandıklarıyla gidecek
  await order(b.customer!, 8604, [glass(4, 1000, 500, { unitPrice: '150', offerPrice: '200' })], { amount: '300.00', offer: '400.00', currency: 'RON' }); // 2 m²
  await db.$disconnect();
});

test('yönetici: firma başına tek satır; açılınca alt siparişler; ana satır = alt siparişlerin toplamı; sipariş ≠ cam adedi; fabrika satış ve teklif ayrı; para birimleri toplanmaz', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(DAY_URL);
  const table = page.locator('.card#gun .firm-table');
  // Kısa başlıklar (Yönetici Paneli Paketi 1, karar 215); tam adı ipucunda (title)
  expect(await heads(table.locator(':scope > thead th'))).toEqual([
    'Firma', 'Sipariş', 'Cam', 'CNC', 'Delik', 'm²', 'Net kg', 'Sandık', 'Brüt kg', 'Fabrika satış', 'Teklif tutarı', 'İşlemler',
  ]);
  expect(await table.locator(':scope > thead th[title]').evaluateAll((els) => els.map((e) => e.getAttribute('title')))).toEqual([
    'Sipariş adedi', 'Cam adedi', 'CNC adedi', 'Delik adedi', 'Toplam m²', 'Net ağırlık (kg)', 'Sandık adedi', 'Brüt ağırlık (kg)', 'Fabrika satış tutarı', 'Teklif tutarı',
  ]);
  await expect(table.locator(':scope > tbody.firm'), 'firma başına tek satır').toHaveCount(2);
  const u = firmOf(page, uns.name);
  const b = firmOf(page, beta.name);
  // Ünsal: 3 sipariş · 6 cam · CNC 2 · delik 4 · 8 m²; camı 7 m² × 20 kg = 140 kg (misafir 1 m² Beta'da) · 1 tahmini sandık · brüt 190
  const ux = await cells(u, [...NUM, 'factory', 'offer']);
  expect(ux.map((s, i) => (i === 6 ? s.split(/\s/)[0] : s))).toEqual(['3', '6', '2', '4', '8,00', '140', '1', '190', '314,00 EUR', '440,00 EUR']);
  // Beta: 1 sipariş · 4 cam · 2 m²; kendi camı 40 kg + misafir 20 kg = 60 · 1 sandık · brüt 110; tutarlar RON
  const bx = await cells(b, [...NUM, 'factory', 'offer']);
  expect(bx.map((s, i) => (i === 6 ? s.split(/\s/)[0] : s))).toEqual(['1', '4', '–', '–', '2,00', '60', '1', '110', '300,00 RON', '400,00 RON']);
  // Gün toplamı: tutarlar para birimi başına alt alta (toplanmaz)
  const foot = (await table.locator(':scope > tfoot td').allInnerTexts()).map((s) => s.trim());
  expect(foot.slice(0, 11)).toEqual(['Toplam', '4', '10', '2', '4', '10,00', '200', '2', '300', '314,00 EUR\n300,00 RON', '440,00 EUR\n400,00 RON']);

  // Alt siparişler: Sipariş No | Cam | CNC | Delik | Toplam m² | Fabrika Satış | Teklif Tutarı; toplam satırı = ana satır
  const uo = await openFirm(u);
  await expect(u.locator('.firm-toggle')).toHaveAttribute('aria-expanded', 'true');
  expect(await heads(uo.locator('thead th'))).toEqual(['Sipariş No', 'Cam', 'CNC', 'Delik', 'Toplam m²', 'Fabrika Satış', 'Teklif Tutarı']);
  await expect(uo.locator('tbody tr[data-order]')).toHaveCount(3);
  const sub = async (no: string) => (await uo.locator(`tr[data-order="${ids[no]}"] td`).allInnerTexts()).slice(1).map((s) => s.trim());
  expect(await sub('UNS8601')).toEqual(['3', '2', '4', '3,00', '129,00 EUR', '190,00 EUR']);
  expect(await sub('UNS8602')).toEqual(['2', '–', '–', '4,00', '148,00 EUR', '200,00 EUR']);
  expect(await sub('UNS8603')).toEqual(['1', '–', '–', '1,00', '37,00 EUR', '50,00 EUR']);
  await expect(uo.locator(`tr[data-order="${ids.UNS8603}"] .guest-badge`)).toContainText(`sandık bekliyor → ${beta.name}`);
  const subFoot = (await uo.locator('tfoot td').allInnerTexts()).map((s) => s.trim());
  expect(subFoot).toEqual(['Toplam · 3 sipariş', '6', '2', '4', '8,00', '314,00 EUR', '440,00 EUR']);
  expect(subFoot.slice(1), 'ana satır = alt siparişlerin toplamı').toEqual([ux[1], ux[2], ux[3], ux[4], ux[8], ux[9]]);
  const bo = await openFirm(b);
  expect((await bo.locator(`tr[data-order="${ids.BET8604}"] td`).allInnerTexts()).slice(1).map((s) => s.trim())).toEqual(['4', '–', '–', '2,00', '300,00 RON', '400,00 RON']);
  await shot(page, 'yukleme-firma-tablosu');
  await shot(page, 'yukleme-firma-tablosu', true);
  // Kapat: alt siparişler gizlenir
  await u.locator('.firm-toggle').click();
  await expect(u.locator('tr.firm-orders')).toBeHidden();
  await expect(u.locator('.firm-toggle')).toHaveAttribute('aria-expanded', 'false');

  // Yükleme Özeti (Excel): firma bazlı özet ekrandaki tabloyla aynı; para birimleri ayrı sütun; sipariş blokları AYNI sayfada (karar 233)
  const sum = await xlsx(page, `/yuklemeler/dokum?gun=${DAY}`);
  const head = sum.rows.find((r) => r[0] === 'Firma')!;
  expect(head.slice(9)).toEqual(['Fabrika satış tutarı (EUR)', 'Fabrika satış tutarı (RON)', 'Teklif tutarı (EUR)', 'Teklif tutarı (RON)']);
  const line = (name: string) => Array.from({ length: 13 }, (_, i) => sum.rows.find((r) => r[0] === name)?.[i] ?? null);
  expect(line(uns.name)).toEqual([uns.name, 3, 6, 2, 4, 8, 140, 1, 190, 314, null, 440, null]);
  expect(line(beta.name)).toEqual([beta.name, 1, 4, 0, 0, 2, 60, 1, 110, null, 300, null, 400]);
  expect(line('TOPLAM')).toEqual(['TOPLAM', 4, 10, 2, 4, 10, 200, 2, 300, 314, 300, 440, 400]);
  const guest = sum.rows.find((r) => r[0] === 'UNS8603')!;
  expect([guest[1], guest[5], guest[8]], 'fiziksel sandık ilişkisi ayrı tabloda').toEqual([uns.name, beta.name, 'sandık seçimi bekliyor']);
  const one = await reportSheet(sum.buf, 1);
  expect(await reportSheet(sum.buf, 2), 'tek çalışma sayfası').toEqual([]);
  for (const no of ['UNS8601', 'UNS8602', 'UNS8603', 'BET8604']) expect(summaryBlock(one, `${no.startsWith('BET') ? beta.name : uns.name} · ${no}`), `sipariş bloğu aynı sayfada: ${no}`).not.toBeNull();
  // Genel toplam para birimi başına (birimler toplanmaz)
  expect(one.some((r) => r[0] === 'GENEL TOPLAM')).toBe(true);
  expect(one.some((r) => r[0] === 'TOPLAM (EUR)') && one.some((r) => r[0] === 'TOPLAM (RON)')).toBe(true);
  await page.context().close();
});

test('takvim: sağ üstte iki eşit yuvarlak — sarı sipariş sayısı, kırmızı misafir yük sayısı; sayı yuvarlağın içinde; masaüstü ve mobil', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(DAY_URL);
  const cell = page.locator('.cal-day.sel');
  await expect(cell.locator('.cal-count')).toHaveText('4');
  await expect(cell.locator('.cal-guests')).toHaveText('1');
  await expect(cell.locator('.cal-guests')).toHaveAttribute('title', 'Misafir yük: 1 sipariş');
  await expect(cell.locator('.cal-names')).toContainText(uns.name);
  const measure = () => cell.evaluate((day) => {
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    const count = day.querySelector('.cal-count') as HTMLElement;
    const guests = day.querySelector('.cal-guests') as HTMLElement;
    const style = (el: HTMLElement) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color, radius: s.borderRadius }; };
    // Sayı yuvarlağın içinde: metin taşmaz
    const fits = (el: HTMLElement) => el.scrollWidth <= el.clientWidth + 0.5 && el.scrollHeight <= el.clientHeight + 0.5;
    return { day: box(day), count: box(count), guests: box(guests), countStyle: style(count), guestStyle: style(guests), fits: fits(count) && fits(guests) };
  });
  for (const [label, viewport] of [['masaüstü', { width: 1440, height: 900 }], ['mobil', { width: 375, height: 812 }]] as const) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(200);
    const g = await measure();
    expect(Math.abs(g.count.w - g.count.h), `${label}: yuvarlak`).toBeLessThan(0.6);
    expect(Math.abs(g.count.w - g.guests.w), `${label}: iki yuvarlak eşit`).toBeLessThan(0.6);
    expect(Math.abs(g.count.h - g.guests.h)).toBeLessThan(0.6);
    expect(Math.abs(g.count.y - g.guests.y), `${label}: yan yana`).toBeLessThan(0.6);
    expect(g.guests.x, `${label}: sarı solda, kırmızı sağda`).toBeGreaterThan(g.count.x);
    expect(g.guests.right, `${label}: hücrenin içinde`).toBeLessThanOrEqual(g.day.right);
    expect(g.day.right - g.guests.right, `${label}: sağ kenarda`).toBeLessThan(16);
    expect(g.count.y - g.day.y, `${label}: üstte`).toBeLessThan(16);
    expect(g.count.w, `${label}: okunur boyut`).toBeGreaterThanOrEqual(15);
    expect(g.fits, `${label}: sayı yuvarlağın içinde`).toBe(true);
    expect(g.countStyle, `${label}: açık sarı zemin, koyu sayı`).toEqual({ bg: 'rgb(255, 248, 217)', color: 'rgb(59, 47, 0)', radius: '50%' });
    expect(g.guestStyle, `${label}: açık kırmızı / pembe zemin, koyu kırmızı sayı`).toEqual({ bg: 'rgb(253, 235, 238)', color: 'rgb(142, 27, 27)', radius: '50%' });
  }
  await shot(page, 'yukleme-takvim-gostergeleri', true);
  await page.context().close();
});

test('firma işlemleri: Sandık / PDF / Excel / Özet — yalnızca o firma ve gün; çıktıda yalnızca teklif tutarı; Özet\'in tutarları yalnızca yöneticide; yetki sunucuda', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(DAY_URL);
  const u = firmOf(page, uns.name);
  const q = `gun=${DAY}&firma=${uns.id}`;
  await expect(u.locator('[data-action=pdf]')).toHaveAttribute('href', `/yuklemeler/firma?${q}&bicim=pdf`);
  await expect(u.locator('[data-action=xlsx]')).toHaveAttribute('href', `/yuklemeler/firma?${q}&bicim=xlsx`);
  await expect(u.locator('[data-action=summary]')).toHaveAttribute('href', `/yuklemeler/ozet?${q}`);
  // Sandık: firmanın o günkü sandık bölümü (sandık formu bu firmanın); misafir sipariş için açık uyarı
  const crates = await openFirm(u, 'crates');
  await expect(u.locator('[data-action=crates]')).toHaveAttribute('aria-expanded', 'true');
  await expect(crates.locator('form.crate-editor input[name=customerId]')).toHaveValue(uns.id);
  await expect(crates.locator(`.guest-note[data-order="${ids.UNS8603}"]`)).toContainText(`UNS8603 — Bu sipariş ${beta.name} firmasının sandıkları ile gelecektir.`);
  await expect(crates.getByRole('button', { name: '+ Sandık ekle' }), 'firmanın misafir olmayan siparişleri var').toBeEnabled();
  const bc = await openFirm(firmOf(page, beta.name), 'crates');
  await expect(bc.locator(`.guest-box form.guest-in[data-order="${ids.UNS8603}"]`)).toContainText(`UNS8603 · ${uns.name} · 1 cam · 1,000 m²`);

  // Excel: yalnızca bu firma ve gün; finansal olarak yalnızca teklif tutarı (fabrika satış tutarı hiçbir hücrede yok)
  const ex = await xlsx(page, `/yuklemeler/firma?${q}&bicim=xlsx`);
  expect(ex.name).toContain(`filename="Yukleme-UNS-${DAY}.xlsx"`);
  const row = (no: string) => ex.rows.find((r) => r[0] === no);
  expect(row('UNS8601')?.slice(0, 7)).toEqual(['UNS8601', 'Firma tablosu 8601', 3, 2, 4, 3, 190]);
  expect(row('UNS8602')?.slice(0, 7)).toEqual(['UNS8602', 'Firma tablosu 8602', 2, 0, 0, 4, 200]);
  expect(row('UNS8603')?.slice(0, 7)).toEqual(['UNS8603', 'Firma tablosu 8603', 1, 0, 0, 1, 50]);
  expect(row('BET8604'), 'başka firmanın siparişi yok').toBeUndefined();
  expect(ex.rows.find((r) => r[0] === 'Toplam')?.slice(0, 7)).toEqual(['Toplam', null, 6, 2, 4, 8, 440]);
  for (const factory of [129, 148, 37, 314]) expect(ex.rows.flat(), `fabrika satış tutarı yok: ${factory}`).not.toContain(factory);
  expect(ex.rows.flat()).toContain('Teklif tutarı (EUR)');
  expect(ex.rows.flat().some((c) => typeof c === 'string' && /fabrika/i.test(c))).toBe(false);
  expect(ex.rows.flat()).toContain('UNS8603: başka firmanın sandığıyla gidiyor — sandık seçimi bekliyor');
  for (const s of [beta.name, 'BET8604']) expect(JSON.stringify(ex.rows), `başka firma yok: ${s}`).not.toContain(s);
  // PDF: aynı veri (içerik birim testinde); başlık ve dosya adı
  const pdf = await page.request.get(`/yuklemeler/firma?${q}&bicim=pdf`);
  expect([pdf.status(), pdf.headers()['content-type']]).toEqual([200, 'application/pdf']);
  expect(pdf.headers()['content-disposition']).toContain(`filename="Yukleme-UNS-${DAY}.pdf"`);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  // Özet (yönetici): firma + gün; fabrika satış VE teklif tutarı; fiziksel sandık ilişkisi ayrı bölümde
  await u.locator('[data-action=summary]').click();
  await expect(page).toHaveURL(new RegExp(`/yuklemeler/ozet\\?gun=${DAY}&firma=${uns.id}$`));
  await expect(page.locator('h1')).toHaveText(`Yükleme özeti — ${uns.name}`);
  const eur = page.locator('#ozet-tutarlar tr[data-currency="EUR"]');
  await expect(eur.locator('[data-col=factory]')).toHaveText('314,00 EUR');
  await expect(eur.locator('[data-col=offer]')).toHaveText('440,00 EUR');
  await expect(page.locator('#ozet-tutarlar tr[data-currency]')).toHaveCount(1);
  await expect(page.locator('#ozet-siparisler tbody tr[data-order]')).toHaveCount(3);
  await expect(page.locator('#ozet-siparisler')).not.toContainText('BET8604');
  await expect(page.locator(`#ozet-fiziksel [data-away] li[data-order="${ids.UNS8603}"]`)).toContainText(`Bu sipariş ${beta.name} firmasının sandıkları ile gelecektir.`);
  await shot(page, 'yukleme-firma-ozeti');
  await page.goto(`/yuklemeler/ozet?gun=${DAY}&firma=${beta.id}`);
  await expect(page.locator(`#ozet-fiziksel [data-in] li[data-order="${ids.UNS8603}"]`)).toContainText(`UNS8603 · ${uns.name} · Sandık seçimi bekliyor`);
  await expect(page.locator('#ozet-siparisler tbody tr[data-order]'), 'misafir sipariş ev sahibinin ticari satırlarında yok').toHaveCount(1);
  await expect(page.locator('#ozet-tutarlar tr[data-currency="RON"] [data-col=offer]')).toHaveText('400,00 RON');
  // Başka gün / bilinmeyen firma: veri yok; geçersiz gün: 400
  expect((await page.request.get(`/yuklemeler/firma?gun=${DAY}&firma=yok&bicim=pdf`)).status()).toBe(404);
  expect((await page.request.get(`/yuklemeler/firma?gun=2020-01-01&firma=${uns.id}&bicim=pdf`)).status()).toBe(404);
  expect((await page.request.get(`/yuklemeler/firma?gun=abc&firma=${uns.id}&bicim=xlsx`)).status()).toBe(400);
  await page.goto(`/yuklemeler/ozet?gun=2020-01-01&firma=${uns.id}`);
  await expect(page.locator('main')).toContainText('Bu firmanın bu gün yüklemesi yok.');
  await page.context().close();

  // Denetimci: firma tablosunda ve çıktısında yalnızca teklif tutarı (müşteri fiyatı); Özet'te tutar yok
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(DAY_URL);
  const ih = await heads(insp.locator('.card#gun .firm-table > thead th'));
  expect([ih.includes('Teklif tutarı'), ih.includes('Fabrika satış tutarı')]).toEqual([true, false]);
  const ix = await xlsx(insp, `/yuklemeler/firma?${q}&bicim=xlsx`);
  expect(ix.rows.flat()).toContain(190);
  expect(ix.rows.flat()).not.toContain(129);
  await insp.goto(`/yuklemeler/ozet?${q}`);
  await expect(insp.locator('h1')).toHaveText(`Yükleme özeti — ${uns.name}`);
  await expect(insp.locator('#ozet-tutarlar')).toHaveCount(0);
  for (const h of ['Fabrika satış', 'Teklif tutarı']) await expect(insp.locator('#ozet-siparisler th', { hasText: h })).toHaveCount(0);
  await insp.context().close();

  // Müşteri ve çizim: firma çıktısı ve özet iç ekibindir (sunucu reddeder)
  for (const [who, email, pw] of [['musteri', CUSTOMER, CUST_PW], ['cizim', DRAWER, TEAM_PW]] as const) {
    const p = await as(browser, email, pw);
    for (const f of ['pdf', 'xlsx']) expect((await p.request.get(`/yuklemeler/firma?${q}&bicim=${f}`)).status(), `${who}: ${f}`).toBe(403);
    expect((await p.request.get(`/yuklemeler/dokum?gun=${DAY}`)).status(), `${who}: özet Excel`).toBe(403);
    const r = await p.request.get(`/yuklemeler/ozet?${q}`);
    expect(r.url(), `${who}: özet sayfası`).not.toContain('/yuklemeler/ozet');
    expect(await r.text()).not.toContain('ozet-siparisler');
    await p.context().close();
  }
});

test('satış: firma adları her yerde ilk 3 karakter + 10 yıldız (tablo, alt sipariş, takvim, misafir uyarısı, sandık ekranı, ipuçları, sayfa verisi, gün Excel\'i); tutar yalnızca fabrika satış; firma PDF / Excel / Özet satışa kapalı', async ({ browser }) => {
  const sales = await as(browser, SALES2, TEAM_PW);
  await sales.goto(DAY_URL);
  // Sayfanın bütün verisi (HTML + sunucu bileşeni yükü) tam adı içermez
  const html = await (await sales.request.get(DAY_URL)).text();
  for (const n of [uns.name, beta.name]) expect(html, `sayfa verisi: ${n}`).not.toContain(n);
  expect(html).toContain(mask(uns.name));
  const u = firmOf(sales, mask(uns.name));
  const b = firmOf(sales, mask(beta.name));
  await expect(u.locator('tr.firm-row')).toBeVisible();
  await expect(sales.locator('.cal-day.sel .cal-names')).toContainText(mask(uns.name));
  await expect(sales.locator('#gun .guest-waiting')).toContainText(`UNS8603 · ${mask(uns.name)}`);
  await expect(sales.locator('#gun .guest-waiting')).toContainText(`Hedef firma: ${mask(beta.name)}`);
  // İpuçları (title): misafir yük rozetleri
  await expect(u.locator('[data-guest-out]')).toHaveAttribute('title', `Fiziksel sandık sahibi: ${mask(beta.name)}. Ticari sahiplik bu firmada kalır; sandık ve ağırlık sandığın sahibinde sayılır.`);
  await expect(b.locator('[data-guest-in]')).toHaveAttribute('title', `UNS8603 · ${mask(uns.name)}`);
  // Alt sipariş ve sandık ekranı
  const uo = await openFirm(u);
  await expect(uo.locator(`tr[data-order="${ids.UNS8603}"] .guest-badge`)).toContainText(`sandık bekliyor → ${mask(beta.name)}`);
  const uc = await openFirm(u, 'crates');
  await expect(uc.locator(`.guest-note[data-order="${ids.UNS8603}"]`)).toContainText(`Bu sipariş ${mask(beta.name)} firmasının sandıkları ile gelecektir.`);
  const bc = await openFirm(b, 'crates');
  await expect(bc.locator(`.guest-box form.guest-in[data-order="${ids.UNS8603}"]`)).toContainText(`UNS8603 · ${mask(uns.name)}`);
  for (const n of [uns.name, beta.name]) await expect(sales.locator('main'), `ekran: ${n}`).not.toContainText(n);
  // Tutar: yalnızca fabrika satış (müşteri teklif tutarı satışa gelmez)
  expect(await heads(sales.locator('.card#gun .firm-table > thead th'))).toEqual([
    'Firma', 'Sipariş', 'Cam', 'CNC', 'Delik', 'm²', 'Net kg', 'Sandık', 'Brüt kg', 'Fabrika satış', 'İşlemler',
  ]);
  // Firma satırında satış yalnızca "Sandık"ı görür (karar 215)
  expect(await u.locator('tr.firm-row .firm-acts [data-action]').evaluateAll((els) => els.map((e) => e.getAttribute('data-action')))).toEqual(['crates']);
  expect(await cells(u, ['factory'])).toEqual(['314,00 EUR']);
  expect(await heads(uo.locator('thead th'))).toEqual(['Sipariş No', 'Cam', 'CNC', 'Delik', 'Toplam m²', 'Fabrika Satış']);
  await shot(sales, 'yukleme-firma-tablosu-satis');

  // Gün Excel'i (satışın gün belgesi — durur): maskeli; teklif tutarı yok
  const sum = await xlsx(sales, `/yuklemeler/dokum?gun=${DAY}`);
  expect(sum.rows.some((r) => r[0] === mask(uns.name))).toBe(true);
  const lines = await reportSheet(sum.buf, 1);
  for (const n of [uns.name, beta.name]) expect(JSON.stringify([sum.rows, lines]), `özet Excel: ${n}`).not.toContain(n);
  // Sipariş blok başlıkları da maskeli (karar 233)
  expect(summaryBlock(lines, `${mask(uns.name)} · UNS8601`)).not.toBeNull();
  // Excel'in belge özellikleri (docProps) de tam adı taşımaz
  const { openZip } = await import('../server/files/zip.js');
  const zip = openZip(sum.buf);
  for (const part of ['docProps/core.xml', 'docProps/app.xml', 'xl/workbook.xml']) {
    const xml = zip.read(part)?.toString('utf8') ?? '';
    for (const n of [uns.name, beta.name]) expect(xml, `${part}: ${n}`).not.toContain(n);
  }
  expect(sum.rows.flat().some((c) => typeof c === 'string' && c.startsWith('Teklif tutarı'))).toBe(false);
  // Firma PDF / Excel / Özet satışa kapalı (karar 215): sunucu reddeder, Özet yükleme gününe döner (maskeli sayfa)
  for (const f of ['pdf', 'xlsx']) expect((await sales.request.get(`/yuklemeler/firma?gun=${DAY}&firma=${uns.id}&bicim=${f}`)).status(), f).toBe(403);
  await sales.goto(`/yuklemeler/ozet?gun=${DAY}&firma=${uns.id}`);
  await expect(sales).toHaveURL(new RegExp(`/yuklemeler\\?gun=${DAY}$`));
  await expect(sales.locator('#ozet-siparisler, #ozet-tutarlar, #ozet-ayrinti')).toHaveCount(0);
  const ozetHtml = await (await sales.request.get(`/yuklemeler/ozet?gun=${DAY}&firma=${uns.id}`)).text();
  for (const n of [uns.name, beta.name]) expect(ozetHtml, `özet adresi: ${n}`).not.toContain(n);
  await sales.context().close();
});

test('dosya adları panel dilinde ve güvenli karakterlerle (TR / RO); belge içeriği seçilen dilde', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  const names = async () => {
    const get = async (url: string) => (await page.request.get(url)).headers()['content-disposition'];
    return [
      await get(`/yuklemeler/dokum?gun=${DAY}`), await get(`/yuklemeler/nakliye?gun=${DAY}`),
      await get(`/yuklemeler/firma?gun=${DAY}&firma=${uns.id}&bicim=xlsx`), await get(`/yuklemeler/firma?gun=${DAY}&firma=${uns.id}&bicim=pdf`),
    ];
  };
  expect(await names()).toEqual([
    `attachment; filename="Yukleme-Ozeti-${DAY}.xlsx"`, `attachment; filename="Nakliye-Listesi-${DAY}.pdf"`,
    `attachment; filename="Yukleme-UNS-${DAY}.xlsx"`, `attachment; filename="Yukleme-UNS-${DAY}.pdf"`,
  ]);
  await page.goto('/dil?l=ro&next=/yuklemeler');
  try {
    expect(await names()).toEqual([
      `attachment; filename="Rezumat-Incarcare-${DAY}.xlsx"`, `attachment; filename="Lista-Transport-${DAY}.pdf"`,
      `attachment; filename="Incarcare-UNS-${DAY}.xlsx"`, `attachment; filename="Incarcare-UNS-${DAY}.pdf"`,
    ]);
    const ro = await xlsx(page, `/yuklemeler/dokum?gun=${DAY}`);
    expect(ro.rows[0][0]).toBe(`REZUMAT ÎNCĂRCARE · ${dmy(DAY)}`);
    const { readXlsx } = await import('../server/files/xlsx.js');
    expect(readXlsx(ro.buf).sheetName).toBe('Rezumat încărcare');
    const fro = await xlsx(page, `/yuklemeler/firma?gun=${DAY}&firma=${uns.id}&bicim=xlsx`);
    expect(String(fro.rows[0][0])).toContain('LISTĂ DE ÎNCĂRCARE');
  } finally {
    await page.goto('/dil?l=tr&next=/yuklemeler');
  }
  await page.context().close();
});
