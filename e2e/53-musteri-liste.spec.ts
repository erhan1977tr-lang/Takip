import { test, expect } from '@playwright/test';
import { ADMIN, CUSTOMER, CUST_PW, as } from './helpers';

// P5 — müşteri sipariş listesi (karar 243), gerçek sunucu:
//  - "Încărcate și arhivă" / "Yüklenen ve arşiv": yalnızca onaylı yüklemeyle EKSİKSİZ yüklenmiş (ve kapanmış) siparişler
//  - Active: tarihi geçmiş yüklenmemiş sipariş, kısmen yüklenmiş (kalanı olan) sipariş, onaysız "Yüklendi"
//  - Active tahmini yükleme gününe göre artan
//  - başka firmanın siparişi hiçbir bölümde yok
// Yükleme onayı kayıtları doğrudan veritabanına yazılır (onay ekranı kendi testlerinde); FGO'ya gidilmez.
test.describe.configure({ mode: 'serial' });

const ids: Record<string, string> = {};
const at = (offset: number) => new Date(Date.now() + offset * 86_400_000);
async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('veri: Ünsal için gecikmiş / kısmi / eksiksiz yüklenmiş / onaysız "Yüklendi" siparişler; başka firmanın yüklenmiş siparişi', async () => {
  const db = await prisma();
  const { snapshotLine } = await import('../server/loading/confirmation.js');
  try {
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const cust = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
    const foreignFirm = await db.customer.create({ data: { name: 'Liste Yabancı SRL', prefix: 'LYB' } });
    const make = async (c: { id: string; prefix: string | null }, no: number, ship: Date, status: 'URETIMDE' | 'YUKLENDI' = 'URETIMDE') => {
      const o = await db.order.create({
        data: {
          orderNo: `${c.prefix}${no}`, customerOrderNo: no, title: `P5 liste ${no}`, orderTypeCode: 'GLASS_ORDER', customerId: c.id, createdById: admin.id, status, estimatedShipDate: ship,
          offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '1', offerAmount: '150', createdById: admin.id, sentAt: new Date(),
            lines: { create: [{ sortOrder: 0, description: 'Temper', descriptionRo: 'Securizat', enMm: 1000, boyMm: 1000, adet: 3, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' }] } } },
        },
      });
      ids[o.orderNo] = o.id;
      return o;
    };
    let back = 200;
    const confirm = async (o: { id: string }, loaded: number) => {
      const day = at(-(back += 1)).toISOString().slice(0, 10);
      const conf = await db.loadingConfirmation.create({ data: { shipDay: new Date(`${day}T00:00:00Z`), confirmedById: admin.id, confirmedAt: new Date(`${day}T12:00:00Z`) } });
      const full = await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { offers: { include: { lines: true } } } });
      const offer = full.offers[0];
      const line = offer.lines[0];
      const rows = [
        { ...snapshotLine(full, offer, line, { quantity: loaded }), status: 'LOADED' },
        ...(3 - loaded > 0 ? [{ ...snapshotLine(full, offer, line, { quantity: 3 - loaded }), status: 'NOT_LOADED', notLoadedReason: 'BROKEN' }] : []),
      ];
      await db.loadingConfirmationItem.createMany({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: rows.map((i: any) => ({ ...i, confirmationId: conf.id, scopeKey: `l:${i.offerLineId}`, m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2), costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4) })),
      });
    };
    const c = cust.customer!;
    await make(c, 9501, at(-400)); // tarihi çok geçmiş, yüklenmemiş → Active'in en üstüne
    const partial = await make(c, 9502, at(-399));
    await confirm(partial, 2);
    const full = await make(c, 9503, at(-398));
    await confirm(full, 3);
    await make(c, 9504, at(-397), 'YUKLENDI'); // yalnızca "Yüklendi" düğmesi
    const foreign = await make(foreignFirm, 9505, at(-396));
    await confirm(foreign, 3);
  } finally {
    await db.$disconnect();
  }
});

test('müşteri: eksiksiz yüklenen arşivde; gecikmiş, kısmi ve onaysız "Yüklendi" Active\'de, tarihe göre artan; başka firma yok', async ({ browser }) => {
  const page = await as(browser, CUSTOMER, CUST_PW);
  // Sipariş satırlarının bağlantıları, sayfadaki sırayla (taslak / teklif / bölüm bağlantıları hariç; # kısmı atılır)
  const order = async () => page.locator('main a[href^="/siparisler/"]').evaluateAll((els) => [...new Set(els
    .map((e) => (e.getAttribute('href') ?? '').split('#')[0])
    .filter((h) => /^\/siparisler\/[a-z0-9]{20,}$/.test(h)))]);
  await page.goto('/siparisler');
  const active = await order();
  const pos = (no: string) => active.indexOf(`/siparisler/${ids[no]}`);
  for (const no of ['UNS9501', 'UNS9502', 'UNS9504']) expect(pos(no), `${no} Active'de`).toBeGreaterThanOrEqual(0);
  expect(pos('UNS9503'), 'eksiksiz yüklenen Active\'de değil').toBe(-1);
  // Tahmini yükleme gününe göre artan: 9501 (en eski, gecikmiş) < 9502 < 9504
  expect(pos('UNS9501')).toBeLessThan(pos('UNS9502'));
  expect(pos('UNS9502')).toBeLessThan(pos('UNS9504'));
  await page.goto('/siparisler?view=archive');
  const archive = await order();
  expect(archive).toContain(`/siparisler/${ids.UNS9503}`);
  for (const no of ['UNS9501', 'UNS9502', 'UNS9504']) expect(archive, `${no} arşivde değil`).not.toContain(`/siparisler/${ids[no]}`);
  // Başka firmanın siparişi (ve adı) hiçbir bölümde / sayfa verisinde yok
  for (const url of ['/siparisler', '/siparisler?view=archive']) {
    const html = await (await page.request.get(url)).text();
    expect(html, url).not.toContain(ids.LYB9505);
    expect(html, url).not.toContain('Liste Yabancı SRL');
  }
  await page.context().close();
});
