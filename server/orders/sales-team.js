// Satış ekibi — ortak GÖRÜNTÜLEME (4.3.17, karar 301). Yeni tablo / alan yok: ekip, var olan User.defaultDrawerId'den
// türetilir. Aynı, GEÇERLİ (etkin, silinmemiş iç ekip çizimcisi) varsayılan çizimciye bağlı etkin satışçılar birbirlerinin
// cam siparişlerini görür; DEĞİŞTİREMEZ. Varsayılan çizimcisi olmayan ya da çizimcisi geçersiz (pasif / silinmiş / çizimci
// değil) satışçının ekibi yalnızca kendisidir.
//
// Ekip yalnızca GÖRÜNTÜLEME kapsamını (server/orders/scope.js → orderViewScope) genişletir. Yazma kapsamı (orderScope /
// actorScope), "Sıra bende", Teklifler görev listeleri, bildirimler, okunmamış sayaçlar, ticari sahiplik (salesUserId),
// satışçı bazlı hesaplar ve sandık kayıt kuralları DEĞİŞMEZ.
import { validDrawer, validSales } from './sales-routing.js';

/**
 * Saf kural: satışçının ekibi (kimlik listesi; ilk eleman her zaman kendisi).
 * @param {{ id?: string | null, appRole?: string }} user
 * @param {{ id: string, appRole: string, type: string, isActive?: boolean, deletedAt?: Date | null } | null} drawer  kullanıcının varsayılan çizimcisi
 * @param {{ id: string, appRole: string, type: string, isActive?: boolean, deletedAt?: Date | null, defaultDrawerId?: string | null }[]} candidates
 *   aynı defaultDrawerId'ye sahip kullanıcılar (geçerli satışçı olmayanlar elenir)
 * @returns {string[]}
 */
export function salesTeamOf(user, drawer, candidates = []) {
  if (!user?.id || user.appRole !== 'SATIS') return user?.id ? [user.id] : [];
  if (!validDrawer(drawer)) return [user.id];
  const mates = candidates
    .filter((u) => u.id !== user.id && u.defaultDrawerId === drawer.id && validSales(u))
    .map((u) => u.id)
    .sort();
  return [user.id, ...mates];
}

/**
 * Oturum kullanıcısının ekibi (istek başına bir kez — lib/auth/session.ts). Yalnızca satış rolünde sorgu yapar; diğer
 * rollerde null (ekip kavramı yok, görüntüleme kapsamı = yazma kapsamı).
 * @param {any} db  @param {{ id: string, appRole: string, defaultDrawerId?: string | null }} user
 * @returns {Promise<string[] | null>}
 */
export async function loadSalesTeam(db, user) {
  if (!user?.id || user.appRole !== 'SATIS') return null;
  if (!user.defaultDrawerId) return [user.id];
  const drawer = await db.user.findUnique({
    where: { id: user.defaultDrawerId },
    select: { id: true, appRole: true, type: true, isActive: true, deletedAt: true },
  });
  if (!validDrawer(drawer)) return [user.id];
  const candidates = await db.user.findMany({
    where: { defaultDrawerId: drawer.id, appRole: 'SATIS', type: 'INTERNAL', isActive: true, deletedAt: null },
    select: { id: true, appRole: true, type: true, isActive: true, deletedAt: true, defaultDrawerId: true },
  });
  return salesTeamOf(user, drawer, candidates);
}
