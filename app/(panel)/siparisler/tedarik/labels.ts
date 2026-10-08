import type { Dict, MsgKey, T } from '@/lib/i18n';

/**
 * Tedarik ekranlarının hata metni (Paket 6). Kod adresten gelir: yalnızca bilinen kodlar metne çevrilir (bilinmeyen →
 * genel metin); satır numarası yalnızca rakamsa, dosya adı yalnızca güvenli karakterlerle yazılır.
 *   UPLOAD_<kod> → ortak yükleme metinleri (files.problem.<kod>)
 */
export function supplierErrorText(t: T, m: Dict, code: string | undefined, sp: { row?: string; name?: string } = {}): string | null {
  if (!code) return null;
  const row = /^\d{1,4}$/.test(sp.row ?? '') ? String(sp.row) : '—';
  const name = String(sp.name ?? '').replace(/[^\p{L}\p{N} ._()-]+/gu, '_').slice(0, 120);
  if (code.startsWith('UPLOAD_')) {
    const k = code.slice(7);
    return Object.hasOwn(m.files.problem, k) ? t(`files.problem.${k}` as MsgKey, { name }) : t('supplier.errors.OTHER');
  }
  if (Object.hasOwn(m.supplier.errors, code)) return t(`supplier.errors.${code}` as MsgKey, { row, name });
  return t('supplier.errors.OTHER');
}
