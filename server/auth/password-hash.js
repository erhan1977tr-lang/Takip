// Şifre özeti — scrypt. Biçim: scrypt$N$r$p$salt$hash (salt ve hash base64url). Uygulama (lib/auth/password.ts) ve
// sunucu komutu (scripts/admin-recover.mjs — yönetici hesap kurtarma, karar 246) AYNI işlevi kullanır; ikinci bir biçim
// yazılmaz. Parametreler değişmedi (kayıtlı özetler geçerli).
import crypto from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** @param {string} password @returns {Promise<string>} */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** @param {string} password @param {string} stored @returns {Promise<boolean>} */
export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64url'), Number(n), Number(r), Number(p));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
