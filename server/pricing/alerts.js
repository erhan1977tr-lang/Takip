// Yöneticinin "Önemli kararlar" listesi (AdminAlert). Şimdilik tek tür: PRICE_OVERRIDE —
// satışçı teklifi liste fiyatından farklı fiyatla yöneticiye gönderdi (karar 26).
// Kayıtlar silinmez; yönetici "Gördüm" deyince kapanır (kim, ne zaman). Aynı siparişin teklifi yeniden
// gönderilirse eski açık uyarı kendiliğinden kapanır ve yenisi açılır (liste hep son durumu gösterir).
import { writeAudit } from '../orders/journal.js';
import { priceOverrides } from './tables.js';

// COMPENSATION_PRICE: telafi camı açıldı — HER telafide bir kayıt: karar (bedelsiz / aynı fiyat / farklı fiyat), önceki →
// uygulanan müşteri fiyatı, kaynak siparişin adedi (karar 157) · COMPENSATION_PENDING: satışın "farklı fiyat" kararı
// yöneticinin onayını bekliyor (server/orders/compensation.js — Aşama 9). Bir telafi için ikisi birden açılmaz.
// STOCK_SHORTAGE: müşterinin profil siparişinde stok yetmedi — sipariş engellenmez, yönetici karar verir (karar 165;
// server/profile/stock.js → recordStockShortage).
// STOCK_CRITICAL: ürünün stoğu yöneticinin kritik eşiğine indi — ürün başına tek açık kayıt (karar 177;
// server/profile/stock.js → recordCriticalStock, setCriticalStock).
// FINANCE_REVIEW: elle ödeme kaydı ile FGO tahsilatı uyuşmuyor / fazla ödeme / FGO'nun doğrulamadığı elle avans / iptal
// edilmiş siparişin proformasına FGO tahsilatı (karar 208; server/finance/service.js → financeReviewTick).
// DUPLICATE_RISK: aynı müşteride aynı tutar — yönetici eşleşmeyi gördü ve "ayrı ödeme" diye onayladı (karar 208).
// FGO_UNCERTAIN: belge kesme isteğinin sonucu belirsiz — yönetici FGO'ya bakıp karar verecek (karar 209;
// server/finance/uncertain.js). Hepsi dedupeKey ile tekildir (aynı durum için ikinci kayıt açılmaz).
export const ALERT_TYPES = ['PRICE_OVERRIDE', 'COMPENSATION_PRICE', 'COMPENSATION_PENDING', 'STOCK_SHORTAGE', 'STOCK_CRITICAL', 'FINANCE_REVIEW', 'DUPLICATE_RISK', 'FGO_UNCERTAIN'];

/**
 * Fiyat farkının parmak izi (satır sırası hariç: tür, açıklama, liste fiyatı, satış fiyatı, bedelsiz). Aynı farkın yeniden
 * gönderimi "değişmedi" sayılır — yöneticiye yeni e-posta gitmez (Yönetici Paneli Paketi 1, karar 218).
 * @param {{ kind?: string | null, description?: string | null, listPrice: unknown, unitPrice: unknown, free?: boolean }[] | null | undefined} diffs
 * @returns {string}
 */
export function overrideKey(diffs) {
  return (Array.isArray(diffs) ? diffs : [])
    .map((d) => JSON.stringify([d?.kind ?? null, String(d?.description ?? ''), Number(d?.listPrice).toFixed(2), Number(d?.unitPrice).toFixed(2), !!d?.free]))
    .sort().join('|');
}

/**
 * Satışçı teklifi yöneticiye gönderirken çağrılır (iş akışı işleminin içinde, aynı tx).
 * changed: fark, siparişin SON kaydından (açık ya da "Gördüm" ile kapanmış) farklı — satış fabrika fiyatını gerçekten
 * değiştirdi; aynı fiyatların yeniden gönderimi (geri alma / geri gönderme sonrası) false (karar 218).
 * @returns {Promise<{ count: number, changed: boolean, alertId: string | null }>} count: liste fiyatından farklı satır sayısı
 */
export async function recordPriceOverrides(tx, { orderId, offerId, orderNo, currency, lines, actor, now = new Date() }) {
  const last = await tx.adminAlert.findFirst({ where: { type: 'PRICE_OVERRIDE', orderId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { details: true } });
  await tx.adminAlert.updateMany({ where: { type: 'PRICE_OVERRIDE', orderId, resolvedAt: null }, data: { resolvedAt: now } });
  const diffs = priceOverrides(lines);
  if (diffs.length === 0) return { count: 0, changed: false, alertId: null };
  const alert = await tx.adminAlert.create({
    data: { type: 'PRICE_OVERRIDE', orderId, offerId, createdById: actor.id, createdAt: now, details: { orderNo, currency, lines: diffs } },
  });
  await writeAudit(tx, {
    action: 'PRICE_OVERRIDE', entityType: 'Offer', entityId: offerId, userId: actor.id,
    details: { orderId, orderNo, alertId: alert.id, lines: diffs },
  }, actor);
  const before = last?.details && typeof last.details === 'object' && !Array.isArray(last.details) ? /** @type {any} */ (last.details).lines : [];
  return { count: diffs.length, changed: overrideKey(diffs) !== overrideKey(before), alertId: alert.id };
}

/**
 * Yönetici uyarıyı gördü olarak kapatır.
 * @returns {Promise<boolean>} kapatıldı mı (zaten kapalıysa false)
 */
export async function resolveAlert(db, id, actor) {
  return db.$transaction(async (tx) => {
    // Belirsiz FGO belgesi (karar 209) "Gördüm" ile kapanmaz: yöneticinin FGO kararıyla (resolveUncertainJob) kapanır.
    // Bekleyen telafi kararı da (AUD-17, P7): onay / ret ile kapanır — arayüzde gizli düğme sunucuda da reddedilir
    const r = await tx.adminAlert.updateMany({ where: { id, resolvedAt: null, type: { notIn: ['FGO_UNCERTAIN', 'COMPENSATION_PENDING'] } }, data: { resolvedAt: new Date(), resolvedById: actor.id } });
    if (r.count === 0) return false;
    await writeAudit(tx, { action: 'ALERT_RESOLVE', entityType: 'AdminAlert', entityId: id, userId: actor.id }, actor);
    return true;
  });
}

export const openAlertCount = (db) => db.adminAlert.count({ where: { resolvedAt: null } });
