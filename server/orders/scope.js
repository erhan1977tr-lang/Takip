// Kim hangi siparişleri görür (sunucuda, sorgu koşulu olarak). lib/orders.ts ve iş akışı servisi bunu kullanır.
//   Müşteri: yalnızca kendi firmasının siparişleri
//   Çizim ekibi: yalnızca KENDİSİNE ATANMIŞ, çizim gereken siparişler (4.3.0, karar 300)
//   Satış: yalnızca sorumlu satışçısı kendisi olan siparişler (satıştan geçen tipler — profil siparişleri satışa hiç
//   görünmez, CLAUDE.md "Profile Order"); atama bekleyen sipariş hiçbir satışçıya / çizimciye görünmez (4.3.0, karar 300)
//   Yönetici, denetimci: hepsi
//   Silinmiş sipariş (removedAt — karar 110) hiçbir role görünmez: listeler, sipariş sayfası, dosyalar ve iş akışı
//   işlemleri bu kapsamdan geçtiği için silinmiş sipariş hepsinden birlikte kalkar. Geri yükleme: server/orders/removal.js.
/** Çizim ekibinin gördüğü siparişler: çizim gereken siparişler (çizim akışı olan tiplerde). Yöneticinin "Çizim Paneli" de bunu kullanır. */
export const DRAWING_SCOPE = { drawingTrack: { not: 'YOK' }, orderType: { usesDrawing: true } };

/** Kimlik yoksa hiçbir siparişle eşleşmeyen değer (boş kimlik "her şey" anlamına gelmesin) */
const NONE = '__none__';

/**
 * @param {{ id?: string | null, appRole: string, customerId?: string | null }} user
 *   id: satış ve çizim için ZORUNLU — kapsam kişiye bağlıdır (eksikse hiçbir sipariş eşleşmez)
 */
export function orderScope(user) {
  const live = { removedAt: null };
  if (user.appRole === 'MUSTERI') return { ...live, customerId: user.customerId ?? NONE };
  if (user.appRole === 'CIZIM') return { ...live, ...DRAWING_SCOPE, assignedDrawerId: user.id || NONE };
  if (user.appRole === 'SATIS') return { ...live, orderType: { usesSales: true }, salesUserId: user.id || NONE };
  return live;
}

/**
 * GÖRÜNTÜLEME kapsamı (4.3.17, karar 301) — yalnızca OKUMA yolları kullanır (sipariş sayfası, çizim görüntüleyici, "Tüm aktif
 * siparişler" listesi ve arama, dosya indirme / önizleme, teklif dışa aktarımı, yükleme / sandık / nakliye okumaları; yapı
 * testi çağıranları listeler). Satış: ekibinin (aynı geçerli varsayılan çizimciye bağlı satışçılar — server/orders/sales-team.js)
 * siparişleri; ekip bilgisi yoksa yalnızca kendisi. Diğer bütün roller: orderScope ile BİREBİR aynı.
 * Yazma, görev listesi, bildirim ve sayaçlar bunu KULLANMAZ: orderScope / actorScope (sorumlu satışçı = kendisi).
 * @param {{ id?: string | null, appRole: string, customerId?: string | null, salesTeam?: string[] | null }} user
 */
export function orderViewScope(user) {
  if (user.appRole !== 'SATIS') return orderScope(user);
  const own = user.id || NONE;
  const team = Array.isArray(user.salesTeam) && user.salesTeam.includes(own) ? user.salesTeam.filter((x) => typeof x === 'string' && x) : [own];
  return { removedAt: null, orderType: { usesSales: true }, salesUserId: { in: team } };
}

/** Sipariş, bakan satışçı için yalnızca GÖRÜNTÜLEME midir (ekip arkadaşının siparişi)? Diğer rollerde hiçbir zaman. */
export function teamViewOnly(user, order) {
  return user?.appRole === 'SATIS' && !!order && order.salesUserId !== user.id;
}

/** İş akışı / servis aktörü ({ id, role, customerId }) için aynı kapsam */
export const actorScope = (actor) => orderScope({ id: actor?.id ?? null, appRole: actor?.role, customerId: actor?.customerId ?? null });
