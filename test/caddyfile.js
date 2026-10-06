// deploy/Caddyfile okuyucusu — yalnızca testler içindir (test/body-limits.test.js, test/body-gate.test.js,
// e2e/27-govde-sinirlari.spec.ts). Dosyanın BİLİNEN biçimini okur (sekme girintili, karar 141 + 143'teki yapı); biçim
// değişirse okuyucu bilerek hata verir — testler dosyayla birlikte güncellenir.
//
//   handle @ad { respond 404 }                                                     → dışarıya kapalı adresler (kapının adresi)
//   handle @ad { route { import govde_kapisi; request_body { max_size X }; import uygulama } } → kapılı büyük kademe
//   handle { request_body { max_size X }; import uygulama }                        → varsayılan kademe (kapısız)
import fs from 'node:fs';

/** Caddy'nin boyut yazımı (go-humanize): MB ondalık (10^6), MiB ikili (2^20) */
export function caddyBytes(v) {
  const m = /^(\d+)(KB|MB|GB|KiB|MiB|GiB)$/.exec(v);
  if (!m) throw new Error(`Caddyfile: boyut okunamadı: ${v}`);
  return Number(m[1]) * { KB: 1e3, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[m[2]];
}

/** Caddy "path" eşleştiricisi: tam eşleşme ya da sondaki * ile ön ek; büyük/küçük harfe bakmaz */
export const pathMatches = (pattern, p) => {
  const a = pattern.toLowerCase(), b = p.toLowerCase();
  return a.endsWith('*') ? b.startsWith(a.slice(0, -1)) : a === b;
};

/**
 * @param {string} [file]
 * @returns {{
 *   text: string, code: string,
 *   matchers: Record<string, { paths: string[], notMethods: string[] | null, smallLength: string | null }>,
 *   blocked: { name: string, paths: string[] }[],
 *   tiers: { name: string | null, paths: string[] | null, max: number, gated: boolean }[],
 *   gate: string | null,
 *   routeFor: (r: { path: string, method?: string, contentLength?: string | null }) => { blocked: boolean, tier: string | null, gated: boolean, max: number },
 *   limitFor: (path: string) => number,
 * }}
 */
export function readCaddyfile(file = 'deploy/Caddyfile') {
  const text = fs.readFileSync(file, 'utf8');
  /** Yorumsuz satırlar */
  const code = text.split('\n').map((l) => l.replace(/^\s*#.*$/, '')).join('\n');

  /** @type {Record<string, { paths: string[], notMethods: string[] | null, smallLength: string | null }>} */
  const matchers = {};
  // Tek satır: @ad path …
  for (const m of code.matchAll(/^\t@(\w+) path (.+)$/gm)) matchers[m[1]] = { paths: m[2].trim().split(/\s+/), notMethods: null, smallLength: null };
  // Blok: @ad { path … / not method … / not header_regexp Content-Length … }
  for (const m of code.matchAll(/^\t@(\w+) \{\n((?:\t\t.+\n)+)\t\}$/gm)) {
    const entry = { paths: /** @type {string[]} */ ([]), notMethods: /** @type {string[] | null} */ (null), smallLength: /** @type {string | null} */ (null) };
    for (const line of m[2].trim().split('\n').map((l) => l.trim())) {
      let x;
      if ((x = /^path (.+)$/.exec(line))) entry.paths = x[1].split(/\s+/);
      else if ((x = /^not method (.+)$/.exec(line))) entry.notMethods = x[1].split(/\s+/);
      else if ((x = /^not header_regexp Content-Length (\S+)$/.exec(line))) entry.smallLength = x[1];
      else throw new Error(`Caddyfile: @${m[1]} içinde tanınmayan satır: ${line}`);
    }
    matchers[m[1]] = entry;
  }

  const blocked = [...code.matchAll(/^\thandle @(\w+) \{\n\t\trespond 404\n\t\}$/gm)].map((m) => ({ name: m[1], paths: matchers[m[1]].paths }));
  const gated = [...code.matchAll(/^\thandle @(\w+) \{\n\t\troute \{\n\t\t\timport govde_kapisi\n\t\t\trequest_body \{\n\t\t\t\tmax_size (\w+)\n\t\t\t\}\n\t\t\timport uygulama\n\t\t\}\n\t\}$/gm)]
    .map((m) => ({ name: m[1], paths: matchers[m[1]].paths, max: caddyBytes(m[2]), gated: true }));
  const fallback = /^\thandle \{\n\t\trequest_body \{\n\t\t\tmax_size (\w+)\n\t\t\}\n\t\timport uygulama\n\t\}$/m.exec(code);
  if (!fallback) throw new Error('Caddyfile: varsayılan kademe okunamadı');
  /** Kademeler dosyadaki sırayla; eşleştiricisiz olan (varsayılan) sonda */
  const tiers = [...gated, { name: null, paths: null, max: caddyBytes(fallback[1]), gated: false }];
  const gate = /^\(govde_kapisi\) \{\n([\s\S]*?)\n\}$/m.exec(code)?.[1] ?? null;

  /** Bir isteğin düştüğü kademe. Kapılı kademeye yalnızca GET / HEAD olmayan ve gövdesi "küçük" bildirilmemiş istek girer. */
  const routeFor = ({ path, method = 'POST', contentLength = null }) => {
    if (blocked.some((b) => b.paths.some((x) => pathMatches(x, path)))) return { blocked: true, tier: null, gated: false, max: 0 };
    for (const t of gated) {
      const m = matchers[t.name];
      if (!m.paths.some((x) => pathMatches(x, path))) continue;
      if (m.notMethods?.includes(method.toUpperCase())) continue;
      if (m.smallLength && contentLength != null && new RegExp(m.smallLength).test(contentLength)) continue;
      return { blocked: false, tier: t.name, gated: true, max: t.max };
    }
    return { blocked: false, tier: null, gated: false, max: tiers[tiers.length - 1].max };
  };
  /** Adresin (yol) en büyük gövde sınırı: kapıdan geçen büyük gövdeli POST için geçerli kademe */
  const limitFor = (path) => routeFor({ path, method: 'POST', contentLength: null }).max;
  return { text, code, matchers, blocked, tiers, gate, routeFor, limitFor };
}
