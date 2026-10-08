import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as, newOrder, sampleFile, sendDrawing, uploadDrawing } from './helpers';

// Fonksiyonel paket 3 — çizimci paneli, DWG/DXF ve revizyon (karar 167–169), gerçek sunucuda:
//  - "DXF/DWG olarak gelen çizimler" menüsü ve listesi; her siparişte üç AYRI karar (sunucu işlemleri):
//      Üretime Hazır → müşteri onayı beklenmez, "Müşteriden onaylı çizimler"e geçer; dosya ve karar geçmişte
//      Çizim Hatalı → müşteriye bildirim (zil, hemen) + kırmızı bilgilendirme (açıklama Romence çevirisiyle); müşteri
//        düzeltilmiş dosya gönderir (çizimcinin kuyruğuna döner) ya da fabrikadan çizim ister (olağan kuyruk)
//      Çizimi Güncelle → orijinal dosya korunur; olağan çift onaylı gönderim → müşteri onayı → "Müşteriden onaylı çizimler"
//  - müşteri onaylayınca çizimciye bildirim (işçi beklenmez), bağlantı onaylanan SÜRÜMÜN ekranı, tek kez
//  - revizyon: çizimci kuyruğunda satır kırmızı, sipariş sayfasında kırmızı bilgilendirme (numaralı not + Türkçe çeviri)
//  - çizimcinin sipariş ekranı: 1) müşteri dosyaları 2) teknik çizim dosyaları 3) onay ve revizyon 4) notlar 5) bilgiler
//  - firma adı çizimcide maskeli; başka firmanın müşterisi siparişi / dosyayı göremez
// Bu dosyada işçi (scripts/worker.mjs) ÇALIŞTIRILMAZ: bildirimin işlemden hemen sonra yazıldığı böylece kanıtlanır.
// Google'a GERÇEK istek gitmez: sunucu TRANSLATE_FAKE=1 ile sahte sağlayıcıyı kullanır ("[ro] metin"); "#çeviri-hata"
// içeren metinde sahte sağlayıcı zaman aşımı verir. FGO / ANAF'a hiçbir çağrı yapılmaz.
test.describe.configure({ mode: 'serial' });

const BETA = 'beta@betacam.test';
const INSPECTOR = 'denetim@e2e.test';
const FAKE_KEY = 'e2e-sahte-anahtar-0123456789abcdef';
const MASKED = 'Üns**********';
const FIRM = 'Ünsal Cam';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const orderNoOf = async (p: Page) => (await p.locator('.page-head .mono').first().innerText()).trim();
type FeedItem = { title: string; link: string | null };
/** Zilin akışı (JSON) — bildirim zili bunu okur */
const feed = async (p: Page): Promise<FeedItem[]> => (await (await p.request.get('/bildirimler/akis')).json()).items;
/** Yönetici siparişi çizim ekibine gönderir */
async function toDrawing(admin: Page, id: string) {
  await admin.goto(`/siparisler/${id}`);
  await admin.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(admin.getByText('Sipariş çizim ekibine yönlendirildi.')).toBeVisible();
}

test('hazırlık: not çevirisi açık (sahte sağlayıcı — test modu)', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/entegrasyonlar');
  const card = admin.locator('form#ceviri');
  await expect(card.locator('.alert-warn')).toContainText('TEST MODU'); // yoksa dosya burada durur: gerçek Google'a gidilmez
  await card.locator('input[name=enabled]').check();
  await card.locator('input[name=apiKey]').fill(FAKE_KEY);
  await card.getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin).toHaveURL(/ok=translate/);
  await admin.context().close();
});

test('DXF/DWG menüsü: maskeli liste; karar verilmeden yükleme yok; "Üretime Hazır" → müşteri onayı beklenmez, "Müşteriden onaylı çizimler"; dosya ve karar korunur', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'DWG hazır', 'hazir-plan.dwg');
  const orderNo = await orderNoOf(cust);
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await toDrawing(admin, id);

  const drawer = await as(browser, DRAWER, TEAM_PW);
  // Menü: çizim ekibinin solunda "DXF/DWG olarak gelen çizimler"
  await drawer.locator('.sidebar').getByRole('link', { name: 'DXF/DWG olarak gelen çizimler' }).click();
  await expect(drawer).toHaveURL(/\/siparisler\?view=dwg$/);
  await expect(drawer.locator('.sidebar a.active')).toHaveText('DXF/DWG olarak gelen çizimler');
  const row = drawer.locator(`#dwg-bekleyen tr[data-dwg-row="${orderNo}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(MASKED);
  await expect(row.getByRole('link', { name: 'hazir-plan.dwg' })).toHaveAttribute('href', /^\/dosya\/siparis\//);
  for (const name of ['Üretime Hazır', 'Çizimi Güncelle']) await expect(row.getByRole('button', { name })).toBeVisible();
  await expect(row.locator('summary', { hasText: 'Çizim Hatalı' })).toBeVisible();
  // Firma adı çizimcinin hiçbir yanıtında yok (HTML + RSC)
  for (const url of ['/siparisler?view=dwg', `/siparisler/${id}`]) {
    for (const rsc of [false, true]) {
      const body = await (await drawer.request.get(rsc ? `${url}${url.includes('?') ? '&' : '?'}_rsc=1` : url, { headers: rsc ? { RSC: '1' } : {} })).text();
      expect(body, url).not.toContain(FIRM);
    }
  }
  // Çizimci sipariş sayfasında: karar kutusu; karar verilmeden çizim yükleme alanı yok (sunucu da reddeder)
  await drawer.goto(`/siparisler/${id}`);
  await expect(drawer.locator('#dwg-karar')).toContainText('kararınız bekleniyor');
  await expect(drawer.locator('#drawing-file')).toHaveCount(0);
  // Bölüm sırası: müşteri dosyaları → teknik çizim dosyaları → onay ve revizyon → notlar → sipariş bilgileri
  const heads = await drawer.locator('main h2').allTextContents();
  const pos = (h: string) => heads.findIndex((x) => x.includes(h));
  const order = ['Müşteri sipariş dosyaları', 'Teknik çizim dosyaları', 'Çizim onayı ve revizyon', 'Notlar', 'Sipariş bilgileri'].map(pos);
  expect(order.every((x) => x >= 0), heads.join(' | ')).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  await expect(drawer.locator('#teklif, #sandik, .stepper')).toHaveCount(0); // finans / teklif / sandık yok

  // Listeden "Üretime Hazır" (onay penceresi) → sipariş sayfasına
  await drawer.goto('/siparisler?view=dwg');
  await drawer.locator(`#dwg-bekleyen tr[data-dwg-row="${orderNo}"]`).getByRole('button', { name: 'Üretime Hazır' }).click();
  await expect(drawer.locator('.alert-ok', { hasText: 'Müşterinin çizimi üretime hazır kabul edildi' })).toBeVisible();
  await expect(drawer.locator('.page-head .badge', { hasText: 'Çizim onaylandı' })).toBeVisible();
  const rec = drawer.locator('#cizim [data-dwg-status="ONAYLANDI"]');
  await expect(rec).toContainText('üretime hazır');
  await expect(rec.getByRole('link', { name: 'hazir-plan.dwg' })).toBeVisible();
  // Liste: artık karar bekleyenlerde değil; çizim panelinde "Müşteriden onaylı çizimler"de
  await drawer.goto('/siparisler?view=dwg');
  await expect(drawer.locator(`#dwg-bekleyen tr[data-dwg-row="${orderNo}"]`)).toHaveCount(0);
  await drawer.goto('/siparisler');
  await expect(drawer.locator('#onayli-cizimler').locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();
  await expect(drawer.locator('#onayli-cizimler h2')).toContainText('Müşteriden onaylı çizimler');

  // Müşteri onay vermedi; çizimi onaylandı olarak görür; dosyası yerinde ve indirilebilir
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.getByRole('button', { name: 'Bu çizimi onayla' })).toHaveCount(0);
  await expect(cust.locator('#cizim [data-dwg-status="ONAYLANDI"]')).toBeVisible();
  const db = await prisma();
  try {
    const o = await db.order.findUniqueOrThrow({ where: { id }, include: { drawings: true, files: true } });
    expect([o.drawingTrack, o.drawings.map((d) => [d.source, d.status])]).toEqual(['ONAYLANDI', [['MUSTERI_DXF_DWG', 'ONAYLANDI']]]);
    const file = o.files.find((f) => f.name === 'hazir-plan.dwg')!;
    expect((await cust.request.get(`/dosya/siparis/${file.id}`)).status()).toBe(200);
    expect((await drawer.request.get(`/dosya/siparis/${file.id}`)).status()).toBe(200);
    // Başka firmanın müşterisi: sipariş de dosya da yok
    const beta = await as(browser, BETA, TEAM_PW);
    expect((await beta.request.get(`/siparisler/${id}`)).status()).toBe(404);
    expect((await beta.request.get(`/dosya/siparis/${file.id}`)).status()).toBe(404);
    await beta.context().close();
    const drawerUser = await db.user.findUniqueOrThrow({ where: { email: DRAWER } });
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: id, action: 'ORDER_TRANSITION', details: { path: ['action'], equals: 'dwg_ready' } } });
    expect([audit.userId, audit.actorRole, (audit.details as { decision?: string }).decision]).toEqual([drawerUser.id, 'CIZIM', 'READY']);
  } finally {
    await db.$disconnect();
  }
  for (const p of [cust, admin, drawer]) await p.context().close();
});

test('Çizim Hatalı: müşteriye hemen bildirim + kırmızı bilgilendirme (Romence çeviri); düzeltilmiş dosya çizimcinin kuyruğuna döner; hatalı dosya ve karar geçmişte', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'DWG hatalı', 'hatali-plan.dxf');
  const orderNo = await orderNoOf(cust);
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await toDrawing(admin, id);
  const drawer = await as(browser, DRAWER, TEAM_PW);
  await drawer.goto('/siparisler?view=dwg');
  const row = drawer.locator(`#dwg-bekleyen tr[data-dwg-row="${orderNo}"]`);
  await row.locator('summary', { hasText: 'Çizim Hatalı' }).click();
  await row.locator('textarea[name=note]').fill('Ölçü katmanı eksik');
  await row.getByRole('button', { name: 'Hatalı olarak bildir' }).click();
  await expect(drawer.locator('.alert-ok', { hasText: 'Çizim hatalı olarak işaretlendi ve müşteriye bildirildi.' })).toBeVisible();
  await expect(drawer.locator('.page-head .badge', { hasText: 'Müşteri düzeltmesi bekleniyor' })).toBeVisible();
  // Çizimci kendi açıklamasını özgün hâliyle görür (Romence çeviri müşteri içindir)
  const faulty = drawer.locator('#cizim [data-revision-kind="HATALI"]');
  await expect(faulty).toContainText('Ölçü katmanı eksik');
  await expect(faulty.locator('.note-translation')).toHaveCount(0);

  // Müşteri: zil HEMEN (işçi çalışmadı) — bağlantı kırmızı bilgilendirmeye
  const items = await feed(cust);
  const notice = items.find((x) => x.link === `/siparisler/${id}#cizim-hatali`);
  expect(notice, JSON.stringify(items.slice(0, 3))).toBeTruthy();
  expect(notice!.title).toBe('Çiziminizde düzeltme gerekiyor');
  await cust.goto(`/siparisler/${id}`);
  const alert = cust.locator('#cizim-hatali');
  await expect(alert).toHaveClass(/alert-error/);
  await expect(alert).toContainText('Çiziminizde düzeltme gerekiyor.');
  await expect(alert).toContainText('Ölçü katmanı eksik');
  await expect(alert.locator('.note-translation')).toContainText('[ro] Ölçü katmanı eksik');
  await expect(alert.locator('.note-translation')).toContainText('Română · tradus automat');
  // Başka firmanın müşterisi siparişi göremez
  const beta = await as(browser, BETA, TEAM_PW);
  expect((await beta.request.get(`/siparisler/${id}`)).status()).toBe(404);
  await beta.context().close();
  // Denetimci açıklamayı yalnızca özgün hâliyle görür
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(`/siparisler/${id}`);
  await expect(insp.locator('#cizim [data-revision-kind="HATALI"]')).toContainText('Ölçü katmanı eksik');
  await expect(insp.locator('#cizim [data-revision-kind="HATALI"] .note-translation')).toHaveCount(0);
  await insp.context().close();

  // Müşteri düzeltilmiş dosyayı gönderir: yalnızca PDF olursa kabul edilmez (en az bir DWG / DXF). Dosya alanının etiketi
  // gönder düğmesinin adını içermez (Playwright dosya alanını da "button" rolünde sayar; erişilebilirlik için de ayrı adlar)
  const respond = cust.locator('#duzeltme');
  await expect(respond.getByRole('button', { name: 'Düzeltilmiş dosyayı gönder' })).toHaveCount(1);
  await expect(respond.getByLabel('Düzeltilmiş çizim dosyaları (en az bir DWG ya da DXF)')).toHaveAttribute('type', 'file');
  await respond.locator('#dwg-resubmit').setInputFiles(sampleFile('yalniz.pdf', 'pdf'));
  await respond.getByRole('button', { name: 'Düzeltilmiş dosyayı gönder', exact: true }).click();
  await expect(cust.locator('.alert-error', { hasText: 'En az bir DWG ya da DXF dosyası seçin.' })).toBeVisible();
  await cust.locator('#duzeltme #dwg-resubmit').setInputFiles([sampleFile('duzeltilmis-plan.dxf', 'duzeltilmis'), sampleFile('aciklama.pdf', 'aciklama')]);
  await cust.locator('#duzeltme').getByRole('button', { name: 'Düzeltilmiş dosyayı gönder', exact: true }).click();
  await expect(cust.getByText('Düzeltilmiş dosyanız çizim ekibine iletildi.')).toBeVisible();
  await expect(cust.locator('#cizim-hatali')).toHaveCount(0);

  // Çizimci: zil hemen; sipariş yeniden "DXF/DWG" kuyruğunda (düzeltilmiş dosya · v2)
  expect((await feed(drawer)).some((x) => x.link === `/siparisler/${id}#cizim` && x.title === 'Müşteri düzeltilmiş çizim dosyası gönderdi')).toBe(true);
  await drawer.goto('/siparisler?view=dwg');
  const again = drawer.locator(`#dwg-bekleyen tr[data-dwg-row="${orderNo}"]`);
  await expect(again).toContainText('düzeltilmiş dosya · v2');
  await expect(again.getByRole('link', { name: 'duzeltilmis-plan.dxf' })).toBeVisible();
  await again.getByRole('button', { name: 'Üretime Hazır' }).click();
  await expect(drawer.locator('.alert-ok', { hasText: 'Müşterinin çizimi üretime hazır kabul edildi' })).toBeVisible();
  // Geçmiş: v1 hatalı (dosyası ve açıklamasıyla), v2 üretime hazır
  await expect(drawer.locator('#cizim [data-dwg-status="REVIZYON_ISTENDI"]')).toContainText('hatali-plan.dxf');
  await expect(drawer.locator('#cizim [data-dwg-status="REVIZYON_ISTENDI"]')).toContainText('Ölçü katmanı eksik');
  await expect(drawer.locator('#cizim [data-dwg-status="ONAYLANDI"]')).toContainText('duzeltilmis-plan.dxf');
  const db = await prisma();
  try {
    const o = await db.order.findUniqueOrThrow({ where: { id }, include: { drawings: { orderBy: { version: 'asc' } }, files: true } });
    expect(o.drawings.map((d) => [d.version, d.source, d.status])).toEqual([[1, 'MUSTERI_DXF_DWG', 'REVIZYON_ISTENDI'], [2, 'MUSTERI_DXF_DWG', 'ONAYLANDI']]);
    expect(o.files.map((f) => f.name).sort()).toEqual(['aciklama.pdf', 'duzeltilmis-plan.dxf', 'hatali-plan.dxf']);
    expect(await db.notificationOutbox.count({ where: { orderId: id, type: 'ORDER_DWG_FAULTY' } })).toBe(1);
  } finally {
    await db.$disconnect();
  }
  for (const p of [cust, admin, drawer]) await p.context().close();
});

test('Çizim Hatalı → müşteri fabrikadan çizim ister: olağan çizim kuyruğu ve yükleme', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'DWG fabrika', 'fabrika-plan.dwg');
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await toDrawing(admin, id);
  const drawer = await as(browser, DRAWER, TEAM_PW);
  await drawer.goto(`/siparisler/${id}`);
  await drawer.locator('#dwg-karar summary', { hasText: 'Çizim Hatalı' }).click();
  await drawer.locator('#dwg-karar textarea[name=note]').fill('Katmanlar okunmuyor');
  await drawer.locator('#dwg-karar').getByRole('button', { name: 'Hatalı olarak bildir' }).click();
  await expect(drawer.locator('.alert-ok', { hasText: 'Çizim hatalı olarak işaretlendi' })).toBeVisible();
  // Müşterinin düzeltmesi beklenirken çizimci yalnızca "Çizimi Güncelle" diyebilir
  await expect(drawer.locator('#dwg-karar')).toContainText('Müşterinin düzeltmesi bekleniyor');
  await expect(drawer.locator('#dwg-karar').getByRole('button', { name: 'Üretime Hazır' })).toHaveCount(0);
  await drawer.goto('/siparisler?view=dwg');
  await expect(drawer.locator('#dwg-duzeltme').locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();

  await cust.goto(`/siparisler/${id}`);
  await cust.locator('#duzeltme').getByRole('button', { name: 'Fabrikadan yeni çizim iste' }).click();
  await expect(cust.getByText('Talebiniz alındı: çizimi fabrikamız hazırlayıp onayınıza sunacak.')).toBeVisible();
  expect((await feed(drawer)).some((x) => x.link === `/siparisler/${id}#cizim` && x.title === 'Müşteri fabrikadan yeni çizim istedi')).toBe(true);
  await drawer.goto('/siparisler');
  await expect(drawer.locator('.card', { hasText: 'Yapılacak çizimler' }).locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();
  await drawer.goto(`/siparisler/${id}`);
  await expect(drawer.locator('#dwg-karar')).toHaveCount(0);
  await uploadDrawing(drawer, [sampleFile('fabrika-v2.pdf', 'fabrika v2')]);
  for (const p of [cust, admin, drawer]) await p.context().close();
});

test('Çizimi Güncelle: orijinal dosya korunur; çift onaylı gönderim; revizyon kırmızı; müşteri onayı → çizimciye tek bildirim (onaylanan sürüme); çeviri bir kez, yenileme çeviri yapmaz', async ({ browser }) => {
  test.setTimeout(180_000);
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'DWG güncelle', 'guncelle-plan.dwg');
  const orderNo = await orderNoOf(cust);
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await toDrawing(admin, id);
  const drawer = await as(browser, DRAWER, TEAM_PW);
  await drawer.goto(`/siparisler/${id}`);
  await drawer.locator('#dwg-karar').getByRole('button', { name: 'Çizimi Güncelle' }).click();
  await expect(drawer).toHaveURL(new RegExp(`/siparisler/${id}\\?ok=dwg_update#cizim-dosyalari$`));
  await expect(drawer.locator('#cizim-dosyalari #drawing-file')).toHaveCount(1);
  // Yeni çizim: taslak → "Kontrol Et" → "Müşteriye gönder" (mevcut çift onay; sipariş sayfasında gönder düğmesi yok)
  await drawer.setInputFiles('#drawing-file', [sampleFile('guncel-v2.pdf', 'v2'), sampleFile('guncel-v2.dxf', 'v2 dxf')]);
  await drawer.fill('#d-note-c', 'Kenar 5 mm düzeltildi');
  await drawer.getByRole('button', { name: 'Taslağa yükle' }).click();
  await expect(drawer.getByText('Dosyalar taslağa eklendi.')).toBeVisible();
  await sendDrawing(drawer, id);

  // Müşteri: sürüm notu özgün + Romence çevirisiyle; çizimci yalnızca özgün notu görür
  await cust.goto(`/siparisler/${id}`);
  const note = cust.locator('#cizim [data-version-note]').first();
  await expect(note).toContainText('Kenar 5 mm düzeltildi');
  await expect(note.locator('.note-translation')).toContainText('[ro] Kenar 5 mm düzeltildi');
  await drawer.goto(`/siparisler/${id}`);
  await expect(drawer.locator('[data-version-note] .note-translation')).toHaveCount(0);
  // "Müşteriden onay beklenenler"
  await drawer.goto('/siparisler');
  await expect(drawer.locator('.card', { hasText: 'Müşteriden onay beklenenler' }).locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();

  // Müşteri revizyon ister (numaralı maddeler) → çizimcinin zili hemen; kuyrukta satır kırmızı; sayfada kırmızı bilgilendirme
  await cust.goto(`/siparisler/${id}`);
  await cust.getByRole('link', { name: 'Revizyon iste' }).first().click();
  const submit = cust.getByRole('button', { name: 'Revizyon iste' });
  await expect(async () => {
    await cust.getByLabel('Madde 1', { exact: true }).fill('Margine 3 mm');
    await expect(submit).toBeEnabled({ timeout: 1000 });
  }).toPass();
  await cust.getByRole('button', { name: '+ Madde ekle' }).click();
  await cust.getByLabel('Madde 2', { exact: true }).fill('Gaura Ø10');
  await submit.click();
  await expect(cust.getByText('Revizyon talebiniz çizim ekibine iletildi.')).toBeVisible();
  expect((await feed(drawer)).some((x) => x.link === `/siparisler/${id}#cizim` && x.title === 'Müşteri revizyon istedi')).toBe(true);
  await drawer.goto('/siparisler');
  const jobs = drawer.locator('.card', { hasText: 'Yapılacak çizimler' });
  const red = jobs.locator(`tr[data-revision-row="${orderNo}"]`);
  await expect(red).toHaveClass(/row-alert/);
  await expect(red.locator('.badge-danger', { hasText: 'Revizyon istendi' }).first()).toBeVisible();
  expect(await red.evaluate((el) => getComputedStyle(el.querySelector('td')!).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await drawer.goto(`/siparisler/${id}`);
  const revAlert = drawer.locator('#revizyon');
  await expect(revAlert).toHaveClass(/alert-error/);
  await expect(revAlert).toContainText('Müşteri revizyon istedi (v2).');
  await expect(revAlert.locator('ol.revision-list li')).toHaveText(['Margine 3 mm', 'Gaura Ø10']);
  await expect(revAlert.locator('.note-translation')).toContainText('[tr] 1. Margine 3 mm');
  // Önceki sürüm ve karar geçmişte: v1 müşterinin kaydı (fabrika güncelliyor), v2 revizyon istendi
  await expect(drawer.locator('#cizim [data-dwg-status="YAPILIYOR"]')).toContainText('guncelle-plan.dwg');
  await expect(drawer.locator('#cizim .drawing-version[data-version="2"]')).toContainText('revizyon istendi');

  // v3 → müşteri onaylar → çizimciye bildirim (işçi yok), bağlantı onaylanan sürümün ekranı; tek kez
  await uploadDrawing(drawer, [sampleFile('guncel-v3.pdf', 'v3')]);
  await sendDrawing(drawer, id);
  await expect(drawer.locator('#revizyon')).toHaveCount(0);
  await cust.goto(`/siparisler/${id}`);
  await cust.getByRole('button', { name: 'Bu çizimi onayla' }).click();
  await expect(cust.getByText(/Çizimi onayladınız/)).toBeVisible();
  const db = await prisma();
  try {
    const v3 = await db.drawing.findFirstOrThrow({ where: { orderId: id, version: 3 } });
    expect(v3.status).toBe('ONAYLANDI');
    const approved = (await feed(drawer)).filter((x) => x.link === `/siparisler/${id}/cizim/${v3.id}`);
    expect(approved.map((x) => x.title)).toEqual(['Çizim müşteri tarafından onaylandı']);
    await drawer.goto(approved[0].link!);
    await expect(drawer.locator('.page-head .badge', { hasText: 'v3' })).toBeVisible();
    // Yenileme / yoklama: yeni bildirim, yeni kuyruk olayı ya da yeni çeviri yok
    const drawerUser = await db.user.findUniqueOrThrow({ where: { email: DRAWER } });
    const count = () => db.notification.count({ where: { userId: drawerUser.id, orderId: id, type: 'ORDER_DRAWING_APPROVED' } });
    const v2 = await db.drawing.findFirstOrThrow({ where: { orderId: id, version: 2 } });
    expect([v2.translationStatus, v2.translationLang, v2.translation]).toEqual(['DONE', 'ro', '[ro] Kenar 5 mm düzeltildi']);
    const rev = await db.drawingRevision.findFirstOrThrow({ where: { drawingId: v2.id } });
    expect([rev.translationStatus, rev.translation]).toEqual(['DONE', `[tr] ${rev.comment}`]);
    const outbox = await db.notificationOutbox.count({ where: { orderId: id } });
    for (const p of [drawer, cust, admin]) {
      for (let i = 0; i < 2; i++) {
        await p.goto(`/siparisler/${id}`);
        await p.request.get('/bildirimler/akis');
        await p.evaluate(() => window.dispatchEvent(new Event('takip:poll')));
      }
    }
    expect(await count()).toBe(1);
    expect(await db.notificationOutbox.count({ where: { orderId: id } })).toBe(outbox);
    expect(await db.notificationOutbox.count({ where: { orderId: id, type: 'ORDER_DRAWING_APPROVED' } })).toBe(1);
    const v2After = await db.drawing.findUniqueOrThrow({ where: { id: v2.id } });
    expect(v2After.translationAt?.getTime()).toBe(v2.translationAt?.getTime());
    const revAfter = await db.drawingRevision.findUniqueOrThrow({ where: { id: rev.id } });
    expect(revAfter.translationAt?.getTime()).toBe(rev.translationAt?.getTime());
    // Orijinal DWG: silinmedi, üzerine yazılmadı, indirilebilir
    const orig = await db.orderFile.findFirstOrThrow({ where: { orderId: id, name: 'guncelle-plan.dwg' } });
    expect((await drawer.request.get(`/dosya/siparis/${orig.id}`)).status()).toBe(200);
    // "Müşteriden onaylı çizimler"
    await drawer.goto('/siparisler');
    await expect(drawer.locator('#onayli-cizimler').locator(`a[href="/siparisler/${id}"]`).first()).toBeVisible();
  } finally {
    await db.$disconnect();
  }
  for (const p of [cust, admin, drawer]) await p.context().close();
});

test('çeviri yapılamazsa akış sürer; iç ekip "Çeviriyi yeniden dene" ile açıkça ister; müşteri ve denetimci hata görmez', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'DWG çeviri hatası', 'ceviri-plan.dwg');
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await toDrawing(admin, id);
  const drawer = await as(browser, DRAWER, TEAM_PW);
  await drawer.goto(`/siparisler/${id}`);
  await drawer.locator('#dwg-karar summary', { hasText: 'Çizim Hatalı' }).click();
  // Sahte sağlayıcı "#çeviri-hata" içeren metinde zaman aşımı verir
  await drawer.locator('#dwg-karar textarea[name=note]').fill('Katman eksik #çeviri-hata');
  await drawer.locator('#dwg-karar').getByRole('button', { name: 'Hatalı olarak bildir' }).click();
  await expect(drawer.locator('.alert-ok', { hasText: 'Çizim hatalı olarak işaretlendi' })).toBeVisible();
  const failed = drawer.locator('#cizim [data-revision-kind="HATALI"] [data-translation-failed="TIMEOUT"]');
  await expect(failed).toBeVisible();
  // Müşteri: karar ve özgün açıklama yerinde; hata durumu yok; yanıt verebilir
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.locator('#cizim-hatali')).toContainText('Katman eksik #çeviri-hata');
  await expect(cust.locator('[data-translation-failed]')).toHaveCount(0);
  await expect(cust.locator('#duzeltme').getByRole('button', { name: 'Fabrikadan yeni çizim iste' })).toBeVisible();
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(`/siparisler/${id}`);
  await expect(insp.locator('[data-translation-failed]')).toHaveCount(0);
  await expect(insp.getByRole('button', { name: 'Çeviriyi yeniden dene' })).toHaveCount(0);
  await insp.context().close();
  // İç ekip açıkça yeniden ister: (sahte sağlayıcı yine başarısız) not durur, denetim kaydı bir tane
  await failed.getByRole('button', { name: 'Çeviriyi yeniden dene' }).click();
  await expect(drawer.locator('.alert-error', { hasText: 'Çeviri yine yapılamadı' })).toBeVisible();
  const db = await prisma();
  try {
    const rev = await db.drawingRevision.findFirstOrThrow({ where: { drawing: { orderId: id }, kind: 'HATALI' } });
    expect([rev.comment, rev.translationStatus, rev.translationError, rev.translationLang]).toEqual(['Katman eksik #çeviri-hata', 'FAILED', 'TIMEOUT', 'ro']);
    expect(await db.auditLog.count({ where: { action: 'DRAWING_TRANSLATION_RETRY', entityId: rev.id } })).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id } })).drawingTrack).toBe('DUZELTME_BEKLIYOR');
  } finally {
    await db.$disconnect();
  }
  for (const p of [cust, admin, drawer]) await p.context().close();
});
