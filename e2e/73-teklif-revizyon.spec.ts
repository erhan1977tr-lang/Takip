import { test, expect, type Browser, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, INSPECTOR_PW, TEAM_PW, as, fillOffer, newOrder } from './helpers';

// Müşteri teklif revizyonu (4.2.10, karar 306 — ürün sahibinin 27.10.2026 kararları):
//  - üretimdeki (URETIMDE) siparişte müşteri "Ölçülerde değişiklik var" → satışa revizyon taslağı; sipariş durumu değişmez
//  - satış: Teklifler → "Müşteri Revizyon Bekleyen Teklifler" (maskeli müşteri adı, notun özgün + Türkçe çevirisi), menüde
//    "Teklifler" sayacı; üretim uyarısı; "Yönetici Onayına Gönder"; yöneticiye gidince listeden çıkar
//  - yönetici: aynı uyarı; onaylayıp müşteriye gönderir → yeni sürüm yeniden onay ister; müşteri onaylar
//  - eski talep (ALE81 gibi, taslaksız): "Revizyon taslağını aç" — tek seferlik, not bu sırada bir kez çevrilir
//  - müşteri ve denetimci Türkçe çeviriyi ve uyarıyı görmez
// Çeviri sahte sağlayıcıyla (TRANSLATE_FAKE=1 — "[tr] …"); FGO / gerçek SMTP / Google'a istek yapılmaz. Sondaki adım üretim
// onayını ve not çevirisini yeniden kapatır (sonraki testler eski davranışla çalışır).
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test';
const INSPECTOR = 'denetim@e2e.test'; // 05'te açıldı
const WARNING = 'Sipariş üretimde. Teklif revizyonu fabrika üretimini veya çizimleri otomatik değiştirmez.';
const FAKE_KEY = 'e2e-sahte-anahtar-0123456789abcdef';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

async function setApproval(page: Page, on: boolean) {
  await page.goto('/admin/entegrasyonlar');
  const card = page.locator('#uretim-onayi');
  const box = card.locator('[data-production-approval-enabled]');
  if (on) await box.check();
  else await box.uncheck();
  await card.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.locator('[data-production-approval-state]')).toHaveAttribute('data-production-approval-state', on ? 'on' : 'off');
}

/** Not çevirisi (sahte sağlayıcı): açılır, anahtar yeniden kaydedilir (önceki testlerden bağımsız) */
async function setTranslate(page: Page, on: boolean) {
  await page.goto('/admin/entegrasyonlar');
  const card = page.locator('form#ceviri');
  await expect(card.locator('.alert-warn')).toContainText('TEST MODU'); // ağ güvencesi: sahte sağlayıcı
  if (on) {
    await card.locator('input[name=enabled]').check();
    await card.locator('input[name=apiKey]').fill(FAKE_KEY);
  } else await card.locator('input[name=enabled]').uncheck();
  await card.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page).toHaveURL(/ok=translate/);
}

/** Satış teklifi hazırlar ve yöneticiye gönderir; yönetici fiyatlayıp müşteriye gönderir */
async function prepareAndSend(browser: Browser, orderId: string) {
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
  await expect(admin.getByText(/^Fiyat onaylandı; teklif müşterinin panelinde\./)).toBeVisible();
  return { sales, admin };
}

/** Sipariş üretimde, müşterideki son sürüm onay bekliyor: müşteri onaylar (üretim) → yönetici "Teklifi güncelle" */
async function inProductionPending(browser: Browser, title: string, file: string) {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, title, file);
  const { sales, admin } = await prepareAndSend(browser, id);
  await cust.goto(`/siparisler/${id}`);
  await cust.locator('#uretim-onayi').getByRole('button', { name: 'ÜRETİME ALINMASINI ONAYLIYORUM' }).click();
  await expect(cust.getByText('Üretim onayınız alındı. Teşekkürler.')).toBeVisible();
  await admin.goto(`/siparisler/${id}?teklif=guncelle#teklif`);
  await admin.getByLabel('Müşteri fiyatı').first().fill('52');
  await admin.getByRole('button', { name: 'Teklifi güncelle ve müşteriye gönder' }).click();
  await expect(admin.getByText('Teklif güncellendi; müşteri yeni sürümü görüyor.')).toBeVisible();
  const db = await prisma();
  const o = await db.order.findUniqueOrThrow({ where: { id }, include: { customer: true, offers: { orderBy: { createdAt: 'desc' } } } });
  await db.$disconnect();
  expect(o.status).toBe('URETIMDE');
  expect(o.productionApprovalRequired).toBe(true);
  expect(o.offers[0].status).toBe('GONDERILDI');
  expect(o.offers[0].approvedAt).toBeNull();
  return { id, cust, sales, admin, orderNo: o.orderNo, firmName: o.customer.name, sentId: o.offers[0].id };
}

/** Menüdeki "Teklifler" sayacı (yoksa 0) */
async function badge(page: Page) {
  await page.goto('/siparisler');
  const n = page.locator('.sidebar a[href="/teklifler"] [data-nav-link-count]');
  return (await n.count()) ? Number(await n.getAttribute('data-nav-link-count')) : 0;
}

test.afterAll(async () => {
  // Güvenlik: başka testler eski davranışla çalışsın (üretim onayı ve not çevirisi kapalı; kayıtlı anahtar kalır)
  const db = await prisma();
  await db.integrationSetting.upsert({ where: { key: 'production-approval' }, create: { key: 'production-approval', value: { enabled: false } }, update: { value: { enabled: false } } });
  const tr = await db.integrationSetting.findUnique({ where: { key: 'translate' } });
  if (tr) await db.integrationSetting.update({ where: { key: 'translate' }, data: { value: { ...(tr.value as object), enabled: false } } });
  await db.$disconnect();
});

test('üretimdeki sipariş: müşteri talebi → satış listesi + sayaç + çeviri + uyarı → "Yönetici Onayına Gönder" → yönetici gönderir → yeni onay', async ({ browser }) => {
  const admin0 = await as(browser, ADMIN, ADMIN_PW);
  await setApproval(admin0, true);
  await setTranslate(admin0, true);
  const { id, cust, sales, admin, orderNo, firmName } = await inProductionPending(browser, 'Revizyon üretimde', 'revizyon-uretim.pdf');
  const before = await badge(sales);

  // Müşteri: değişiklik talebi (Romence not)
  const note = 'Lățimea primului rând trebuie să fie 1200 mm';
  await cust.goto(`/siparisler/${id}`);
  const card = cust.locator('#uretim-onayi');
  await card.getByText('ÖLÇÜLERDE DEĞİŞİKLİK VAR').click();
  await card.locator('#degisiklik-notu').fill(note);
  await card.getByRole('button', { name: 'Değişiklik talebini gönder' }).click();
  await expect(cust.getByText('Değişiklik talebiniz iletildi. Güncellenmiş teklif hazırlanınca size gönderilecek.')).toBeVisible();
  // Müşteri kendi notunun Türkçesini ve iç uyarıyı görmez
  await expect(cust.locator('[data-approval-state="CHANGE_REQUESTED"]')).toContainText(note);
  await expect(cust.locator('body')).not.toContainText(`[tr] ${note}`);
  await expect(cust.locator('[data-revision-production-warning]')).toHaveCount(0);

  // Satış: menü sayacı bir arttı; "Müşteri Revizyon Bekleyen Teklifler" listesinde maskeli ad + özgün not + Türkçe çeviri
  expect(await badge(sales)).toBe(before + 1);
  await sales.goto('/teklifler');
  const group = sales.locator('[data-group="customerRevision"]');
  await expect(group.locator('h2')).toContainText('Müşteri Revizyon Bekleyen Teklifler');
  const row = group.locator(`tr[data-revision-row="${orderNo}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-revision-stage', 'SALES');
  await expect(row).toContainText(note);
  await expect(row.locator('[data-translation="tr"]')).toContainText(`[tr] ${note}`);
  await expect(row).toContainText('Türkçe · otomatik çevrilmiştir');
  await expect(row).toContainText(`${firmName.slice(0, 3)}**********`);
  await expect(row).not.toContainText(firmName);
  // "Fiyatımı bekleyenler"de yeniden görünmez
  await expect(sales.locator(`[data-group="awaitingPrice"] a.order-no`, { hasText: orderNo })).toHaveCount(0);
  await row.getByRole('link', { name: 'Aç ve düzenle' }).click();
  await expect(sales).toHaveURL(new RegExp(`/siparisler/${id}`));

  // Sipariş sayfası: üretim uyarısı (engellemez), talep notu + Türkçe, düzenleyici; gönder düğmesinin adı
  await expect(sales.locator('[data-revision-production-warning]')).toHaveText(WARNING);
  await expect(sales.locator('#uretim-onayi [data-change-note] [data-translation="tr"]')).toContainText(`[tr] ${note}`);
  await expect(sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' })).toHaveCount(0);
  await sales.getByLabel('Boy', { exact: true }).first().fill('2100');
  await sales.getByRole('button', { name: 'Yönetici Onayına Gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  // Yöneticiye gönderilince listeden ve sayaçtan çıkar
  await sales.goto('/teklifler');
  await expect(sales.locator(`[data-group="customerRevision"] tr[data-revision-row="${orderNo}"]`)).toHaveCount(0);
  expect(await badge(sales)).toBe(before);

  // Denetimci: notu yalnızca özgün dilinde görür; uyarı yok
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(`/siparisler/${id}`);
  await expect(insp.locator('#uretim-onayi [data-change-note]')).toContainText(note);
  await expect(insp.locator('#uretim-onayi [data-translation]')).toHaveCount(0);
  await expect(insp.locator('[data-revision-production-warning]')).toHaveCount(0);

  // Yönetici: aynı uyarı; fiyatlayıp müşteriye gönderir → yeni sürüm yeniden onay ister; sipariş durumu değişmez
  await admin.goto(`/siparisler/${id}`);
  await expect(admin.locator('[data-revision-production-warning]')).toHaveText(WARNING);
  await admin.getByLabel('Müşteri fiyatı').first().fill('55');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText('Fiyat onaylandı; teklif müşterinin panelinde.', { exact: true })).toBeVisible();
  const db = await prisma();
  const o = await db.order.findUniqueOrThrow({ where: { id }, include: { offers: { orderBy: { createdAt: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } } });
  expect(o.status).toBe('URETIMDE');
  expect(o.offers.map((x) => [x.status, !!x.changeRequestedAt, !!x.approvedAt])).toEqual([['GONDERILDI', false, true], ['GONDERILDI', true, false], ['GONDERILDI', false, false]]);
  expect(o.offers[1].translation).toBe(`[tr] ${note}`);
  expect(o.offers[2].approvalRequestedAt).not.toBeNull();
  expect(o.offers[2].lines[0].boyMm).toBe(2100);
  await db.$disconnect();

  // Müşteri: yeni sürüm onay bekler; onaylar
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.locator('#uretim-onayi [data-approval-state="PENDING"]')).toBeVisible();
  await cust.locator('#uretim-onayi').getByRole('button', { name: 'ÜRETİME ALINMASINI ONAYLIYORUM' }).click();
  await expect(cust.getByText('Üretim onayınız alındı. Teşekkürler.')).toBeVisible();
  const d2 = await prisma();
  const o2 = await d2.order.findUniqueOrThrow({ where: { id }, include: { offers: { orderBy: { createdAt: 'desc' }, take: 1 } } });
  expect([o2.status, !!o2.offers[0].approvedAt]).toEqual(['URETIMDE', true]);
  await d2.$disconnect();
});

test('eski talep (ALE81 gibi, taslaksız): "Revizyon taslağını aç" tek seferlik; talep değişmez; not bu sırada bir kez Türkçeye çevrilir', async ({ browser }) => {
  const admin0 = await as(browser, ADMIN, ADMIN_PW);
  await setApproval(admin0, true);
  await setTranslate(admin0, true);
  const { id, sales, orderNo, sentId } = await inProductionPending(browser, 'Revizyon eski talep', 'revizyon-eski.pdf');
  // 4.2.9'un üretimdeki siparişte bıraktığı durum: talep kaydı var, taslak yok, not çevrilmemiş
  const note = 'Rândul 2 are dimensiuni greșite';
  const db = await prisma();
  const cust = await db.user.findFirstOrThrow({ where: { email: CUSTOMER } });
  const at = new Date(Date.now() - 3_600_000);
  await db.offer.update({ where: { id: sentId }, data: { changeRequestedAt: at, changeRequestedById: cust.id, changeNote: note } });
  await db.$disconnect();

  await sales.goto('/teklifler');
  const row = sales.locator(`[data-group="customerRevision"] tr[data-revision-row="${orderNo}"]`);
  await expect(row).toHaveAttribute('data-revision-stage', 'NO_DRAFT');
  await expect(row).toContainText('Taslak açılmadı');
  await sales.goto(`/siparisler/${id}`);
  const info = sales.locator('#uretim-onayi[data-revision-stage="NO_DRAFT"]');
  await expect(info).toContainText('Bu talep için revizyon taslağı henüz açılmadı.');
  await expect(info.locator('[data-translation]')).toHaveCount(0); // henüz çevrilmedi; sayfa açılışı çevirmez
  await info.getByRole('button', { name: 'Revizyon taslağını aç' }).click();
  await expect(sales.getByText('Revizyon taslağı açıldı. Teklifi düzeltip “Yönetici Onayına Gönder” ile yöneticiye gönderin.')).toBeVisible();
  await expect(sales.locator('#uretim-onayi [data-translation="tr"]')).toContainText(`[tr] ${note}`);
  await expect(sales.getByRole('button', { name: 'Revizyon taslağını aç' })).toHaveCount(0);
  await expect(sales.getByRole('button', { name: 'Yönetici Onayına Gönder' })).toBeVisible();
  await expect(sales.locator('[data-revision-production-warning]')).toHaveText(WARNING);

  const d2 = await prisma();
  const o = await d2.order.findUniqueOrThrow({ where: { id }, include: { offers: { orderBy: { createdAt: 'asc' } } } });
  expect(o.status).toBe('URETIMDE');
  expect(o.offers.at(-1)!.status).toBe('HAZIRLANIYOR');
  const req = o.offers.find((x) => x.id === sentId)!;
  expect([req.status, req.changeRequestedAt?.toISOString(), req.changeNote, req.translationStatus]).toEqual(['GONDERILDI', at.toISOString(), note, 'DONE']);
  const audit = await d2.auditLog.findFirst({ where: { action: 'ORDER_TRANSITION', entityId: id, details: { path: ['action'], equals: 'open_revision_draft' } } });
  expect((audit?.details as { legacy?: boolean }).legacy).toBe(true);
  // Yenileme ikinci taslak / ikinci çeviri üretmez
  await sales.reload();
  expect(await d2.offer.count({ where: { orderId: id } })).toBe(o.offers.length);
  await d2.$disconnect();

  // Ayarlar kapatılır (sonraki testler eski davranışla)
  await setTranslate(admin0, false);
  await setApproval(admin0, false);
});
