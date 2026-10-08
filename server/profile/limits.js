// Müşterinin profil hesaplayıcısı ve gönderim öncesi stok uyarısı için istek sınırları (Paket 5, karar 177).
// İkisi de yalnızca okur (kayıt yazmaz) ama sonuçları müşterinin KENDİ siparişindeki eksik ürünlerin stok değerini içerir:
// sınır, çok sayıda istekle stok yoklamayı yavaşlatır. Ortak bellek içi sınırlayıcı (server/security/rate-limit.js): `take`
// tek adımda denetler ve sayar; sayaç uygulama süreciyle sıfırlanır. Anahtar kullanıcı kimliğidir.
import { createRateLimiter } from '../security/rate-limit.js';

const MIN = 60_000;
export const PROFILE_CALC_LIMITS = Object.freeze({
  /** Hesapla: kullanıcı başına 10 dakikada en çok 60 */
  calc: Object.freeze({ limit: 60, windowMs: 10 * MIN }),
  /** Gönderim öncesi stok uyarısı: kullanıcı başına 10 dakikada en çok 30 */
  stockCheck: Object.freeze({ limit: 30, windowMs: 10 * MIN }),
});

/** @param {typeof PROFILE_CALC_LIMITS} [limits] */
export function createProfileCalcLimits(limits = PROFILE_CALC_LIMITS) {
  const calc = createRateLimiter(limits.calc);
  const stockCheck = createRateLimiter(limits.stockCheck);
  return {
    /** @param {string} userId  @param {number} [now] */
    calc: (userId, now) => calc.take(String(userId), now).ok,
    /** @param {string} userId  @param {number} [now] */
    stockCheck: (userId, now) => stockCheck.take(String(userId), now).ok,
  };
}

/** Uygulama sürecinin sayaçları */
export const profileCalcLimits = createProfileCalcLimits();
