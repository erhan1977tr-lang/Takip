// Siparişin "Hareketler" listesinin yeri (ürün sahibi, 14.11.2026; karar 314).
//
//   Yönetici ve yönetici yardımcısının sol menüsü çok uzun olduğu için menünün altındaki "Hareketler" alanı bu rollerde
//   hiç görünmüyordu (alan sıfır yüksekliğe sıkışıyordu). Bu iki rolde liste sipariş sayfasının içinde, ayrı bir kart olarak
//   gösterilir. Diğer roller (müşteri, satış, çizim, denetimci) eskisi gibi sol menünün altında görür. Listenin verisi ve
//   süzme kuralları (eventText, order-view.js) aynıdır; yalnızca yeri değişir.

/** "Hareketler"i sayfanın içinde (kart olarak) gören roller */
export const HISTORY_INLINE_ROLES = Object.freeze(['ADMIN', 'YONETICI_YARDIMCISI']);

/**
 * @param {string | null | undefined} role
 * @returns {boolean} true → sayfanın içinde kart; false → sol menünün altında (eski yer)
 */
export function historyInline(role) {
  return !!role && HISTORY_INLINE_ROLES.includes(role);
}
