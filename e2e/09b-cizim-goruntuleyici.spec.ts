import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, createUser, firstLogin, newOrder, outboxCodeFor, sampleFile, sendDrawing, uploadDrawing } from './helpers';

// Çizim görüntüleyici (gerçek PDF, PNG ve JPG ile; karar 84): çizimci "Kontrol Et" → o ekrandan "Müşteriye gönder" →
// müşteri görüntüleyicide "Bu çizimi onayla" / "Revizyon iste": çizim üzerine İğne / Dikdörtgen / Serbest / Metin işareti
// koyar ve değişiklikleri NUMARALI maddelerle yazar (karar 162, Paket B — karar 227: açıklamalı işaret nota "#n: …" olarak
// eklenir; taslak sayfa yenilenince kaybolmaz) → çizimci numaralı notu ve işaretleri çizim üzerinde görür → v2 →
// müşteri görüntüleyiciden onaylar →
// "Müşteriden onaylı çizimler" (çizim, satış, yönetici). Onay yetkisi olmayan müşteri kullanıcısı karar
// veremez; başka firma hiçbir şeyi açamaz; pdf.js varlıkları uygulamanın kendi adresinden gelir.
test.describe.configure({ mode: 'serial' });

const lat = (x: string) => Buffer.from(x, 'latin1');
const stream = (dict: string, data: Buffer) => Buffer.concat([lat(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, lat('\nendstream')]);
/** Nesnelerden geçerli PDF dosyası (xref ile) */
function pdfOf(objs: Buffer[]): Buffer {
  const parts: Buffer[] = [lat('%PDF-1.4\n')];
  const offsets: number[] = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(len);
    const b = Buffer.concat([lat(`${i + 1} 0 obj\n`), o, lat('\nendobj\n')]);
    parts.push(b);
    len += b.length;
  });
  parts.push(lat(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`));
  return Buffer.concat(parts);
}
/**
 * Geçerli, tek sayfalık küçük PDF (300 × 200 pt): bir çizgi + GÖMÜLÜ OLMAYAN standart yazı tipiyle (Helvetica) metin
 * (pdf.js yazı tipini uygulamanın kendi /pdfjs/standard_fonts/ adresinden alır) + verilirse gömülü JPEG görsel
 * (sayfanın sağ altında, x 160–280 / y 20–80 pt).
 */
function realPdf(jpeg?: { data: Buffer; w: number; h: number }): Buffer {
  const content = ['2 w 20 20 m 280 180 l S', 'BT /F1 18 Tf 30 150 Td (GKH 1100 mm) Tj ET', jpeg ? 'q 120 0 0 60 160 20 cm /Im1 Do Q' : ''].join('\n');
  const objs = [
    lat('<< /Type /Catalog /Pages 2 0 R >>'),
    lat('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    lat(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >>${jpeg ? ' /XObject << /Im1 6 0 R >>' : ''} >> >>`),
    stream('', lat(content)),
    lat('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  if (jpeg) objs.push(stream(`/Type /XObject /Subtype /Image /Width ${jpeg.w} /Height ${jpeg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, jpeg.data));
  return pdfOf(objs);
}

/** Geçerli PNG (gri, w × h) */
function realPng(w = 240, h = 120): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; // 8 bit gri
  const raw = Buffer.alloc((w + 1) * h, 0xdd);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** Tuvalde koyu piksel var mı (boş / beyaz değil) */
const inked = (c: HTMLCanvasElement | SVGElement) => {
  const cv = c as HTMLCanvasElement;
  if (cv.width <= 300) return false; // pdf.js henüz boyut vermedi (varsayılan 300 × 150)
  const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) return true;
  return false;
};
const file = (name: string, buffer: Buffer) => ({ name, mimeType: 'application/octet-stream', buffer });

/** Tuvalin (oranla verilen) noktasındaki renk */
const pixelAt = (c: HTMLCanvasElement | SVGElement, at: number[]) => {
  const cv = c as HTMLCanvasElement;
  return Array.from(cv.getContext('2d')!.getImageData(Math.floor(cv.width * at[0]), Math.floor(cv.height * at[1]), 1, 1).data);
};
/** Görsel kontrol için ekran görüntüsü (yalnızca SCREENSHOT_DIR ayarlıysa; CI bunları ci-screenshots dalına yazar) */
async function shot(page: import('@playwright/test').Page, name: string, mobile = false) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const before = page.viewportSize();
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, `${mobile ? 'mobil' : 'masaustu'}-${name}.png`), fullPage: true });
  if (before) await page.setViewportSize(before);
}
const VIEWER = 'izleyici@unsal.test'; // Ünsal Cam'ın onay yetkisi OLMAYAN kullanıcısı
const SALES2 = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te kilitleniyor)

test('çizim görüntüleyici: kontrol et → gönder; numaralı maddeli revizyon notu (işaretleme yok); eski işaretler iç ekipte; görüntüleyiciden onay; onaylanmış çizimler', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Görüntüleyici', 'plan.pdf');
  const admin = await as(browser, ADMIN, ADMIN_PW);
  // Aynı firmada onay yetkisi olmayan müşteri kullanıcısı
  await createUser(admin, { email: VIEWER, name: 'İzleyici Kişi', role: 'Müşteri', firm: 'Ünsal Cam' });
  const fresh = await (await browser.newContext()).newPage();
  await firstLogin(fresh, VIEWER, outboxCodeFor(VIEWER), TEAM_PW);
  await fresh.context().close();
  await admin.goto(`/siparisler/${id}`);
  await admin.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(admin.getByText('Sipariş çizim ekibine yönlendirildi.')).toBeVisible();

  // Çizimci sipariş sayfası (karar 84; Paket 3): 1) müşteri sipariş dosyaları 2) teknik çizim dosyaları (yükleme bu bölümde)
  // 3) çizim onayı ve revizyon 4) notlar 5) sipariş bilgileri. Adım çubuğu / işlem kartı yok (durum küçük rozetle); sandık /
  // teklif / istenen camlar yok.
  const drawer = await as(browser, DRAWER, TEAM_PW);
  await drawer.goto(`/siparisler/${id}`);
  await expect(drawer.locator('#sandik')).toHaveCount(0);
  await expect(drawer.locator('#teklif')).toHaveCount(0);
  await expect(drawer.getByText('İstenen camlar')).toHaveCount(0);
  await expect(drawer.locator('.stepper')).toHaveCount(0);
  await expect(drawer.locator('.card.turn')).toHaveCount(0);
  await expect(drawer.locator('.page-head .badge', { hasText: 'Çizim bekliyor' })).toBeVisible();
  const heads = await drawer.locator('h2').allTextContents();
  const pos = (h: string) => heads.findIndex((x) => x.includes(h));
  expect(pos('Müşteri sipariş dosyaları')).toBeGreaterThanOrEqual(0);
  expect(pos('Müşteri sipariş dosyaları')).toBeLessThan(pos('Teknik çizim dosyaları'));
  expect(pos('Teknik çizim dosyaları')).toBeLessThan(pos('Çizim onayı ve revizyon'));
  expect(pos('Çizim onayı ve revizyon')).toBeLessThan(pos('Notlar'));
  expect(heads.some((h) => h.startsWith('Sıra '))).toBe(false); // "sıra kimde" kartı yok
  expect(pos('Notlar')).toBeLessThan(pos('Sipariş bilgileri'));
  expect(heads.some((h) => h.includes('Teknik çizimler ve onay'))).toBe(false); // çizimcide iki ayrı bölüm
  await expect(drawer.locator('#cizim-dosyalari #drawing-file')).toHaveCount(1); // yükleme "Teknik çizim dosyaları"nın içinde

  // Gerçek dosyalar: metinli PDF (gömülü olmayan Helvetica + gömülü JPEG), PNG ve JPG
  const jpeg = Buffer.from(await drawer.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = '#c00000';
    g.fillRect(0, 0, 64, 32);
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }), 'base64');
  await drawer.setInputFiles('#drawing-file', [file('plan-v1.pdf', realPdf({ data: jpeg, w: 64, h: 32 })), file('detay-v1.png', realPng()), file('foto-v1.jpg', jpeg), sampleFile('plan-v1.dxf', 'dxf')]);
  await drawer.getByRole('button', { name: 'Taslağa yükle' }).click();
  await expect(drawer.getByText('Dosyalar taslağa eklendi.')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Müşteriye gönder' })).toHaveCount(0); // gönderim yalnızca kontrol ekranında
  await shot(drawer, '20-cizimci-siparis');
  await shot(drawer, '20-cizimci-siparis', true);

  // "Kontrol Et": PDF gerçekten çiziliyor (pdf.js); yazı tipi uygulamanın kendi adresinden geliyor; dış sunucuya istek yok
  const own = new URL(drawer.url()).origin;
  const assets: string[] = [];
  const foreign: string[] = [];
  drawer.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin !== own && /^https?:$/.test(u.protocol)) foreign.push(r.url());
    if (u.pathname.startsWith('/pdfjs/')) assets.push(`${r.status()} ${u.pathname}`);
  });
  await drawer.getByRole('link', { name: 'Kontrol Et' }).click();
  await expect(drawer).toHaveURL(/\/cizim\/[a-z0-9]+$/);
  const viewerUrl = drawer.url();
  await drawer.locator('.viewer-bar select').selectOption({ label: 'plan-v1.pdf' });
  const canvas = drawer.locator('.viewer-page canvas');
  await expect(canvas).toHaveCount(1);
  await expect.poll(() => canvas.evaluate(inked)).toBe(true); // sayfa gerçekten çizildi (çizgi + metin)
  await expect.poll(() => assets.filter((a) => a.includes('/pdfjs/standard_fonts/')).length).toBeGreaterThan(0);
  expect(assets.every((a) => a.startsWith('200 ')), assets.join(', ')).toBe(true);
  // PDF içindeki JPEG görsel de çizildi (sağ altta kırmızı alan)
  await expect.poll(async () => { const [r, g, b] = await canvas.evaluate(pixelAt, [220 / 300, 150 / 200]); return r > 150 && g < 90 && b < 90; }).toBe(true);
  expect(foreign, 'görüntüleyici dış sunucuya istek atmamalı').toEqual([]);
  await shot(drawer, '21-cizimci-kontrol-et');
  await expect(drawer.locator('.viewer-layer.editable')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'İğne' })).toHaveCount(0); // çizimci işaret koymaz
  await drawer.locator('.viewer-bar select').selectOption({ label: 'detay-v1.png' });
  await expect.poll(() => drawer.locator('.viewer-page img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(240);
  await drawer.locator('.viewer-bar select').selectOption({ label: 'foto-v1.jpg' });
  await expect.poll(() => drawer.locator('.viewer-page img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(64);
  // Teknik ek (DXF) ekranda açılmaz, indirilebilir
  await drawer.locator('.viewer-bar select').selectOption({ label: 'plan-v1.dxf' });
  await expect(drawer.getByText('Bu dosya türü ekranda gösterilemez')).toBeVisible();
  // pdf.js varlıkları: yalnızca yazı tipi / cMap klasörleri, yalnızca giriş yapmış kullanıcıya
  expect((await drawer.request.get('/pdfjs/cmaps/UniJIS-UTF16-H.bcmap')).status()).toBe(200);
  expect((await drawer.request.get('/pdfjs/standard_fonts/LICENSE_FOXIT')).status()).toBe(404);
  expect((await drawer.request.get('/pdfjs/build/pdf.mjs')).status()).toBe(404);
  expect([400, 404]).toContain((await drawer.request.get('/pdfjs/standard_fonts/..%2Fpackage.json')).status());
  const anon = await browser.newContext();
  expect((await anon.request.get(`${own}/pdfjs/standard_fonts/LiberationSans-Regular.ttf`)).status()).toBe(401);
  await anon.close();
  // Müşteri taslağın ekranını açamaz
  expect((await cust.goto(viewerUrl))?.status()).toBe(404);

  // "Müşteriye gönder" kontrol ekranında (onay penceresini as() kabul eder)
  await drawer.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(drawer.getByText('Çizim müşterinin onayına gönderildi.')).toBeVisible();
  const fileHref = await drawer.locator('.file-row', { hasText: 'plan-v1.pdf' }).locator('a[href^="/dosya/cizim/"]').first().getAttribute('href');

  // Müşteri yalıtımı: başka firmanın müşterisi (Beta Cam) çizim ekranını, revizyon ekranını ve dosyayı açamaz (sunucuda)
  const beta = await as(browser, 'beta@betacam.test', TEAM_PW);
  expect((await beta.goto(viewerUrl))?.status()).toBe(404);
  expect((await beta.goto(`${viewerUrl}?revizyon=1`))?.status()).toBe(404);
  expect((await beta.request.get(fileHref!.split('?')[0])).status()).toBe(404);
  expect((await beta.request.get(`${fileHref!.split('?')[0]}?ac=1`)).status()).toBe(404);
  expect((await beta.goto(`/siparisler/${id}`))?.status()).toBe(404);
  await beta.context().close();
  expect((await cust.request.get(fileHref!.split('?')[0])).status()).toBe(200); // kendi firması açar
  await drawer.goto('/siparisler');
  await expect(drawer.locator('.card', { hasText: 'Müşteriden onay beklenenler' }).locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();

  // Onay yetkisi olmayan müşteri kullanıcısı: inceler ama ne onaylayabilir ne revizyon isteyebilir (ekranda da sunucuda da)
  const viewer = await as(browser, VIEWER, TEAM_PW);
  await viewer.goto(`/siparisler/${id}`);
  await expect(viewer.getByText('Hesabınızın onay yetkisi yok')).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Bu çizimi onayla' })).toHaveCount(0);
  await expect(viewer.getByRole('link', { name: 'Revizyon iste' })).toHaveCount(0);
  await viewer.getByRole('link', { name: 'Aç ve incele' }).first().click();
  await expect(viewer).toHaveURL(viewerUrl);
  await expect(viewer.locator('.viewer-page')).toHaveCount(1);
  await expect(viewer.getByText('Hesabınızın onay yetkisi yok')).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Bu çizimi onayla' })).toHaveCount(0);
  await expect(viewer.getByRole('link', { name: 'Revizyon iste' })).toHaveCount(0);
  await viewer.goto(`${viewerUrl}?revizyon=1`); // adresi elle yazsa da revizyon ekranı açılmaz
  await expect(viewer.locator('textarea[name=item]')).toHaveCount(0);
  await expect(viewer.locator('.viewer-layer.editable')).toHaveCount(0);
  await viewer.context().close();

  // Müşteri (onay yetkili): listede "Çizim onay bekliyor"; "Aç ve incele" → görüntüleyicide karar: onayla / revizyon iste
  await cust.goto('/siparisler');
  await expect(cust.getByText('Çizim onay bekliyor').first()).toBeVisible();
  await cust.goto(`/siparisler/${id}`);
  // Yeni çizim: siparişte belirgin kırmızı bilgilendirme; ana işlem "Aç ve incele" (karar 162)
  await expect(cust.locator('#cizim-onay.alert-error')).toContainText('Yeni çizim onayınızı bekliyor (v1).');
  await expect(cust.locator('#cizim-onay').getByRole('link', { name: 'Aç ve incele' })).toHaveClass(/btn-primary/);
  await cust.getByRole('link', { name: 'Aç ve incele' }).first().click();
  await expect(cust.getByRole('button', { name: 'Bu çizimi onayla' })).toBeVisible();
  await expect(cust.locator('.viewer-side')).toHaveCount(0); // boş "İşaretler" bölümü yok
  await cust.locator('.viewer-bar select').selectOption({ label: 'plan-v1.pdf' });
  await expect.poll(() => cust.locator('.viewer-page canvas').evaluate(inked)).toBe(true);
  await shot(cust, '22-musteri-cizim-karar');
  await shot(cust, '22-musteri-cizim-karar', true);
  await cust.locator('.viewer-decide').getByRole('link', { name: 'Revizyon iste' }).click();
  await expect(cust).toHaveURL(/revizyon=1$/);
  await cust.locator('.viewer-bar select').selectOption({ label: 'plan-v1.pdf' });
  await expect.poll(() => cust.locator('.viewer-page canvas').evaluate(inked)).toBe(true);
  // Müşteri revizyon ekranında çizim üzerine işaret araçları (Paket B — karar 227): İğne, Dikdörtgen, Serbest, Metin
  for (const tool of ['İğne', 'Dikdörtgen', 'Serbest', 'Metin']) await expect(cust.getByRole('button', { name: tool, exact: true })).toBeVisible();
  // "Revizyon notu": numaralı maddeler; madde ya da açıklamalı işaret zorunlu (boş / yalnızca boşluk gönderilemez)
  await expect(cust.getByRole('button', { name: 'Revizyon iste' })).toBeDisabled();
  await expect(cust.getByText('Revizyon notu (ya da açıklamalı bir işaret) zorunludur.')).toBeVisible();
  // Ayrı "İşaretler" paneli yok (P5 — karar 244): işaret açıklamaları "Revizyon notu" bölümünde, işaretin numarasıyla
  await expect(cust.locator('.viewer-side')).toHaveCount(0);
  await expect(cust.locator('.viewer-decide [data-revision-marks]')).toBeVisible();
  // İğne: sayfanın %25 / %50 noktasına (konum sayfaya oranlı saklanır)
  const layer = cust.locator('.viewer-layer.editable').first();
  const box = (await layer.boundingBox())!;
  await layer.click({ position: { x: box.width * 0.25, y: box.height * 0.5 } });
  await expect(cust.locator('.ann-pin')).toHaveCount(1);
  await expect(cust.getByRole('button', { name: 'Revizyon iste' })).toBeDisabled(); // açıklamasız işaret tek başına yetmez
  await cust.getByLabel('#1 işaretinin açıklaması', { exact: true }).fill('Bu köşe 5 mm');
  await expect(cust.getByRole('button', { name: 'Revizyon iste' })).toBeEnabled();
  // Dikdörtgen: sürükleyerek
  await cust.getByRole('button', { name: 'Dikdörtgen', exact: true }).click();
  await cust.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.2);
  await cust.mouse.down();
  await cust.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3, { steps: 5 });
  await cust.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.4, { steps: 5 });
  await cust.mouse.up();
  await expect(cust.locator('.ann-rect')).toHaveCount(1);
  // Taslak sayfa yenilenince kaybolmaz (bu tarayıcıda, bu sürüm için)
  await cust.reload();
  await cust.locator('.viewer-bar select').selectOption({ label: 'plan-v1.pdf' });
  await expect(cust.locator('.ann-pin')).toHaveCount(1);
  await expect(cust.locator('.ann-rect')).toHaveCount(1);
  await expect(cust.getByLabel('#1 işaretinin açıklaması', { exact: true })).toHaveValue('Bu köşe 5 mm');
  // Yakınlaştırınca işaret sayfaya göre aynı yerde kalır
  await cust.getByRole('button', { name: 'Yakınlaştır' }).click();
  {
    const l2 = (await cust.locator('.viewer-layer.editable').first().boundingBox())!;
    const p2 = (await cust.locator('.ann-pin').boundingBox())!;
    expect(Math.abs((p2.x + p2.width / 2 - l2.x) / l2.width - 0.25)).toBeLessThan(0.02);
    expect(Math.abs((p2.y + p2.height / 2 - l2.y) / l2.height - 0.5)).toBeLessThan(0.02);
  }
  // Kalıcı numara (P5 — karar 244): üçüncü işaret #3; #2 silinince #1 ve #3 numaralarını korur, açıklamalar kendi işaretinde kalır
  await cust.getByRole('button', { name: 'Sığdır' }).click();
  await cust.getByRole('button', { name: 'İğne', exact: true }).click();
  {
    const l3 = (await cust.locator('.viewer-layer.editable').first().boundingBox())!;
    await cust.locator('.viewer-layer.editable').first().click({ position: { x: l3.width * 0.75, y: l3.height * 0.8 } });
  }
  await expect(cust.locator('.ann-pin')).toHaveCount(2);
  await cust.getByLabel('#3 işaretinin açıklaması', { exact: true }).fill('Sağ alt köşe');
  await cust.getByRole('button', { name: '#2 işaretini sil' }).click();
  await expect(cust.locator('.ann-rect')).toHaveCount(0);
  await expect(cust.locator('[data-revision-marks] [data-mark-no]')).toHaveCount(2);
  expect(await cust.locator('[data-revision-marks] [data-mark-no]').evaluateAll((els) => els.map((e) => e.getAttribute('data-mark-no')))).toEqual(['1', '3']);
  await expect(cust.locator('.ann-pin')).toHaveText(['1', '3']);
  await expect(cust.getByLabel('#1 işaretinin açıklaması', { exact: true })).toHaveValue('Bu köşe 5 mm');
  await expect(cust.getByLabel('#3 işaretinin açıklaması', { exact: true })).toHaveValue('Sağ alt köşe');
  // Yeni işaret silinen numarayı yeniden almaz (#4)
  {
    const l4 = (await cust.locator('.viewer-layer.editable').first().boundingBox())!;
    await cust.locator('.viewer-layer.editable').first().click({ position: { x: l4.width * 0.1, y: l4.height * 0.1 } });
  }
  await expect(cust.getByLabel('#4 işaretinin açıklaması', { exact: true })).toBeVisible();
  await cust.getByRole('button', { name: '#4 işaretini sil' }).click();
  await expect(cust.locator('.ann-pin')).toHaveText(['1', '3']);
  // Sayfa yenilense de silinen son numara (#4) yeniden verilmez: sayaç taslakla saklanır (karar 244)
  await cust.reload();
  await cust.locator('.viewer-bar select').selectOption({ label: 'plan-v1.pdf' });
  await expect(cust.locator('.ann-pin')).toHaveText(['1', '3']);
  await expect(cust.getByLabel('#3 işaretinin açıklaması', { exact: true })).toHaveValue('Sağ alt köşe');
  await cust.getByRole('button', { name: 'İğne', exact: true }).click();
  {
    const l5 = (await cust.locator('.viewer-layer.editable').first().boundingBox())!;
    await cust.locator('.viewer-layer.editable').first().click({ position: { x: l5.width * 0.1, y: l5.height * 0.15 } });
  }
  await expect(cust.getByLabel('#5 işaretinin açıklaması', { exact: true })).toBeVisible();
  await expect(cust.getByLabel('#4 işaretinin açıklaması', { exact: true })).toHaveCount(0);
  await cust.getByRole('button', { name: '#5 işaretini sil' }).click();
  await expect(cust.locator('.ann-pin')).toHaveText(['1', '3']);
  await cust.getByLabel('Madde 1', { exact: true }).fill('   ');
  await cust.getByLabel('Madde 1', { exact: true }).fill('Bu ölçü 1100 olmalı');
  await cust.getByRole('button', { name: '+ Madde ekle' }).click();
  await cust.getByLabel('Madde 2', { exact: true }).fill('2. Bu kenar yuvarlatılsın'); // elle yazılan numara atılır
  await cust.getByRole('button', { name: '+ Madde ekle' }).click();
  await cust.getByLabel('Madde 3', { exact: true }).fill('silinecek madde');
  await cust.getByRole('button', { name: 'Madde 3: çıkar' }).click();
  await expect(cust.getByLabel('Madde 3', { exact: true })).toHaveCount(0);
  await cust.getByRole('button', { name: '+ Madde ekle' }).click();
  await cust.getByLabel('Madde 3', { exact: true }).fill('2 delik Ø12');
  await shot(cust, '23-musteri-revizyon');
  await cust.getByRole('button', { name: 'Revizyon iste' }).click();
  await expect(cust.getByText('Revizyon talebiniz çizim ekibine iletildi.')).toBeVisible();

  // Kayıt: tek numaralı metin (açıklamalı işaret "#1: …" maddesi); işaretler talebe bağlı, sayfaya oranlı
  {
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient();
    try {
      const rev = await db.drawingRevision.findFirstOrThrow({ where: { drawing: { orderId: id } }, orderBy: { createdAt: 'desc' }, include: { drawing: { include: { files: true } } } });
      expect(rev.comment).toBe('1. Bu ölçü 1100 olmalı\n2. Bu kenar yuvarlatılsın\n3. 2 delik Ø12\n4. #1: Bu köşe 5 mm\n5. #3: Sağ alt köşe');
      const plan = rev.drawing.files.find((f) => f.name === 'plan-v1.pdf')!;
      const marks = rev.annotations as { id: string; no: number; fileId: string; type: string; x: number; y: number; text: string }[];
      // Kalıcı kimlik + numara saklanır (P5 — karar 244): silinen #2 yok, #3 numarasını korur
      expect(marks.map((a) => [a.fileId === plan.id, a.type, a.text, a.no])).toEqual([[true, 'pin', 'Bu köşe 5 mm', 1], [true, 'pin', 'Sağ alt köşe', 3]]);
      expect(new Set(marks.map((a) => a.id)).size).toBe(2);
      expect(Math.abs(marks[0].x - 0.25)).toBeLessThan(0.02);
      expect(Math.abs(marks[0].y - 0.5)).toBeLessThan(0.02);
    } finally {
      await db.$disconnect();
    }
  }

  // Çizimci: iş yeniden "Yapılacak çizimler"de; numaralı revizyon notu (sıralı liste) ve eski işaret çizim üzerinde
  await drawer.goto('/siparisler');
  await expect(drawer.locator('.card', { hasText: 'Yapılacak çizimler' }).locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();
  await drawer.goto(`/siparisler/${id}`);
  await expect(drawer.locator('.page-head .badge', { hasText: 'Revizyon istendi' })).toBeVisible();
  const request = drawer.locator('#cizim .note', { hasText: 'Revizyon talebi:' }).first();
  await expect(request.locator('ol.revision-list li')).toHaveText(['Bu ölçü 1100 olmalı', 'Bu kenar yuvarlatılsın', '2 delik Ø12', '#1: Bu köşe 5 mm', '#3: Sağ alt köşe']);
  await drawer.getByRole('link', { name: 'çizim üzerinde gör (2 işaret)' }).click();
  await drawer.locator('.viewer-bar select').selectOption({ label: 'plan-v1.pdf' });
  await expect(drawer.locator('.ann-pin')).toHaveText(['1', '3']);
  await expect(drawer.locator('.ann-rect')).toHaveCount(0);
  await expect(drawer.locator('.viewer-side')).toContainText('Bu köşe 5 mm');
  await expect(drawer.locator('.viewer-side .badge-info')).toHaveText(['1', '3']); // iç ekipte salt okunur panel aynı numaralarla
  const pin = await drawer.locator('.ann-pin').first().evaluate((e: HTMLElement) => [parseFloat(e.style.left), parseFloat(e.style.top)]);
  expect(Math.abs(pin[0] - 25)).toBeLessThan(2);
  expect(Math.abs(pin[1] - 50)).toBeLessThan(2);
  await expect(drawer.locator('.viewer-requests ol.revision-list li')).toHaveCount(5);
  await expect(drawer.locator('.viewer-layer.editable')).toHaveCount(0); // çizimci işaretleri değiştiremez
  await expect(drawer.getByRole('button', { name: 'Müşteriye gönder' })).toHaveCount(0); // eski sürüm yeniden gönderilemez

  // v2 → müşteri GÖRÜNTÜLEYİCİDEN onaylar → "Müşteriden onaylı çizimler"; v1, dosyaları ve talebi geçmişte kalır
  await drawer.goto(`/siparisler/${id}`);
  await uploadDrawing(drawer, [file('plan-v2.pdf', realPdf())]);
  await sendDrawing(drawer, id);
  await cust.goto(`/siparisler/${id}`);
  await cust.getByRole('link', { name: 'Aç ve incele' }).first().click();
  await expect(cust.locator('.page-head .badge', { hasText: 'v2' })).toBeVisible();
  await cust.getByRole('button', { name: 'Bu çizimi onayla' }).click();
  await expect(cust.getByText(/Çizimi onayladınız|üretime alındı/)).toBeVisible();
  // Onay kesindir: artık ne onay ne revizyon işlemi var (sipariş sayfasında da görüntüleyicide de)
  await expect(cust.getByRole('button', { name: 'Bu çizimi onayla' })).toHaveCount(0);
  await expect(cust.getByRole('link', { name: 'Revizyon iste' })).toHaveCount(0);
  const v1 = cust.locator('.drawing-version', { hasText: 'plan-v1.pdf' });
  await expect(v1).toContainText('revizyon istendi');
  await expect(v1.locator('ol.revision-list li')).toHaveText(['Bu ölçü 1100 olmalı', 'Bu kenar yuvarlatılsın', '2 delik Ø12', '#1: Bu köşe 5 mm', '#3: Sağ alt köşe']);
  await expect(v1.getByRole('link', { name: /işaret\)/ })).toHaveCount(0); // işaret bağlantısı yalnızca iç ekipte
  await expect(v1.locator('.file-row')).toHaveCount(4); // v1'in dosyaları (teknik ek dahil) aynen duruyor
  await expect(cust.locator('.drawing-version', { hasText: 'plan-v2.pdf' })).toContainText('onaylandı');
  await cust.goto(`${viewerUrl}?revizyon=1`); // eski sürüm için revizyon ekranı açılmaz
  await expect(cust.locator('textarea[name=item]')).toHaveCount(0);
  await cust.locator('.viewer-bar select').selectOption({ label: 'plan-v1.pdf' });
  // Eski sürüm salt görüntülenir: müşteri kendi talebinin işaretlerini görür (karar 227), değiştiremez
  await expect(cust.locator('.ann-pin')).toHaveText(['1', '3']);
  await expect(cust.locator('.viewer-side')).toContainText('Bu köşe 5 mm');
  await expect(cust.locator('.viewer-layer.editable')).toHaveCount(0);
  await expect(cust.locator('.viewer-side input')).toHaveCount(0);
  await expect(cust.locator('.viewer-requests ol.revision-list li')).toHaveText(['Bu ölçü 1100 olmalı', 'Bu kenar yuvarlatılsın', '2 delik Ø12', '#1: Bu köşe 5 mm', '#3: Sağ alt köşe']);

  // Onaylanmış çizimler: çizim ekibi ve yönetici görür (satışın "Sıra bende"sinde yok — fonksiyonel paket 1); yükleme
  // gününe göre süzme, en yeni / en eski
  await drawer.goto('/siparisler');
  const approved = (p: typeof drawer) => p.locator('#onayli-cizimler');
  await expect(approved(drawer).locator('h2')).toContainText('Müşteriden onaylı çizimler');
  await expect(approved(drawer).locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();
  await shot(drawer, '24-cizim-paneli-onayli-cizimler');
  await approved(drawer).getByRole('link', { name: 'En eski' }).click();
  await expect(drawer).toHaveURL(/onay=eski/);
  const days = await approved(drawer).locator('#onayli-yukleme option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  expect(days[0]).toBe('');
  expect(days.length).toBeGreaterThan(1);
  const total = await approved(drawer).locator('tbody a.btn').count();
  await approved(drawer).locator('#onayli-yukleme').selectOption(days[1]);
  await approved(drawer).getByRole('button', { name: 'Süz' }).click();
  await expect(drawer).toHaveURL(new RegExp(`yukleme=${days[1]}`));
  await expect(drawer).toHaveURL(/onay=eski/); // sıralama korunur
  const filtered = await approved(drawer).locator('tbody a.btn').count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThanOrEqual(total);
  await drawer.goto('/siparisler?yukleme=2000-01-01');
  await expect(approved(drawer)).toContainText('Onaylanmış çizim yok.');
  // Yönetici: onaylı çizimler Çizim Paneli'nde (karar 217 — yöneticinin "Sıra bende"sinde yalnızca dört tablo var)
  const adminPage = await as(browser, ADMIN, ADMIN_PW);
  await adminPage.goto('/siparisler');
  await expect(approved(adminPage)).toHaveCount(0);
  await adminPage.goto('/siparisler?panel=cizim');
  await expect(approved(adminPage).locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();
  await adminPage.context().close();
  // Satış: "Sıra bende"de yalnızca "Yeni siparişler" ve "SLA riski / gecikenler" — onaylanmış çizimler bölümü (ve teklif /
  // üretim bölümleri) yok. Sipariş "Tüm aktif siparişler" sekmesinde durur; firma adı satışta maskelidir.
  const sales = await as(browser, SALES2, TEAM_PW);
  await sales.goto('/siparisler');
  await expect(approved(sales)).toHaveCount(0);
  const titles = await sales.locator('main .card-head h2').allTextContents();
  expect(titles.map((x) => x.replace(/\s*\d+\s*$/, '').trim())).toEqual(['Yeni siparişler — karar bekliyor', 'SLA riski / gecikenler']);
  await sales.goto('/siparisler?view=all');
  await expect(sales.locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();
  const list = await sales.content();
  expect(list).not.toContain('Ünsal Cam');
  expect(list).toContain('Üns**********'); // ilk 3 karakter + sabit sayıda yıldız (maskeleme kuralı değişmedi)
  await sales.context().close();
});
