import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, DRAWER, INSPECTOR_PW, TEAM_PW, as, fillOffer, firmWithOrder, newOrder, openFirm } from './helpers';

// Fonksiyonel paket 4 — yönetici paneli:
//  - sandık bedeli yalnızca yöneticinin satırıdır: yöneticinin ve müşterinin teklifinde görünür ve toplama girer; satış
//    görmez (sayfanın ham yanıtında da yok); teklif müşteriye gidince bildirim yalnızca müşteriye (satışa zil yok)
//  - yöneticinin sipariş ekranında "İstenen camlar" ve "Sandıklar" bölümü yok; sandık kaydı ve Yüklemeler görünümü değişmez
//  - müşterideki teklifin fiyatı: yeni sürüm (eski sürüm durur), müşteri yeni fiyatı ancak açık gönderimden sonra görür,
//    değişiklik yöneticinin "Hareketler"inde (kim, ne zaman, sürüm, eski → yeni); satış görmez
//  - mali kilit: FGO belgesi kesilmiş siparişte "Teklifi güncelle" yerine gerekçe; sipariş silinmez (1. adımda neden)
//  - siparişi silme: yalnızca yönetici; iki aşama (sipariş no + sonuç → numarayı yazarak ayrı onay); "Vazgeç" her adımda;
//    sunucu yazılan numarayı ayrıca denetler
// FGO bu veritabanında KAPALIDIR: belge kaydı test verisi olarak doğrudan yazılır ve sonda silinir; FGO'ya istek gitmez.
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı (satis@e2e.test 05'te bilerek kilitleniyor)
const INSPECTOR = 'denetim@e2e.test';
let orderId = '';
let orderNo = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('sandık bedeli yöneticinin satırıdır: yönetici ve müşteri görür, toplama girer; satış görmez; teklif bildirimi yalnızca müşteriye', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  orderId = await newOrder(cust, 'Yönetici paneli', 'yonetici-paneli.pdf');
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${orderId}`);
  await sales.getByRole('button', { name: 'Teklife Gönder', exact: true }).click();
  await fillOffer(sales, '40'); // 3 × 1000 × 2000 mm = 6 m² × 40 = 240 (satış tutarı)
  await expect(sales.getByRole('button', { name: /Sandık parası/ })).toHaveCount(0);
  await sales.getByRole('button', { name: 'Teklifi yöneticiye gönder' }).click();
  await expect(sales.getByText('Teklif sistem yöneticisinin onayına gönderildi.')).toBeVisible();

  // Yönetici: müşteri fiyatı + sandık bedeli; önce taslak — müşteri taslağı görmez
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${orderId}`);
  const price = admin.getByLabel('Müşteri fiyatı', { exact: true });
  await price.first().fill('50');
  await admin.getByRole('button', { name: /Sandık parası/ }).click();
  await expect(price).toHaveCount(2);
  await expect(admin.locator('.offer-table [data-crate-fee]')).toHaveText('Sandık bedeli · satış görmez');
  await price.nth(1).fill('25');
  await admin.getByRole('button', { name: 'Taslak olarak kaydet' }).click();
  await expect(admin.getByText('Teklif taslak olarak kaydedildi.')).toBeVisible();
  await cust.goto(`/siparisler/${orderId}`);
  await expect(cust.locator('#teklif')).toHaveCount(0);
  expect(await cust.content()).not.toContain('325,00');

  // Açık gönderim: müşteri sandık bedelini ve doğru toplamı görür (6 m² × 50 + 25 = 325)
  await admin.getByRole('button', { name: 'Fiyatı onayla ve müşteriye gönder' }).click();
  await expect(admin.getByText(/Fiyat onaylandı/).first()).toBeVisible();
  await expect(admin.locator('#teklif [data-crate-fee]')).toHaveCount(1);
  await expect(admin.locator('#teklif tfoot')).toContainText('325,00 EUR');
  await cust.goto(`/siparisler/${orderId}`);
  await expect(cust.locator('#teklif tbody')).toContainText('Sandık parası');
  await expect(cust.locator('#teklif tfoot')).toContainText('325,00 EUR');
  await expect(cust.locator('#teklif [data-crate-fee]')).toHaveCount(0); // "satış görmez" rozeti yalnızca yöneticide

  // Satış: sandık bedeli satırı yok; tutarı yalnızca cam (satış fiyatı); sayfanın ham yanıtında da yok
  await sales.goto(`/siparisler/${orderId}`);
  await expect(sales.locator('#teklif')).not.toContainText('Sandık parası');
  await expect(sales.locator('#teklif tbody tr')).toHaveCount(1);
  await expect(sales.locator('#teklif tfoot')).toContainText('240,00 EUR');
  const html = await (await sales.request.get(`/siparisler/${orderId}`)).text();
  expect(html).not.toContain('325,00');
  expect(html).not.toContain('data-crate-fee');
  expect(html).not.toMatch(/\\?"crateFee\\?":\s*true/);

  // Bildirim: teklif müşteriye gidince zil yalnızca müşteride; satışa (ve yöneticiye) teklif bildirimi yok
  const db = await prisma();
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  orderNo = order.orderNo;
  const notes = await db.notification.findMany({ where: { orderId, type: { in: ['ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED'] } }, include: { user: { select: { appRole: true, email: true } } } });
  expect(notes.length).toBeGreaterThan(0);
  expect(notes.filter((n) => n.user.appRole !== 'MUSTERI').map((n) => n.user.email)).toEqual([]);
  expect(notes.map((n) => n.user.email)).toContain(CUSTOMER);
  await db.$disconnect();
  await Promise.all([cust.context().close(), sales.context().close(), admin.context().close()]);
});

test('yöneticinin sipariş bilgileri sade: "İstenen camlar" ve "Sandıklar" yok; sandık kaydı ve Yüklemeler görünümü değişmez', async ({ browser }) => {
  const db = await prisma();
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const day = (order.actualShipDate ?? order.estimatedShipDate)!.toISOString().slice(0, 10);
  const crate = await db.crate.create({
    data: { shipDay: new Date(`${day}T00:00:00Z`), customerId: order.customerId, crateNo: 381, netAgirlik: '100', brutAgirlik: '130', orders: { create: { orderId } } },
  });
  const before = JSON.stringify(await db.crate.findUniqueOrThrow({ where: { id: crate.id }, include: { orders: true } }));

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${orderId}`);
  const info = admin.locator('#bilgiler');
  await expect(info).toBeVisible();
  await expect(info).toContainText(orderNo);
  await expect(admin.getByText('İstenen camlar')).toHaveCount(0);
  await expect(admin.locator('#sandik')).toHaveCount(0);
  // Sipariş bilgileri dikey düzende (etiket | değer satırları) kalır
  expect(await info.locator('dl.order-info > div').count()).toBeGreaterThanOrEqual(5);
  // Sandık kaydı değişmedi; Yüklemeler'de siparişin satırında sandık numarası görünür (sandık işlevleri yerinde)
  await admin.goto(`/yuklemeler?ay=${day.slice(0, 7)}&gun=${day}#gun`);
  const row = (await openFirm(firmWithOrder(admin, orderId))).locator(`tr[data-order="${orderId}"]`);
  await expect(row.locator('.crate-nos')).toContainText('#381');
  expect(JSON.stringify(await db.crate.findUniqueOrThrow({ where: { id: crate.id }, include: { orders: true } }))).toBe(before);
  // Denetimci (yönetici değil) sipariş bilgilerini eskisi gibi görür
  const insp = await as(browser, INSPECTOR, INSPECTOR_PW);
  await insp.goto(`/siparisler/${orderId}`);
  await expect(insp.locator('#sandik')).toBeVisible();
  await expect(insp.locator('#sandik')).toContainText('381');
  await db.$disconnect();
  await Promise.all([admin.context().close(), insp.context().close()]);
});

test('müşterideki teklifin fiyatı: yeni sürüm, eski sürüm durur; müşteri yeni fiyatı ancak açık gönderimden sonra görür; Hareketler\'de görünür, satışta yok', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await admin.goto(`/siparisler/${orderId}`);
  await admin.getByRole('link', { name: 'Teklifi güncelle' }).first().click();
  await expect(admin.getByText('Müşterideki teklifi güncelliyorsunuz.')).toBeVisible();
  const price = admin.getByLabel('Müşteri fiyatı', { exact: true });
  await expect(price).toHaveCount(2);
  await expect(admin.locator('.offer-table [data-crate-fee]')).toHaveCount(1);
  await price.first().fill('55');
  // Kaydedilmeden (gönderilmeden) müşteri eski fiyatı görür
  await cust.goto(`/siparisler/${orderId}`);
  await expect(cust.locator('#teklif tfoot')).toContainText('325,00 EUR');
  // Açık gönderim (onay penceresi — as() kabul eder): yeni sürüm müşteride
  await admin.getByRole('button', { name: 'Teklifi güncelle ve müşteriye gönder' }).click();
  await expect(admin.locator('.alert-ok')).toContainText('Teklif güncellendi; müşteri yeni sürümü görüyor.');
  await cust.reload();
  await expect(cust.locator('#teklif tfoot')).toContainText('355,00 EUR'); // 6 × 55 + 25

  // Yöneticinin "Hareketler"i: kim, ne zaman, teklif sürümü, satır satır eski → yeni ve toplam
  const v2 = admin.locator('li[data-price-change="2"]');
  await expect(v2).toContainText('Müşteri fiyatı değişti (teklif v2)');
  await expect(v2).toContainText('müşteriye gönderildi');
  await expect(v2).toContainText('50,00 EUR → 55,00 EUR');
  await expect(v2).toContainText('Toplam: 325,00 EUR → 355,00 EUR');
  await expect(v2).toContainText('E2E Yönetici');
  await expect(admin.locator('li[data-price-change="1"]', { hasText: 'taslak — müşteri görmez' })).toHaveCount(1);
  // Kayıt: iki gönderilmiş sürüm; eski sürümün fiyatları aynen durur; denetim kaydı yöneticinin
  const db = await prisma();
  const offers = await db.offer.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
  expect(offers.map((o) => [o.status, Number(o.offerAmount), Number(o.amount)])).toEqual([['GONDERILDI', 325, 240], ['GONDERILDI', 355, 240]]);
  expect(offers.map((o) => o.lines.map((l) => [Number(l.offerPrice), l.crateFee]))).toEqual([[[50, false], [25, true]], [[55, false], [25, true]]]);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'OFFER_PRICE_CHANGED', entityId: orderId, details: { path: ['version'], equals: 2 } }, include: { user: true } });
  expect(audit.user?.email).toBe(ADMIN);
  await db.$disconnect();
  // Satış: fiyat hareketi ve müşteri tutarı yok
  const sales = await as(browser, SALES, TEAM_PW);
  const html = await (await sales.request.get(`/siparisler/${orderId}`)).text();
  expect(html).not.toContain('data-price-change');
  expect(html).not.toContain('355,00');
  await Promise.all([admin.context().close(), cust.context().close(), sales.context().close()]);
});

test('mali kilit: FGO belgesi kesilmiş siparişte fiyat güncellenmez (gerekçe görünür) ve sipariş silinmez', async ({ browser }) => {
  const db = await prisma();
  const doc = await db.fgoDocument.create({ data: { orderId, kind: 'PROFORMA', series: 'E2E', number: '38001', issuedAt: new Date() } });
  try {
    const admin = await as(browser, ADMIN, ADMIN_PW);
    await admin.goto(`/siparisler/${orderId}`);
    const lock = admin.locator('#fiyat-kilidi');
    await expect(lock).toContainText('Fiyat değiştirilemez.');
    await expect(lock).toContainText('FGO belgesi kesildi: Proforma (E2E38001)');
    await expect(admin.getByRole('link', { name: 'Teklifi güncelle' })).toHaveCount(0);
    // Adresle açılmaya çalışılsa da düzenleyici açılmaz (asıl denetim sunucuda — update_offer: PRICE_LOCKED)
    await admin.goto(`/siparisler/${orderId}?teklif=guncelle`);
    await expect(admin.getByRole('button', { name: 'Teklifi güncelle ve müşteriye gönder' })).toHaveCount(0);
    await expect(admin.locator('#fiyat-kilidi')).toBeVisible();
    // Silme: 1. adımda sipariş numarası ve engel; "Devam et" yok; "Vazgeç" kapatır
    const box = admin.locator('#sil');
    await box.getByRole('button', { name: 'Siparişi sil' }).click();
    const step1 = box.locator('[data-remove-step="1"]');
    await expect(step1).toContainText(`Silinecek sipariş: ${orderNo}`);
    await expect(step1.locator('[data-remove-blocked]')).toContainText('Bu sipariş silinemez.');
    await expect(step1.locator('[data-remove-blocked]')).toContainText('FGO belgesi kesildi: Proforma (E2E38001)');
    await expect(box.getByRole('button', { name: 'Devam et' })).toHaveCount(0);
    await step1.getByRole('button', { name: 'Vazgeç' }).click();
    await expect(box.locator('[data-remove-step]')).toHaveCount(0);
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect([o.removedAt, o.status]).toEqual([null, 'URETIMDE']);
    expect(await db.offer.count({ where: { orderId } })).toBe(2);
    await admin.context().close();
  } finally {
    await db.fgoDocument.delete({ where: { id: doc.id } });
    await db.$disconnect();
  }
});

test('siparişi silme: yalnızca yönetici, iki aşamalı (sipariş no + sonuç → numarayı yazarak son onay); "Vazgeç" her adımda; sunucu numarayı ayrıca denetler', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  const id = await newOrder(cust, 'Silinecek sipariş', 'silinecek.pdf');
  const db = await prisma();
  const no = (await db.order.findUniqueOrThrow({ where: { id } })).orderNo;
  // Yönetici dışındaki rollerde bölüm yok
  await cust.goto(`/siparisler/${id}`);
  await expect(cust.locator('#sil')).toHaveCount(0);
  for (const [email, pw] of [[SALES, TEAM_PW], [DRAWER, TEAM_PW], [INSPECTOR, INSPECTOR_PW]] as const) {
    const p = await as(browser, email, pw);
    await p.goto(`/siparisler/${id}`);
    await expect(p.locator('#sil')).toHaveCount(0);
    await p.context().close();
  }

  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${id}`);
  const box = admin.locator('#sil');
  // 1. aşama: silinecek sipariş ve sonucu
  await box.getByRole('button', { name: 'Siparişi sil' }).click();
  const step1 = box.locator('[data-remove-step="1"]');
  await expect(step1).toContainText(`Silinecek sipariş: ${no}`);
  await expect(step1).toContainText('Korunan kayıtlar:');
  await step1.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(box.locator('[data-remove-step]')).toHaveCount(0);
  // 2. aşama: numara yazılmadan / yanlış yazılınca kırmızı düğme çalışmaz; "Vazgeç" kapatır
  await box.getByRole('button', { name: 'Siparişi sil' }).click();
  await box.getByRole('button', { name: 'Devam et' }).click();
  const step2 = box.locator('[data-remove-step="2"]');
  const input = step2.getByLabel(`Silmeyi onaylamak için sipariş numarasını yazın: ${no}`);
  const submit = step2.locator('button.btn-danger-solid');
  await expect(submit).toBeDisabled();
  await input.fill(`${no}9`);
  await expect(submit).toBeDisabled();
  await step2.getByRole('button', { name: 'Vazgeç' }).click();
  await expect(box.locator('[data-remove-step]')).toHaveCount(0);
  expect((await db.order.findUniqueOrThrow({ where: { id } })).removedAt).toBeNull();
  // Düğme kilidi tarayıcıda aşılsa da sunucu yazılan numarayı denetler: yanlış numarayla gelen istek silmez
  await box.getByRole('button', { name: 'Siparişi sil' }).click();
  await box.getByRole('button', { name: 'Devam et' }).click();
  await input.fill(no);
  await expect(submit).toBeEnabled();
  await input.evaluate((el: HTMLInputElement) => { el.value = 'BASKA1'; });
  await submit.click();
  await expect(box.locator('.alert-error')).toContainText('Sipariş numarası eşleşmedi; sipariş silinmedi.');
  expect((await db.order.findUniqueOrThrow({ where: { id } })).removedAt).toBeNull();
  // Doğru numarayla (harf farkı yok sayılır) silinir: yumuşak silme, kayıt ve denetim. (Hata sonrası bölüm 1. ya da 2.
  // adımda açık kalır — sayfanın yenilenmesi bileşenin durumunu koruyabilir.)
  if (await box.getByRole('button', { name: 'Devam et' }).count()) await box.getByRole('button', { name: 'Devam et' }).click();
  await input.fill(no.toLowerCase());
  await submit.click();
  await expect(admin).toHaveURL(new RegExp(`silindi=${no}`));
  await expect(admin.locator('#silinen .alert-ok')).toContainText(`Sipariş silindi: ${no}.`);
  const o = await db.order.findUniqueOrThrow({ where: { id }, include: { files: true } });
  expect([o.status, !!o.removedAt, o.files.length]).toEqual(['IPTAL', true, 1]);
  expect(await db.auditLog.count({ where: { action: 'ORDER_REMOVED', entityId: id } })).toBe(1);
  expect((await cust.request.get(`/siparisler/${id}`)).status()).toBe(404);
  await db.$disconnect();
  await Promise.all([cust.context().close(), admin.context().close()]);
});
