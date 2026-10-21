// Ticari teklif → Cam: Excel dosyasının OKUNMASI (4.1.0, karar 298) — yalnızca sunucu. Dosya kalıcı olarak saklanmaz: tarayıcıdan
// gelen içerik bellekte okunur, satırlar döner, içerik bırakılır. Çağıran (app/(panel)/admin/ticari-teklifler/actions.ts →
// readCommercialExcelAction) önce COMMERCIAL_OFFER_MANAGE yetkisini, sonra boyutu dosya belleğe alınmadan denetler.
//
// Okuma ve kaynak sınırları satış ekibinin aktarımıyla AYNI kod: parseExcel (içeriğe göre .xls / .xlsx; okuyucuların ZIP / XLS /
// sayfa sınırları — karar 140) ve previewRows (1000 satır × 30 sütun, hücre ve toplam metin sınırı — karar 152).
import { createHash } from 'node:crypto';
import { parseExcel, previewRows } from '../orders/excel-file.js';
import { COMMERCIAL_IMPORT_MAX_BYTES } from './excel-import.js';

/** Dosya adı .xls / .xlsx mi (içerik ayrıca okuyucunun kendi imza denetiminden geçer) */
export const excelName = (name) => /\.xlsx?$/i.test(String(name ?? '').trim());

/**
 * @param {Buffer} buf  dosyanın içeriği (boyutu çağıran okumadan önce denetler; burada yeniden denetlenir)
 * @param {{ parse?: (buf: Buffer) => { rows: unknown[][] } }} [io]  testler için
 * @returns {{ ok: true, rows: string[][], fingerprint: string } | { ok: false, error: 'EMPTY' | 'TOO_BIG' | 'TOO_MUCH_TEXT' | 'UNREADABLE' }}
 *   fingerprint: içeriğin SHA-256 özeti (aynı dosyanın tekrar aktarımı uyarısı için; saklanmaz)
 */
export function readCommercialExcel(buf, { parse = (b) => parseExcel(b) } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, error: 'EMPTY' };
  if (buf.length > COMMERCIAL_IMPORT_MAX_BYTES) return { ok: false, error: 'TOO_BIG' };
  let rows;
  try {
    ({ rows } = parse(buf));
  } catch {
    return { ok: false, error: 'UNREADABLE' };
  }
  const preview = previewRows(rows);
  if (!preview.ok) return { ok: false, error: preview.error };
  return { ok: true, rows: preview.rows, fingerprint: createHash('sha256').update(buf).digest('hex') };
}
