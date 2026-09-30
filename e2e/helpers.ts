import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const ADMIN = 'admin@e2e.test';
export const ADMIN_PW = 'Yonetici2026';
export const CUSTOMER = 'ali@unsal.test';
export const CUST_PW = 'Musteri2026x';

export function outboxCodeFor(email: string): string {
  const dir = process.env.MAIL_OUTBOX_DIR;
  if (!dir) throw new Error('MAIL_OUTBOX_DIR ayarlı değil');
  const files = fs.readdirSync(dir).filter((f) => f.includes(email)).sort();
  expect(files.length, `outbox'ta ${email} için e-posta yok`).toBeGreaterThan(0);
  const msg = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  expect(msg.subject).toContain('Takip');
  const m = /(\d{6})/.exec(msg.text);
  if (!m) throw new Error('E-postada kod bulunamadı');
  return m[1];
}

export async function firstLogin(page: Page, email: string, code: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/setup\?email=/);
  await page.fill('#code', code);
  await page.click('button[type=submit]');
  await expect(page.getByRole('heading', { name: 'Şifrenizi belirleyin', exact: true })).toBeVisible();
  await page.fill('#password', password);
  await page.fill('#password2', password);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/siparisler/);
}

export async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/siparisler/);
}

/** Yönetici olarak kullanıcı oluşturur (davet e-postası outbox'a düşer). */
export async function createUser(page: Page, u: { email: string; name: string; role: 'Müşteri' | 'Satış' | 'Çizimci' | 'Denetimci'; firm: string; canApprove?: boolean }) {
  await page.goto('/admin/users');
  await page.fill('#u-email', u.email);
  await page.fill('#u-name', u.name);
  await page.locator('label.chip', { hasText: u.role }).click();
  await page.selectOption('#u-firm', { label: u.role === 'Müşteri' ? u.firm : `${u.firm} (fabrika)` });
  if (u.canApprove) await page.locator('input[name=canApprove]').check();
  await page.click('form.card button[type=submit]');
  await expect(page.getByText(`${u.email} → ${u.firm} firmasına atandı ve davet e-postası gönderildi.`)).toBeVisible();
}

export const GLASS = '66.3 Temper Lamine Cam (Şeffaf)';
export const GLASS_RO = 'Sticlă securizată laminată 6.6.3 (transparentă)';

/** Yönetici → Cam kataloğu: renksiz tek cam ekler (Türkçe + Romence ad, ağırlık). */
export async function addGlass(page: Page, nameTr: string, nameRo: string, weight = '30') {
  await page.goto('/admin/katalog');
  await page.fill('#nameTr', nameTr);
  await page.fill('#nameRo', nameRo);
  await page.fill('#weightKgM2', weight);
  await page.getByRole('button', { name: 'Kataloğa ekle' }).click();
  await expect(page.getByText('Cam kataloğa eklendi.')).toBeVisible();
}
export const SALES = 'satis@e2e.test';
export const DRAWER = 'cizim@e2e.test';
export const TEAM_PW = 'Ekip2026abc';

/** Ayrı bir tarayıcı oturumunda giriş yapar; onay pencerelerini otomatik kabul eder. */
export async function as(browser: import('@playwright/test').Browser, email: string, pw: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await login(page, email, pw);
  return page;
}

/**
 * Uzantısına uygun içerikte örnek dosya (sunucu türü içerikten kontrol eder; uzantıya güvenmez).
 * label içeriğe yazılır ki indirilen dosya doğrulanabilsin.
 */
export function sampleFile(name: string, label = name): { name: string; mimeType: string; buffer: Buffer } {
  const ext = name.toLowerCase().split('.').pop();
  let buffer: Buffer;
  if (ext === 'pdf') buffer = Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
  else if (ext === 'dxf') buffer = Buffer.from(`999\n${label}\n0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n`, 'latin1');
  else if (ext === 'dwg') buffer = Buffer.concat([Buffer.from('AC1032', 'latin1'), Buffer.alloc(32), Buffer.from(label)]);
  else if (ext === 'xlsx' || ext === 'docx' || ext === 'zip') buffer = zipOf([{ name: 'icerik.txt', data: Buffer.from(label) }]);
  else if (ext === 'png') buffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(label)]);
  else buffer = Buffer.from(label);
  return { name, mimeType: 'application/octet-stream', buffer };
}

/** Sıkıştırmasız (store) basit ZIP arşivi. */
export function zipOf(entries: { name: string; data: Buffer }[]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20); central.writeUInt32LE(e.data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, e.data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Müşteri olarak yeni sipariş oluşturur, sipariş kimliğini döndürür. */
export async function newOrder(page: Page, title: string, fileName: string): Promise<string> {
  await page.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await page.fill('#title', title);
  await page.setInputFiles('#files', sampleFile(fileName, `test dosyası ${title}`));
  await page.getByLabel('Cam', { exact: true }).selectOption({ label: GLASS });
  await page.getByLabel('Adet', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(page).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/);
  await expect(page.getByText('Siparişiniz alındı.')).toBeVisible();
  return /\/siparisler\/([a-z0-9]+)/.exec(page.url())![1];
}

/** Teklif tablosunun ilk satırını doldurur (1000 × 2000 mm, adet siparişten gelir). */
export async function fillOffer(page: Page, price = '41,5') {
  await page.getByLabel('En', { exact: true }).first().fill('1000');
  await page.getByLabel('Boy', { exact: true }).first().fill('2000');
  await page.getByLabel('Birim fiyat').first().fill(price);
}

/**
 * ADR 0003 sızıntı taraması: kullanıcının bağlantıları izleyerek erişebildiği sayfaları gezer ve her sayfanın
 * ham yanıtında (HTML + RSC verisi) aranan metinlerin (ve JSON kaçışlı biçimlerinin) geçip geçmediğine bakar.
 */
export async function crawlForLeaks(page: Page, secrets: string[], max = 80): Promise<{ pages: number; leaks: string[] }> {
  const needles = secrets
    .filter((s) => s.trim().length >= 5)
    .flatMap((s) => [s, JSON.stringify(s).slice(1, -1), s.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)]);
  const seen = new Set<string>();
  const queue = ['/siparisler'];
  const leaks: string[] = [];
  while (queue.length && seen.size < max) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    for (const variant of [url, `${url}${url.includes('?') ? '&' : '?'}_rsc=1`]) {
      const res = await page.request.get(variant, { headers: variant.includes('_rsc') ? { RSC: '1' } : {} });
      const body = await res.text();
      for (const n of needles) if (body.includes(n)) leaks.push(`${variant}: "${n}"`);
    }
    await page.goto(url);
    for (const href of await page.locator('a[href^="/"]').evaluateAll((els) => els.map((a) => a.getAttribute('href') || ''))) {
      const clean = href.split('#')[0];
      if (!clean || /^\/(dosya|dil|login|setup|_next)\b/.test(clean) || seen.has(clean)) continue;
      queue.push(clean);
    }
  }
  return { pages: seen.size, leaks: [...new Set(leaks)] };
}

/** Müşteri firmalarının gizli tutulacak bilgileri (tam ad, ilk 3 harften sonrası, iletişim). */
export async function customerSecrets(): Promise<string[]> {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const rows = await db.customer.findMany({
      where: { type: 'CUSTOMER' }, select: { name: true, contactPerson: true, phone: true, address: true, taxId: true },
    });
    return rows.flatMap((r) => [r.name, r.name.slice(3), r.contactPerson, r.phone, r.address, r.taxId]).filter((x): x is string => !!x);
  } finally {
    await db.$disconnect();
  }
}
