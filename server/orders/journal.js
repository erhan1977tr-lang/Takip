// Sipariş kayıtlarının yazıcıları: geçmiş (OrderEvent), denetim (AuditLog), bildirim kuyruğu (NotificationOutbox).
// Hepsi çağıranın veritabanı işlemi (tx) içinde çalışır; işlem geri alınırsa hiçbiri kalmaz.
import { NOTIFY_RULES } from '../notifications/email.js';
import { customerMailLang } from '../notifications/lang.js';

/** @param {{ orderId: string, event: string, from?: string | null, to?: string | null, actorId?: string | null, note?: string | null }} e */
export function writeHistory(tx, e) {
  return tx.orderEvent.create({
    data: {
      orderId: e.orderId, event: e.event, note: e.note ?? null, userId: e.actorId ?? null,
      fromStatus: e.from ?? null, toStatus: e.to ?? null,
    },
  });
}

/**
 * @param {{ action: string, entityType: string, entityId?: string | null, userId?: string | null, details?: object }} entry
 * @param {{ role?: string | null, ip?: string | null }} [actor]
 */
export function writeAudit(tx, entry, actor = {}) {
  return tx.auditLog.create({
    data: {
      action: entry.action, entityType: entry.entityType, entityId: entry.entityId ?? null, userId: entry.userId ?? null,
      details: entry.details ?? undefined, actorRole: actor.role ?? null, ip: actor.ip ?? null,
    },
  });
}

/**
 * Kuyruğa olay yazar. E-posta giden sipariş olaylarında müşterinin e-posta dili olay anında belirlenip olaya yazılır
 * (payload.lang — karar 200, server/notifications/lang.js): işçi dili sonradan değiştirmez.
 * @param {{ type: string, orderId?: string | null, payload?: object }} ev
 */
export async function enqueueOutbox(tx, ev) {
  let payload = ev.payload ?? undefined;
  if (ev.orderId && Object.hasOwn(NOTIFY_RULES, ev.type) && !(payload && 'lang' in payload) && typeof tx.order?.findUnique === 'function') {
    const order = await tx.order.findUnique({ where: { id: ev.orderId }, select: { customerId: true, createdBy: { select: { fixedLanguage: true, language: true, customerId: true } } } });
    const creator = order?.createdBy && order.createdBy.customerId === order.customerId ? order.createdBy : null;
    payload = { ...(payload ?? {}), lang: customerMailLang(creator) };
  }
  return tx.notificationOutbox.create({ data: { type: ev.type, orderId: ev.orderId ?? null, payload } });
}
