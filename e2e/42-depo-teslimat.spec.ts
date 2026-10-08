import { test, expect, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, INSPECTOR_PW, SALES, TEAM_PW, as, sampleFile } from './helpers';

// Paket 8 — Depo, teslimat, çalışma takvimleri ve teslimat belgeleri (karar 192–197).
//  - Ayarlar → Çalışma Takvimleri: Romanya deposu ve Türkiye fabrikası ayrı; resmî tatil, elle kapalı gün; yalnızca yönetici; mobilde taşma yok
//  - profil siparişi: tahmini teslim (alış) günü müşteri ekranında (tahmini, stoktan bağımsız); yönetici depoda iken değiştirir
//    → müşteriye TEK bildirim (olay başına); aynı gün yeniden kaydedilirse bildirim yok
//  - teslimat fotoğrafları: birden çok, her biri ayrı istek; biri reddedilirse ötekiler kalır; aynı fotoğraf ikinci kez kayıt olmaz
//  - teslimat raporu: yönetici ve depo bağlantısı oluşturur; müşteri kendi siparişinden açar (teslimden sonra da); başka firma /
//    satış açamaz; teslim onayı bir kez işlenir (eski sekmeden ikinci onay yeni olay / stok hareketi / bildirim yazmaz)
//  - tedarikçi tahmini yükleme tarihi Türkiye resmî tatiline denk gelirse uyarı; tarih değişmez
// FGO bu veritabanında KAPALIDIR; gerçek e-posta / FGO isteği yoktur (işçi çalıştırılmaz).
test.describe.configure({ mode: 'serial' });

const BETA = 'beta@betacam.test';
const INSPECTOR = 'denetim@e2e.test';
let orderId = '';
let orderNo = '';
let depotToken = '';
const dmy = (k: string) => k.split('-').reverse().join('.');

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
/** Gerçek içerik denetiminden geçen küçük JPEG (FF D8 FF + SOF0 boyutu); label içeriğe yazılır (ayrı sağlama toplamı) */
function jpeg(name: string, label = name) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const text = Buffer.from(label);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, text.length + 2]), text]);
  return { name, mimeType: 'image/jpeg', buffer: Buffer.concat([Buffer.from([0xff, 0xd8]), com, sof, Buffer.from([0xff, 0xd9])]) };
}
async function noOverflow(page: Page, what: string) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `${what}: mobilde sayfa yana taşmaz`).toBeLessThanOrEqual(iw + 1);
}

test('veri: Ünsal\'ın profil siparişi depoya iletildi (gerçek servislerle: teklif, onay, proforma, "Siparişi depoya gönder")', async () => {
  const db = await prisma();
  try {
    const { createProfileOrder } = await import('../server/profile/create.js');
    const { profileOrderItems } = await import('../server/profile/rules.js');
    const { runProfileAction } = await import('../server/profile/transitions.js');
    const { earliestPickup } = await import('../server/profile/dates.js');
    const { suggestNextNo } = await import('../server/orders/create.js');
    const { hashToken } = await import('../server/profile/warehouse.js');
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
    const act = (u: { id: string; appRole: string; canApprove: boolean; customerId: string | null }) => ({ id: u.id, role: u.appRole, canApprove: u.canApprove, customerId: u.customerId, ip: '127.0.0.1' });
    const products = await db.profileProduct.findMany({ where: { code: { in: ['GK15', 'AD45'] } }, include: { category: true } });
    const items = profileOrderItems(products.map((p) => ({ productId: p.id, qty: p.code === 'GK15' ? 2 : 3 })), products);
    if (!items.ok) throw new Error(`kalemler: ${items.code}`);
    const next = await suggestNextNo(db, cust.customerId!, 'PROFILE_ORDER');
    const created = await createProfileOrder(db, { actor: act(cust), firm: { id: cust.customer!.id, prefix: cust.customer!.prefix! }, title: 'Teslimat paketi', requestedNo: next, suggestedNo: next, items: items.items });
    orderId = created.id;
    orderNo = created.orderNo;
    const offer = await db.offer.findFirstOrThrow({ where: { orderId }, include: { lines: true } });
    await runProfileAction(db, { orderId, action: 'send_profile_offer', actor: act(admin), payload: { lines: offer.lines.map((l) => ({ id: l.id, offerPrice: '10' })) } });
    const sent = await db.offer.findFirstOrThrow({ where: { orderId, status: 'GONDERILDI' } });
    await runProfileAction(db, { orderId, action: 'approve_profile_offer', actor: act(cust), payload: { offerId: sent.id, pickupDate: earliestPickup({ now: new Date(Date.now() + 5 * 60_000) }), phone: '0723000000', plate: 'B 42 DEP' } });
    await runProfileAction(db, { orderId, action: 'mark_proforma', actor: act(admin), payload: { proformaNo: 'PF-P8' } });
    await runProfileAction(db, { orderId, action: 'send_to_warehouse', actor: act(admin), payload: {} });
    // Depo bağlantısı (e-postadaki adres) — işçi çalıştırılmadan: anahtarın özeti doğrudan yazılır
    depotToken = crypto.randomBytes(32).toString('base64url');
    await db.profileOrder.update({ where: { orderId }, data: { depotTokenHash: hashToken(depotToken), depotTokenExpiresAt: new Date(Date.now() + 7 * 86_400_000) } });
    expect((await db.profileOrder.findUniqueOrThrow({ where: { orderId } })).stage).toBe('DEPODA');
  } finally {
    await db.$disconnect();
  }
});

test('Ayarlar → Çalışma Takvimleri: iki ayrı takvim; resmî tatil; elle kapalı gün eklenir ve kaldırılır; yalnızca yönetici; mobilde taşma yok', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/entegrasyonlar');
  await admin.locator('[data-settings-tabs]').getByRole('link', { name: 'Çalışma Takvimleri' }).click();
  await expect(admin).toHaveURL(/\/admin\/entegrasyonlar\/takvimler/);
  await expect(admin.locator('[data-holiday-data]')).toContainText('2026, 2027');
  // Romanya: 30 Kasım resmî tatil (Sf. Andrei), 28 Kasım hafta sonu; Türkiye fabrikasında 30 Kasım çalışma günü
  await admin.goto('/admin/entegrasyonlar/takvimler?takvim=RO_DEPOT&ay=2026-11');
  await expect(admin.locator('[data-day="2026-11-30"]')).toHaveAttribute('data-reason', 'HOLIDAY');
  await expect(admin.locator('[data-day="2026-11-30"]')).toContainText('Sf. Andrei');
  await expect(admin.locator('[data-day="2026-11-28"]')).toHaveAttribute('data-reason', 'WEEKEND');
  await admin.locator('[data-calendar-tab="TR_FACTORY"]').click();
  await expect(admin.locator('#takvim')).toHaveAttribute('data-calendar', 'TR_FACTORY');
  await expect(admin.locator('[data-day="2026-11-30"]')).toHaveAttribute('data-reason', 'WORKDAY');
  // Türkiye: Kurban Bayramı 2027 (17 Mayıs pazartesi tatil; 15 Mayıs cumartesi → hafta sonu)
  await admin.goto('/admin/entegrasyonlar/takvimler?takvim=TR_FACTORY&ay=2027-05');
  await expect(admin.locator('[data-day="2027-05-17"]')).toHaveAttribute('data-reason', 'HOLIDAY');
  await expect(admin.locator('[data-day="2027-05-15"]')).toHaveAttribute('data-reason', 'WEEKEND');
  // Elle kapalı gün (Romanya deposu): ay görünümünde ve listede; Türkiye takvimi etkilenmez; kaldırılınca otomatik kurala döner
  await admin.goto('/admin/entegrasyonlar/takvimler?takvim=RO_DEPOT&ay=2027-02');
  await admin.fill('#ov-day', '2027-02-10');
  await admin.selectOption('#ov-mode', 'CLOSED');
  await admin.fill('#ov-note', 'Envanter sayımı');
  await admin.locator('#isaretle').getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(admin.getByText('Takvim kaydedildi.')).toBeVisible();
  await expect(admin.locator('[data-day="2027-02-10"]')).toHaveAttribute('data-reason', 'MANUAL_CLOSED');
  await expect(admin.locator('tr[data-override="2027-02-10"]')).toContainText('Envanter sayımı');
  await admin.goto('/admin/entegrasyonlar/takvimler?takvim=TR_FACTORY&ay=2027-02');
  await expect(admin.locator('[data-day="2027-02-10"]')).toHaveAttribute('data-reason', 'WORKDAY');
  await admin.goto('/admin/entegrasyonlar/takvimler?takvim=RO_DEPOT&ay=2027-02');
  await admin.locator('tr[data-override="2027-02-10"]').getByRole('button', { name: 'Kaldır', exact: true }).click();
  await expect(admin.getByText('Takvim kaydedildi.')).toBeVisible();
  await expect(admin.locator('[data-day="2027-02-10"]')).toHaveAttribute('data-reason', 'WORKDAY');
  await expect(admin.locator('tr[data-override="2027-02-10"]')).toHaveCount(0);
  const db = await prisma();
  try {
    const audits = await db.auditLog.findMany({ where: { action: 'WORK_CALENDAR_OVERRIDE', entityId: 'RO_DEPOT:2027-02-10' } });
    expect(audits.length, 'işaretleme ve kaldırma denetimde').toBe(2);
  } finally {
    await db.$disconnect();
  }
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto('/admin/entegrasyonlar/takvimler?takvim=RO_DEPOT&ay=2026-12');
  await noOverflow(admin, 'takvim');
  await admin.context().close();
  // Satış: sayfa açılmaz (kendi ana sayfasına döner)
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto('/admin/entegrasyonlar/takvimler');
  await expect(sales).toHaveURL(/\/siparisler/);
  await expect(sales.locator('#takvim')).toHaveCount(0);
  await sales.context().close();
});

test('müşteri: tahmini teslim günü (tahmini, stoktan bağımsız açıklamasıyla); değiştiremez; henüz fotoğraf / rapor yok; mobilde taşma yok', async ({ browser }) => {
  const db = await prisma();
  const p = await db.profileOrder.findUniqueOrThrow({ where: { orderId } });
  await db.$disconnect();
  const day = p.pickupDate!.toISOString().slice(0, 10);
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/siparisler/${orderId}`);
  const card = cust.locator('#teslim');
  await expect(card.locator('h2')).toHaveText('Teslimat');
  await expect(card.locator(`[data-delivery-date="${day}"]`)).toHaveText(dmy(day));
  await expect(card.locator('[data-delivery-note]')).toContainText('Bu tarih tahminidir');
  await expect(card.locator('[data-delivery-note]')).toContainText('Stok durumu hesaba katılmaz');
  await expect(card).toContainText(/Depoda hazırlanıyor|Teslimata hazır/);
  await expect(card.getByText('Bilgileri değiştir')).toHaveCount(0);
  await expect(cust.locator('#teslimat [data-no-photos]')).toBeVisible();
  await expect(cust.locator('#teslimat [data-no-reports]')).toBeVisible();
  await expect(cust.locator('#teslimat input[type=file]')).toHaveCount(0);
  await expect(cust.locator('#teslimat').getByRole('button', { name: 'Teslimat raporu oluştur' })).toHaveCount(0);
  await cust.setViewportSize({ width: 390, height: 844 });
  await cust.reload();
  await noOverflow(cust, 'müşterinin profil siparişi');
  await cust.context().close();
});

test('yönetici: teslim gününü depoda iken değiştirir → müşteriye TEK bildirim (zil); aynı gün yeniden → yeni bildirim yok', async ({ browser }) => {
  const db = await prisma();
  const { isOpenDay, addDaysKey } = await import('../server/calendar/rules.js');
  const before = (await db.profileOrder.findUniqueOrThrow({ where: { orderId } })).pickupDate!.toISOString().slice(0, 10);
  let next = addDaysKey(before, 1);
  while (!isOpenDay('RO_DEPOT', next)) next = addDaysKey(next, 1);
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const save = async (day: string) => {
    await admin.goto(`/siparisler/${orderId}`);
    await admin.locator('#teslim summary', { hasText: 'Bilgileri değiştir' }).click();
    await admin.fill('#up-date', day);
    await admin.locator('#teslim').getByRole('button', { name: 'Kaydet', exact: true }).click();
  };
  await save(next);
  await expect(admin.getByText('Teslim günü değiştirildi; müşteriye bildirildi.')).toBeVisible();
  await expect(admin.locator(`#teslim [data-delivery-date="${next}"]`)).toBeVisible();
  await save(next); // aynı gün
  await expect(admin.getByText('Teslim bilgileri güncellendi.')).toBeVisible();
  await admin.context().close();
  try {
    // Değişiklik başına tek olay (outbox) → firmanın her müşteri kullanıcısına tek bildirim; iç ekibe yok
    expect(await db.notificationOutbox.count({ where: { orderId, type: 'ORDER_DELIVERY_DATE_CHANGED' } })).toBe(1);
    const rows = await db.notification.findMany({ where: { orderId, type: 'ORDER_DELIVERY_DATE_CHANGED' }, include: { user: { select: { email: true, appRole: true } } } });
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(1);
    expect(rows.filter((r) => r.user.email === CUSTOMER).length).toBe(1);
    expect(rows.every((r) => r.user.appRole === 'MUSTERI' && r.link === `/siparisler/${orderId}#teslim`)).toBe(true);
  } finally {
    await db.$disconnect();
  }
  // Müşterinin zili yeni günü yazar; sipariş sayfası yeni günü gösterir
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const feed = await (await cust.request.get('/bildirimler/akis')).json() as { items: { title: string; body: string; link: string | null }[] };
  const item = feed.items.find((i) => i.link === `/siparisler/${orderId}#teslim`);
  expect(item?.title).toBe('Tahmini teslim gününüz değişti');
  expect(item?.body).toContain(`yeni tahmini teslim günü ${dmy(next)}`);
  await cust.goto(`/siparisler/${orderId}`);
  await expect(cust.locator(`#teslim [data-delivery-date="${next}"]`)).toHaveText(dmy(next));
  await expect(cust.locator('.timeline')).toContainText('Tahmini teslim gününüz değişti');
  await cust.context().close();
});

test('fotoğraflar (yönetici): birden çok, her biri ayrı; hatalı biri ötekileri silmez; aynı fotoğraf tekrar kayıt olmaz; rapor oluşur', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${orderId}`);
  const box = admin.locator('#teslimat');
  await admin.setInputFiles('#dl-photos', [jpeg('kapi-1.jpg'), { name: 'sahte.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('bu bir fotoğraf değil') }, jpeg('kapi-2.jpg')]);
  await box.getByRole('button', { name: 'Yükle', exact: true }).click();
  await expect(box.locator('[data-upload-state]')).toHaveCount(3);
  await expect(box.locator('[data-upload-state="done"]')).toHaveCount(2);
  await expect(box.locator('[data-upload-state="error"]')).toContainText('Dosyanın içeriği uzantısıyla uyuşmuyor.');
  await expect(box.locator('progress')).toHaveAttribute('value', '3');
  await expect(box.locator('.photo-tile')).toHaveCount(2);
  // Aynı fotoğraf (başka adla) yeniden: "zaten yüklenmiş", yeni kayıt yok
  await admin.setInputFiles('#dl-photos', [jpeg('kapi-1-kopya.jpg', 'kapi-1.jpg')]);
  await box.getByRole('button', { name: 'Yükle', exact: true }).click();
  await expect(box.locator('[data-upload-state="duplicate"]')).toHaveCount(1);
  await admin.reload();
  await expect(admin.locator('#teslimat .photo-tile')).toHaveCount(2);
  // Teslimat raporu #1
  await admin.fill('#dr-note', 'İki koli, sağlam teslim.');
  await admin.locator('#teslimat').getByRole('button', { name: 'Teslimat raporu oluştur' }).click();
  await expect(admin.getByText('Teslimat raporu #1 oluşturuldu.')).toBeVisible();
  await expect(admin.locator('#teslimat [data-report="1"]')).toContainText('Güncel rapor');
  // Aynı içerik (aynı fotoğraflar ve açıklama): yeni rapor yok
  await admin.fill('#dr-note', 'İki koli, sağlam teslim.');
  await admin.locator('#teslimat').getByRole('button', { name: 'Teslimat raporu oluştur' }).click();
  await expect(admin.getByText('İçerik değişmediği için yeni rapor oluşturulmadı; rapor #1 geçerli.')).toBeVisible();
  await expect(admin.locator('#teslimat [data-report]')).toHaveCount(1);
  const href = await admin.locator('#teslimat [data-report="1"] a').getAttribute('href');
  expect(href).toMatch(/^\/dosya\/rapor\/[a-z0-9]+$/);
  const res = await admin.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect(res.headers()['content-disposition']).toBe(`inline; filename="Teslimat-Raporu-${orderNo}-1.pdf"`);
  expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto(`/siparisler/${orderId}#teslimat`);
  await noOverflow(admin, 'yöneticinin profil siparişi');
  await admin.context().close();
});

test('depo bağlantısı: fotoğraf yükler, rapor oluşturur, teslimi onaylar; ikinci onay (eski sekme) yeni olay / stok hareketi yazmaz', async ({ browser }) => {
  const db = await prisma();
  const moves = await db.stockMovement.count({ where: { orderId } });
  const ctx = await browser.newContext();
  const depot = await ctx.newPage();
  depot.on('dialog', (d) => d.accept());
  // Onaydan ÖNCE açılmış ikinci sekme (aynı formu sonra yeniden gönderecek)
  const stale = await ctx.newPage();
  stale.on('dialog', (d) => d.accept());
  await stale.goto(`/depo/${depotToken}`);
  await depot.goto(`/depo/${depotToken}`);
  await expect(depot.getByRole('heading', { name: 'Mal teslimi' })).toBeVisible();
  await depot.setInputFiles('#dep-photos', [jpeg('depo-1.jpg'), jpeg('depo-2.jpg')]);
  await depot.locator('#fotograflar').getByRole('button', { name: 'Yükle', exact: true }).click();
  await expect(depot.locator('#fotograflar [data-upload-state="done"]')).toHaveCount(2);
  await expect(depot.locator('[data-depot-photos] li')).toHaveCount(4);
  await depot.fill('#dep-note', 'Şoför imzaladı.');
  await depot.locator('#rapor').getByRole('button', { name: 'Teslimat raporu oluştur' }).click();
  await expect(depot.getByText('Teslimat raporu #2 oluşturuldu. Teşekkürler!')).toBeVisible();
  await expect(depot.locator('[data-depot-reports] li')).toHaveCount(2);
  // Teslim onayı (mevcut akış: imzalı belge + onay)
  await depot.setInputFiles('#dep-files', sampleFile('imza.pdf', 'imzali teslim P8'));
  await depot.getByRole('button', { name: 'Malı teslim ettim — onayla' }).click();
  await expect(depot.getByText('Teslim onaylandı. Teşekkürler!')).toBeVisible();
  await expect(depot.getByRole('button', { name: 'Malı teslim ettim — onayla' })).toHaveCount(0);
  // Eski sekmeden ikinci onay: belge eklenir, teslim yeniden işlenmez
  await stale.setInputFiles('#dep-files', sampleFile('imza-2.pdf', 'imzali teslim P8 ikinci'));
  await stale.getByRole('button', { name: 'Malı teslim ettim — onayla' }).click();
  await expect(stale.getByText('Teslim onaylandı. Teşekkürler!')).toBeVisible();
  await depot.setViewportSize({ width: 390, height: 844 });
  await depot.reload();
  await noOverflow(depot, 'depo bağlantısı');
  await ctx.close();
  try {
    expect(await db.orderEvent.count({ where: { orderId, event: 'DELIVERED' } })).toBe(1);
    expect(await db.notificationOutbox.count({ where: { orderId, type: 'ORDER_DELIVERED' } })).toBe(1);
    expect(await db.stockMovement.count({ where: { orderId } }), 'teslim stok hareketi yazmaz').toBe(moves);
    expect(await db.notificationOutbox.count({ where: { orderId, type: 'FGO_INVOICE' } }), 'FGO kapalı: kuyruğa fatura işi yok').toBe(0);
    expect(await db.orderFile.count({ where: { orderId, source: 'DEPOT_LINK' } }), 'iki imzalı belge').toBe(2);
  } finally {
    await db.$disconnect();
  }
});

test('erişim: müşteri kendi raporunu ve fotoğraflarını açar (teslimden sonra da); başka firma, satış açamaz; denetimci görür', async ({ browser }) => {
  const db = await prisma();
  const reports = await db.deliveryReport.findMany({ where: { orderId }, orderBy: { revision: 'asc' } });
  const photos = await db.deliveryPhoto.findMany({ where: { orderId } });
  await db.$disconnect();
  expect(reports.map((r) => r.revision)).toEqual([1, 2]);
  expect(photos.length).toBe(4);
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/siparisler/${orderId}`);
  await expect(cust.locator('#teslim')).toContainText('Teslim edildi');
  await expect(cust.locator('#teslimat .photo-tile')).toHaveCount(4);
  await expect(cust.locator('#teslimat [data-report="2"]')).toContainText('Güncel rapor');
  await expect(cust.locator('#teslimat [data-report="1"]')).toBeVisible();
  await expect(cust.locator('#teslimat')).not.toContainText('E2E Yönetici'); // müşteriye iç ekipten kişi adı gitmez
  await expect(cust.locator('.timeline')).toContainText('Teslimat raporu hazır');
  await expect(cust.locator('.timeline a[href="#teslimat"]'), 'geçmişteki rapor kayıtları raporların listesine götürür').toHaveCount(2);
  for (const r of reports) {
    const res = await cust.request.get(`/dosya/rapor/${r.id}`);
    expect(res.status(), `rapor #${r.revision}`).toBe(200);
    expect(res.headers()['content-disposition']).toBe(`inline; filename="Teslimat-Raporu-${orderNo}-${r.revision}.pdf"`);
  }
  const ph = await cust.request.get(`/dosya/teslimat/${photos[0].id}?ac=1`);
  expect([ph.status(), ph.headers()['content-type']]).toEqual([200, 'image/jpeg']);
  await cust.context().close();
  for (const [email, pw] of [[BETA, TEAM_PW], [SALES, TEAM_PW]] as const) {
    const page = await as(browser, email, pw);
    expect((await page.request.get(`/dosya/rapor/${reports[1].id}`)).status(), email).toBe(404);
    expect((await page.request.get(`/dosya/teslimat/${photos[0].id}?ac=1`)).status(), email).toBe(404);
    await page.context().close();
  }
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  expect((await insp.request.get(`/dosya/rapor/${reports[0].id}`)).status()).toBe(200);
  await insp.goto(`/siparisler/${orderId}`);
  await expect(insp.locator('#teslimat .photo-tile')).toHaveCount(4);
  await expect(insp.locator('#teslimat input[type=file]')).toHaveCount(0);
  await expect(insp.locator('#teslimat').getByRole('button', { name: 'Teslimat raporu oluştur' })).toHaveCount(0);
  await insp.context().close();
});

test('tedarikçi: tahmini yükleme tarihi Türkiye resmî tatiline denk gelirse uyarı; tarih değişmez', async ({ browser }) => {
  const { HOLIDAYS } = await import('../server/calendar/holidays.js');
  const today = new Date().toISOString().slice(0, 10);
  type H = { day: string; names: readonly string[]; half: boolean };
  const all = Object.values(HOLIDAYS.TR as Record<string, readonly H[]>).flat();
  const isWeekday = (d: string) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
  const holiday = all.find((h) => !h.half && h.day > today && isWeekday(h.day));
  test.skip(!holiday, 'kayıtlı ileri tarihli Türkiye tatili yok');
  const db = await prisma();
  const stamp = Date.now();
  const supplier = await db.supplier.create({ data: { name: `P8 Tedarikçi ${stamp}`, currency: 'EUR' } });
  const so = await db.supplierOrder.create({ data: { orderNo: `TS-P8-${stamp}`, supplierId: supplier.id, currency: 'EUR', status: 'GONDERILDI', sentAt: new Date() } });
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/tedarik/${so.id}`);
  await admin.locator('#eta input[type=date]').fill(holiday!.day);
  await admin.locator('#eta').getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(admin.getByText('Tahmini yükleme tarihi kaydedildi.')).toBeVisible();
  await expect(admin.locator('[data-eta-info]')).toHaveText(dmy(holiday!.day));
  await expect(admin.locator('[data-eta-calendar="closed"]')).toContainText('Türkiye fabrikasının kapalı günü');
  await admin.context().close();
  try {
    const after = await db.supplierOrder.findUniqueOrThrow({ where: { id: so.id } });
    expect(after.etaDate!.toISOString().slice(0, 10), 'tarih değişmedi').toBe(holiday!.day);
  } finally {
    await db.$disconnect();
  }
});
