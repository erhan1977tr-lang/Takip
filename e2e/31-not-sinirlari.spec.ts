import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, INSPECTOR_PW, TEAM_PW, as, createUser, firstLogin, outboxCodeFor } from './helpers';

// Not yazma ve not çevirisi sınırları (karar 147; güvenlik denetimi 3.50.9 AUD-9) — gerçek sunucuda, tarayıcıdan.
//  - müşteri: 10 dakikada 20 not; 21. not reddedilir (Romence, anlaşılır ileti), yazılmaz; taklit / paralel istek de geçemez
//  - sınır kullanıcıya özeldir: aynı firmanın öteki kullanıcısı ve iç ekip yazmaya devam eder
//  - hız sınırı yüzünden çevrilmeyen not: iç ekip nedenini ve "yeniden dene"yi görür; müşteri ve denetimci hiçbir şey
//    görmez; sayfa yenilemesi çeviri yapmaz; iç ekip "yeniden dene" ile çevirtir
//  - "yeniden dene": kullanıcı başına 10 dakikada 20 çağrı; sonraki istek reddedilir, not ve denetim kaydı değişmez
// Sayaçlar sunucu sürecinde tutulur: bu dosya KENDİ kullanıcılarını oluşturur (öteki testlerin yazdığı notlardan
// etkilenmez) ve son sırada çalışır. Saatte 30 çeviri ve sipariş başına 500 not sınırları veritabanı testlerindedir
// (test/db/note-translation.test.js) — tarayıcıdan dakikalar sürer.
// Google'a GERÇEK istek gitmez: sunucu TRANSLATE_FAKE=1 ile sahte sağlayıcıyı kullanır; ilk test bunu ekranda doğrular.
test.describe.configure({ mode: 'serial' });

const WRITER = 'not-sinir@unsal.test'; // bu dosyaya özel müşteri kullanıcısı (Ünsal Cam)
const STAFF = 'not-sinir-satis@e2e.test'; // bu dosyaya özel satış kullanıcısı
const INSPECTOR = 'denetim@e2e.test';
const SETTINGS = '/admin/entegrasyonlar';
// Gerçek bir anahtar DEĞİL: yalnızca biçimi geçerli sahte değer (sahte sağlayıcı anahtarı kullanmaz)
const FAKE_KEY = 'e2e-sahte-anahtar-0123456789abcdef';
const RO_RATE = 'Ați trimis prea multe note într-un timp scurt. Vă rugăm să încercați din nou peste câteva minute.';
const TR_RETRY_LIMIT = 'Kısa sürede çok fazla çeviri denemesi yapıldı. Lütfen birkaç dakika sonra yeniden deneyin.';
const LIMITED_NOTE = 'Notă salvată fără traducere (limită)';
const FAILING_NOTE = 'Notă care nu se poate traduce #çeviri-hata';
let orderId = '';
let orderUrl = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const romanian = (page: Page) => page.context().addCookies([{ name: 'takip_lang', value: 'ro', url: new URL(page.url()).origin }]);
const noteForm = (page: Page) => page.locator('#notlar form', { has: page.locator('textarea[name=text]') });
const noteOf = (page: Page, text: string) => page.locator('#notlar .note', { hasText: text });
/** Not formunu gönderir (sonucu çağıran denetler) */
async function submitNote(page: Page, text: string) {
  await page.goto(orderUrl);
  await page.locator('#notlar textarea[name=text]').fill(text);
  await noteForm(page).getByRole('button').click();
}
async function actionField(page: Page, url: string, marker: string): Promise<string> {
  const html = await (await page.request.get(url)).text();
  const form = html.split('<form').find((chunk) => chunk.includes(marker));
  const m = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form) : null;
  expect(m, `sunucu işlemi alanı bulunamadı (${url}, ${marker})`).toBeTruthy();
  return m![0];
}
/** Sunucu işlemine doğrudan istek (tarayıcı formu olmadan); yanıtın vardığı adres döner */
async function forge(page: Page, field: string, data: Record<string, string>) {
  const origin = new URL(page.url()).origin;
  const res = await page.request.post(orderUrl, { multipart: { [field]: '', ...data }, headers: { origin } });
  return new URL(res.url());
}

test('veri: bu dosyaya özel müşteri ve satış kullanıcısı, sipariş; not çevirisi açık (sahte sağlayıcı — test modu)', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await createUser(admin, { email: WRITER, name: 'Not Sınırı Müşteri', role: 'Müşteri', firm: 'Ünsal Cam' });
  await createUser(admin, { email: STAFF, name: 'Not Sınırı Satış', role: 'Satış', firm: 'GKH Trading' });
  for (const email of [WRITER, STAFF]) {
    const fresh = await (await browser.newContext()).newPage();
    await firstLogin(fresh, email, outboxCodeFor(email), TEAM_PW);
    await fresh.context().close();
  }
  // Ağ güvencesi: sunucu sahte sağlayıcıyla çalışıyor (Google'a istek gitmez). Bu uyarı yoksa dosya burada durur.
  await admin.goto(SETTINGS);
  const card = admin.locator('form#ceviri');
  await expect(card.locator('.alert-warn')).toContainText('TEST MODU');
  await card.locator('input[name=enabled]').check();
  await card.locator('input[name=apiKey]').fill(FAKE_KEY);
  await card.getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin).toHaveURL(/ok=translate/);
  await admin.goto(SETTINGS);
  await expect(card.locator('input[name=enabled]')).toBeChecked();
  await admin.context().close();

  const db = await prisma();
  const adminUser = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const writer = await db.user.findUniqueOrThrow({ where: { email: WRITER }, include: { customer: true } });
  const o = await db.order.create({
    data: {
      orderNo: `${writer.customer!.prefix}9801`, customerOrderNo: 9801, title: 'Not sınırları e2e', orderTypeCode: 'GLASS_ORDER', customerId: writer.customerId!, createdById: writer.id, status: 'URETIMDE',
      estimatedShipDate: new Date(Date.now() + 30 * 86_400_000),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: adminUser.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '37', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
  orderId = o.id;
  orderUrl = `/siparisler/${o.id}`;
  await db.$disconnect();
});

test('müşteri 20 not yazar; 21. not reddedilir (Romence ileti) ve yazılmaz; taklit / paralel istekler de geçemez; öteki kullanıcılar etkilenmez', async ({ browser }) => {
  test.setTimeout(240_000);
  const db = await prisma();
  const writer = await db.user.findUniqueOrThrow({ where: { email: WRITER } });
  const mine = () => db.orderNote.count({ where: { orderId, userId: writer.id } });
  const page = await as(browser, WRITER, TEAM_PW);
  await romanian(page);
  for (let i = 1; i <= 20; i++) {
    await submitNote(page, `Nota ${i} din 20`);
    await expect(page, `not ${i}`).toHaveURL(/ok=note_added/);
  }
  await expect(page.locator('html')).toHaveAttribute('lang', 'ro');
  await expect(page.locator('.alert-ok', { hasText: 'Nota a fost adăugată.' })).toBeVisible();
  expect(await mine()).toBe(20);
  // Müşteri notları çevrildi (sahte sağlayıcı): çeviri sınırı (saatte 30) içinde
  expect(await db.orderNote.count({ where: { orderId, userId: writer.id, translationStatus: 'DONE', translationLang: 'tr' } })).toBe(20);

  // 21. not: reddedilir; ileti Romence ve anlaşılır, sayı / sınır ayrıntısı vermez; not yazılmaz
  await submitNote(page, 'Nota 21 – peste limită');
  await expect(page).toHaveURL(/[?&]error=/);
  const alert = page.locator('.alert-error', { hasText: 'prea multe note' });
  await expect(alert).toHaveText(RO_RATE);
  expect(await alert.innerText()).not.toMatch(/\d|RATE_LIMIT|limit/i);
  await expect(noteOf(page, 'Nota 21')).toHaveCount(0);
  await expect(page.locator('#notlar .note')).toHaveCount(20);
  expect(await mine()).toBe(20);
  expect(await db.orderNote.count({ where: { orderId, text: { contains: 'peste limită' } } })).toBe(0);

  // Tarayıcı formu olmadan, aynı anda 8 istek: hepsi reddedilir (sınır sunucuda)
  const field = await actionField(page, orderUrl, 'name="text"');
  const forged = await Promise.all(Array.from({ length: 8 }, (_, i) => forge(page, field, { id: orderId, text: `Fals ${i}` })));
  for (const url of forged) expect(url.searchParams.get('error')).toBe(RO_RATE);
  expect(await mine()).toBe(20);
  expect(await db.orderNote.count({ where: { orderId, text: { startsWith: 'Fals ' } } })).toBe(0);
  // Kullanıcının başka siparişi de aynı sınırdadır (hak kullanıcınındır)
  const other = await db.order.findFirst({ where: { customerId: writer.customerId!, id: { not: orderId }, removedAt: null, orderTypeCode: 'GLASS_ORDER' }, orderBy: { createdAt: 'desc' } });
  if (other) {
    const before = await db.orderNote.count({ where: { orderId: other.id } });
    const res = await page.request.post(`/siparisler/${other.id}`, { multipart: { [field]: '', id: other.id, text: 'Altă comandă' }, headers: { origin: new URL(page.url()).origin } });
    expect(new URL(res.url()).searchParams.get('error')).toBe(RO_RATE);
    expect(await db.orderNote.count({ where: { orderId: other.id } })).toBe(before);
  }
  await page.context().close();

  // Sınır kullanıcıya özeldir: aynı firmanın öteki kullanıcısı ve satış aynı siparişe yazar
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await submitNote(cust, 'Notă de la alt utilizator al firmei');
  await expect(cust).toHaveURL(/ok=note_added/);
  await cust.context().close();
  const staff = await as(browser, STAFF, TEAM_PW);
  await submitNote(staff, 'Satış notu: sınır müşteri kullanıcısına özeldir');
  await expect(staff).toHaveURL(/ok=note_added/);
  await staff.context().close();
  expect(await db.orderNote.count({ where: { orderId } })).toBe(22);
  await db.$disconnect();
});

test('hız sınırı yüzünden çevrilmeyen not: iç ekip nedeni ve "yeniden dene"yi görür, müşteri ve denetimci görmez; yenileme çeviri yapmaz; iç ekip yeniden deneyince çevrilir', async ({ browser }) => {
  const db = await prisma();
  const writer = await db.user.findUniqueOrThrow({ where: { email: WRITER } });
  // Servisin çeviri sınırı dolduğunda yazdığı kayıt (aynı alanlar — veritabanı testi servisin bunu yazdığını doğrular)
  const row = await db.orderNote.create({ data: { orderId, userId: writer.id, text: LIMITED_NOTE, translationLang: 'tr', translationStatus: 'FAILED', translationError: 'RATE_LIMIT', translationAt: new Date() } });
  const same = async () => JSON.stringify(await db.orderNote.findUniqueOrThrow({ where: { id: row.id } }));
  const before = await same();

  const staff = await as(browser, STAFF, TEAM_PW);
  await staff.goto(orderUrl);
  const n = noteOf(staff, LIMITED_NOTE).first();
  await expect(n.locator('.note-text')).toHaveText(LIMITED_NOTE);
  const failed = n.locator('[data-translation-failed="RATE_LIMIT"]');
  await expect(failed).toContainText('Otomatik çeviri yapılamadı: kısa sürede çok fazla not yazıldığı için çeviri yapılmadı');
  await expect(failed.getByRole('button', { name: 'Çeviriyi yeniden dene' })).toBeVisible();
  await expect(n.locator('.note-translation .pre')).toHaveCount(0);
  // Yenileme kendiliğinden çevirmez (kayıt, çeviri zamanı dahil, aynen durur)
  for (let i = 0; i < 3; i++) await staff.reload();
  expect(await same()).toBe(before);

  // Müşteri (Romence arayüz): notunu özgün hâliyle görür; durum, neden ve "yeniden dene" ona gitmez
  const cust = await as(browser, WRITER, TEAM_PW);
  await romanian(cust);
  await cust.goto(orderUrl);
  await expect(noteOf(cust, LIMITED_NOTE).locator('.note-text')).toHaveText(LIMITED_NOTE);
  await expect(cust.locator('[data-translation-failed]')).toHaveCount(0);
  const custBody = await (await cust.request.get(orderUrl)).text();
  for (const s of ['RATE_LIMIT', 'data-translation-failed', 'traducerea nu a fost făcută', 'Traducerea automată nu a reușit', 'name="noteId"']) expect(custBody, `müşteri yanıtında yok: ${s}`).not.toContain(s);
  // Müşteri "yeniden dene" işlemini taklit etse de çeviri değişmez (yetki sunucuda)
  const retryField = await actionField(staff, orderUrl, 'name="noteId"');
  const forgedByCustomer = await forge(cust, retryField, { id: orderId, noteId: row.id });
  expect(forgedByCustomer.searchParams.get('error'), 'müşteri: işlem reddedildi').toBeTruthy();
  expect(await same()).toBe(before);
  await cust.context().close();
  // Denetimci: özgün not; durum, neden ve "yeniden dene" yok
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(orderUrl);
  await expect(noteOf(insp, LIMITED_NOTE).first().locator('.note-text')).toHaveText(LIMITED_NOTE);
  await expect(insp.locator('[data-translation-failed]')).toHaveCount(0);
  const inspBody = await (await insp.request.get(orderUrl)).text();
  for (const s of ['RATE_LIMIT', 'data-translation-failed', 'Otomatik çeviri yapılamadı', 'Çeviriyi yeniden dene', 'name="noteId"']) expect(inspBody, `denetimci yanıtında yok: ${s}`).not.toContain(s);
  await insp.context().close();
  expect(await same()).toBe(before);
  expect(await db.auditLog.count({ where: { action: 'NOTE_TRANSLATION_RETRY', entityId: row.id } })).toBe(0);

  // İç ekip açıkça yeniden ister → çevrilir (sahte sağlayıcı), bir kez
  await staff.goto(orderUrl);
  await noteOf(staff, LIMITED_NOTE).first().getByRole('button', { name: 'Çeviriyi yeniden dene' }).click();
  await expect(staff).toHaveURL(/ok=note_translated/);
  const done = noteOf(staff, LIMITED_NOTE).first();
  await expect(done.locator('.note-translation .pre')).toHaveText(`[tr] ${LIMITED_NOTE}`);
  await expect(done.locator('[data-translation-failed]')).toHaveCount(0);
  const after = await db.orderNote.findUniqueOrThrow({ where: { id: row.id } });
  expect([after.text, after.translation, after.translationLang, after.translationStatus, after.translationError]).toEqual([LIMITED_NOTE, `[tr] ${LIMITED_NOTE}`, 'tr', 'DONE', null]);
  expect(await db.auditLog.count({ where: { action: 'NOTE_TRANSLATION_RETRY', entityId: row.id } })).toBe(1);
  await staff.context().close();
  await db.$disconnect();
});

test('"yeniden dene" sınırı: kullanıcı başına 10 dakikada 20 çağrı — sonraki istek reddedilir, not ve denetim kaydı değişmez; başka kullanıcı deneyebilir', async ({ browser }) => {
  test.setTimeout(180_000);
  const db = await prisma();
  const writer = await db.user.findUniqueOrThrow({ where: { email: WRITER } });
  const staffUser = await db.user.findUniqueOrThrow({ where: { email: STAFF } });
  // Sahte sağlayıcının çeviremediği not (işaretli metin → zaman aşımı): her deneme bir sağlayıcı çağrısıdır
  const row = await db.orderNote.create({ data: { orderId, userId: writer.id, text: FAILING_NOTE, translationLang: 'tr', translationStatus: 'FAILED', translationError: 'TIMEOUT', translationAt: new Date() } });
  const retriesBy = (userId: string) => db.auditLog.count({ where: { action: 'NOTE_TRANSLATION_RETRY', userId } });
  expect(await retriesBy(staffUser.id), 'bu kullanıcı önceki testte bir kez denedi').toBe(1);

  const staff = await as(browser, STAFF, TEAM_PW);
  const field = await actionField(staff, orderUrl, 'name="noteId"');
  // 19 deneme daha (toplam 20): her biri sağlayıcıya gider, çeviri yine yapılamaz
  for (let i = 2; i <= 20; i++) {
    const url = await forge(staff, field, { id: orderId, noteId: row.id });
    expect(url.searchParams.get('error'), `deneme ${i}`).toContain('Çeviri yine yapılamadı');
  }
  expect(await retriesBy(staffUser.id)).toBe(20);
  const before = JSON.stringify(await db.orderNote.findUniqueOrThrow({ where: { id: row.id } }));
  // 21. istek: reddedilir — sağlayıcı çağrılmaz, nota dokunulmaz, denetim kaydı yazılmaz
  const blocked = await forge(staff, field, { id: orderId, noteId: row.id });
  expect(blocked.searchParams.get('error')).toBe(TR_RETRY_LIMIT);
  // Ekranda da aynı ileti; not "çevrilemedi" olarak, yeniden denenebilir hâlde durur
  await staff.goto(orderUrl);
  await noteOf(staff, FAILING_NOTE).first().getByRole('button', { name: 'Çeviriyi yeniden dene' }).click();
  await expect(staff.locator('.alert-error', { hasText: 'çeviri denemesi' })).toHaveText(TR_RETRY_LIMIT);
  await expect(noteOf(staff, FAILING_NOTE).first().locator('[data-translation-failed="TIMEOUT"]')).toBeVisible();
  expect(await retriesBy(staffUser.id)).toBe(20);
  expect(JSON.stringify(await db.orderNote.findUniqueOrThrow({ where: { id: row.id } }))).toBe(before);
  // Sınır yeniden denemeye özeldir: aynı kullanıcı not yazmaya devam eder
  await submitNote(staff, 'Satış notu: yeniden deneme sınırı not yazmayı engellemez');
  await expect(staff).toHaveURL(/ok=note_added/);
  await staff.context().close();

  // Sınır kullanıcı başınadır: yönetici aynı notu deneyebilir (sağlayıcıya gider; sahte sağlayıcı yine çeviremez)
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(orderUrl);
  await noteOf(admin, FAILING_NOTE).first().getByRole('button', { name: 'Çeviriyi yeniden dene' }).click();
  await expect(admin.locator('.alert-error', { hasText: 'Çeviri yine yapılamadı' })).toBeVisible();
  expect(await db.auditLog.count({ where: { action: 'NOTE_TRANSLATION_RETRY', entityId: row.id } })).toBe(20);

  // Temizlik: not çevirisi kapatılır (önceki testlerin bıraktığı durum)
  await admin.goto(SETTINGS);
  const card = admin.locator('form#ceviri');
  await card.locator('input[name=enabled]').uncheck();
  await card.getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin).toHaveURL(/ok=translate/);
  await admin.context().close();
  await db.$disconnect();
});
