// Hatalı giriş / kod denemesi sınırı (Aşama 1). Saf hesap; kayıtlar lib/auth/throttle.ts'de.
//   Aynı e-posta + IP: 15 dakikada 5 hata → kilit (kilidin süresi en eski hatanın pencereden çıkmasına kadar)
//   Aynı e-posta (tüm IP'ler): 15 dakikada 20 hata → kilit (IP değiştirerek deneyen saldırı)
//   Aynı IP (tüm e-postalar): 15 dakikada 30 hata → kilit (çok hesabı deneyen saldırı)
// Kilit olayı (karar 149): hangi denemenin bir sınırı DOLDURDUĞU da buradan hesaplanır (filledScopes) — kayıt, kilidi
// oluşturan denemeye bağlanır; zaten kilitliyken gelen istek olay üretmez.

export const WINDOW_MS = 15 * 60_000;
export const LIMITS = { account: 5, email: 20, ip: 30 };

/**
 * @param {number[]} failures  hata anları (ms)
 * @param {number} now
 * @param {number} max
 * @returns {{ locked: false } | { locked: true, retryAt: number, minutes: number }}
 */
export function lockState(failures, now, max, windowMs = WINDOW_MS) {
  const recent = failures.filter((t) => now - t < windowMs).sort((a, b) => a - b);
  if (recent.length < max) return { locked: false };
  const retryAt = recent[recent.length - max] + windowMs;
  return { locked: true, retryAt, minutes: Math.max(1, Math.ceil((retryAt - now) / 60_000)) };
}

/** Üç sınırı birlikte değerlendirir; biri kilitliyse kilitli (en uzun süre geçerli).
 * @param {{ account: number[], email?: number[], ip: number[] }} failures  hata anları (ms)
 * @param {number} now
 */
export function throttleState({ account, email = [], ip }, now) {
  const states = [lockState(account, now, LIMITS.account), lockState(email, now, LIMITS.email), lockState(ip, now, LIMITS.ip)];
  const locked = states.filter((s) => s.locked);
  if (!locked.length) return { locked: false };
  return { locked: true, minutes: Math.max(...locked.map((s) => s.minutes)) };
}

/** Kilit kapsamları — SABİT sıra (kilit olayının kaydı hep bu sırayla yazılır): e-posta + IP, e-posta geneli, IP geneli */
export const LOCK_SCOPES = Object.freeze(['account', 'email', 'ip']);

/**
 * Yeni bir deneme eklendiğinde DOLAN sınırlar (karar 149): eklemeden önce kilitli olmayan, eklenince kilitlenen kapsamlar.
 * Yani kilidi OLUŞTURAN denemeyi tanımlar (5., 20. ya da 30. deneme); zaten kilitli bir kapsam "dolan" sayılmaz.
 * Sınırlar ve pencere lockState ile aynıdır — ikinci bir sayım kuralı yoktur.
 * @param {{ account: number[], email?: number[], ip: number[] }} failures  denemeden ÖNCEKİ kayıt anları (ms)
 * @param {number} now  eklenecek denemenin anı
 * @returns {('account' | 'email' | 'ip')[]}  LOCK_SCOPES sırasıyla
 */
export function filledScopes({ account, email = [], ip }, now) {
  const before = { account, email, ip };
  return LOCK_SCOPES.filter((s) => !lockState(before[s], now, LIMITS[s]).locked && lockState([...before[s], now], now, LIMITS[s]).locked);
}
