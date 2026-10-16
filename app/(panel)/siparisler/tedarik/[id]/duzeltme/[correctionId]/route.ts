import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { downloadHeaders, exportName } from '@/lib/exports';
import { buildCorrectionPdf } from '@/server/suppliers/receipt-mail.js';

export const dynamic = 'force-dynamic';

// Mal kabulü düzeltmesinin belgesi (3.91.0, karar 286): CORECȚIE RECEPȚIE — düzeltmenin KOPYASINDAN Romence PDF, her
// istekte yeniden üretilir. Orijinal kabulün belgesi değişmez. Yalnızca SUPPLIER_MANAGE; düzeltme bu siparişin değilse 404.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; correctionId: string }> }) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'SUPPLIER_MANAGE')) return new Response(t('common.fileNotFound'), { status: 404 });
  const { id, correctionId } = await ctx.params;
  const pdf = await buildCorrectionPdf(db, correctionId);
  if (!pdf || pdf.correction.orderId !== id) return new Response(t('common.fileNotFound'), { status: 404 });
  await audit('SUPPLIER_RECEIPT_CORRECTION_VIEW', 'SupplierOrder', id, user.id, { orderNo: pdf.orderNo, receiptSeq: pdf.receipt.seq, seq: pdf.correction.seq, correctionId: pdf.correction.id });
  const name = exportName(t, 'goodsReceiptCorrection', [pdf.orderNo, String(pdf.receipt.seq), String(pdf.correction.seq)], 'pdf');
  return new Response(new Uint8Array(pdf.buf), { headers: downloadHeaders(name, 'pdf', { inline: true }) });
}
