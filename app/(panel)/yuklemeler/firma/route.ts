import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { dayEntry, firmsOfDay, loadDay, moneyView } from '@/lib/loading';
import { fmtDate, fmtNum } from '@/lib/format';
import { downloadHeaders, exportName, exportSubtitle } from '@/lib/exports';
import { parseDateOnly } from '@/server/orders/rules.js';
import { firmExportData, firmExportSheet } from '@/server/loading/firm-export.js';
import { writeReportXlsx } from '@/server/files/xlsx-report.js';
import { firmLoadingPdf } from '@/server/pdf/firm-loading.js';

export const dynamic = 'force-dynamic';

// GET /yuklemeler/firma?gun=YYYY-MM-DD&firma=<firma>&bicim=pdf|xlsx — firma satırının "PDF" / "Excel" çıktısı (Paket 7,
// karar 187): YALNIZCA seçilen firmanın o günkü siparişleri ve sandıkları. İç ekip (yönetici, satış, denetimci:
// TRANSPORT_LIST_VIEW); müşteri ve çizim erişemez (403). Firma o gün görünür değilse 404 (başka firmanın verisi dönmez).
// Finansal olarak yalnızca müşteri teklif tutarı — o tutarı görebilen rolde (yönetici, denetimci); fabrika satış tutarı hiçbir
// rolde bu çıktılara girmez; satışın çıktısında tutar yoktur. Firma adı role göre maskeli (satış: ilk 3 karakter + 10 yıldız);
// başka firmanın adı yazılmaz. Dosya adı panel dilinde ve firma koduyla: "Yukleme-GLA-2026-10-08.pdf".
export async function GET(req: Request) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'TRANSPORT_LIST_VIEW')) return new Response(t('common.fileNotFound'), { status: 403 });
  const sp = new URL(req.url).searchParams;
  const day = sp.get('gun') ?? '';
  const firmId = sp.get('firma') ?? '';
  const format = sp.get('bicim') === 'xlsx' ? 'xlsx' : 'pdf';
  if (!parseDateOnly(day)) return new Response(t('loading.transport.badDay'), { status: 400 });
  const data = await loadDay(user, day);
  const money = moneyView(user);
  const entries = data.rows.map((o) => dayEntry(o, { customer: false, money }));
  const firm = firmsOfDay(user, entries, data.crates, data.guests, data.hostNames).firms.find((f) => f.id === firmId);
  if (!firm) return new Response(t('common.fileNotFound'), { status: 404 });

  // Yalnızca teklif tutarı (görebilen rolde); fabrika satış tutarı çıktıya hiç girmez
  const d = firmExportData(firm, { offer: money.offer });
  const dmy = fmtDate(`${day}T12:00:00Z`);
  const stats: [string, string][] = [
    [t('loading.firmExport.stats.orders'), String(firm.orders)],
    [t('loading.firmExport.stats.glass'), String(firm.camAdet)],
    [t('loading.firmExport.stats.cnc'), String(firm.cnc)],
    [t('loading.firmExport.stats.holes'), String(firm.delik)],
    [t('loading.firmExport.stats.m2'), `${fmtNum(firm.metraj)} m²`],
    [t('loading.firmExport.stats.net'), `${fmtNum(firm.netKg, 0)} kg`],
    [t('loading.firmExport.stats.crates'), `${firm.crates}${firm.realCrates || firm.crates === 0 ? '' : ` (${t('loading.firmExport.estimated')})`}`],
    [t('loading.firmExport.stats.gross'), `${fmtNum(firm.grossKg, 0)} kg`],
  ];
  // Misafir yük: yalnızca sandık numarası (başka firmanın adı yazılmaz — çıktı müşteriyle paylaşılabilir)
  const guestNotes = d.orders.filter((o) => o.guest).map((o) => t('loading.firmExport.guestNote', {
    order: o.orderNo, crate: o.guestCrate != null ? t('loading.guest.crateNo', { no: o.guestCrate }) : t('loading.firmExport.guestWaiting'),
  }));
  const notes = [...guestNotes, t('loading.firmExport.physicalNote'), ...(d.currencies.length ? [t('common.pricesExclVat')] : [])];
  const cols = {
    order: t('loading.firmExport.cols.order'), project: t('loading.firmExport.cols.project'), glass: t('loading.firmExport.cols.glass'),
    cnc: t('loading.firmExport.cols.cnc'), holes: t('loading.firmExport.cols.holes'), m2: t('loading.firmExport.cols.m2'), offer: t('loading.firmExport.cols.offer'),
    crate: t('loading.firmExport.cols.crate'), dims: t('loading.firmExport.cols.dims'), net: t('loading.firmExport.cols.net'), gross: t('loading.firmExport.cols.gross'),
    orders: t('loading.firmExport.cols.orders'), note: t('loading.firmExport.cols.note'),
  };
  const title = t('loading.firmExport.title');
  const dayText = t('loading.summary.dayLine', { date: dmy });
  const code = firm.rows[0]?.entry.o.customer.prefix ?? '';
  const name = exportName(t, 'firmLoading', [code, day], format);
  const body = format === 'xlsx'
    ? writeReportXlsx({
      sheets: [firmExportSheet(d, {
        title: `${title} · ${firm.name} · ${dmy}`, subtitle: exportSubtitle(t, dayText), sheet: t('loading.firmExport.sheet'),
        ordersTitle: t('loading.firmExport.ordersTitle'), cratesTitle: t('loading.firmExport.cratesTitle'), total: t('common.total'),
        noCrates: t('loading.firmExport.noCrates'), noOrders: t('loading.firmExport.noOrders'),
        info: [[t('loading.firmExport.firm'), firm.name], [t('loading.firmExport.day'), dmy], ...stats], notes, cols,
      })],
    })
    : firmLoadingPdf(d, {
      title, firm: firm.name, day: dayText, generated: t('exports.generated', { date: fmtDate(new Date()) }),
      ordersTitle: t('loading.firmExport.ordersTitle'), cratesTitle: t('loading.firmExport.cratesTitle'), total: t('common.total'),
      noOrders: t('loading.firmExport.noOrders'), noCrates: t('loading.firmExport.noCrates'), stats, notes, cols,
    });
  await audit('LOADING_FIRM_EXPORT', 'Customer', firm.id, user.id, { day, format, orders: firm.orders, offerAmounts: d.currencies.length > 0 });
  return new Response(new Uint8Array(body), { headers: downloadHeaders(name, format) });
}
