import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, GLASS, GLASS_RO } from './helpers';

// Romence / Türkçe: giriş sayfasının dili (IP, tarayıcı dili), dil düğmeleri, girişte panele taşınan dil.
test.describe.configure({ mode: 'serial' });

const HAS_GEO = !/generated:\s*null/.test(fs.readFileSync('server/geo/ranges.js', 'utf8'));
const RAW_KEY = /\b(common|status|events|order|offer|orders|newOrder|offers|loading|admin|auth|nav|roles|demo|files|offerProblems|lang)\.[A-Za-z_]+(\.[A-Za-z_]+)*\b/;

async function ctx(browser: Browser, opts: { locale?: string; ip?: string } = {}): Promise<Page> {
  const c = await browser.newContext({
    locale: opts.locale ?? 'en-US',
    extraHTTPHeaders: opts.ip ? { 'x-forwarded-for': opts.ip } : undefined,
  });
  const page = await c.newPage();
  page.on('dialog', (d) => d.accept());
  return page;
}

async function shot(page: Page, name: string) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `ro-${name}.png`), fullPage: true });
}

test('IP ve tarayıcı dili bilinmiyorsa giriş sayfası Romence açılır', async ({ browser }) => {
  const page = await ctx(browser);
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Intră în cont' })).toBeVisible();
  await expect(page.getByLabel('Parolă')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ro');
  await expect(page.locator('.lang-switch a.active')).toHaveText('RO');
  await shot(page, '01-giris');
});

test('tarayıcı dili Türkçeyse Türkçe; dil düğmesiyle değişir ve hatırlanır', async ({ browser }) => {
  const page = await ctx(browser, { locale: 'tr-TR' });
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
  await page.locator('.lang-switch').getByRole('link', { name: 'RO' }).click();
  await expect(page.getByRole('button', { name: 'Intră în cont' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Intră în cont' })).toBeVisible(); // çerez hatırlar
  await page.locator('.lang-switch').getByRole('link', { name: 'TR' }).click();
  await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
});

test('IP adresine göre: Türkiye → Türkçe, Romanya → Romence (tarayıcı dilinden önce)', async ({ browser }) => {
  test.skip(!HAS_GEO, 'IP aralık verisi yok');
  const tr = await ctx(browser, { ip: '78.180.10.10', locale: 'ro-RO' }); // Türk Telekom bloğu
  await tr.goto('/login');
  await expect(tr.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
  const ro = await ctx(browser, { ip: '86.121.10.10', locale: 'tr-TR' }); // RCS & RDS bloğu
  await ro.goto('/login');
  await expect(ro.getByRole('button', { name: 'Intră în cont' })).toBeVisible();
});

test('Romence girilince panel Romence açılır; sağ üstten dil değişir', async ({ browser }) => {
  const page = await ctx(browser, { locale: 'ro-RO' });
  await page.goto('/login');
  await page.fill('#email', ADMIN);
  await page.fill('#password', ADMIN_PW);
  await page.getByRole('button', { name: 'Intră în cont' }).click();
  await expect(page).toHaveURL(/\/siparisler/);
  await expect(page.locator('.sidebar').getByRole('link', { name: 'Comenzi' })).toBeVisible();
  await expect(page.locator('.lang-select')).toHaveValue('ro');

  // Romence ekranlarda çevrilmemiş anahtar kalmamalı
  const pages = ['/siparisler', '/siparisler?view=all', '/siparisler?view=archive', '/teklifler', '/yuklemeler?gun=2027-03-19', '/yuklemeler?view=liste&ay=2027-03', '/admin/users', '/admin/firms', '/admin/katalog'];
  for (const url of pages) {
    await page.goto(url);
    await expect(page.locator('body'), url).not.toContainText(RAW_KEY);
  }
  await page.goto('/siparisler?view=all&q=UNS2');
  await page.getByRole('link', { name: 'UNS2' }).first().click();
  await expect(page).toHaveURL(/\/siparisler\/[a-z0-9]+$/);
  await expect(page.locator('body')).not.toContainText(RAW_KEY);
  await expect(page.getByText('În producție').first()).toBeVisible();
  await shot(page, '03-siparis-detay');
  await page.goto('/siparisler');
  await shot(page, '02-yonetici-siparisler');
  await page.goto('/yuklemeler?gun=2027-03-19');
  await shot(page, '04-yuklemeler');

  await page.locator('.lang-select').selectOption('tr');
  await expect(page.locator('.sidebar').getByRole('link', { name: 'Siparişler' })).toBeVisible();
  await expect(page).toHaveURL(/\/yuklemeler\?gun=2027-03-19/); // aynı sayfada kalır
  await page.reload();
  await expect(page.locator('.lang-select')).toHaveValue('tr');
});

test('müşteri Romence panelde siparişini ve teklifini görür', async ({ browser }) => {
  const page = await ctx(browser, { locale: 'ro-RO' });
  await page.goto('/login');
  await page.fill('#email', CUSTOMER);
  await page.fill('#password', CUST_PW);
  await page.getByRole('button', { name: 'Intră în cont' }).click();
  await expect(page.locator('.sidebar').getByRole('link', { name: 'Comenzile mele' })).toBeVisible();
  for (const url of ['/siparisler', '/siparisler?view=archive', '/teklifler', '/yuklemeler?gun=2027-03-19', '/siparisler/yeni', '/siparisler/yeni?tip=PROFILE_ORDER']) {
    await page.goto(url);
    await expect(page.locator('body'), url).not.toContainText(RAW_KEY);
  }
  await page.goto('/siparisler');
  await page.getByRole('link', { name: 'UNS2' }).first().click();
  await expect(page.getByRole('heading', { name: 'Oferta dvs.' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(RAW_KEY);
  // Cam adı seçilen dilde (karar 20): Romence panelde Romence ad, Türkçesi görünmez
  await expect(page.getByText(`${GLASS_RO} × 3`)).toBeVisible();
  await expect(page.getByText(`${GLASS} × 3`)).toHaveCount(0);
  await shot(page, '05-musteri-siparis');
  await page.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await expect(page.getByLabel('Sticlă', { exact: true }).locator('option', { hasText: GLASS_RO })).toHaveCount(1);
});
