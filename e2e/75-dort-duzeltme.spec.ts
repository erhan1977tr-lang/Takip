import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, as } from './helpers';

// 4.2.18 (ürün sahibi, 14.11.2026), gerçek sunucu:
//  - karar 314: yöneticinin sipariş sayfasında "Hareketler" sayfanın içinde kart (#hareketler); müşteride eskisi gibi sol menüde
//  - karar 316: yöneticinin "Tüm aktif siparişler"inde tahmini günü 4 gün geçen üretimdeki sipariş yok, "Yüklenen ve arşiv"de
//    var; 4 gün dolmamış sipariş aktif listede; durum değişmez
// Veriler doğrudan veritabanına yazılır; FGO'ya / dış servise gidilmez.
test.describe.configure({ mode: 'serial' });

const ids: Record<string, string> = {};
const at = (offset: number) => new Date(Date.now() + offset * 86_400_000);
async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('veri: Ünsal için CNC / delikli, olaylı sipariş; tahmini günü 10 gün ve 2 gün geçmiş üretimdeki siparişler', async () => {
  const db = await prisma();
  try {
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
    const c = cust.customer!;
    const make = async (no: number, ship: Date) => {
      const o = await db.order.create({
        data: {
          orderNo: `${c.prefix}${no}`, customerOrderNo: String(no), title: `Dört düzeltme ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: ship,
          offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '1', offerAmount: '100', createdById: admin.id, sentAt: new Date(),
            lines: { create: [
              { sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 1, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' },
              { sortOrder: 1, description: 'Kose Yuvarlama', adet: 2, unit: 'adet', unitPrice: '2.5', offerPrice: '2.5', kind: 'CNC' },
              { sortOrder: 2, description: 'CNC KÜÇÜK DELİK', adet: 4, unit: 'adet', unitPrice: '2.5', offerPrice: '2.5', kind: 'DELIK' },
            ] } } },
          events: { create: [{ event: 'PRODUCTION', userId: admin.id, toStatus: 'URETIMDE' }] },
        },
      });
      ids[o.orderNo] = o.id;
    };
    await make(9751, at(20));
    await make(9752, at(-10));
    await make(9753, at(-2));
  } finally {
    await db.$disconnect();
  }
});

test('yönetici: "Hareketler" sayfanın içinde kart olarak görünür; müşteride sol menünün altında (eski yer)', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${ids.UNS9751}`);
  const card = admin.locator('main #hareketler[data-history="inline"]');
  await expect(card).toBeVisible();
  await expect(card.locator('h2')).toHaveText('Hareketler');
  await expect(card.locator('ul.timeline > li').first()).toBeVisible();
  // Sol menüdeki yuva yöneticide boş
  await expect(admin.locator('.sidebar-activity .side-timeline')).toHaveCount(0);
  await admin.context().close();

  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/siparisler/${ids.UNS9751}`);
  await expect(cust.locator('#hareketler')).toHaveCount(0);
  await expect(cust.locator('.sidebar-activity .side-timeline')).toHaveCount(1);
  await cust.context().close();
});

test('yönetici: tahmini günü 4 gün geçen üretimdeki sipariş "Tüm aktif siparişler"de yok, "Yüklenen ve arşiv"de var; durum değişmez', async ({ browser }) => {
  const admin = await as(browser, ADMIN, ADMIN_PW);
  const count = (no: string) => admin.locator(`main a[href="/siparisler/${ids[no]}"]`).count();
  for (const [no, active] of [['UNS9751', true], ['UNS9752', false], ['UNS9753', true]] as const) {
    await admin.goto(`/siparisler?view=all&q=${no}`);
    expect((await count(no)) > 0, `${no} tüm aktif`).toBe(active);
    await admin.goto(`/siparisler?view=archive&q=${no}`);
    expect((await count(no)) > 0, `${no} arşiv`).toBe(!active);
  }
  await admin.context().close();
  const db = await prisma();
  try {
    const o = await db.order.findUniqueOrThrow({ where: { id: ids.UNS9752 } });
    expect(o.status).toBe('URETIMDE');
  } finally {
    await db.$disconnect();
  }
});
