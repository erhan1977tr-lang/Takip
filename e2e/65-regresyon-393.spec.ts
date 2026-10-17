import { test, expect, type Page } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, as } from './helpers';

// 3.93.0 regresyon düzeltmeleri (karar 288) — gerçek sunucuda:
//  D17 onaylı yükleme gününde firma PDF / Excel / Özet planlanan değil, YÜKLENEN miktarları gösterir ("Yükleme Özeti" ile aynı)
//  D14 Ayarlar sayfası adresten gelen imzasız serbest metni (sahte uyarı) göstermez
// FGO bu veritabanında KAPALIDIR; dış istek yok.
test.describe.configure({ mode: 'serial' });

const DAY = '2025-11-18'; // bu testin onaylı yükleme günü (geçmiş)
async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
async function xlsxRows(page: Page, url: string): Promise<(string | number | null)[][]> {
  const { readXlsx } = await import('../server/files/xlsx.js');
  const res = await page.request.get(url);
  expect(res.status(), url).toBe(200);
  return readXlsx(await res.body()).rows as (string | number | null)[][];
}
let firmId = '';

test('veri: 10 adetlik sipariş, onaylı yüklemede 6 yüklendi / 4 yüklenmedi', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const u = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
  firmId = u.customer!.id;
  const o = await db.order.create({
    data: {
      orderNo: `${u.customer!.prefix}9393`, customerOrderNo: '9393', title: 'Regresyon 393', orderTypeCode: 'GLASS_ORDER', customerId: firmId, createdById: admin.id, status: 'URETIMDE',
      estimatedShipDate: new Date(`${DAY}T12:00:00Z`),
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '370', offerAmount: '500', createdById: admin.id, sentAt: new Date(),
        lines: { create: [{ sortOrder: 0, description: 'R393 Temper', descriptionRo: 'Sticlă securizată', enMm: 1000, boyMm: 1000, adet: 10, unit: 'm2', unitPrice: '37', offerPrice: '50', kind: 'CAM' }] } } },
    },
    include: { offers: { include: { lines: true } } },
  });
  const l = o.offers[0].lines[0];
  const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${DAY}T00:00:00Z`), confirmedById: admin.id, note: 'e2e r393' } });
  const base = {
    confirmationId: conf.id, orderId: o.id, customerId: firmId, offerLineId: l.id, scopeKey: `l:${l.id}`, sortOrder: 0, kind: 'CAM', unit: 'm2',
    description: l.description, descriptionRo: l.descriptionRo, enMm: 1000, boyMm: 1000, currency: 'EUR', unitCost: '37', unitSale: '50',
  };
  await db.loadingConfirmationItem.createMany({
    data: [
      { ...base, quantity: 6, m2: '6', costAmount: '222', saleAmount: '300', status: 'LOADED' },
      { ...base, quantity: 4, m2: '4', costAmount: '148', saleAmount: '200', status: 'NOT_LOADED', notLoadedReason: 'NOT_READY' },
    ],
  });
  await db.$disconnect();
});

test('D17: onaylı günde firma Excel / PDF / Özet yüklenen miktarı gösterir (6 adet, 6 m², 300 EUR) — planlanan 10 değil', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  const q = `gun=${DAY}&firma=${firmId}`;
  const rows = await xlsxRows(page, `/yuklemeler/firma?${q}&bicim=xlsx`);
  const row = rows.find((r) => r[0] === 'UNS9393' || String(r[0] ?? '').endsWith('9393'));
  expect(row, 'sipariş satırı').toBeTruthy();
  expect(row!.slice(2, 7)).toEqual([6, 0, 0, 6, 300]);
  const pdf = await page.request.get(`/yuklemeler/firma?${q}&bicim=pdf`);
  expect(pdf.status()).toBe(200);
  await page.goto(`/yuklemeler/ozet?${q}`);
  const tr = page.locator('#ozet-siparisler tbody tr[data-order]').filter({ hasText: '9393' });
  await expect(tr).toHaveCount(1);
  await expect(page.locator('#ozet-tutarlar tr[data-currency="EUR"] [data-col=offer]')).toHaveText('300,00 EUR');
});

test('D14: Ayarlar sayfası adresteki imzasız serbest metni göstermez (sahte uyarı yok); imzasız ayrıntı için genel metin', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  const fake = 'SAHTE-UYARI-Lutfen-sifrenizi-sahte.example-adresine-girin';
  for (const qs of [`error=fgo&detail=${fake}`, `ok=fgoTest&detail=${fake}&types=${fake}`, `error=fgoTest&detail=${fake}`, `error=warehouse&detail=${fake}`]) {
    const res = await page.request.get(`/admin/entegrasyonlar?${qs}`);
    expect(res.status()).toBe(200);
    expect(await res.text(), qs).not.toContain(fake);
  }
});
