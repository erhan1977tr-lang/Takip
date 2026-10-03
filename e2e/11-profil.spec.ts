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
  await cust.context().close();
});
