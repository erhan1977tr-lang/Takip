import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, TEAM_PW, as } from './helpers';

// Son dört düzeltme paketi (karar 256–258) — gerçek sunucuda:
//  - telafi: YALNIZCA kesilmiş nihai fatura (factură finală) telafiyi engeller — ekranda düğme yok, nedeni yazılı (TR / RO),
//    doğrudan (taklit) istek de reddedilir; proformalı siparişte telafi açılır ve bedelsiz telafide kaynak adedi değişmez
//  - mali belge alıcısı: firma sayfası, gönderimle AYNI kuralla (financialRecipient) gerçek alıcıyı gösterir; geçersiz fatura
//    e-postası (birden çok adres, ardışık nokta …) sunucuda reddedilir
// Bu veritabanında FGO KAPALIDIR: belge kayıtları testin doğrudan yazdığı satırlardır; FGO'ya, SMTP'ye istek gitmez.
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test'; // 08'de açılan satışçı
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const NEW_DAY = iso(50);
let invId = '', profId = '', profLine = '', firmId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
async function actionField(page: Page, url: string, marker: string): Promise<string> {
  const html = await (await page.request.get(url)).text();
  const form = html.split('<form').find((chunk) => chunk.includes(marker));
  const m = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form) : null;
  expect(m, `sunucu işlemi alanı bulunamadı (${url}, ${marker})`).toBeTruthy();
  return m![0];
}

test('veri: nihai faturalı ve proformalı iki sipariş (ayrı firma), mali belge alıcısı için firma', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const firm = await db.customer.create({ data: { name: 'Telafi Fatura SRL', prefix: 'QZF', email: 'office@qzf.test', fxPolicy: 'BNR' } });
  const order = (no: number) => db.order.create({
    data: {
      orderNo: `QZF${no}`, customerOrderNo: String(no), title: `Fatura telafi ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE',
      estimatedShipDate: new Date(`${iso(30)}T12:00:00Z`),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(), lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 6, unit: 'm2', kind: 'CAM', unitPrice: '37', offerPrice: '66.96' }] } } },
    },
    include: { offers: { include: { lines: true } } },
  });
  const inv = await order(1);
  const prof = await order(2);
  await db.fgoDocument.create({ data: { orderId: inv.id, kind: 'PROFORMA', series: 'PRF', number: 'E256-1', issuedAt: new Date() } });
  await db.fgoDocument.create({ data: { orderId: inv.id, kind: 'INVOICE', series: 'GKH', number: 'E256-2', issuedAt: new Date() } });
  await db.fgoDocument.create({ data: { orderId: prof.id, kind: 'PROFORMA', series: 'PRF', number: 'E256-3', issuedAt: new Date() } });
  const billing = await db.customer.create({ data: { name: 'Fatura Adres SRL', prefix: 'QZB', email: 'office@qzb.test', billingEmail: 'facturi@qzb.test;contabil@qzb.test', fxPolicy: 'BNR' } });
  await db.$disconnect();
  [invId, profId, profLine, firmId] = [inv.id, prof.id, prof.offers[0].lines[0].id, billing.id];
});

test('telafi: nihai fatura varsa düğme yok, neden yazılı (TR / RO); doğrudan istek reddedilir; proformalı siparişte bedelsiz telafi açılır, kaynak adedi değişmez', async ({ browser }) => {
  const sales = await as(browser, SALES, TEAM_PW);
  // --- Nihai faturalı sipariş: teklif satırında "Kırık / Telafi" yok, "Önemli kararlar"da oluşturma düğmesi yok, neden yazılı
  await sales.goto(`/siparisler/${invId}`);
  await expect(sales.locator('#teklif')).toBeVisible();
  await expect(sales.locator('#teklif').getByRole('link', { name: 'Kırık / Telafi' })).toHaveCount(0);
  const card = sales.locator('#kararlar');
  await expect(card.getByRole('link', { name: 'Kırık / Telafi Camı Oluştur' })).toHaveCount(0);
  await expect(card.locator('[data-comp-blocked=FINAL_INVOICE]')).toContainText('nihai fatura (factură finală) kesildi (GKHE256-2)');
  // Adres çubuğuyla form açılmaz
  await sales.goto(`/siparisler/${invId}?telafi=sec#telafi`);
  await expect(sales.locator('#telafi')).toHaveCount(0);
  // Romence ekran: anlaşılır Romence neden
  await sales.goto(`/dil?l=ro&next=${encodeURIComponent(`/siparisler/${invId}`)}`);
  await expect(sales.locator('html')).toHaveAttribute('lang', 'ro');
  await expect(sales.locator('#kararlar [data-comp-blocked=FINAL_INVOICE]')).toContainText('a fost emisă factura finală (GKHE256-2)');
  await sales.goto(`/dil?l=tr&next=${encodeURIComponent(`/siparisler/${profId}`)}`);
  await expect(sales.locator('html')).toHaveAttribute('lang', 'tr');

  // --- Taklit istek (form gizli olsa da sunucu işlemi çağrılırsa): sunucu reddeder, hiçbir kayıt yazılmaz
  const db = await prisma();
  const field = await actionField(sales, `/siparisler/${profId}?telafi=${profLine}`, 'name="destType"');
  const invLine = (await db.offerLine.findFirstOrThrow({ where: { offer: { orderId: invId } } })).id;
  const origin = new URL(sales.url()).origin;
  const res = await sales.request.post(`/siparisler/${invId}`, {
    multipart: { [field]: '', id: invId, key: `taklit-${'x'.repeat(20)}`, lineId: invLine, quantity: '1', mode: 'FREE', destType: 'NEW', day: NEW_DAY, confirm: 'on' },
    headers: { origin }, maxRedirects: 0,
  });
  expect(res.status()).toBeLessThan(500);
  expect(await db.compensation.count({ where: { sourceOrderId: invId } })).toBe(0);
  expect(await db.order.count({ where: { compOfId: invId } })).toBe(0);

  // --- Proformalı sipariş: telafi açılır (proforma engel değildir); bedelsiz telafide kaynak adedi DEĞİŞMEZ
  const docs = JSON.stringify(await db.fgoDocument.findMany({ where: { orderId: profId } }));
  await sales.goto(`/siparisler/${profId}`);
  await sales.locator('#teklif').getByRole('link', { name: 'Kırık / Telafi' }).first().click();
  const form = sales.locator('#telafi');
  await expect(form).toBeVisible();
  // Belgeli kaynakta bedelli telafinin adedi düşmez (mevcut kural) — form bunu kayıttan önce söyler
  await expect(form.locator('[data-source-kept=BILLING]')).toBeVisible();
  await form.locator('#comp-qty').fill('2');
  await form.locator('label.chip', { hasText: 'Bedelsiz' }).click();
  await form.locator('input[name=destChoice][value=NEW]').check();
  await form.locator('#comp-day').fill(NEW_DAY);
  const summary = form.locator('.comp-summary');
  await expect(summary.locator('[data-source-free]')).toContainText('6 adet — değişmez');
  await summary.locator('.comp-confirm input').check();
  await form.getByRole('button', { name: 'Telafi camını ekle' }).click();
  await expect(sales).toHaveURL(/telafiOk=sent/);
  await expect(sales.locator('[data-comp-source=FREE]')).toContainText('Bedelsiz telafi: kaynak siparişin adedi değişmedi');
  const src = await db.order.findUniqueOrThrow({ where: { id: profId }, include: { offers: { include: { lines: true } } } });
  expect([src.offers.length, src.offers[0].lines.map((l) => l.adet)]).toEqual([1, [6]]);
  const t = await db.order.findFirstOrThrow({ where: { orderNo: 'QZF2-T' }, include: { offers: { include: { lines: true } } } });
  expect(t.offers[0].lines.map((l) => [l.adet, Number(l.unitPrice), Number(l.offerPrice), l.free, !!l.compensationId])).toEqual([[2, 37, 0, true, true]]);
  expect(JSON.stringify(await db.fgoDocument.findMany({ where: { orderId: profId } }))).toBe(docs);
  await db.$disconnect();
  await sales.context().close();

  // Yönetici de nihai faturalı siparişte telafi açamaz (aynı neden)
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${invId}`);
  await expect(admin.locator('#kararlar [data-comp-blocked=FINAL_INVOICE]')).toBeVisible();
  await expect(admin.locator('#teklif').getByRole('link', { name: 'Kırık / Telafi' })).toHaveCount(0);
  await admin.context().close();
});

test('mali belge alıcısı: firma sayfası gönderimle aynı kuralı gösterir (fatura e-postası → firmanın e-postası → Email yok); geçersiz adres sunucuda reddedilir', async ({ browser }) => {
  const db = await prisma();
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const recipient = admin.locator('[data-financial-recipient]');
  // Birden çok adres yazılmış (eski / dışarıdan gelmiş kayıt): geçersiz → firmanın e-postasına düşülür
  await admin.goto(`/admin/firms/${firmId}`);
  await expect(recipient).toHaveAttribute('data-financial-recipient', 'office@qzb.test');
  await expect(recipient).toContainText('Fatura e-postası boş ya da geçersiz');
  // Geçerli fatura e-postası: o
  await db.customer.update({ where: { id: firmId }, data: { billingEmail: 'facturi@qzb.test' } });
  await admin.reload();
  await expect(recipient).toHaveAttribute('data-financial-recipient', 'facturi@qzb.test');
  await expect(recipient).toContainText('(fatura e-postası)');
  // İkisi de geçersiz / boş: "Email yok" uyarısı
  await db.customer.update({ where: { id: firmId }, data: { billingEmail: null, email: 'office@qzb' } });
  await admin.reload();
  await expect(recipient).toHaveAttribute('data-financial-recipient', '');
  await expect(recipient).toContainText('Email yok');
  // Formdan: tarayıcının kabul ettiği ama tek geçerli adres olmayan biçim (ardışık nokta) sunucuda reddedilir; geçerli adres kaydedilir
  await db.customer.update({ where: { id: firmId }, data: { email: 'office@qzb.test' } });
  await admin.reload();
  await expect(recipient).toHaveAttribute('data-financial-recipient', 'office@qzb.test');
  const billing = admin.getByLabel('Fatura e-postası (E-mail facturare)');
  await billing.fill('facturi..x@qzb.test');
  await admin.locator('form.card').getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin.locator('.alert-error')).toContainText('Fatura e-postası geçerli bir e-posta adresi olmalı');
  expect((await db.customer.findUniqueOrThrow({ where: { id: firmId } })).billingEmail).toBeNull();
  await billing.fill('muhasebe@qzb.test');
  await admin.locator('form.card').getByRole('button', { name: 'Kaydet' }).click();
  await expect(admin).toHaveURL(/\/admin\/firms\?saved=/);
  expect((await db.customer.findUniqueOrThrow({ where: { id: firmId } })).billingEmail).toBe('muhasebe@qzb.test');
  await admin.goto(`/admin/firms/${firmId}`);
  await expect(recipient).toHaveAttribute('data-financial-recipient', 'muhasebe@qzb.test');
  await db.$disconnect();
  await admin.context().close();
});
