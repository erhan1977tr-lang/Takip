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
