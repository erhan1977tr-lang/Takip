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

// Ön izleme sınırları (GO-LIVE saldırı turu NEW-GL-01, karar 152). Okuyucular aynı metni paylaşan hücrelere AYNI dizeyi
// verir (paylaşılan metin tablosu): birkaç KB'lık dosyada 1.000.000 karakterlik tek metne 30.000 hücre başvurabilir.
// Bellekte bu tek dizedir; ama ön izleme tarayıcıya yazılırken her hücre ayrı ayrı yazılır (30 GB). Bu yüzden sınır,
// hücre sonuca EKLENMEDEN önce uygulanır — dev metin hiçbir aşamada üretilmez.
/** Ön izleme penceresinin en çok hücre sayısı (IMPORT_MAX_ROWS × IMPORT_MAX_COLS; pencerenin dışı okunmaz) */
export const IMPORT_MAX_CELLS = 30_000;
/** Tek hücrenin metni: Excel'in kendi hücre sınırı (32.767 karakter) — daha uzunu Excel ile üretilmiş bir dosya değildir */
export const IMPORT_MAX_CELL_CHARS = 32_767;
/** Ön izlemede dönen toplam metin (karakter = UTF-16 birimi; UTF-8'de en çok 3 MB) */
export const IMPORT_MAX_TEXT_CHARS = 1_000_000;

/** İçeriğe göre: eski .xls (OLE2) ya da .xlsx (zip; .xls adıyla kaydedilmiş .xlsx de olur) */
export const parseExcel = (buf) => (isXls(buf) ? readXls(buf) : readXlsx(buf));

/**
 * Okuyucunun verdiği satırlardan ön izleme penceresini üretir (saf fonksiyon). Sınırlar ÜRETİM SIRASINDA uygulanır:
 * her hücrenin uzunluğuna ve o ana kadarki toplama, hücre sonuca eklenmeden ÖNCE bakılır (uzunluk okumak kopya üretmez);
 * sınır aşılırsa hiçbir satır dönmez. Metin hücreleri kopyalanmaz (aynı dize), sayı / mantıksal değer en çok ~25 karakterdir.
 * Pencerenin dışındaki satır ve sütunlara hiç bakılmaz (eski davranış: ilk 1000 satır × 30 sütun).
 * @param {unknown} rows  okuyucunun satırları: (string | number | boolean | null)[][]
 * @param {{ maxRows?: number, maxCols?: number, maxCells?: number, maxCellChars?: number, maxTextChars?: number }} [limits]  testler için
 * @returns {{ ok: true, rows: string[][], cells: number, chars: number } | { ok: false, error: 'TOO_MUCH_TEXT' | 'UNREADABLE', reason: 'cells' | 'cell' | 'total' | 'type' }}
 */
export function previewRows(rows, limits = {}) {
  const {
    maxRows = IMPORT_MAX_ROWS, maxCols = IMPORT_MAX_COLS, maxCells = IMPORT_MAX_CELLS,
    maxCellChars = IMPORT_MAX_CELL_CHARS, maxTextChars = IMPORT_MAX_TEXT_CHARS,
  } = limits;
  if (!Array.isArray(rows)) return { ok: false, error: 'UNREADABLE', reason: 'type' };
  const tooMuch = (reason) => ({ ok: false, error: /** @type {const} */ ('TOO_MUCH_TEXT'), reason });
  const out = [];
  let cells = 0;
  let chars = 0;
  const nRows = Math.min(rows.length, maxRows);
  for (let i = 0; i < nRows; i++) {
    const r = rows[i];
    const nCols = Array.isArray(r) ? Math.min(r.length, maxCols) : 0;
    const line = [];
    for (let c = 0; c < nCols; c++) {
      if (++cells > maxCells) return tooMuch('cells');
      const v = r[c];
      let s;
      if (v == null) s = '';
      else if (typeof v === 'string') s = v;
      else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
      else return { ok: false, error: 'UNREADABLE', reason: 'type' }; // okuyucular başka tür vermez; nesnenin toString'i çağrılmaz
      if (s.length > maxCellChars) return tooMuch('cell');
      chars += s.length;
      if (chars > maxTextChars) return tooMuch('total');
      line.push(s);
    }
    out.push(line);
  }
  return { ok: true, rows: out, cells, chars };
}

/**
 * Siparişe yüklenmiş Excel dosyasının satırları (ön izleme için metne çevrilmiş, ilk IMPORT_MAX_ROWS × IMPORT_MAX_COLS).
 * Hiçbir şey kaydetmez. Yetki, sipariş kapsamı ve dosya seçimi çağıranın işidir (readOfferExcelAction).
 * Ön izlemenin metni sınırlıdır (previewRows): tek hücre ya da toplam metin sınırı aşarsa 'TOO_MUCH_TEXT' döner.
 * @param {{ path: string | null, size?: number | null }} file  path: diskteki tam yol; size: kayıtlı boyut (OrderFile.size)
 * @param {{ stat?: typeof fsp.stat, readFile?: typeof fsp.readFile, parse?: (buf: Buffer) => { rows: unknown[][] } }} [io]  testler için
 * @returns {Promise<{ ok: true, rows: string[][] } | { ok: false, error: 'NO_FILE' | 'TOO_BIG' | 'TOO_MUCH_TEXT' | 'UNREADABLE' }>}
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
    const preview = previewRows(rows);
    return preview.ok ? { ok: true, rows: preview.rows } : { ok: false, error: preview.error };
  } catch {
    return { ok: false, error: 'UNREADABLE' };
  }
}
