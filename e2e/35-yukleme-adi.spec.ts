import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { CUSTOMER, CUST_PW, GLASS, TEAM_PW, as, sampleFile, zipOf } from './helpers';

// Yükleme: dosya adı ve geçici dosya temizliği (GO-LIVE saldırı turu NEW-GL-02, karar 153) — gerçek sunucuda, üç yoldan:
// müşteri (yeni sipariş + sipariş sayfası), ekip (sipariş sayfası, iç dosya) ve depo bağlantısı (oturumsuz).
// Eski sürümde ham ada göre ".pdf" olan 184 karakterlik "….constructor.pdf" adı 180 karaktere kesilince ".constructor" ile
// bitiyor, içerik denetimi hata fırlatıyor (500), geçici dosya ve aynı istekte ondan önce saklanan dosya diskte kalıyordu;
// "….zip.pdf" ise ".zip" olup tür denetimini atlatıyordu. Şimdi:
//  - böyle adlı gerçek PDF olağan bir yüklemedir (ad 180 karakter, uzantı .pdf); indirilebilir
//  - içeriği uyuşmayan dosya açık mesajla reddedilir; aynı istekteki öteki dosyalar da saklanmaz
//  - hiçbir durumda UPLOAD_DIR/.gelen altında dosya kalmaz; kalıcı yerdeki dosya sayısı yalnızca kabul edilenler kadar artar
// (11'in depo bağlantısı ve 08'de açılan satışçı kullanılır. Dosyalar birkaç yüz bayttır.)
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açıldı (satis@e2e.test 05'te bilerek kilitleniyor)
const ROOT = process.env.UPLOAD_DIR ?? '';
/** Toplam uzunluğu n olan, verilen sonekle biten ad */
const padded = (n: number, tail: string, fill = 'a') => fill.repeat(n - tail.length) + tail;
/** Sunucunun saklayacağı ad (bağımsız hesap): 180 karakterden uzunsa gövde kısalır, uzantı aynı kalır */
const storedName = (raw: string) => (raw.length <= 180 ? raw : raw.slice(0, 180 - (raw.length - raw.lastIndexOf('.'))) + raw.slice(raw.lastIndexOf('.')));
const pdf = (name: string, label = 'yukleme adi') => ({ ...sampleFile('x.pdf', label), name });
const zip = (name: string) => ({ name, mimeType: 'application/octet-stream', buffer: zipOf([{ name: 'icerik.txt', data: Buffer.from('zip icerigi') }]) });
const exe = (name: string) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('MZ bu bir PDF değil') });

/** .gelen altındaki geçici dosyalar */
const temps = () => (fs.existsSync(path.join(ROOT, '.gelen')) ? fs.readdirSync(path.join(ROOT, '.gelen')) : []);
/** Kalıcı yerdeki dosya sayısı (YYYY/AA/…; noktalı klasörler — .gelen, .karantina — sayılmaz) */
function kept(): number {
  let n = 0;
  const walk = (dir: string, top: boolean) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (top && e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), false);
      else n++;
    }
  };
  walk(ROOT, true);
  return n;
}
/** Sipariş sayfasındaki "Dosya ekle" formu */
async function addFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  // Sayfada çizim yükleme formu da olabilir (aynı alan adı): yalnızca "Dosya ekle" formu
  const form = page.locator('form', { has: page.locator('button', { hasText: 'Dosya ekle' }) });
  await form.locator('input[name=files]').setInputFiles(files);
  await form.locator('button', { hasText: 'Dosya ekle' }).click();
}

let orderUrl = '';

test.beforeAll(() => {
  expect(ROOT, 'UPLOAD_DIR (test süreci sunucunun yükleme klasörünü görmeli)').toBeTruthy();
  expect(fs.existsSync(ROOT)).toBe(true);
});

test('müşteri: "….constructor.pdf" olağan yüklemedir; içeriği uyuşmayan dosya reddedilir, hiçbir dosya artık bırakmaz', async ({ browser }) => {
  test.setTimeout(120_000);
  expect(temps(), 'önceki testlerden geçici dosya kalmamış olmalı').toEqual([]);
  const start = kept();
  const cust = await as(browser, CUSTOMER, CUST_PW);

  // Yeni sipariş: iki dosyalı istek, ikincisi PDF değil → sipariş oluşmaz, birinci dosya da saklanmaz
  await cust.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await cust.fill('#title', 'Yükleme adı (ret)');
  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: GLASS });
  await cust.setInputFiles('#files', [pdf('iyi.pdf'), exe(padded(184, '.__proto__.pdf'))]);
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(cust.getByText(/dosyasının içeriği uzantısıyla uyuşmuyor/)).toBeVisible({ timeout: 30_000 });
  await expect(cust).toHaveURL(/\/siparisler\/yeni/);
  expect([temps(), kept()]).toEqual([[], start]);

  // Yeni sipariş: saldırı adı + gerçek PDF → sipariş oluşur; ad 180 karaktere iner, uzantı .pdf kalır
  const attack = padded(184, '.constructor.pdf');
  await cust.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await cust.fill('#title', 'Yükleme adı');
  await cust.getByLabel('Cam', { exact: true }).selectOption({ label: GLASS });
  await cust.setInputFiles('#files', [pdf('olagan.pdf'), pdf(attack, 'saldiri adi, gercek pdf')]);
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/, { timeout: 45_000 });
  orderUrl = new URL(cust.url()).pathname;
  expect([storedName(attack).length, storedName(attack)]).toEqual([180, `${'a'.repeat(168)}.constru.pdf`]);
  const row = cust.locator('.file-row', { hasText: 'a'.repeat(60) });
  await expect(row.locator('.fname')).toHaveText(storedName(attack));
  await expect(row.locator('.file-ext')).toHaveText('pdf');
  expect([temps(), kept()]).toEqual([[], start + 2]);
  // İndirilebilir ve içerik aynı
  const href = await row.locator('a[href^="/dosya/siparis/"]').last().getAttribute('href');
  const got = await cust.request.get(href!);
  expect(got.status()).toBe(200);
  expect((await got.body()).toString('latin1')).toContain('saldiri adi, gercek pdf');

  // Sipariş sayfası: iki dosyalı istek, ikincisi ZIP (ham ad ".pdf") → ret; birincisi de saklanmaz
  // (her ret kendi dosya adını taşır: beklenen mesaj bir önceki isteğinkiyle karışmaz)
  await addFiles(cust, [pdf('ek-1.pdf'), zip(padded(184, '.constructor.pdf', 'b'))]);
  await expect(cust.getByText(new RegExp(`“b{168}\\.constru\\.pdf” dosyasının içeriği uzantısıyla uyuşmuyor`))).toBeVisible();
  expect([temps(), kept()]).toEqual([[], start + 2]);
  // ".zip.pdf": eski kesme adı ".zip" yapıp ZIP'i kabul ettiriyordu → ret
  await addFiles(cust, [zip(padded(184, '.zip.pdf', 'c'))]);
  await expect(cust.getByText(new RegExp(`“c{176}\\.pdf” dosyasının içeriği uzantısıyla uyuşmuyor`))).toBeVisible();
  // Uzantısı doğrudan "constructor" / "__proto__" olan ad: desteklenmeyen tür (hiçbir şey yazılmaz)
  for (const name of ['belge.constructor', 'belge.__proto__', 'constructor']) {
    await addFiles(cust, [pdf(name)]);
    await expect(cust.getByText(`“${name}” desteklenmeyen dosya türü.`)).toBeVisible();
  }
  expect([temps(), kept()]).toEqual([[], start + 2]);
  // Sayfa hâlâ çalışıyor; reddedilenlerin hiçbiri listede yok
  await cust.goto(orderUrl);
  await expect(cust.locator('.file-row')).toHaveCount(2);
  await expect(cust.getByText('ek-1.pdf')).toHaveCount(0);
  await cust.context().close();
});

test('ekip (iç dosya): aynı kurallar — kabul edilen saklanır, reddedilen ve yanındaki dosya artık bırakmaz', async ({ browser }) => {
  expect(orderUrl).not.toBe('');
  const start = kept();
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(orderUrl);
  // Uzun ad + gerçek PDF: iç dosya olarak eklenir
  const long = padded(200, '.toString.pdf', 'd');
  await addFiles(sales, [pdf(long, 'ic dosya')]);
  await expect(sales.getByText('Dosyalar eklendi.')).toBeVisible();
  const row = sales.locator('.file-row', { hasText: 'd'.repeat(60) });
  expect([storedName(long).length, storedName(long)]).toEqual([180, `${'d'.repeat(176)}.pdf`]);
  await expect(row.locator('.fname')).toHaveText(storedName(long));
  await expect(row.getByText('iç dosya')).toBeVisible();
  expect([temps(), kept()]).toEqual([[], start + 1]);
  // İki dosyalı istek, ikincisi PDF değil → ikisi de saklanmaz
  await addFiles(sales, [pdf('ic-ek.pdf'), exe(padded(184, '.hasOwnProperty.pdf', 'e'))]);
  await expect(sales.getByText(/“e{160,}[.a-zA-Z]*\.pdf” dosyasının içeriği uzantısıyla uyuşmuyor/)).toBeVisible();
  expect([temps(), kept()]).toEqual([[], start + 1]);
  await sales.goto(orderUrl);
  await expect(sales.getByText('ic-ek.pdf')).toHaveCount(0);
  await sales.context().close();

  // Müşteri iç dosyayı görmez (kural değişmedi)
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(orderUrl);
  await expect(cust.locator('.file-row')).toHaveCount(2);
  await cust.context().close();
});

test('depo bağlantısı (oturumsuz): ".zip.pdf" reddedilir; uzun adlı gerçek PDF eklenir; geçici dosya kalmaz', async ({ browser }) => {
  // 11'de teslim edilmiş siparişin depo bağlantısı (e-posta dosyaya yazılmıştı): teslimden sonra "başka belge ekle"
  const outbox = process.env.MAIL_OUTBOX_DIR!;
  const tokens = fs.readdirSync(outbox).filter((f) => f.includes('adrian@partnertrans.ro')).sort().reverse()
    .map((f) => /\/depo\/([A-Za-z0-9_-]{40,60})/.exec(String(JSON.parse(fs.readFileSync(path.join(outbox, f), 'utf8')).text))?.[1])
    .filter((t): t is string => !!t);
  expect(tokens.length, 'depo e-postası yok (11 çalışmış olmalı)').toBeGreaterThan(0);
  const ctx = await browser.newContext();
  const depot = await ctx.newPage();
  let token = '';
  for (const t of tokens) {
    await depot.goto(`/depo/${t}`);
    if (await depot.getByRole('button', { name: 'Ekle', exact: true }).count()) { token = t; break; }
  }
  expect(token, 'teslim edilmiş siparişin depo bağlantısı bulunamadı').not.toBe('');
  const start = kept();
  const listed = await depot.locator('ul.small li').count();

  // Ham ad ".pdf" (izinli), içerik ZIP; eski kesme adı ".zip" yapıyor ve ZIP kabul ediliyordu
  await depot.setInputFiles('#dep-files', [zip(padded(184, '.zip.pdf', 'f'))]);
  await depot.getByRole('button', { name: 'Ekle', exact: true }).click();
  await expect(depot).toHaveURL(/[?&]e=type&n=f{20}/);
  await expect(depot.locator('.alert-error')).toContainText('Yalnızca PDF, JPG ya da PNG yüklenebilir');
  expect([temps(), kept()]).toEqual([[], start]);
  // Saldırı adı + PDF olmayan içerik: eski sürümde 500 + geçici dosya; şimdi ret
  await depot.goto(`/depo/${token}`);
  await depot.setInputFiles('#dep-files', [pdf('once.pdf'), exe(padded(184, '.constructor.pdf', 'g'))]);
  await depot.getByRole('button', { name: 'Ekle', exact: true }).click();
  await expect(depot).toHaveURL(/[?&]e=type&n=g{20}/);
  expect([temps(), kept()]).toEqual([[], start]);
  await depot.goto(`/depo/${token}`);
  await expect(depot.locator('ul.small li')).toHaveCount(listed);

  // Saldırı adı + gerçek PDF: eklenir (ad 180 karakter, uzantı .pdf)
  const doc = padded(184, '.constructor.pdf', 'h');
  await depot.setInputFiles('#dep-files', [pdf(doc, 'depo belgesi')]);
  await depot.getByRole('button', { name: 'Ekle', exact: true }).click();
  await expect(depot.getByText('Belge eklendi.')).toBeVisible();
  await expect(depot.locator('ul.small li')).toHaveCount(listed + 1);
  await expect(depot.locator('ul.small li').last()).toContainText(`${'h'.repeat(168)}.constru.pdf`);
  expect(storedName(doc)).toBe(`${'h'.repeat(168)}.constru.pdf`);
  expect([temps(), kept()]).toEqual([[], start + 1]);
  await ctx.close();
});
