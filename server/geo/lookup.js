// IP adresinin ülkesi (yalnızca Türkiye, Romanya ve Moldova; diğerleri null). Veri: ranges.js.
import data from './ranges.js';
import { ipv4ToInt, ipv6ToBigInt } from './ip.js';

/**
 * @param {any[][]} arr sıralı [başlangıç, bitiş, ülke sırası]
 * @param {number | bigint} x
 * @returns {number | null}
 */
function search(arr, x) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = arr[mid];
    if (x < r[0]) hi = mid - 1;
    else if (x > r[1]) lo = mid + 1;
    else return r[2];
  }
  return null;
}

/**
 * @param {{ countries: string[], v4: number[][], v6: (string | number)[][] }} d
 * @returns {(ip: string) => string | null}
 */
export function createLookup(d) {
  const v4 = d.v4;
  const v6 = d.v6.map(([hex, p, ci]) => {
    const s = BigInt(`0x${hex}`);
    return [s, s + (1n << BigInt(128 - Number(p))) - 1n, ci];
  });
  return (ip) => {
    if (!ip) return null;
    const raw = String(ip).trim().replace(/^\[(.*)\](:\d+)?$/, '$1');
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
    const n = ipv4ToInt(mapped ? mapped[1] : raw.replace(/:\d+$/, ''));
    if (n != null) {
      const ci = search(v4, n);
      return ci == null ? null : d.countries[ci];
    }
    const b = ipv6ToBigInt(raw);
    if (b == null) return null;
    const ci = search(v6, b);
    return ci == null ? null : d.countries[ci];
  };
}

export const countryOf = createLookup(data);
/** Verinin tarihi ve aralık sayısı (tanılama için) */
export const geoData = { generated: data.generated, ranges: data.v4.length + data.v6.length };
