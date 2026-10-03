// Yöneticinin "Önemli kararlar" listesi (AdminAlert). Şimdilik tek tür: PRICE_OVERRIDE —
// satışçı teklifi liste fiyatından farklı fiyatla yöneticiye gönderdi (karar 26).
// Kayıtlar silinmez; yönetici "Gördüm" deyince kapanır (kim, ne zaman). Aynı siparişin teklifi yeniden
// gönderilirse eski açık uyarı kendiliğinden kapanır ve yenisi açılır (liste hep son durumu gösterir).
import { writeAudit } from '../orders/journal.js';
import { priceOverrides } from './tables.js';

// COMPENSATION_PRICE: telafi camının fiyatı normalden farklı (Bedelsiz / değiştirilmiş) · COMPENSATION_PENDING: satışın
// telafi kararı yöneticinin onayını bekliyor (server/orders/compensation.js — Aşama 9)
export const ALERT_TYPES = ['PRICE_OVERRIDE', 'COMPENSATION_PRICE', 'COMPENSATION_PENDING'];

/**
 * Satışçı teklifi yöneticiye gönderirken çağrılır (iş akışı işleminin içinde, aynı tx).
 * @returns {Promise<number>} liste fiyatından farklı satır sayısı
 */
export async function recordPriceOverrides(tx, { orderId, offerId, orderNo, currency, lines, actor, now = new Date() }) {
  await tx.adminAlert.updateMany({ where: { type: 'PRICE_OVERRIDE', orderId, resolvedAt: null }, data: { resolvedAt: now } });
  const diffs = priceOverrides(lines);
  if (diffs.length === 0) return 0;
  const alert = await tx.adminAlert.create({
    data: { type: 'PRICE_OVERRIDE', orderId, offerId, createdById: actor.id, createdAt: now, details: { orderNo, currency, lines: diffs } },
  });
  await writeAudit(tx, {
    action: 'PRICE_OVERRIDE', entityType: 'Offer', entityId: offerId, userId: actor.id,
    details: { orderId, orderNo, alertId: alert.id, lines: diffs },
  }, actor);
  return diffs.length;
}

/**
 * Yönetici uyarıyı gördü olarak kapatır.
 * @returns {Promise<boolean>} kapatıldı mı (zaten kapalıysa false)
 */
export async function resolveAlert(db, id, actor) {
  return db.$transaction(async (tx) => {
    const r = await tx.adminAlert.updateMany({ where: { id, resolvedAt: null }, data: { resolvedAt: new Date(), resolvedById: actor.id } });
    if (r.count === 0) return false;
    await writeAudit(tx, { action: 'ALERT_RESOLVE', entityType: 'AdminAlert', entityId: id, userId: actor.id }, actor);
    return true;
  });
}

export const openAlertCount = (db) => db.adminAlert.count({ where: { resolvedAt: null } });
