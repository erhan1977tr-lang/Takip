import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as, newOrder } from './helpers';

// Çizim görüntüleyici (gerçek PDF ve PNG ile): çizimci "Kontrol Et" → müşteri "Revizyon iste" ekranında çizim üzerine
// işaret koyar, zorunlu notla gönderir → çizimci işaretleri çizim üzerinde görür → v2 → müşteri onaylar →
// çizim panelinde "Müşteri tarafından onaylanmış çizimler". Çizimcinin sipariş sayfasında ticari bölümler yok.
test.describe.configure({ mode: 'serial' });

/** Geçerli, tek sayfalık küçük PDF (300 × 200 pt; bir çizgi) */
function realPdf(): Buffer {
  const content = '2 w 20 20 m 280 180 l S';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
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

test('çizim görüntüleyici: kontrol et → işaretli revizyon → işaretler çizimcide → onay → onaylanmış çizimler', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Görüntüleyici', 'plan.pdf');
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${id}`);
  await admin.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(admin.getByText('Sipariş çizim ekibine yönlendirildi.')).toBeVisible();

  // Çizimci: sipariş sayfasında yalnızca dosyalar, çizimler, notlar, sipariş bilgileri (sandık / teklif / istenen camlar yok)
  const drawer = await as(browser, DRAWER, TEAM_PW);
  await drawer.goto(`/siparisler/${id}`);
  await expect(drawer.locator('#sandik')).toHaveCount(0);
  await expect(drawer.locator('#teklif')).toHaveCount(0);
  await expect(drawer.getByText('İstenen camlar')).toHaveCount(0);
  const heads = await drawer.locator('h2').allTextContents();
  const pos = (h: string) => heads.findIndex((x) => x.includes(h));
  expect(pos('Müşteri sipariş dosyaları')).toBeGreaterThanOrEqual(0);
  expect(pos('Müşteri sipariş dosyaları')).toBeLessThan(pos('Teknik çizimler ve onay')); // dosyalar üstte
  expect(pos('Teknik çizimler ve onay')).toBeLessThan(pos('Sipariş bilgileri'));

  await drawer.setInputFiles('#drawing-file', [file('plan-v1.pdf', realPdf()), file('detay-v1.png', realPng())]);
  await drawer.getByRole('button', { name: 'Taslağa yükle' }).click();
  await expect(drawer.getByText('Dosyalar taslağa eklendi.')).toBeVisible();

  // "Kontrol Et": PDF gerçekten çiziliyor (pdf.js) ve görsel açılıyor; müşteri taslağın ekranını açamaz
  await drawer.getByRole('link', { name: 'Kontrol Et' }).click();
  await expect(drawer).toHaveURL(/\/cizim\/[a-z0-9]+$/);
  const viewerUrl = drawer.url();
  await drawer.locator('.viewer-bar select').selectOption({ label: 'plan-v1.pdf' });
  const canvas = drawer.locator('.viewer-page canvas');
  await expect(canvas).toHaveCount(1);
  await expect.poll(() => canvas.evaluate(inked)).toBe(true); // sayfa gerçekten çizildi (PDF'teki çizgi)
  await expect(drawer.locator('.viewer-layer.editable')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'İğne' })).toHaveCount(0); // çizimci işaret koymaz
  await drawer.locator('.viewer-bar select').selectOption({ label: 'detay-v1.png' });
  await expect.poll(() => drawer.locator('.viewer-page img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(240);
  expect((await cust.goto(viewerUrl))?.status()).toBe(404);

  await drawer.goto(`/siparisler/${id}`);
  await drawer.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(drawer.getByText('Çizim müşterinin onayına gönderildi.')).toBeVisible();
  // Başka firmanın müşterisi (Beta Cam) gönderilmiş çizimin ekranını da revizyon ekranını da açamaz (sunucuda, firma kapsamı)
  const beta = await as(browser, 'beta@betacam.test', TEAM_PW);
  expect((await beta.goto(viewerUrl))?.status()).toBe(404);
  expect((await beta.goto(`${viewerUrl}?revizyon=1`))?.status()).toBe(404);
  await beta.context().close();
  await drawer.goto('/siparisler');
  await expect(drawer.locator('.card', { hasText: 'Onay bekleyen çizimler' }).locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();

  // Müşteri: listede "Çizim onay bekliyor"; "Aç ve incele" ve "Revizyon iste"
  await cust.goto('/siparisler');
  await expect(cust.getByText('Çizim onay bekliyor').first()).toBeVisible();
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.getByRole('link', { name: 'Aç ve incele' }).first()).toBeVisible();
  await cust.getByRole('link', { name: 'Revizyon iste' }).click();
  await expect(cust).toHaveURL(/revizyon=1$/);
  await cust.locator('.viewer-bar select').selectOption({ label: 'plan-v1.pdf' });
  await expect.poll(() => cust.locator('.viewer-page canvas').evaluate(inked)).toBe(true);
  const layer = cust.locator('.viewer-page .viewer-layer.editable');
  await expect(layer).toHaveCount(1);
  let box = (await layer.boundingBox())!;
  // İğne (varsayılan araç)
  await layer.click({ position: { x: box.width * 0.25, y: box.height * 0.5 } });
  await expect(cust.locator('.ann-pin')).toHaveCount(1);
  await cust.getByLabel('İşaretler 1', { exact: true }).fill('Bu ölçü 1100 olmalı');
  // Dikdörtgen (sürükleyerek)
  await cust.getByRole('button', { name: 'Dikdörtgen' }).click();
  await layer.scrollIntoViewIfNeeded();
  box = (await layer.boundingBox())!;
  await cust.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await cust.mouse.down();
  await cust.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 5 });
  await cust.mouse.up();
  await expect(cust.locator('.ann-rect')).toHaveCount(1);
  // Not zorunlu
  await expect(cust.getByRole('button', { name: 'Revizyon iste' })).toBeDisabled();
  await cust.fill('#rev-comment', 'İşaretli yerleri düzeltin');
  await cust.getByRole('button', { name: 'Revizyon iste' }).click();
  await expect(cust.getByText('Revizyon talebiniz çizim ekibine iletildi.')).toBeVisible();

  // Çizimci: iş yeniden "Yapılacak çizimler"de; revizyon notu ve işaretler çizim üzerinde
  await drawer.goto('/siparisler');
  await expect(drawer.locator('.card', { hasText: 'Yapılacak çizimler' }).locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();
  await drawer.goto(`/siparisler/${id}`);
  await expect(drawer.getByText('İşaretli yerleri düzeltin').first()).toBeVisible();
  await drawer.getByRole('link', { name: 'çizim üzerinde gör (2 işaret)' }).click();
  await expect(drawer.locator('.ann-pin')).toHaveCount(1);
  await expect(drawer.locator('.ann-rect')).toHaveCount(1);
  await expect(drawer.getByText('Bu ölçü 1100 olmalı')).toBeVisible();
  // İşaret, müşterinin koyduğu yerde (sayfanın %25 / %50'si)
  const pin = await drawer.locator('.ann-pin').evaluate((e: HTMLElement) => [parseFloat(e.style.left), parseFloat(e.style.top)]);
  expect(Math.abs(pin[0] - 25)).toBeLessThan(2);
  expect(Math.abs(pin[1] - 50)).toBeLessThan(2);

  // v2 → müşteri onaylar → çizim panelinde "Müşteri tarafından onaylanmış çizimler"; v1 ve talebi geçmişte kalır
  await drawer.goto(`/siparisler/${id}`);
  await drawer.setInputFiles('#drawing-file', file('plan-v2.pdf', realPdf()));
  await drawer.getByRole('button', { name: 'Taslağa yükle' }).click();
  await drawer.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(drawer.getByText('Çizim müşterinin onayına gönderildi.')).toBeVisible();
  await cust.goto(`/siparisler/${id}`);
  await cust.getByRole('button', { name: 'Çizimi onayla' }).click();
  await expect(cust.getByText(/Çizimi onayladınız|üretime alındı/)).toBeVisible();
  await expect(cust.locator('.drawing-version', { hasText: 'plan-v1.pdf' })).toContainText('revizyon istendi');
  await drawer.goto('/siparisler');
  await expect(drawer.locator('.card', { hasText: 'Müşteri tarafından onaylanmış çizimler' }).locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();
  await drawer.getByRole('link', { name: 'En eski' }).click();
  await expect(drawer).toHaveURL(/onay=eski/);
});
