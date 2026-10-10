import { passwordIssue } from '../../server/auth/password-policy.js';
import { hashPassword, verifyPassword } from '../../server/auth/password-hash.js';

// scrypt ile şifre özeti — tek uygulama server/auth/password-hash.js (biçim: scrypt$N$r$p$salt$hash). Sunucu komutu
// (yönetici hesap kurtarma) da aynısını kullanır.
export { hashPassword, verifyPassword };

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
