// Kur için ondalık hesap (kayan nokta yok): değerler metin ("5.1000"), hesap BigInt ile tam yapılır,
// yuvarlama yalnızca en sonda ve yarım-yukarı (half-up).

/** "5.1000" → { n: 51000n, s: 4 }; geçersiz → null */
export function dec(v) {
  const m = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const f = m[2] ?? '';
  return { n: BigInt(m[1] + f), s: f.length };
}

/** n / 10^s → `places` ondalıklı metin (fazla basamak yarım-yukarı yuvarlanır) */
export function fmt(n, s, places) {
  if (s > places) {
    const d = 10n ** BigInt(s - places);
    n = (n + d / 2n) / d;
  } else if (s < places) {
    n *= 10n ** BigInt(places - s);
  }
  if (places === 0) return n.toString();
  const str = n.toString().padStart(places + 1, '0');
  return `${str.slice(0, -places)}.${str.slice(-places)}`;
}

/** Uygulanan kurun ondalık sayısı (BNR ve BT kurları 4 ondalıklıdır; belgeye yazılan ve hesapta kullanılan aynı değerdir) */
export const RATE_PLACES = 4;

/**
 * taban × (1 + yüzde / 100), tam hesap; sonuç RATE_PLACES ondalığa bir kez yuvarlanır.
 * 5.1000 + %2 → "5.2020"
 * @param {string} base  @param {string} percent  @param {number} [places]
 * @returns {string | null}
 */
export function applyMarkup(base, percent, places = RATE_PLACES) {
  const b = dec(base);
  const p = dec(percent);
  if (!b || !p) return null;
  // (100 + p) / 100  →  n = 100·10^s + p.n, ölçek s + 2
  const factor = 100n * 10n ** BigInt(p.s) + p.n;
  return fmt(b.n * factor, b.s + p.s + 2, places);
}

/** Ondalık metni en az `places` ondalığa getirir ("5.1" → "5.1000"); geçersiz → null */
export function padRate(v, places = RATE_PLACES) {
  const d = dec(v);
  return d ? fmt(d.n, d.s, Math.max(places, d.s)) : null;
}
