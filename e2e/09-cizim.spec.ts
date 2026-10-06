import { test, expect, type Page } from '@playwright/test';
import type { PrismaClient } from '@prisma/client';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, SALES, TEAM_PW, as, login, newOrder, sampleFile } from './helpers';

// Aşama 4: çizim taslağa yüklenir (çoklu dosya, virüs taraması); "Kontrol Et" ekranındaki "Müşteriye gönder" onaylı
// ikinci adımdır (karar 84: sipariş sayfasından gönderilemez; sunucu kontrol kanıtı ister);
// gönderilen sürüm müşteri karar vermeden gerekçeyle geri çekilebilir, sürüm geçmişte kalır.
// Karar 146 (güvenlik denetimi AUD-8): geri çekilen sürümün SATIRI (durum, tarih, gerekçe) müşteride kalır; dosyaları ve
// müşteri notu müşteriye kapanır — sipariş sayfası, sayfa kaynağı, /dosya/cizim (dosya kimliği, eski sürüm kimliği, ?ac=1)
// ve görüntüleyici. İç roller eskisi gibi görür. Reddedilen istek indirme kaydı (FILE_DOWNLOAD) yazmaz.
test.describe.configure({ mode: 'serial' });

const INSPECTOR = 'denetim@e2e.test';
const NOTE = 'Müşteri notu: v1 ölçüleri 1250 x 2100';
let db: PrismaClient;
test.beforeAll(async () => {
  const { PrismaClient: Client } = await import('@prisma/client');
  db = new Client();
});
test.afterAll(async () => { await db.$disconnect(); });

/** Onay pencerelerini kendimiz yöneteceğimiz çizimci oturumu (as() hepsini kabul eder). */
async function drawerPage(browser: import('@playwright/test').Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await login(page, DRAWER, TEAM_PW);
  return page;
}

test('çizim: taslak → onaylı gönderim → geri çekme → yeni sürüm', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Duşakabin', 'dus.pdf');
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${id}`);
  await admin.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(admin.getByText('Sipariş çizim ekibine yönlendirildi.')).toBeVisible();

  const drawer = await drawerPage(browser);
  await drawer.goto(`/siparisler/${id}`);
  await drawer.setInputFiles('#drawing-file', [sampleFile('dus-v1.dxf', 'dxf'), sampleFile('dus-v1.pdf', 'pdf'), sampleFile('yanlis.png', 'png')]);
  await drawer.fill('#d-note-c', NOTE);
  await drawer.getByRole('button', { name: 'Taslağa yükle' }).click();
  await expect(drawer.getByText('Dosyalar taslağa eklendi.')).toBeVisible();

  // Taslaktan dosya çıkarma (onaylı)
  drawer.once('dialog', (d) => d.accept());
  await drawer.locator('.file-row', { hasText: 'yanlis.png' }).getByRole('button', { name: 'Çıkar' }).click();
  await expect(drawer.getByText('Dosya taslaktan çıkarıldı.')).toBeVisible();
  await expect(drawer.locator('.file-row', { hasText: 'yanlis.png' })).toHaveCount(0);

  // Zorunlu kontrol: sipariş sayfasında "Müşteriye gönder" yok; önce "Kontrol Et" (görüntüleyici)
  await expect(drawer.getByRole('button', { name: 'Müşteriye gönder' })).toHaveCount(0);
  await expect(drawer.locator('.drawing-next')).toContainText('gönderme düğmesi o ekrandadır');
  await drawer.getByRole('link', { name: 'Kontrol Et' }).click();
  await expect(drawer).toHaveURL(/\/cizim\/[a-z0-9]+$/);
  const checkUrl = drawer.url();
  // "Emin misiniz?" sorusuna hayır → gönderilmez
  let asked = '';
  drawer.once('dialog', (d) => { asked = d.message(); void d.dismiss(); });
  await drawer.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect.poll(() => asked).toContain('Emin misiniz?');
  expect(asked).toContain('v1 (2 dosya)');
  await drawer.goto(`/siparisler/${id}`);
  await expect(drawer.getByText('Taslak v1 — müşteri henüz görmüyor')).toBeVisible();
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.getByRole('button', { name: 'Bu çizimi onayla' })).toHaveCount(0);
  // Taslak dosyası müşteriye kapalı (sunucuda): bağlantıyı bilse de indiremez
  const draftHref = await drawer.locator('.file-row', { hasText: 'dus-v1.dxf' }).locator('a[href^="/dosya/cizim/"]').first().getAttribute('href');
  expect((await cust.request.get(draftHref!)).status()).toBe(404);
  expect((await drawer.request.get(draftHref!)).status()).toBe(200);

  // Sunucu denetimi: kontrol ekranı açıldıktan SONRA taslak değişirse (yeni dosya) o ekrandaki gönderim reddedilir
  const stale = await drawer.context().newPage();
  await stale.goto(checkUrl);
  await drawer.setInputFiles('#drawing-file', sampleFile('dus-ek.dxf', 'ek'));
  await drawer.getByRole('button', { name: 'Taslağa yükle' }).click();
  await expect(drawer.getByText('Dosyalar taslağa eklendi.')).toBeVisible();
  stale.once('dialog', (d) => d.accept());
  await stale.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(stale.locator('.alert-error')).toContainText('gönderilmeden önce kontrol edilmelidir');
  await expect(stale.getByText('Taslak v1 — müşteri henüz görmüyor')).toBeVisible();
  await stale.close();
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.getByRole('button', { name: 'Bu çizimi onayla' })).toHaveCount(0);

  // Yeniden "Kontrol Et" → Evet → müşteriye gider
  await drawer.goto(`/siparisler/${id}`);
  await drawer.getByRole('link', { name: 'Kontrol Et' }).click();
  drawer.once('dialog', (d) => d.accept());
  await drawer.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(drawer.getByText('Çizim müşterinin onayına gönderildi.')).toBeVisible();
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.getByRole('button', { name: 'Bu çizimi onayla' })).toBeVisible();
  await expect(cust.locator('.file-row', { hasText: 'dus-v1.dxf' })).toBeVisible();

  // Gönderilmiş sürüm (değişmedi): müşteri notu görür; dosyayı dosya kimliğiyle, eski sürüm kimliğiyle ve "aç" (?ac=1)
  // adresiyle alır; görüntüleyici açılır. Her erişim indirme kaydına yazılır.
  const v1 = await db.drawing.findFirstOrThrow({ where: { orderId: id, version: 1 }, include: { files: { orderBy: { name: 'asc' } } } });
  expect(v1.files.map((f) => f.name)).toEqual(['dus-ek.dxf', 'dus-v1.dxf', 'dus-v1.pdf']);
  const v1Pdf = v1.files.find((f) => f.name === 'dus-v1.pdf')!;
  const v1Viewer = `/siparisler/${id}/cizim/${v1.id}`;
  const v1Urls = [...v1.files.flatMap((f) => [`/dosya/cizim/${f.id}`, `/dosya/cizim/${f.id}?ac=1`]), `/dosya/cizim/${v1.id}`, `/dosya/cizim/${v1.id}?ac=1`];
  const custUser = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  const custDownloads = () => db.auditLog.count({ where: { action: 'FILE_DOWNLOAD', userId: custUser.id, entityId: { in: [...v1.files.map((f) => f.id), v1.id] } } });
  await expect(cust.locator('.drawing-version', { hasText: 'dus-v1.dxf' })).toContainText(NOTE);
  expect(await custDownloads()).toBe(0);
  for (const url of v1Urls) {
    const res = await cust.request.get(url);
    expect(res.status(), url).toBe(200);
    if (url === `/dosya/cizim/${v1Pdf.id}?ac=1`) expect(res.headers()['content-type']).toBe('application/pdf');
  }
  expect(await custDownloads()).toBe(v1Urls.length);
  expect((await cust.request.get(v1Viewer)).status()).toBe(200);

  // Müşteri karar vermeden geri çekme (gerekçe zorunlu, onaylı)
  await drawer.goto(`/siparisler/${id}`);
  await drawer.fill('input[name=reason]', 'Yanlış ölçü gönderildi');
  drawer.once('dialog', (d) => d.accept());
  await drawer.getByRole('button', { name: 'Geri çek' }).click();
  await expect(drawer.getByText('Çizim sürümü geri çekildi; yeni sürüm yükleyebilirsiniz.')).toBeVisible();

  await cust.goto(`/siparisler/${id}`);
  await expect(cust.getByRole('button', { name: 'Bu çizimi onayla' })).toHaveCount(0);
  await expect(cust.getByText('geri çekildi').first()).toBeVisible();
  await expect(cust.getByText('Yanlış ölçü gönderildi').first()).toBeVisible();

  // Karar 146: geri çekilen sürümün satırı müşteride kalır (sürüm no, durum, gerekçe); dosyaları ve müşteri notu gelmez
  const withdrawn = cust.locator('.drawing-version', { hasText: 'geri çekildi' });
  await expect(withdrawn).toHaveCount(1);
  await expect(withdrawn).toContainText('v1');
  await expect(withdrawn).toContainText('Yanlış ölçü gönderildi');
  await expect(withdrawn.locator('.file-row')).toHaveCount(0);
  await expect(withdrawn.getByRole('link')).toHaveCount(0);
  await expect(cust.locator('a[href*="/dosya/cizim/"]')).toHaveCount(0);
  await expect(cust.locator(`a[href*="/cizim/${v1.id}"]`)).toHaveCount(0);
  // Sayfanın ham yanıtında (HTML + sunucu bileşeni verisi) ve çizilmiş sayfada dosya adı, dosya kimliği ve müşteri notu yok
  const leaks = ['dus-v1.dxf', 'dus-v1.pdf', 'dus-ek.dxf', NOTE, 'v1 ölçüleri', ...v1.files.map((f) => f.id)];
  const rawPage = await (await cust.request.get(`/siparisler/${id}`)).text();
  const shown = await cust.content();
  expect(rawPage).toContain('Yanlış ölçü gönderildi');
  for (const leak of leaks) {
    expect(rawPage, `ham yanıt: ${leak}`).not.toContain(leak);
    expect(shown, `sayfa: ${leak}`).not.toContain(leak);
  }
  // Bütün dosya yolları kapalı: dosya kimliği, eski sürüm kimliği, "?ac=1"; görüntüleyici (revizyon ekranı dahil) "bulunamadı"
  for (const url of v1Urls) expect((await cust.request.get(url)).status(), url).toBe(404);
  expect((await cust.goto(v1Viewer))?.status()).toBe(404);
  expect((await cust.goto(`${v1Viewer}?revizyon=1`))?.status()).toBe(404);
  expect((await cust.request.get(v1Viewer)).status()).toBe(404);
  // Reddedilen istek indirme kaydı yazmaz (geri çekmeden önceki kayıtlar durur)
  expect(await custDownloads()).toBe(v1Urls.length);
  // İç roller (çizim, yönetici, satış, denetimci) geri çekilen sürümü eskisi gibi görür: dosya, not, görüntüleyici
  const sales = await as(browser, SALES, TEAM_PW);
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  for (const [who, page] of [['çizim', drawer], ['yönetici', admin], ['satış', sales], ['denetimci', insp]] as const) {
    expect((await page.request.get(`/dosya/cizim/${v1Pdf.id}`)).status(), who).toBe(200);
    expect((await page.request.get(`/dosya/cizim/${v1Pdf.id}?ac=1`)).status(), who).toBe(200);
    expect((await page.request.get(`/dosya/cizim/${v1.id}`)).status(), who).toBe(200);
    expect((await page.request.get(v1Viewer)).status(), who).toBe(200);
    await page.goto(`/siparisler/${id}`);
    const row = page.locator('.drawing-version', { hasText: 'geri çekildi' });
    await expect(row.locator('.file-row'), who).toHaveCount(3);
    await expect(row, who).toContainText('dus-v1.pdf');
    await expect(row, who).toContainText(NOTE);
  }
  await sales.context().close();
  await insp.context().close();

  // Yeni sürüm (v2) — v1 geçmişte kalır
  await drawer.setInputFiles('#drawing-file', sampleFile('dus-v2.pdf', 'pdf v2'));
  await drawer.getByRole('button', { name: 'Taslağa yükle' }).click();
  await drawer.getByRole('link', { name: 'Kontrol Et' }).click();
  drawer.once('dialog', (d) => d.accept());
  await drawer.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(drawer.getByText('Çizim müşterinin onayına gönderildi.')).toBeVisible();
  await expect(drawer.getByText('v2 · güncel')).toBeVisible();
  await expect(drawer.locator('.drawing-version', { hasText: 'dus-v1.dxf' })).toContainText('geri çekildi');

  // Yeni sürüm gönderilince: v2 müşteriye açık (değişmedi), v1 kapalı kalır
  const v2 = await db.drawing.findFirstOrThrow({ where: { orderId: id, version: 2 }, include: { files: true } });
  expect((await cust.request.get(`/dosya/cizim/${v2.files[0].id}`)).status()).toBe(200);
  expect((await cust.request.get(`/dosya/cizim/${v2.id}`)).status()).toBe(200);
  expect((await cust.request.get(`/siparisler/${id}/cizim/${v2.id}`)).status()).toBe(200);
  for (const url of v1Urls) expect((await cust.request.get(url)).status(), url).toBe(404);
  expect((await cust.request.get(v1Viewer)).status()).toBe(404);
  expect(await custDownloads()).toBe(v1Urls.length);
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.locator('.drawing-version', { hasText: 'v2' }).locator('.file-row', { hasText: 'dus-v2.pdf' })).toBeVisible();
  await expect(cust.locator('.drawing-version', { hasText: 'geri çekildi' }).locator('.file-row')).toHaveCount(0);
  const rawAfter = await (await cust.request.get(`/siparisler/${id}`)).text();
  expect(rawAfter).toContain('dus-v2.pdf');
  for (const leak of leaks) expect(rawAfter, leak).not.toContain(leak);

  await cust.goto(`/siparisler/${id}`);
  await cust.getByRole('button', { name: 'Bu çizimi onayla' }).click();
  await expect(cust.getByText(/Çizimi onayladınız|üretime alındı/)).toBeVisible();
});

test('yönetici: soldaki "Çizim Ekibi → Çizim Paneli" çizim ekibinin panelini açar (tam firma adlarıyla); çizim ekibi maskeli görür; öbür roller açamaz', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  // Menü: "Çizim Ekibi" bölümü ve altında "Çizim Paneli"; yöneticinin kendi sayfası "Siparişler" olarak kalır
  await expect(admin.locator('.sidebar .nav-section', { hasText: 'Çizim Ekibi' })).toBeVisible();
  const link = admin.locator('.sidebar').getByRole('link', { name: 'Çizim Paneli' });
  await expect(link).toHaveAttribute('href', '/siparisler?panel=cizim');
  await expect(admin.getByRole('heading', { name: 'Siparişler', exact: true })).toBeVisible();
  await expect(admin.locator('.sidebar a.active')).toHaveText('Siparişler');
  await link.click();
  await expect(admin).toHaveURL(/\/siparisler\?panel=cizim$/);
  await expect(admin.getByRole('heading', { name: 'Çizim Paneli' })).toBeVisible();
  await expect(admin.locator('.sidebar a.active')).toHaveText('Çizim Paneli');

  // Çizim ekibinin bölümleri (ekibin tamamı için); yöneticinin fiyat / profil kuyrukları, uyarıları ve silinenler listesi burada yok
  const titles = await admin.locator('main .card-head h2').allTextContents();
  for (const t of ['Yapılacak çizimler', 'Onay bekleyen çizimler', 'Müşteri tarafından onaylanmış çizimler']) expect(titles.some((x) => x.includes(t)), t).toBe(true);
  for (const t of ['Fiyat onayı bekleyen teklifler', 'Yeni siparişler', 'Teklif hazırlanacaklar', 'Profil', 'Benim çizimlerim', 'Üretimdeki siparişler']) expect(titles.some((x) => x.includes(t)), t).toBe(false);
  await expect(admin.locator('main .alert')).toHaveCount(0);

  // Aynı veri: yöneticinin panelindeki siparişler çizim ekibinin gördükleriyle aynı; sekmeler panelde kalır
  const nos = async (p: typeof admin) => (await p.locator('main a.order-no').allTextContents()).sort();
  await admin.locator('.tabs').getByRole('link', { name: 'Tüm aktif siparişler' }).click();
  await expect(admin).toHaveURL(/\/siparisler\?panel=cizim&view=all$/);
  await expect(admin.getByRole('heading', { name: 'Çizim Paneli' })).toBeVisible();
  const drawer = await as(browser, DRAWER, TEAM_PW);
  await drawer.goto('/siparisler?view=all');
  const seen = await nos(admin);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).toEqual(await nos(drawer));
  // Yöneticinin kendi "tüm aktif" listesi daha geniştir (çizimsiz siparişler de) — yetkisi daralmadı
  await admin.goto('/siparisler?view=all');
  expect((await nos(admin)).length).toBeGreaterThan(seen.length);

  // Firma adı: yönetici tam ad, çizim ekibi maskeli (sayfanın ham yanıtında da)
  await admin.goto('/siparisler?panel=cizim&view=all');
  await expect(admin.locator('main td.mono', { hasText: 'Ünsal Cam' }).first()).toBeVisible();
  for (const url of ['/siparisler?view=all', '/siparisler?panel=cizim&view=all', '/siparisler?panel=cizim']) {
    const html = await (await drawer.request.get(url)).text();
    expect(html, url).not.toContain('Ünsal Cam');
    if (url.includes('view=all')) expect(html, url).toContain('Üns**********');
  }
  // Çizim ekibinin kendi paneli ve menüsü değişmedi
  await drawer.goto('/siparisler');
  await expect(drawer.getByRole('heading', { name: 'Çizim Paneli' })).toBeVisible();
  await expect(drawer.locator('.card-head h2', { hasText: 'Benim çizimlerim' })).toBeVisible();
  await expect(drawer.locator('.sidebar .nav-section', { hasText: 'Çizim Ekibi' })).toHaveCount(0);
  await expect(drawer.locator('.sidebar').getByRole('link', { name: 'Çizim Paneli' })).toHaveCount(0);
  await drawer.context().close();
  await admin.context().close();

  // Satış, denetimci ve müşteri: çizim yetkisi yok — parametre yok sayılır, kendi sayfaları açılır; menülerinde bağlantı yok
  for (const [email, pw, title] of [['fiyat-satis@e2e.test', TEAM_PW, 'Satış Paneli'], ['denetim@e2e.test', INSPECTOR_PW, 'Tüm siparişler (denetim)'], [CUSTOMER, CUST_PW, 'Ünsal Cam — Siparişlerim']] as const) {
    const p = await as(browser, email, pw);
    await p.goto('/siparisler?panel=cizim');
    await expect(p.getByRole('heading', { name: title, exact: true }), email).toBeVisible();
    await expect(p.getByRole('heading', { name: 'Çizim Paneli' }), email).toHaveCount(0);
    await expect(p.locator('.card-head h2', { hasText: 'Yapılacak çizimler' }), email).toHaveCount(0);
    await expect(p.locator('.sidebar').getByRole('link', { name: 'Çizim Paneli' }), email).toHaveCount(0);
    await p.context().close();
  }
});
