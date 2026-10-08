import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as } from './helpers';

// Fonksiyonel paket 5 — profil hesaplayıcı + stok yönetimi (kararlar 175–177):
//  - kesin paket içerikleri katalogda (GK15 137, AD45 24, MC12 27, MC16 43 m / kutu); bar boyu, katsayı, kalınlık ve
//    sistemleri yönetici girer; eksik değer varsa hesap yapılmaz ve eksik adıyla söylenir (yöneticide de, müşteride de)
//  - müşteri: sistem + renk + cam kalınlığı + toplam metre → MR23 kalınlığa göre MC12 / MC16; sonuç formdaki adetlere aktarılır,
//    elle değiştirilebilir; yeniden hesapta üzerine yazılacak adetler önce gösterilir (Vazgeç / Evet); adetli aksesuar elle
//  - gönderimden önce stok uyarısı (engellemez); siparişte müşterinin kendi eksik ürünleri gereken / mevcut / eksik ile
//  - yönetici: kritik eşik (tek "Önemli kararlar" kaydı), "Rezerve" sütunu (onaylı, depoya gitmemiş); denetimci salt okunur;
//    satış / çizim / müşteri genel stoğu göremez
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı
const INSPECTOR = 'denetim@e2e.test';
let orderUrl = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
/** Sayfadaki (yönetici oturumunun gördüğü) bir formun sunucu işlemi alanı */
async function actionField(page: Page, url: string, marker: string) {
  const html = await (await page.request.get(url)).text();
  const form = html.split('<form').find((c) => c.includes(marker));
  return form ? /\$ACTION_ID_[0-9a-f]+/.exec(form)?.[0] : undefined;
}
/**
 * Hesaplayıcı ayarı: kalem satırı (ürün kodu, renk, kalınlık etiketi, tüketim). rows: eklendikten sonra beklenen satır sayısı
 * (sayfa yönlendirmesi bitmeden sonraki adıma geçilmez); null = satır eklenmemeli (hata beklenir)
 */
async function addRow(admin: Page, slot: string, code: string | null, color: string, thickness: string, perMeter: string, rows: number | null) {
  await admin.fill('#it-slot', slot);
  const value = code ? await admin.locator('#it-product option', { hasText: `${code} —` }).getAttribute('value') : '';
  await admin.selectOption('#it-product', value ?? '');
  await admin.selectOption('#it-color', color);
  if (thickness) await admin.selectOption('#it-thickness', { label: thickness });
  else await admin.selectOption('#it-thickness', '');
  await admin.fill('#it-per', perMeter);
  await admin.locator('#satir-ekle').getByRole('button', { name: 'Satır ekle' }).click();
  if (rows != null) await expect(admin.locator('#kalemler tr[data-calc-item]')).toHaveCount(rows);
}
const formQty = (page: Page, code: string) => page.locator('table.profile-pick tr', { hasText: code }).locator('input.qty-input');

test('yönetici: kesin paket içerikleri; cam kalınlıkları ve MR23 sistemi; çakışan satır reddedilir; eksik bar boyu "Eksikler"de, girilince sistem hazır', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/profil-katalogu');
  for (const [code, text] of [['GK15', '137 m / kutu'], ['AD45', '24 m / kutu'], ['MC12', '27 m / kutu'], ['MC16', '43 m / kutu']]) {
    await expect(admin.locator(`[data-pack="${code}"]`), code).toHaveText(text);
  }
  await expect(admin.locator('[data-pack="MR23-7016"]')).toHaveText('—'); // bar boyu tahmin edilmez
  await expect(admin.locator('.sidebar').getByRole('link', { name: 'Profil Hesaplayıcı' })).toBeVisible();

  await admin.goto('/admin/profil-katalogu/hesaplama');
  await expect(admin.getByRole('heading', { name: 'Profil Hesaplayıcı', level: 1 })).toBeVisible();
  await expect(admin.locator('#sistemler')).toContainText('Henüz sistem yok');
  for (const [i, mm] of ['12,76', '16,76'].entries()) {
    await admin.fill('#th-mm', mm);
    await admin.locator('#kalinlik').getByRole('button', { name: 'Ekle', exact: true }).click();
    await expect(admin.locator('#kalinlik tr[data-thickness]')).toHaveCount(i + 1);
  }
  await expect(admin.getByText('Eklendi.')).toBeVisible();
  await admin.fill('#sy-code', 'MR23');
  await admin.fill('#sy-ro', 'MR23 mână curentă');
  await admin.fill('#sy-tr', 'MR23 el tutamağı');
  await admin.locator('#yeni-sistem').getByRole('button', { name: 'Sistem ekle' }).click();
  await expect(admin).toHaveURL(/sistem=/);
  await expect(admin.locator('#sistem h2')).toContainText('MR23');
  await addRow(admin, 'Profil', 'MR23-7016', 'RAL7016', '', '1', 1);
  await addRow(admin, 'Profil', 'MR23-ELX', 'ELOXAT', '', '1', 2);
  await addRow(admin, 'El tutamağı contası', 'MC12', '', '12,76 mm', '1', 3);
  await addRow(admin, 'El tutamağı contası', 'MC16', '', '16,76 mm', '1', 4);
  // Aynı kalemde aynı renge uyan ikinci satır reddedilir
  await addRow(admin, 'profil', 'MR23-ELX', '', '', '1', null);
  await expect(admin.getByText('Bu kalemde aynı renge ve cam kalınlığına uyan bir satır zaten var.')).toBeVisible();
  await expect(admin.locator('#kalemler tr[data-calc-item]')).toHaveCount(4);
  // Bar boyu girilmemiş: iki renkte de eksik, ürün adıyla
  const problems = admin.locator('#eksikler li[data-problem="NO_PACK"]');
  await expect(problems).toHaveCount(2);
  await expect(problems.first()).toContainText('MR23-7016 ürününün paket içeriği');
  await expect(admin.locator('#sistemler tr[data-system="MR23"]')).toContainText('2 eksik');

  // Eksik katsayılı deneme sistemi: müşteri hesapta aynı eksikliği görür
  await admin.goto('/admin/profil-katalogu/hesaplama');
  await admin.fill('#sy-code', 'EKSIK');
  await admin.fill('#sy-ro', 'Eksik deneme');
  await admin.fill('#sy-tr', 'Eksik deneme');
  await admin.locator('#yeni-sistem').getByRole('button', { name: 'Sistem ekle' }).click();
  await expect(admin.locator('#sistem h2')).toContainText('EKSIK');
  await addRow(admin, 'Conta', 'GK15', '', '', '', 1);
  await expect(admin.locator('#eksikler li[data-problem="NO_PER_METER"]')).toContainText('GK15 için 1 m korkuluk başına tüketim katsayısı girilmemiş');

  // Bar boyunu yönetici girer (Profil Kataloğu → ürün → paket içeriği)
  for (const code of ['MR23-7016', 'MR23-ELX']) {
    await admin.goto('/admin/profil-katalogu');
    await admin.locator('tr', { hasText: code }).getByRole('link', { name: 'Düzenle' }).click();
    await admin.fill('#pc-pack', '6');
    await admin.selectOption('#pc-measure', 'M');
    await admin.locator('#urun').getByRole('button', { name: 'Kaydet' }).click();
    await expect(admin.getByText('Kaydedildi.')).toBeVisible();
    await expect(admin.locator(`[data-pack="${code}"]`)).toHaveText('6 m / boy');
  }
  await admin.goto('/admin/profil-katalogu/hesaplama');
  await expect(admin.locator('#sistemler tr[data-system="MR23"]')).toContainText('Hazır');
  await admin.locator('#sistemler tr[data-system="MR23"]').getByRole('link', { name: 'Aç' }).click();
  await expect(admin.locator('#eksikler [data-calc-ready]')).toBeVisible();
  await admin.context().close();
});

test('müşteri: hesaplayıcı — MR23 kalınlığa göre MC12 / MC16; forma aktarım, elle değişiklik, üzerine yazma onayı; eksik değer; stok uyarısı engellemez', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto('/siparisler/yeni?tip=PROFILE_ORDER');
  const calc = cust.locator('#hesaplayici');
  await expect(calc.getByRole('heading', { name: 'Metraj hesaplayıcı' })).toBeVisible();
  await calc.locator('#calc-system').selectOption({ label: 'MR23 — MR23 el tutamağı' });
  await calc.locator('#calc-color').selectOption('RAL7016');
  await calc.locator('#calc-thickness').selectOption({ label: '16,76 mm' });
  // Geçersiz metre: miktar üretilmez
  await calc.locator('#calc-meters').fill('-5');
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await expect(calc.locator('[data-calc-errors]')).toContainText('Metre geçersiz');
  await expect(calc.locator('[data-calc-result]')).toHaveCount(0);
  // Enter hesaplar, formu göndermez
  await calc.locator('#calc-meters').fill('30');
  await calc.locator('#calc-meters').press('Enter');
  const res = calc.locator('[data-calc-result]');
  await expect(res.locator('tr[data-calc-row="MR23-7016"] [data-calc-qty]')).toHaveText('5');
  await expect(res.locator('tr[data-calc-row="MC16"] [data-calc-qty]')).toHaveText('1');
  await expect(res.locator('tr[data-calc-row="MC12"]')).toHaveCount(0);
  await expect(res.locator('tr[data-calc-row="MR23-7016"] [data-calc-stock]')).toHaveText('Stok yetersiz: gereken 5, mevcut 0, eksik 5');
  await expect(cust).toHaveURL(/tip=PROFILE_ORDER$/);
  // 12,76 mm → MC12 (27 m / kutu): 30 m → 2 kutu
  await calc.locator('#calc-thickness').selectOption({ label: '12,76 mm' });
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await expect(res.locator('tr[data-calc-row="MC12"] [data-calc-qty]')).toHaveText('2');
  await expect(res.locator('tr[data-calc-row="MC16"]')).toHaveCount(0);
  await calc.locator('#calc-thickness').selectOption({ label: '16,76 mm' });
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await calc.getByRole('button', { name: 'Forma aktar' }).click();
  await expect(calc.locator('[data-calc-applied]')).toBeVisible();
  await expect(formQty(cust, 'MR23-7016')).toHaveValue('5');
  await expect(formQty(cust, 'MC16')).toHaveValue('1');
  await expect(cust.locator('table.profile-pick tr', { hasText: 'MC16' }).locator('[data-calc-mark="calc"]')).toHaveText('hesaplandı');
  // Müşteri değiştirir; adetli aksesuarı elle ekler
  await formQty(cust, 'MC16').fill('3');
  await expect(cust.locator('table.profile-pick tr', { hasText: 'MC16' }).locator('[data-calc-mark="edited"]')).toHaveText('değiştirildi');
  await formQty(cust, 'SPIGOTI').fill('12');
  // Yeniden hesap (40 m): üzerine yazılacak adetler önce gösterilir; "Vazgeç" hiçbir şeyi değiştirmez
  await calc.locator('#calc-meters').fill('40');
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await expect(res.locator('tr[data-calc-row="MR23-7016"] [data-calc-qty]')).toHaveText('7');
  await calc.getByRole('button', { name: 'Forma aktar' }).click();
  const confirm = calc.locator('[data-calc-confirm]');
  await expect(confirm).toContainText('Girdiğiniz miktarların üzerine yazılacak');
  await expect(confirm.locator('li')).toHaveCount(2);
  await expect(confirm).toContainText('MC16 — ');
  await expect(confirm).toContainText(': 3 → 1');
  await expect(confirm).toContainText(': 5 → 7');
  await confirm.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(formQty(cust, 'MC16')).toHaveValue('3');
  await expect(formQty(cust, 'MR23-7016')).toHaveValue('5');
  await calc.getByRole('button', { name: 'Forma aktar' }).click();
  await confirm.getByRole('button', { name: 'Evet, üzerine yaz' }).click();
  await expect(formQty(cust, 'MC16')).toHaveValue('1');
  await expect(formQty(cust, 'MR23-7016')).toHaveValue('7');
  await expect(formQty(cust, 'SPIGOTI')).toHaveValue('12'); // hesap dışındaki ürüne dokunulmadı

  // Eksik katsayı: hiçbir miktar üretilmez, eksik değer ve yöneticinin tamamlaması gerektiği söylenir
  await calc.locator('#calc-system').selectOption({ label: 'EKSIK — Eksik deneme' });
  await expect(calc.locator('#calc-color')).toBeDisabled();
  await expect(calc.locator('#calc-thickness')).toBeDisabled();
  await calc.locator('#calc-meters').fill('10');
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await expect(calc.locator('[data-calc-errors]')).toContainText('GK15 için 1 m korkuluk başına tüketim katsayısı girilmemiş');
  await expect(calc.locator('[data-calc-errors]')).toContainText('yöneticinin tamamlaması gerekiyor');
  await expect(calc.locator('[data-calc-result]')).toHaveCount(0);
  await expect(formQty(cust, 'MR23-7016')).toHaveValue('7');

  // Gönderim: stok uyarısı (yalnızca bu formdaki yetmeyen ürünler) — engellemez
  await cust.fill('#title', 'Metraj hesabı');
  await cust.getByRole('button', { name: 'Siparişi gönder' }).click();
  const check = cust.locator('#stok-uyari');
  await expect(check.locator('tr[data-stock-check-row="MR23-7016"] td.num')).toHaveText(['7 boy', '0', '7']);
  await expect(check.locator('tr[data-stock-check-row]')).toHaveCount(3); // MR23-7016, MC16, SPIGOTI (stoğu yok / eksi)
  await check.getByRole('button', { name: 'Yine de gönder' }).click();
  await expect(cust).toHaveURL(/\/siparisler\/[a-z0-9]+\?ok=profile_created/);
  orderUrl = new URL(cust.url()).pathname;
  const warn = cust.locator('#stok.alert-warn');
  await expect(warn.locator('[data-stock-line="MR23-7016"]')).toContainText('gereken 7 boy, mevcut 0, eksik 7');
  await expect(warn.locator('[data-stock-line]')).toHaveCount(3);
  await cust.context().close();

  const db = await prisma();
  try {
    const id = orderUrl.split('/').pop()!;
    const items = await db.profileOrderItem.findMany({ where: { orderId: id } });
    expect(Object.fromEntries(items.map((i) => [i.code, i.qty]))).toEqual({ 'MR23-7016': 7, MC16: 1, SPIGOTI: 12 });
    expect(await db.adminAlert.count({ where: { orderId: id, type: 'STOCK_SHORTAGE' } })).toBe(1);
    expect(await db.adminAlert.count({ where: { orderId: id } })).toBe(1);
  } finally {
    await db.$disconnect();
  }
});

test('yönetici: "Rezerve" (onaylı, depoya gitmemiş — stok hareketi değil); kritik eşik → tek "Önemli kararlar" kaydı', async ({ browser }) => {
  // Yönetici fiyatlar ve gönderir, müşteri onaylar → sipariş onaylı (depoya gitmedi)
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(orderUrl);
  for (const code of ['MR23-7016', 'MC16', 'SPIGOTI']) await admin.getByLabel(`${code} — Birim fiyat (EUR)`).fill('10');
  await admin.getByRole('button', { name: 'Müşteriye gönder' }).click();
  await expect(admin.getByText('Teklif müşteriye gönderildi.')).toBeVisible();
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(orderUrl);
  await cust.fill('#pk-phone', '+40 723 555 000');
  await cust.fill('#pk-plate', 'b 39 hsp');
  await cust.getByRole('button', { name: 'Teklifi onayla' }).click();
  await expect(cust.getByText('Teklifi onayladınız.', { exact: false })).toBeVisible();
  await cust.context().close();

  await admin.goto('/admin/stok');
  const mr = admin.locator('tr[data-stock-row="MR23-7016"]');
  await expect(mr.locator('td.num').first()).toHaveText('0'); // stok değişmedi
  await expect(mr.locator('[data-reserved]')).toHaveText('7');
  await expect(mr.locator('[data-status]')).toContainText('rezerveye 7 eksik');
  await expect(admin.locator('tr[data-stock-row="MC16"] [data-reserved]')).toHaveText('1');
  // Kritik eşik: GK15 stoğu 6 (11. dosya) → eşik 6 → kritik, tek kayıt
  const gk = admin.locator('tr[data-stock-row="GK15"]');
  await expect(gk.locator('td.num').first()).toHaveText('6');
  await gk.getByLabel('GK15 kritik eşiği').fill('6');
  await gk.getByRole('button', { name: 'Eşiği kaydet' }).click();
  await expect(admin.getByText('Kritik eşik kaydedildi. Ürünün stoğu eşiğin altında')).toBeVisible();
  await expect(admin.locator('tr[data-stock-row="GK15"]')).toHaveClass(/row-alert/);
  await expect(admin.locator('tr[data-stock-row="GK15"] [data-status]')).toContainText('Kritik');
  // Aynı eşik: değişiklik yok, ikinci kayıt yok
  await admin.locator('tr[data-stock-row="GK15"]').getByRole('button', { name: 'Eşiği kaydet' }).click();
  await expect(admin.getByText('Eşik zaten bu değerde.')).toBeVisible();
  await admin.goto('/admin/kararlar');
  const row = admin.locator('.card').first().locator('tr', { hasText: 'Kritik stok: ürün eşiğe indi' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-critical="GK15"]')).toContainText('stok 6 kutu, kritik eşik 6 kutu');
  await expect(row.getByRole('link', { name: 'GK15' })).toHaveAttribute('href', /^\/admin\/stok#s-/);
  await admin.context().close();
  const db = await prisma();
  try {
    expect(await db.adminAlert.count({ where: { type: 'STOCK_CRITICAL' } })).toBe(1);
    expect(await db.stockMovement.count({ where: { orderId: orderUrl.split('/').pop()! } })).toBe(0);
  } finally {
    await db.$disconnect();
  }
});

test('denetimci stoğu yalnızca görür: formsuz sayfa, Excel ve ayar yok; işlemi doğrudan gönderse de stok / eşik değişmez', async ({ browser }) => {
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.locator('.sidebar').getByRole('link', { name: 'Profil Stoğu' }).click();
  await expect(insp).toHaveURL(/\/admin\/stok$/);
  await expect(insp.getByRole('heading', { name: 'Profil Stoğu', level: 1 })).toBeVisible();
  await expect(insp.locator('[data-stock-readonly]')).toBeVisible();
  await expect(insp.locator('form').filter({ hasNot: insp.getByRole('button', { name: 'Çıkış' }) })).toHaveCount(0);
  await expect(insp.locator('input[name="threshold"], #st-p, #st-q, #st-file')).toHaveCount(0);
  await expect(insp.getByRole('link', { name: 'Excel indir' })).toHaveCount(0);
  const gk = insp.locator('tr[data-stock-row="GK15"]');
  await expect(gk.locator('td.num').first()).toHaveText('6');
  await expect(gk.locator('[data-threshold]')).toHaveText('6');
  await expect(gk.locator('[data-status]')).toContainText('Kritik');
  await expect(insp.locator('tr[data-stock-row="MR23-7016"] [data-reserved]')).toHaveText('7');
  expect((await insp.request.get('/admin/stok/excel')).status()).toBe(404);
  await insp.goto('/admin/profil-katalogu/hesaplama');
  await expect(insp).toHaveURL(/\/siparisler$/);
  // Sipariş sayfasında stok kartı (salt okunur, kararlar bağlantısı yok)
  await insp.goto(orderUrl);
  await expect(insp.locator('#stok tr[data-stock-row="MR23-7016"]')).toBeVisible();
  await expect(insp.locator('#stok').getByRole('link', { name: /Önemli kararlar/ })).toHaveCount(0);

  // Yöneticinin formundaki işlemi denetimci doğrudan gönderir → reddedilir, değişiklik yok
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const field = await actionField(admin, '/admin/stok', 'name="threshold"');
  const move = await actionField(admin, '/admin/stok', 'name="kind"');
  expect(field && move).toBeTruthy();
  await admin.context().close();
  const db = await prisma();
  try {
    const p = await db.profileProduct.findUniqueOrThrow({ where: { code: 'GK15' } });
    const before = [p.criticalStock, await db.stockMovement.count(), await db.auditLog.count({ where: { action: { in: ['STOCK_THRESHOLD', 'STOCK_MOVEMENT'] } } })];
    const origin = new URL(insp.url()).origin;
    await insp.request.post('/admin/stok', { multipart: { [field!]: '', productId: p.id, threshold: '999' }, headers: { origin } });
    await insp.request.post('/admin/stok', { multipart: { [move!]: '', productId: p.id, kind: 'SAYIM', qty: '999', note: 'denetimci' }, headers: { origin } });
    const after = [(await db.profileProduct.findUniqueOrThrow({ where: { code: 'GK15' } })).criticalStock, await db.stockMovement.count(), await db.auditLog.count({ where: { action: { in: ['STOCK_THRESHOLD', 'STOCK_MOVEMENT'] } } })];
    expect(after).toEqual(before);
  } finally {
    await db.$disconnect();
  }
  await insp.context().close();
});

test('satış, çizim ve müşteri genel stok envanterini göremez; hesaplayıcı ayarlarını açamaz', async ({ browser }) => {
  for (const [email, pw] of [[SALES, TEAM_PW], [DRAWER, TEAM_PW], [CUSTOMER, CUST_PW]]) {
    const page = await as(browser, email, pw);
    await expect(page.locator('.sidebar').getByRole('link', { name: 'Profil Stoğu' }), email).toHaveCount(0);
    for (const url of ['/admin/stok', '/admin/profil-katalogu/hesaplama']) {
      await page.goto(url);
      await expect(page, `${email} ${url}`).toHaveURL(/\/siparisler$/);
    }
    expect((await page.request.get('/admin/stok/excel')).status(), email).toBe(404);
    await page.context().close();
  }
});
