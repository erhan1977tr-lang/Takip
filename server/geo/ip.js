// IPv4 / IPv6 adreslerini sayıya çevirme (bağımlılıksız).

/**
 * "85.105.1.2" → sayı; geçersizse null.
 * @param {string} ip
 * @returns {number | null}
 */
export function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip).trim());
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
}

/**
 * "2a02:2f0::1" → BigInt; geçersizse null. "::ffff:1.2.3.4" gibi IPv4 sonekli yazımı da çözer.
 * @param {string} ip
 * @returns {bigint | null}
 */
export function ipv6ToBigInt(ip) {
  let s = String(ip).trim().toLowerCase().split('%')[0];
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(':')) return null;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n == null) return null;
    s = `${s.slice(0, -v4[1].length)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let groups;
  if (parts.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}
