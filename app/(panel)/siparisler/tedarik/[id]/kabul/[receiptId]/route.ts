import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { downloadHeaders, exportName } from '@/lib/exports';
import { buildReceiptPdf } from '@/server/suppliers/receipt-mail.js';

export const dynamic = 'force-dynamic';

// Mal kabulünün INTRAREA MARFĂ belgesi (3.87.0, karar 282): kabulün KOPYASINDAN Romence PDF, her istekte yeniden üretilir
// (aynı içerik). Yalnızca SUPPLIER_MANAGE (yönetici, yönetici yardımcısı); diğer herkese 404. Kabul bu siparişin değilse 404.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; receiptId: string }> }) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'SUPPLIER_MANAGE')) return new Response(t('common.fileNotFound'), { status: 404 });
  const { id, receiptId } = await ctx.params;
  const pdf = await buildReceiptPdf(db, receiptId);
  if (!pdf || pdf.receipt.orderId !== id) return new Response(t('common.fileNotFound'), { status: 404 });
  await audit('SUPPLIER_RECEIPT_VIEW', 'SupplierOrder', id, user.id, { orderNo: pdf.orderNo, seq: pdf.receipt.seq, receiptId: pdf.receipt.id });
  const name = exportName(t, 'goodsReceipt', [pdf.orderNo, String(pdf.receipt.seq)], 'pdf');
  return new Response(new Uint8Array(pdf.buf), { headers: downloadHeaders(name, 'pdf', { inline: true }) });
}
