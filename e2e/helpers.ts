import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const ADMIN = 'admin@e2e.test';
export const ADMIN_PW = 'Yonetici2026';
export const CUSTOMER = 'ali@unsal.test';
export const CUST_PW = 'Musteri2026x';
/** Denetimci (05'te açılır). Yeni şifre kuralı: en az 10 karakter (karar 117). */
export const INSPECTOR_PW = 'Denetim2026x';

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

/**
 * İlk giriş: davet e-postasındaki bağlantı (/setup?email=…) → kod → şifre. Giriş ekranı davet bekleyen hesabı
 * ayırt etmez (SEC-10): oradan /setup'a kendiliğinden geçilmez.
 */
export async function firstLogin(page: Page, email: string, code: string, password: string) {
  await page.goto(`/setup?email=${encodeURIComponent(email)}`);
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

/** Çizimci (sipariş sayfasında): dosyaları taslağa yükler ve yüklemenin bittiğini (dosya satırları) bekler. */
export async function uploadDrawing(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.setInputFiles('#drawing-file', files);
  await page.getByRole('button', { name: 'Taslağa yükle' }).click();
  for (const f of files) await expect(page.locator('.drawing-version.draft .file-row', { hasText: f.name })).toBeVisible();
}

/**
 * Çizimci: taslağı "Kontrol Et" ile açar ve o ekrandaki "Müşteriye gönder" ile gönderir (karar 84: gönderim yalnızca
 * kontrol ekranından). Onay penceresini sayfa kabul eder (as() ile açılmış oturum).
 */
export async function sendDrawing(page: Page, orderId: string) {
  await page.goto(`/siparisler/${orderId}`);
  await expect(page.getByRole('button', { name: 'Müşteriye gönder' })).toHaveCount(0); // sipariş sayfasından gönderilemez
  await page.getByRole('link', { name: 'Kontrol Et' }).click();
  await expect(page).toHaveURL(/\/cizim\/[a-z0-9]+$/);
  await page.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(page.getByText('Çizim müşterinin onayına gönderildi.')).toBeVisible();
}

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
  // Müşteri formunda cam adedi yok (karar 160): adet teklif tablosunda girilir (fillOffer)
  await page.getByRole('button', { name: 'Siparişi gönder' }).click();
  await expect(page).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=created/);
  await expect(page.getByText('Siparişiniz alındı.')).toBeVisible();
  return /\/siparisler\/([a-z0-9]+)/.exec(page.url())![1];
}

/**
 * Teklif tablosunun ilk satırını doldurur: 1000 × 2000 mm, 3 adet. Müşteri formunda cam adedi yok (karar 160): tablo
 * siparişten 1 adetle açılır, adedi satış girer.
 */
export async function fillOffer(page: Page, price = '41,5') {
  await page.getByLabel('Adet', { exact: true }).first().fill('3');
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
    // İndirme bağlantıları (teklif PDF / Excel, döküm…) sayfa olarak açılamaz: içerikleri yukarıda tarandı, bağlantı toplanmaz
    const opened = await page.goto(url).then(() => true, (e: Error) => {
      if (/Download is starting/.test(e.message)) return false;
      throw e;
    });
    if (!opened) continue;
    for (const href of await page.locator('a[href^="/"]').evaluateAll((els) => els.map((a) => a.getAttribute('href') || ''))) {
      const clean = href.split('#')[0];
      if (!clean || /^\/(dosya|dil|login|setup|_next)\b/.test(clean) || seen.has(clean)) continue;
      queue.push(clean);
    }
  }
  // JSON yanıtı (bildirim akışı): metin olarak değil, nesne olarak İÇ İÇE taranır — her anahtar ve her değer
  const feed = await page.request.get('/bildirimler/akis');
  if (feed.ok()) for (const hit of deepFind(await feed.json(), secrets)) leaks.push(`/bildirimler/akis ${hit}`);
  return { pages: seen.size, leaks: [...new Set(leaks)] };
}

/**
 * İç içe tarama: nesnenin her derinliğindeki anahtar ve değerlerde gizli bilgilerden biri geçen yollar (büyük / küçük harf
 * duyarsız). Ekranda görünmeyen ama yanıtta duran alanları da yakalar.
 */
export function deepFind(value: unknown, secrets: string[], at = '$'): string[] {
  const needles = secrets.filter((x) => x.trim().length >= 5).map((x) => x.toLowerCase());
  const out: string[] = [];
  const walk = (v: unknown, where: string) => {
    if (v == null) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const text = String(v).toLowerCase();
      for (const n of needles) if (text.includes(n)) out.push(`${where}: "${n}"`);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) { walk(k, `${where}.<key>`); walk(x, `${where}.${k}`); }
  };
  walk(value, at);
  return out;
}

/** Müşteri firmalarının gizli tutulacak bilgileri (tam ad, ilk 3 harften sonrası, iletişim). */
export async function customerSecrets(): Promise<string[]> {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const rows = await db.customer.findMany({
      where: { type: 'CUSTOMER' },
      select: { name: true, contactPerson: true, phone: true, address: true, taxId: true, email: true, billingEmail: true, regCom: true, county: true, city: true, fxMarkupPercent: true },
    });
    // Müşteri tarafındaki KİŞİLER de firmayı ele verir (AUD-2): müşteri kullanıcılarının adı ve e-posta adresi
    const people = await db.user.findMany({ where: { type: 'CUSTOMER' }, select: { name: true, email: true } });
    // Firma adı, iletişim ve fatura bilgileri, mali belge e-postası, müşteriye özel kur yüzdesi (SEC-07)
    return [
      ...rows.flatMap((r) => [r.name, r.name.slice(3), r.contactPerson, r.phone, r.address, r.taxId, r.email, r.billingEmail, r.regCom, r.county, r.city, r.fxMarkupPercent?.toString()]),
      ...people.flatMap((u) => [u.name, u.email]),
    ].filter((x): x is string => !!x);
  } finally {
    await db.$disconnect();
  }
}

/**
 * Yükleme günü firma tablosu (Paket 7, karar 186): firmanın ana satırı (tbody.firm). Ad, rolün gördüğü biçimde (satış /
 * çizim: maskeli) TAM eşleşir — başka firmanın satırındaki misafir yük satırı eşleşmez.
 */
export function firmOf(page: Page, name: string): Locator {
  return page.locator('.firm-table > tbody.firm').filter({ has: page.locator('tr.firm-row b.group-name').getByText(name, { exact: true }) });
}

/** Yükleme günü firma tablosunda, verilen siparişi (alt sipariş satırı) taşıyan firmanın ana satırı */
export function firmWithOrder(page: Page, orderId: string): Locator {
  return page.locator('.firm-table > tbody.firm').filter({ has: page.locator(`tr.firm-orders tr[data-order="${orderId}"]`) });
}

/**
 * Firma satırının alt siparişlerini ("orders" — firma adına tıklanır) ya da sandıklarını ("crates" — "Sandık" düğmesi) açar.
 * İstemci bileşenidir: sayfa etkileşime hazır olana kadar yinelenir; bölüm zaten açıksa dokunmaz.
 */
export async function openFirm(firm: Locator, part: 'orders' | 'crates' = 'orders'): Promise<Locator> {
  const target = firm.locator(part === 'orders' ? 'tr.firm-orders' : 'tr.firm-crates');
  const button = part === 'orders' ? firm.locator('.firm-toggle') : firm.locator('[data-action=crates]');
  await expect(async () => {
    if (!(await target.isVisible())) await button.click();
    await expect(target).toBeVisible({ timeout: 1000 });
  }).toPass();
  return target;
}

/**
 * Ortak rapor Excel'inin (server/files/xlsx-report.js — metinler satır içi yazılır) n. sayfası (1'den), satır satır; boş hücre
 * null. Yalnızca testte: üretimdeki içe aktarıcılar ilk sayfayı readXlsx ile okur.
 */
export async function reportSheet(buf: Buffer, n: number): Promise<(string | number | null)[][]> {
  const { openZip } = await import('../server/files/zip.js');
  const xml = openZip(buf).read(`xl/worksheets/sheet${n}.xml`)?.toString('utf8') ?? '';
  const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const col = (ref: string) => [...ref].reduce((x, ch) => x * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const rows: (string | number | null)[][] = [];
  for (const m of xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: (string | number | null)[] = [];
    for (const c of m[2].matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = c[2] ?? '';
      const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
      const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
      row[col(c[1])] = v != null ? Number(v) : t != null ? unescape(t) : null;
    }
    rows[Number(m[1]) - 1] = Array.from(row, (x) => x ?? null);
  }
  return Array.from(rows, (r) => r ?? []);
}

/**
 * Sipariş sayfasında bölüm(ler)i ekranda GÖRÜR (Paket B — karar 228): uyarı, gösterildiği bölüm ekranda en az 600 ms
 * görününce okunur. Sayfada olmayan bölüm atlanır (o bölümün uyarıları sayfa başlığıyla okunur).
 */
export async function seeSections(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (!(await el.count())) continue;
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
  }
}

/**
 * Tahmini yükleme tarihi — Sipariş Bilgileri'nde satır içi düzenleme (karar 230): "Değiştir" → tarih → "Kaydet" →
 * eski → yeni onay penceresi (sayfa as() ile açılmış olmalı: pencereyi ortak işleyici kabul eder). Onay metni döndürülür.
 */
export async function setShipDate(page: Page, day: string): Promise<string> {
  const form = page.locator('[data-ship-form]');
  // İstemci bileşeni: sayfa etkileşime hazır olana kadar yinelenir
  await expect(async () => {
    if (!(await form.isVisible())) await page.locator('[data-ship-edit]').click();
    await expect(form).toBeVisible({ timeout: 1000 });
  }).toPass();
  await form.locator('#ship-date').fill(day);
  // Onay penceresini as() içindeki ortak işleyici kabul eder; burada yalnızca metni okunur
  const message = new Promise<string>((resolve) => page.once('dialog', (d) => resolve(d.message())));
  await form.getByRole('button', { name: 'Kaydet' }).click();
  return message;
}

/**
 * "Yükleme Özeti" — "Döküm" sayfası (P3 — karar 241; reportSheet(buf, 2)): düz tablo. Sütunlar: SİPARİŞ NO (A), MÜŞTERİ (B),
 * PROJE (C), AÇIKLAMA (D), ADET (E), BİRİM (F), METRAJ (G), BİRİM FİYAT (H), TUTAR (I), Para birimi (J). Verilen siparişin
 * kalem satırları (yoksa boş dizi).
 */
export function summaryLines(rows: (string | number | null)[][], orderNo: string): (string | number | null)[][] {
  return rows.filter((r) => r?.[0] === orderNo);
}
