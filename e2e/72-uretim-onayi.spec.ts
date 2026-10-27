import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, TEAM_PW, as, fillOffer, newOrder } from './helpers';

// Müşteri üretim onayı (4.2.1, karar 305):
//  - ayar (Ayarlar → Entegrasyonlar → Müşteri üretim onayı) yalnızca yeni siparişleri kapsar; kapalıyken eski davranış
//  - yönetici teklifi gönderince sipariş üretime geçmez; müşteri panelinde zil, "Onay gerekli", "Üretim onayı gereklidir",
//    son onay tarihi ve iki işlem; "Üretime alınmasını onaylıyorum" (ikinci doğrulama) → üretim; iç ekip durumu görür
//  - "Ölçülerde değişiklik var": zorunlu açıklama → satışa yeni taslak; satış düzeltir, yönetici gönderir, yeniden onay
//  - 4.2.5: süre talep müşteriye İLETİLİNCE başlar (işçinin e-posta turu; e-postalar MAIL_OUTBOX_DIR'e yazılır);
//    onaysız yükleme engeli ("Yüklendi" düğmesi yerine engel kartı, "Yükleme yapıldı" engelli siparişleri listeler) ve
//    yalnızca yöneticinin gerekçeli istisnası
// FGO / gerçek SMTP / Google'a istek yapılmaz. Sondaki adım ayarı yeniden kapatır (sonraki testler eski davranışla çalışır).
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

async function setApproval(page: import('@playwright/test').Page, on: boolean) {
  await page.goto('/admin/entegrasyonlar');
  const card = page.locator('#uretim-onayi');
  await expect(card).toBeVisible();
  const box = card.locator('[data-production-approval-enabled]');
  if (on) await box.check();
  else await box.uncheck();
  await card.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Üretim onayı ayarı kaydedildi.')).toBeVisible();
  await expect(page.locator('[data-production-approval-state]')).toHaveAttribute('data-production-approval-state', on ? 'on' : 'off');
}

/** Satış "Teklife Gönder" + tabloyu doldurur ve yöneticiye gönderir; yönetici fiyatlayıp müşteriye gönderir */
async function prepareAndSend(browser: import('@playwright/test').Browser, orderId: string) {
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${orderId}`);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await fillOffer(sales, '40');
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${orderId}`);
  await admin.getByLabel('Müşteri fiyatı').first().fill('50');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  // İşlemin bitmesi beklenir (ayar açıkken "üretime alındı" cümlesi yok; kapalıyken var — ikisi de bu başlangıçla)
  await expect(admin.getByText(/^Fiyat onaylandı; teklif müşterinin panelinde\./)).toBeVisible();
  return { sales, admin };
}

/** İşçinin turu (e-posta + zil) talep müşteriye iletilene kadar — kuyrukta önceki testlerin olayları olabilir */
async function deliver(offerId: string) {
  const db = await prisma();
  try {
    for (let i = 0; i < 15; i++) {
      execFileSync('node', ['scripts/worker.mjs', '--once'], { env: process.env, stdio: 'inherit' });
      const o = await db.offer.findUnique({ where: { id: offerId } });
      if (o?.approvalDeliveredAt) return o;
    }
    throw new Error('onay talebi iletilmedi');
  } finally {
    await db.$disconnect();
  }
}

test.afterAll(async () => {
  // Güvenlik: başka testler eski davranışla çalışsın
  const db = await prisma();
  await db.integrationSetting.upsert({ where: { key: 'production-approval' }, create: { key: 'production-approval', value: { enabled: false } }, update: { value: { enabled: false } } });
  await db.$disconnect();
});

test('ayar kapalıyken: teklif gönderilince sipariş eskisi gibi üretime geçer, müşteriye onay sorulmaz', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await setApproval(admin, false);
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Onay kapalı', 'onay-kapali.pdf');
  const { admin: a } = await prepareAndSend(browser, id);
  await expect(a.getByText('Fiyat onaylandı; teklif müşterinin panelinde. Çizim onaylı (ya da gereksiz) olduğu için sipariş otomatik olarak üretime alındı.')).toBeVisible();
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.locator('[data-approval-state]')).toHaveCount(0);
  await expect(cust.getByRole('button', { name: 'ÜRETİME ALINMASINI ONAYLIYORUM' })).toHaveCount(0);
});

test('ayar açıkken: onay beklenir; müşteri paneli uyarıları; onay → üretim; iç ekip durumu görür', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await setApproval(admin, true);
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Onay açık', 'onay-acik.pdf');
  const { admin: a, sales } = await prepareAndSend(browser, id);
  await expect(a.getByText('Fiyat onaylandı; teklif müşterinin panelinde.', { exact: true })).toBeVisible();
  // Yönetici: üretime geçmedi; onay durumu görünür — talep henüz iletilmedi, süre başlamadı (4.2.5)
  await expect(a.locator('#uretim-onayi[data-approval-state="PENDING"]')).toContainText('Müşterinin üretim onayı bekleniyor');
  await expect(a.locator('#uretim-onayi')).toHaveAttribute('data-approval-delivery', 'WAITING');
  await expect(a.locator('#uretim-onayi')).toContainText('Talep müşteriye henüz iletilmedi — süre başlamadı.');

  // Müşteri: liste, durum, zil, son tarih, iki işlem
  await cust.goto('/siparisler');
  const row = cust.locator('tr', { hasText: 'Onay açık' });
  await expect(row.locator('[data-approval-needed]')).toHaveText('Onay gerekli');
  await expect(row).toContainText('Üretim onayı gereklidir');
  const db = await prisma();
  const order = await db.order.findUnique({ where: { id }, include: { offers: { orderBy: { createdAt: 'desc' } } } });
  expect(order?.productionApprovalRequired).toBe(true);
  expect(order?.status).toBe('HAZIRLANIYOR');
  const sent = order!.offers[0];
  expect(sent.approvalRequestedAt).not.toBeNull();
  expect(sent.approvalDueAt).toBeNull();
  const bell = await db.notification.findFirst({ where: { orderId: id, type: 'ORDER_OFFER_SENT', user: { email: CUSTOMER } } });
  // Zil metni okuyanın dilinde sunucuda üretilir (renderInApp): onay işareti var, son tarih yok (iletimde belirlenir)
  expect((bell?.params as { approval?: number; due?: string }).approval).toBe(1);
  expect((bell?.params as { approval?: number; due?: string }).due).toBeUndefined();
  const ev = await db.notificationOutbox.findFirst({ where: { orderId: id, type: 'ORDER_OFFER_SENT' } });
  expect((ev?.payload as { approval?: { offerId?: string } }).approval?.offerId).toBe(sent.id);
  await db.$disconnect();
  // Müşteri: iletilmeden önce son tarih yok
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.locator('#uretim-onayi [data-approval-due]')).toContainText('talep size e-postayla iletildiği anda başlar');
  // İşçi e-postayı gönderir → iletim anı + son tarih (2 Romanya iş günü)
  const delivered = await deliver(sent.id);
  expect(delivered.approvalDeliveryChannel).toBe('EMAIL');
  expect(delivered.approvalDueAt).not.toBeNull();
  await a.goto(`/siparisler/${id}`);
  await expect(a.locator('#uretim-onayi')).toHaveAttribute('data-approval-delivery', 'DELIVERED');
  await expect(a.locator('#uretim-onayi')).toContainText('Son onay tarihi:');
  await expect(a.locator('#uretim-onayi')).toContainText('Müşteriye iletildi:');

  await cust.goto(`/siparisler/${id}`);
  const card = cust.locator('#uretim-onayi');
  await expect(card.locator('[data-approval-state="PENDING"]')).toBeVisible();
  await expect(card).toContainText('Üretim onayınız bekleniyor');
  await expect(card).toContainText('Son onay tarihi:');
  await expect(card).toContainText('(Romanya saati)');
  await expect(cust.locator('.page-head')).toContainText('Üretim onayı gereklidir');
  await expect(card.getByRole('button', { name: 'ÜRETİME ALINMASINI ONAYLIYORUM' })).toBeVisible();
  await expect(card.getByText('ÖLÇÜLERDE DEĞİŞİKLİK VAR')).toBeVisible();

  // Satış: aynı durumu görür, onay işlemi yok
  await sales.goto(`/siparisler/${id}`);
  await expect(sales.locator('#uretim-onayi[data-approval-state="PENDING"]')).toBeVisible();
  await expect(sales.getByRole('button', { name: 'ÜRETİME ALINMASINI ONAYLIYORUM' })).toHaveCount(0);

  // Onay (ikinci doğrulama penceresi `as` tarafından kabul edilir) → üretim
  await card.getByRole('button', { name: 'ÜRETİME ALINMASINI ONAYLIYORUM' }).click();
  await expect(cust.getByText('Üretim onayınız alındı. Teşekkürler.')).toBeVisible();
  await expect(cust.locator('.page-head')).toContainText('Onaylandı, üretimde');
  const db2 = await prisma();
  const after = await db2.order.findUnique({ where: { id }, include: { offers: true, events: true } });
  expect(after?.status).toBe('URETIMDE');
  expect(after?.offers[0].approvedAt).not.toBeNull();
  expect(after?.events.map((e) => e.event)).toContain('PRODUCTION_APPROVED');
  const notified = await db2.notification.findMany({ where: { orderId: id, type: 'ORDER_PRODUCTION_APPROVED' }, include: { user: { select: { email: true } } } });
  expect(notified.map((n) => n.user.email)).toEqual(expect.arrayContaining([ADMIN, SALES]));
  await db2.$disconnect();
});

test('ölçülerde değişiklik var: açıklama zorunlu; satış düzeltir, yönetici gönderir; yeni sürüm yeniden onay ister', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await setApproval(admin, true);
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Onay değişiklik', 'onay-degisiklik.pdf');
  const { sales } = await prepareAndSend(browser, id);
  await cust.goto(`/siparisler/${id}`);
  const card = cust.locator('#uretim-onayi');
  await card.getByText('ÖLÇÜLERDE DEĞİŞİKLİK VAR').click();
  await expect(card.locator('#degisiklik-notu')).toHaveAttribute('required', '');
  await card.locator('#degisiklik-notu').fill('1. satırın boyu 2100 mm olmalı');
  await card.getByRole('button', { name: 'Değişiklik talebini gönder' }).click();
  await expect(cust.getByText('Değişiklik talebiniz iletildi. Güncellenmiş teklif hazırlanınca size gönderilecek.')).toBeVisible();
  await expect(cust.locator('[data-approval-state="CHANGE_REQUESTED"]')).toContainText('1. satırın boyu 2100 mm olmalı');
  await expect(cust.getByRole('button', { name: 'ÜRETİME ALINMASINI ONAYLIYORUM' })).toHaveCount(0);

  // Satış: müşterinin notunu görür, tabloyu düzeltip yöneticiye gönderir (müşteriye doğrudan gönderemez)
  await sales.goto(`/siparisler/${id}`);
  await expect(sales.locator('#uretim-onayi[data-approval-state="CHANGE_REQUESTED"] [data-change-note]')).toHaveText('1. satırın boyu 2100 mm olmalı');
  await sales.getByLabel('Boy', { exact: true }).first().fill('2100');
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  await admin.goto(`/siparisler/${id}`);
  await admin.getByLabel('Müşteri fiyatı').first().fill('50');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText('Fiyat onaylandı; teklif müşterinin panelinde.', { exact: true })).toBeVisible();

  // Müşteri: yeni sürüm yeniden onay ister; onaylanınca üretim
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.locator('#uretim-onayi [data-approval-state="PENDING"]')).toBeVisible();
  await cust.locator('#uretim-onayi').getByRole('button', { name: 'ÜRETİME ALINMASINI ONAYLIYORUM' }).click();
  await expect(cust.getByText('Üretim onayınız alındı. Teşekkürler.')).toBeVisible();
  const db = await prisma();
  const o = await db.order.findUnique({ where: { id }, include: { offers: { orderBy: { createdAt: 'asc' } } } });
  expect(o?.status).toBe('URETIMDE');
  expect(o?.offers.map((x) => [x.status, !!x.changeRequestedAt, !!x.approvedAt])).toEqual([['GONDERILDI', true, false], ['GONDERILDI', false, true]]);
  await db.$disconnect();

  // Ayar yeniden kapatılır (sonraki testler eski davranışla)
  await setApproval(admin, false);
});

test('onaysız yükleme engeli: "Yüklendi" yerine engel; yalnızca yönetici gerekçeli istisna verir; yükleme günü engelli siparişi listeler', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await setApproval(admin, false);
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Onay yükleme engeli', 'onay-yukleme.pdf');
  const { sales } = await prepareAndSend(browser, id);
  // Geçişin yaptığı gibi: üretimdeki sipariş kapsama alınır, güncel sürüme onay talebi açılır. Kesim günü bu test için
  // geçmişe alınır (yükleme günü bugünden önce olmalı — gelecekteki gün onaylanamaz)
  const db = await prisma();
  const past = new Date(Date.now() - 3 * 86_400_000);
  const day = past.toISOString().slice(0, 10);
  const offer = await db.offer.findFirst({ where: { orderId: id }, orderBy: { createdAt: 'desc' } });
  await db.order.update({ where: { id }, data: { productionApprovalRequired: true, estimatedShipDate: new Date(`${day}T10:00:00Z`) } });
  await db.offer.update({ where: { id: offer!.id }, data: { approvalRequestedAt: new Date() } });
  await db.integrationSetting.update({ where: { key: 'production-approval' }, data: { value: { enabled: true, cutoff: '2026-01-01' } } });
  expect((await db.order.findUnique({ where: { id } }))?.status).toBe('URETIMDE');
  await db.$disconnect();

  // Satış: "Yüklendi" yok, engel kartı var, istisna formu yok
  await sales.goto(`/siparisler/${id}`);
  await expect(sales.locator('#yukleme-izni[data-loading-blocked]')).toContainText('Yükleme engelli: müşterinin üretim onayı yok.');
  await expect(sales.getByRole('button', { name: 'Yüklendi olarak işaretle', exact: true })).toHaveCount(0);
  await expect(sales.getByText('Onaysız yükleme istisnası (yalnızca yönetici)')).toHaveCount(0);

  // Yükleme günü: engelli sipariş listelenir, "Yükleme yapıldı" düğmesi yok
  await admin.goto(`/yuklemeler?gun=${day}#onay`);
  const blocked = admin.locator('[data-approval-blocked]');
  await expect(blocked).toBeVisible();
  const orderNo = await (async () => { const d = await prisma(); const o = await d.order.findUnique({ where: { id } }); await d.$disconnect(); return o!.orderNo; })();
  await expect(blocked).toContainText(orderNo);
  await expect(blocked).toContainText('müşteri onayı bekleniyor');
  await expect(admin.locator('#onay').getByRole('button', { name: 'Yükleme yapıldı' })).toHaveCount(0);

  // Yönetici: gerekçeli istisna (müşteri onayı sayılmaz)
  await admin.goto(`/siparisler/${id}`);
  const gate = admin.locator('#yukleme-izni');
  await gate.getByText('Onaysız yükleme istisnası (yalnızca yönetici)').click();
  await gate.locator('#istisna-gerekce').fill('Müşteri telefonla onay verdi; yazılı onay bekleniyor');
  await gate.getByRole('button', { name: 'İstisnai yükleme izni ver' }).click();
  await expect(admin.getByText('Yükleme istisnası kaydedildi. Müşteri onayı olarak sayılmaz; denetim kaydına yazıldı.')).toBeVisible();
  await expect(admin.locator('#yukleme-izni[data-loading-override]')).toContainText('Müşteri telefonla onay verdi');
  // Müşteri istisnayı görmez; onay kartı hâlâ onay bekler
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.locator('#yukleme-izni')).toHaveCount(0);
  await expect(cust.locator('#uretim-onayi [data-approval-state="PENDING"]')).toBeVisible();
  // Satış artık "Yüklendi" yapabilir
  await sales.goto(`/siparisler/${id}`);
  await expect(sales.getByRole('button', { name: 'Yüklendi olarak işaretle', exact: true })).toBeVisible();
  const d2 = await prisma();
  const o2 = await d2.order.findUnique({ where: { id }, include: { offers: { orderBy: { createdAt: 'desc' }, take: 1 } } });
  expect(o2?.loadingOverrideReason).toBe('Müşteri telefonla onay verdi; yazılı onay bekleniyor');
  expect(o2?.offers[0].approvedAt).toBeNull();
  const audit = await d2.auditLog.findFirst({ where: { action: 'ORDER_TRANSITION', entityId: id, details: { path: ['action'], equals: 'override_loading_approval' } } });
  expect(audit).not.toBeNull();
  await d2.$disconnect();
  await setApproval(admin, false);
});
