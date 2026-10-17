// Adres (query) üzerinden taşınan serbest metnin imzası (3.93.0, karar 288 — D14).
// Ayarlar sayfası bir işlemin sonucunu (FGO testi yanıtı, hatalı alanlar, depo alıcıları, çeviri testi) yönlendirme adresinde
// taşır. Adres herkesçe yazılabilir: imzasız metin ekranda gösterilirse yöneticiye sahte uyarı / sosyal mühendislik metni
// gösterilebilir (XSS değil — metin kaçışlanır). İşlem metni AUTH_SECRET ile HMAC'ler; sayfa yalnızca imzası doğrulanan metni
// gösterir, gerisini sabit metinle değiştirir. Yalnızca node:crypto; durum yok, veritabanı yok.
import crypto from 'node:crypto';

const SIG_LEN = 32; // base64url karakter (192 bit)

/**
 * @param {string} secret  @param {string} scope  sonucun türü (ör. "error:fgo")  @param {string[]} values  imzalanan metinler
 * @returns {string}
 */
export function signParams(secret, scope, values) {
  if (!secret) throw new Error('signParams: sır yok');
  const h = crypto.createHmac('sha256', String(secret));
  h.update(`takip-param\n${scope}`);
  for (const v of values) h.update(`\n${String(v ?? '').length}:${String(v ?? '')}`);
  return h.digest('base64url').slice(0, SIG_LEN);
}

/**
 * İmza doğru mu (sabit zamanlı karşılaştırma).
 * @param {string} secret  @param {string} scope  @param {string[]} values  @param {unknown} sig
 */
export function verifyParams(secret, scope, values, sig) {
  if (typeof sig !== 'string' || sig.length !== SIG_LEN || !secret) return false;
  const want = Buffer.from(signParams(secret, scope, values));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/**
 * Kullanıcıya ve süreye bağlı sonuç imzası (karar 289; güvenlik denetimi 3.93.2 Y-5): imza yalnızca işlemi yapan
 * kullanıcıya ve kısa bir süre için geçerlidir — imzalı bir adres başka bir kullanıcıya gönderilip "sahte uyarı" olarak
 * gösterilemez, eski bir adres sonsuza dek geçerli kalmaz.
 */
export const RESULT_TTL_MS = 10 * 60_000;

/**
 * @param {{ secret: string, scope: string, userId: string, values: string[], now?: number, ttlMs?: number }} o
 * @returns {{ sig: string, exp: string }}
 */
export function signResult({ secret, scope, userId, values, now = Date.now(), ttlMs = RESULT_TTL_MS }) {
  if (!userId) throw new Error('signResult: kullanıcı yok');
  const exp = String(Math.floor((now + ttlMs) / 1000));
  return { sig: signParams(secret, `${scope}\nu:${userId}\nexp:${exp}`, values), exp };
}

/**
 * @param {{ secret: string, scope: string, userId: string | null | undefined, values: string[], sig: unknown, exp: unknown, now?: number, ttlMs?: number }} o
 */
export function verifyResult({ secret, scope, userId, values, sig, exp, now = Date.now(), ttlMs = RESULT_TTL_MS }) {
  if (!userId || typeof exp !== 'string' || !/^\d{9,11}$/.test(exp)) return false;
  const at = Number(exp) * 1000;
  if (at < now || at > now + ttlMs + 60_000) return false;
  return verifyParams(secret, `${scope}\nu:${userId}\nexp:${exp}`, values, sig);
}
