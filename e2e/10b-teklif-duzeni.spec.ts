import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, GLASS, TEAM_PW, as, newOrder } from './helpers';

const SALES = 'fiyat-satis@e2e.test'; // 08'de açıldı (05'te satis@e2e.test bilerek kilitlendi)

// Görünüm 3. aşama: sipariş sayfasının bölüm sırası (dosyalar → notlar → sipariş bilgileri → teklif) ve teklif
// tablosunun araçları (aynı camdan "+", sandık parası, tek fiyat, tabloyu temizle). İş kuralları değişmedi.
test('sipariş sayfası: bölüm sırası ve teklif tablosu araçları', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Düzen', 'duzen.pdf'); // siparişte 3 adet cam
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${id}`);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.locator('.offer-table')).toBeVisible();

  // Satış: işlemler → müşteri dosyaları → notlar → sipariş bilgileri → teklif tablosu; "İstenen camlar" ve "Sandıklar" yok
  const order = async (page: typeof sales) => {
    const heads = await page.locator('main h2').allTextContents();
    return (h: string) => heads.findIndex((x) => x.includes(h));
  };
  let pos = await order(sales);
  expect(pos('Müşteri sipariş dosyaları')).toBeGreaterThanOrEqual(0);
  expect(pos('Müşteri sipariş dosyaları')).toBeLessThan(pos('Notlar'));
  expect(pos('Notlar')).toBeLessThan(pos('Sipariş bilgileri'));
  expect(pos('Sipariş bilgileri')).toBeLessThan(pos('Teklif tablosu'));
  expect(pos('Sandıklar')).toBe(-1);
  await expect(sales.getByText('İstenen camlar')).toHaveCount(0);

  // Aynı camdan "+": hemen altına, aynı cam adıyla yeni satır
  const desc = sales.getByLabel('Açıklama', { exact: true });
  const price = sales.getByLabel('Birim fiyat', { exact: true });
  await expect(desc).toHaveCount(1);
  await sales.getByRole('button', { name: 'Aynı camdan yeni satır ekle' }).click();
  await expect(desc).toHaveCount(2);
  await expect(desc.nth(1)).toHaveValue(GLASS);
  // CNC tek adetlik (yeni eklenen) cam satırına: 3 adetlik satırdan cam ayrılmaz (ayırma 02'de sınanır)
  await sales.getByRole('button', { name: '+CNC' }).nth(1).click();
  await sales.getByLabel('CNC fiyatı').fill('15');

  // "Tek fiyatı tüm satırlara uygula": işaretliyken m² cam satırlarının hepsine; CNC satırı değişmez
  await sales.getByLabel('Tek fiyatı tüm satırlara uygula').check();
  await price.first().fill('44');
  await expect(price.nth(1)).toHaveValue('44');
  await expect(sales.getByLabel('CNC fiyatı')).toHaveValue('15');
  await sales.getByLabel('Tek fiyatı tüm satırlara uygula').uncheck();
  await price.nth(1).fill('40');
  await expect(price.first()).toHaveValue('44');

  // "+ Sandık parası": adetle fiyatlanan normal satır
  await sales.getByRole('button', { name: /Sandık parası/ }).click();
  await expect(desc.nth(2)).toHaveValue('Sandık parası');

  // "Tabloyu temizle" (onaylı): tablo siparişteki ilk hâline döner; kaydedilmedikçe hiçbir şey yazılmaz
  await sales.getByRole('button', { name: 'Tabloyu temizle' }).click();
  await expect(desc).toHaveCount(1);
  await expect(desc.first()).toHaveValue(GLASS);
  await expect(sales.getByLabel('Adet', { exact: true })).toHaveValue('3');
  await expect(sales.getByLabel('CNC fiyatı')).toHaveCount(0);

  // Yönetici: aynı sıra; "İstenen camlar" sipariş bilgilerinde durur
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${id}`);
  pos = await order(admin);
  expect(pos('Müşteri sipariş dosyaları')).toBeLessThan(pos('Notlar'));
  expect(pos('Notlar')).toBeLessThan(pos('Sipariş bilgileri'));
  await expect(admin.getByText('İstenen camlar')).toBeVisible();
});

// Yönetici fiyat tablosunda aynı araç: müşteri fiyatı (satış fiyatı / maliyet değişmez); kural satıştakiyle aynı.
test('yönetici: "Tek fiyatı tüm satırlara uygula" müşteri fiyatını yalnızca m² cam satırlarına yazar; CNC ve sandık parası değişmez', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Tek fiyat yönetici', 'tekfiyat.pdf'); // siparişte 3 adet cam
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${id}`);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.locator('.offer-table')).toBeVisible();
  // Satış: iki cam satırı (ikincisinde CNC) + sandık parası; satış fiyatları 30 / 30 / 15 / 20
  await sales.getByRole('button', { name: 'Aynı camdan yeni satır ekle' }).click();
  const en = sales.getByLabel('En', { exact: true });
  const boy = sales.getByLabel('Boy', { exact: true });
  await en.nth(0).fill('1000');
  await boy.nth(0).fill('2000');
  await en.nth(1).fill('500');
  await boy.nth(1).fill('1000');
  await sales.getByRole('button', { name: '+CNC' }).nth(1).click();
  await sales.getByLabel('CNC fiyatı').fill('15');
  await sales.getByRole('button', { name: /Sandık parası/ }).click();
  const unit = sales.getByLabel('Birim fiyat', { exact: true });
  await expect(unit).toHaveCount(3);
  await unit.nth(0).fill('30');
  await unit.nth(1).fill('30');
  await unit.nth(2).fill('20');
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${id}`);
  const offer = admin.getByLabel('Müşteri fiyatı', { exact: true }); // cam, cam, sandık parası
  const cnc = admin.getByLabel('CNC müşteri fiyatı');
  await expect(offer).toHaveCount(3);
  await cnc.fill('18');
  await offer.nth(2).fill('25');
  // Araç tablonun altında, satıştakiyle aynı yerde ve aynı adla; işaretli gelmez
  const one = admin.locator('.offer-tools').getByLabel('Tek fiyatı tüm satırlara uygula');
  await expect(one).not.toBeChecked();
  await one.check();
  await offer.nth(0).fill('52,5');
  await expect(offer.nth(1)).toHaveValue('52,5'); // öbür m² cam satırı
  await expect(cnc).toHaveValue('18'); // CNC değişmez
  await expect(offer.nth(2)).toHaveValue('25'); // sandık parası (adetli satır) değişmez
  // İşaretliyken CNC satırına yazılan fiyat yalnızca o satıra yazılır
  await cnc.fill('19');
  await expect(offer.nth(0)).toHaveValue('52,5');
  await expect(offer.nth(2)).toHaveValue('25');
  // İşaret kaldırılınca yalnızca yazılan satır değişir
  await one.uncheck();
  await offer.nth(1).fill('50');
  await expect(offer.nth(0)).toHaveValue('52,5');
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText(/Fiyat onaylandı|üretime alındı/).first()).toBeVisible();

  // Kayıt (sunucu): müşteri fiyatları yazıldığı gibi; satış fiyatları (maliyet) hiç değişmedi
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const sent = await db.offer.findFirstOrThrow({ where: { orderId: id, status: 'GONDERILDI' }, orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
  await db.$disconnect();
  expect(sent.lines.map((l) => [l.kind, l.unit, Number(l.unitPrice), Number(l.offerPrice)])).toEqual([
    ['CAM', 'm2', 30, 52.5], ['CAM', 'm2', 30, 50], ['CNC', 'adet', 15, 19], ['CAM', 'adet', 20, 25],
  ]);
  // Satış müşteri fiyatını yine görmez
  const html = await (await sales.request.get(`/siparisler/${id}`)).text();
  expect(html).not.toMatch(/"offerPrice":"?5[02]/);
  expect(html).not.toContain('52,50');
});
