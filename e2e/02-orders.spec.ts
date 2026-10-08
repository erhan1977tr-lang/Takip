import { test, expect } from '@playwright/test';
import {
  ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, GLASS, GLASS_RO, SALES, TEAM_PW as PW, sampleFile,
  addGlass, as, createUser, fillOffer, firstLogin, login, newOrder, outboxCodeFor, sendDrawing, uploadDrawing,
} from './helpers';

// Sipariş akışı: çizim ve teklif hatları bağımsız; müşteri yalnızca çizimi onaylar, teklifi görür.
test.describe.configure({ mode: 'serial' });

const BETA = 'beta@betacam.test';
const ids: { a?: string; b?: string; drawing?: string } = {};

test('hazırlık: katalog, satış, çizim ve ikinci müşteri', async ({ page }) => {
  await login(page, ADMIN, ADMIN_PW);
  await page.goto('/admin/katalog');
  await addGlass(page, GLASS, GLASS_RO);
  await addGlass(page, '4mm Float Cam', 'Sticlă float 4 mm');

  await page.goto('/admin/firms');
  await page.fill('#f-name', 'Beta Cam');
  await page.fill('#f-prefix', 'BET');
  await page.click('form.card button[type=submit]');
  await expect(page.getByText('“Beta Cam” firması oluşturuldu (kod: BET)')).toBeVisible();

  await createUser(page, { email: SALES, name: 'Satış Kişi', role: 'Satış', firm: 'GKH Trading' });
  await createUser(page, { email: DRAWER, name: 'Çizim Kişi', role: 'Çizimci', firm: 'GKH Trading' });
  await createUser(page, { email: BETA, name: 'Beta Müşteri', role: 'Müşteri', firm: 'Beta Cam', canApprove: true });

  for (const email of [SALES, DRAWER, BETA]) {
    const ctx = await page.context().browser()!.newContext();
    const p = await ctx.newPage();
    await firstLogin(p, email, outboxCodeFor(email), PW);
    await ctx.close();
  }
});

test('teklif yolu: çizim gerekmez → teklif → yönetici onayı → otomatik üretim; müşteri teklifi yalnızca görür', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  ids.a = await newOrder(cust, 'Duş kabini', 'Darius.dwg');
  await expect(cust.getByText('UNS1').first()).toBeVisible();

  const sales = await as(browser, SALES, PW);
  await expect(sales.getByRole('heading', { name: 'Satış Paneli' })).toBeVisible();
  const row = sales.locator('.card', { hasText: 'Yeni siparişler — karar bekliyor' }).locator('tr', { hasText: 'UNS1' });
  await expect(row).toBeVisible();
  await expect(row.getByText('Üns**********')).toBeVisible(); // satış tam adı görmez
  await sales.goto(`/siparisler/${ids.a}`);
  await expect(sales.getByText('Ünsal Cam', { exact: true })).toHaveCount(0);
  await expect(sales.getByText('Sıradaki adım: Çizim Ekibine Gönder · Teklife Gönder')).toBeVisible();
  await expect(sales.getByRole('button', { name: 'Beklemeye Al' })).toBeVisible();
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.getByText('Çizim gerekmiyor olarak işaretlendi.')).toBeVisible();
  await expect(sales.getByLabel('Açıklama').first()).toHaveValue(GLASS);
  await fillOffer(sales);
  await expect(sales.locator('.offer-table tfoot')).toContainText('249,00 EUR');
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  await expect(sales.getByText('Otomatik üretime geçmesi için bekleniyor:')).toBeVisible();
  await expect(sales.getByText('Teklif yönetici onayında')).toBeVisible();
  await expect(sales.getByRole('button', { name: /üretime/i })).toHaveCount(0); // elle üretime alma yok

  // Müşteri, yönetici onaylamadan teklifi göremez
  await cust.goto(`/siparisler/${ids.a}`);
  await expect(cust.getByRole('heading', { name: 'Teklifiniz' })).toHaveCount(0);

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto('/teklifler');
  await expect(admin.locator('.card', { hasText: 'Yönetici onayında' }).getByRole('link', { name: 'UNS1' })).toBeVisible();
  await admin.goto(`/siparisler/${ids.a}`);
  await expect(admin.getByText('Ünsal Cam').first()).toBeVisible(); // yönetici tam adı görür
  await admin.fill('#sandikEtiket', 'SB-M');
  // İki kademeli fiyat (karar 4): yönetici müşteri fiyatını girer; satış fiyatı yanında salt okunur
  await admin.getByLabel('Müşteri fiyatı').first().fill('41,5');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  // Çizim gerekmediği için fiyat onayıyla sipariş otomatik olarak üretime geçer
  await expect(admin.getByText('sipariş otomatik olarak üretime alındı')).toBeVisible();
  await expect(admin.getByText('Otomatik olarak üretime alındı').first()).toBeVisible(); // hareketler

  // Müşteri teklifi görür ama onaylamaz
  await cust.goto(`/siparisler/${ids.a}`);
  await expect(cust.getByRole('heading', { name: 'Teklifiniz' })).toBeVisible();
  await expect(cust.locator('#teklif tfoot')).toContainText('249,00 EUR');
  await expect(cust.getByRole('button', { name: /onayla/i })).toHaveCount(0);
  await cust.goto('/teklifler');
  await expect(cust.getByRole('link', { name: 'UNS1' })).toBeVisible();
  await expect(cust.getByText('249,00 EUR')).toBeVisible();

  await cust.goto(`/siparisler/${ids.a}`);
  await expect(cust.getByText('Onaylandı, üretimde').first()).toBeVisible();

  // Satış yükler ve arşivler
  await sales.goto(`/siparisler/${ids.a}`);
  await sales.getByRole('button', { name: 'Yüklendi olarak işaretle' }).click();
  await expect(sales.getByText('Sipariş yüklendi olarak işaretlendi.')).toBeVisible();
  await sales.getByRole('button', { name: 'Arşivle' }).click();
  await expect(sales.getByText('Sipariş arşivlendi.')).toBeVisible();

  await cust.goto('/siparisler?view=archive');
  await expect(cust.getByRole('link', { name: 'UNS1' })).toBeVisible();
});

test('çizim yolu: çizim ve teklif paralel; müşterideki teklifi yönetici günceller; çizim onayıyla otomatik üretim', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  ids.b = await newOrder(cust, 'Merdiven korkuluğu', 'korkuluk.pdf');

  const sales = await as(browser, SALES, PW);
  await sales.goto(`/siparisler/${ids.b}`);
  await sales.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(sales.getByText('Sipariş çizim ekibine yönlendirildi.')).toBeVisible();

  // Satış, çizim beklemeden teklifi yazar
  await fillOffer(sales);
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${ids.b}`);
  // İki kademeli fiyat (karar 4): yönetici müşteri fiyatını girer; satış fiyatı yanında salt okunur
  await admin.getByLabel('Müşteri fiyatı').first().fill('41,5');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText('Fiyat onaylandı; teklif müşterinin panelinde.')).toBeVisible();

  // Teklif müşteride ama çizim bitmediği için üretime geçmez
  await expect(admin.getByText('otomatik olarak üretime alındı')).toHaveCount(0);
  await sales.goto(`/siparisler/${ids.b}`);
  await expect(sales.getByText('Çizim henüz tamamlanmadı')).toBeVisible();
  await cust.goto(`/siparisler/${ids.b}`);
  await expect(cust.getByRole('heading', { name: 'Teklifiniz' })).toBeVisible();
  await expect(cust.getByText('Çizim hazırlanıyor').first()).toBeVisible();

  const drawer = await as(browser, DRAWER, PW);
  await expect(drawer.getByRole('heading', { name: 'Çizim Paneli' })).toBeVisible();
  // Tek çizimci olduğu için iş kendiliğinden ona atandı: "Çizilecekler" ve "Benim çizimlerim"de görünür, üstlenmeye gerek yok
  await expect(drawer.locator('.card', { hasText: 'Yapılacak çizimler' }).getByRole('link', { name: 'UNS2' })).toBeVisible();
  await expect(drawer.locator('.card', { hasText: 'Benim çizimlerim' }).getByRole('link', { name: 'UNS2' })).toBeVisible();
  const hidden = await drawer.goto(`/siparisler/${ids.a}`); // çizimsiz sipariş çizim ekibine görünmez
  expect(hidden?.status()).toBe(404);

  await drawer.goto(`/siparisler/${ids.b}`);
  await expect(drawer.getByRole('button', { name: 'Çizimi üstlen' })).toHaveCount(0);
  // 1. adım: dosyalar taslağa (birden çok dosya, müşteri notu); müşteri henüz görmez
  await drawer.setInputFiles('#drawing-file', [sampleFile('korkuluk-v1.dxf', 'dxf v1'), sampleFile('korkuluk-v1.pdf', 'pdf v1')]);
  await drawer.fill('#d-note-c', 'Ölçüler sahadan alındı');
  await drawer.fill('#d-note-i', 'iç: müşteri telefonda onay verdi');
  await drawer.getByRole('button', { name: 'Taslağa yükle' }).click();
  await expect(drawer.getByText('Dosyalar taslağa eklendi.')).toBeVisible();
  await expect(drawer.getByText('Taslak v1 — müşteri henüz görmüyor')).toBeVisible();
  await cust.goto(`/siparisler/${ids.b}`);
  await expect(cust.locator('a[href^="/dosya/cizim/"]')).toHaveCount(0);
  await expect(cust.getByText('Onayınız bekleniyor')).toHaveCount(0);
  await expect(drawer.getByRole('link', { name: 'Kontrol Et' })).toBeVisible(); // göndermeden önce müşterinin göreceği hâliyle kontrol
  // 2. adım: "Kontrol Et" ekranındaki "Müşteriye gönder" → "emin misiniz?" onayı (as() onay pencerelerini kabul eder)
  await sendDrawing(drawer, ids.b);

  await cust.goto(`/siparisler/${ids.b}`);
  await expect(cust.getByText('Ölçüler sahadan alındı')).toBeVisible();
  await expect(cust.getByText('iç: müşteri telefonda onay verdi')).toHaveCount(0); // iç not müşteriye gitmez
  await expect(cust.getByText('Onayınız bekleniyor').first()).toBeVisible();
  const href = await cust.locator('.file-row', { hasText: 'korkuluk-v1.dxf' }).locator('a[href^="/dosya/cizim/"]').first().getAttribute('href');
  ids.drawing = href!.split('/').pop();
  const dl = await cust.request.get(href!);
  expect(dl.status()).toBe(200);
  expect(await dl.text()).toContain('dxf v1');
  // "Revizyon iste" → çizim görüntüleyici: numaralı not zorunlu (boşken gönderilemez — karar 162)
  await cust.getByRole('link', { name: 'Revizyon iste' }).click();
  await expect(cust).toHaveURL(/\/cizim\/[a-z0-9]+\?revizyon=1$/);
  await expect(cust.getByRole('button', { name: 'Revizyon iste' })).toBeDisabled();
  await cust.getByLabel('Madde 1', { exact: true }).fill('Korkuluk yüksekliği 1100 mm olmalı');
  await cust.getByRole('button', { name: 'Revizyon iste' }).click();
  await expect(cust.getByText('Revizyon talebiniz çizim ekibine iletildi.')).toBeVisible();

  await drawer.goto(`/siparisler/${ids.b}`);
  await expect(drawer.getByText('Korkuluk yüksekliği 1100 mm olmalı').first()).toBeVisible();
  // Yalnızca DXF ile gönderilemez: müşterinin açabileceği PDF / JPG / PNG şart (teknik dosya ek olarak kalır)
  await drawer.setInputFiles('#drawing-file', sampleFile('korkuluk-v2.dxf', 'dxf v2'));
  await drawer.getByRole('button', { name: 'Taslağa yükle' }).click();
  await expect(drawer.locator('.drawing-next')).toContainText('en az bir PDF, JPG ya da PNG');
  await drawer.getByRole('link', { name: 'Kontrol Et' }).click();
  await expect(drawer.getByRole('button', { name: 'Müşteriye gönder' })).toBeDisabled();
  await expect(drawer.locator('.viewer-decide')).toContainText('en az bir PDF, JPG ya da PNG');
  await drawer.goto(`/siparisler/${ids.b}`);
  await uploadDrawing(drawer, [sampleFile('korkuluk-v2.pdf', 'pdf v2')]);
  await sendDrawing(drawer, ids.b);
  await expect(drawer.getByText('v2 · güncel')).toBeVisible();
  await expect(drawer.locator('.drawing-version', { hasText: 'korkuluk-v2.pdf' })).toContainText('korkuluk-v2.dxf');

  await sales.goto(`/siparisler/${ids.b}`);
  await expect(sales.getByText('Çizim müşteri onayında')).toBeVisible();

  // Teklif müşterideyken gelen revize çizim: satış teklifi değiştiremez, yöneticiye haber vermesi istenir
  await expect(sales.getByText('Teklif müşteriye gönderildikten sonra revize çizim yüklendi')).toBeVisible();
  await expect(sales.getByText('sistem yöneticisine haber verin')).toBeVisible();
  await expect(sales.getByRole('link', { name: 'Teklifi güncelle' })).toHaveCount(0);
  await expect(sales.locator('.offer-table')).toHaveCount(0);
  await expect(sales.getByRole('button', { name: /Geri Al/ })).toHaveCount(0);

  // Yönetici: listede "Teklif kontrolü" altında görür, teklifi günceller; müşteri yeni fiyatı hemen görür
  await admin.goto('/siparisler');
  await expect(admin.locator('.card', { hasText: 'Teklif kontrolü' }).getByRole('link', { name: 'UNS2' })).toBeVisible();
  await admin.goto(`/siparisler/${ids.b}`);
  await admin.getByRole('link', { name: 'Teklifi güncelle' }).first().click();
  await expect(admin.getByText('Müşterideki teklifi güncelliyorsunuz.')).toBeVisible();
  await admin.getByLabel('Müşteri fiyatı').first().fill('50');
  await expect(admin.locator('.offer-table tfoot')).toContainText('300,00 EUR');
  await admin.fill('#updateNote', 'v2 çizime göre');
  await admin.getByRole('button', { name: 'Teklifi güncelle ve müşteriye gönder' }).click();
  await expect(admin.locator('.alert-ok')).toContainText('Teklif güncellendi; müşteri yeni sürümü görüyor.');
  await expect(admin.locator('.timeline')).toContainText('v2 çizime göre');
  await expect(admin.getByText('Teklif müşteriye gönderildikten sonra revize çizim yüklendi')).toHaveCount(0);
  await expect(admin.getByText('sürüm 2', { exact: true })).toBeVisible();
  await expect(admin.getByText('otomatik olarak üretime alındı')).toHaveCount(0); // çizim hâlâ müşteride
  await admin.goto('/siparisler');
  await expect(admin.locator('.card', { hasText: 'Teklif kontrolü' }).getByRole('link', { name: 'UNS2' })).toHaveCount(0);

  await cust.goto(`/siparisler/${ids.b}`);
  await expect(cust.locator('#teklif tfoot')).toContainText('300,00 EUR');
  await expect(cust.locator('.timeline')).toContainText('Teklifiniz güncellendi');
  await expect(cust.locator('.timeline')).not.toContainText('v2 çizime göre'); // iç not müşteriye gitmez
  await cust.goto('/teklifler');
  await expect(cust.getByText('300,00 EUR')).toBeVisible();
  await cust.goto(`/siparisler/${ids.b}`);

  // Müşteri çizimi onaylar → teklif de müşteride olduğu için otomatik üretim
  await cust.getByRole('button', { name: 'Bu çizimi onayla' }).click();
  await expect(cust.getByText('Teklifiniz de hazır olduğu için siparişiniz üretime alındı.')).toBeVisible();
  await expect(cust.getByText('Onaylandı, üretimde').first()).toBeVisible();

  await sales.goto('/siparisler?view=all');
  const row = sales.locator('tr', { hasText: 'UNS2' });
  await expect(row.getByText('Üretimde')).toBeVisible();
  await expect(row.getByText('v2 · 1 tur')).toBeVisible();
});

test('beklemedeki sipariş otomatik üretime geçmez; beklemeden çıkınca geçer', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Vitrin camı', 'vitrin.pdf');
  const sales = await as(browser, SALES, PW);
  await sales.goto(`/siparisler/${id}`);
  await sales.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await fillOffer(sales);
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${id}`);
  // İki kademeli fiyat (karar 4): yönetici müşteri fiyatını girer; satış fiyatı yanında salt okunur
  await admin.getByLabel('Müşteri fiyatı').first().fill('41,5');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText('Fiyat onaylandı; teklif müşterinin panelinde.')).toBeVisible();
  const drawer = await as(browser, DRAWER, PW);
  await drawer.goto(`/siparisler/${id}`);
  await uploadDrawing(drawer, [sampleFile('vitrin.dxf', 'dxf'), sampleFile('vitrin.pdf', 'pdf')]);
  await sendDrawing(drawer, id);

  await sales.goto(`/siparisler/${id}`);
  await sales.getByRole('button', { name: 'Beklemeye Al' }).click();
  await expect(sales.getByText('Sipariş beklemeye alındı.')).toBeVisible();

  await cust.goto(`/siparisler/${id}`);
  await cust.getByRole('button', { name: 'Bu çizimi onayla' }).click();
  await expect(cust.getByText('Çizimi onayladınız. Teşekkürler.')).toBeVisible();
  await expect(cust.getByText('Onaylandı, üretimde')).toHaveCount(0);

  await sales.goto(`/siparisler/${id}`);
  await sales.getByRole('button', { name: 'Beklemeden çıkar' }).click();
  await expect(sales.locator('.alert-ok')).toContainText('otomatik olarak üretime alındı');
});

test('satış kararını geri alır; teklif yöneticiye gidince satış değişiklik yapamaz', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Balkon camı', 'balkon.pdf');
  const sales = await as(browser, SALES, PW);
  await sales.goto(`/siparisler/${id}`);
  await sales.getByRole('button', { name: 'Çizim Ekibine Gönder' }).click();
  await expect(sales.getByText('Sipariş çizim ekibine yönlendirildi.')).toBeVisible();
  await fillOffer(sales);
  await sales.getByRole('button', { name: 'Taslak olarak kaydet' }).click();
  await expect(sales.getByText('Teklif taslak olarak kaydedildi.')).toBeVisible();

  await sales.getByRole('button', { name: 'Çizime Göndermeyi Geri Al' }).click();
  await expect(sales.getByText('Çizime gönderme geri alındı.')).toBeVisible();
  await expect(sales.getByText('Sıradaki adım: Çizim Ekibine Gönder · Teklife Gönder')).toBeVisible();
  const drawer = await as(browser, DRAWER, PW);
  expect((await drawer.goto(`/siparisler/${id}`))?.status()).toBe(404); // çizim işi çizim ekibinden kalktı

  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.getByText('Çizim gerekmiyor olarak işaretlendi.')).toBeVisible();
  await expect(sales.locator('.offer-table tfoot')).toContainText('249,00 EUR'); // taslak korundu
  await sales.getByRole('button', { name: 'Teklife Göndermeyi Geri Al' }).click();
  await expect(sales.getByText('Teklife gönderme geri alındı.')).toBeVisible();

  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  await expect(sales.getByRole('button', { name: /Geri Al/ })).toHaveCount(0);
  await expect(sales.getByRole('button', { name: 'Çizim Ekibine Gönder' })).toHaveCount(0);
  await expect(sales.locator('.offer-table')).toHaveCount(0);
});

test('teklifte CNC ve delik alt satırları; fiyatsız satırla teklif gönderilemez', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Mutfak dolap camı', 'dolap.pdf');
  const sales = await as(browser, SALES, PW);
  await sales.goto(`/siparisler/${id}`);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.getByText('Çizim gerekmiyor olarak işaretlendi.')).toBeVisible();
  await fillOffer(sales);
  // CNC / delik TEK bir cama aittir (karar 113): 3 adetlik satırdan bir cam ayrılır (2 + 1) ve işlem ayrılan cama eklenir
  await sales.getByRole('button', { name: '+CNC' }).click();
  await expect(sales.getByText('Cam ayrıldı')).toBeVisible();
  const qty = sales.getByLabel('Adet', { exact: true });
  await expect(qty).toHaveCount(2);
  await expect(qty.nth(0)).toHaveValue('2');
  await expect(qty.nth(1)).toHaveValue('1');
  await expect(qty.nth(1)).toHaveAttribute('readonly', ''); // işlemli cam tek adettir
  await expect(sales.getByLabel('Birim fiyat', { exact: true }).nth(1)).toHaveValue('41,5'); // birim fiyat ayrılan camda aynı
  // Tek adetlik cama +Delik: yeniden ayrılmaz, delik aynı cama eklenir
  await sales.getByRole('button', { name: '+Delik' }).nth(1).click();
  await expect(qty).toHaveCount(2);
  await expect(sales.getByText('2 satırın fiyatı boş: 2. CNC, 2. Delik')).toBeVisible();
  await expect(sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' })).toBeDisabled();

  await sales.getByLabel('CNC açıklaması').fill('Kulp yuvası');
  await sales.getByLabel('CNC adedi').fill('2');
  await sales.getByLabel('CNC fiyatı').fill('15');
  await sales.getByLabel('Delik adedi').fill('4');
  await sales.locator('tr.sub-line', { hasText: 'Delik' }).getByRole('button', { name: 'bedelsiz' }).click();
  await expect(sales.locator('.offer-table tfoot')).toContainText('3 cam · 2 CNC · 4 delik');
  await expect(sales.locator('.offer-table tfoot')).toContainText('279,00 EUR'); // 249 + 2 × 15, delik bedelsiz (ayırma tutarı değiştirmez)
  if (process.env.SCREENSHOT_DIR) {
    await sales.setViewportSize({ width: 1440, height: 900 });
    await sales.locator('.offer-table').scrollIntoViewIfNeeded();
    await sales.screenshot({ path: `${process.env.SCREENSHOT_DIR}/masaustu-teklif-islem-tek-cam.png`, fullPage: true });
  }
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();
  const view = sales.locator('#teklif');
  await expect(view.locator('tr.sub-line', { hasText: 'Kulp yuvası' })).toContainText('CNC');
  await expect(view.locator('tr.sub-line', { hasText: 'Delik' })).toContainText('bedelsiz');
  await expect(view.locator('tfoot')).toContainText('279,00 EUR');
});

test('notlar: iç not müşteriye görünmez', async ({ browser }) => {
  const sales = await as(browser, SALES, PW);
  await sales.goto(`/siparisler/${ids.b}`);
  await sales.getByLabel('Not', { exact: true }).fill('Müşteriyle fiyatı telefonda konuştuk');
  await sales.locator('input[name=internal]').check();
  await sales.getByRole('button', { name: 'Gönder', exact: true }).click();
  await expect(sales.getByText('Not eklendi.')).toBeVisible();
  await sales.getByLabel('Not', { exact: true }).fill('Teklifiniz bugün hazır olacak');
  await sales.getByRole('button', { name: 'Gönder', exact: true }).click();

  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/siparisler/${ids.b}`);
  await expect(cust.getByText('Teklifiniz bugün hazır olacak')).toBeVisible();
  await expect(cust.getByText('Müşteriyle fiyatı telefonda konuştuk')).toHaveCount(0);
});

test('izolasyon: başka firmanın müşterisi siparişi ve dosyayı göremez', async ({ browser }) => {
  const beta = await as(browser, BETA, PW);
  await expect(beta.getByText('UNS1')).toHaveCount(0);
  const res = await beta.goto(`/siparisler/${ids.b}`);
  expect(res?.status()).toBe(404);
  const dl = await beta.request.get(`/dosya/cizim/${ids.drawing}`);
  expect(dl.status()).toBe(404);
  await beta.goto('/siparisler/yeni?tip=GLASS_ORDER');
  await expect(beta.getByText('BET1')).toBeVisible();

  // Giriş yapmamış biri dosya indiremez
  const ctx = await browser.newContext();
  const anon = await ctx.request.get(`/dosya/cizim/${ids.drawing}`);
  expect(anon.status()).toBe(401);
});
