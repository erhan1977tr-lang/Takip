// Müşteri proformasına (toplu proforma) elle ödeme kaydı — proforma satırından (karar 326, ürün sahibi 23.11.2026).
//
// Kayıt mevcut tek yazıcıyla yazılır (recordManualPayment, karar 206): aynı doğrulama, kur, aynı müşteride aynı tutar
// denetimi ve tek kullanımlık anahtar. ManualPayment.orderId zorunlu olduğundan kayıt partinin bir siparişine bağlanır
// ("taşıyıcı"): partide etkin, iptal / silinmemiş ilk sipariş (sipariş numarası sırasıyla). Zincir yine partidir
// (batchId) — hesap (chainState, paymentState) siparişe değil proformaya göre yapılır. Belge kesilmez; avans faturası
// ayrıca (yöneticinin düğmesi; FGO'da görünen tahsilattan da otomatik — server/glass/auto-advance.js).

import { can } from '../auth/permissions.js';
import { sortByOrderNo } from '../orders/order-number.js';
import { recordManualPayment } from './service.js';

const FORBIDDEN = { ok: false, code: 'FORBIDDEN' };

/**
 * Taşıyıcı sipariş: kesilmiş müşteri proformasının etkin, iptal / silinmemiş ilk siparişi.
 * @param {any} db  @param {string} batchId
 * @returns {Promise<{ ok: true, orderId: string, orderNo: string } | { ok: false, code: string }>}
 */
export async function batchPaymentCarrier(db, batchId) {
  const b = await db.billingBatch.findUnique({
    where: { id: String(batchId ?? '') },
    select: { kind: true, status: true, document: { select: { id: true } }, orders: { where: { activeKey: { not: null } }, select: { orderId: true, orderNo: true, order: { select: { status: true, removedAt: true } } } } },
  });
  if (!b || b.kind !== 'PROFORMA') return { ok: false, code: 'NOT_FOUND' };
  if (b.status !== 'ISSUED' || !b.document) return { ok: false, code: 'NO_PROFORMA' };
  const live = sortByOrderNo(b.orders.filter((o) => o.order.status !== 'IPTAL' && !o.order.removedAt), (o) => o.orderNo);
  if (live.length === 0) return { ok: false, code: 'ORDER_STATE' };
  return { ok: true, orderId: live[0].orderId, orderNo: live[0].orderNo };
}

/**
 * Proforma satırından elle ödeme: yetki → taşıyıcı → recordManualPayment (kayıt partinin zincirine yazılır).
 * @param {any} db
 * @param {{ batchId: string, input: Record<string, unknown>, requestKey: unknown, ack?: string | null, actor: any, now?: Date }} p
 */
export async function recordBatchPayment(db, { batchId, input, requestKey, ack = null, actor, now = new Date() }) {
  if (!can(actor?.role, 'ACCOUNTING_MANAGE')) return FORBIDDEN;
  const carrier = await batchPaymentCarrier(db, batchId);
  if (!carrier.ok) return carrier;
  // Siparişin etkin müşteri proforması tektir (activeKey benzersiz): loadChain kaydı bu partinin zincirine (batchId) yazar
  return recordManualPayment(db, { orderId: carrier.orderId, input, requestKey, ack, actor, now });
}
