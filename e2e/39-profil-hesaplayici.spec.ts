import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as } from './helpers';

// Fonksiyonel paket 5 — profil hesaplayıcı + stok yönetimi (kararlar 175–177) ve korkuluk hesaplayıcısının kesin kuralları
// (kararlar 203–204):
//  - kesin paket içerikleri katalogda (GK15 137, AD45 24, MC12 27, MC16 43 m / kutu, profiller 6 m); varsayılan sistemler
//    FBL90 / FBL115 (korkuluk profili) ve MR23 / RM29 (küpeşte), cam 6+6 / 8+8 hazır; yöneticinin yeni sistemi eksikse hesap
//    yapılmaz ve eksik adıyla söylenir (yöneticide de, müşteride de)
//  - müşteri: cam + renk + profil + küpeşte + toplam metre → profil ve küpeşte birlikte; sonuç formdaki adetlere aktarılır,
//    elle değiştirilebilir; yeniden hesapta üzerine yazılacak adetler önce gösterilir (Vazgeç / Evet); adetli aksesuar elle;
//    Romence panelde Romence, tablet / mobilde taşma yok
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

test('yönetici: kesin paket içerikleri ve korkuluk varsayılanları (karar 203) hazır — FBL90 / FBL115 / MR23 / RM29, 6+6 / 8+8, 6 m boy; çakışan satır reddedilir; eksik katsayı "Eksikler"de', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/admin/profil-katalogu');
  for (const [code, text] of [['GK15', '137 m / kutu'], ['AD45', '24 m / kutu'], ['MC12', '27 m / kutu'], ['MC16', '43 m / kutu'], ['MR23-7016', '6 m / boy'], ['FBL90-ELX', '6 m / boy']]) {
    await expect(admin.locator(`[data-pack="${code}"]`), code).toHaveText(text);
  }
  await expect(admin.locator('.sidebar').getByRole('link', { name: 'Profil Hesaplayıcı' })).toBeVisible();

  await admin.goto('/admin/profil-katalogu/hesaplama');
  await expect(admin.getByRole('heading', { name: 'Profil Hesaplayıcı', level: 1 })).toBeVisible();
  await expect(admin.locator('[data-calc-defaults="applied"]')).toBeVisible();
  await expect(admin.locator('#kalinlik tr[data-thickness]')).toHaveCount(2);
  await expect(admin.locator('#kalinlik tr[data-thickness="12.76"]')).toContainText('6+6');
  await expect(admin.locator('#kalinlik tr[data-thickness="16.76"]')).toContainText('8+8');
  for (const [code, kind] of [['FBL90', 'Profil'], ['FBL115', 'Profil'], ['MR23', 'Küpeşte'], ['RM29', 'Küpeşte']]) {
    const row = admin.locator(`#sistemler tr[data-system="${code}"]`);
    await expect(row, code).toContainText('Hazır');
    await expect(row.locator('[data-kind]'), code).toHaveText(kind);
  }
  // Aynı kalemde aynı renge uyan ikinci satır reddedilir (varsayılan sistemde de)
  await admin.locator('#sistemler tr[data-system="MR23"]').getByRole('link', { name: 'Aç' }).click();
  await expect(admin.locator('#sistem h2')).toContainText('MR23');
  await expect(admin.locator('#se-kind')).toHaveValue('HANDRAIL');
  await addRow(admin, 'profil', 'MR23-ELX', '', '', '1', null);
  await expect(admin.getByText('Bu kalemde aynı renge ve cam kalınlığına uyan bir satır zaten var.')).toBeVisible();
  await expect(admin.locator('#kalemler tr[data-calc-item]')).toHaveCount(4);

  // Yöneticinin yeni bir korkuluk profili (eksik katsayıyla): müşteri hesapta aynı eksikliği görür
  await admin.goto('/admin/profil-katalogu/hesaplama');
  await admin.fill('#sy-code', 'EKSIK');
  await admin.fill('#sy-ro', 'Eksik deneme');
  await admin.fill('#sy-tr', 'Eksik deneme');
  await admin.selectOption('#sy-kind', 'PROFILE');
  await admin.locator('#yeni-sistem').getByRole('button', { name: 'Sistem ekle' }).click();
  await expect(admin.locator('#sistem h2')).toContainText('EKSIK');
  await addRow(admin, 'Conta', 'GK15', '', '', '', 1);
  await expect(admin.locator('#eksikler li[data-problem="NO_PER_METER"]')).toContainText('GK15 için 1 m korkuluk başına tüketim katsayısı girilmemiş');
  await admin.context().close();
});

test('müşteri: beş alan (cam, renk, profil, küpeşte, metre) — FBL90 + MR23 birlikte; 6+6 → MC12, 8+8 → MC16; RM29 contasız; forma aktarım, elle değişiklik korunur, üzerine yazma onayı; eksik değer; stok uyarısı engellemez', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.setViewportSize({ width: 1440, height: 900 });
  await cust.goto('/siparisler/yeni?tip=PROFILE_ORDER');
  const calc = cust.locator('#hesaplayici');
  await expect(calc.getByRole('heading', { name: 'Profil ve aksesuar hesaplayıcı' })).toBeVisible();
  // Masaüstünde beş alan tek yatay satırda, sırasıyla; "artıkları kullan" seçeneği yok
  const labels = await calc.locator('.calc-grid label').allInnerTexts();
  expect(labels).toEqual(['Cam tipi', 'Profil rengi', 'Profil tipi', 'Küpeşte', 'Toplam metre']);
  const tops = await calc.locator('.calc-grid .calc-field').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size, 'tek satır').toBe(1);
  await expect(calc.locator('input[type=checkbox]')).toHaveCount(0);
  expect(await calc.locator('#calc-thickness option').allInnerTexts()).toEqual(['— cam seçin —', '6+6', '8+8']);
  expect(await calc.locator('#calc-color option').allInnerTexts()).toEqual(['— renk seçin —', '7016 MAT', 'Eloxat']);
  expect(await calc.locator('#calc-handrail option').allInnerTexts()).toEqual(['Yok', 'MR23', 'RM29']);
  await calc.locator('#calc-thickness').selectOption({ label: '8+8' });
  await calc.locator('#calc-color').selectOption('RAL7016');
  await calc.locator('#calc-profile').selectOption({ label: 'FBL 90' });
  await calc.locator('#calc-handrail').selectOption({ label: 'MR23' });
  // Geçersiz metre: miktar üretilmez
  await calc.locator('#calc-meters').fill('-5');
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await expect(calc.locator('[data-calc-errors]')).toContainText('Metre geçersiz');
  await expect(calc.locator('[data-calc-result]')).toHaveCount(0);
  // Örnek A: 20 m → FBL90 4 boy, PANA-L90 + PANA-90-16 4 poşet, MR23 4 boy, MC16 1 kutu (Enter hesaplar, formu göndermez)
  await calc.locator('#calc-meters').fill('20');
  await calc.locator('#calc-meters').press('Enter');
  const res = calc.locator('[data-calc-result]');
  const row = (code: string) => res.locator(`tr[data-calc-row="${code}"]`);
  await expect(res.locator('tr[data-calc-row]')).toHaveCount(5);
  for (const [code, qty, unit, color] of [['FBL90-7016', '4', 'boy', '7016 MAT'], ['PANA-L90', '4', 'poşet', '—'], ['PANA-90-16', '4', 'poşet', '—'], ['MR23-7016', '4', 'boy', '7016 MAT'], ['MC16', '1', 'kutu', '—']]) {
    await expect(row(code).locator('[data-calc-qty]'), code).toHaveText(qty);
    await expect(row(code).locator('[data-calc-unit]'), code).toHaveText(unit);
    await expect(row(code).locator('[data-calc-color]'), code).toHaveText(color);
  }
  await expect(cust).toHaveURL(/tip=PROFILE_ORDER$/);
  // 6+6 → MC12 ve PANA-90-12 (MC16 / PANA-90-16 yok)
  await calc.locator('#calc-thickness').selectOption({ label: '6+6' });
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await expect(row('MC12').locator('[data-calc-qty]')).toHaveText('1');
  await expect(row('PANA-90-12').locator('[data-calc-qty]')).toHaveText('4');
  await expect(res.locator('tr[data-calc-row="MC16"], tr[data-calc-row="PANA-90-16"]')).toHaveCount(0);
  // Örnek B: 25 m, FBL115 + RM29, 6+6 → RM12, conta yok
  await calc.locator('#calc-profile').selectOption({ label: 'FBL 115' });
  await calc.locator('#calc-handrail').selectOption({ label: 'RM29' });
  await calc.locator('#calc-meters').fill('25');
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await expect(row('RM12-7016').locator('[data-calc-qty]')).toHaveText('5');
  await expect(row('PANA-115-12').locator('[data-calc-qty]')).toHaveText('5');
  await expect(res.locator('tr[data-calc-row="MC12"], tr[data-calc-row="MC16"]')).toHaveCount(0);
  // Küpeşte yok: yalnız FBL + poşetler
  await calc.locator('#calc-handrail').selectOption({ label: 'Yok' });
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await expect(res.locator('tr[data-calc-row]')).toHaveCount(3);

  // 8+8, FBL90 + MR23, 30 m → forma aktar
  await calc.locator('#calc-thickness').selectOption({ label: '8+8' });
  await calc.locator('#calc-profile').selectOption({ label: 'FBL 90' });
  await calc.locator('#calc-handrail').selectOption({ label: 'MR23' });
  await calc.locator('#calc-meters').fill('30');
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await expect(row('MR23-7016').locator('[data-calc-qty]')).toHaveText('5');
  await expect(row('MR23-7016').locator('[data-calc-stock]')).toHaveText('Stok yetersiz: gereken 5, mevcut 0, eksik 5');
  await calc.getByRole('button', { name: 'Forma aktar' }).click();
  await expect(calc.locator('[data-calc-applied]')).toBeVisible();
  for (const [code, q] of [['FBL90-7016', '5'], ['PANA-L90', '5'], ['PANA-90-16', '5'], ['MR23-7016', '5'], ['MC16', '1']]) await expect(formQty(cust, code), code).toHaveValue(q);
  await expect(cust.locator('table.profile-pick tr', { hasText: 'MC16' }).locator('[data-calc-mark="calc"]')).toHaveText('hesaplandı');
  // Müşteri değiştirir; adetli aksesuarı elle ekler
  await formQty(cust, 'MC16').fill('3');
  await expect(cust.locator('table.profile-pick tr', { hasText: 'MC16' }).locator('[data-calc-mark="edited"]')).toHaveText('değiştirildi');
  await formQty(cust, 'SPIGOTI').fill('12');
  // Yeniden hesap (40 m) formu değiştirmez; aktarımda üzerine yazılacaklar önce gösterilir; "Vazgeç" hiçbir şeyi değiştirmez
  await calc.locator('#calc-meters').fill('40');
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await expect(row('MR23-7016').locator('[data-calc-qty]')).toHaveText('7');
  await expect(formQty(cust, 'MC16')).toHaveValue('3');
  await calc.getByRole('button', { name: 'Forma aktar' }).click();
  const confirm = calc.locator('[data-calc-confirm]');
  await expect(confirm).toContainText('Girdiğiniz miktarların üzerine yazılacak');
  await expect(confirm.locator('li')).toHaveCount(5);
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
  // Müşteri hesaplanan miktarları değiştirebilir: bu sipariş yalnızca küpeşte + conta + spigot
  for (const code of ['FBL90-7016', 'PANA-L90', 'PANA-90-16']) await formQty(cust, code).fill('0');

  // Eksik katsayı (yöneticinin yeni profili): hiçbir miktar üretilmez, eksik değer ve yöneticinin tamamlaması gerektiği söylenir
  await calc.locator('#calc-profile').selectOption({ label: 'Eksik deneme' });
  await calc.locator('#calc-meters').fill('10');
  await calc.getByRole('button', { name: 'Hesapla' }).click();
  await expect(calc.locator('[data-calc-errors]')).toContainText('GK15 için 1 m korkuluk başına tüketim katsayısı girilmemiş');
  await expect(calc.locator('[data-calc-errors]')).toContainText('yöneticinin tamamlaması gerekiyor');
  await expect(calc.locator('[data-calc-result]')).toHaveCount(0);
  await expect(formQty(cust, 'MR23-7016')).toHaveValue('7');

  // Hesap hiçbir şey yazmadı: stok hareketi / sipariş yok
  const db0 = await prisma();
  const moves = await db0.stockMovement.count();
  await db0.$disconnect();

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
    expect(await db.stockMovement.count(), 'hesap ve sipariş stok hareketi yazmaz').toBe(moves);
  } finally {
    await db.$disconnect();
  }
});

test('müşteri: hesaplayıcı Romence panelde Romence; tablette 3, mobilde tek sütun — yatay taşma yok; ürün kodları çevrilmez', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.context().addCookies([{ name: 'takip_lang', value: 'ro', url: new URL(cust.url()).origin }]);
  await cust.goto('/siparisler/yeni?tip=PROFILE_ORDER');
  const calc = cust.locator('#hesaplayici');
  await expect(cust.locator('html')).toHaveAttribute('lang', 'ro');
  await expect(calc.getByRole('heading', { name: 'Calculator profile și accesorii' })).toBeVisible();
  expect(await calc.locator('.calc-grid label').allInnerTexts()).toEqual(['Tip geam', 'Culoare profil', 'Dimensiune profil', 'Mână curentă', 'Metri totali']);
  expect(await calc.locator('#calc-handrail option').allInnerTexts()).toEqual(['Fără', 'MR23', 'RM29']);
  await calc.locator('#calc-thickness').selectOption({ label: '6+6' });
  await calc.locator('#calc-color').selectOption('ELOXAT');
  await calc.locator('#calc-profile').selectOption({ label: 'FBL 115' });
  await calc.locator('#calc-handrail').selectOption({ label: 'MR23' });
  await calc.locator('#calc-meters').fill('60');
  await calc.getByRole('button', { name: 'Calculează' }).click();
  const res = calc.locator('[data-calc-result]');
  // Örnek D (Eloxat): FBL115 10, L115/115-12 10, MR23 10, MC12 3
  for (const [code, qty, unit] of [['FBL115-ELX', '10', 'bară'], ['PANA-L115', '10', 'pungi'], ['PANA-115-12', '10', 'pungi'], ['MR23-ELX', '10', 'bară'], ['MC12', '3', 'cutii']]) {
    await expect(res.locator(`tr[data-calc-row="${code}"] [data-calc-qty]`), code).toHaveText(qty);
    await expect(res.locator(`tr[data-calc-row="${code}"] [data-calc-unit]`), code).toHaveText(unit);
  }
  await expect(res.getByRole('button', { name: 'Transferă în formular' })).toBeVisible();
  await expect(res.locator('thead')).toContainText('Cod produs');
  for (const [w, cols] of [[900, 3], [390, 1]] as const) {
    await cust.setViewportSize({ width: w, height: 900 });
    const xs = await calc.locator('.calc-grid .calc-field').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(xs).size, `${w}px: ${cols} sütun`).toBe(cols);
    // Hesaplayıcı kartı ekrandan taşmaz ve kendi içinde yatay kaydırma gerektirmez (sonuç tablosu kendi kaydırma kutusunda)
    const [right, sw, cw, iw] = await calc.evaluate((el) => [el.getBoundingClientRect().right, el.scrollWidth, el.clientWidth, window.innerWidth]);
    expect(right, `${w}px: kart ekranda`).toBeLessThanOrEqual(iw + 1);
    expect(sw, `${w}px: yatay taşma yok`).toBeLessThanOrEqual(cw + 1);
  }
  await cust.context().close();
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
