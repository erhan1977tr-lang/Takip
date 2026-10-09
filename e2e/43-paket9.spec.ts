import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, INSPECTOR_PW, TEAM_PW, as, createUser, firstLogin, outboxCodeFor } from './helpers';

// Paket 9 (kararlar 198–202) — dil ayarı, sipariş mesajı sayaçları ve bildirimi, tekilleştirme, anlık arama, mobil taşma.
//  - Ayarlar: bütün rollerde (iç ekip "Hesap ayarları"); Otomatik varsayılan; seçilen dil yeniden girişte de geçerli
//  - müşterinin mesajı: yöneticide ve ilgili satışta zil + siparişte kırmızı sayaç; zil #notlar'a götürür; sipariş açılınca
//    okundu (sayaç ve zil birlikte); yenileme / otomatik yenileme sayacı geri getirmez; satışta firma adı maskeli
//  - aynı form iki kez gönderilse de tek mesaj, tek bildirim; iç not müşteriye hiçbir iz bırakmaz
//  - denetimci notu yalnızca özgün dilinde görür; sayfa yenilemesi çeviri yapmaz (çeviri satırı değişmez)
//  - anlık arama: yazdıkça süzülür, geç gelen eski yanıt yenisini ezmez, boş arama normal liste, "sonuç yok" durumu,
//    satışın aramasında firmanın tam adı yok
//  - mobilde (390 px) sayfalar yana taşmaz
// Gerçek SMTP / Google / FGO isteği yok (e-postalar outbox klasörüne, çeviri sahte sağlayıcıya).
test.describe.configure({ mode: 'serial' });

const WRITER = 'p9-musteri@unsal.test';
const STAFF = 'p9-satis@e2e.test';
const INSPECTOR = 'denetim@e2e.test';
const TITLE = `Paket9 mesaj ${Date.now().toString(36)}`;
let orderId = '';
let orderNo = '';
let firmName = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
async function noOverflow(page: Page, what: string) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `${what}: mobilde sayfa yana taşmaz`).toBeLessThanOrEqual(iw + 1);
}
const rowOf = (page: Page) => page.locator('tr', { has: page.locator(`a.order-no[href="/siparisler/${orderId}"]`) });
async function sendNote(page: Page, text: string, internal = false) {
  await page.goto(`/siparisler/${orderId}`);
  await page.locator('#notlar textarea[name=text]').fill(text);
  if (internal) await page.locator('#notlar input[name=internal]').check();
  await page.locator('#notlar form', { has: page.locator('textarea[name=text]') }).getByRole('button').click();
  await expect(page).toHaveURL(/ok=note_added/);
}

test('veri: bu dosyaya özel müşteri ve satış kullanıcısı, cam siparişi', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await createUser(admin, { email: WRITER, name: 'Paket9 Müşteri', role: 'Müşteri', firm: 'Ünsal Cam' });
  await createUser(admin, { email: STAFF, name: 'Paket9 Satış', role: 'Satış', firm: 'GKH Trading' });
  for (const email of [WRITER, STAFF]) {
    const fresh = await (await browser.newContext()).newPage();
    await firstLogin(fresh, email, outboxCodeFor(email), TEAM_PW);
    await fresh.context().close();
  }
  await admin.context().close();
  const db = await prisma();
  const writer = await db.user.findUniqueOrThrow({ where: { email: WRITER }, include: { customer: true } });
  const no = 9000 + Math.floor(Math.random() * 900);
  const o = await db.order.create({
    data: { orderNo: `${writer.customer!.prefix}${no}`, customerOrderNo: no, title: TITLE, orderTypeCode: 'GLASS_ORDER', customerId: writer.customerId!, createdById: writer.id, status: 'HAZIRLANIYOR' },
  });
  orderId = o.id;
  orderNo = o.orderNo;
  firmName = writer.customer!.name;
  await db.$disconnect();
});

test('dil ayarı: iç ekipte "Hesap ayarları"; Otomatik varsayılan; Română seçilince panel Romence ve yeniden girişte de Romence; e-posta tercihi yalnızca müşteride', async ({ browser }) => {
  const page = await as(browser, STAFF, TEAM_PW);
  const link = page.locator('.sidebar').getByRole('link', { name: 'Hesap ayarları', exact: true });
  await expect(link).toHaveAttribute('href', '/ayarlar');
  await link.click();
  await expect(page.getByRole('heading', { name: 'Hesap ayarları', level: 1 })).toBeVisible();
  const select = page.locator('#fixedLanguage');
  await expect(select).toHaveValue('');
  expect(await select.locator('option').allInnerTexts()).toEqual(['Otomatik', 'Türkçe', 'Română']);
  await expect(page.locator('input[name=emailNotifications]')).toHaveCount(0);
  await select.selectOption('ro');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page).toHaveURL(/ok=1/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ro');
  await expect(page.getByRole('heading', { name: 'Setările contului', level: 1 })).toBeVisible();
  await page.context().close();
  // Yeni oturum, Türkçe giriş ekranı: sabit dil geçerli
  const again = await (await browser.newContext()).newPage();
  await again.goto('/login');
  await again.fill('#email', STAFF);
  await again.fill('#password', TEAM_PW);
  await again.click('button[type=submit]');
  await expect(again).toHaveURL(/\/siparisler/);
  await expect(again.locator('html')).toHaveAttribute('lang', 'ro');
  // Otomatik'e döner (öbür testler Türkçe ekranla çalışır)
  await again.goto('/ayarlar');
  await again.locator('#fixedLanguage').selectOption('');
  await again.getByRole('button', { name: 'Salvează' }).click();
  await expect(again).toHaveURL(/ok=1/);
  const db = await prisma();
  expect((await db.user.findUniqueOrThrow({ where: { email: STAFF } })).fixedLanguage).toBeNull();
  await db.user.update({ where: { email: STAFF }, data: { language: 'tr' } });
  await db.$disconnect();
  await again.context().close();
  // Müşteride e-posta tercihi var
  const cust = await as(browser, WRITER, TEAM_PW);
  await cust.goto('/ayarlar');
  await expect(cust.locator('input[name=emailNotifications]')).toHaveCount(1);
  await expect(cust.locator('#fixedLanguage')).toHaveValue('');
  await cust.context().close();
});

test('mesaj: müşterinin mesajı (çift tıklamayla bile) tek kez yazılır; yönetici / satışta sayaç + zil; zil #notlar\'a götürür; açılınca okundu, yenileme geri getirmez; satışta firma maskeli', async ({ browser }) => {
  const db = await prisma();
  const cust = await as(browser, WRITER, TEAM_PW);
  await cust.goto(`/siparisler/${orderId}`);
  await cust.locator('#notlar textarea[name=text]').fill('Paket9: soru var');
  // Çift tıklama: aynı form (aynı tek kullanımlık anahtar) iki kez gider
  await cust.locator('#notlar form', { has: cust.locator('textarea[name=text]') }).getByRole('button').dblclick();
  await expect(cust).toHaveURL(/ok=note_added/);
  await expect.poll(() => db.orderNote.count({ where: { orderId, text: 'Paket9: soru var' } })).toBe(1);
  await cust.waitForTimeout(500);
  expect(await db.orderNote.count({ where: { orderId, text: 'Paket9: soru var' } })).toBe(1);
  expect(await db.notificationOutbox.count({ where: { orderId, type: 'ORDER_NOTE_ADDED' } })).toBe(1);
  await cust.context().close();

  // Yönetici: liste satırında kırmızı sayaç, zilde bildirim (bildirim hemen dağıtılır — işçi yok)
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler?view=all&q=${encodeURIComponent(TITLE)}`);
  await expect(rowOf(admin).locator('.msg-count')).toHaveText('1');
  await expect(admin.locator('.sidebar [data-nav-unread]')).toBeVisible();
  await admin.locator('.notif-bell').click();
  const item = admin.locator('.notif-item', { hasText: orderNo }).first();
  await expect(item).toContainText('Siparişte yeni mesaj');
  await expect(item.locator('a.notif-main')).toHaveAttribute('href', `/siparisler/${orderId}#notlar`);
  await item.locator('a.notif-main').click();
  await expect(admin).toHaveURL(new RegExp(`/siparisler/${orderId}#notlar`));
  await expect(admin.locator('#notlar [data-new="1"]')).toHaveCount(1);
  // Açıldı → okundu (sayaç ve zil); yenileme sayacı geri getirmez
  await expect.poll(async () => (await db.notification.findMany({ where: { orderId, type: 'ORDER_NOTE_ADDED', user: { email: ADMIN } } })).every((x) => x.isRead)).toBe(true);
  await admin.reload();
  await expect(admin.locator('#notlar [data-unread-notes]')).toHaveCount(0);
  await admin.goto(`/siparisler?view=all&q=${encodeURIComponent(TITLE)}`);
  await expect(rowOf(admin).locator('.msg-count')).toHaveCount(0);
  await admin.context().close();

  // Satış: aynı mesajın bildirimi, firma adı maskeli (ilk 3 karakter + 10 yıldız)
  const sales = await as(browser, STAFF, TEAM_PW);
  await sales.locator('.notif-bell').click();
  const s = sales.locator('.notif-item', { hasText: orderNo }).first();
  await expect(s).toContainText(`${firmName.slice(0, 3)}**********`);
  await expect(s).not.toContainText(firmName);
  await sales.goto(`/siparisler?view=all&q=${encodeURIComponent(TITLE)}`);
  await expect(rowOf(sales).locator('.msg-count')).toHaveText('1');
  expect(await sales.content()).not.toContain(firmName);
  await sales.context().close();
  await db.$disconnect();
});

test('iç ekibin mesajı müşteriye zil + sayaç; iç not müşteriye hiçbir iz bırakmaz; denetimci notu yalnızca özgün dilinde görür; yenileme çeviri yapmaz', async ({ browser }) => {
  const db = await prisma();
  const sales = await as(browser, STAFF, TEAM_PW);
  await sendNote(sales, 'Paket9: yanıt');
  await sendNote(sales, 'Paket9: gizli iç not', true);
  await sales.context().close();
  const cust = await as(browser, WRITER, TEAM_PW);
  await cust.goto('/siparisler');
  await expect(rowOf(cust).locator('.msg-count')).toHaveText('1');
  await cust.locator('.notif-bell').click();
  await expect(cust.locator('.notif-item', { hasText: orderNo })).toHaveCount(1);
  await cust.goto(`/siparisler/${orderId}`);
  expect(await cust.content()).not.toContain('gizli iç not');
  await expect(cust.locator('#notlar [data-new="1"]')).toHaveCount(1);
  await cust.context().close();

  // Denetimci: çevirisi saklanmış müşteri notunu yalnızca özgün dilinde görür; iki yenileme çeviri satırını değiştirmez
  const note = await db.orderNote.findFirstOrThrow({ where: { orderId, text: 'Paket9: soru var' } });
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(`/siparisler/${orderId}`);
  const box = insp.locator(`#notlar [data-note="${note.id}"]`);
  await expect(box).toContainText('Paket9: soru var');
  await expect(box.locator('.note-translation')).toHaveCount(0);
  await insp.reload();
  await insp.reload();
  const after = await db.orderNote.findUniqueOrThrow({ where: { id: note.id } });
  expect([after.translationStatus, after.translationAt?.getTime() ?? null]).toEqual([note.translationStatus, note.translationAt?.getTime() ?? null]);
  await insp.context().close();
  await db.$disconnect();
});

test('anlık arama: yazdıkça süzülür; geç gelen eski yanıt yenisini ezmez; "sonuç yok" durumu; boş arama normal liste', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/siparisler?view=all');
  const box = admin.locator('.toolbar input[type=search]');
  // İlk (eski) aramanın yanıtı geciktirilir
  const STALE = 'zz-eski-arama';
  await admin.route((url) => url.pathname === '/siparisler' && url.searchParams.get('q') === STALE, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue().catch(() => {});
  });
  await box.pressSequentially(STALE, { delay: 10 });
  await admin.waitForTimeout(450);
  await box.fill(TITLE);
  await expect(admin).toHaveURL(new RegExp(`q=${encodeURIComponent(TITLE).replace(/%20/g, '(\\+|%20)')}`));
  await expect(rowOf(admin)).toHaveCount(1);
  await admin.waitForTimeout(3000);
  await expect(rowOf(admin)).toHaveCount(1);
  await expect(box).toHaveValue(TITLE);
  expect(new URL(admin.url()).searchParams.get('q')).toBe(TITLE);
  expect(new URL(admin.url()).searchParams.get('view')).toBe('all');
  await admin.unrouteAll({ behavior: 'ignoreErrors' });
  // Sonuç yok
  await box.fill('zz-hic-yok-123');
  await expect(admin.locator('[data-search-result="0"]')).toHaveText('Aramanızla eşleşen sipariş yok.');
  // Boş arama: normal liste (q yok)
  await box.fill('');
  await expect.poll(() => new URL(admin.url()).searchParams.get('q')).toBeNull();
  await expect(admin.locator('[data-search-result]')).toHaveCount(0);
  await admin.context().close();
});

test('mobil (390 px): sipariş listesi, sipariş sayfası, ayarlar ve bildirim zili yana taşmaz; sayaç görünür', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.fill('#email', WRITER);
  await page.fill('#password', TEAM_PW);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/siparisler/);
  await noOverflow(page, 'müşteri sipariş listesi');
  await page.goto(`/siparisler/${orderId}`);
  await noOverflow(page, 'sipariş sayfası');
  await page.goto('/ayarlar');
  await noOverflow(page, 'ayarlar');
  await page.locator('.notif-bell').click();
  await noOverflow(page, 'açık zil');
  await ctx.close();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto('/siparisler?view=all');
  await noOverflow(admin, 'iç ekip sipariş listesi');
  await admin.context().close();
});
