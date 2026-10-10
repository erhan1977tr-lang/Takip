// Tahmini yükleme tarihi kilidi (Paket C — karar 230). İşlem (transitions.js → set_ship_date) ve sipariş sayfası aynı kuralı
// kullanır. Durum kilidi (Yüklendi / Arşiv / İptal) availableActions'ta (CLOSED).

/**
 * Siparişin herhangi bir yükleme onayı kalemi varsa (yüklendi ya da yüklenmedi — kısmi / çoklu yükleme dahil) tahmini
 * yükleme tarihi değişmez: kalan cam yalnızca yeniden planlama ile taşınır (karar 106).
 * @param {any} db  @param {string} orderId
 */
export async function shipDateLocked(db, orderId) {
  return (await db.loadingConfirmationItem.count({ where: { orderId } })) > 0;
}
