import { getCurrentUser } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { fxOfferNote } from '@/lib/fx-note';
import { audit } from '@/lib/audit';
import { canSeeOfferReport, loadOfferReport } from '@/lib/customer-offers';
import { offerReportFileName } from '@/server/orders/customer-offers.js';
import { offerSummaryPdf } from '@/server/pdf/offer-summary.js';
import { contentDisposition } from '@/server/files/export-name.js';

export const dynamic = 'force-dynamic';

// GET /teklifler/pdf?bas=YYYY-MM-DD&bit=YYYY-MM-DD — "Tekliflerim" dökümü (karar 164): müşteri kullanıcısının KENDİ
// firmasının cam teklifleri (müşteriye gönderilmiş son sürüm, gönderildiği gün aralıkta), her teklif ayrı ve ayrıntılı,
// sonda toplam m² ve toplam tutar. Yalnızca müşteri kullanıcısı (User.type = CUSTOMER) + OFFER_EXPORT; başkasına 404.
// Fiyatlar müşteri fiyatıdır (lib/customer-offers.ts → sanitizeRows); dosya adı seçili panel dilinde.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  const { t, locale } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!canSeeOfferReport(user)) return new Response(t('common.fileNotFound'), { status: 404 });
  const sp = new URL(req.url).searchParams;
  const res = await loadOfferReport(user, { bas: sp.get('bas') ?? undefined, bit: sp.get('bit') ?? undefined }, t, locale);
  if (!res.ok) return new Response(t(`offers.report.errors.${res.code}` as MsgKey), { status: 400 });
  if (res.tooMany) return new Response(t('offers.report.errors.TOO_MANY'), { status: 400 });
  const { report } = res;
  const currencies = new Set(report.sections.map((s) => s.currency));
  const text = {
    title: t('offers.report.pdfTitle'),
    firm: user.customer?.name ?? '',
    range: `${fmtDate(`${res.from}T12:00:00Z`)} – ${fmtDate(`${res.to}T12:00:00Z`)}`,
    generated: t('offers.report.generated', { date: fmtDate(new Date()) }),
    offerDate: t('offers.customer.cols.date'),
    version: t('offers.report.version'),
    cols: {
      // Dar sütunlar: ölçüler mm'dir (teklif PDF'indeki "(mm)" ekli başlık bu sütuna sığmıyordu)
      n: '#', desc: t('offer.cols.description'), poz: t('offer.cols.poz'), en: t('offer.cols.width'), boy: t('offer.cols.height'),
      adet: t('offer.cols.qty'), m2: t('offer.cols.metraj'), unitPrice: t('offer.cols.unitPrice'), amount: t('offer.cols.amount'),
    },
    free: t('offer.free'), piece: t('common.unitPiece'), subtotal: t('offers.report.subtotal'), grandTotal: t('offers.report.grandTotal'),
    count: t('offers.report.count'), empty: t('offers.report.empty'),
    notes: [t('common.pricesExclVat'), ...(currencies.has('EUR') ? [fxOfferNote(t, user.customer?.fxPolicy)] : [])],
  };
  const body = offerSummaryPdf(report, text);
  await audit('OFFER_REPORT_EXPORT', 'Customer', user.customerId, user.id, { from: res.from, to: res.to, offers: report.sections.length });
  const name = offerReportFileName(t('exports.names.offerReport'), res);
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
