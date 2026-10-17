// Şifre özeti — scrypt. Biçim: scrypt$N$r$p$salt$hash (salt ve hash base64url). Uygulama (lib/auth/password.ts) ve
// sunucu komutu (scripts/admin-recover.mjs — yönetici hesap kurtarma, karar 246) AYNI işlevi kullanır; ikinci bir biçim
// yazılmaz. Maliyet (karar 289; AUD-14): N=2^14, r=8, p=5 — OWASP'ın scrypt eşdeğerlerinden biri; bellek aynı (16 MiB,
// eşzamanlı girişlerde sunucu belleği büyümez), işlemci maliyeti 5 kat. Eski özetler (p=1) geçerlidir: parametreler
// özetin içinde saklıdır; başarılı girişte güncel parametreyle yenilenir (needsRehash).
import crypto from 'node:crypto';

const N = 16384;
const R = 8;
const P = 5;
const KEYLEN = 64;

function scrypt(password, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** @param {string} password @returns {Promise<string>} */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Kayıtlı özet güncel parametrelerden farklı mı (girişte yenilenir) */
export function needsRehash(stored) {
  const parts = String(stored ?? '').split('$');
  return parts.length === 6 && parts[0] === 'scrypt' && (Number(parts[1]) !== N || Number(parts[2]) !== R || Number(parts[3]) !== P);
}

/** Kabul edilen parametre aralığı: bozuk / aşırı değerli özet işlemciyi ya da belleği tüketemez */
const SANE = (n, r, p) => Number.isInteger(n) && n >= 1024 && n <= 2 ** 17 && (n & (n - 1)) === 0 && Number.isInteger(r) && r >= 1 && r <= 16 && Number.isInteger(p) && p >= 1 && p <= 16;

/** @param {string} password @param {string} stored @returns {Promise<boolean>} */
export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  if (!SANE(Number(n), Number(r), Number(p))) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64url'), Number(n), Number(r), Number(p));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
