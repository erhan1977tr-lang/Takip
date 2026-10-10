import { fxOfferNote } from '@/lib/fx-note';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { lineKindText } from '@/lib/labels';
import { fmtDate, fmtM2 } from '@/lib/format';
import { currentOffer, orderDetailInclude, orderScope, sanitizeOrder, sentOffer } from '@/lib/orders';
import { audit } from '@/lib/audit';
import { canExportOffer, offerExportData, offerXlsx } from '@/server/orders/offer-export.js';
import { offerPdf } from '@/server/pdf/offer.js';
import { compensationTagText, loadCompensationTags, physicalVsBillable } from '@/server/orders/compensation-tag.js';
import { downloadHeaders, exportName } from '@/lib/exports';

export const dynamic = 'force-dynamic';

// GET /siparisler/<id>/teklif?format=pdf|xlsx — cam siparişinin teklifi. Yönetici (OFFER_SEND): son teklif, müşteri
// fiyatlarıyla; PDF ve Excel her zaman. Müşteri (OFFER_EXPORT): yalnızca kendisine gönderilmiş teklif; PDF her zaman,
// Excel yalnızca yönetici siparişte izin verdiyse (Order.customerExcel) — aksi hâlde 403 (düğmeyi gizlemek yetmez).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const { t, locale } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  const { id } = await ctx.params;
  const format = new URL(req.url).searchParams.get('format') === 'xlsx' ? 'xlsx' : 'pdf';
  const raw = await db.order.findFirst({ where: { id, orderTypeCode: 'GLASS_ORDER', ...orderScope(user) }, include: orderDetailInclude });
  if (!raw) return new Response(t('common.fileNotFound'), { status: 404 });
  const isAdmin = userCan(user, 'OFFER_SEND');
  if (!canExportOffer(format, { canExport: userCan(user, 'OFFER_EXPORT'), isAdmin, customerExcel: raw.customerExcel })) {
    return new Response(t('offer.export.denied'), { status: 403 });
  }
  const order = sanitizeOrder(user, raw);
  const offer = isAdmin ? currentOffer(order) : sentOffer(order);
  if (!offer) return new Response(t('common.fileNotFound'), { status: 404 });

  // Telafi etiketi (karar 231): gerçek telafi numarası cam türünün üstünde
  const tags = await loadCompensationTags(db, offer.lines);
  const tagTexts = { newText: t('compensation.tag.new'), existingText: t('compensation.tag.existing') };
  const data = offerExportData({
    lines: offer.lines,
    tagOf: (l) => (l.compensationId ? compensationTagText(tags.get(l.compensationId) ?? null, tagTexts) : null),
    // Yalnızca müşteri fiyatı: yönetici → offerPrice; müşteride temizlenmiş unitPrice zaten müşteri fiyatıdır
    price: (l) => (isAdmin ? l.offerPrice : l.unitPrice),
    locale, kindLabel: (k) => lineKindText(t, k as string),
  });
  const pvb = physicalVsBillable(offer.lines);
  const physicalText = t('offer.physical', {
    pieces: pvb.physical.pieces, m2: fmtM2(pvb.physical.m2), bPieces: pvb.billable.pieces, bM2: fmtM2(pvb.billable.m2), fPieces: pvb.free.pieces, fM2: fmtM2(pvb.free.m2),
  });
  const text = {
    title: t('offer.export.title'), orderNo: order.orderNo, firm: order.customer.name,
    date: fmtDate(offer.sentAt ?? offer.createdAt), currency: offer.currency,
    notes: [
      // Bedelsiz telafi varsa: fiziksel ve faturalanacak cam ayrı (karar 231)
      ...(pvb.free.pieces > 0 ? [physicalText] : []),
      t('common.pricesExclVat'), ...(offer.currency === 'EUR' ? [fxOfferNote(t, raw.customer.fxPolicy)] : []),
    ],
    cols: {
      n: '#', desc: t('offer.cols.description'), poz: t('offer.cols.poz'), en: t('offer.cols.widthMm'), boy: t('offer.cols.heightMm'),
      adet: t('offer.cols.qty'), m2: t('offer.cols.metraj'), unitPrice: t('offer.cols.unitPrice'), amount: t('offer.cols.amount'),
    },
    free: t('offer.free'), total: t('common.total'), piece: t('common.unitPiece'),
  };
  const body = format === 'xlsx' ? offerXlsx(data, text) : offerPdf(data, text);
  await audit('OFFER_EXPORT', 'Order', order.id, user.id, { format, offerId: offer.id });
  // Dosya adı panel dilinde (Paket 7): "Teklif-GLA68.pdf" / "Oferta-GLA68.xlsx"
  return new Response(new Uint8Array(body), { headers: downloadHeaders(exportName(t, 'offer', [order.orderNo], format), format) });
}
