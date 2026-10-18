import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, INSPECTOR_PW, TEAM_PW, as } from './helpers';

// DÜZELTME 10 Aşama 2C (karar 295) — Muhasebe → Müşteri Bakiyeleri gerçek sunucuda:
//  - müşteri bazında fazla ödeme (cam proforması 605 RON, FGO tahsilatı 800 RON → 195 RON), kullanılabilir bakiye
//  - TAKİP içi mahsup: açık onay kutusu + onay penceresi; FGO belgesi / tahsilatı değişmez, kuyruğa iş yazılmaz
//  - sipariş finans kartında çıkan / gelen mahsup; geri alma gerekçeyle
//  - satış, denetimci, müşteri: sayfa yok, veri yok; taklit form gönderimi kayıt oluşturmaz
// FGO bu veritabanında KAPALIDIR ve kapalı kalır: proforma satırları doğrudan test verisi olarak yazılır, FGO'ya istek gitmez.
test.describe.configure({ mode: 'serial' });

const SALES = 'fiyat-satis@e2e.test';
const INSPECTOR = 'denetim@e2e.test';
const PAGE = '/admin/muhasebe/bakiye';
let customerId = '';
let sourceId = '';
let targetId = '';
let sourceRef = '';
let targetRef = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
async function noOverflow(page: Page, what: string) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `${what}: mobilde sayfa yana taşmaz`).toBeLessThanOrEqual(iw + 1);
}

test('veri: aynı müşterinin iki cam siparişi; birinde fazla ödeme (FGO 800 / proforma 605), diğeri ödenmemiş', async () => {
  const db = await prisma();
  try {
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const firm = await db.customer.create({ data: { name: 'Bakiye E2E SRL', prefix: 'BKY', email: 'bky@e2e.test', taxId: '554433', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. Sold 1' } });
    customerId = firm.id;
    const make = async (no: number, paid: string) => {
      const o = await db.order.create({
        data: {
          orderNo: `BKY${no}`, customerOrderNo: String(no), title: `Bakiye ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE',
          estimatedShipDate: new Date(Date.now() + 20 * 86_400_000),
          offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '0', offerAmount: '0', createdById: admin.id, sentAt: new Date(),
            lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
          price: { create: { amount: '100.00', setById: admin.id } },
        },
      });
      const pf = await db.fgoDocument.create({ data: { orderId: o.id, kind: 'PROFORMA', series: 'PRF', number: String(96900 + no), total: '605.00', paid, issuedAt: new Date(), checkedAt: new Date() } });
      await db.glassBilling.create({ data: { orderId: o.id, fxRate: '5.0000', fxDate: new Date(), fxSource: 'BNR' } });
      return { id: o.id, ref: `${pf.series}${pf.number}` };
    };
    ({ id: sourceId, ref: sourceRef } = await make(1, '800.00'));
    ({ id: targetId, ref: targetRef } = await make(2, '0'));
  } finally {
    await db.$disconnect();
  }
});

test('yönetici: müşteri bazında bakiye; TAKİP içi mahsup açık onayla; FGO kayıtları ve kuyruk değişmez; geri alma gerekçeyle', async ({ browser }) => {
  const db = await prisma();
  try {
    const docsBefore = JSON.stringify(await db.fgoDocument.findMany({ where: { orderId: { in: [sourceId, targetId] } }, orderBy: { id: 'asc' } }));
    const outboxBefore = await db.notificationOutbox.count();
    const page = await as(browser, ADMIN, ADMIN_PW);
    await page.goto(PAGE);
    await expect(page.locator('.sidebar').getByRole('link', { name: 'Müşteri Bakiyeleri' })).toBeVisible();
    const row = page.locator('[data-credit-customer="BKY"]');
    await expect(row.locator('[data-available]')).toContainText('195,00 RON');
    await row.getByRole('link', { name: 'Bakiye ayrıntısı' }).click();
    await expect(page.locator('[data-credit-not-fgo]')).toContainText('FGO');
    await expect(page.locator('[data-total="overpaid"]')).toContainText('195,00 RON');
    await expect(page.locator(`[data-chain="${sourceRef}"]`)).toHaveAttribute('data-overpaid', '195');

    const form = page.locator('#mahsup-formu');
    await form.locator('#of-source').selectOption(`order:${sourceId}`);
    await form.locator('#of-target').selectOption(targetId);
    await form.locator('#of-amount').fill('50');
    await form.locator('#of-note').fill('BKY1 fazlası BKY2 proformasına');
    // Onay kutusu işaretlenmeden form gönderilmez (tarayıcı + sunucu)
    await form.getByRole('button', { name: 'Mahsubu kaydet' }).click();
    await expect(page.locator('[data-offset]')).toHaveCount(0);
    await form.locator('input[name="confirm"]').check();
    await form.getByRole('button', { name: 'Mahsubu kaydet' }).click();
    await expect(page.getByText('Mahsup kaydı oluşturuldu')).toBeVisible();
    await expect(page.locator('[data-offset-status="ACTIVE"]')).toHaveCount(1);
    await expect(page.locator('[data-total="available"]')).toContainText('145,00 RON');
    await expect(page.locator(`[data-chain="${sourceRef}"]`)).toHaveAttribute('data-remaining', '145');

    // FGO belgeleri (toplam / tahsilat) aynı; kuyruğa iş yazılmadı
    expect(JSON.stringify(await db.fgoDocument.findMany({ where: { orderId: { in: [sourceId, targetId] } }, orderBy: { id: 'asc' } }))).toBe(docsBefore);
    expect(await db.notificationOutbox.count()).toBe(outboxBefore);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'CREDIT_OFFSET_CREATED' }, orderBy: { createdAt: 'desc' } });
    expect((audit.details as { fgo: boolean; amountRon: string }).fgo).toBe(false);

    // Sipariş finans kartı: kaynakta çıkan, hedefte gelen; avans dayanağı değişmedi
    await page.goto(`/siparisler/${targetId}`);
    await expect(page.locator('#odemeler [data-credit-dir="in"]')).toContainText(sourceRef);
    await expect(page.locator('#odemeler [data-fin=required]')).toContainText('0,00 RON');
    await page.goto(`/siparisler/${sourceId}`);
    await expect(page.locator('#odemeler [data-credit-dir="out"]')).toContainText(targetRef);

    // Geri alma: gerekçe + onay; kayıt silinmez
    await page.goto(`${PAGE}?c=${customerId}`);
    const offsetRow = page.locator('[data-offset-status="ACTIVE"]');
    const rev = offsetRow.locator('[data-close="REVERSED"]');
    await rev.locator('input[name="reason"]').fill('yanlış tutar');
    await rev.locator('input[name="confirm"]').check();
    await rev.getByRole('button', { name: 'Geri al' }).click();
    await expect(page.getByText('Mahsup geri alındı.')).toBeVisible();
    await expect(page.locator('[data-offset-status="REVERSED"]')).toHaveCount(1);
    await expect(page.locator('[data-total="available"]')).toContainText('195,00 RON');
    expect(await db.creditOffset.count({ where: { customerId } })).toBe(1);

    // İkinci mahsup → "FGO'ya işlendi" yalnızca manuel muhasebe beyanı: referans + gerekçe + onay; FGO'ya istek yok
    await form.locator('#of-amount').fill('30');
    await form.locator('#of-note').fill('ikinci mahsup');
    await form.locator('input[name="confirm"]').check();
    await form.getByRole('button', { name: 'Mahsubu kaydet' }).click();
    await expect(page.locator('[data-offset-status="ACTIVE"]')).toHaveCount(1);
    const decl = page.locator('[data-offset-status="ACTIVE"] [data-close="FGO_RECORDED"]');
    await decl.locator('summary').click();
    await decl.locator('input[name="fgoRef"]').fill('PRF 96902 / incasare 1');
    await decl.locator('input[name="reason"]').fill('muhasebe FGO\'ya işledi');
    await decl.locator('input[name="confirm"]').check();
    await decl.getByRole('button', { name: 'Beyanı kaydet' }).click();
    await expect(page.getByText('manuel beyan')).toBeVisible();
    await expect(page.locator('[data-fgo-ref="PRF 96902 / incasare 1"]')).toBeVisible();
    // Beyan edilen kayıt artık mahsup sayılmaz (FGO rakamları güncellenince yansır); geri alınamaz
    await expect(page.locator('[data-total="offset"]')).toContainText('0,00 RON');
    expect(JSON.stringify(await db.fgoDocument.findMany({ where: { orderId: { in: [sourceId, targetId] } }, orderBy: { id: 'asc' } }))).toBe(docsBefore);
    expect(await db.notificationOutbox.count()).toBe(outboxBefore);
    const declared = await db.creditOffset.findFirstOrThrow({ where: { customerId, status: 'FGO_RECORDED' } });
    expect([declared.fgoRef, declared.closedById !== null]).toEqual(['PRF 96902 / incasare 1', true]);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${PAGE}?c=${customerId}`);
    await noOverflow(page, 'müşteri bakiyesi');
    await page.context().close();
  } finally {
    await db.$disconnect();
  }
});

test('yetkisiz roller: sayfa ve veri yok; taklit form gönderimi mahsup oluşturmaz', async ({ browser }) => {
  const db = await prisma();
  try {
    const admin = await as(browser, ADMIN, ADMIN_PW);
    const html = await (await admin.request.get(`${PAGE}?c=${customerId}`)).text();
    const form = html.split('<form').find((chunk) => chunk.includes('name="sourceChain"'));
    const field = form ? /\$ACTION_ID_[0-9a-f]+/.exec(form)?.[0] : null;
    expect(field, 'mahsup formunun sunucu işlemi alanı').toBeTruthy();
    await admin.context().close();
    const before = await db.creditOffset.count();
    for (const [email, pw] of [[SALES, TEAM_PW], [INSPECTOR, INSPECTOR_PW], [CUSTOMER, CUST_PW]]) {
      const p = await as(browser, email, pw);
      await p.goto(`${PAGE}?c=${customerId}`);
      await expect(p, email).not.toHaveURL(/\/admin\/muhasebe\/bakiye/);
      const body = await (await p.request.get(`${PAGE}?c=${customerId}`)).text();
      for (const s of [sourceRef, targetRef, 'Bakiye E2E SRL', '195,00']) expect(body.includes(s), `${email} → ${s}`).toBe(false);
      await expect(p.locator('.sidebar').getByRole('link', { name: 'Müşteri Bakiyeleri' })).toHaveCount(0);
      const origin = new URL(p.url()).origin;
      await p.request.post(`${PAGE}?c=${customerId}`, {
        multipart: { [field!]: '', customerId, sourceChain: `order:${sourceId}`, targetOrderId: targetId, amount: '10', note: 'taklit', confirm: 'on', requestKey: `taklit${Date.now()}x${email.length}` },
        headers: { origin },
      });
      await p.context().close();
    }
    expect(await db.creditOffset.count()).toBe(before);
  } finally {
    await db.$disconnect();
  }
});
