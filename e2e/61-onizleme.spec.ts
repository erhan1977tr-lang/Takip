import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import type { PrismaClient } from '@prisma/client';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, login } from './helpers';
import { circle, dxf, line, raw, text } from '../test/fixtures/cad.js';

// Güvenli dosya önizlemesi (karar 283) — GERÇEK sunucuda: PDF (çok sayfa), PNG / JPEG / WEBP, DXF, GERÇEK DWG (CI'da
// LibreDWG'nin kendi örnek dosyası; yoksa DWG adımı atlanır), sahte uzantı, rol / firma yalıtımı, geri çekilen çizim
// sürümü, iç dosya, güvenli başlıklar, ayrı denetim kaydı, mevcut "Aç" / "İndir" değişmedi, telefon genişliği.
// Veri bu dosyaya özeldir: siparişler ve dosyalar doğrudan yazılır (müşteri dosyası kullanılmaz).
test.describe.configure({ mode: 'serial' });

const ROOT = process.env.UPLOAD_DIR ?? '';
const BETA = 'beta@betacam.test';
const SALES = 'fiyat-satis@e2e.test';
const RUN = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const DIR = `onizleme-${RUN}`;
const DWG_SAMPLE = path.join(os.homedir(), '.libredwg', 'ornek', 'sample_2018.dwg');

let db: PrismaClient;
const F: Record<string, { id: string; name: string; href: string; buf: Buffer }> = {};
const O: Record<string, string> = {};

// ---------------------------------------------------------------- örnek içerikler
/** Geçerli, çok sayfalı küçük PDF (xref uzaklıkları hesaplanır) */
function pdf(pages: number): Buffer {
  const objs: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  const font = 3 + pages * 2;
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 36 Tf 72 700 Td (Sayfa ${i + 1}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
/** Geçerli PNG (w × h, düz renk) */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [28, 75, 145]).flat())])));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function put(name: string, buf: Buffer) {
  const storageKey = `${DIR}/${crypto.randomBytes(8).toString('hex')}${path.extname(name)}`;
  fs.mkdirSync(path.join(ROOT, DIR), { recursive: true });
  fs.writeFileSync(path.join(ROOT, storageKey), buf);
  return { storageKey, size: buf.length, checksum: crypto.createHash('sha256').update(buf).digest('hex') };
}

test.beforeAll(async () => {
  const { PrismaClient: Client } = await import('@prisma/client');
  db = new Client();
});
test.afterAll(async () => { await db.$disconnect(); });

test('veri: iki firma; PDF / resim / DXF / DWG / sahte dosya; iç dosya; geri çekilen çizim sürümü', async ({ browser }) => {
  expect(ROOT, 'UPLOAD_DIR (test süreci sunucunun yükleme klasörünü görmeli)').toBeTruthy();
  const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  const beta = await db.user.findUniqueOrThrow({ where: { email: BETA }, include: { customer: true } });
  const drawer = await db.user.findUniqueOrThrow({ where: { email: DRAWER } });
  // JPEG ve WEBP tarayıcının kendi kodlayıcısıyla üretilir (gerçek, çözülebilir dosyalar)
  const page = await browser.newPage();
  const encoded = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = '#1c4b91'; g.fillRect(0, 0, 64, 32);
    const b64 = async (type: string) => {
      const blob: Blob = await new Promise((r) => c.toBlob((x) => r(x!), type, 0.9));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (const x of bytes) s += String.fromCharCode(x);
      return btoa(s);
    };
    return { jpg: await b64('image/jpeg'), webp: await b64('image/webp') };
  });
  await page.close();
  const base = 9100 + Math.floor(Math.random() * 800);
  let k = 0;
  const order = async (key: string, owner: typeof cust) => {
    const no = base * 10 + k++;
    const o = await db.order.create({
      data: {
        orderNo: `${owner.customer!.prefix}${no}`, customerOrderNo: String(no), title: `Önizleme ${key} ${RUN}`, orderTypeCode: 'GLASS_ORDER',
        customerId: owner.customer!.id, createdById: owner.id, status: 'HAZIRLANIYOR', drawingTrack: 'GEREKLI',
      },
    });
    O[key] = o.id;
    return o.id;
  };
  const file = async (key: string, orderId: string, name: string, buf: Buffer, kind: 'CUSTOMER' | 'INTERNAL' = 'CUSTOMER', uploader = cust.id) => {
    const p = put(name, buf);
    const f = await db.orderFile.create({ data: { orderId, kind, name, storageKey: p.storageKey, size: p.size, checksum: p.checksum, scanStatus: 'CLEAN', uploadedById: uploader } });
    F[key] = { id: f.id, name, href: `/dosya/siparis/${f.id}`, buf };
  };
  const a = await order('A', cust);
  await file('pdf', a, `cok-sayfa-${RUN}.pdf`, pdf(3));
  await file('png', a, `resim-${RUN}.png`, png(120, 60));
  await file('jpg', a, `foto-${RUN}.jpg`, Buffer.from(encoded.jpg, 'base64'));
  await file('webp', a, `foto-${RUN}.webp`, Buffer.from(encoded.webp, 'base64'));
  await file('dxf', a, `plan-${RUN}.dxf`, Buffer.from(dxf({
    insunits: 4, layers: [{ name: 'CAM-KENAR', color: 1 }, { name: 'OLCU', color: 3 }],
    entities: [line(0, 0, 1000, 0, 'CAM-KENAR'), line(1000, 0, 1000, 500, 'CAM-KENAR'), circle(500, 250, 40, 'CAM-KENAR'), text(10, 520, 25, 'Kat 1', 'OLCU'), raw('3DSOLID')],
  }), 'latin1'));
  if (fs.existsSync(DWG_SAMPLE)) await file('dwg', a, `gercek-${RUN}.dwg`, fs.readFileSync(DWG_SAMPLE));
  await file('fake', a, `sahte-${RUN}.pdf`, Buffer.from('<html><body><script>window.pwned=1</script></body></html>', 'latin1'));
  await file('internal', a, `ic-${RUN}.pdf`, pdf(1), 'INTERNAL', drawer.id);
  // Geri çekilen çizim sürümü: müşteri dosyasını alamaz (karar 146) — önizleme de alamaz
  const wp = put(`geri-${RUN}.pdf`, pdf(1));
  const w = await db.drawing.create({
    data: {
      orderId: a, version: 1, status: 'GERI_CEKILDI', uploadedById: drawer.id, sentAt: new Date(), sentById: drawer.id, withdrawnAt: new Date(), withdrawReason: 'x', scanStatus: 'CLEAN',
      files: { create: [{ name: `geri-${RUN}.pdf`, storageKey: wp.storageKey, size: wp.size, checksum: wp.checksum, scanStatus: 'CLEAN', uploadedById: drawer.id }] },
    },
    include: { files: true },
  });
  F.withdrawn = { id: w.files[0].id, name: w.files[0].name, href: `/dosya/cizim/${w.files[0].id}`, buf: Buffer.alloc(0) };
  const b = await order('B', beta);
  await file('beta', b, `beta-${RUN}.pdf`, pdf(1), 'CUSTOMER', beta.id);
});

// ---------------------------------------------------------------- yardımcılar
const row = (page: Page, name: string) => page.locator('.file-row').filter({ has: page.locator('.fname', { hasText: name }) });
async function openPreview(page: Page, key: string) {
  await page.goto(`/siparisler/${O.A}`);
  await row(page, F[key].name).locator('button[data-preview]').click();
  const modal = page.locator('dialog[data-preview-modal]');
  await expect(modal).toBeVisible();
  return modal;
}

test('PDF: çok sayfa, sayfa geçişi, yakınlaştırma, indir bağlantısı, kapat', async ({ browser }) => {
  const page = await as(browser, CUSTOMER, CUST_PW);
  const modal = await openPreview(page, 'pdf');
  await expect(modal.locator('[data-preview-page]')).toHaveText('Sayfa 1 / 3');
  await expect(modal.locator('[data-page="1"][data-drawn]')).toBeVisible({ timeout: 20_000 });
  await modal.getByRole('button', { name: 'Sonraki sayfa' }).click();
  await expect(modal.locator('[data-preview-page]')).toHaveText('Sayfa 2 / 3');
  await expect(modal.locator('[data-page="2"][data-drawn]')).toBeAttached({ timeout: 20_000 });
  const before = await modal.locator('[data-page="2"]').boundingBox();
  await modal.getByRole('button', { name: 'Yakınlaştır' }).click();
  await expect.poll(async () => (await modal.locator('[data-page="2"]').boundingBox())!.width).toBeGreaterThan(before!.width * 1.2);
  await expect(modal.locator('[data-preview-download]')).toHaveAttribute('href', F.pdf.href);
  await modal.locator('[data-preview-close]').click();
  await expect(modal).toHaveCount(0);
  // Önizleme ayrı kaydedilir; indirme kaydı yazılmaz
  const u = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  expect(await db.auditLog.count({ where: { action: 'FILE_PREVIEW', entityId: F.pdf.id, userId: u.id } })).toBeGreaterThan(0);
  expect(await db.auditLog.count({ where: { action: 'FILE_DOWNLOAD', entityId: F.pdf.id } })).toBe(0);
  await page.context().close();
});

test('resimler: PNG / JPEG / WEBP önizlenir, sığdır ve yakınlaştır çalışır', async ({ browser }) => {
  const page = await as(browser, CUSTOMER, CUST_PW);
  for (const [key, size] of [['png', '120x60'], ['jpg', '64x32'], ['webp', '64x32']] as const) {
    const modal = await openPreview(page, key);
    await expect(modal.locator(`[data-preview-image="${size}"] img`)).toBeVisible();
    const pct = modal.locator('.preview-pct');
    const a = await pct.textContent();
    await modal.getByRole('button', { name: 'Yakınlaştır' }).click();
    await expect(pct).not.toHaveText(a!);
    await modal.locator('[data-preview-fit]').click();
    await expect(pct).toHaveText(a!);
    await modal.locator('[data-preview-close]').click();
  }
  await page.context().close();
});

test('DXF: katmanlar, birim dosyadan, gösterilemeyen nesne uyarısı; katman gizlenebilir', async ({ browser }) => {
  const page = await as(browser, CUSTOMER, CUST_PW);
  const modal = await openPreview(page, 'dxf');
  await expect(modal.locator('[data-preview-cad]')).toBeVisible({ timeout: 30_000 });
  await expect(modal.locator('[data-preview-units]')).toHaveText('Çizim birimi: mm');
  await expect(modal.locator('[data-warn="unsupported"]')).toContainText('3DSOLID × 1');
  await expect(modal.locator('input[data-layer="CAM-KENAR"]')).toBeChecked();
  await modal.locator('input[data-layer="OLCU"]').uncheck();
  await expect(modal.locator('input[data-layer="OLCU"]')).not.toBeChecked();
  await expect(modal.locator('[data-preview-converted]')).toHaveCount(0);
  await page.context().close();
});

test('gerçek DWG (LibreDWG örneği): sunucuda dönüştürülür ve çizilir', async ({ browser }) => {
  test.skip(!F.dwg, 'örnek DWG yok (yalnızca CI\'da LibreDWG ile)');
  const page = await as(browser, CUSTOMER, CUST_PW);
  const modal = await openPreview(page, 'dwg');
  await expect(modal.locator('[data-preview-cad]')).toBeVisible({ timeout: 60_000 });
  await expect(modal.locator('[data-preview-converted]')).toBeVisible();
  expect(Number(await modal.locator('[data-preview-cad]').getAttribute('data-preview-cad'))).toBeGreaterThan(0);
  await page.context().close();
});

test('sahte uzantı (.pdf içinde HTML): önizleme yok, anlaşılır hata; indirme değişmedi', async ({ browser }) => {
  const page = await as(browser, CUSTOMER, CUST_PW);
  const modal = await openPreview(page, 'fake');
  await expect(modal.locator('[data-preview-error="MISMATCH"]')).toContainText('içeriği uzantısıyla uyuşmuyor');
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  const res = await page.request.get(`${F.fake.href}?onizle=1`);
  expect(res.status()).toBe(415);
  expect(await res.json()).toEqual({ ok: false, code: 'MISMATCH' });
  const dl = await page.request.get(F.fake.href);
  expect(dl.status()).toBe(200);
  expect(dl.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(dl.headers()['content-type']).toBe('application/octet-stream');
  await page.context().close();
});

test('güvenli başlıklar; "Aç" ve "İndir" eskisi gibi; yetki: başka firma / iç dosya / geri çekilen sürüm / oturumsuz', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const p = await cust.request.get(`${F.pdf.href}?onizle=1`);
  expect(p.status()).toBe(200);
  const h = p.headers();
  expect(h['content-type']).toBe('application/pdf');
  expect(h['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['cache-control']).toBe('private, no-store');
  expect(h['content-disposition']).toBe('inline');
  expect(Buffer.from(await p.body()).equals(F.pdf.buf)).toBe(true);
  // Mevcut davranış: "Aç" (?ac=1) satır içi, "İndir" ek
  const open = await cust.request.get(`${F.pdf.href}?ac=1`);
  expect(open.headers()['content-disposition']).toMatch(/^inline; filename=/);
  const dl = await cust.request.get(F.png.href);
  expect(dl.headers()['content-disposition']).toMatch(/^attachment; filename=/);
  expect(Buffer.from(await dl.body()).equals(F.png.buf)).toBe(true);
  await cust.goto(`/siparisler/${O.A}`);
  await expect(row(cust, F.pdf.name).getByRole('link', { name: 'Aç' })).toBeVisible();
  await expect(row(cust, F.pdf.name).getByRole('link', { name: 'İndir' })).toBeVisible();
  await expect(row(cust, F.pdf.name).getByRole('button', { name: 'Önizle' })).toBeVisible();

  const no = async (pg: Page, url: string, status = 404) => {
    const r = await pg.request.get(url, { maxRedirects: 0 });
    expect(r.status(), url).toBe(status);
    const body = Buffer.from(await r.body()).toString('latin1');
    expect(body).not.toContain('%PDF');
  };
  for (const mode of ['1', 'cad']) {
    await no(cust, `${F.beta.href}?onizle=${mode}`);
    await no(cust, `${F.internal.href}?onizle=${mode}`);
    await no(cust, `${F.withdrawn.href}?onizle=${mode}`);
    await no(cust, `/dosya/siparis/yok-${RUN}?onizle=${mode}`);
    await no(cust, `/dosya/siparis/..%2F..%2Fetc%2Fpasswd?onizle=${mode}`);
  }
  const anon = await (await browser.newContext()).newPage();
  await no(anon, `${F.pdf.href}?onizle=1`, 401);
  const beta = await as(browser, BETA, TEAM_PW);
  await no(beta, `${F.pdf.href}?onizle=1`);
  await no(beta, `${F.dxf.href}?onizle=cad`);
  // Bilinmeyen kip ya da yanlış kip → sabit hata, içerik yok
  const bad = await cust.request.get(`${F.pdf.href}?onizle=x`);
  expect(bad.status()).toBe(415);
  const cadOnPdf = await cust.request.get(`${F.pdf.href}?onizle=cad`);
  expect(await cadOnPdf.json()).toEqual({ ok: false, code: 'UNSUPPORTED' });
  // Yetkili iç ekip: satış müşteri dosyasını önizler; firma adı maskeli kalır (önizleme yalnızca dosya içeriğidir)
  const sales = await as(browser, SALES, TEAM_PW);
  const s = await sales.request.get(`${F.dxf.href}?onizle=cad`);
  expect(s.status()).toBe(200);
  const j = await s.json();
  expect(j.ok).toBe(true);
  expect(JSON.stringify(j)).not.toContain('Ünsal');
  const admin = await as(browser, ADMIN, ADMIN_PW);
  expect((await admin.request.get(`${F.internal.href}?onizle=1`)).status()).toBe(200);
  for (const pg of [cust, anon, beta, sales, admin]) await pg.context().close();
});

test('telefon genişliği: pencere ekrana sığar, yatay kaydırma yok', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await login(page, CUSTOMER, CUST_PW);
  for (const key of ['pdf', 'dxf']) {
    const modal = await openPreview(page, key);
    const box = (await modal.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(modal.locator('[data-preview-close]')).toBeInViewport();
    await expect(modal.locator('[data-preview-download]')).toBeInViewport();
    await modal.locator('[data-preview-close]').click();
  }
  await ctx.close();
});
