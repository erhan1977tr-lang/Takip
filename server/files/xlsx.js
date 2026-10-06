// Excel (.xlsx) okuma/yazma — yalnızca bu uygulamanın ihtiyacı kadar: tek sayfa, metin ve sayı hücreleri.
// Okuma: ilk çalışma sayfasının hücre değerleri (paylaşılan metinler, satır içi metin, sayı, mantıksal).
// Yazma: kalın başlık satırları ve sütun genişlikleriyle tek sayfalık dosya.
//
// Okuma sınırları (denetim 3.50.9 AUD-3, karar 140) — bozuk ya da kötü niyetli dosya sınırlı sürede, XlsxError ile biter:
//   · dosya en çok EXCEL_MAX_BYTES (okuyucunun kendisi denetler; çağıran ayrıca dosyayı okumadan önce bakar);
//   · ZIP'ten yalnızca gereken 4 parça açılır (çalışma kitabı, ilişkiler, ilk sayfa, paylaşılan metinler), her biri gerçek
//     açılmış baytla sınırlı (server/files/zip.js → ZIP_LIMITS);
//   · XML düzenli ifadeyle değil indexOf ile, tek geçişte taranır (elements): kapanış etiketi olmayan öğe hemen hatadır —
//     eski "tembel" düzenli ifadeler kapanışı olmayan her etikette metnin sonuna kadar gidiyordu (karesel süre);
//   · satır, hücre ve metin sayısı sınırlıdır (SHEET_LIMITS).
import { ZipError, openZip, writeZip } from './zip.js';

export class XlsxError extends Error {}

/** Okunacak Excel dosyasının (.xlsx / .xls) en büyük boyutu: 5 MB (yönetim Excel yüklemeleriyle aynı sınır) */
export const EXCEL_MAX_BYTES = 5 * 1024 * 1024;

/**
 * İlk sayfadan okunan verinin sınırları (.xlsx ve .xls için aynı):
 *   rows : en büyük satır numarası / işlenen satır sayısı
 *   cols : tutulan en büyük sütun indeksi (sonrası yok sayılır)
 *   cells: işlenen hücre sayısı ve bellekte tutulan hücre yeri (satır uzunluklarının toplamı); paylaşılan metin sayısı
 * Uygulamanın kabul ettiği en büyük içerik 2.000 satırdır (katalog / fiyat); teklif aktarımı ilk 1.000 satır × 30 sütunu kullanır.
 */
export const SHEET_LIMITS = Object.freeze({ rows: 100_000, cols: 200, cells: 2_000_000 });

const BAD_XML = 'Excel dosyası bozuk (XML)';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** Sayısal karakter başvurusu; geçersiz kod noktası (aralık dışı, vekil) hata değil U+FFFD olur */
const codePoint = (n) => (n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�');
const unescapeXml = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) =>
    e[0] === '#' ? codePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e]);
const escapeXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  // XML 1.0'da geçersiz kontrol karakterleri atılır
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/**
 * xml içindeki <name …>…</name> / <name …/> öğeleri, sırayla — DOĞRUSAL: her adım indexOf ile ileri gider, geri dönmez.
 * Etiket adı tam eşleşmelidir (<c, <col değildir). '>' ya da kapanış etiketi yoksa XlsxError (tek taramadan sonra durur).
 * open: yalnızca açılış etiketi istenir (kapanış aranmaz).
 * @param {string} xml
 * @param {string} name
 * @param {{ open?: boolean }} [o]
 * @returns {Generator<{ attrs: string, inner: string, selfClosed: boolean }>}
 */
function* elements(xml, name, { open = false } = {}) {
  const head = `<${name}`, tail = `</${name}>`;
  let pos = 0;
  for (;;) {
    const i = xml.indexOf(head, pos);
    if (i < 0) return;
    const after = xml.charCodeAt(i + head.length);
    // adın bittiği yer: boşluk, '>' ya da '/'
    if (!(after === 62 || after === 47 || after === 32 || after === 9 || after === 10 || after === 13)) { pos = i + head.length; continue; }
    const gt = xml.indexOf('>', i + head.length);
    if (gt < 0) throw new XlsxError(BAD_XML);
    const selfClosed = xml.charCodeAt(gt - 1) === 47;
    const attrs = xml.slice(i + head.length, selfClosed ? gt - 1 : gt);
    if (selfClosed || open) { yield { attrs, inner: '', selfClosed }; pos = gt + 1; continue; }
    const close = xml.indexOf(tail, gt + 1);
    if (close < 0) throw new XlsxError(BAD_XML);
    yield { attrs, inner: xml.slice(gt + 1, close), selfClosed: false };
    pos = close + tail.length;
  }
}

/** İlk <name> öğesi (yoksa null) */
function first(xml, name, o) {
  for (const el of elements(xml, name, o)) return el;
  return null;
}

/** <t> parçalarını birleştirir (zengin metin <r><t>..</t></r> dahil; okunuş <rPh> hariç) */
function textOf(xml) {
  let src = xml;
  if (xml.includes('<rPh')) {
    // okunuş (furigana) bölümleri atılır: öğelerin dışında kalan parçalar birleştirilir
    src = '';
    let rest = xml;
    for (;;) {
      const i = rest.indexOf('<rPh');
      if (i < 0) break;
      const end = rest.indexOf('</rPh>', i);
      if (end < 0) throw new XlsxError(BAD_XML);
      src += rest.slice(0, i);
      rest = rest.slice(end + 6);
    }
    src += rest;
  }
  let out = '';
  for (const t of elements(src, 't')) out += unescapeXml(t.inner);
  return out;
}

/** @type {Map<string, RegExp>} */
const ATTR_RE = new Map();
/** Öznitelik değeri; attrs: etiket adından sonraki bölüm (' r="A1" t="s"') */
const attr = (attrs, name) => {
  let re = ATTR_RE.get(name);
  if (!re) ATTR_RE.set(name, re = new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  const m = re.exec(attrs);
  return m ? unescapeXml(m[1]) : null;
};

/** "AB12" → sütun indeksi (0 tabanlı) */
function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * İlk çalışma sayfasını satırlar halinde okur.
 * @param {Buffer} buf
 * @returns {{ sheetName: string, rows: (string | number | boolean | null)[][] }}
 */
export function readXlsx(buf) {
  if (!Buffer.isBuffer(buf)) throw new XlsxError('Excel dosyası okunamadı');
  if (buf.length > EXCEL_MAX_BYTES) throw new XlsxError('Excel dosyası çok büyük');
  try {
    return parseXlsx(buf);
  } catch (e) {
    // Her hata denetimli bir XlsxError olur (bozuk dosya RangeError / TypeError olarak sızmaz)
    if (e instanceof XlsxError) throw e;
    throw new XlsxError(e instanceof ZipError ? `Excel dosyası okunamadı (${e.message})` : 'Excel dosyası okunamadı');
  }
}

/** @param {Buffer} buf */
function parseXlsx(buf) {
  const zip = openZip(buf);
  const str = (name) => zip.read(name)?.toString('utf8') ?? null;
  const wb = str('xl/workbook.xml');
  if (!wb) throw new XlsxError('Excel (.xlsx) dosyası değil');
  const sheetTag = first(wb, 'sheet', { open: true });
  if (!sheetTag) throw new XlsxError('Çalışma sayfası yok');
  const sheetName = attr(sheetTag.attrs, 'name') ?? '';
  const rid = attr(sheetTag.attrs, 'r:id');
  let target = 'worksheets/sheet1.xml';
  const rels = str('xl/_rels/workbook.xml.rels');
  if (rels && rid) {
    for (const rel of elements(rels, 'Relationship', { open: true })) {
      if (attr(rel.attrs, 'Id') === rid) target = attr(rel.attrs, 'Target') ?? target;
    }
  }
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheet = str(path);
  if (!sheet) throw new XlsxError('Çalışma sayfası okunamadı');

  const shared = [];
  const ss = str('xl/sharedStrings.xml');
  if (ss) {
    for (const si of elements(ss, 'si')) {
      if (shared.length >= SHEET_LIMITS.cells) throw new XlsxError('Çok fazla metin');
      shared.push(textOf(si.inner));
    }
  }

  /** @type {(string | number | boolean | null)[][]} */
  const rows = [];
  let nextRow = 0, rowCount = 0, cells = 0, slots = 0;
  for (const rm of elements(sheet, 'row')) {
    const r = attr(rm.attrs, 'r');
    const ri = r ? Number(r) - 1 : nextRow;
    if (!Number.isInteger(ri) || ri < 0) throw new XlsxError(BAD_XML);
    nextRow = ri + 1;
    if (ri > SHEET_LIMITS.rows || ++rowCount > SHEET_LIMITS.rows) throw new XlsxError('Çok fazla satır');
    const row = [];
    let nextCol = 0;
    for (const cm of elements(rm.inner, 'c')) {
      if (++cells > SHEET_LIMITS.cells) throw new XlsxError('Çok fazla hücre');
      const ref = attr(cm.attrs, 'r');
      const ci = ref ? colIndex(ref) : nextCol;
      nextCol = ci + 1;
      if (!(ci >= 0) || ci > SHEET_LIMITS.cols) continue;
      const t = attr(cm.attrs, 't');
      const inner = cm.inner;
      const vEl = inner ? first(inner, 'v') : null;
      const v = vEl && !vEl.selfClosed ? vEl.inner : undefined; // <v/> değer yok sayılır
      let val = null;
      if (t === 's') val = v != null ? (shared[Number(v)] ?? null) : null;
      else if (t === 'inlineStr') val = textOf(first(inner, 'is')?.inner ?? '');
      else if (t === 'str' || t === 'e') val = v != null ? unescapeXml(v) : null;
      else if (t === 'b') val = v === '1';
      else if (v != null && v !== '') val = Number(v);
      row[ci] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    slots += row.length;
    if (slots > SHEET_LIMITS.cells) throw new XlsxError('Çok fazla hücre');
    rows[ri] = row;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return { sheetName, rows };
}

const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/**
 * Tek sayfalık .xlsx oluşturur.
 * @param {{ sheetName: string, rows: (string | number | null | undefined)[][], bold?: number[], widths?: number[] }} p
 *   bold: kalın yazılacak satır indeksleri (0 tabanlı); widths: sütun genişlikleri (karakter)
 * @returns {Buffer}
 */
export function writeXlsx({ sheetName, rows, bold = [], widths = [] }) {
  const boldSet = new Set(bold);
  const name = escapeXml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sayfa1');
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const body = rows.map((row, ri) => {
    const s = boldSet.has(ri) ? ' s="1"' : '';
    const cells = row.map((v, ci) => {
      if (v == null || v === '') return '';
      const ref = `${colName(ci)}${ri + 1}`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  return writeZip([
    { name: '[Content_Types].xml', data: `${xmlHead}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${xmlHead}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `${xmlHead}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', data: `${xmlHead}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>` },
  ]);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
