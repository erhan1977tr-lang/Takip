// RIPE NCC dağıtım istatistiklerini (delegated-ripencc-extended-latest) ülke aralıklarına çevirir.
// Satır biçimi: kayıt|ülke|tür|başlangıç|değer|tarih|durum[|kimlik]  (ipv4: değer = adres sayısı, ipv6: önek uzunluğu)
import { ipv4ToInt, ipv6ToBigInt } from './ip.js';

/**
 * @param {string} text
 * @param {string[]} [wanted]
 * @returns {{ countries: string[], v4: number[][], v6: (string | number)[][] }}
 */
export function parseDelegated(text, wanted = ['MD', 'RO', 'TR']) {
  const countries = [...wanted].sort();
  const idx = new Map(countries.map((c, i) => [c, i]));
  /** @type {number[][]} */
  const v4 = [];
  /** @type {[bigint, number, number][]} */
  const v6 = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.trim().split('|');
    if (f.length < 7) continue;
    const [, cc, type, start, value, , status] = f;
    const ci = idx.get(cc);
    if (ci === undefined || (status !== 'allocated' && status !== 'assigned')) continue;
    if (type === 'ipv4') {
      const s = ipv4ToInt(start);
      const n = Number(value);
      if (s != null && n > 0) v4.push([s, s + n - 1, ci]);
    } else if (type === 'ipv6') {
      const b = ipv6ToBigInt(start);
      const p = Number(value);
      if (b != null && p >= 0 && p <= 128) v6.push([b, p, ci]);
    }
  }
  v4.sort((a, b) => a[0] - b[0]);
  // Bitişik ya da çakışan, aynı ülkeli aralıkları birleştir
  /** @type {number[][]} */
  const m4 = [];
  for (const r of v4) {
    const last = m4[m4.length - 1];
    if (last && last[2] === r[2] && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else m4.push([...r]);
  }
  v6.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { countries, v4: m4, v6: v6.map(([b, p, ci]) => [b.toString(16).padStart(32, '0'), p, ci]) };
}
