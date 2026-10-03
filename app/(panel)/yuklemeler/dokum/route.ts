import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { cratesBetween, guestCratesBetween, loadOf, ordersShippingBetween, replanRowsBetween, shipDay } from '@/lib/loading';
import { customerLabel } from '@/lib/orders';
import { fmtDate } from '@/lib/format';
import { parseDateOnly } from '@/server/orders/rules.js';
import { groupLoad } from '@/server/loading/crates.js';
import { buildLoadingSummary, loadingSummaryXlsx } from '@/server/loading/summary.js';
import { XLSX_MIME } from '@/server/files/xlsx.js';

export const dynamic = 'force-dynamic';

// GET /yuklemeler/dokum?gun=YYYY-MM-DD — seçilen yükleme gününün dökümü (Excel). İç ekip (yönetici, satış, denetimci:
// TRANSPORT_LIST_VIEW); müşteri erişemez. Sipariş ve sandık verisi Yüklemeler sayfasıyla aynı sorgulardan, role göre
// temizlenmiş gelir: satışta firma adı maskeli ve fiyat satış fiyatıdır; müşteri fiyatı yalnızca yönetici / denetimcide.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'TRANSPORT_LIST_VIEW')) return new Response(t('common.fileNotFound'), { status: 403 });
  const day = new URL(req.url).searchParams.get('gun') ?? '';
  if (!parseDateOnly(day)) return new Response(t('loading.transport.badDay'), { status: 400 });
  const d = new Date(`${day}T00:00:00Z`);
  const next = new Date(d.getTime() + 86_400_000);
  const [around, carried, crates, guests] = await Promise.all([
    ordersShippingBetween(user, new Date(d.getTime() - 86_400_000), new Date(d.getTime() + 2 * 86_400_000)),
    replanRowsBetween(user, d, next), cratesBetween(user, d, next), guestCratesBetween(user, d, next),
  ]);
  // O günün yükü: o güne planlı siparişler + yüklenmeyen camın o güne aktarılmış kalanları (yalnızca aktarılan adet; karar 102)
  const orders = [
    ...around.filter((o) => shipDay(o) === day),
    ...carried.filter((o) => shipDay(o) === day).map((o) => ({ ...o, title: [o.title, t('loading.replan.from', { date: fmtDate(`${o.replan!.fromDay}T12:00:00Z`) })].filter(Boolean).join(' · ') })),
  ];
  const admin = userCan(user, 'OFFER_SEND');
  // Fiziksel sandık (karar 103): siparişin gittiği sandıklar; başka müşterinin sandığı ev sahibinin adıyla (role göre maskeli)
  // yazılır. Satır ticari olarak siparişin kendi müşterisinde kalır.
  const dayGuests = guests.filter((l) => l.day === day);
  const crateOf = (o: { id: string; customer: { id: string } }) => [
    ...crates.filter((c) => c.customerId === o.customer.id && c.orders.some((x) => x.orderId === o.id)).map((c) => `#${c.crateNo}`),
    ...dayGuests.filter((l) => l.orderId === o.id).map((l) => `#${l.crateNo} (${customerLabel(user, l.hostName)})`),
  ];
  const summary = buildLoadingSummary(orders, { priceOf: (l) => (admin ? l.offerPrice : l.unitPrice), crateOf });

  // Ağırlık ve sandık: Yüklemeler sayfasındaki hesap (müşteri + gün; girilmiş sandıklar tahminin önüne geçer; başka
  // müşterinin sandığında giden camın ağırlığı o sandığın müşterisine yazılır)
  const byCustomer = new Map<string, typeof orders>();
  for (const o of orders) byCustomer.set(o.customer.id, [...(byCustomer.get(o.customer.id) ?? []), o]);
  const hosted = new Map(dayGuests.map((l) => [l.orderId, l.hostId]));
  for (const h of hosted.values()) if (!byCustomer.has(h)) byCustomer.set(h, []);
  const kgOf = new Map<string, number>();
  for (const o of orders) kgOf.set(o.id, (kgOf.get(o.id) ?? 0) + loadOf(o, false).netKg);
  let netKg = 0, grossKg = 0, crateCount = 0;
  for (const [id, list] of byCustomer) {
    const guestKg = [...hosted.entries()].filter(([, h]) => h === id).reduce((s, [orderId]) => s + (kgOf.get(orderId) ?? 0), 0);
    const g = groupLoad(list.map((o) => (hosted.has(o.id) ? { ...loadOf(o, false), netKg: 0 } : loadOf(o, false))), crates.filter((c) => c.customerId === id), { guestKg });
    netKg += g.netKg; grossKg += g.grossKg; crateCount += g.crates;
  }
  const finalPrice = admin || userCan(user, 'PRICE_FINAL_VIEW');
  const body = loadingSummaryXlsx(summary, {
    day,
    stats: [
      [t('loading.summary.orders'), summary.orders],
      [t('loading.summary.lines'), summary.offerLines],
      [t('loading.summary.glassKg'), `${Math.round(netKg)} kg`],
      [t('loading.summary.crates'), crateCount],
      [t('loading.summary.grossKg'), `${Math.round(grossKg)} kg`],
      [t('loading.summary.ops'), t('loading.summary.opsIncluded')],
      [t('loading.summary.price'), finalPrice ? t('loading.summary.priceFinal') : t('loading.summary.priceSales')],
      [t('loading.summary.currency'), Object.keys(summary.totals).join(', ') || '—'],
    ],
    text: {
      title: t('loading.summary.title'), unit: 'm²', total: t('loading.summary.total'),
      cols: [t('loading.summary.colOrder'), t('loading.summary.colCustomer'), t('loading.summary.colProject'), t('loading.summary.colGlass'),
        t('loading.summary.colQty'), t('loading.summary.colUnit'), t('loading.summary.colM2'), t('loading.summary.colPrice'), t('loading.summary.colAmount'), t('loading.summary.colCrate')],
    },
  });
  await audit('LOADING_SUMMARY_EXPORT', 'Loading', day, user.id, { orders: summary.orders });
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Disposition': `attachment; filename="yukleme-${day}-ozet.xlsx"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
