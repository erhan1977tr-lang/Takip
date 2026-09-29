import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version as string;

test('giriş ekranında logo, sürüm numarası ve sekme simgesi', async ({ page }) => {
  await page.goto('/login');
  const logo = page.getByAltText('GKH Digital');
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByText(`v${VERSION}`, { exact: true })).toBeVisible();
  const icon = await page.request.get('/icon.png');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toContain('image/png');
});

test('sürüm adresi (/surum) yayındaki sürümü verir', async ({ request }) => {
  const res = await request.get('/surum');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('no-store');
  const body = await res.json();
  expect(body.version).toBe(VERSION);
  expect(typeof body.build).toBe('string');
});
