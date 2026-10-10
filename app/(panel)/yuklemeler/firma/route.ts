import { getCurrentUser } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { db } from '@/lib/db';
import { canFirmDocs, customerPriceOf, dayEntry, firmsOfDay, loadDay, moneyView } from '@/lib/loading';
import { fmtDate, fmtM2, fmtNum } from '@/lib/format';
import { fxOfferNote } from '@/lib/fx-note';
import { downloadHeaders, exportName, exportSubtitle } from '@/lib/exports';
import { parseDateOnly } from '@/server/orders/rules.js';
import { firmExportData, firmExportSheets } from '@/server/loading/firm-export.js';
import { writeReportXlsx } from '@/server/files/xlsx-report.js';
import { firmLoadingPdf } from '@/server/pdf/firm-loading.js';

export const dynamic = 'force-dynamic';

// GET /yuklemeler/firma?gun=YYYY-MM-DD&firma=<firma>&bicim=pdf|xlsx — firma satırının "PDF" / "Excel" çıktısı (Paket 7,
// karar 187; ayrıntı karar 215): YALNIZCA seçilen firmanın o günkü siparişleri, her siparişin teklif satırları ve firmanın
// sandıkları. Kim: canFirmDocs (yükleme belgelerini indiren + müşteri fiyatını gören rol: yönetici, salt okuyan denetimci);
// satış, müşteri ve çizim 403 (satış firma satırında yalnızca "Sandık"ı görür). Firma o gün görünür değilse 404 (başka firmanın
// verisi dönmez). Finansal olarak yalnızca müşteri teklif tutarı ve yalnızca müşteriye gönderilmiş teklifte; fabrika satış
// tutarı hiçbir rolde bu çıktılara girmez. PDF ve Excel aynı veriden (firmExportData): kapsam ve tutarlar birebir aynı.
// Firma adı tam (bu rollerde maske yok); başka firmanın adı yazılmaz. Dosya adı panel dilinde ve firma koduyla: "Yukleme-GLA-2026-10-08.pdf".
export async function GET(req: Request) {
  const user = await getCurrentUser();
  const { t, locale } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!canFirmDocs(user)) return new Response(t('common.fileNotFound'), { status: 403 });
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
  const kindLabel = (k: string) => t(`status.lineKind.${k}` as MsgKey);
  const d = firmExportData(firm, { offer: money.offer, price: customerPriceOf(user), locale, kindLabel });
  const dmy = fmtDate(`${day}T12:00:00Z`);
  const stats: [string, string][] = [
    [t('loading.firmExport.stats.orders'), String(firm.orders)],
    [t('loading.firmExport.stats.glass'), String(firm.camAdet)],
    [t('loading.firmExport.stats.cnc'), String(firm.cnc)],
    [t('loading.firmExport.stats.holes'), String(firm.delik)],
    [t('loading.firmExport.stats.m2'), `${fmtM2(firm.metraj)} m²`],
    [t('loading.firmExport.stats.net'), `${fmtNum(firm.netKg, 0)} kg`],
    [t('loading.firmExport.stats.crates'), `${firm.crates}${firm.realCrates || firm.crates === 0 ? '' : ` (${t('loading.firmExport.estimated')})`}`],
    [t('loading.firmExport.stats.gross'), `${fmtNum(firm.grossKg, 0)} kg`],
  ];
  // Misafir yük: yalnızca sandık numarası (başka firmanın adı yazılmaz — çıktı müşteriyle paylaşılabilir)
  const guestNotes = d.orders.filter((o) => o.guest).map((o) => t('loading.firmExport.guestNote', {
    order: o.orderNo, crate: o.guestCrate != null ? t('loading.guest.crateNo', { no: o.guestCrate }) : t('loading.firmExport.guestWaiting'),
  }));
  // EUR teklifin kur notu müşterinin kur politikasından (yüzde hiçbir zaman yazılmaz — karar 99)
  const fx = d.currencies.includes('EUR') ? fxOfferNote(t, (await db.customer.findUnique({ where: { id: firm.id }, select: { fxPolicy: true } }))?.fxPolicy) : null;
  const notes = [...guestNotes, t('loading.firmExport.physicalNote'), ...(d.currencies.length ? [t('common.pricesExclVat')] : []), ...(fx ? [fx] : [])];
  const cols = {
    order: t('loading.firmExport.cols.order'), project: t('loading.firmExport.cols.project'), glass: t('loading.firmExport.cols.glass'),
    cnc: t('loading.firmExport.cols.cnc'), holes: t('loading.firmExport.cols.holes'), m2: t('loading.firmExport.cols.m2'), offer: t('loading.firmExport.cols.offer'),
    crate: t('loading.firmExport.cols.crate'), dims: t('loading.firmExport.cols.dims'), net: t('loading.firmExport.cols.net'), gross: t('loading.firmExport.cols.gross'),
    orders: t('loading.firmExport.cols.orders'), note: t('loading.firmExport.cols.note'),
    // Ayrıntı (teklif satırları): teklif PDF'iyle aynı başlıklar — ölçüler mm
    n: '#', desc: t('offer.cols.description'), poz: t('offer.cols.poz'), en: t('offer.cols.width'), boy: t('offer.cols.height'),
    adet: t('offer.cols.qty'), unitPrice: t('offer.cols.unitPrice'), amount: t('offer.cols.amount'),
  };
  const title = t('loading.firmExport.title');
  const dayText = t('loading.summary.dayLine', { date: dmy });
  const code = firm.rows[0]?.entry.o.customer.prefix ?? '';
  const name = exportName(t, 'firmLoading', [code, day], format);
  const detail = {
    detailTitle: t('loading.firmExport.detailTitle'), subtotal: t('loading.firmExport.subtotal'), free: t('offer.free'), piece: t('common.unitPiece'),
    notSent: t('loading.firmExport.notSent'), replanNote: t('loading.firmExport.replanNote'),
  };
  const body = format === 'xlsx'
    ? writeReportXlsx({
      sheets: firmExportSheets(d, {
        title: `${title} · ${firm.name} · ${dmy}`, subtitle: exportSubtitle(t, dayText), sheet: t('loading.firmExport.sheet'),
        detailSheet: t('loading.firmExport.detailSheet'), detailTitle: `${t('loading.firmExport.detailTitle')} · ${firm.name} · ${dmy}`,
        ordersTitle: t('loading.firmExport.ordersTitle'), cratesTitle: t('loading.firmExport.cratesTitle'), total: t('common.total'),
        noCrates: t('loading.firmExport.noCrates'), noOrders: t('loading.firmExport.noOrders'), free: detail.free, currency: t('loading.summary.currency'),
        replanNote: detail.replanNote,
        info: [[t('loading.firmExport.firm'), firm.name], [t('loading.firmExport.day'), dmy], ...stats], notes, cols,
      }),
    })
    : firmLoadingPdf(d, {
      title, firm: firm.name, day: dayText, generated: t('exports.generated', { date: fmtDate(new Date()) }),
      ordersTitle: t('loading.firmExport.ordersTitle'), cratesTitle: t('loading.firmExport.cratesTitle'), total: t('common.total'),
      noOrders: t('loading.firmExport.noOrders'), noCrates: t('loading.firmExport.noCrates'), stats, notes, cols, ...detail,
    });
  await audit('LOADING_FIRM_EXPORT', 'Customer', firm.id, user.id, {
    day, format, orders: firm.orders, lines: d.orders.reduce((s, o) => s + o.detail.rows.length, 0), offerAmounts: d.currencies.length > 0,
  });
  return new Response(new Uint8Array(body), { headers: downloadHeaders(name, format) });
}
