import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, sampleFile } from './helpers';

// Aşama 6 — profil siparişi: müşteri adet girer → yönetici fiyatlar ve gönderir → müşteri teslim bilgileriyle onaylar →
// proforma → ödeme teyidi (sipariş hemen depoya: stok düşer, Comanda Depozit PDF'li e-posta) → depo bağlantısından imzalı
// belgeyle teslim → fatura. Satış ve çizim bu siparişi hiçbir yerde görmez.
test.describe.configure({ mode: 'serial' });
const SALES = 'fiyat-satis@e2e.test'; // 08'de açıldı
let url = '';

async function stockOf(page: import('@playwright/test').Page, code: string) {
  await page.goto('/admin/stok');
  return (await page.locator('tr', { hasText: code }).first().locator('td.num').first().innerText()).trim();
}

test('yönetici: liste fiyatı ve stok girişi', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/profil-katalogu');
  await expect(admin.getByRole('heading', { name: 'Profil Kataloğu', level: 1 })).toBeVisible();
  await admin.locator('tr', { hasText: 'GK15' }).getByRole('link', { name: 'Düzenle' }).click();
  await expect(admin).toHaveURL(/urun=/);
  await expect(admin.locator('#pc-code')).toHaveValue('GK15');
  await admin.fill('#pc-price', '12,50');
  await admin.locator('#urun').getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin.getByText('Kaydedildi.')).toBeVisible();
  await expect(admin.locator('tr', { hasText: 'GK15' })).toContainText('12,50');

  await admin.goto('/admin/stok');
  const value = await admin.locator('#st-p option', { hasText: 'GK15 —' }).getAttribute('value');
  await admin.selectOption('#st-p', value!);
  await admin.fill('#st-q', '10');
  await admin.getByRole('button', { name: 'Kaydet', exact: true }).first().click();
  await expect(admin.getByText(/Stok hareketi kaydedildi/)).toBeVisible();
  expect(await stockOf(admin, 'GK15')).toBe('10');
  await admin.context().close();
});

test('müşteri: sipariş tipi seçer, profil ürünlerinin adetlerini girer', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto('/siparisler/yeni');
  await cust.getByRole('link', { name: /Profil siparişi/ }).click();
  await expect(cust).toHaveURL(/tip=PROFILE_ORDER/);
  await expect(cust.getByRole('heading', { name: 'Yeni Profil Siparişi' })).toBeVisible();
  await expect(cust.getByText('UNSP1')).toBeVisible(); // ayrı sıra: GLAP12 düzeni
  await expect(cust.getByText(/cursul de vânzare BT|BT satış kuru/)).toBeVisible();
  await cust.fill('#title', 'Depo aksesuar');
  await cust.locator('tr', { hasText: 'GK15' }).locator('input.qty-input').fill('4');
  await cust.locator('tr', { hasText: 'SPIGOTI' }).locator('input.qty-input').fill('20');
  await expect(cust.getByText('2 ürün seçildi')).toBeVisible();
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=profile_created/);
  url = new URL(cust.url()).pathname;
  await expect(cust.getByText('Teklifiniz hazırlanıyor.').first()).toBeVisible();
  // Stok yetersizliği (karar 165): sipariş ENGELLENMEDİ; müşteri uyarıyı ve ürünü görür ama stok sayısını görmez
  const warn = cust.locator('#stok.alert-warn');
  await expect(warn).toContainText('Stok uyarısı:');
  await expect(warn).toContainText('SPIGOTI');
  await expect(warn).not.toContainText('GK15'); // stoğu yeten ürün listede yok
  await expect(cust.locator('.page-head .badge', { hasText: 'Stok yetersiz' })).toBeVisible();
  await expect(cust.locator('table.stock-table')).toHaveCount(0);
  await expect(cust.getByText('Mevcut', { exact: true })).toHaveCount(0);
  // Profil siparişinde müşteri dosya yüklemez (karar 161): alan yok — sunucu da reddeder (aynı firmanın cam siparişindeki
  // "Dosya ekle" işlemini profil siparişi için doğrudan göndermek de dosya eklemez)
  await expect(cust.locator('input[type=file]')).toHaveCount(0);
  await expect(cust.getByRole('button', { name: 'Dosya ekle' })).toHaveCount(0);
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const profileId = url.split('/').pop()!;
    const profile = await db.order.findUniqueOrThrow({ where: { id: profileId } });
    const glass = await db.order.findFirstOrThrow({ where: { customerId: profile.customerId, orderTypeCode: 'GLASS_ORDER', status: { in: ['YENI', 'HAZIRLANIYOR', 'URETIMDE'] }, removedAt: null } });
    const html = await (await cust.request.get(`/siparisler/${glass.id}`)).text();
    const form = html.split('<form').find((c) => c.includes('name="files"'));
    const field = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form)?.[0] : undefined;
    expect(field, 'cam siparişinde "Dosya ekle" formu').toBeTruthy();
    const before = await db.orderFile.count({ where: { orderId: profileId } });
    await cust.request.post(url, {
      multipart: { [field!]: '', id: profileId, files: { name: 'profil-ek.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% profil\n%%EOF\n', 'latin1') } },
      headers: { origin: new URL(cust.url()).origin },
    });
    expect(await db.orderFile.count({ where: { orderId: profileId } })).toBe(before);
  } finally {
    await db.$disconnect();
  }
  await cust.context().close();
});

test('yönetici: stok yetersiz siparişi (karar 165) — gereken / mevcut / eksik tablosu, "Stok yetersiz" işareti, "Önemli kararlar" kaydı; karar verilince işaret kalkar', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(url);
  const card = admin.locator('#stok');
  await expect(card.locator('h2')).toContainText('Stok durumu');
  await expect(card.locator('h2 .badge')).toHaveText('Stok yetersiz');
  const row = card.locator('tr[data-stock-row="SPIGOTI"]');
  await expect(row.locator('td.num').nth(0)).toHaveText('20'); // gereken
  const have = Number(await row.locator('td.num').nth(1).innerText());
  await expect(row.locator('td.num').nth(2)).toHaveText(String(Math.max(0, 20 - have))); // eksik
  await expect(card.locator('tr[data-stock-row="GK15"]')).toHaveCount(0);
  // Yönetici sipariş listesinde işaret
  await admin.goto('/siparisler?view=all');
  await expect(admin.locator('tr', { has: admin.locator(`a[href="${url}"]`) }).first().locator('.badge', { hasText: 'Stok yetersiz' })).toBeVisible();
  // "Önemli kararlar": sipariş anındaki gereken / mevcut / eksik; bağlantı siparişin stok bölümüne
  await admin.goto('/admin/kararlar');
  const alert = admin.locator('.card').first().locator('tr', { hasText: 'Profil siparişi: stok yetersiz' }).filter({ hasText: 'UNSP1' });
  await expect(alert).toHaveCount(1);
  await expect(alert).toContainText('SPIGOTI');
  await expect(alert).toContainText('gereken 20');
  await expect(alert.getByRole('link', { name: 'UNSP1' })).toHaveAttribute('href', `${url}#stok`);
  await alert.getByRole('button', { name: 'Gördüm' }).click();
  await expect(admin.getByText('Kapatıldı.')).toBeVisible();
  await admin.goto(url);
  await expect(admin.locator('.page-head .badge', { hasText: 'Stok yetersiz' })).toHaveCount(0);
  await admin.context().close();
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(url);
  await expect(cust.locator('#stok')).toHaveCount(0); // karar verildi: müşterinin uyarısı da kalktı
  await cust.context().close();
});

test('satış ve çizim profil siparişini görmez', async ({ browser }) => {
  for (const email of [SALES, DRAWER]) {
    const page = await as(browser, email, TEAM_PW);
    await page.goto('/siparisler');
    await expect(page.getByText('UNSP1')).toHaveCount(0);
    const res = await page.goto(url);
    expect(res?.status(), email).toBe(404);
    await page.context().close();
  }
});

test('yönetici fiyatlar ve gönderir; müşteri teslim bilgileriyle onaylar', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(url);
  await expect(admin.getByLabel('GK15 — Birim fiyat (EUR)')).toHaveValue('12.50'); // katalog liste fiyatı
  await expect(admin.getByLabel('SPIGOTI — Birim fiyat (EUR)')).toHaveValue('');
  await admin.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(admin.getByText(/Fiyatı girilmemiş satır var/)).toBeVisible();
  await admin.getByLabel('SPIGOTI — Birim fiyat (EUR)').fill('3');
  await admin.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(admin.getByText('Teklif müşteriye gönderildi.')).toBeVisible();
  await expect(admin.getByText('Müşteri teklifi henüz onaylamadı.')).toBeVisible();

  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(url);
  await expect(cust.getByRole('heading', { name: 'Teklifiniz' })).toBeVisible();
  await expect(cust.locator('tfoot')).toContainText('110,00'); // 4 × 12,50 + 20 × 3
  await expect(cust.getByText(/cursul de vânzare BT|BT satış kuru/).first()).toBeVisible();
  await expect(cust.getByText('Liste fiyatı')).toHaveCount(0);
  await cust.fill('#pk-phone', '+40 723 000 000');
  await cust.fill('#pk-plate', 'b 123 abc');
  await cust.getByRole('button', { name: 'Teklifi onayla' }).click();
  await expect(cust.getByText('Teklifi onayladınız.', { exact: false })).toBeVisible();
  await expect(cust.locator('#teslim')).toContainText('B 123 ABC');
  await cust.context().close();
  await admin.context().close();
});

test('proforma → ödeme teyidi: sipariş hemen depoya gider, stok düşer, teslim bilgisi kilitlenir', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(url);
  await admin.fill('#pf-no', 'PF-1');
  await admin.getByRole('button', { name: 'Proforma kesildi' }).click();
  await expect(admin.getByText('Proforma kaydedildi.')).toBeVisible();
  await admin.getByRole('button', { name: 'Ödeme alındı' }).click();
  await expect(admin.getByText(/Ödeme kaydedildi; sipariş depoya gönderildi/)).toBeVisible();
  await expect(admin.getByText(/Depo e-postası:/)).toBeVisible();
  expect(await stockOf(admin, 'GK15')).toBe('6');

  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(url);
  await expect(cust.getByText(/teslim bilgileri artık değiştirilemez/)).toBeVisible();
  await expect(cust.getByText('Bilgileri değiştir')).toHaveCount(0);
  await cust.context().close();
  await admin.context().close();
});

test('depo e-postası (PDF) ve depo bağlantısından imzalı belgeyle teslim; fatura', async ({ browser }) => {
  // İşçi bir tur: e-posta MAIL_OUTBOX_DIR klasörüne yazılır
  execFileSync('node', ['scripts/worker.mjs', '--once'], { env: process.env, stdio: 'inherit' });
  const dir = process.env.MAIL_OUTBOX_DIR!;
  const file = fs.readdirSync(dir).filter((f) => f.includes('adrian@partnertrans.ro')).sort().pop();
  expect(file, 'depo e-postası yok').toBeTruthy();
  const msg = JSON.parse(fs.readFileSync(path.join(dir, file!), 'utf8'));
  expect(msg.to).toBe('adrian@partnertrans.ro, enis@gkh.ro');
  expect(msg.subject).toContain('Comanda depozit UNSP1');
  expect(msg.attachments[0].filename).toBe('Comanda-Depozit-UNSP1.pdf');
  expect(msg.attachments[0].size).toBeGreaterThan(1000);
  const token = /\/depo\/([A-Za-z0-9_-]+)/.exec(msg.text)![1];

  // Depo: giriş yok
  const ctx = await browser.newContext();
  const depot = await ctx.newPage();
  depot.on('dialog', (d) => d.accept());
  // Gövde kapısı (karar 143): geçerli depo bağlantısı OTURUMSUZ büyük gövde izni alır (Caddy'nin sorusu: özgün adres
  // X-Forwarded-Uri'de); bozuk / uydurma bağlantı almaz; bağlantı yalnızca kendi adresinde geçerlidir
  const gate = async (uri: string) => {
    const r = await depot.request.get('/oturum/govde-izni', { headers: { 'x-forwarded-uri': uri } });
    return { status: r.status(), header: r.headers()['x-takip-govde'] ?? null };
  };
  expect(await gate(`/depo/${token}`)).toEqual({ status: 204, header: 'izin' });
  expect(await gate(`/depo/${token}?e=file`)).toEqual({ status: 204, header: 'izin' });
  for (const bad of [`/depo/${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, `/depo/${'x'.repeat(43)}`, '/depo/kisa', `/depo/${token}/ek`, `/DEPO/${token}`, `/siparisler/${token}`, '/siparisler/yeni']) {
    expect(await gate(bad), bad.replace(token, '<anahtar>')).toEqual({ status: 401, header: null });
  }
  await depot.goto(`/depo/${token}`);
  await expect(depot.getByRole('heading', { name: 'Mal teslimi' })).toBeVisible();
  await expect(depot.getByText(/UNSP1/).first()).toBeVisible();
  await depot.setInputFiles('#dep-files', sampleFile('imza.pdf', 'imzali teslim'));
  await depot.getByRole('button', { name: 'Malı teslim ettim — onayla' }).click();
  await expect(depot.getByText('Teslim onaylandı. Teşekkürler!')).toBeVisible();
  await depot.goto('/depo/' + 'x'.repeat(43));
  await expect(depot.getByText('Bağlantı geçersiz ya da süresi dolmuş.')).toBeVisible();
  await ctx.close();

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(url);
  await expect(admin.getByText('imza.pdf').first()).toBeVisible();
  await expect(admin.getByRole('link', { name: 'Depo formu (PDF)' })).toBeVisible();
  await admin.fill('#inv-no', 'F-1');
  await admin.getByRole('button', { name: 'Faturalandı' }).click();
  await expect(admin.getByText('Fatura kaydedildi; sipariş arşivlendi.')).toBeVisible();
  await admin.context().close();

  // Müşteri iç dosyaları (depo formu, imzalı belge) görmez
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(url);
  await expect(cust.getByText('imza.pdf')).toHaveCount(0);
  await expect(cust.getByText(/Comanda-Depozit/)).toHaveCount(0);
  // Müşteri ekranı (karar 161): "Depoya gönderildi" yok; "Teslim" yalnızca tarih (saat yok); dosya yükleme alanı yok
  const info = cust.locator('dl.order-info');
  await expect(info.locator('dt', { hasText: 'Depoya gönderildi' })).toHaveCount(0);
  await expect(info.locator('div', { has: cust.locator('dt', { hasText: /^Teslim$/ }) }).locator('dd')).toHaveText(/^\d{2}\.\d{2}\.\d{4}$/);
  await expect(cust.locator('input[type=file]')).toHaveCount(0);
  expect(await (await cust.request.get(url)).text()).not.toContain('name="files"');
  await cust.context().close();
  // Yönetici "Depoya gönderildi" bilgisini görür; "Teslim" yine yalnızca tarih
  const admin2 = await as(browser, ADMIN, ADMIN_PW);
  await admin2.goto(url);
  await expect(admin2.locator('dl.order-info dt', { hasText: 'Depoya gönderildi' })).toHaveCount(1);
  await expect(admin2.locator('dl.order-info div', { has: admin2.locator('dt', { hasText: /^Teslim$/ }) }).locator('dd')).toHaveText(/^\d{2}\.\d{2}\.\d{4}( · .+)?$/);
  await admin2.context().close();
});
