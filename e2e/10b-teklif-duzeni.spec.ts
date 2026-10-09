import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, GLASS, TEAM_PW, as, newOrder } from './helpers';

const SALES = 'fiyat-satis@e2e.test'; // 08'de açıldı (05'te satis@e2e.test bilerek kilitlendi)

// Görünüm 3. aşama: sipariş sayfasının bölüm sırası (dosyalar → notlar → sipariş bilgileri → teklif) ve teklif
// tablosunun araçları (aynı camdan "+", tek fiyat, tabloyu temizle). Yöneticinin sandık bedeli satışa görünmez (fonksiyonel
// paket 4); satışın "+ Sandık parası" düğmesi yöneticininkiyle aynı yerde, satışın kendi (görünen) satırını ekler (karar 214).
test('sipariş sayfası: bölüm sırası ve teklif tablosu araçları', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Düzen', 'duzen.pdf'); // müşteri formunda cam adedi yok (karar 160): tablo 1 adetle açılır
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
  // CNC tek adetlik (yeni eklenen) cam satırına: cam ayrılmaz (ayırma 02'de sınanır)
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

  // "+ Sandık parası" (karar 214): tablonun altında, "+ Cam ekle"nin yanında — satışın kendi satırı; cam satırının altında
  // sandık düğmesi yok. Yöneticinin sandık bedeli satışa hiç gelmez (e2e 38, 45)
  await expect(sales.locator('.offer-tools').getByRole('button', { name: '+ Sandık parası' })).toHaveCount(1);
  await expect(sales.locator('.offer-table').getByRole('button', { name: /Sandık/ })).toHaveCount(0);

  // Olağan "+" yalnızca cam cinsini çoğaltır (fonksiyonel paket 1): CNC'li camın "+"ı yeni satıra işlemi KOPYALAMAZ; ölçü
  // de taşımaz. İşlemleriyle birlikte kopyalayan ayrı düğme "+ aynısı"dır; telafi camındaki "işlemleri taşı" kuralı da ayrıdır.
  await sales.getByRole('button', { name: 'Aynı camdan yeni satır ekle' }).nth(1).click();
  await expect(desc).toHaveCount(3);
  await expect(desc.nth(2)).toHaveValue(GLASS); // CNC'li camın (ve CNC satırının) hemen altında
  await expect(sales.getByLabel('CNC fiyatı')).toHaveCount(1);
  await expect(sales.locator('.offer-table tr.sub-line')).toHaveCount(1);
  await expect(sales.getByLabel('En', { exact: true }).nth(2)).toHaveValue('');

  // "Tabloyu temizle" (onaylı): tablo siparişteki ilk hâline döner; kaydedilmedikçe hiçbir şey yazılmaz
  await sales.getByRole('button', { name: 'Tabloyu temizle' }).click();
  await expect(desc).toHaveCount(1);
  await expect(desc.first()).toHaveValue(GLASS);
  await expect(sales.getByLabel('Adet', { exact: true })).toHaveValue('1'); // siparişte adet yok → 1 (karar 160)
  await expect(sales.getByLabel('CNC fiyatı')).toHaveCount(0);

  // Yönetici: aynı sıra; "İstenen camlar" ve "Sandıklar" yöneticinin sipariş ekranında da yok (fonksiyonel paket 4)
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${id}`);
  pos = await order(admin);
  expect(pos('Müşteri sipariş dosyaları')).toBeLessThan(pos('Notlar'));
  expect(pos('Notlar')).toBeLessThan(pos('Sipariş bilgileri'));
  await expect(admin.locator('#bilgiler')).toBeVisible();
  await expect(admin.getByText('İstenen camlar')).toHaveCount(0);
  expect(pos('Sandıklar')).toBe(-1);
});

// Yönetici fiyat tablosunda aynı araç: müşteri fiyatı (satış fiyatı / maliyet değişmez); kural satıştakiyle aynı.
test('yönetici: "Tek fiyatı tüm satırlara uygula" müşteri fiyatını yalnızca m² cam satırlarına yazar; CNC ve yöneticinin sandık bedeli değişmez', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Tek fiyat yönetici', 'tekfiyat.pdf'); // siparişte 3 adet cam
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${id}`);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await expect(sales.locator('.offer-table')).toBeVisible();
  // Satış: iki cam satırı (ikincisinde CNC); satış fiyatları 30 / 30 / 15. Satışın "+ Sandık parası" düğmesi var (karar 214)
  // ama bu testte kullanılmaz; yöneticinin sandık bedeli ayrı ve satışa görünmez (Paket 4).
  await sales.getByRole('button', { name: 'Aynı camdan yeni satır ekle' }).click();
  const en = sales.getByLabel('En', { exact: true });
  const boy = sales.getByLabel('Boy', { exact: true });
  await en.nth(0).fill('1000');
  await boy.nth(0).fill('2000');
  await en.nth(1).fill('500');
  await boy.nth(1).fill('1000');
  await sales.getByRole('button', { name: '+CNC' }).nth(1).click();
  await sales.getByLabel('CNC fiyatı').fill('15');
  await expect(sales.getByRole('button', { name: /Sandık parası/ })).toHaveCount(1);
  const unit = sales.getByLabel('Birim fiyat', { exact: true });
  await expect(unit).toHaveCount(2);
  await unit.nth(0).fill('30');
  await unit.nth(1).fill('30');
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${id}`);
  const offer = admin.getByLabel('Müşteri fiyatı', { exact: true }); // cam, cam (+ yöneticinin sandık bedeli)
  const cnc = admin.getByLabel('CNC müşteri fiyatı');
  await expect(offer).toHaveCount(2);
  // Sandık bedeli: yalnızca yöneticinin tablosunda; "satış görmez" rozetli, ölçüsüz, adetli satır
  await admin.getByRole('button', { name: /Sandık parası/ }).click();
  await expect(offer).toHaveCount(3);
  await expect(admin.locator('.offer-table [data-crate-fee]')).toHaveCount(1);
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
  expect(sent.lines.map((l) => [l.kind, l.unit, Number(l.unitPrice), Number(l.offerPrice), l.crateFee])).toEqual([
    ['CAM', 'm2', 30, 52.5, false], ['CAM', 'm2', 30, 50, false], ['CNC', 'adet', 15, 19, false], ['CAM', 'adet', 0, 25, true],
  ]);
  // Satış müşteri fiyatını yine görmez; yöneticinin sandık bedeli satırını hiç almaz
  const html = await (await sales.request.get(`/siparisler/${id}`)).text();
  expect(html).not.toMatch(/"offerPrice":"?5[02]/);
  expect(html).not.toContain('52,50');
  expect(html).not.toContain('data-crate-fee');
  expect(html).not.toMatch(/\\?"crateFee\\?":\s*true/);
  await sales.goto(`/siparisler/${id}`);
  await expect(sales.locator('#teklif')).toBeVisible();
  await expect(sales.locator('#teklif')).not.toContainText('Sandık parası');
  await expect(sales.locator('#teklif tbody tr')).toHaveCount(3); // cam, cam, CNC — sandık bedeli satırı yok
});
