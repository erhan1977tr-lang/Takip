import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { dayEntry, firmsOfDay, loadDay, moneyView } from '@/lib/loading';
import { fmtDate } from '@/lib/format';
import { downloadHeaders, exportName, exportSubtitle } from '@/lib/exports';
import { parseDateOnly } from '@/server/orders/rules.js';
import { buildLoadingSummary, loadingSummarySheets } from '@/server/loading/summary.js';
import { writeReportXlsx } from '@/server/files/xlsx-report.js';

export const dynamic = 'force-dynamic';

// GET /yuklemeler/dokum?gun=YYYY-MM-DD — seçilen yükleme gününün "Yükleme Özeti" Excel'i (Paket 7). İç ekip (yönetici, satış,
// denetimci: TRANSPORT_LIST_VIEW); müşteri erişemez. Veriler Yüklemeler sayfasıyla aynı sorgulardan, role göre temizlenmiş gelir
// (lib/loading.ts → loadDay): satışta firma adı maskeli. Firma bazlı özet ekrandaki firma tablosuyla AYNI hesaptan (firmsOfDay —
// ticari değerler siparişin sahibinde, sandık / ağırlık sandığın sahibinde); tutar sütunları yetkiye göre: fabrika satış
// (yönetici, satış), teklif (yönetici, denetimci). Satır dökümünde rolün görebildiği fiyat (yönetici / denetimci müşteri fiyatı,
// satış satış fiyatı). "Sandık (Fiziksel)" sütunu yoktur; fiziksel sandık ilişkisi ayrı tablodadır. Dosya adı panel dilinde.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'TRANSPORT_LIST_VIEW')) return new Response(t('common.fileNotFound'), { status: 403 });
  const day = new URL(req.url).searchParams.get('gun') ?? '';
  if (!parseDateOnly(day)) return new Response(t('loading.transport.badDay'), { status: 400 });
  const data = await loadDay(user, day);
  const money = moneyView(user);
  const entries = data.rows.map((o) => dayEntry(o, { customer: false, money }));
  const { firms, total } = firmsOfDay(user, entries, data.crates, data.guests, data.hostNames);
  const dmy = (k: string) => fmtDate(`${k}T12:00:00Z`);
  // Satır dökümü: aktarılan kalan satırında "… yüklemesinden aktarıldı" notu (karar 102)
  const lines = buildLoadingSummary(
    data.rows.map((o) => (o.replan ? { ...o, title: [o.title, t('loading.replan.from', { date: dmy(o.replan.fromDay) })].filter(Boolean).join(' · ') } : o)),
    { priceOf: (l) => (userCan(user, 'OFFER_SEND') ? l.offerPrice : l.unitPrice) },
  );
  // Misafir yük (fiziksel sandık ilişkisi): ticari sahip ve sandığın sahibi ayrı sütunlarda — adlar role göre maskeli
  const guests = firms.flatMap((f) => f.rows.filter((r) => r.guest).map((r) => ({
    orderNo: r.entry.orderNo, owner: f.name, host: r.guest!.hostName,
    crate: r.guest!.crateNo != null ? `#${r.guest!.crateNo}` : t('loading.summary.guestWaiting'),
  })));
  const finalPrice = userCan(user, 'OFFER_SEND') || userCan(user, 'PRICE_FINAL_VIEW');
  const sheets = loadingSummarySheets({
    subtitle: exportSubtitle(t, t('loading.summary.dayLine', { date: dmy(day) })),
    stats: [
      [t('loading.summary.orders'), total.orders],
      [t('loading.summary.lines'), lines.offerLines],
      [t('loading.summary.glassKg'), `${Math.round(total.netKg)} kg`],
      [t('loading.summary.crates'), total.crates],
      [t('loading.summary.grossKg'), `${Math.round(total.grossKg)} kg`],
      [t('loading.summary.ops'), t('loading.summary.opsIncluded')],
      [t('loading.summary.price'), finalPrice ? t('loading.summary.priceFinal') : t('loading.summary.priceSales')],
      [t('loading.summary.currency'), Object.keys(lines.totals).join(', ') || '—'],
    ],
    firms, total: { ...total, name: t('loading.summary.total') }, guests, lines, money,
    text: {
      title: `${t('loading.summary.title')} · ${dmy(day)}`, linesTitle: `${t('loading.summary.linesTitle')} · ${dmy(day)}`,
      sheetFirms: t('loading.summary.sheetFirms'), sheetLines: t('loading.summary.sheetLines'), firmsTitle: t('loading.summary.firmsTitle'),
      guestTitle: t('loading.summary.guestTitle'), guestNone: t('loading.summary.guestNone'), total: t('loading.summary.total'), unit: 'm²',
      currency: t('loading.summary.currency'),
      cols: [t('loading.summary.colOrder'), t('loading.summary.colCustomer'), t('loading.summary.colProject'), t('loading.summary.colGlass'),
        t('loading.summary.colQty'), t('loading.summary.colUnit'), t('loading.summary.colM2'), t('loading.summary.colPrice'), t('loading.summary.colAmount')],
      firmCols: {
        firm: t('loading.firm.cols.firm'), orders: t('loading.firm.cols.orders'), glass: t('loading.firm.cols.glass'), cnc: t('loading.firm.cols.cnc'),
        holes: t('loading.firm.cols.holes'), m2: t('loading.firm.cols.m2'), net: t('loading.firm.cols.net'), crates: t('loading.firm.cols.crates'),
        gross: t('loading.firm.cols.gross'), factory: t('loading.firm.cols.factory'), offer: t('loading.firm.cols.offer'),
      },
      guestCols: {
        order: t('loading.summary.guestCols.order'), owner: t('loading.summary.guestCols.owner'),
        host: t('loading.summary.guestCols.host'), crate: t('loading.summary.guestCols.crate'),
      },
    },
  });
  const body = writeReportXlsx({ sheets });
  await audit('LOADING_SUMMARY_EXPORT', 'Loading', day, user.id, { orders: total.orders });
  return new Response(new Uint8Array(body), { headers: downloadHeaders(exportName(t, 'loadingSummary', [day], 'xlsx'), 'xlsx') });
}
