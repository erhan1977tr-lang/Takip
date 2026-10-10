import { test, expect } from '@playwright/test';
import { ADMIN, ADMIN_PW, CUSTOMER, CUST_PW, INSPECTOR_PW, SALES, TEAM_PW, as, firmOf, openFirm, setShipDate } from './helpers';

// Paket C (kararlar 230–237), gerçek sunucuda. FGO e2e veritabanında KAPALIDIR (gerçek FGO / ANAF isteği yok).
//  - tahmini yükleme tarihi: Sipariş Bilgileri'nde satır içi; onay penceresinde eski → yeni; müşteride düzenleme yok;
//    yüklenmiş siparişte kilitli
//  - müşteri fiyatı yoksa satış / fabrika fiyatı müşteriye ve denetimciye gösterilmez (eski geri düşüş kaldırıldı)
//  - sandık editöründe sipariş seçimi yok; yeni sandık firmanın o günkü bütün siparişlerine bağlanır (başka gün / firma yok)
//  - m² üç ondalık
test.describe.configure({ mode: 'serial' });

const INSPECTOR = 'denetim@e2e.test';
const RUN = Date.now().toString(36);
const DAY = new Date(Date.now() + 131 * 86_400_000).toISOString().slice(0, 10); // yalnızca bu dosyanın yükleme günü
const OTHER_DAY = new Date(Date.now() + 132 * 86_400_000).toISOString().slice(0, 10);
const dmy = (k: string) => k.split('-').reverse().join('.');
const mask = (name: string) => `${name.slice(0, 3)}**********`;
const ids: Record<string, string> = {};
let firm = { id: '', name: '', prefix: '' };

async function prisma() {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

test('veri: müşterinin firmasında bu dosyaya özel siparişler (yükleme günü, eski teklif, başka gün)', async () => {
  const db = await prisma();
  try {
    const u = await db.user.findUniqueOrThrow({ where: { email: CUSTOMER }, include: { customer: true } });
    const admin = await db.user.findUniqueOrThrow({ where: { email: ADMIN } });
    firm = { id: u.customer!.id, name: u.customer!.name, prefix: u.customer!.prefix! };
    const base = 9500 + Math.floor(Math.random() * 400);
    const mk = async (key: string, k: number, day: string, offer: { offerAmount: string | null; offerPrice: string | null }) => {
      const no = base * 10 + k;
      const o = await db.order.create({
        data: {
          orderNo: `${firm.prefix}${no}`, customerOrderNo: no, title: `Paket C ${key} ${RUN}`, orderTypeCode: 'GLASS_ORDER', customerId: firm.id, createdById: u.id,
          status: 'URETIMDE', drawingTrack: 'YOK', estimatedShipDate: new Date(`${day}T09:00:00Z`),
          offers: { create: { status: 'GONDERILDI', currency: 'EUR', amount: '60.00', offerAmount: offer.offerAmount, createdById: admin.id, sentAt: new Date(),
            lines: { create: [{ sortOrder: 0, description: 'Temper 10', descriptionRo: 'Sticlă securizată 10 mm', enMm: 1234, boyMm: 1000, adet: 1, unit: 'm2', unitPrice: '37.13', offerPrice: offer.offerPrice, kind: 'CAM' }] } } },
        },
      });
      ids[key] = o.id;
    };
    await mk('ship', 1, DAY, { offerAmount: '61.70', offerPrice: '50' });
    await mk('second', 2, DAY, { offerAmount: '61.70', offerPrice: '50' });
    await mk('legacy', 3, OTHER_DAY, { offerAmount: null, offerPrice: null }); // eski teklif: müşteri fiyatı yok
  } finally {
    await db.$disconnect();
  }
});

test('tahmini yükleme tarihi: satış satır içinde değiştirir (onayda eski → yeni); müşteri düzenleyemez; yüklenmiş siparişte kilitli', async ({ browser }) => {
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/siparisler/${ids.ship}`);
  await expect(sales.locator('#bilgiler [data-ship-date]')).toHaveAttribute('data-ship-date', DAY);
  const next = new Date(Date.parse(`${DAY}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const message = await setShipDate(sales, next);
  expect(message).toContain(`${dmy(DAY)} → ${dmy(next)}`);
  await expect(sales.locator('.alert-ok')).toContainText('Tahmini yükleme tarihi güncellendi');
  await expect(sales.locator('#bilgiler [data-ship-date]')).toHaveAttribute('data-ship-date', next);
  // İşlemler kartında ayrı tarih formu yok
  await expect(sales.getByRole('button', { name: 'Tarihi güncelle' })).toHaveCount(0);
  // Geri al (sonraki testler için aynı gün) — yine onaylı
  await setShipDate(sales, DAY);
  await expect(sales.locator('#bilgiler [data-ship-date]')).toHaveAttribute('data-ship-date', DAY);
  await sales.context().close();

  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/siparisler/${ids.ship}`);
  await expect(cust.locator('#bilgiler')).toContainText(dmy(DAY));
  await expect(cust.locator('[data-ship-edit], [data-ship-form]')).toHaveCount(0);
  await cust.context().close();

  // Yüklenmiş sipariş: düzenleme yok, kilit açıklaması görünür
  const db = await prisma();
  try {
    await db.order.update({ where: { id: ids.legacy }, data: { status: 'YUKLENDI', actualShipDate: new Date(`${OTHER_DAY}T09:00:00Z`) } });
  } finally {
    await db.$disconnect();
  }
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/siparisler/${ids.legacy}`);
  await expect(admin.locator('#bilgiler [data-ship-locked]')).toContainText('Yükleme tamamlandı');
  await expect(admin.locator('[data-ship-edit]')).toHaveCount(0);
  await admin.context().close();
});

test('fiyat gizliliği: müşteri fiyatı olmayan eski teklifte satış fiyatı müşteriye ve denetimciye gösterilmez', async ({ browser }) => {
  for (const [email, pw] of [[CUSTOMER, CUST_PW], [INSPECTOR, INSPECTOR_PW]] as const) {
    const page = await as(browser, email, pw);
    await page.goto(`/siparisler/${ids.legacy}`);
    const offer = page.locator('#teklif');
    await expect(offer).toBeVisible();
    const html = await offer.innerHTML();
    for (const leak of ['37,13', '60,00', '45,67', '45,82']) expect(html, `${email}: ${leak}`).not.toContain(leak);
    await expect(offer.locator('tfoot')).toContainText('—');
    await page.context().close();
  }
});

test('m² üç ondalık: teklif tablosunda 1,230 m² (alan hesabı aynı: 1234 × 1000 mm → 1,23 m²)', async ({ browser }) => {
  const cust = await as(browser, CUSTOMER, CUST_PW);
  await cust.goto(`/siparisler/${ids.ship}`);
  await expect(cust.locator('#teklif tbody tr').first()).toContainText('1,230 m²');
  await cust.context().close();
});

test('sandık: sipariş seçimi yok; yeni sandık firmanın o günkü bütün siparişlerine bağlanır — başka gün yok; satır işlemleri iki satırda', async ({ browser }) => {
  const sales = await as(browser, SALES, TEAM_PW);
  await sales.goto(`/yuklemeler?gun=${DAY}`);
  const row = firmOf(sales, mask(firm.name));
  const crates = await openFirm(row, 'crates');
  await expect(crates.locator('.crate-pick, td.crate-orders, input[type=checkbox]')).toHaveCount(0);
  await crates.getByRole('button', { name: '+ Sandık ekle' }).click();
  const no = await crates.locator('td.c-no input').last().inputValue();
  await sales.getByLabel(`Net ağırlık (kg) (${no})`).fill('80');
  await sales.getByRole('button', { name: 'Sandıkları kaydet' }).click();
  await expect(crates.locator('.crate-editor .alert-ok')).toContainText('Sandıklar kaydedildi.');
  const db = await prisma();
  try {
    const crate = await db.crate.findFirstOrThrow({ where: { customerId: firm.id, shipDay: new Date(`${DAY}T00:00:00Z`), crateNo: Number(no) }, include: { orders: true } });
    const linked = crate.orders.map((o) => o.orderId);
    expect(linked).toEqual(expect.arrayContaining([ids.ship, ids.second]));
    expect(linked).not.toContain(ids.legacy);
    expect(new Set(linked).size).toBe(linked.length);
  } finally {
    await db.$disconnect();
  }
  await sales.context().close();
  // Yönetici: PDF / Excel ilk satırda, Özet / Sandık ikinci satırda
  const admin = await as(browser, ADMIN, ADMIN_PW);
  await admin.goto(`/yuklemeler?gun=${DAY}`);
  const a = firmOf(admin, firm.name);
  const tops = await a.locator('tr.firm-row .firm-acts [data-action]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-action'), Math.round(e.getBoundingClientRect().top)] as const));
  expect(tops.map(([k]) => k)).toEqual(['pdf', 'xlsx', 'summary', 'crates']);
  expect(tops[0][1]).toBe(tops[1][1]);
  expect(tops[2][1]).toBe(tops[3][1]);
  expect(tops[2][1]).toBeGreaterThan(tops[0][1]);
  // Sandık formu firma satırının hemen altında açılır
  const open = await openFirm(a, 'crates');
  await expect(open.locator('form.crate-editor input[name=customerId]')).toHaveValue(firm.id);
  await admin.context().close();
});
