import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, as } from './helpers';

// P4 — proformada aynı teknik cam tek satır (karar 242), müşteri proforması önizlemesi (gerçek sunucu):
//  - aynı cam farklı fiyatla → tek satır; gösterilen fiyat m² ağırlıklı ortalama ("ort." / "medie"); tutar parça parça
//  - CNC ve sandık bedeli ayrı satır; başka teknik cam ayrı satır
//  - kaynak ve RON toplamı birleştirmeden öncekiyle aynı; Türkçe ve Romence ekranda aynı satırlar
// FGO bu veritabanında KAPALIDIR: hiçbir belge kesilmez (yalnızca önizleme).
test.describe.configure({ mode: 'serial' });

const PAGE = '/admin/muhasebe/cam/proforma';
const day = new Date(`${new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`);
const DAY = day.toISOString().slice(0, 10);
let firmId = '';

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('veri: bir firma, aynı camın iki fiyatlı satırları + CNC + başka cam + sandık bedeli; günün BT kuru', async () => {
  const db = await prisma();
  const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
  const firm = await db.customer.create({ data: { name: 'Grupare E2E SRL', prefix: 'GRE', email: 'grupare@e2e.test', taxId: '667788', county: 'Cluj', city: 'Cluj-Napoca', address: 'Str. Grup 1' } });
  firmId = firm.id;
  await db.order.create({
    data: {
      orderNo: 'GRE1', customerOrderNo: 1, title: 'Grupare e2e', orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: admin.id, status: 'URETIMDE', estimatedShipDate: day,
      offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '100.00', offerAmount: '285.00', createdById: admin.id, sentAt: new Date(),
        lines: { create: [
          { sortOrder: 0, description: 'Temper 10', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1000, boyMm: 1000, adet: 2, unit: 'm2', unitPrice: '30', offerPrice: '50', kind: 'CAM' },
          { sortOrder: 1, description: 'CNC', adet: 2, unit: 'adet', unitPrice: '5', offerPrice: '10', kind: 'CNC' },
          { sortOrder: 2, description: 'Lamine 44.2', descriptionRo: 'Sticlă laminată 44.2', enMm: 1000, boyMm: 1000, adet: 1, unit: 'm2', unitPrice: '40', offerPrice: '80', kind: 'CAM' },
          { sortOrder: 3, description: 'Temper 10', descriptionRo: 'Sticlă securizată 10 mm', enMm: 500, boyMm: 2000, adet: 1, unit: 'm2', unitPrice: '30', offerPrice: '60', kind: 'CAM' },
          { sortOrder: 4, description: 'Sandık parası', descriptionRo: 'Ambalaj (ladă)', adet: 1, unit: 'adet', unitPrice: '0', offerPrice: '25', kind: 'CAM', crateFee: true },
        ] } } },
    },
  });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await db.integrationSetting.upsert({ where: { key: 'fx.daily' }, create: { key: 'fx.daily', value: { day: today, rate: 5.1 } }, update: { value: { day: today, rate: 5.1 } } });
  await db.$disconnect();
});

test('önizleme: aynı cam tek satır (ortalama fiyat işaretli), CNC / sandık / başka cam ayrı; toplamlar değişmez; TR ve RO aynı', async ({ browser }) => {
  const page = await as(browser, ADMIN, ADMIN_PW);
  const url = `${PAGE}?musteri=${firmId}&gun=${DAY}`;
  await page.goto(url);
  const prev = page.locator('#onizleme');
  await expect(prev).toBeVisible();
  const rows = prev.locator('tr.glass-row');
  // Sıra: ilk görülen yerde birleşik cam satırı, sonra CNC, laminat, sandık (bedelsiz yok)
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Comanda GRE1 — Sticlă securizată 10 mm');
  await expect(rows.nth(1)).toContainText('Comanda GRE1 — Prelucrare CNC');
  await expect(rows.nth(2)).toContainText('Comanda GRE1 — Sticlă laminată 44.2');
  await expect(rows.nth(3)).toContainText('Comanda GRE1 — Ambalaj (ladă)');
  // Birleşik satır: 2 + 1 = 3 m²; gösterilen fiyat (2 × 50 + 1 × 60) / 3 = 53,33 "ort."; tutar parça parça 160,00
  const cells = rows.nth(0).locator('td');
  await expect(cells.nth(1)).toHaveText('3,00');
  await expect(cells.nth(3)).toContainText('53,33');
  await expect(rows.nth(0).locator('[data-avg-price]')).toContainText('ort.');
  await expect(cells.nth(4)).toHaveText('160,00');
  // Tek fiyatlı satırlarda ortalama işareti yok
  await expect(prev.locator('[data-avg-price]')).toHaveCount(1);
  // Toplam: kaynak 160 + 20 + 80 + 25 = 285 EUR; kur 5,1 → 1.453,50 RON (TVA hariç) — birleştirmeden öncekiyle aynı
  await expect(prev.locator('.stats')).toContainText('285,00');
  await expect(prev.locator('.stats')).toContainText('1.453,50');

  // Romence ekran: aynı satırlar ve tutarlar; ortalama işareti "medie"
  await page.goto(`/dil?l=ro&next=${encodeURIComponent(url)}`);
  try {
    await page.goto(url);
    const ro = page.locator('#onizleme');
    await expect(ro.locator('tr.glass-row')).toHaveCount(4);
    await expect(ro.locator('tr.glass-row').nth(0)).toContainText('Comanda GRE1 — Sticlă securizată 10 mm');
    await expect(ro.locator('[data-avg-price]')).toContainText('medie');
    await expect(ro.locator('.stats')).toContainText('1.453,50');
  } finally {
    await page.goto('/dil?l=tr&next=/siparisler');
  }
  // Önizleme hiçbir şey yazmaz
  const db = await prisma();
  expect(await db.billingBatch.count({ where: { customerId: firmId } })).toBe(0);
  await db.$disconnect();
  await page.context().close();
});
