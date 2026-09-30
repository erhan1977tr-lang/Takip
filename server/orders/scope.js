// Kim hangi siparişleri görür (sunucuda, sorgu koşulu olarak). lib/orders.ts ve iş akışı servisi bunu kullanır.
//   Müşteri: yalnızca kendi firmasının siparişleri
//   Çizim ekibi: yalnızca çizim gereken siparişler (çizim akışı olan tiplerde)
//   Satış: yalnızca satıştan geçen tipler — profil siparişleri satışa hiç görünmez (CLAUDE.md "Profile Order")
//   Yönetici, denetimci: hepsi
/** @param {{ appRole: string, customerId?: string | null }} user */
export function orderScope(user) {
  if (user.appRole === 'MUSTERI') return { customerId: user.customerId ?? '__none__' };
  if (user.appRole === 'CIZIM') return { drawingTrack: { not: 'YOK' }, orderType: { usesDrawing: true } };
  if (user.appRole === 'SATIS') return { orderType: { usesSales: true } };
  return {};
}
