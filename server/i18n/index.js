// Dil altyapısı: Romence (ro) ve Türkçe (tr). Sözlükler server/i18n/<dil>/ altında, ad alanlarına bölünmüştür.
// İki dilin anahtarları birebir aynı olmalıdır (test/i18n.test.js kontrol eder).
import tr from './tr/index.js';
import ro from './ro/index.js';
import { interpolate } from './interpolate.js';

export { interpolate };
export const LOCALES = /** @type {const} */ (['ro', 'tr']);
export const DEFAULT_LOCALE = 'ro';
export const LOCALE_COOKIE = 'takip_lang';
/** Intl biçimlendirme dili */
export const INTL = { ro: 'ro-RO', tr: 'tr-TR' };
export const DICTS = { ro, tr };

/**
 * @param {unknown} x
 * @returns {x is 'ro' | 'tr'}
 */
export function isLocale(x) {
  return x === 'ro' || x === 'tr';
}

/**
 * @param {any} dict
 * @param {string} key
 */
function lookup(dict, key) {
  let o = dict;
  for (const k of key.split('.')) {
    if (o == null || typeof o !== 'object') return undefined;
    o = o[k];
  }
  return o;
}

/**
 * Anahtarın çevirisi. Bulunamazsa Türkçesi, o da yoksa anahtarın kendisi döner.
 * @param {'ro' | 'tr'} locale
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function translate(locale, key, params) {
  const v = lookup(DICTS[locale], key) ?? lookup(DICTS.tr, key);
  return typeof v === 'string' ? interpolate(v, params) : key;
}
