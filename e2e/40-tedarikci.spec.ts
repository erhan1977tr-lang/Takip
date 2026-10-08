import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as, sampleFile } from './helpers';

// Fonksiyonel paket 6 — tedarikçi yönetimi, satın alma ve tedarikçi hesapları (kararlar 179–184):
//  - menüde "Ayarlar" (eski "Entegrasyonlar"); Ayarlar → Tedarikçiler: ekle / düzenle / pasif, e-posta yalnızca burada
//  - ürünün alış bilgisi (Profil Kataloğu): tedarikçi, alış fiyatı, para birimi — müşterinin liste fiyatından ayrı
//  - Profil Stoğu satırından "Sipariş hazırla" → taslak (kayıtlı alış fiyatı gelir; fiyatsız satır işaretli, uydurulmaz);
//    taslağı kaydetmek e-posta GÖNDERMEZ; yalnızca "Siparişi onayla / gönder" → işçi TEK Türkçe e-posta gönderir
//    (fiyatsız satır varsa fiyat sütunları yok; teknik ek ve logo ekli). Gerçek e-posta yok: MAIL_OUTBOX_DIR klasörü,
//    adresler .test alan adında
//  - e-postasız tedarikçiye gönderim engellenir (sunucuda da)
//  - tahmini yükleme tarihi yalnızca yönetici; 2 gün kala yöneticiye hatırlatma; müşteriye gitmez
//  - hesap: para birimi başına borç / ödeme / kalan; ödeme form anahtarıyla bir kez; iptal
//  - satış, çizim, denetimci, müşteri: sayfalar, ekler ve işlemler kapalı
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı
const INSPECTOR = 'denetim@e2e.test';
const SUP = 'E2E Profil Tedarik';
const SUP_MAIL = 'siparis@e2e-tedarik.test';
const NOMAIL = 'E2E Adressiz Tedarik';
let orderUrl = '';
let orderNo = '';
let fileId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const worker = () => execFileSync('node', ['scripts/worker.mjs', '--once'], { env: process.env, stdio: 'inherit' });
const mails = (to: string) => {
  const dir = process.env.MAIL_OUTBOX_DIR!;
  return fs.readdirSync(dir).filter((f) => f.includes(to)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
};
/** Sayfadaki (yönetici oturumunun gördüğü) bir formun sunucu işlemi alanı */
async function actionField(page: Page, url: string, marker: string) {
  const html = await (await page.request.get(url)).text();
  const form = html.split('<form').find((c) => c.includes(marker));
  return form ? /\$ACTION_ID_[0-9a-f]+/.exec(form)?.[0] : undefined;
}
/** Romanya'da bugünden n gün sonra (YYYY-MM-DD) */
const day = (n: number) => {
  const d = new Date(Date.now() + n * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};

test('yönetici: menüde "Ayarlar" ve "Satın Alma"; Ayarlar → Tedarikçiler — ekle, düzenle, e-postasız uyarı, aynı ad reddedilir, e-posta sunucuda doğrulanır', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const side = admin.locator('.sidebar');
  await expect(side.getByRole('link', { name: 'Ayarlar', exact: true })).toHaveAttribute('href', '/admin/entegrasyonlar');
  await expect(side.getByRole('link', { name: 'Entegrasyonlar' })).toHaveCount(0);
  await expect(side.getByText('Satın Alma', { exact: true })).toBeVisible();
  await expect(side.getByRole('link', { name: 'Tedarikçi Siparişleri' })).toHaveAttribute('href', '/siparisler/tedarik');
  await expect(side.getByRole('link', { name: 'Tedarikçi Hesapları' })).toHaveAttribute('href', '/admin/muhasebe/tedarikciler');

  await side.getByRole('link', { name: 'Ayarlar', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Ayarlar', level: 1 })).toBeVisible();
  await expect(admin.locator('[data-settings-tabs] a.active')).toHaveText('Entegrasyonlar');
  await expect(admin.locator('#fgo')).toBeVisible(); // mevcut entegrasyonlar aynı sayfada
  await admin.locator('[data-settings-tabs]').getByRole('link', { name: 'Tedarikçiler' }).click();
  await expect(admin).toHaveURL(/\/admin\/entegrasyonlar\/tedarikciler$/);
  await expect(admin.locator('[data-settings-tabs] a.active')).toHaveText('Tedarikçiler');
  await expect(admin.locator('.sidebar a.active')).toHaveText('Ayarlar');

  // Ekle
  await admin.fill('#sp-name', SUP);
  await admin.fill('#sp-contact', 'Ayşe Yılmaz');
  await admin.fill('#sp-email', SUP_MAIL);
  await admin.fill('#sp-phone', '+90 212 555 00 00');
  await admin.selectOption('#sp-currency', 'EUR');
  await admin.locator('#tedarikci').getByRole('button', { name: 'Tedarikçi ekle' }).click();
  await expect(admin.getByText('Tedarikçi eklendi.')).toBeVisible();
  const row = admin.locator(`tr[data-supplier="${SUP}"]`);
  await expect(row.locator('[data-email]')).toHaveText(SUP_MAIL);
  await expect(row).toContainText('Etkin');
  // E-postasız tedarikçi: uyarı (sipariş gönderilemez)
  await admin.fill('#sp-name', NOMAIL);
  await admin.locator('#tedarikci').getByRole('button', { name: 'Tedarikçi ekle' }).click();
  await expect(admin.getByText('Tedarikçi eklendi.')).toBeVisible();
  await expect(admin.locator(`tr[data-supplier="${NOMAIL}"] [data-email]`)).toHaveText('E-posta yok');
  await expect(admin.locator('#eposta-eksik')).toContainText('e-posta adresi yok');
  // Aynı ad (büyük / küçük harf, Türkçe I) reddedilir
  await admin.fill('#sp-name', 'e2e profil TEDARİK');
  await admin.locator('#tedarikci').getByRole('button', { name: 'Tedarikçi ekle' }).click();
  await expect(admin.getByText('Bu adla bir tedarikçi zaten var.')).toBeVisible();
  // Geçersiz e-posta sunucuda da reddedilir (tarayıcı denetimi atlanırsa)
  await admin.fill('#sp-name', 'E2E Bozuk Adres');
  await admin.locator('#sp-email').evaluate((el) => el.setAttribute('type', 'text'));
  await admin.fill('#sp-email', 'a@b.test, kopya@baska.test');
  await admin.locator('#tedarikci').getByRole('button', { name: 'Tedarikçi ekle' }).click();
  await expect(admin.getByText('E-posta adresi geçersiz. Tek bir adres yazın (ör. siparis@firma.com).')).toBeVisible();
  await expect(admin.locator('tr[data-supplier="E2E Bozuk Adres"]')).toHaveCount(0);
  // Düzenle
  await row.getByRole('link', { name: 'Düzenle' }).click();
  await expect(admin.locator('#sp-name')).toHaveValue(SUP);
  await admin.fill('#sp-contact', 'Mehmet Öztürk');
  await admin.locator('#tedarikci').getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin.getByText('Tedarikçi kaydedildi.')).toBeVisible();
  await expect(admin.locator(`tr[data-supplier="${SUP}"]`)).toContainText('Mehmet Öztürk');
  await admin.context().close();
});

test('yönetici: ürünün alış bilgisi (Profil Kataloğu) — tedarikçi, alış fiyatı, para birimi; fiyat için para birimi zorunlu', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/profil-katalogu');
  await admin.locator('tr', { hasText: 'MC12' }).first().getByRole('link', { name: 'Düzenle' }).click();
  await expect(admin.locator('#pc-code')).toHaveValue('MC12');
  await expect(admin.locator('#alis')).toContainText('Alış bilgisi (tedarik)');
  const supValue = await admin.locator('#pc-supplier option', { hasText: SUP }).getAttribute('value');
  await admin.selectOption('#pc-supplier', supValue!);
  await admin.fill('#pc-pprice', '2,75');
  await admin.selectOption('#pc-pcur', '');
  await admin.locator('#urun').getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin.getByText('Alış fiyatı girildiyse para birimi de seçilmeli.')).toBeVisible();
  await expect(admin.locator('#pc-code')).toHaveValue('MC12');
  await admin.selectOption('#pc-supplier', supValue!);
  await admin.fill('#pc-pprice', '2,75');
  await admin.selectOption('#pc-pcur', 'EUR');
  await admin.locator('#urun').getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin.getByText('Kaydedildi.')).toBeVisible();
  await expect(admin.locator('[data-purchase="MC12"]')).toContainText('2,75 EUR');
  await expect(admin.locator('[data-purchase="MC12"]')).toContainText(SUP);
  await admin.context().close();
});

test('stok satırından taslak: kayıtlı alış fiyatı gelir, fiyatsız satır işaretli; taslak e-posta göndermez; "Siparişi onayla / gönder" → işçi TEK Türkçe e-posta (fiyat sütunsuz, ekli, logolu)', async ({ browser }) => {
  const db = await prisma();
  const stockBefore = await db.stockMovement.count();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/stok');
  await expect(admin.locator('th', { hasText: 'Beklenen' })).toBeVisible();
  await admin.locator('[data-prepare="MC12"]').click();
  await expect(admin).toHaveURL(/\/siparisler\/tedarik\/yeni\?urun=/);
  await expect(admin.locator('#ts-supplier option:checked')).toContainText(SUP); // ürünün tanımlı tedarikçisi
  await expect(admin.locator('tr[data-create-row="MC12"]')).toContainText('2,75 EUR');
  await admin.locator('input[name^="qty-"]').fill('12');
  await admin.locator('input[name^="color-"]').fill('RAL 7016');
  await admin.getByRole('button', { name: 'Taslak oluştur' }).click();
  await expect(admin.getByText('Taslak oluşturuldu. E-posta gönderilmedi.')).toBeVisible();
  orderUrl = new URL(admin.url()).pathname;
  orderNo = (await db.supplierOrder.findUniqueOrThrow({ where: { id: orderUrl.split('/').pop()! } })).orderNo;
  expect(orderNo).toMatch(/^TS-\d{4}-\d{3}$/);
  await expect(admin.locator('[data-supplier-status="TASLAK"]')).toBeVisible();
  const line1 = admin.locator('#taslak tr[data-line="1"]');
  await expect(line1.getByLabel('Birim alış fiyatı 1', { exact: true })).toHaveValue('2,75');
  await expect(line1.locator('[data-line-total]')).toHaveText('33,00 EUR');
  // Fiyatı olmayan ürün: eklenebilir, "Fiyat yok" (uydurulmaz)
  await admin.locator('#taslak').getByRole('button', { name: '+ Satır ekle' }).click();
  const line2 = admin.locator('#taslak tr[data-line="2"]');
  const mc16 = await line2.locator('select').first().locator('option', { hasText: 'MC16 —' }).getAttribute('value');
  await line2.locator('select').first().selectOption(mc16!);
  await line2.getByLabel('Miktar 2', { exact: true }).fill('3');
  await expect(line2.locator('[data-no-price]')).toHaveText('Fiyat yok');
  await expect(admin.locator('[data-missing-price]')).toBeVisible();
  await expect(admin.locator('[data-grand-total]')).toHaveText('33,00 EUR');
  // Kaydedilmemiş değişiklik varken onay kapalı
  await expect(admin.locator('[data-unsaved]')).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Siparişi onayla / gönder' })).toBeDisabled();
  await admin.getByRole('button', { name: 'Taslağı kaydet' }).click();
  await expect(admin.getByText('Taslak kaydedildi. E-posta gönderilmedi.')).toBeVisible();
  // Teknik ek
  await admin.setInputFiles('#ekler input[type=file]', [sampleFile('teknik-cizim.pdf', 'tedarik e2e')]);
  await admin.locator('#ekler').getByRole('button', { name: 'Ekle', exact: true }).click();
  await expect(admin.getByText('Ek eklendi.')).toBeVisible();
  // Antivirüs açık: "Temiz" (kapalıysa "Taranmadı"); taranmamış ek gönderilmez
  await expect(admin.locator('#ekler .file-row[data-file="teknik-cizim.pdf"]')).toContainText(/Temiz|Taranmadı/);
  fileId = (await db.supplierOrderFile.findFirstOrThrow({ where: { name: 'teknik-cizim.pdf', revision: { order: { orderNo } } } })).id;
  // Taslak, ürün değişikliği ve ek: tedarikçiye hiçbir e-posta gitmedi; işçi çalışsa da gitmez
  worker();
  expect(mails(SUP_MAIL)).toHaveLength(0);
  expect(await db.notificationOutbox.count({ where: { type: 'SUPPLIER_ORDER_EMAIL' } })).toBe(0);

  await admin.getByRole('button', { name: 'Siparişi onayla / gönder' }).click(); // onay penceresi kabul edilir
  await expect(admin.getByText('Sipariş onaylandı ve e-posta gönderim kuyruğuna yazıldı.')).toBeVisible();
  await expect(admin.locator('[data-supplier-status="GONDERIM_BEKLIYOR"]')).toBeVisible();
  await expect(admin.locator('#taslak')).toHaveCount(0); // kesin revizyon düzenlenmez
  await expect(admin.locator('#gonderilen tr[data-final-line="MC12"]')).toContainText('33,00 EUR');
  // Gönderilmeden "Gönderildi" görünmez; işçi bir kez gönderir
  worker();
  await admin.reload();
  await expect(admin.locator('[data-supplier-status="GONDERILDI"]')).toBeVisible();
  await expect(admin.locator('#gonderimler tr[data-email-job="SENT"]')).toHaveCount(1);
  const sent = mails(SUP_MAIL);
  expect(sent).toHaveLength(1);
  const m = sent[0];
  expect(m.subject).toBe(`GKH Trading Invest – Sipariş ${orderNo} – ${SUP}`);
  expect(m.from).toMatch(/^GKH Trading Invest SRL </);
  expect(m.html).toContain('Merhaba,');
  expect(m.html).toContain('Aşağıda detayları bulunan siparişimizi bilgilerinize sunarız.');
  expect(m.html).toContain('Ürün Kodu');
  expect(m.html).toContain('RAL 7016');
  expect(m.html).not.toContain('Birim Fiyat'); // fiyatsız satır var → fiyat sütunları yok
  expect(m.html).not.toContain('Genel Toplam');
  expect(m.text).toContain('Siparişimizin tarafınıza ulaştığını ve tahmini yükleme tarihini teyit etmenizi rica ederiz.');
  expect(m.attachments.map((a: { filename: string }) => a.filename)[0]).toBe('teknik-cizim.pdf');
  expect(m.attachments.some((a: { cid?: string }) => a.cid === 'gkh-logo@takip')).toBe(true);
  // İkinci tur: ikinci e-posta yok
  worker();
  expect(mails(SUP_MAIL)).toHaveLength(1);
  // Stok değişmedi; beklenen tedarik ayrı sütunda
  expect(await db.stockMovement.count()).toBe(stockBefore);
  await admin.goto('/admin/stok');
  await expect(admin.locator('tr[data-stock-row="MC12"] [data-expected]')).toContainText('12');
  await db.$disconnect();
  await admin.context().close();
});

test('e-posta adresi olmayan tedarikçiye gönderim engellenir: düğme kapalı, açık uyarı; sunucuya doğrudan istek de reddedilir', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/siparisler/tedarik/yeni');
  const v = await admin.locator('#ts-supplier option', { hasText: NOMAIL }).getAttribute('value');
  await admin.selectOption('#ts-supplier', v!);
  await admin.getByRole('button', { name: 'Taslak oluştur' }).click();
  await expect(admin.getByText('Taslak oluşturuldu. E-posta gönderilmedi.')).toBeVisible();
  const url = new URL(admin.url()).pathname;
  await admin.locator('#taslak').getByRole('button', { name: '+ Satır ekle' }).click();
  const line = admin.locator('#taslak tr[data-line="1"]');
  const mc12 = await line.locator('select').first().locator('option', { hasText: 'MC12 —' }).getAttribute('value');
  await line.locator('select').first().selectOption(mc12!);
  await line.getByLabel('Miktar 1', { exact: true }).fill('1');
  await admin.getByRole('button', { name: 'Taslağı kaydet' }).click();
  await expect(admin.getByText('Taslak kaydedildi. E-posta gönderilmedi.')).toBeVisible();
  await expect(admin.locator('[data-no-email]')).toContainText('e-posta adresi yok');
  await expect(admin.getByRole('button', { name: 'Siparişi onayla / gönder' })).toBeDisabled();
  // Düğme atlanıp istek doğrudan gönderilirse: sunucu reddeder, hiçbir şey kesinleşmez, kuyruğa iş yazılmaz
  const field = await actionField(admin, url, 'approve-box');
  expect(field).toBeTruthy();
  const db = await prisma();
  try {
    const o = await db.supplierOrder.findUniqueOrThrow({ where: { id: url.split('/').pop()! } });
    const res = await admin.request.post(url, { multipart: { [field!]: '', orderId: o.id, version: String(o.version) }, headers: { origin: new URL(admin.url()).origin } });
    expect(res.status()).toBeLessThan(500);
    // Sunucunun açık hatası (işlem sayfaya hata koduyla döner)
    expect(await res.text()).toContain('Tedarikçinin e-posta adresi yok. Ayarlar → Tedarikçiler ekranından ekleyin. Sipariş gönderilmedi.');
    const after = await db.supplierOrder.findUniqueOrThrow({ where: { id: o.id }, include: { revisions: true } });
    expect([after.status, after.revisions[0].finalizedAt]).toEqual(['TASLAK', null]);
    expect(await db.notificationOutbox.count({ where: { type: 'SUPPLIER_ORDER_EMAIL', payload: { path: ['supplierOrderId'], equals: o.id } } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
  await admin.context().close();
});

test('tahmini yükleme tarihi: yalnızca yönetici girer; 2 gün kala yöneticiye hatırlatma; listede işaret; müşteriye ve başka role gitmez', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(orderUrl);
  await admin.locator('#eta input[type=date]').fill(day(1));
  await admin.locator('#eta').getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin.getByText('Tahmini yükleme tarihi kaydedildi.')).toBeVisible();
  await expect(admin.locator('[data-eta-info]')).toHaveText(day(1).split('-').reverse().join('.'));
  await admin.goto('/siparisler/tedarik');
  await expect(admin.locator(`tr[data-supplier-order="${orderNo}"] [data-eta]`)).toContainText('Yaklaşıyor');
  const db = await prisma();
  try {
    const id = orderUrl.split('/').pop()!;
    const notes = await db.notification.findMany({ where: { type: 'SUPPLIER_ETA', dedupeKey: `supplier-eta:${id}:${day(1)}` }, include: { user: { select: { appRole: true } } } });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.user.appRole === 'ADMIN')).toBe(true);
    expect(notes[0].link).toBe(orderUrl);
    // Aynı tarih için ikinci hatırlatma yok (işçinin turu da aynı anahtarı yazar)
    worker();
    expect(await db.notification.count({ where: { type: 'SUPPLIER_ETA', dedupeKey: `supplier-eta:${id}:${day(1)}` } })).toBe(notes.length);
    expect(await db.notification.count({ where: { type: 'SUPPLIER_ETA', user: { appRole: { not: 'ADMIN' } } } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
  await admin.context().close();
  // Müşteri: tedarikçi siparişini hiçbir yerde göremez
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(orderUrl);
  await expect(cust).toHaveURL(/\/siparisler$/);
  await expect(cust.locator('body')).not.toContainText(orderNo);
  await expect(cust.locator('body')).not.toContainText(SUP);
  await cust.context().close();
});

test('hesap: borç onaylanan siparişten (fiyatsız kısım ayrıca); ödeme bir kez (aynı form iki kez gelse de); para birimleri ayrı; ödeme iptali', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/muhasebe/tedarikciler');
  await expect(admin.getByRole('heading', { name: 'Tedarikçi Hesapları', level: 1 })).toBeVisible();
  const row = admin.locator(`tr[data-account="${SUP}"]`);
  await expect(row.locator('[data-balance="EUR"]')).toContainText('33,00');
  await row.getByRole('link', { name: 'Hesap ayrıntısı' }).click();
  await expect(admin.locator('#bakiye tr[data-balance="EUR"]')).toContainText('33,00');
  await expect(admin.locator('#bakiye [data-missing-price]')).toContainText('1 siparişte fiyatı olmayan satır var');
  await expect(admin.locator(`#siparisler tr[data-account-order="${orderNo}"]`)).toBeVisible();
  // Ödeme (EUR)
  await admin.fill('#pay-amount', '10');
  await admin.selectOption('#pay-cur', 'EUR');
  await admin.fill('#pay-note', 'Havale');
  await admin.getByRole('button', { name: 'Ödemeyi kaydet' }).click();
  await expect(admin.getByText('Ödeme kaydedildi.')).toBeVisible();
  await expect(admin.locator('#bakiye tr[data-balance="EUR"]')).toContainText('23,00');
  // Aynı form (aynı anahtar) iki kez gelirse tek ödeme
  const url = new URL(admin.url());
  const field = await actionField(admin, url.pathname + url.search, 'name="requestKey"');
  const key = await admin.locator('#odeme input[name="requestKey"]').inputValue();
  const supplierId = await admin.locator('#odeme input[name="supplierId"]').inputValue();
  const body = { [field!]: '', supplierId, requestKey: key, paidOn: day(0), amount: '5', currency: 'USD', note: 'çift' };
  for (let i = 0; i < 2; i++) await admin.request.post(url.pathname + url.search, { multipart: body, headers: { origin: url.origin } });
  const db = await prisma();
  try {
    expect(await db.supplierPayment.count({ where: { requestKey: key } })).toBe(1);
  } finally {
    await db.$disconnect();
  }
  await admin.reload();
  // USD ayrı satır (EUR'a eklenmez)
  await expect(admin.locator('#bakiye tr[data-balance="USD"]')).toContainText('-5,00');
  await expect(admin.locator('#bakiye tr[data-balance="EUR"]')).toContainText('23,00');
  // USD ödemesini iptal et: satır gider, kayıt silinmez
  const pay = admin.locator('#odemeler tr[data-payment="5"]');
  await pay.locator('input[name="reason"]').fill('Yanlış para birimi');
  await pay.getByRole('button', { name: 'Ödemeyi iptal et' }).click();
  await expect(admin.getByText('Ödeme iptal edildi.')).toBeVisible();
  await expect(admin.locator('#bakiye tr[data-balance="USD"]')).toHaveCount(0);
  await expect(admin.locator('#odemeler tr[data-payment="5"]')).toContainText('İptal: Yanlış para birimi');
  await admin.context().close();
});

test('yetki: satış, çizim, denetimci ve müşteri tedarik sayfalarına, eklerine ve işlemlerine erişemez; menüde görmez; denetimci stokta beklenen tedariki görmez', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const etaField = await actionField(admin, orderUrl, 'type="date"');
  const supplierField = await actionField(admin, '/admin/entegrasyonlar/tedarikciler', 'name="currency"');
  expect(etaField && supplierField).toBeTruthy();
  await admin.context().close();
  const db = await prisma();
  try {
    const snapshot = async () => JSON.stringify([
      await db.supplier.findMany({ orderBy: { id: 'asc' } }), await db.supplierOrder.findMany({ orderBy: { id: 'asc' } }),
      await db.supplierPayment.count(), await db.notificationOutbox.count({ where: { type: 'SUPPLIER_ORDER_EMAIL' } }),
    ]);
    const before = await snapshot();
    for (const [email, pw] of [[SALES, TEAM_PW], [DRAWER, TEAM_PW], [INSPECTOR, INSPECTOR_PW], [CUSTOMER, CUST_PW]]) {
      const page = await as(browser, email, pw);
      const side = page.locator('.sidebar');
      for (const name of ['Tedarikçi Siparişleri', 'Tedarikçi Hesapları']) await expect(side.getByRole('link', { name }), `${email} ${name}`).toHaveCount(0);
      await expect(side.getByText('Satın Alma', { exact: true })).toHaveCount(0);
      for (const url of ['/siparisler/tedarik', '/siparisler/tedarik/yeni', orderUrl, '/admin/entegrasyonlar/tedarikciler', '/admin/muhasebe/tedarikciler']) {
        await page.goto(url);
        await expect(page, `${email} ${url}`).toHaveURL(/\/siparisler$/);
        await expect(page.locator('body'), `${email} ${url}`).not.toContainText(SUP_MAIL);
      }
      expect((await page.request.get(`/dosya/tedarik/${fileId}`)).status(), `${email} ek`).toBe(404);
      // Yöneticinin formlarının işlem kimliğiyle doğrudan istek: hiçbir şey değişmez
      const origin = new URL(page.url()).origin;
      await page.request.post(orderUrl, { multipart: { [etaField!]: '', orderId: orderUrl.split('/').pop()!, eta: day(5) }, headers: { origin } });
      await page.request.post('/admin/entegrasyonlar/tedarikciler', { multipart: { [supplierField!]: '', name: `Sızma ${email}`, email: 'x@sizma.test', currency: 'EUR' }, headers: { origin } });
      if (email === INSPECTOR) {
        await page.goto('/admin/stok');
        await expect(page.locator('th', { hasText: 'Beklenen' })).toHaveCount(0);
        await expect(page.locator('[data-prepare]')).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Kritik stok için sipariş hazırla' })).toHaveCount(0);
      }
      await page.context().close();
    }
    expect(await snapshot()).toBe(before);
  } finally {
    await db.$disconnect();
  }
  // Yönetici eki indirebilir
  const again = await as(browser, ADMIN, ADMIN_PW);
  const res = await again.request.get(`/dosya/tedarik/${fileId}`);
  expect(res.status()).toBe(200);
  expect((await res.body()).toString('latin1')).toContain('tedarik e2e');
  await again.context().close();
});
