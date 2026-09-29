// Sipariş kayıtlarının yazıcıları: geçmiş (OrderEvent), denetim (AuditLog), bildirim kuyruğu (NotificationOutbox).
// Hepsi çağıranın veritabanı işlemi (tx) içinde çalışır; işlem geri alınırsa hiçbiri kalmaz.

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

/** @param {{ type: string, orderId?: string | null, payload?: object }} ev */
export function enqueueOutbox(tx, ev) {
  return tx.notificationOutbox.create({ data: { type: ev.type, orderId: ev.orderId ?? null, payload: ev.payload ?? undefined } });
}
