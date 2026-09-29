// Kim hangi siparişleri görür (sunucuda, sorgu koşulu olarak). lib/orders.ts ve iş akışı servisi bunu kullanır.
//   Müşteri: yalnızca kendi firmasının siparişleri
//   Çizim ekibi: yalnızca çizim gereken siparişler
//   Satış, yönetici, denetimci: hepsi
/** @param {{ appRole: string, customerId?: string | null }} user */
export function orderScope(user) {
  if (user.appRole === 'MUSTERI') return { customerId: user.customerId ?? '__none__' };
  if (user.appRole === 'CIZIM') return { drawingTrack: { not: 'YOK' } };
  return {};
}
