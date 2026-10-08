import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as, newOrder, sampleFile, sendDrawing, uploadDrawing } from './helpers';
import { FONTS } from '../server/pdf/fonts.js';

// Fonksiyonel paket 2 — müşteri paneli (karar 160–166), gerçek sunucuda:
//  - "Tekliflerim" (müşteri ana sayfası): tarih aralığı; yalnızca kendi firmasının cam teklifleri (son gönderilen sürüm),
//    iptal ve aralık dışı yok; liste ve PDF aynı toplamlar; PDF her teklifi ayrı gösterir, sonda toplam m² ve tutar;
//    dosya adı panel dilinde; satış (fabrika) fiyatı hiçbir yerde yok; iç ekip ve başka firma dökümü alamaz
//  - yeni çizim: bildirim zili + bağlantı siparişteki kırmızı bilgilendirmeye; ana işlem "Aç ve incele"; revizyon notu
//    numaralı maddeler; not BİR KEZ çevrilip saklanır (iç ekip görür, müşteri ve denetimci görmez); sayfa yenilemesi
//    yeni çeviri / yeni bildirim / yeni e-posta işi üretmez; iç olaylar müşteriye bildirilmez
// Google'a GERÇEK istek gitmez: sunucu TRANSLATE_FAKE=1 ile sahte sağlayıcıyı kullanır (çeviri "[tr] metin"); ilk test
// bunu ekrandaki "TEST MODU" uyarısıyla doğrular. FGO / ANAF'a hiçbir çağrı yapılmaz.
test.describe.configure({ mode: 'serial' });

const BETA = 'beta@betacam.test';
const INSPECTOR = 'denetim@e2e.test';
const SALES = 'fiyat-satis@e2e.test';
const FAKE_KEY = 'e2e-sahte-anahtar-0123456789abcdef';
// Satış (fabrika) fiyatları — müşteri ekranında / PDF'te HİÇ geçmemeli
const SALES_PRICES = ['37,13', '25,37', '9,11', '37.13', '25.37', '9.11'];
let revOrderId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const romanian = (page: Page) => page.context().addCookies([{ name: 'takip_lang', value: 'ro', url: new URL(page.url()).origin }]);

/** PDF'teki metin satırları (gömülü yazı tipinin glif → Unicode eşlemesiyle; server/pdf/pdf.js biçimi) */
const REVERSE = Object.fromEntries((['Regular', 'Bold'] as const).map((k) => [k, new Map((FONTS[k].map as number[][]).map(([cp, gid]) => [gid, cp]))]));
function pdfLines(pdf: Buffer): string[] {
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
  return out;
}

test('veri: not çevirisi açık (sahte sağlayıcı — test modu); iki firmanın ocak 2026 teklifleri (biri iki sürümlü, biri iptal, biri aralık dışı)', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/entegrasyonlar');
  const card = admin.locator('form#ceviri');
  await expect(card.locator('.alert-warn')).toContainText('TEST MODU'); // yoksa dosya burada durur: gerçek Google'a gidilmez
  await card.locator('input[name=enabled]').check();
  await card.locator('input[name=apiKey]').fill(FAKE_KEY);
  await card.getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin).toHaveURL(/ok=translate/);
  await admin.context().close();

  const db = await prisma();
  try {
    const adminUser = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const uns = (await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } })).customer!;
    const beta = (await db.user.findUniqueOrThrow({ where: { email: BETA }, include: { customer: true } })).customer!;
    const line = (o: object) => ({ sortOrder: 0, kind: 'CAM', unit: 'm2', descriptionRo: null, ...o });
    const offer = (sentAt: string, lines: object[], extra: object = {}) => ({
      status: 'GONDERILDI' as const, currency: 'EUR', amount: '0', offerAmount: '0', createdById: adminUser.id, sentAt: new Date(sentAt), createdAt: new Date(sentAt),
      lines: { create: lines }, ...extra,
    });
    const order = (firm: { id: string; prefix: string | null }, no: number, title: string, offers: object[], extra: object = {}) => db.order.create({
      data: { orderNo: `${firm.prefix}${no}`, customerOrderNo: no, title, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: adminUser.id, status: 'URETIMDE', offers: { create: offers }, ...extra },
    });
    // UNS9601: 1000 × 2000 × 3 = 6 m² × 41,50 = 249,00 (satış fiyatı 37,13 — müşteriye gitmez)
    await order(uns, 9601, 'Rapor duș cabină', [offer('2026-01-10T10:00:00Z', [line({ description: 'Securizat 8mm', enMm: 1000, boyMm: 2000, adet: 3, unitPrice: '37.13', offerPrice: '41.50' })])]);
    // UNS9602: v1 aralık dışı (aralık 2025), v2 20.01: 500 × 1000 × 4 = 2 m² × 30 = 60 + CNC 2 × 15 = 30 → 90,00
    await order(uns, 9602, 'Rapor balustradă', [
      offer('2025-12-20T10:00:00Z', [line({ description: 'Eski sürüm', enMm: 1000, boyMm: 1000, adet: 9, unitPrice: '9.11', offerPrice: '99' })]),
      offer('2026-01-20T10:00:00Z', [
        line({ description: 'Temper ğüşöç', enMm: 500, boyMm: 1000, adet: 4, unitPrice: '25.37', offerPrice: '30' }),
        line({ sortOrder: 1, kind: 'CNC', unit: 'adet', description: 'CNC', adet: 2, unitPrice: '9.11', offerPrice: '15' }),
      ]),
    ]);
    await order(uns, 9603, 'Rapor iptal', [offer('2026-01-15T10:00:00Z', [line({ description: 'İptal', enMm: 1000, boyMm: 1000, adet: 1, unitPrice: '1', offerPrice: '500' })])], { status: 'IPTAL' });
    await order(uns, 9604, 'Rapor şubat', [offer('2026-02-05T10:00:00Z', [line({ description: 'Şubat', enMm: 1000, boyMm: 1000, adet: 1, unitPrice: '1', offerPrice: '700' })])]);
    await order(beta, 9605, 'Beta raporu', [offer('2026-01-12T10:00:00Z', [line({ description: 'Beta cam', enMm: 1000, boyMm: 1000, adet: 1, unitPrice: '1', offerPrice: '800' })])]);
  } finally {
    await db.$disconnect();
  }
});

test('Tekliflerim: ana sayfanın üstünde tarih aralığı; yalnızca kendi firmasının son teklifleri; liste ve PDF toplamları aynı; satış fiyatı yok; dosya adı panel dilinde', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto('/siparisler');
  const card = cust.locator('#tekliflerim');
  await expect(card.locator('h2')).toHaveText('Tekliflerim');
  // Ana sayfanın üst bölümü: özet kutularından ve sipariş listesinden önce
  const order = await cust.locator('main').evaluate((m) => [...m.querySelectorAll('#tekliflerim, .stats')].map((e) => (e.id ? e.id : 'stats')));
  expect(order[0]).toBe('tekliflerim');
  await card.getByLabel('Başlangıç tarihi').fill('2026-01-01');
  await card.getByLabel('Bitiş tarihi').fill('2026-01-31');
  await card.getByRole('button', { name: 'Göster' }).click();
  await expect(cust).toHaveURL(/bas=2026-01-01&bit=2026-01-31/);
  const rows = cust.locator('#tekliflerim tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('UNS9601');
  await expect(rows.nth(0)).toContainText('10.01.2026');
  await expect(rows.nth(0)).toContainText('249,00 EUR');
  await expect(rows.nth(1)).toContainText('UNS9602');
  await expect(rows.nth(1).locator('.badge')).toHaveText('v2');
  await expect(rows.nth(1)).toContainText('90,00 EUR');
  await expect(cust.locator('#tekliflerim tfoot')).toContainText('2 teklif');
  await expect(cust.locator('#tekliflerim tfoot')).toContainText('339,00 EUR');
  await expect(cust.locator('#tekliflerim tfoot td.num').first()).toHaveText('8,00');
  for (const absent of ['UNS9603', 'UNS9604', 'BET9605', '500,00', '700,00', '800,00', '99,00']) await expect(card).not.toContainText(absent);
  // Satış fiyatı sayfanın ham yanıtında (HTML + RSC) da yok
  const raw = await (await cust.request.get('/siparisler?bas=2026-01-01&bit=2026-01-31')).text();
  for (const p of SALES_PRICES) expect(raw.includes(p), `sayfada satış fiyatı: ${p}`).toBe(false);
  for (const o of ['BET9605', 'Beta raporu']) expect(raw.includes(o)).toBe(false);

  // PDF: aynı aralık, aynı toplamlar; her teklif ayrı; dosya adı Türkçe
  const [download] = await Promise.all([cust.waitForEvent('download'), card.getByRole('button', { name: 'PDF indir' }).click()]);
  expect(download.suggestedFilename()).toBe('tekliflerim-2026-01-01_2026-01-31.pdf');
  const pdf = fs.readFileSync((await download.path())!);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  const lines = pdfLines(pdf);
  const has = (s: string) => lines.some((l) => l.includes(s));
  for (const s of ['TEKLİFLERİM', 'Ünsal Cam', 'UNS9601 — Rapor duș cabină', 'UNS9602 — Rapor balustradă', 'sürüm 2', 'Temper ğüşöç', '249,00 EUR', '90,00 EUR', 'Genel toplam', '2 teklif', '339,00 EUR', '8 m²']) {
    expect(has(s), `PDF'te yok: ${s} — ${lines.join(' | ')}`).toBe(true);
  }
  for (const s of ['UNS9603', 'UNS9604', 'BET9605', 'Eski sürüm', ...SALES_PRICES]) expect(has(s), `PDF'te olmamalı: ${s}`).toBe(false);
  expect(lines.some((l) => l.includes('?')), 'yazı tipinde olmayan karakter yok').toBe(false);
  // GKH logosu (ortak marka görseli) gömülü
  expect(pdf.toString('latin1')).toMatch(/\/Subtype \/Image /);

  // Hatalı aralık: sayfada anlaşılır ileti, PDF adresi 400
  await cust.goto('/siparisler?bas=2026-02-01&bit=2026-01-01');
  await expect(cust.locator('#tekliflerim .alert-error')).toHaveText('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
  expect((await cust.request.get('/teklifler/pdf?bas=2026-02-01&bit=2026-01-01')).status()).toBe(400);

  // Romence panel: başlık ve dosya adı Romence; PDF Romence
  await romanian(cust);
  await cust.goto('/siparisler?bas=2026-01-01&bit=2026-01-31');
  await expect(cust.locator('#tekliflerim h2')).toHaveText('Ofertele mele');
  const [ro] = await Promise.all([cust.waitForEvent('download'), cust.locator('#tekliflerim').getByRole('button', { name: 'Descarcă PDF' }).click()]);
  expect(ro.suggestedFilename()).toBe('ofertele-mele-2026-01-01_2026-01-31.pdf');
  const roLines = pdfLines(fs.readFileSync((await ro.path())!));
  for (const s of ['OFERTELE MELE', 'Total general', 'Oferte: 2', 'Data ofertei: 20.01.2026', '339,00 EUR']) expect(roLines.some((l) => l.includes(s)), `RO PDF'te yok: ${s}`).toBe(true);
  await cust.context().close();

  // Başka firma: kendi dökümü yalnızca kendi teklifleri (Ünsal'ın teklifleri yok)
  const beta = await as(browser, BETA, TEAM_PW);
  const res = await beta.request.get('/teklifler/pdf?bas=2026-01-01&bit=2026-01-31');
  expect(res.status()).toBe(200);
  const betaLines = pdfLines(Buffer.from(await res.body()));
  expect(betaLines.some((l) => l.includes('BET9605'))).toBe(true);
  expect(betaLines.some((l) => /UNS96/.test(l))).toBe(false);
  await beta.goto('/siparisler?bas=2026-01-01&bit=2026-01-31');
  await expect(beta.locator('#tekliflerim')).not.toContainText('UNS96');
  await beta.context().close();

  // İç ekip ve denetimci: döküm yok (kart da yok)
  for (const [email, pw] of [[ADMIN, ADMIN_PW], [SALES, TEAM_PW], [INSPECTOR, INSPECTOR_PW]] as const) {
    const p = await as(browser, email, pw);
    expect((await p.request.get('/teklifler/pdf?bas=2026-01-01&bit=2026-01-31')).status(), email).toBe(404);
    await p.goto('/siparisler');
    await expect(p.locator('#tekliflerim')).toHaveCount(0);
    await p.context().close();
  }
});

test('yeni çizim: bildirim zili → siparişteki kırmızı bilgilendirme; ana işlem "Aç ve incele"; numaralı revizyon notu bir kez çevrilip saklanır; yenileme yeni çeviri / bildirim / e-posta işi üretmez', async ({ browser }) => {
  test.setTimeout(180_000);
  // Sipariş: müşteri formu (cam adedi yok) → yönetici çizime gönderir → çizimci yükler ve gönderir
  const cust = await as(browser, CUSTOMER, CUST_PW);
  revOrderId = await newOrder(cust, 'Paket 2 çizim', 'paket2.pdf');
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${revOrderId}`);
  await admin.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(admin.getByText('Sipariş çizim ekibine yönlendirildi.')).toBeVisible();
  const drawer = await as(browser, DRAWER, TEAM_PW);
  await drawer.goto(`/siparisler/${revOrderId}`);
  await uploadDrawing(drawer, [sampleFile('paket2-plan.pdf', 'plan v1')]);
  await sendDrawing(drawer, revOrderId);
  // İşçi bir tur: uygulama içi bildirimler dağıtılır (e-posta klasöre yazılır; gerçek gönderim yok)
  execFileSync('node', ['scripts/worker.mjs', '--once'], { env: process.env, stdio: 'inherit' });

  // Bildirim zili: "Çizim onayınıza sunuldu" — bağlantı siparişteki kırmızı bilgilendirmeye
  await cust.goto('/siparisler');
  // Zil istemci bileşenidir: sayfa etkileşime hazır olana kadar tıklama yinelenir
  await expect(async () => {
    await cust.locator('.notif-bell').click();
    await expect(cust.locator('.notif-panel')).toBeVisible({ timeout: 1000 });
  }).toPass();
  const item = cust.locator(`.notif-panel a.notif-main[href="/siparisler/${revOrderId}#cizim-onay"]`);
  await expect(item).toHaveCount(1);
  await expect(item.locator('.notif-title')).toHaveText('Çizim onayınıza sunuldu');
  await item.click();
  await expect(cust).toHaveURL(new RegExp(`/siparisler/${revOrderId}#cizim-onay$`));
  const alert = cust.locator('#cizim-onay');
  await expect(alert).toHaveClass(/alert-error/);
  await expect(alert).toContainText('Yeni çizim onayınızı bekliyor (v1).');
  // Ana işlem "Aç ve incele" (mavi); onay ve revizyon ikincil
  await expect(cust.locator('.card.turn a.btn-primary')).toHaveText('Aç ve incele');
  await alert.getByRole('link', { name: 'Aç ve incele' }).click();
  await expect(cust.locator('.viewer-side')).toHaveCount(0); // boş "İşaretler" bölümü yok
  await cust.locator('.viewer-decide').getByRole('link', { name: 'Revizyon iste' }).click();
  await expect(cust.getByRole('button', { name: 'İğne' })).toHaveCount(0);
  const submit = cust.getByRole('button', { name: 'Revizyon iste' });
  await expect(submit).toBeDisabled();
  await expect(async () => {
    await cust.getByLabel('Madde 1', { exact: true }).fill('Margine 5 mm mai îngustă');
    await expect(submit).toBeEnabled({ timeout: 1000 });
  }).toPass();
  await cust.getByRole('button', { name: '+ Madde ekle' }).click();
  await cust.getByLabel('Madde 2', { exact: true }).fill('Gaura Ø12 la dreapta');
  await submit.click();
  await expect(cust.getByText('Revizyon talebiniz çizim ekibine iletildi.')).toBeVisible();

  const db = await prisma();
  try {
    const rev = await db.drawingRevision.findFirstOrThrow({ where: { drawing: { orderId: revOrderId } } });
    // Numaralı not; BİR KEZ çevrildi ve saklandı (sahte sağlayıcı: "[tr] metin")
    expect([rev.comment, rev.translationStatus, rev.translationLang]).toEqual(['1. Margine 5 mm mai îngustă\n2. Gaura Ø12 la dreapta', 'DONE', 'tr']);
    expect(rev.translation).toBe(`[tr] ${rev.comment}`);
    const outbox = await db.notificationOutbox.count({ where: { orderId: revOrderId } });
    const notes = await db.notification.count({ where: { orderId: revOrderId } });

    // İç ekip: özgün numaralı not + Türkçe çeviri (etiket çevirinin dilinde); müşteri ve denetimci yalnızca özgün not
    await admin.goto(`/siparisler/${revOrderId}`);
    const request = (p: Page) => p.locator('#cizim .note', { hasText: 'Revizyon talebi:' }).first();
    await expect(request(admin).locator('ol.revision-list li').first()).toHaveText('Margine 5 mm mai îngustă');
    await expect(request(admin).locator('.note-translation')).toContainText('Türkçe · otomatik çevrilmiştir');
    await expect(request(admin).locator('.note-translation')).toContainText('[tr] 1. Margine 5 mm mai îngustă');
    await cust.goto(`/siparisler/${revOrderId}`);
    await expect(request(cust).locator('ol.revision-list li')).toHaveText(['Margine 5 mm mai îngustă', 'Gaura Ø12 la dreapta']);
    await expect(request(cust).locator('.note-translation')).toHaveCount(0);
    const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
    await insp.goto(`/siparisler/${revOrderId}`);
    await expect(request(insp).locator('ol.revision-list li')).toHaveCount(2);
    await expect(request(insp).locator('.note-translation')).toHaveCount(0);
    // Yenileme / otomatik yenileme / bildirim yoklaması: çeviri, bildirim ve e-posta işi değişmez
    for (const p of [admin, cust, drawer, insp]) {
      for (let i = 0; i < 2; i++) {
        await p.goto(`/siparisler/${revOrderId}`);
        await p.request.get('/bildirimler/akis');
      }
    }
    const again = await db.drawingRevision.findUniqueOrThrow({ where: { id: rev.id } });
    expect([again.translation, again.translationStatus, again.translationAt?.getTime()]).toEqual([rev.translation, 'DONE', rev.translationAt?.getTime()]);
    expect(await db.notificationOutbox.count({ where: { orderId: revOrderId } })).toBe(outbox);
    expect(await db.notification.count({ where: { orderId: revOrderId } })).toBe(notes);
    // İç olaylar (revizyon talebi, çizime gönderme, yeni sipariş) müşteri kullanıcılarına bildirilmez
    execFileSync('node', ['scripts/worker.mjs', '--once'], { env: process.env, stdio: 'inherit' });
    const customerUsers = (await db.user.findMany({ where: { appRole: 'MUSTERI' }, select: { id: true } })).map((u) => u.id);
    const types = (await db.notification.findMany({ where: { orderId: revOrderId, userId: { in: customerUsers } }, select: { type: true } })).map((n) => n.type);
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) expect(['ORDER_DRAWING_UPLOADED', 'ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED', 'ORDER_SHIP_DATE', 'ORDER_SHIPPED'], t).toContain(t);
    await insp.context().close();
  } finally {
    await db.$disconnect();
  }
  for (const p of [cust, admin, drawer]) await p.context().close();
});
