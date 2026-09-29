// Sunucu tarafı dil yardımcıları. Kullanım (sunucu bileşeni ya da sunucu işlemi):
//   const { t, locale, m } = await getT();
//   t('status.order.YENI')                        → "İnceleniyor" / "În analiză"
//   t('offerProblems.rowGlass', { n: 2 })          → "2. satır" / "rândul 2"
//   <ClientBilesen m={m.offer} />                  → istemci bileşenine yalnızca gereken sözlük parçası
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import type trDict from '@/server/i18n/tr/index.js';
import { DICTS, INTL, LOCALE_COOKIE, isLocale, translate } from '@/server/i18n/index.js';
import { clientIp, detectLocale } from '@/server/i18n/detect.js';
import { secureCookies } from './env';

export type Locale = 'ro' | 'tr';
export type Dict = typeof trDict;
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : T[K] extends object ? Leaves<T[K], `${P}${K}.`> : never;
}[keyof T & string];
/** Sözlükteki tüm anahtarlar ("status.order.YENI" gibi) */
export type MsgKey = Leaves<Dict>;
export type TParams = Record<string, string | number>;
export type T = (key: MsgKey, params?: TParams) => string;

/**
 * Bu isteğin dili: önce kullanıcının seçimi (çerez), yoksa bağlantının ülkesi (IP), yoksa tarayıcı dili, yoksa Romence.
 * Girişte ve dil değiştirilince çerez yazılır; panel o dille devam eder.
 */
export const getLocale = cache(async (): Promise<Locale> => {
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(c)) return c;
  const h = await headers();
  return detectLocale({
    country: h.get('cf-ipcountry'),
    ip: clientIp((n) => h.get(n)),
    acceptLanguage: h.get('accept-language'),
  });
});

export async function getT(): Promise<{ t: T; locale: Locale; m: Dict; intl: string }> {
  const locale = await getLocale();
  const t: T = (key, params) => translate(locale, key, params);
  return { t, locale, m: DICTS[locale] as Dict, intl: INTL[locale] };
}

/** Dil seçimini çereze yazar. Yalnızca sunucu işlemi ya da route handler içinden çağrılır. */
export async function setLocaleCookie(locale: Locale): Promise<void> {
  (await cookies()).set(LOCALE_COOKIE, locale, {
    httpOnly: false,
    sameSite: 'lax',
    secure: secureCookies(),
    path: '/',
    maxAge: 365 * 86_400,
  });
}
