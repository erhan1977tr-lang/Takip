import { test, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import {
  ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, INSPECTOR_PW, TEAM_PW, as, createUser, firmOf, firstLogin, openFirm, outboxCodeFor, reportSheet, sampleFile,
} from './helpers';

// Yönetici Paneli Düzeltme Paketi 1 (3.63.0, kararlar 215–218):
//  - yükleme günü: firma satırının işlemleri yönetici için PDF | Excel | Özet | Sandık, satış için yalnızca Sandık (sunucu da
//    reddeder); masaüstünde ve 390 px'te yatay kayma yok; firma PDF'i ve Excel'i aynı kapsam (sipariş başına teklif satırları,
//    sandık parası ayrı kalem, para birimleri ayrı); Özet'te fabrika satış ve müşteri teklifi ayrı; misafir yükte sandık ve
//    ağırlık iki kez sayılmaz
//  - "Profil Siparişleri" bölümü ve kırmızı sayaç; yöneticinin "Sıra bende"sinde dört tablo
//  - yöneticinin e-postaları: yeni sipariş, satışın fabrika fiyatını değiştirmesi (aynı fiyatın yeniden gönderimi yok), satışın
//    teklifi geri alması (zil ve bekleyen kuyruk güncel); şifre sıfırlamada yöneticiye e-posta yok
// FGO / ANAF / Google'a istek yapılmaz; e-postalar işçinin outbox klasörüne yazılır (gerçek SMTP yok).
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test';
const INSPECTOR = 'denetim@e2e.test';
const BETA = 'beta@betacam.test';
const DAY = new Date(Date.now() + 103 * 86_400_000).toISOString().slice(0, 10); // yalnızca bu testin yükleme günü
const DAY_URL = `/yuklemeler?gun=${DAY}`;
const mask = (name: string) => `${name.slice(0, 3)}**********`;
let uns = { id: '', name: '' };
let beta = { id: '', name: '' };
const ids: Record<string, string> = {};
type Rows = (string | number | null)[][];

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const worker = () => execFileSync('node', ['scripts/worker.mjs', '--once'], { env: process.env, stdio: 'inherit' });
function mailsTo(email: string): { subject: string; text: string; html: string; to: string }[] {
  const dir = process.env.MAIL_OUTBOX_DIR!;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.includes(email)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}
async function shot(page: Page, name: string) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
}
/** Sayfa ve firma tablosu yatay kaymıyor (tablo kendi alanında da kaymaz) */
const overflow = (page: Page) => page.evaluate(() => ({
  doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  wrap: Math.max(0, ...[...document.querySelectorAll('.firm-wrap, .firm-sub, .crate-editor .table-wrap, .stack-wrap')].map((el) => el.scrollWidth - el.clientWidth)),
}));
const actionsOf = (firm: Locator) => firm.locator('tr.firm-row .firm-acts [data-action]').evaluateAll((els) => els.map((e) => e.getAttribute('data-action')));
const actionRows = (firm: Locator) => firm.locator('tr.firm-row .firm-acts [data-action]').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
async function xlsx(page: Page, url: string) {
  const { readXlsx } = await import('../server/files/xlsx.js');
  const res = await page.request.get(url);
  expect(res.status(), url).toBe(200);
  const buf = await res.body();
  return { first: readXlsx(buf).rows as Rows, detail: await reportSheet(buf, 2) };
}
/** Firma PDF'inin metni (gömülü yazı tipinin karakter tablosuyla — test/firm-export.test.js ile aynı okuyucu) */
async function pdfText(buf: Buffer): Promise<string[]> {
  const { FONTS } = await import('../server/pdf/fonts.js');
  const fonts = FONTS as unknown as Record<string, { map: [number, number][] }>;
  const reverse = Object.fromEntries(['Regular', 'Bold'].map((k) => [k, new Map(fonts[k].map.map(([cp, gid]) => [gid, cp]))]));
  const out: string[] = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  const s = buf.toString('latin1');
  for (let m; (m = re.exec(s));) {
    const start = m.index + m[0].length;
    let ops: string;
    try { ops = zlib.inflateSync(buf.subarray(start, start + Number(m[1]))).toString('latin1'); } catch { continue; }
    for (const t of ops.matchAll(/\/(F1|F2) [\d.]+ Tf [\d.-]+ [\d.-]+ Td <([0-9a-f]*)> Tj/g)) {
      const map = reverse[t[1] === 'F2' ? 'Bold' : 'Regular'];
      out.push((t[2].match(/.{4}/g) ?? []).map((h) => String.fromCodePoint(map.get(parseInt(h, 16)) ?? 63)).join(''));
    }
  }
  return out;
}

test('veri: aynı yükleme gününde Ünsal\'ın iki siparişi (biri iki sandık parası satırlı, biri Beta\'nın sandığında misafir yük) ve Beta\'nın RON siparişi + sandığı', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const u = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  const b = await db.user.findUniqueOrThrow({ where: { email: BETA }, include: { customer: true } });
  uns = { id: u.customer!.id, name: u.customer!.name };
  beta = { id: b.customer!.id, name: b.customer!.name };
  type Line = { description: string; adet: number; unit: string; kind: string; unitPrice: string; offerPrice: string; enMm?: number; boyMm?: number; crateFee?: boolean; descriptionRo?: string };
  const glass = (adet: number, enMm = 1000, boyMm = 1000, unitPrice = '37', offerPrice = '50'): Line => ({ description: 'Temper', descriptionRo: 'Sticlă securizată', enMm, boyMm, adet, unit: 'm2', kind: 'CAM', unitPrice, offerPrice });
  const order = async (c: { id: string; prefix: string | null }, no: number, lines: Line[], o: { amount: string; offer: string; currency?: string; guestHostId?: string }) => {
    const created = await db.order.create({
      data: {
        orderNo: `${c.prefix}${no}`, customerOrderNo: no, title: `Yönetici paketi ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE',
        estimatedShipDate: new Date(`${DAY}T12:00:00Z`), guestHostId: o.guestHostId ?? null,
        offers: { create: { status: 'GONDERILDI', currency: o.currency ?? 'EUR', amount: o.amount, offerAmount: o.offer, createdById: admin.id, sentAt: new Date(),
          lines: { create: lines.map((l, i) => ({ sortOrder: i, ...l })) } } },
      },
    });
    ids[created.orderNo] = created.id;
    return created;
  };
  // UNS9301: 2 m² cam (37 / 50) + CNC 2 (5 / 10) + delik 4 (2 / 5) + satışın sandık parası 2 × (25 / 30) + yöneticinin sandık
  // bedeli 1 × (0 / 45) → fabrika 74 + 10 + 8 + 50 = 142 · müşteri 100 + 20 + 20 + 60 + 45 = 245
  await order(u.customer!, 9301, [
    glass(2),
    { description: 'CNC', adet: 2, unit: 'adet', kind: 'CNC', unitPrice: '5', offerPrice: '10' },
    { description: 'Delik', adet: 4, unit: 'adet', kind: 'DELIK', unitPrice: '2', offerPrice: '5' },
    { description: 'Sandık parası', descriptionRo: 'Ambalaj (ladă)', adet: 2, unit: 'adet', kind: 'CAM', unitPrice: '25', offerPrice: '30' },
    { description: 'Sandık parası', descriptionRo: 'Ambalaj (ladă)', adet: 1, unit: 'adet', kind: 'CAM', unitPrice: '0', offerPrice: '45', crateFee: true },
  ], { amount: '142.00', offer: '245.00' });
  // UNS9302: 1 m² — Beta'nın sandığıyla gider (misafir yük)
  const guest = await order(u.customer!, 9302, [glass(1)], { amount: '37.00', offer: '50.00', guestHostId: beta.id });
  // BET9303: RON, 2 m²
  const host = await order(b.customer!, 9303, [glass(4, 1000, 500, '150', '200')], { amount: '300.00', offer: '400.00', currency: 'RON' });
  // Beta'nın sandığı: kendi siparişi + Ünsal'ın misafir siparişi (fiziksel yerleşim; ticari sahiplik değişmez)
  const crate = await db.crate.create({ data: { shipDay: new Date(`${DAY}T00:00:00Z`), customerId: beta.id, crateNo: 31, lengthMm: 2400, widthMm: 800, heightMm: 1900, netAgirlik: 80, brutAgirlik: 130 } });
  await db.crateOrder.createMany({ data: [{ crateId: crate.id, orderId: host.id }, { crateId: crate.id, orderId: guest.id }] });
  await db.$disconnect();
});

test('yükleme günü: yöneticide PDF | Excel | Özet | Sandık (geniş ekranda tek satırda); satışta yalnızca Sandık — belge adresleri satışa sunucuda kapalı', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.setViewportSize({ width: 1920, height: 1000 });
  await admin.goto(DAY_URL);
  const u = firmOf(admin, uns.name);
  expect(await actionsOf(u)).toEqual(['pdf', 'xlsx', 'summary', 'crates']);
  expect(await actionsOf(firmOf(admin, beta.name))).toEqual(['pdf', 'xlsx', 'summary', 'crates']);
  expect(await actionRows(u), 'geniş ekranda dört işlem tek satırda').toBe(1);
  await admin.setViewportSize({ width: 1440, height: 900 });
  expect(await actionRows(u), '1440 px: en çok iki satır (tek tek alt alta değil)').toBeLessThanOrEqual(2);
  // Kısa başlıklar; tam adı ipucunda
  const th = admin.locator('.card#gun .firm-table > thead th');
  expect((await th.allTextContents()).map((s) => s.trim())).toEqual(['Firma', 'Sipariş', 'Cam', 'CNC', 'Delik', 'm²', 'Net kg', 'Sandık', 'Brüt kg', 'Fabrika satış', 'Teklif tutarı', 'İşlemler']);
  await expect(th.nth(1)).toHaveAttribute('title', 'Sipariş adedi');
  await admin.context().close();

  const sales = await as(browser, SALES2, TEAM_PW);
  await sales.goto(DAY_URL);
  const su = firmOf(sales, mask(uns.name));
  expect(await actionsOf(su)).toEqual(['crates']);
  await expect(sales.locator('.firm-table [data-action=pdf], .firm-table [data-action=xlsx], .firm-table [data-action=summary]')).toHaveCount(0);
  // Sandık satışta çalışır (sandık formu açılır, sunucuya bu firmanın sandıkları gider)
  const crates = await openFirm(su, 'crates');
  await expect(crates.locator('form.crate-editor input[name=customerId]')).toHaveValue(uns.id);
  // Satış sandığı kaydeder (mevcut yetki); firma satırı kayıttan sonra gerçek sandıkla güncellenir — misafir sipariş
  // (UNS9302, Beta'nın sandığında) bu firmanın sandığına konmaz, ağırlığı Beta'da kalır
  await crates.getByRole('button', { name: '+ Sandık ekle' }).click();
  await sales.getByLabel('Uzunluk (mm) (32)').fill('2400');
  await sales.getByLabel('Genişlik (mm) (32)').fill('1000');
  await sales.getByLabel('Yükseklik (mm) (32)').fill('900');
  await sales.getByLabel('Net ağırlık (kg) (32)').fill('100');
  await sales.getByLabel('Brüt ağırlık (kg) (32)').fill('150');
  await sales.getByRole('button', { name: 'Sandıkları kaydet' }).click();
  await expect(crates.locator('.crate-editor .alert-ok')).toContainText('Sandıklar kaydedildi.');
  await sales.reload();
  const after = firmOf(sales, mask(uns.name));
  await expect(after.locator('tr.firm-row td[data-col=crates]')).toContainText('1');
  await expect(after.locator('tr.firm-row td[data-col=crates] .badge')).toHaveText('gerçek');
  await expect(after.locator('tr.firm-row td[data-col=gross]')).toHaveText('150');
  // Sunucu: firma PDF / Excel 403, Özet yükleme gününe döner (veri dönmez); satışın gün belgeleri (nakliye, gün özeti) durur
  const q = `gun=${DAY}&firma=${uns.id}`;
  for (const f of ['pdf', 'xlsx']) expect((await sales.request.get(`/yuklemeler/firma?${q}&bicim=${f}`)).status(), f).toBe(403);
  const ozet = await sales.request.get(`/yuklemeler/ozet?${q}`);
  expect(ozet.url()).not.toContain('/yuklemeler/ozet');
  expect(ozet.url()).toContain(`/yuklemeler?gun=${DAY}`);
  expect(await ozet.text()).not.toContain('ozet-ayrinti');
  expect((await sales.request.get(`/yuklemeler/dokum?gun=${DAY}`)).status(), 'gün özeti Excel\'i satışta durur').toBe(200);
  expect((await sales.request.get(`/yuklemeler/nakliye?gun=${DAY}`)).status(), 'nakliye listesi satışta durur').toBe(200);
  await sales.context().close();
});

test('düzen: masaüstünde (1920 / 1440 / 1280) ve 390 px\'te sayfa ve firma tablosu yatay kaymaz — alt siparişler ve sandık formu açıkken de', async ({ browser }) => {
  for (const [who, email, pw, name] of [['yonetici', ADMIN, ADMIN_PW, () => uns.name], ['satis', SALES2, TEAM_PW, () => mask(uns.name)]] as const) {
    const page = await as(browser, email, pw);
    for (const width of [1920, 1440, 1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(DAY_URL);
      const firm = firmOf(page, name());
      await openFirm(firm);
      await openFirm(firm, 'crates');
      const o = await overflow(page);
      expect(o.doc, `${who} @${width}: sayfa`).toBeLessThanOrEqual(0);
      expect(o.wrap, `${who} @${width}: tablo`).toBeLessThanOrEqual(1);
      // Önemli bilgi gizlenmez: sayılar ve işlemler görünür (dar ekranda etiketli kart)
      await expect(firm.locator('tr.firm-row td[data-col=m2]')).toBeVisible();
      await expect(firm.locator('tr.firm-row [data-action=crates]')).toBeVisible();
      if (width === 390) await shot(page, `mobil-yukleme-firma-${who}`);
      if (width === 1440) await shot(page, `masaustu-yukleme-firma-${who}`);
    }
    await page.context().close();
  }
});

test('firma PDF / Excel: aynı kapsam — sipariş başına teklif satırları (sandık parası ayrı kalem), sipariş tutarı = satırların toplamı; fabrika satışı yok', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  const q = `gun=${DAY}&firma=${uns.id}`;
  const ex = await xlsx(page, `/yuklemeler/firma?${q}&bicim=xlsx`);
  // 1. sayfa: sipariş başına tek satır (Paket 7 düzeni)
  const row = (no: string) => ex.first.find((r) => r[0] === no);
  expect(row('UNS9301')?.slice(0, 7)).toEqual(['UNS9301', 'Yönetici paketi 9301', 2, 2, 4, 2, 245]);
  expect(row('UNS9302')?.slice(0, 7)).toEqual(['UNS9302', 'Yönetici paketi 9302', 1, 0, 0, 1, 50]);
  expect(row('BET9303'), 'başka firmanın siparişi yok').toBeUndefined();
  // 2. sayfa: her teklif satırı; sipariş no her satırda; sandık parası iki ayrı numaralı kalem
  const detail = ex.detail.filter((r) => typeof r?.[0] === 'string' && /^UNS93/.test(String(r[0])));
  const of = (no: string) => detail.filter((r) => r[0] === no);
  expect(of('UNS9301').map((r) => [r[2], r[3], r[7], r[10], r[11]])).toEqual([
    [1, 'Temper', 2, 100, 'EUR'], ['', 'CNC', 2, 20, 'EUR'], ['', 'Delik', 4, 20, 'EUR'], [2, 'Sandık parası', 2, 60, 'EUR'], [3, 'Sandık parası', 1, 45, 'EUR'],
  ]);
  expect(of('UNS9302').map((r) => [r[2], r[10]])).toEqual([[1, 50]]);
  const sum = (no: string) => of(no).reduce((s, r) => s + Number(r[10] ?? 0), 0);
  expect([sum('UNS9301'), sum('UNS9302')], 'sipariş tutarı = satırların toplamı (sandık parası bir kez)').toEqual([245, 50]);
  for (const factory of [142, 74, 37]) expect(ex.detail.flat(), `fabrika satışı yok: ${factory}`).not.toContain(factory);
  const total = ex.detail.find((r) => r?.[0] === 'Toplam');
  expect(total?.[10]).toBe(295);
  // PDF: aynı siparişler, aynı satırlar ve tutarlar
  const res = await page.request.get(`/yuklemeler/firma?${q}&bicim=pdf`);
  expect([res.status(), res.headers()['content-type'], res.headers()['content-disposition']]).toEqual([200, 'application/pdf', `attachment; filename="Yukleme-UNS-${DAY}.pdf"`]);
  const text = await pdfText(await res.body());
  const joined = text.join('\n');
  for (const s of ['SİPARİŞ AYRINTISI', 'UNS9301 — Yönetici paketi 9301', 'UNS9302 — Yönetici paketi 9302', '245,00', '295,00']) expect(joined, s).toContain(s);
  expect(text.filter((t) => t === 'Sandık parası').length, 'sandık parası iki ayrı satır').toBe(2);
  for (const s of ['142,00', '74,00', 'BET9303', beta.name]) expect(joined, `yok: ${s}`).not.toContain(s);
  await page.context().close();
});

test('Özet: fabrika satış ve müşteri teklifi ayrı (satır, sipariş, para birimi); sandık parası ayrı satır; misafir yük iki kez sayılmaz; denetimcide tutar yok', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/yuklemeler/ozet?gun=${DAY}&firma=${uns.id}`);
  await expect(page.locator('h1')).toHaveText(`Yükleme özeti — ${uns.name}`);
  const eur = page.locator('#ozet-tutarlar tr[data-currency="EUR"]');
  await expect(eur.locator('[data-col=factory]')).toHaveText('179,00 EUR');
  await expect(eur.locator('[data-col=offer]')).toHaveText('295,00 EUR');
  const d = page.locator(`#ozet-ayrinti section[data-order-detail="${ids.UNS9301}"]`);
  await expect(d.locator('tr.detail-groups')).toContainText('Fabrika satış (EUR)');
  await expect(d.locator('tr.detail-groups')).toContainText('Müşteri teklifi (EUR)');
  await expect(d.locator('tbody tr')).toHaveCount(5);
  const crates = d.locator('tbody tr', { hasText: 'Sandık parası' });
  await expect(crates).toHaveCount(2);
  await expect(crates.nth(0).locator('[data-col=factory]')).toHaveText('50,00');
  await expect(crates.nth(0).locator('[data-col=offer]')).toHaveText('60,00');
  await expect(crates.nth(1).locator('[data-col=factory]')).toHaveText('0,00');
  await expect(crates.nth(1).locator('[data-col=offer]')).toHaveText('45,00');
  await expect(d.locator('tfoot [data-col=factory]')).toHaveText('142,00 EUR');
  await expect(d.locator('tfoot [data-col=offer]')).toHaveText('245,00 EUR');
  // Sipariş tablosu: aynı sayılar
  await expect(page.locator(`#ozet-siparisler tr[data-order="${ids.UNS9301}"] [data-col=factory]`)).toHaveText('142,00 EUR');
  await expect(page.locator(`#ozet-siparisler tr[data-order="${ids.UNS9301}"] [data-col=offer]`)).toHaveText('245,00 EUR');
  expect((await overflow(page)).doc).toBeLessThanOrEqual(0);
  await shot(page, 'masaustu-yukleme-ozeti-ayrinti');
  await page.setViewportSize({ width: 390, height: 844 });
  const o = await overflow(page);
  expect([o.doc <= 0, o.wrap <= 1], '390 px: sayfa ve tablolar kaymaz').toEqual([true, true]);
  await shot(page, 'mobil-yukleme-ozeti-ayrinti');
  // Beta: kendi RON siparişi; misafir sipariş ticari satırlarında yok
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/yuklemeler/ozet?gun=${DAY}&firma=${beta.id}`);
  await expect(page.locator('#ozet-tutarlar tr[data-currency="RON"] [data-col=offer]')).toHaveText('400,00 RON');
  await expect(page.locator('#ozet-ayrinti section[data-order-detail]')).toHaveCount(1);
  // Yükleme günü: sandık ve ağırlık yalnızca taşıyan firmada — gün toplamı firmaların toplamı (iki kez sayılmaz)
  await page.goto(DAY_URL);
  const num = async (l: Locator) => Number((await l.innerText()).trim().split(/\s/)[0].replace(/\./g, '').replace(',', '.'));
  const firms = page.locator('.card#gun .firm-table > tbody.firm');
  const sumCol = async (col: string) => { let s = 0; for (const f of await firms.all()) s += await num(f.locator(`tr.firm-row td[data-col=${col}]`)); return s; };
  const foot = (col: string) => num(page.locator(`.card#gun .firm-table > tfoot td[data-col=${col}]`));
  for (const col of ['crates', 'gross', 'net']) expect(await sumCol(col), col).toBe(await foot(col));
  await page.context().close();

  // Denetimci: satırlar var, fiyat sütunları yok
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(`/yuklemeler/ozet?gun=${DAY}&firma=${uns.id}`);
  await expect(insp.locator(`#ozet-ayrinti section[data-order-detail="${ids.UNS9301}"] tbody tr`)).toHaveCount(5);
  await expect(insp.locator('#ozet-ayrinti .grp-factory, #ozet-ayrinti .grp-offer, #ozet-tutarlar')).toHaveCount(0);
  await insp.context().close();
});

test('"Profil Siparişleri" bölümü: kırmızı sayaç = fiyat bekleyen profil siparişleri (sunucuda); iptal sayılmaz; tablolar bölümde; satışta yok', async ({ browser }) => {
  const db = await prisma();
  const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  const where = { removedAt: null, orderTypeCode: 'PROFILE_ORDER', status: { notIn: ['IPTAL', 'ARSIVLENDI'] as ('IPTAL' | 'ARSIVLENDI')[] }, profile: { is: { stage: 'FIYAT_BEKLIYOR' as const } } };
  let no = 9400;
  const made: string[] = [];
  const profile = async (status: 'YENI' | 'IPTAL' = 'YENI') => {
    no += 1;
    const o = await db.order.create({
      data: { orderNo: `UNSP${no}`, customerOrderNo: no, title: 'Profil sayaç', orderTypeCode: 'PROFILE_ORDER', customerId: cust.customerId!, createdById: cust.id, status, profile: { create: { stage: 'FIYAT_BEKLIYOR' } } },
    });
    made.push(o.id);
  };
  await profile();
  await profile();
  await profile('IPTAL');
  const expected = await db.order.count({ where });
  expect(expected).toBeGreaterThanOrEqual(2);
  const text = (n: number) => (n > 99 ? '99+' : String(n));
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/siparisler');
  const section = admin.locator('.sidebar .nav-section', { hasText: 'Profil Siparişleri' });
  await expect(section.locator('[data-nav-count]')).toHaveText(text(expected));
  await expect(section).toHaveAttribute('title', `${expected} yeni profil siparişi fiyat bekliyor`);
  // Bölümün bağlantıları: profil siparişleri ve profil tanımları
  for (const href of ['/siparisler?view=profil', '/admin/profil-katalogu', '/admin/profil-katalogu/hesaplama', '/admin/profil-fiyatlari', '/admin/stok']) await expect(admin.locator(`.sidebar .nav a[href="${href}"]`)).toHaveCount(1);
  // Bağlantılar bölümün altında (yan menüdeki sırayla: bölüm adı → profil bağlantıları → Çizim Ekibi)
  const order = await admin.locator('.sidebar .nav > *').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? `#${e.textContent?.replace(/\d+$/, '').trim()}`));
  const at = order.findIndex((x) => x.startsWith('#Profil Siparişleri'));
  expect(order.slice(at + 1, at + 6)).toEqual(['/siparisler?view=profil', '/admin/profil-katalogu', '/admin/profil-katalogu/hesaplama', '/admin/profil-fiyatlari', '/admin/stok']);
  // Yeni profil siparişi → sayaç bir artar (sunucuda yeniden sayılır)
  await profile();
  await admin.reload();
  await expect(section.locator('[data-nav-count]')).toHaveText(text(expected + 1));
  // Bölümün sayfası: profil tabloları; "fiyat bekleyenler" sayacıyla aynı
  await admin.getByRole('link', { name: 'Profil siparişleri', exact: true }).first().click();
  await expect(admin).toHaveURL(/\/siparisler\?view=profil$/);
  await expect(admin.locator('h1')).toHaveText('Profil Siparişleri');
  await expect(admin.locator('#profil-profilePricing .card-head .badge')).toHaveText(String(Math.min(expected + 1, 300)));
  expect((await admin.locator('main .card-flush > .card-head h2').allInnerTexts()).map((s) => s.replace(/\s*\d+$/, ''))).toEqual([
    'Profil — fiyat bekleyenler', 'Profil — onaylanmamış teklifler', 'Profil — proforma / ödeme bekleyenler', 'Profil — depoda, teslim bekleyenler', 'Profil — faturalanacaklar',
  ]);
  await expect(admin.locator('#profil-profilePricing')).toContainText(`UNSP${no}`);
  // Telefonda bölüm adı yok: sayaç bağlantıda
  await admin.setViewportSize({ width: 390, height: 844 });
  await expect(admin.locator('.mobile-nav a[href="/siparisler?view=profil"] [data-nav-count]')).toHaveText(text(expected + 1));
  await shot(admin, 'mobil-profil-siparisleri');
  await admin.context().close();
  // Satış: bölüm yok, profil sayfası açılmaz (Sıra bende'ye döner)
  const sales = await as(browser, SALES2, TEAM_PW);
  await expect(sales.locator('.sidebar .nav-section', { hasText: 'Profil Siparişleri' })).toHaveCount(0);
  await expect(sales.locator('[data-nav-count]')).toHaveCount(0);
  await sales.goto('/siparisler?view=profil');
  await expect(sales.locator('h1')).toHaveText('Satış Paneli');
  await expect(sales.locator('#profil-profilePricing')).toHaveCount(0);
  await sales.context().close();
  // Bu testin profil siparişleri sonraki testleri etkilemesin (silinmiş sayılır — kayıt durur)
  await db.order.updateMany({ where: { id: { in: made } }, data: { removedAt: new Date() } });
  await db.$disconnect();
});

test('"Sıra bende": yöneticide yalnızca dört tablo — yeni siparişler, teklif hazırlanacaklar, SLA riski / gecikenler, profil fiyat bekleyenler; satışınki değişmedi', async ({ browser }) => {
  const titles = async (page: Page) => (await page.locator('main .card-flush > .card-head h2').allInnerTexts()).map((s) => s.replace(/\s*\d+$/, '').trim());
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/siparisler');
  expect(await titles(admin)).toEqual(['Yeni siparişler — karar bekliyor', 'Teklif hazırlanacaklar', 'SLA riski / gecikenler', 'Profil — fiyat bekleyenler']);
  // Profil siparişleri sekmesi; Çizim Paneli değişmedi
  await expect(admin.locator('.tabs [data-tab=profil]')).toHaveText('Profil siparişleri');
  await admin.goto('/siparisler?panel=cizim');
  expect(await titles(admin)).toEqual(expect.arrayContaining(['Müşteriden onaylı çizimler']));
  await admin.context().close();
  const sales = await as(browser, SALES2, TEAM_PW);
  await sales.goto('/siparisler');
  expect(await titles(sales)).toEqual(['Yeni siparişler — karar bekliyor', 'SLA riski / gecikenler']);
  await sales.context().close();
});

test('yöneticinin e-postaları: yeni sipariş; satış fabrika fiyatını değiştirince bir kez (geri alıp aynı fiyatla yeniden gönderince yok); geri alma; zil ve bekleyen kuyruk güncel', async ({ browser }) => {
  const db = await prisma();
  const { translate } = await import('../server/i18n/index.js');
  const adminUser = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const L = adminUser.language === 'tr' ? 'tr' : 'ro';
  const subj = (orderNo: string, key: string) => `${orderNo} — ${translate(L, key)}`;
  const count = (subject: string) => mailsTo(ADMIN).filter((m) => m.subject === subject).length;
  worker(); // e-posta gönderiminin başlangıç anı ve önceki olaylar (bu testin olaylarından önce)

  // A — müşterinin yeni siparişi (fiyat tablosundaki cam: liste 30,00 — 08-fiyat)
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await cust.fill('#title', 'Yönetici e-postası');
  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: '10 MM TEMPER CAM — BRONZ' });
  await cust.setInputFiles('#files', sampleFile('yonetici-eposta.pdf', 'yonetici e-postasi'));
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/);
  const orderId = /\/siparisler\/([a-z0-9]+)/.exec(cust.url())![1];
  await cust.context().close();
  const { orderNo } = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { orderNo: true } });
  worker();
  const created = mailsTo(ADMIN).filter((m) => m.subject === subj(orderNo, 'notify.newOrder'));
  expect(created).toHaveLength(1);
  expect(created[0].text).toContain(`/siparisler/${orderId}`);
  expect(created[0].html).toContain('cid:gkh-logo@takip');

  // B — satış liste fiyatını değiştirip yöneticiye gönderir
  const sales = await as(browser, SALES2, TEAM_PW);
  await sales.goto(`/siparisler/${orderId}`);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.getByLabel('Birim fiyat').first()).toHaveValue('30.00');
  await sales.getByLabel('En', { exact: true }).first().fill('1000');
  await sales.getByLabel('Boy', { exact: true }).first().fill('1000');
  await sales.getByLabel('Birim fiyat').first().fill('28');
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  worker();
  const override = subj(orderNo, 'notify.admin.priceOverride');
  expect(count(override)).toBe(1);
  expect(mailsTo(ADMIN).find((m) => m.subject === override)!.text).not.toMatch(/28[.,]00|30[.,]00/);

  // C — satış geri alır: yöneticiye e-posta; zildeki "yöneticiye gönderildi" okunmuş sayılır; bekleyen kuyruktan çıkar
  await sales.getByRole('button', { name: 'Yöneticiye göndermeyi geri al', exact: true }).click();
  await expect(sales.getByText('Teklif yöneticiden geri alındı; düzenleyip yeniden gönderebilirsiniz.')).toBeVisible();
  const unread = (type: string) => db.notification.count({ where: { userId: adminUser.id, orderId, type, isRead: false } });
  expect([await unread('ORDER_OFFER_SUBMITTED'), await unread('ORDER_OFFER_WITHDRAWN')]).toEqual([0, 1]);
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/teklifler');
  await expect(admin.locator('[data-group=YONETIMDE]')).not.toContainText(orderNo);
  // Aynı fiyatla yeniden gönderim: yeni "fabrika fiyatı" e-postası yok; teklif yeniden yöneticinin kuyruğunda, zilde yeni bildirim
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  await sales.context().close();
  worker();
  worker(); // yeniden işleme kopya üretmez
  expect(count(override), 'aynı fiyat yeniden gönderildi: ikinci e-posta yok').toBe(1);
  expect(count(subj(orderNo, 'events.OFFER_WITHDRAWN.label'))).toBe(1);
  expect(count(subj(orderNo, 'notify.newOrder'))).toBe(1);
  expect([await unread('ORDER_OFFER_SUBMITTED'), await unread('ORDER_OFFER_WITHDRAWN')]).toEqual([1, 1]);
  await admin.goto('/teklifler');
  await expect(admin.locator('[data-group=YONETIMDE]')).toContainText(orderNo);
  await admin.context().close();
  await db.$disconnect();
});

test('şifre sıfırlama: yönetici başlatır, kod kullanıcıya gider — yöneticiye e-posta yok', async ({ browser }) => {
  const email = 'sifre-sifirlama@e2e.test';
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await createUser(admin, { email, name: 'Sıfırlanacak Satışçı', role: 'Satış', firm: 'GKH Trading' });
  const ctx = await browser.newContext();
  await firstLogin(await ctx.newPage(), email, outboxCodeFor(email), TEAM_PW);
  await ctx.close();
  const adminMails = mailsTo(ADMIN).length;
  const userMails = mailsTo(email).length;
  await admin.goto('/admin/users');
  await admin.locator('tr', { hasText: email }).getByRole('button', { name: 'Şifreyi sıfırla' }).click();
  await expect(admin.getByText(`${email} şifresi sıfırlandı ve yeni kod gönderildi.`)).toBeVisible();
  expect(mailsTo(email).length, 'kullanıcıya yeni kod').toBe(userMails + 1);
  expect(mailsTo(ADMIN).length, 'yöneticiye e-posta yok').toBe(adminMails);
  await admin.context().close();
});
