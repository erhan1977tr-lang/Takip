// Giriş sayfasının dili: çerez yoksa bağlantının geldiği ülkeye (IP), o da bilinmiyorsa tarayıcı diline göre.
import { DEFAULT_LOCALE } from './index.js';
import { countryOf } from '../geo/lookup.js';

/**
 * Ülke kodundan dil: Türkiye → tr; Romanya ve Moldova → ro; diğerleri → null.
 * @param {string | null | undefined} cc
 * @returns {'ro' | 'tr' | null}
 */
export function localeForCountry(cc) {
  const c = String(cc || '').toUpperCase();
  if (c === 'TR') return 'tr';
  if (c === 'RO' || c === 'MD') return 'ro';
  return null;
}

/**
 * Accept-Language başlığında (öncelik sırasıyla) ilk Türkçe ya da Romence dil.
 * @param {string | null | undefined} header
 * @returns {'ro' | 'tr' | null}
 */
export function localeFromAcceptLanguage(header) {
  if (!header) return null;
  const langs = header.split(',').map((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map((x) => /^\s*q=([\d.]+)/.exec(x)).find(Boolean);
    return { tag: tag.trim().toLowerCase(), q: q ? Number(q[1]) : 1, i };
  }).filter((l) => l.tag && l.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const l of langs) {
    const primary = l.tag.split('-')[0];
    if (primary === 'tr') return 'tr';
    if (primary === 'ro' || primary === 'mo') return 'ro';
  }
  return null;
}

/**
 * İstemcinin IP adresi: Cloudflare varsa CF-Connecting-IP, yoksa X-Forwarded-For'un ilk değeri, yoksa X-Real-IP.
 * (Sunucuda uygulamaya yalnızca Caddy üzerinden erişilir; Caddy bu başlığı kendisi yazar.)
 * @param {(name: string) => string | null} get
 * @returns {string | null}
 */
export function clientIp(get) {
  const cf = get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim() || null;
  const real = get('x-real-ip');
  return real ? real.trim() : null;
}

/**
 * @param {{ country?: string | null, ip?: string | null, acceptLanguage?: string | null }} p
 * @param {(ip: string) => string | null} [lookup]
 * @returns {'ro' | 'tr'}
 */
export function detectLocale({ country = null, ip = null, acceptLanguage = null }, lookup = countryOf) {
  return (
    localeForCountry(country) ??
    (ip ? localeForCountry(lookup(ip)) : null) ??
    localeFromAcceptLanguage(acceptLanguage) ??
    /** @type {'ro' | 'tr'} */ (DEFAULT_LOCALE)
  );
}
