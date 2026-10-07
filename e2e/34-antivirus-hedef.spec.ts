import net from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as, login, newOrder, zipOf } from './helpers';
import { eicar } from '../server/files/clamav.js';

// Antivirüs: tarayıcının adresi yalnızca sunucu ayarından gelir (karar 150; güvenlik denetimi 3.50.9 AUD-12). Gerçek
// sunucuda:
//  - Entegrasyonlar ekranında adres / port salt-okunurdur, giriş alanı yoktur; veritabanında kalmış eski adres gösterilmez
//  - yöneticinin elle hazırladığı istek (host / port alanlarıyla) hedefi değiştiremez; kayıtta adres kalmaz; ardından
//    gerçek tarayıcı (CI'da gerçek ClamAV) EICAR'ı yine yakalar — "tuzak" adrese tek bağlantı bile gitmez
//  - satış / çizim / denetimci / müşteri / oturumsuz istek: üç işlem de reddedilir; ayar, denetim kaydı ve bekleyen dosya
//    değişmez (aynı istek yöneticiden gelince işlenir — isteğin biçimi doğrudur)
//  - adresteki hata ayrıntısı / imza adı serbest metin olarak gösterilmez
// "Tuzak": bu test sürecinin 127.0.0.1'de açtığı, bağlanan her şeye "temiz" diyen sahte tarayıcı. Eski sürümde yönetici
// adresi buna çevirebiliyordu (dosyalar oraya gider, virüs "temiz" sayılırdı). Dış ağa hiçbir istek gitmez.
test.describe.configure({ mode: 'serial' });

const PAGE = '/admin/entegrasyonlar';
const SALES2 = 'fiyat-satis@e2e.test'; // 08'de açıldı (satis@e2e.test 05'te bilerek kilitleniyor)
const INSPECTOR = 'denetim@e2e.test'; // 05'te açıldı
const HAS_AV = !!process.env.CLAMAV_HOST;
const HOST = process.env.CLAMAV_HOST || 'clamav';
const PORT = String(Number(process.env.CLAMAV_PORT) || 3310);
const PENDING_KEY = '2026/10/aud12-e2e-yok.pdf'; // diskte olmayan dosya: tarama çalışırsa SKIPPED olur

type Trap = { server: net.Server; port: number; connections: number; socks: Set<net.Socket> };
let trap: Trap;
let original: { value: unknown } | null = null;

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
/** Antivirüs kartındaki üç formun sunucu işlemi alanları: [kaydet, bağlantıyı test et, şimdi tara] */
async function avActions(page: Page): Promise<[string, string, string]> {
  const html = await (await page.request.get(PAGE)).text();
  const card = html.slice(html.indexOf('id="antivirus"'));
  const ids = card.split('<form').slice(1, 4).map((chunk) => /\$ACTION_ID_[0-9a-f]+/.exec(chunk)?.[0] ?? '');
  expect(ids.every(Boolean) && new Set(ids).size === 3, `antivirüs işlemleri bulunamadı: ${ids.join(' | ')}`).toBe(true);
  return ids as [string, string, string];
}
/** Sunucu işlemine doğrudan istek (tarayıcı formu olmadan) */
async function forge(page: Page, field: string, data: Record<string, string>) {
  const origin = new URL(page.url()).origin;
  return page.request.post(PAGE, { multipart: { [field]: '', ...data }, headers: { origin } });
}

test.beforeAll(async () => {
  trap = await new Promise<Trap>((resolve) => {
    const t: Trap = { server: net.createServer(), port: 0, connections: 0, socks: new Set() };
    t.server.on('connection', (sock) => {
      t.connections += 1;
      t.socks.add(sock);
      sock.on('error', () => {});
      sock.on('close', () => t.socks.delete(sock));
      sock.on('data', () => {});
      sock.end('stream: OK\0');
    });
    t.server.listen(0, '127.0.0.1', () => { t.port = (t.server.address() as net.AddressInfo).port; resolve(t); });
  });
  const db = await prisma();
  const row = await db.integrationSetting.findUnique({ where: { key: 'antivirus' } });
  original = row ? { value: row.value } : null;
  await db.$disconnect();
});

test.afterAll(async () => {
  // Ayarı testten önceki hâline getir (kayıt yoktuysa yine yok)
  const db = await prisma();
  if (original) await db.integrationSetting.update({ where: { key: 'antivirus' }, data: { value: original.value as object } });
  else await db.integrationSetting.deleteMany({ where: { key: 'antivirus' } });
  await db.orderFile.deleteMany({ where: { storageKey: PENDING_KEY } });
  await db.$disconnect();
  for (const s of trap.socks) s.destroy();
  await new Promise<void>((r) => { trap.server.close(() => r()); });
});

test('yönetici: tarayıcının adresi ve portu salt-okunur, giriş alanı yok; veritabanında kalmış eski adres gösterilmez', async ({ page }) => {
  const db = await prisma();
  // Eski sürümden kalma kayıt: adres ve port veritabanında (tuzağı gösteriyor)
  const legacy = { enabled: true, host: '127.0.0.1', port: trap.port, onUnavailable: 'accept' };
  await db.integrationSetting.upsert({ where: { key: 'antivirus' }, create: { key: 'antivirus', value: legacy }, update: { value: legacy } });

  await login(page, ADMIN, ADMIN_PW);
  await page.goto(PAGE);
  const card = page.locator('#antivirus');
  await expect(card.locator('[data-av-host]')).toHaveText(HOST);
  await expect(card.locator('[data-av-port]')).toHaveText(PORT);
  await expect(card.getByText('Tarayıcının adresi ve portu sunucu ayarından gelir (CLAMAV_HOST / CLAMAV_PORT); güvenlik nedeniyle bu ekrandan değiştirilemez.')).toBeVisible();
  // Düzenlenebilir alan yok
  await expect(page.locator('input[name="host"], input[name="port"], #av-host, #av-port')).toHaveCount(0);
  await expect(card.locator('#av-target input, #av-target select, #av-target textarea, #av-target [contenteditable]')).toHaveCount(0);
  const names = await card.locator('form').first().locator('input:not([type="hidden"]), select, textarea')
    .evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLInputElement).name))].sort());
  expect(names, 'kaydet formunun alanları').toEqual(['enabled', 'onUnavailable']);
  // Veritabanındaki eski port ekranda yok; kaydı okumak onu değiştirmez
  expect(await card.innerText()).not.toContain(String(trap.port));
  expect((await db.integrationSetting.findUniqueOrThrow({ where: { key: 'antivirus' } })).value).toEqual(legacy);
  // Durum denetimi sunucu ayarındaki tarayıcıya gider (tuzak "PONG" demez — oraya gidilse "ulaşılamıyor" görünürdü)
  if (HAS_AV) await expect(page.getByText(/Bağlı: ClamAV/)).toBeVisible();
  expect(trap.connections, 'tuzağa bağlanılmadı').toBe(0);
  await db.$disconnect();
});

test('yönetici: elle hazırlanmış istek (host / port ile) hedefi değiştiremez; gerçek tarayıcı EICAR\'ı yine yakalar', async ({ browser }) => {
  const db = await prisma();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(PAGE);
  const [save, check, scan] = await avActions(admin);
  const saves = () => db.auditLog.count({ where: { action: 'SETTINGS_UPDATE', entityId: 'antivirus' } });
  const savesBefore = await saves();

  // Kaydet: host / port (ve uydurma alanlar) gönderilir
  const res = await forge(admin, save, { enabled: 'on', onUnavailable: 'accept', host: '127.0.0.1', port: String(trap.port), timeoutMs: '1', target: `127.0.0.1:${trap.port}` });
  expect(new URL(res.url()).searchParams.get('ok'), 'istek işlendi (ayar kaydedildi)').toBe('saved');
  expect((await db.integrationSetting.findUniqueOrThrow({ where: { key: 'antivirus' } })).value, 'kayıtta adres / port yok').toEqual({ enabled: true, onUnavailable: 'accept' });
  expect(await saves()).toBe(savesBefore + 1);
  const last = await db.auditLog.findFirstOrThrow({ where: { action: 'SETTINGS_UPDATE', entityId: 'antivirus' }, orderBy: { createdAt: 'desc' } });
  expect((last.details as { after: unknown }).after).toEqual({ enabled: true, onUnavailable: 'accept' });
  // Hedef aynı
  await admin.goto(PAGE);
  await expect(admin.locator('[data-av-host]')).toHaveText(HOST);
  await expect(admin.locator('[data-av-port]')).toHaveText(PORT);
  expect(await admin.locator('#antivirus').innerText()).not.toContain(String(trap.port));

  // "Bağlantıyı test et" ve "şimdi tara" işlemlerine de adres alanlarıyla istek: adres istekten okunmaz
  const tests = () => db.auditLog.count({ where: { action: 'ANTIVIRUS_TEST' } });
  const testsBefore = await tests();
  await forge(admin, check, { host: '127.0.0.1', port: String(trap.port) });
  await forge(admin, scan, { host: '127.0.0.1', port: String(trap.port) });
  expect(await tests(), 'test isteği işlendi (denetim kaydı)').toBe(testsBefore + 1);
  expect(trap.connections, 'tuzağa bağlanılmadı').toBe(0);

  if (HAS_AV) {
    // Gerçek tarayıcı: durum, test ve yükleme — hepsi sunucu ayarındaki ClamAV ile
    await admin.goto(PAGE);
    await expect(admin.getByText(/Bağlı: ClamAV/)).toBeVisible();
    await admin.getByRole('button', { name: 'Bağlantıyı test et' }).click();
    await expect(admin.getByText(/Test başarılı: test virüsü \(EICAR\) yakalandı/)).toBeVisible();
    const cust = await as(browser, CUSTOMER, CUST_PW);
    const id = await newOrder(cust, 'Antivirüs hedefi', 'hedef-olculer.pdf');
    await expect(cust.getByText('hedef-olculer.pdf')).toBeVisible();
    await expect(cust.getByText('taranmadı')).toHaveCount(0);
    await cust.setInputFiles('input[name=files]', { name: 'hedef-ekler.zip', mimeType: 'application/zip', buffer: zipOf([{ name: 'eicar.com', data: eicar() }]) });
    await cust.locator('button', { hasText: 'Dosya ekle' }).click();
    await expect(cust.getByText('“hedef-ekler.zip” dosyasında virüs bulundu; dosya kabul edilmedi.')).toBeVisible();
    await cust.goto(`/siparisler/${id}`);
    await expect(cust.getByText('hedef-ekler.zip')).toHaveCount(0);
    await cust.context().close();
    expect(trap.connections, 'tuzağa bağlanılmadı').toBe(0);
  }
  await admin.context().close();
  await db.$disconnect();
});

test('satış / çizim / denetimci / müşteri / oturumsuz: antivirüs işlemlerine doğrudan istek reddedilir; ayar, denetim kaydı ve bekleyen dosya değişmez', async ({ browser }) => {
  const db = await prisma();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(PAGE);
  const [save, check, scan] = await avActions(admin);

  // Bekleyen bir dosya: "şimdi tara" çalışırsa durumu değişir (dosya diskte yok → SKIPPED)
  const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  const order = await db.order.findFirstOrThrow({ where: { customerId: cust.customerId!, removedAt: null }, orderBy: { createdAt: 'desc' } });
  await db.orderFile.deleteMany({ where: { storageKey: PENDING_KEY } });
  // En eski bekleyen dosya olsun (tarama en eskiden başlar; başka bekleyen olsa da sıra ona gelir)
  const pending = await db.orderFile.create({ data: { name: 'aud12-e2e-yok.pdf', storageKey: PENDING_KEY, size: 10, uploadedById: cust.id, orderId: order.id, scanStatus: 'PENDING', createdAt: new Date('2020-01-01T00:00:00Z') } });
  const snapshot = async () => JSON.stringify([
    (await db.integrationSetting.findUnique({ where: { key: 'antivirus' } }))?.value ?? null,
    await db.auditLog.count({ where: { action: 'SETTINGS_UPDATE', entityId: 'antivirus' } }),
    await db.auditLog.count({ where: { action: 'ANTIVIRUS_TEST' } }),
    (await db.orderFile.findUniqueOrThrow({ where: { id: pending.id } })).scanStatus,
    await db.orderFile.count({ where: { scanStatus: 'PENDING' } }),
  ]);
  const before = await snapshot();
  expect(JSON.parse(before)[0], 'başlangıç: önceki testin kaydettiği ayar').toEqual({ enabled: true, onUnavailable: 'accept' });

  // Kaydet isteği "kapat + reddet + tuzak adres" der: işlenirse ayar değişirdi
  const attack = { onUnavailable: 'reject', host: '127.0.0.1', port: String(trap.port) };
  const users: [string, string][] = [[SALES2, TEAM_PW], [DRAWER, TEAM_PW], [INSPECTOR, INSPECTOR_PW], [CUSTOMER, CUST_PW]];
  for (const [email, pw] of users) {
    const p = await as(browser, email, pw);
    await p.goto(PAGE);
    await expect(p, email).not.toHaveURL(/entegrasyonlar/);
    const body = await (await p.request.get(PAGE)).text();
    for (const s of ['id="av-target"', 'data-av-host', 'data-av-port', 'CLAMAV_HOST']) expect(body.includes(s), `${email} → ${s}`).toBe(false);
    for (const [field, data] of [[save, attack], [check, {}], [scan, {}]] as [string, Record<string, string>][]) {
      const res = await forge(p, field, data);
      expect(new URL(res.url()).pathname, `${email}: istek ayar sayfasına varmadı`).not.toBe(PAGE);
    }
    expect(await snapshot(), `${email}: ayar / denetim / bekleyen dosya aynen`).toBe(before);
    await p.context().close();
  }
  // Oturumsuz
  const anon = await (await browser.newContext()).newPage();
  await anon.goto('/login');
  for (const [field, data] of [[save, attack], [check, {}], [scan, {}]] as [string, Record<string, string>][]) {
    const res = await forge(anon, field, data);
    expect(new URL(res.url()).pathname, 'oturumsuz: istek ayar sayfasına varmadı').not.toBe(PAGE);
  }
  expect(await snapshot(), 'oturumsuz: ayar / denetim / bekleyen dosya aynen').toBe(before);
  await anon.context().close();
  expect(trap.connections, 'tuzağa bağlanılmadı').toBe(0);

  // Aynı istekler yöneticiden gelince İŞLENİR (isteğin biçimi doğru — yukarıdaki sonuç yetki denetiminden)
  await forge(admin, scan, {});
  expect((await db.orderFile.findUniqueOrThrow({ where: { id: pending.id } })).scanStatus, 'yönetici: bekleyen dosya tarandı (diskte yok → atlandı)').toBe('SKIPPED');
  await forge(admin, save, attack);
  expect((await db.integrationSetting.findUniqueOrThrow({ where: { key: 'antivirus' } })).value, 'yönetici: ayar kaydedildi (adres yine yok)').toEqual({ enabled: false, onUnavailable: 'reject' });
  expect(trap.connections).toBe(0);
  await admin.context().close();
  await db.$disconnect();
});

test('adresteki hata ayrıntısı ve imza adı serbest metin olarak gösterilmez: yalnızca sabit metin / temizlenmiş ad', async ({ page }) => {
  await login(page, ADMIN, ADMIN_PW);
  const visit = async (query: Record<string, string>) => {
    await page.goto(`${PAGE}?${new URLSearchParams(query).toString()}`);
    return page.locator('body').innerText();
  };
  // Bilinen kod → sabit metin
  expect(await visit({ error: 'testFailed', detail: 'timeout' })).toContain('Test başarısız: tarayıcı zamanında yanıt vermedi');
  expect(await visit({ error: 'scanStopped', detail: 'unreachable' })).toContain('Tarama durdu: tarayıcıya ulaşılamıyor');
  expect(await visit({ error: 'testFailed', detail: 'invalid-response' })).toContain('Test başarısız: tarayıcıdan geçersiz yanıt geldi');
  // Kod olmayan her şey → "bilinmeyen hata"; gönderilen metin ekranda yok
  for (const detail of ['GIZLI-ENJEKTE: connect ECONNREFUSED 10.0.0.5:3310', '220 GIZLI-ENJEKTE ESMTP', 'TIMEOUT', 'unknown ', '']) {
    const text = await visit({ error: 'testFailed', detail });
    expect(text, detail).toContain('Test başarısız: bilinmeyen hata');
    expect(text.includes('GIZLI-ENJEKTE') || text.includes('10.0.0.5') || text.includes('ECONNREFUSED'), detail).toBe(false);
  }
  // İmza adı: güvenli karakterlere ve 200 karaktere iner
  const sig = await visit({ ok: 'testOk', signature: `Ad<b>GIZLI</b>\r\n${'Z'.repeat(500)}` });
  expect(sig).toContain('Test başarılı: test virüsü (EICAR) yakalandı — Ad?b?GIZLI?/b???ZZZ');
  expect(/Z{186,}/.test(sig), 'imza adı kısaltıldı').toBe(false);
  expect(/Z{150,}/.test(sig)).toBe(true);
  // Sayılar yalnızca rakam
  const counts = await visit({ ok: 'scanned', scanned: 'GIZLI-ENJEKTE', clean: '7', infected: '-1' });
  expect(counts).toContain('0 dosya tarandı: 7 temiz, 0 virüslü.');
  expect(counts.includes('GIZLI-ENJEKTE')).toBe(false);
});
