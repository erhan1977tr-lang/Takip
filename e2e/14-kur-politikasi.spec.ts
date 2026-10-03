import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, TEAM_PW, as } from './helpers';

// Müşteri kur politikası (Aşama 7D-1, karar 95–98): Yönetici → Müşteriler'de politika seçimi (BT / BNR / BNR + %; zorunlu, varsayılan BT),
// yüzde doğrulaması sunucuda, bugünün kuru önizlemesi, cam siparişinin Finans / FGO bölümünde kur önizlemesi + elle kur alanı.
// Yetkisiz roller politikayı adresle ya da taklit form gönderimiyle değiştiremez.
// FGO bu veritabanında kapalıdır: hiçbir belge kesilmez.
test.describe.configure({ mode: 'serial' });

const SALES2 = 'fiyat-satis@e2e.test';
const INSPECTOR = 'denetim@e2e.test';
let firmId = '';
let orderId = '';
const firmUrl = () => `/admin/firms/${firmId}`;

async function shot(page: Page, name: string) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const before = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `masaustu-${name}.png`), fullPage: true });
  if (before) await page.setViewportSize(before);
}

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const policyOf = async () => {
  const db = await prisma();
  const f = await db.customer.findUniqueOrThrow({ where: { id: firmId } });
  await db.$disconnect();
  return [f.fxPolicy, f.fxMarkupPercent?.toString() ?? null];
};

async function actionField(page: Page, url: string, marker: string): Promise<string> {
  const html = await (await page.request.get(url)).text();
  const form = html.split('<form').find((chunk) => chunk.includes(marker));
  const m = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form) : null;
  expect(m, `sunucu işlemi alanı bulunamadı (${url}, ${marker})`).toBeTruthy();
  return m![0];
}
async function forge(page: Page, url: string, field: string, data: Record<string, string>) {
  const origin = new URL(page.url()).origin;
  return page.request.post(url, { multipart: { [field]: '', ...data }, headers: { origin } });
}

test('veri: kur politikası için ayrı müşteri ve belgesi olmayan EUR cam siparişi', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const firm = await db.customer.create({ data: { name: 'Kur E2E SRL', prefix: 'KUR', taxId: '445566', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. Curs 1' } });
  expect([firm.fxPolicy, firm.fxMarkupPercent], 'yeni müşteri: varsayılan politika BT').toEqual(['BT_UNIT_SELL', null]);
  const order = await db.order.create({
    data: {
      orderNo: 'KUR1', customerOrderNo: 1, title: 'Kur e2e', orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE',
      estimatedShipDate: new Date(Date.now() + 20 * 86_400_000),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: '100.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
    },
  });
  await db.$disconnect();
  firmId = firm.id;
  orderId = order.id;
});

test('yönetici: varsayılan politika BT; BNR + % kaydedilir, geçersiz yüzde reddedilir; önizleme', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(firmUrl());
  await expect(page.locator('#fxPolicy')).toHaveValue('BT_UNIT_SELL');
  await expect(page.locator('#fxPolicy option'), 'yalnızca üç politika; "seçilmedi" yok').toHaveCount(3);
  await expect(page.locator('#fxMarkupPercent')).toHaveCount(0);
  await expect(page.locator('#kur-bugun .fx-info, #kur-bugun .fx-unavailable')).toHaveCount(1);

  // Yüzde alanı yalnızca "BNR + %" seçilince görünür; sunucu 0–20 dışını reddeder
  await page.selectOption('#fxPolicy', 'BNR');
  await expect(page.locator('#fxMarkupPercent')).toHaveCount(0);
  await page.selectOption('#fxPolicy', 'BNR_PLUS_PERCENT');
  await page.fill('#fxMarkupPercent', '50');
  await page.locator('form:has(#fxPolicy) button[type=submit]').click();
  await expect(page).toHaveURL(new RegExp(`/admin/firms/${firmId}\\?error=`));
  await expect(page.locator('.alert-error')).toBeVisible();
  expect(await policyOf(), 'geçersiz yüzde kaydedilmedi').toEqual(['BT_UNIT_SELL', null]);

  await page.selectOption('#fxPolicy', 'BNR_PLUS_PERCENT');
  await page.fill('#fxMarkupPercent', '2,5');
  await page.locator('form:has(#fxPolicy) button[type=submit]').click();
  await expect(page).toHaveURL(/\/admin\/firms\?saved=/);
  expect(await policyOf()).toEqual(['BNR_PLUS_PERCENT', '2.5']);

  // Önizleme: seçili politika; BNR alınabildiyse kur tablosu, alınamadıysa "alınamadı" (başka kur gösterilmez)
  await page.goto(firmUrl());
  await expect(page.locator('#fxPolicy')).toHaveValue('BNR_PLUS_PERCENT');
  await expect(page.locator('#fxMarkupPercent')).toHaveValue('2,5');
  const today = page.locator('#kur-bugun');
  await expect(today).toContainText(/BNR.*2,5/);
  await expect(today.locator('.fx-info, .fx-unavailable')).toHaveCount(1);
  await shot(page, 'kur-musteri');

  // Cam siparişi → Finans / FGO: kur önizlemesi ve elle kur alanı (kuru bu belge belirleyecek)
  await page.goto(`/siparisler/${orderId}`);
  const prev = page.locator('#kur-onizleme');
  await expect(prev).toContainText(/BNR.*2,5/);
  await expect(prev.locator('.fx-info, .fx-unavailable')).toHaveCount(1);
  await expect(page.locator('#gb-rate-proforma')).toBeVisible();
  await shot(page, 'kur-finans');

  // Denetim kaydı: politika değişikliği
  const db = await prisma();
  const audits = await db.auditLog.findMany({ where: { entityId: firmId, action: 'CUSTOMER_UPDATE' } });
  expect(audits.map((a) => (a.details as { after?: { fxPolicy?: string } }).after?.fxPolicy)).toEqual(['BNR_PLUS_PERCENT']);
  await db.$disconnect();
  await page.context().close();
});

test('BT politikası: otomatik kur yok — günün BT kuru girilmediyse "alınamıyor" denir, BT XML kuru gösterilmez', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  await page.goto(firmUrl());
  await page.selectOption('#fxPolicy', 'BT_UNIT_SELL');
  await expect(page.locator('#fxMarkupPercent')).toHaveCount(0);
  await page.locator('form:has(#fxPolicy) button[type=submit]').click();
  await expect(page).toHaveURL(/\/admin\/firms\?saved=/);
  expect(await policyOf(), 'yüzde yalnızca BNR + % ile saklanır').toEqual(['BT_UNIT_SELL', null]);
  // Günün BT kuru bu testte girilmemiş olsun
  const db = await prisma();
  await db.integrationSetting.deleteMany({ where: { key: 'fx.daily' } });
  await db.$disconnect();
  await page.goto(firmUrl());
  const today = page.locator('#kur-bugun');
  await expect(today.locator('.fx-unavailable')).toBeVisible();
  await expect(today.locator('.fx-info')).toHaveCount(0);
  await expect(today).not.toContainText('exchange.xml');
  await expect(today.locator('a[href="/admin/entegrasyonlar"]')).toBeVisible();
  await shot(page, 'kur-musteri-bt');
  await page.context().close();
});

test('yetkisiz roller kur politikasını değiştiremez: sayfa açılmaz, taklit form gönderimi çalışmaz; politikasız kayıt olmaz', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const field = await actionField(admin, firmUrl(), 'name="fxPolicy"');
  const data = { id: firmId, name: 'Kur E2E SRL', type: 'CUSTOMER', prefix: 'KUR', groupName: '', camEtiket: '', sandikEtiket: '', fxPolicy: 'BNR', fxMarkupPercent: '' };
  for (const [who, email, pw] of [['musteri', CUSTOMER, CUST_PW], ['satis', SALES2, TEAM_PW], ['cizim', DRAWER, TEAM_PW], ['denetim', INSPECTOR, 'Denet1']] as const) {
    const p = await as(browser, email, pw);
    await p.goto(firmUrl());
    await expect(p, `${who}: sayfa`).toHaveURL(/\/siparisler$/);
    const r = await forge(p, firmUrl(), field, data);
    expect(r.url(), `${who}: taklit istek`).toMatch(/\/siparisler$/);
    expect(await policyOf(), `${who}: politika değişmedi`).toEqual(['BT_UNIT_SELL', null]);
    await p.context().close();
  }
  // Karşı kontrol: aynı istek yönetici oturumuyla çalışır (engel yetki kontrolüdür)
  const ok = await forge(admin, firmUrl(), field, data);
  expect(ok.url()).toContain('/admin/firms?saved=');
  expect(await policyOf()).toEqual(['BNR', null]);

  // Politika zorunlu: boş politika yönetici oturumuyla bile kaydedilmez
  const empty = await forge(admin, firmUrl(), field, { ...data, fxPolicy: '' });
  expect(empty.url()).toContain(`/admin/firms/${firmId}?error=`);
  expect(await policyOf()).toEqual(['BNR', null]);
  // Yönetici varsayılana (BT) döner
  await admin.goto(firmUrl());
  await admin.selectOption('#fxPolicy', 'BT_UNIT_SELL');
  await admin.locator('form:has(#fxPolicy) button[type=submit]').click();
  await expect(admin).toHaveURL(/\/admin\/firms\?saved=/);
  expect(await policyOf()).toEqual(['BT_UNIT_SELL', null]);
  await admin.context().close();
});

// Tanı (başarısız olmaz): BNR'nin resmî kur dosyası bu ortamdan okunabiliyor mu? Sonuç ekran görüntüleri klasörüne
// yazılır (bnr-erisim.txt). Yalnızca okuma; kur değeri sınanmaz (her gün değişir).
test('tanı: BNR resmî kur dosyasına erişim', async () => {
  const dir = process.env.SCREENSHOT_DIR;
  test.skip(!dir, 'SCREENSHOT_DIR yok');
  const out: string[] = [];
  for (const url of ['https://curs.bnr.ro/nbrfxrates.xml']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' } });
      const body = await res.text();
      out.push(`== ${url}\nHTTP ${res.status} · son adres ${res.url} · content-type ${res.headers.get('content-type') ?? '-'} · server ${res.headers.get('server') ?? '-'} · uzunluk ${body.length}`);
      out.push(body.slice(0, 700).replace(/\s+/g, ' '));
      const i = body.indexOf('EUR');
      out.push(`EUR çevresi: ${i < 0 ? 'yok' : body.slice(Math.max(0, i - 120), i + 80).replace(/\s+/g, ' ')}`);
    } catch (e) {
      out.push(`== ${url}\nistek olmadı: ${String((e as Error)?.message ?? e)}`);
    }
  }
  fs.mkdirSync(dir!, { recursive: true });
  fs.writeFileSync(path.join(dir!, 'bnr-erisim.txt'), `${out.join('\n')}\n`);
});
