// Bildirim outbox'ı (ADR 0006). Dış gönderim (e-posta, WhatsApp, webhook) işlem içinde YAPILMAZ;
// işlem yalnızca olayı yazar, ayrı çalışan gönderir. Tablo ve çalışan Aşama 8'de; burada olay biçimi
// ve testler için bellek içi uygulama var.

/**
 * @param {string} type  ör. 'ORDER_SUBMITTED'
 * @param {{ orderId?: string, payload?: object, dedupeKey?: string }} [opts]
 */
export function outboxEvent(type, { orderId = null, payload = {}, dedupeKey = null } = {}) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(type)) throw new Error(`olay tipi BÜYÜK_HARF olmalı: ${type}`);
  return { type, orderId, payload, dedupeKey, attempts: 0, status: 'PENDING' };
}

/** Testler için: yazılan olayları bellekte tutar. */
export function memoryOutbox() {
  const events = [];
  return {
    events,
    async enqueue(_tx, event) {
      events.push(event);
    },
  };
}
