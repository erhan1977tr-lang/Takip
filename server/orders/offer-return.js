// Yöneticinin geri gönderme nedeni (FOL17, 20.11.2026): yönetici teklifi satışa geri gönderirken yazdığı neden (OFFER_RETURNED
// olayının notu) yalnızca "Hareketler"de duruyordu. Satış teklifi yeniden hazırlarken neden, teklif tablosunun üstünde de
// gösterilir. Saf işlev — yeni veri yok, yalnızca siparişin rolüne göre süzülmüş olaylarından (order-view.js → eventsFor) okunur.

/** Teklifin satış ↔ yönetici akışındaki olayları: en sonuncusu geri gönderme değilse uyarı gösterilmez */
const FLOW = new Set(['OFFER_SUBMITTED', 'OFFER_RETURNED', 'OFFER_WITHDRAWN', 'OFFER_SENT', 'OFFER_REVISION_OPENED']);

/**
 * @param {{ event: string, note?: string | null, createdAt: Date | string }[]} events  en yeniden eskiye (lib/orders.ts)
 * @param {string | null | undefined} offerStatus  güncel teklifin durumu
 * @returns {{ note: string, at: Date | string } | null}
 */
export function lastReturn(events, offerStatus) {
  if (offerStatus !== 'HAZIRLANIYOR') return null;
  const last = (events ?? []).find((e) => FLOW.has(e.event));
  if (!last || last.event !== 'OFFER_RETURNED' || !last.note) return null;
  return { note: last.note, at: last.createdAt };
}
