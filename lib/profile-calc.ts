// Profil hesaplayıcısının metinleri (Paket 5, karar 175–176): hata kodu → kullanıcının dilinde açıklama. Müşterinin
// hesaplayıcısı (siparisler/yeni/profile-calc-actions.ts) ve yöneticinin ayar ekranı (admin/profil-katalogu/hesaplama)
// aynı metni kullanır: eksik değeri ve yerini adıyla söyler. Müşteriye ayrıca "yöneticinin tamamlaması gerekiyor" eklenir.
import type { MsgKey, T } from './i18n';
import { fmtDec } from './format';

export type CalcError = { code: string; slot?: string; product?: string; color?: string | null; thicknessMm?: string | null; max?: number; system?: string };

/** Yöneticinin ayarından kaynaklanan (müşterinin düzeltemeyeceği) hatalar */
const ADMIN_CODES = new Set(['SYSTEM_EMPTY', 'NO_OPTION', 'AMBIGUOUS', 'PRODUCT_INACTIVE', 'PRODUCT_GONE', 'NO_PER_METER', 'NO_PACK', 'NO_THICKNESS']);
const KNOWN = new Set([...ADMIN_CODES, 'PROFILE_REQUIRED', 'METERS_EMPTY', 'METERS_BAD', 'METERS_ZERO', 'METERS_TOO_LARGE', 'SYSTEM_INACTIVE', 'COLOR_REQUIRED', 'THICKNESS_REQUIRED', 'NO_PRODUCTS', 'TOO_MANY']);

/** Koşulun metni: "Eloxat · 12,76 mm" (koşul yoksa "bu seçim") */
export function calcCondition(t: T, e: { color?: string | null; thicknessMm?: string | null }): string {
  const parts = [
    e.color === 'RAL7016' || e.color === 'ELOXAT' ? t(`profile.calc.colors.${e.color}` as MsgKey) : null,
    e.thicknessMm ? t('profile.calc.mm', { mm: fmtDec(e.thicknessMm, 2) }) : null,
  ].filter((x): x is string => !!x);
  return parts.length ? parts.join(' · ') : t('profile.calc.anyChoice');
}

/**
 * @param system  hesaplanan sistemin kodu (yoksa boş)
 * @param customer  müşteriye gidiyorsa yönetici gerektiren hatalara "yöneticinin tamamlaması gerekiyor" eklenir
 */
export function calcErrorText(t: T, e: CalcError, { system = '', customer = false }: { system?: string; customer?: boolean } = {}): string {
  if (!KNOWN.has(e.code)) return t('profile.calc.unavailable');
  const text = t(`profile.calc.error.${e.code}` as MsgKey, {
    slot: e.slot ?? '', product: e.product ?? '', system: e.system ?? system, condition: calcCondition(t, e), max: fmtDec(e.max ?? 0, 0),
  });
  return customer && ADMIN_CODES.has(e.code) ? `${text} ${t('profile.calc.adminNeeded')}` : text;
}
