// HMAC yardımcıları (3.95.0, karar 290): amaca özgü anahtar türetme, imza ve sabit zamanlı karşılaştırma. Saf modül.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Ana sırdan amaca özgü anahtar: HMAC-SHA256(secret, purpose) — farklı amaçların imzaları birbirine karışmaz */
export const deriveKey = (secret, purpose) => createHmac('sha256', String(secret)).update(String(purpose)).digest();

/** Onaltılık HMAC-SHA256 */
export const hmacHex = (key, data) => createHmac('sha256', key).update(data).digest('hex');

/** İki onaltılık imzayı sabit zamanda karşılaştırır (biçimi bozuk olan false) */
export function hexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b) || a.length !== b.length || a.length % 2) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
