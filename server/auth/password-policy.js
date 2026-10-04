// Şifre kuralı (güvenlik denetimi SEC-04, karar 117 — karar 12'deki "en az 6 karakter, bir harf + bir rakam" kuralının yerine).
//   YENİ şifreler için (davet, şifre sıfırlama, şifre değiştirme): en az 10 karakter, en çok 200. Uzun parola
//   (boşluklu cümle) kullanılabilir; harf / rakam / simge zorunluluğu YOKTUR — uzunluk, karmaşıklık kuralından
//   daha etkilidir. Yalnızca açıkça değersiz olanlar reddedilir: tek karakterin tekrarı gibi (en az 4 farklı karakter).
//   Kayıtlı şifreler (özetleri) geçerli kalır: kural yalnızca şifre BELİRLENİRKEN uygulanır; girişte uygulanmaz —
//   eski, kısa şifresi olan kullanıcı giriş yapmaya devam eder (yönetici isterse "şifre sıfırla" ile yeniletir).
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const PASSWORD_MIN_DISTINCT = 4;

/**
 * @param {unknown} password
 * @returns {'short' | 'long' | 'trivial' | null}  sorun kodu ya da null (uygun)
 */
export function passwordIssue(password) {
  const p = typeof password === 'string' ? password : '';
  const chars = [...p];
  if (chars.length < PASSWORD_MIN) return 'short';
  if (chars.length > PASSWORD_MAX) return 'long';
  if (new Set(chars).size < PASSWORD_MIN_DISTINCT) return 'trivial';
  return null;
}
