import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, INSPECTOR_PW, TEAM_PW, as } from './helpers';

// Sipariş notlarının otomatik çevirisi (karar 127) — tarayıcıda.
//  - Yönetici → Entegrasyonlar → "Not çevirisi": aç / kapat, anahtar (yalnızca "kayıtlı" görünür), bağlantı denemesi
//  - müşteri Romence yazar → yönetici ve satış özgün notu + "Türkçe · otomatik çevrilmiştir" çevirisini görür
//  - iç ekip Türkçe yazar → müşteri özgün notu + "Română · tradus automat" çevirisini görür
//  - iç not müşteriye görünmez ve çevrilmez; başka firmanın müşterisi hiçbir şey görmez
//  - çeviri yapılamazsa not yine kaydedilir; sayfa yenilenince çeviri yeniden yapılmaz
//  - denetimci (karar 128) notları yalnızca ÖZGÜN dilinde görür: çeviri, çeviri hatası ve "yeniden dene" ona gitmez
//  - sayfa açılışı, yenileme, 60 saniyelik otomatik yenileme, bildirim yoklaması ve işçi çeviri isteği YAPMAZ
//  - bütün e-postalar ortak GKH başlığıyla (gömülü logo) yazılır (karar 129) — e-posta gönderilmez, klasöre yazılır
// Google'a GERÇEK istek gitmez: sunucu TRANSLATE_FAKE=1 ile sahte sağlayıcıyı kullanır (ağa çıkmaz; çeviri "[tr] metin").
// İlk test bunu ekrandaki "TEST MODU" uyarısıyla doğrular — uyarı yoksa hiçbir not yazılmadan dosya durur.
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test';
const BETA = 'beta@betacam.test';
const INSPECTOR = 'denetim@e2e.test';
const SETTINGS = '/admin/entegrasyonlar';
// Gerçek bir anahtar DEĞİL: yalnızca biçimi geçerli sahte değer (sahte sağlayıcı anahtarı kullanmaz)
const FAKE_KEY = 'e2e-sahte-anahtar-0123456789abcdef';
const RO_NOTE = 'Vă rog să modificați dimensiunea la 1200 mm.';
const TR_NOTE = 'Ölçüyü güncelledik, yeni teklif yarın hazır.';
const INTERNAL_NOTE = 'İç bilgi: müşteriye yüzde yedi indirim yapılabilir';
const FAIL_NOTE = 'Mulțumesc, aștept confirmarea #çeviri-hata';
let orderId = '';
let orderUrl = '';

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
/** Not yazar (sipariş sayfasındaki mevcut form) */
async function writeNote(page: Page, text: string, internal = false) {
  await page.goto(orderUrl);
  await page.locator('#notlar textarea[name=text]').fill(text);
  if (internal) await page.locator('#notlar input[name=internal]').check();
  await page.locator('#notlar form', { has: page.locator('textarea[name=text]') }).getByRole('button').click();
  await expect(page).toHaveURL(/ok=note_added/);
}
const noteOf = (page: Page, text: string) => page.locator('#notlar .note', { hasText: text });
type Settings = { enabled?: boolean; keySealed?: string | null } | null;

test('ayar: Yönetici → Entegrasyonlar → "Not çevirisi" — sahte sağlayıcı (test modu), anahtar yalnızca "kayıtlı" görünür, bağlantı denemesi, yalnızca yönetici', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  const db = await prisma();
  const setting = async () => ((await db.integrationSetting.findUnique({ where: { key: 'translate' } }))?.value ?? null) as Settings;
  await page.goto(SETTINGS);
  const card = page.locator('form#ceviri');
  await expect(card.locator('h2')).toHaveText('Not çevirisi');
  // Ağ güvencesi: sunucu sahte sağlayıcıyla çalışıyor (Google'a istek gitmez). Bu uyarı yoksa test burada durur.
  await expect(card.locator('.alert-warn')).toContainText('TEST MODU');
  await expect(card.locator('input[name=enabled]')).not.toBeChecked();
  await expect(card).toContainText('Kapalı: notlar çevrilmez');
  await expect(page.locator('#ceviri-dene button')).toBeDisabled(); // anahtar yokken denenemez
  expect(await setting(), 'başlangıçta ayar yok').toBeNull();

  // Anahtarsız açılamaz; biçimi bozuk anahtar reddedilir
  await card.locator('input[name=enabled]').check();
  await card.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page).toHaveURL(/error=translate/);
  await expect(page.locator('.alert-error', { hasText: 'önce Google anahtarını girin' })).toBeVisible();
  await card.locator('input[name=apiKey]').fill('kisa');
  await card.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.locator('.alert-error', { hasText: 'Anahtar geçersiz görünüyor' })).toBeVisible();
  expect(await setting()).toBeNull();

  // Anahtar + aç: kaydedilir; anahtar sayfaya bir daha GELMEZ (ne alanda ne HTML'de), veritabanında şifrelidir
  await card.locator('input[name=enabled]').check();
  await card.locator('input[name=apiKey]').fill(FAKE_KEY);
  await card.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page).toHaveURL(/ok=translate/);
  await expect(page.locator('.alert-ok', { hasText: 'Not çevirisi ayarı kaydedildi.' })).toBeVisible();
  await page.goto(SETTINGS);
  await expect(card.locator('input[name=enabled]')).toBeChecked();
  await expect(card.locator('input[name=apiKey]')).toHaveValue('');
  await expect(card.locator('input[name=apiKey]')).toHaveAttribute('type', 'password');
  await expect(card.locator('input[name=apiKey]')).toHaveAttribute('placeholder', /kayıtlı/);
  await expect(card).toContainText('Açık: müşteriye açık her yeni not yazılırken çevrilir.');
  const html = await (await page.request.get(SETTINGS)).text();
  expect(html, 'anahtar yanıtta yok').not.toContain(FAKE_KEY);
  const saved = await setting();
  expect(saved?.enabled).toBe(true);
  expect(String(saved?.keySealed)).toMatch(/^v1:/);
  expect(JSON.stringify(saved), 'anahtar veritabanında açık değil').not.toContain(FAKE_KEY);
  expect(html, 'şifreli anahtar da yanıtta yok').not.toContain(String(saved?.keySealed));
  await shot(page, 'not-cevirisi-ayar');

  // Bağlantıyı dene: zararsız ifade çevrilir (sahte sağlayıcı), hiçbir not yazılmaz
  const notes = await db.orderNote.count();
  await page.locator('#ceviri-dene button').click();
  await expect(page).toHaveURL(/ok=translateTest/);
  await expect(page.locator('.alert-ok', { hasText: 'Google çeviri bağlantısı çalışıyor' })).toContainText('[tr] Bună ziua');
  expect(await db.orderNote.count()).toBe(notes);

  // Yetki sunucuda: satış ayarı değiştiremez, bağlantıyı deneyemez (taklit istek)
  const saveField = await actionField(page, SETTINGS, 'id="ceviri"');
  const testField = await actionField(page, SETTINGS, 'id="ceviri-dene"');
  const sales = await as(browser, SALES, TEAM_PW);
  const before = JSON.stringify(await setting());
  const audits = () => db.auditLog.count({ where: { entityType: 'IntegrationSetting', entityId: 'translate' } });
  const auditsBefore = await audits();
  for (const [field, data] of [[saveField, { apiKey: 'baska-bir-anahtar-0123456789abcdef' }], [saveField, { clearKey: 'on' }], [testField, {}]] as const) {
    const r = await forge(sales, SETTINGS, field, data);
    expect(r.url(), 'satış: taklit istek').toMatch(/\/siparisler$/);
  }
  expect(JSON.stringify(await setting())).toBe(before);
  expect(await audits(), 'yetkisiz istek ayar / deneme kaydı üretmedi').toBe(auditsBefore);
  expect((await (await sales.request.get(SETTINGS)).text()), 'satış ayar sayfasını göremez').not.toContain('id="ceviri"');
  await sales.context().close();
  // Denetim kaydında anahtar yok
  const log = JSON.stringify(await db.auditLog.findMany({ where: { entityType: 'IntegrationSetting', entityId: 'translate' } }));
  expect(log).not.toContain(FAKE_KEY);
  expect(log).not.toContain('v1:');
  await db.$disconnect();
  await page.context().close();
});

test('veri: müşterinin siparişi (not akışı için)', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  const o = await db.order.create({
    data: {
      orderNo: `${cust.customer!.prefix}9701`, customerOrderNo: 9701, title: 'Not çevirisi e2e', orderTypeCode: 'GLASS_ORDER', customerId: cust.customerId!, createdById: cust.id, status: 'URETIMDE',
      estimatedShipDate: new Date(Date.now() + 30 * 86_400_000),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '37', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
  orderId = o.id;
  orderUrl = `/siparisler/${o.id}`;
  await db.$disconnect();
});

test('müşteri Romence yazar → yönetici ve satış özgün notu + Türkçe çeviriyi görür; çeviri saklanır, sayfa yenilenince yeniden yapılmaz', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await writeNote(cust, RO_NOTE);
  // Müşteri kendi notunu yazdığı gibi görür (kendi notunun Türkçesi ona gösterilmez)
  await expect(noteOf(cust, RO_NOTE).locator('.note-text')).toHaveText(RO_NOTE);
  await expect(noteOf(cust, RO_NOTE).locator('.note-translation')).toHaveCount(0);
  expect(await (await cust.request.get(orderUrl)).text(), 'Türkçe çeviri müşteriye gönderilmez').not.toContain(`[tr] ${RO_NOTE}`);

  const db = await prisma();
  const row = await db.orderNote.findFirstOrThrow({ where: { orderId, text: RO_NOTE } });
  expect([row.text, row.internal, row.translation, row.translationLang, row.translationStatus, row.translationError]).toEqual([RO_NOTE, false, `[tr] ${RO_NOTE}`, 'tr', 'DONE', null]);

  // Yönetici ve satış: özgün Romence not + hemen altında "Türkçe · otomatik çevrilmiştir" ile Türkçesi
  for (const [who, email, pw] of [['yönetici', ADMIN, ADMIN_PW], ['satış', SALES, TEAM_PW]] as const) {
    const p = await as(browser, email, pw);
    await p.goto(orderUrl);
    const n = noteOf(p, RO_NOTE).first();
    await expect(n.locator('.note-label').first(), who).toHaveText('Özgün mesaj');
    await expect(n.locator('.note-text'), who).toHaveText(RO_NOTE);
    const tr = n.locator('.note-translation');
    await expect(tr, who).toHaveAttribute('lang', 'tr');
    await expect(tr.locator('.note-label'), who).toHaveText('Türkçe · otomatik çevrilmiştir');
    await expect(tr.locator('.pre'), who).toHaveText(`[tr] ${RO_NOTE}`);
    await expect(n.locator('[data-translation-failed]'), who).toHaveCount(0);
    if (who === 'yönetici') {
      await shot(p, 'not-cevirisi-ic-ekip');
      // Yenileme çeviri yapmaz: kayıt (çeviri zamanı dahil) aynen durur
      for (let i = 0; i < 3; i++) await p.reload();
      await expect(noteOf(p, RO_NOTE).first().locator('.note-translation .pre')).toHaveText(`[tr] ${RO_NOTE}`);
    }
    await p.context().close();
  }
  // Denetimci: notu görür (mevcut yetkisi) ama yalnızca özgün Romence metni; Türkçe çeviri ekranda da yanıtta da yok
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(orderUrl);
  const own = noteOf(insp, RO_NOTE).first();
  await expect(own.locator('.note-text')).toHaveText(RO_NOTE);
  await expect(own.locator('.note-translation')).toHaveCount(0);
  await expect(own.locator('.note-label')).toHaveCount(0);
  await expect(insp.locator('#notlar form')).toHaveCount(0); // denetimci not yazamaz, "yeniden dene" de yok
  const inspBody = await (await insp.request.get(orderUrl)).text();
  expect(inspBody).toContain(RO_NOTE);
  for (const s of [`[tr] ${RO_NOTE}`, 'otomatik çevrilmiştir', 'Özgün mesaj']) expect(inspBody, `denetimci yanıtında yok: ${s}`).not.toContain(s);
  await shot(insp, 'not-cevirisi-denetimci');
  await insp.context().close();
  for (let i = 0; i < 2; i++) await cust.reload();
  const again = await db.orderNote.findUniqueOrThrow({ where: { id: row.id } });
  expect(JSON.stringify(again), 'sayfa açılışı / yenileme kaydı değiştirmez (yeniden çeviri yok)').toBe(JSON.stringify(row));
  expect(await db.orderNote.count({ where: { orderId } })).toBe(1);
  await db.$disconnect();
  await cust.context().close();
});

test('iç ekip Türkçe yazar → müşteri özgün notu + Romence çeviriyi görür; iç ekip ve denetimci yalnızca özgün Türkçe notu görür; iç not müşteriye görünmez ve çevrilmez; başka firma hiçbir şey görmez', async ({ browser }) => {
  const sales = await as(browser, SALES, TEAM_PW);
  await writeNote(sales, TR_NOTE);
  await writeNote(sales, INTERNAL_NOTE, true);
  // Satış kendi notunu yalnızca ÖZGÜN Türkçe hâliyle görür (karar 130): Romence çeviri müşteri içindir — ekranda da
  // sunucunun yanıtında da yoktur ("Özgün mesaj" etiketi de çizilmez: gösterilecek çeviri yok). İç notta çeviri yoktur.
  const mine = noteOf(sales, TR_NOTE).first();
  await expect(mine.locator('.note-text')).toHaveText(TR_NOTE);
  await expect(mine.locator('.note-translation')).toHaveCount(0);
  await expect(mine.locator('.note-label')).toHaveCount(0);
  await expect(mine.locator('[data-translation-failed]')).toHaveCount(0);
  const salesBody = await (await sales.request.get(orderUrl)).text();
  for (const s of [`[ro] ${TR_NOTE}`, 'tradus automat']) expect(salesBody, `satış yanıtında yok: ${s}`).not.toContain(s);
  await shot(sales, 'not-cevirisi-ic-ekip-kendi-notu');
  await expect(noteOf(sales, INTERNAL_NOTE)).toHaveClass(/internal/);
  await expect(noteOf(sales, INTERNAL_NOTE).locator('.note-translation')).toHaveCount(0);
  await sales.context().close();

  const db = await prisma();
  const pub = await db.orderNote.findFirstOrThrow({ where: { orderId, text: TR_NOTE } });
  expect([pub.internal, pub.translation, pub.translationLang, pub.translationStatus]).toEqual([false, `[ro] ${TR_NOTE}`, 'ro', 'DONE']);
  const int = await db.orderNote.findFirstOrThrow({ where: { orderId, text: INTERNAL_NOTE } });
  expect([int.internal, int.translation, int.translationLang, int.translationStatus, int.translationAt], 'iç not çevrilmez').toEqual([true, null, null, null, null]);

  // Müşteri (Romence arayüz): "Mesaj original" + Türkçe özgün not, altında "Română · tradus automat" + Romencesi
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/dil?l=ro&next=${orderUrl}`);
  const n = noteOf(cust, TR_NOTE).first();
  await expect(n.locator('.note-label').first()).toHaveText('Mesaj original');
  await expect(n.locator('.note-text')).toHaveText(TR_NOTE);
  const ro = n.locator('.note-translation');
  await expect(ro).toHaveAttribute('lang', 'ro');
  await expect(ro.locator('.note-label')).toHaveText('Română · tradus automat');
  await expect(ro.locator('.pre')).toHaveText(`[ro] ${TR_NOTE}`);
  await shot(cust, 'not-cevirisi-musteri');
  // Türkçe arayüzde de etiket çevirinin dilindedir
  await cust.goto(`/dil?l=tr&next=${orderUrl}`);
  await expect(noteOf(cust, TR_NOTE).first().locator('.note-translation .note-label')).toHaveText('Română · tradus automat');
  await expect(noteOf(cust, TR_NOTE).first().locator('.note-label').first()).toHaveText('Özgün mesaj');
  // İç not: ekranda da yanıtta da yok (özgünü, çevirisi, kimliği)
  await expect(cust.locator('#notlar .note')).toHaveCount(2);
  await expect(cust.getByText(INTERNAL_NOTE)).toHaveCount(0);
  const body = await (await cust.request.get(orderUrl)).text();
  for (const s of [INTERNAL_NOTE, 'yüzde yedi', `[ro] ${INTERNAL_NOTE}`, int.id]) expect(body, `müşteri yanıtında yok: ${s}`).not.toContain(s);
  await cust.context().close();

  // Yönetici iç notu görür (çevirisiz); başka firmanın müşterisi siparişi, notları ve çevirileri göremez
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(orderUrl);
  await expect(noteOf(admin, INTERNAL_NOTE)).toContainText('iç not');
  await expect(noteOf(admin, INTERNAL_NOTE).locator('.note-translation')).toHaveCount(0);
  await expect(admin.locator('#notlar .note')).toHaveCount(3);
  // Yönetici de ekibin notunu yalnızca özgün Türkçe hâliyle görür (çizimci için aynı kural: veritabanı testi);
  // müşterinin Romence notunun Türkçe çevirisi yerinde durur
  const own = noteOf(admin, TR_NOTE).first();
  await expect(own.locator('.note-text')).toHaveText(TR_NOTE);
  await expect(own.locator('.note-translation')).toHaveCount(0);
  await expect(own.locator('.note-label')).toHaveCount(0);
  const adminBody = await (await admin.request.get(orderUrl)).text();
  for (const s of [`[ro] ${TR_NOTE}`, 'tradus automat']) expect(adminBody, `yönetici yanıtında yok: ${s}`).not.toContain(s);
  await expect(noteOf(admin, RO_NOTE).first().locator('.note-translation .pre'), 'müşteri notunun Türkçesi').toHaveText(`[tr] ${RO_NOTE}`);
  await admin.context().close();
  // Denetimci: ekibin notunu yalnızca özgün Türkçe hâliyle görür (Romence çeviri yok); iç notu eskisi gibi görür
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(orderUrl);
  await expect(insp.locator('#notlar .note')).toHaveCount(3);
  await expect(noteOf(insp, TR_NOTE).first().locator('.note-text')).toHaveText(TR_NOTE);
  await expect(noteOf(insp, INTERNAL_NOTE)).toContainText('iç not');
  await expect(insp.locator('#notlar .note-translation')).toHaveCount(0);
  await expect(insp.locator('#notlar .note-label')).toHaveCount(0);
  const inspBody = await (await insp.request.get(orderUrl)).text();
  for (const s of [`[ro] ${TR_NOTE}`, `[tr] ${RO_NOTE}`, 'tradus automat', 'otomatik çevrilmiştir']) expect(inspBody, `denetimci yanıtında yok: ${s}`).not.toContain(s);
  await insp.context().close();
  const beta = await as(browser, BETA, TEAM_PW);
  const res = await beta.request.get(orderUrl);
  const other = await res.text();
  expect(res.status(), 'başka firma: sipariş yok').toBe(404);
  for (const s of [RO_NOTE, TR_NOTE, INTERNAL_NOTE, `[ro] ${TR_NOTE}`, `[tr] ${RO_NOTE}`]) expect(other).not.toContain(s);
  await beta.context().close();
  await db.$disconnect();
});

test('çeviri yapılamazsa not yine kaydedilir: müşteri notunu görür, iç ekip "çevrilemedi" bilgisini görür; müşteri çeviriyi değiştiremez', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await writeNote(cust, FAIL_NOTE); // sahte sağlayıcı bu işaretle zaman aşımı verir; not yine kaydedilir ("Not eklendi")
  await expect(noteOf(cust, FAIL_NOTE).locator('.note-text')).toHaveText(FAIL_NOTE);
  // Müşteriye hata bilgisi / durum gitmez
  await expect(cust.locator('[data-translation-failed]')).toHaveCount(0);
  const custBody = await (await cust.request.get(orderUrl)).text();
  for (const s of ['Otomatik çeviri yapılamadı', 'Traducerea automată nu a reușit', 'data-translation-failed']) expect(custBody, `müşteri yanıtında yok: ${s}`).not.toContain(s);

  const db = await prisma();
  const row = await db.orderNote.findFirstOrThrow({ where: { orderId, text: FAIL_NOTE } });
  expect([row.text, row.translation, row.translationLang, row.translationStatus, row.translationError]).toEqual([FAIL_NOTE, null, 'tr', 'FAILED', 'TIMEOUT']);

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(orderUrl);
  const n = noteOf(admin, FAIL_NOTE).first();
  await expect(n.locator('.note-text')).toHaveText(FAIL_NOTE);
  const failed = n.locator('[data-translation-failed="TIMEOUT"]');
  await expect(failed).toContainText('Otomatik çeviri yapılamadı: Google zamanında yanıt vermedi');
  await expect(n.locator('.note-translation .pre')).toHaveCount(0);
  await shot(admin, 'not-cevirisi-yapilamadi');
  // Yenileme kendiliğinden yeniden denemez
  for (let i = 0; i < 2; i++) await admin.reload();
  expect(JSON.stringify(await db.orderNote.findUniqueOrThrow({ where: { id: row.id } }))).toBe(JSON.stringify(row));

  // Müşteri "yeniden dene" işlemini taklit etse de çeviri değişmez (yetki sunucuda)
  const retryField = await actionField(admin, orderUrl, 'name="noteId"');
  const forged = await forge(cust, orderUrl, retryField, { id: orderId, noteId: row.id });
  expect(forged.url(), 'müşteri: işlem reddedildi').toContain('error=');
  expect(JSON.stringify(await db.orderNote.findUniqueOrThrow({ where: { id: row.id } }))).toBe(JSON.stringify(row));
  expect(await db.auditLog.count({ where: { action: 'NOTE_TRANSLATION_RETRY', entityId: row.id } })).toBe(0);

  // Denetimci: çevrilemeyen notu özgün hâliyle görür; hata bilgisi, durum ve "yeniden dene" ona gitmez; taklit istek reddedilir
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(orderUrl);
  await expect(noteOf(insp, FAIL_NOTE).first().locator('.note-text')).toHaveText(FAIL_NOTE);
  await expect(insp.locator('[data-translation-failed]')).toHaveCount(0);
  await expect(insp.getByRole('button', { name: 'Çeviriyi yeniden dene' })).toHaveCount(0);
  const inspBody = await (await insp.request.get(orderUrl)).text();
  for (const s of ['Otomatik çeviri yapılamadı', 'Çeviriyi yeniden dene', 'data-translation-failed', 'name="noteId"']) expect(inspBody, `denetimci yanıtında yok: ${s}`).not.toContain(s);
  const inspForged = await forge(insp, orderUrl, retryField, { id: orderId, noteId: row.id });
  expect(inspForged.url(), 'denetimci: işlem yetkisi yok').toMatch(/\/siparisler$/);
  expect(JSON.stringify(await db.orderNote.findUniqueOrThrow({ where: { id: row.id } }))).toBe(JSON.stringify(row));
  await insp.context().close();

  // İç ekip açıkça yeniden ister: (sahte sağlayıcı yine başarısız) not durur, durum "çevrilemedi" kalır
  await failed.getByRole('button', { name: 'Çeviriyi yeniden dene' }).click();
  await expect(admin.locator('.alert-error', { hasText: 'Çeviri yine yapılamadı' })).toBeVisible();
  await expect(noteOf(admin, FAIL_NOTE).first().locator('.note-text')).toHaveText(FAIL_NOTE);
  const after = await db.orderNote.findUniqueOrThrow({ where: { id: row.id } });
  expect([after.text, after.translationStatus, after.translationError]).toEqual([FAIL_NOTE, 'FAILED', 'TIMEOUT']);
  expect(await db.auditLog.count({ where: { action: 'NOTE_TRANSLATION_RETRY', entityId: row.id } })).toBe(1);
  // Entegrasyonlar ekranı çevrilemeyen notu bildirir
  await admin.goto(SETTINGS);
  await expect(admin.locator('#ceviri-hatali')).toContainText('Son 7 günde çevrilemeyen not: 1');
  await admin.context().close();
  await cust.context().close();
  await db.$disconnect();
});

test('sayfa açılışı, yenileme, 60 saniyelik otomatik yenileme, bildirim yoklaması ve işçi çeviri isteği YAPMAZ: DONE, FAILED ve çevirisiz eski notlar aynen kalır', async ({ browser }) => {
  test.setTimeout(180_000);
  const db = await prisma();
  // Çevirisi hiç istenmemiş "eski" notlar (çeviri özelliğinden önce yazılmış gibi): görüntülenince çevrilmemeli
  const sales = await db.user.findUniqueOrThrow({ where: { email: SALES } });
  const custUser = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  const OLD_RO = 'Notă veche de la client (fără traducere)';
  const OLD_TR = 'Ekibin eski notu (çevirisiz)';
  await db.orderNote.create({ data: { orderId, userId: custUser.id, text: OLD_RO, createdAt: new Date('2026-09-01T08:00:00Z') } });
  await db.orderNote.create({ data: { orderId, userId: sales.id, text: OLD_TR, createdAt: new Date('2026-09-01T09:00:00Z') } });
  const snapshot = async () => JSON.stringify(await db.orderNote.findMany({ where: { orderId }, orderBy: { id: 'asc' } }));
  const before = await snapshot();
  const states = async () => (await db.orderNote.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })).map((n) => n.translationStatus);
  expect(await states()).toEqual([null, null, 'DONE', 'DONE', null, 'FAILED']); // iki eski not, müşteri notu, satış notu, iç not, çevrilemeyen not

  // Her rol: açılış + üç yenileme + bildirim yoklaması (zilin JSON akışı)
  for (const [who, email, pw] of [['yönetici', ADMIN, ADMIN_PW], ['satış', SALES, TEAM_PW], ['müşteri', CUSTOMER, CUST_PW], ['denetimci', INSPECTOR, INSPECTOR_PW]] as const) {
    const p = await as(browser, email, pw);
    await p.goto(orderUrl);
    for (let i = 0; i < 3; i++) await p.reload();
    await expect(noteOf(p, OLD_RO).locator('.note-text'), who).toHaveText(OLD_RO);
    await expect(noteOf(p, OLD_RO).locator('.note-translation'), `${who}: eski not çevrilmez`).toHaveCount(0);
    await expect(noteOf(p, OLD_TR).locator('.note-translation'), `${who}: eski not çevrilmez`).toHaveCount(0);
    expect((await p.request.get('/bildirimler/akis')).ok(), who).toBeTruthy();
    await p.evaluate(() => window.dispatchEvent(new Event('takip:poll')));
    await p.context().close();
  }
  expect(await snapshot(), 'açılış / yenileme / yoklama hiçbir notu değiştirmedi').toBe(before);

  // Gerçek otomatik yenileme: ortak 60 saniyelik zamanlayıcı (AutoRefresh → router.refresh) üç kez çalışır;
  // her seferinde sunucu bileşeni yeniden çizilir (RSC isteği) — çeviri yapılmaz
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.clock.install();
  await admin.goto(orderUrl);
  await expect(noteOf(admin, FAIL_NOTE).first().locator('[data-translation-failed="TIMEOUT"]')).toBeVisible();
  for (let i = 0; i < 3; i++) {
    const refreshed = admin.waitForResponse((r) => r.url().includes(`/siparisler/${orderId}`) && (r.url().includes('_rsc=') || r.request().headers().rsc === '1'), { timeout: 30_000 });
    await admin.clock.runFor(61_000);
    expect((await refreshed).ok(), `otomatik yenileme ${i + 1}`).toBeTruthy();
  }
  // Yenilemeden sonra da aynı görünüm: saklanan çeviri yerinde, çevrilemeyen not hâlâ "çevrilemedi" (kendiliğinden denenmedi)
  await expect(noteOf(admin, RO_NOTE).first().locator('.note-translation .pre')).toHaveText(`[tr] ${RO_NOTE}`);
  await expect(noteOf(admin, FAIL_NOTE).first().locator('[data-translation-failed="TIMEOUT"]')).toBeVisible();
  await admin.context().close();
  expect(await snapshot(), 'otomatik yenileme hiçbir notu değiştirmedi').toBe(before);

  // İşçi bir tur çalışır (kuyruklar, taramalar, bildirimler): çeviri yapmaz, çevrilemeyen notu yeniden denemez
  execFileSync('node', ['scripts/worker.mjs', '--once'], { env: process.env, stdio: 'inherit' });
  expect(await snapshot(), 'işçi hiçbir notu değiştirmedi').toBe(before);
  const noteIds = (await db.orderNote.findMany({ where: { orderId }, select: { id: true } })).map((n) => n.id);
  expect(await db.auditLog.count({ where: { action: 'NOTE_TRANSLATION_RETRY', entityId: { in: noteIds } } }), 'yeniden deneme yalnızca önceki testteki açık istek').toBe(1);
  await db.$disconnect();
});

test('e-postalar: yazılan bütün HTML e-postalar ortak GKH başlığını taşır (gömülü logo); düz metin sürümü yerinde; gerçek e-posta gönderilmez', async () => {
  const dir = process.env.MAIL_OUTBOX_DIR;
  expect(dir, 'testlerde e-posta gönderilmez: klasöre yazılır').toBeTruthy();
  type Mail = { to: string; subject: string; text: string; html?: string; attachments?: { filename: string; contentType: string; size: number; cid?: string }[] };
  const mails: Mail[] = fs.readdirSync(dir!).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir!, f), 'utf8')));
  const html = mails.filter((m) => m.html);
  expect(html.length, 'bu çalışmada yazılmış HTML e-postalar').toBeGreaterThan(5);
  for (const m of html) {
    const where = `${m.subject} → ${m.to}`;
    expect(m.html, where).toContain('<img src="cid:gkh-logo@takip"');
    expect((m.html!.match(/<img\b/g) ?? []).length, where).toBe(1);
    expect(m.html!, `${where}: dış adresli görsel yok`).not.toMatch(/<img[^>]+src="https?:/);
    const logo = (m.attachments ?? []).filter((a) => a.cid === 'gkh-logo@takip');
    expect(logo.map((a) => [a.filename, a.contentType]), where).toEqual([['gkh-trading-invest-logo.png', 'image/png']]);
    expect(logo[0].size, where).toBeGreaterThan(50_000);
    expect(m.text.trim().length, `${where}: düz metin sürümü`).toBeGreaterThan(20);
    expect(m.text, where).not.toContain('cid:');
  }
  // Birden çok e-posta yolu aynı ortak başlığı taşır: davet / doğrulama kodu, mali belge ve depo e-postaları (ve bu çalışmada
  // işçinin yazdığı sipariş bildirimleri — hepsi yukarıdaki döngüde denetlendi)
  const kinds = {
    davet: html.filter((m) => /Takip/.test(m.subject) && /\b\d{6}\b/.test(m.text)).length,
    belge: html.filter((m) => /^(Proformă|Factură)/.test(m.subject)).length,
    depo: html.filter((m) => /Comanda depozit/.test(m.subject)).length,
  };
  for (const [kind, n] of Object.entries(kinds)) expect(n, `${kind} e-postası`).toBeGreaterThan(0);
  console.log(`e-posta sayıları: ${JSON.stringify({ ...kinds, toplam: html.length, bildirim: html.filter((m) => /^[A-Z]{3}P?\d+(-T\d*)? — /.test(m.subject)).length })}`);
  // Ekli PDF'ler yerinde ve logodan önce (depo formu, mali belge)
  const depot = html.find((m) => /Comanda depozit/.test(m.subject))!;
  expect(depot.attachments!.map((a) => a.contentType)).toEqual(['application/pdf', 'image/png']);
});

test('çeviri kapatılınca notlar eskisi gibi çevirisiz kaydedilir; önceki çeviriler yerinde durur', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(SETTINGS);
  const card = admin.locator('form#ceviri');
  await card.locator('input[name=enabled]').uncheck();
  await card.getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin).toHaveURL(/ok=translate/);
  await expect(card.locator('input[name=enabled]')).not.toBeChecked();
  const db = await prisma();
  const setting = ((await db.integrationSetting.findUnique({ where: { key: 'translate' } }))?.value ?? null) as Settings;
  expect([setting?.enabled, String(setting?.keySealed).startsWith('v1:')], 'kapalı; kayıtlı anahtar duruyor').toEqual([false, true]);

  const cust = await as(browser, CUSTOMER, CUST_PW);
  const text = 'Notă scrisă cu traducerea dezactivată';
  await writeNote(cust, text);
  await cust.context().close();
  const row = await db.orderNote.findFirstOrThrow({ where: { orderId, text } });
  expect([row.translation, row.translationLang, row.translationStatus, row.translationError, row.translationAt]).toEqual([null, null, null, null, null]);
  await admin.goto(orderUrl);
  await expect(noteOf(admin, text).locator('.note-text')).toHaveText(text);
  await expect(noteOf(admin, text).locator('.note-translation')).toHaveCount(0);
  await expect(noteOf(admin, text).locator('.note-label')).toHaveCount(0);
  // Daha önce çevrilmiş not çevirisiyle durur (saklanan sonuç gösterilir)
  await expect(noteOf(admin, RO_NOTE).first().locator('.note-translation .pre')).toHaveText(`[tr] ${RO_NOTE}`);
  await db.$disconnect();
  await admin.context().close();
});
