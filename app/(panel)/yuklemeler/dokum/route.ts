import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { cratesBetween, loadOf, ordersShippingBetween, shipDay } from '@/lib/loading';
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
  const [around, crates] = await Promise.all([
    ordersShippingBetween(user, new Date(d.getTime() - 86_400_000), new Date(d.getTime() + 2 * 86_400_000)),
    cratesBetween(user, d, new Date(d.getTime() + 86_400_000)),
  ]);
  const orders = around.filter((o) => shipDay(o) === day);
  const admin = userCan(user, 'OFFER_SEND');
  const summary = buildLoadingSummary(orders, { priceOf: (l) => (admin ? l.offerPrice : l.unitPrice) });

  // Ağırlık ve sandık: Yüklemeler sayfasındaki hesap (müşteri + gün; girilmiş sandıklar tahminin önüne geçer)
  const byCustomer = new Map<string, typeof orders>();
  for (const o of orders) byCustomer.set(o.customer.id, [...(byCustomer.get(o.customer.id) ?? []), o]);
  let netKg = 0, grossKg = 0, crateCount = 0;
  for (const [id, list] of byCustomer) {
    const g = groupLoad(list.map((o) => loadOf(o, false)), crates.filter((c) => c.customerId === id));
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
        t('loading.summary.colQty'), t('loading.summary.colUnit'), t('loading.summary.colM2'), t('loading.summary.colPrice'), t('loading.summary.colAmount')],
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
