// Teklif tablosuna Excel'den aktarma — siparişe yüklenmiş dosyanın OKUNMASI (sunucu tarafı; satır doğrulama: excel-import.js).
// Denetim 3.50.9 AUD-3, karar 140: sipariş dosyası 100 MB'a kadar olabilir; Excel okuyucu ise yalnızca küçük dosyalar
// içindir. Bu yüzden boyut sınırı dosya belleğe ALINMADAN önce uygulanır: önce kayıtlı boyuta, sonra diskteki gerçek
// boyuta bakılır; ancak ikisi de sınırın altındaysa dosya okunur ve ayrıştırılır (okuyucular aynı sınırı kendileri de
// denetler: server/files/xlsx.js → EXCEL_MAX_BYTES).
import fsp from 'node:fs/promises';
import { EXCEL_MAX_BYTES, readXlsx } from '../files/xlsx.js';
import { isXls, readXls } from '../files/xls.js';
import { IMPORT_MAX_COLS, IMPORT_MAX_ROWS } from './excel-import.js';

/** Teklife aktarılacak Excel dosyasının en büyük boyutu (5 MB — yönetim Excel yüklemeleriyle aynı) */
export const IMPORT_MAX_BYTES = EXCEL_MAX_BYTES;

/** İçeriğe göre: eski .xls (OLE2) ya da .xlsx (zip; .xls adıyla kaydedilmiş .xlsx de olur) */
export const parseExcel = (buf) => (isXls(buf) ? readXls(buf) : readXlsx(buf));

/**
 * Siparişe yüklenmiş Excel dosyasının satırları (ön izleme için metne çevrilmiş, ilk IMPORT_MAX_ROWS × IMPORT_MAX_COLS).
 * Hiçbir şey kaydetmez. Yetki, sipariş kapsamı ve dosya seçimi çağıranın işidir (readOfferExcelAction).
 * @param {{ path: string | null, size?: number | null }} file  path: diskteki tam yol; size: kayıtlı boyut (OrderFile.size)
 * @param {{ stat?: typeof fsp.stat, readFile?: typeof fsp.readFile, parse?: (buf: Buffer) => { rows: unknown[][] } }} [io]  testler için
 * @returns {Promise<{ ok: true, rows: string[][] } | { ok: false, error: 'NO_FILE' | 'TOO_BIG' | 'UNREADABLE' }>}
 */
export async function readOfferExcel(file, { stat = fsp.stat, readFile = fsp.readFile, parse = parseExcel } = {}) {
  if (!file?.path) return { ok: false, error: 'NO_FILE' };
  // 1) Kayıtlı boyut  2) diskteki gerçek boyut — ikisi de dosya okunmadan önce
  if (Number(file.size) > IMPORT_MAX_BYTES) return { ok: false, error: 'TOO_BIG' };
  let info;
  try {
    info = await stat(file.path);
  } catch {
    return { ok: false, error: 'NO_FILE' };
  }
  if (!info.isFile()) return { ok: false, error: 'NO_FILE' };
  if (info.size > IMPORT_MAX_BYTES) return { ok: false, error: 'TOO_BIG' };
  try {
    const buf = await readFile(file.path);
    if (buf.length > IMPORT_MAX_BYTES) return { ok: false, error: 'TOO_BIG' };
    const { rows } = parse(buf);
    const text = (v) => (v == null ? '' : String(v));
    return { ok: true, rows: rows.slice(0, IMPORT_MAX_ROWS).map((r) => r.slice(0, IMPORT_MAX_COLS).map(text)) };
  } catch {
    return { ok: false, error: 'UNREADABLE' };
  }
}
