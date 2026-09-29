// Metin şablonuna değer yerleştirir: "{n}. satır" + {n: 2} → "2. satır". Bilinmeyen yer tutucu olduğu gibi kalır.
// Bağımlılığı yoktur; istemci bileşenlerinde de kullanılabilir.

/**
 * @param {string} s
 * @param {Record<string, string | number> | undefined} [params]
 * @returns {string}
 */
export function interpolate(s, params) {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
}
