// Müşteri üretim onayı — talebin müşteriye İLETİLMESİ (4.2.5, ürün sahibinin 27.10.2026 kararı).
//
// Süre, talep müşteriye gerçekten iletildiği andan başlar. Talep (teklif gönderimi / güncellemesi / mevcut sipariş için
// geçiş) giden kuyruğa olay yazar (payload.approval.offerId); bu modül e-posta işçisinin (server/notifications/email.js →
// dispatchNotifications) içinden çağrılır:
//   - e-posta posta sunucusuna en az BİR müşteri adresi için kabul edildi → Offer.approvalDeliveredAt = o an,
//     approvalDueAt = o andan itibaren 2 Romanya iş günü, kanal EMAIL (e-postadaki son tarih aynı andan hesaplanır)
//   - müşteriye e-posta gidemiyor (bildirim tercihi kapalı / geçerli adres yok) ama uygulama içi bildirim müşterinin etkin
//     kullanıcısına yazıldı → iletim = bildirimin yazıldığı an, kanal IN_APP (müşterinin tercihine uyulur)
//   - e-posta bütün denemelerden sonra gönderilemedi ya da müşteriye hiçbir yoldan ulaşılamadı → süre BAŞLAMAZ:
//     Offer.approvalDeliveryError (EMAIL_FAILED | NO_RECIPIENT) + yöneticiye uygulama içi bildirim (sürüm + hata başına bir kez).
//     Müşteri panelden yine onaylayabilir; yönetici talebi yeniden gönderebilir (resend_approval_request).
// Yazımlar koşulludur: iletim bir kez yazılır (ilk başarılı iletim); daha yeni sürüm, onay ya da değişiklik talebi varsa
// yazılmaz. Hatırlatma olayı (ORDER_PRODUCTION_APPROVAL_REMINDER) iletimi değiştirmez, saklanan son tarihi kullanır.
import { approvalDeadline } from './production-approval.js';

/** Onay talebi taşıyan olaylar (iletim bunlardan başlar) */
export const APPROVAL_REQUEST_TYPES = Object.freeze(['ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED', 'ORDER_PRODUCTION_APPROVAL_REQUESTED']);
/** Müşteriye tek hatırlatma (production-approval-service.js → remindApprovalCustomers) */
export const APPROVAL_REMINDER_TYPE = 'ORDER_PRODUCTION_APPROVAL_REMINDER';
export const DELIVERY_ERRORS = Object.freeze(['EMAIL_FAILED', 'NO_RECIPIENT']);

const OFFER = { id: true, orderId: true, status: true, approvalRequestedAt: true, approvalDeliveredAt: true, approvalDueAt: true, approvedAt: true, changeRequestedAt: true };

/** Olayın onay sürümü (yoksa null): yalnızca onay taşıyan türlerde, kimlik biçimi doğrulanır */
export function approvalOfferId(type, payload) {
  if (!APPROVAL_REQUEST_TYPES.includes(type) && type !== APPROVAL_REMINDER_TYPE) return null;
  const a = payload?.approval;
  return a && typeof a === 'object' && typeof a.offerId === 'string' && /^[a-z0-9]{8,40}$/i.test(a.offerId) ? a.offerId : null;
}

/**
 * E-postada gösterilecek son tarih: iletim yazıldıysa saklanan son tarih; yazılmadıysa şimdi iletilirse oluşacak son tarih
 * (markDelivered aynı anı yazar). Sürüm artık güncel / bekleyen değilse null (e-posta yine gider; son tarih satırı "belirlenemedi").
 * @returns {Promise<null | { offerId: string, due: Date | null, noData: boolean, delivered: boolean, open: boolean }>}
 */
export async function approvalForMail(db, offerId, at) {
  if (!offerId) return null;
  const o = await db.offer.findUnique({ where: { id: offerId }, select: OFFER });
  if (!o) return null;
  const open = o.status === 'GONDERILDI' && !o.approvedAt && !o.changeRequestedAt;
  if (o.approvalDeliveredAt) return { offerId, due: o.approvalDueAt, noData: !o.approvalDueAt, delivered: true, open };
  const d = approvalDeadline(at);
  return { offerId, due: d.due, noData: d.noData, delivered: false, open };
}

/**
 * Talep iletildi: bir kez (koşullu). Sürüm hâlâ gönderilmiş ve karara bağlanmamış olmalı; aynı siparişte daha yeni sürüm
 * varsa yazılmaz (eski sürümün süresi başlamaz).
 * @returns {Promise<boolean>} yazıldı mı
 */
export async function markDelivered(db, { offerId, at, due, channel }) {
  const o = await db.offer.findUnique({ where: { id: offerId }, select: { orderId: true, createdAt: true } });
  if (!o) return false;
  const newer = await db.offer.count({ where: { orderId: o.orderId, createdAt: { gt: o.createdAt } } });
  if (newer) return false;
  const r = await db.offer.updateMany({
    where: { id: offerId, status: 'GONDERILDI', approvalDeliveredAt: null, approvedAt: null, changeRequestedAt: null, approvalRequestedAt: { not: null } },
    data: { approvalDeliveredAt: at, approvalDueAt: due ?? null, approvalDeliveryChannel: channel, approvalDeliveryError: null, approvalDeliveryFailedAt: null },
  });
  return r.count === 1;
}

/**
 * Talep iletilemedi: süre başlamaz. Hata kodu sürüme yazılır (iletim yoksa) ve yöneticiye uygulama içi bildirim gider
 * (sürüm + olay başına bir kez — bildirimin benzersiz anahtarı). Bildirim hatası işlemi düşürmez.
 */
export async function markUndelivered(db, { offerId, orderId, code, outboxId, now = new Date() }) {
  if (!DELIVERY_ERRORS.includes(code)) return false;
  const r = await db.offer.updateMany({
    where: { id: offerId, status: 'GONDERILDI', approvalDeliveredAt: null, approvedAt: null, changeRequestedAt: null },
    data: { approvalDeliveryError: code, approvalDeliveryFailedAt: now },
  });
  if (r.count !== 1) return false;
  try {
    const { notifyStaff } = await import('../notifications/inapp.js');
    await notifyStaff(db, {
      audience: 'admin', key: `approval-undelivered:${offerId}:${outboxId}`, type: 'PRODUCTION_APPROVAL_UNDELIVERED', orderId,
      params: { ref: code }, link: `/siparisler/${orderId}#uretim-onayi`,
    });
  } catch {
    // bildirim yazılamadı: sürümdeki hata kaydı yeter (sipariş sayfasında görünür)
  }
  return true;
}

/**
 * E-posta alıcısı yok (tercih / adres): müşterinin etkin kullanıcısına bu olayın uygulama içi bildirimi yazıldıysa iletim
 * odur. Bildirim henüz yazılmadıysa (işçi turu) null — olay bir sonraki turda yeniden değerlendirilir.
 * @returns {Promise<Date | null>}
 */
export async function inAppDeliveredAt(db, { outboxId, customerId }) {
  const n = await db.notification.findFirst({
    where: { dedupeKey: `outbox:${outboxId}`, user: { customerId, type: 'CUSTOMER', isActive: true } },
    orderBy: { createdAt: 'asc' }, select: { createdAt: true },
  });
  return n?.createdAt ?? null;
}
