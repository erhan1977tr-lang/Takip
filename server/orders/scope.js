// Kim hangi siparişleri görür (sunucuda, sorgu koşulu olarak). lib/orders.ts ve iş akışı servisi bunu kullanır.
//   Müşteri: yalnızca kendi firmasının siparişleri
//   Çizim ekibi: yalnızca çizim gereken siparişler (çizim akışı olan tiplerde)
//   Satış: yalnızca satıştan geçen tipler — profil siparişleri satışa hiç görünmez (CLAUDE.md "Profile Order")
//   Yönetici, denetimci: hepsi
//   Silinmiş sipariş (removedAt — karar 110) hiçbir role görünmez: listeler, sipariş sayfası, dosyalar ve iş akışı
//   işlemleri bu kapsamdan geçtiği için silinmiş sipariş hepsinden birlikte kalkar. Geri yükleme: server/orders/removal.js.
/** Çizim ekibinin gördüğü siparişler: çizim gereken siparişler (çizim akışı olan tiplerde). Yöneticinin "Çizim Paneli" de bunu kullanır. */
export const DRAWING_SCOPE = { drawingTrack: { not: 'YOK' }, orderType: { usesDrawing: true } };

/** @param {{ appRole: string, customerId?: string | null }} user */
export function orderScope(user) {
  const live = { removedAt: null };
  if (user.appRole === 'MUSTERI') return { ...live, customerId: user.customerId ?? '__none__' };
  if (user.appRole === 'CIZIM') return { ...live, ...DRAWING_SCOPE };
  if (user.appRole === 'SATIS') return { ...live, orderType: { usesSales: true } };
  return live;
}
