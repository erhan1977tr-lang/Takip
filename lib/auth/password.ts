import crypto from 'node:crypto';
import { passwordIssue } from '../../server/auth/password-policy.js';

// scrypt ile şifre özeti. Biçim: scrypt$N$r$p$salt$hash (salt ve hash base64url)
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key as Buffer)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64url'), Number(n), Number(r), Number(p));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Kullanıcı yokken de aynı süreyi harcamak için (e-posta var mı yok mu anlaşılmasın).
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('takip-dummy-password-1');
  await verifyPassword(password, await dummyHash);
}

/**
 * YENİ şifre kuralı (server/auth/password-policy.js): en az 10 karakter, uzun parola serbest. Sorun kodu ya da null.
 * Yalnızca şifre belirlenirken uygulanır; girişte uygulanmaz (kayıtlı eski şifreler geçerli kalır).
 */
export function passwordProblem(password: string): string | null {
  return passwordIssue(password);
}
