// Onaysız yükleme engeli (4.2.5, ürün sahibinin 27.10.2026 kararı) — veritabanı tarafı.
//
// Kural (saf): production-approval.js → loadingApprovalBlock. Engel sunucudaki BÜTÜN yükleme işlemlerinde uygulanır:
//   - "Yükleme yapıldı" (server/loading/confirmation.js → confirmLoading): onay gününde kapsamdaki bir sipariş müşteri
//     onayı ya da yönetici istisnası olmadan plandaysa onay kaydedilmez (APPROVAL_REQUIRED + sipariş listesi). Gün kesim
//     gününden önceyse (30.10.2026) engel yoktur.
//   - "Yüklendi" (server/orders/transitions.js → mark_shipped): siparişin planlanan yükleme günüyle (yoksa bugün) aynı kural.
// Ayar kapalıyken (Ayarlar → Entegrasyonlar → Müşteri üretim onayı) engel yoktur: 4.2.0 davranışına dönüş anahtarı.
// Yönetici istisnası (override_loading_approval) müşteri onayı DEĞİLDİR; teklifin onay alanlarına dokunmaz.
// Bu modül döngü oluşturmamak için bildirim / servis modüllerini içe aktarmaz (yalnızca ayar satırını okur).
import { APPROVAL_SETTING_KEY, approvalCutoff, approvalSettingOn, loadingApprovalBlock } from './production-approval.js';

/** Ayar (yalnızca okunur): { enabled, cutoff } */
export async function approvalGateSetting(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: APPROVAL_SETTING_KEY }, select: { value: true } });
  return { enabled: approvalSettingOn(row?.value), cutoff: approvalCutoff(row?.value) };
}

/**
 * Verilen yükleme gününde engellenen siparişler: [{ orderId, orderNo, reason }] (reason: NOT_SENT | PENDING | CHANGE_REQUESTED).
 * @param {any} db  @param {{ day: string, orderIds: string[], setting?: { enabled: boolean, cutoff: string } | null }} p
 * @returns {Promise<{ orderId: string, orderNo: string, reason: string }[]>}
 */
export async function loadingApprovalBlocks(db, { day, orderIds, setting = null }) {
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return [];
  const s = setting ?? await approvalGateSetting(db);
  if (!s.enabled) return [];
  const orders = await db.order.findMany({
    where: { id: { in: ids }, productionApprovalRequired: true, loadingOverrideAt: null },
    orderBy: { orderNo: 'asc' },
    select: {
      id: true, orderNo: true, productionApprovalRequired: true, loadingOverrideAt: true,
      offers: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, approvedAt: true, changeRequestedAt: true } },
    },
  });
  return orders
    .map((o) => ({ orderId: o.id, orderNo: o.orderNo, reason: loadingApprovalBlock({ ...s, day, order: o, offer: o.offers[0] ?? null }) }))
    .filter((r) => r.reason);
}
