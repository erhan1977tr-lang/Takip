// Hatalı giriş / kod denemesi sınırı (Aşama 1). Saf hesap; kayıtlar lib/auth/throttle.ts'de.
//   Aynı e-posta + IP: 15 dakikada 5 hata → kilit (kilidin süresi en eski hatanın pencereden çıkmasına kadar)
//   Aynı e-posta (tüm IP'ler): 15 dakikada 20 hata → kilit (IP değiştirerek deneyen saldırı)
//   Aynı IP (tüm e-postalar): 15 dakikada 30 hata → kilit (çok hesabı deneyen saldırı)

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

/** Üç sınırı birlikte değerlendirir; biri kilitliyse kilitli (en uzun süre geçerli). */
export function throttleState({ account, email = [], ip }, now) {
  const states = [lockState(account, now, LIMITS.account), lockState(email, now, LIMITS.email), lockState(ip, now, LIMITS.ip)];
  const locked = states.filter((s) => s.locked);
  if (!locked.length) return { locked: false };
  return { locked: true, minutes: Math.max(...locked.map((s) => s.minutes)) };
}
