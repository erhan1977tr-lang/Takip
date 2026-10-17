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

/**
 * Siparişin onaylı yükleme günü (3.93.0, karar 288 — O1): yüklenen (LOADED) kalemi olan en son onay günü; yalnızca yüklenmedi
 * kalemi varsa en son onay günü; onay yoksa null. "Yüklendi" bu güne yazılır ve onaylı günün sandıkları taşınmaz.
 * @param {any} db  @param {string} orderId
 * @returns {Promise<Date | null>}
 */
export async function confirmedShipDay(db, orderId) {
  const pick = (status) => db.loadingConfirmationItem.findFirst({
    where: { orderId, ...(status ? { status } : {}) }, orderBy: { confirmation: { shipDay: 'desc' } }, select: { confirmation: { select: { shipDay: true } } },
  });
  const it = (await pick('LOADED')) ?? (await pick(null));
  return it?.confirmation.shipDay ?? null;
}
