// Küçük, bellek içi istek sınırı (kayan pencere) — tek uygulama sürecinde çalışan mevcut kurulum için (Redis yok).
// Sayaç süreçle birlikte sıfırlanır; bu, kısa pencereli "kötüye kullanımı yavaşlat" sınırları için yeterlidir.
// Kalıcı olması gereken sınırlar (giriş denemeleri, yükleme kotası) veritabanından hesaplanır, burada değil.

/**
 * @param {{ limit: number, windowMs: number, maxKeys?: number }} o
 * @returns {{ take: (key: string, now?: number) => { ok: true, remaining: number } | { ok: false, retryAfterMs: number }, size: () => number }}
 */
export function createRateLimiter({ limit, windowMs, maxKeys = 5000 }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  const sweep = (now) => {
    for (const [k, list] of hits) if (!list.length || now - list[list.length - 1] >= windowMs) hits.delete(k);
  };
  return {
    take(key, now = Date.now()) {
      const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (list.length >= limit) {
        hits.set(key, list);
        return { ok: false, retryAfterMs: Math.max(1, list[0] + windowMs - now) };
      }
      list.push(now);
      hits.delete(key); // en son kullanılan anahtar sona gelsin (aşağıdaki sınır en eskiyi atar)
      hits.set(key, list);
      if (hits.size > maxKeys) {
        sweep(now);
        while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      }
      return { ok: true, remaining: limit - list.length };
    },
    size: () => hits.size,
  };
}
