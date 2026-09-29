// Excel (.xlsx) okuma/yazma — yalnızca bu uygulamanın ihtiyacı kadar: tek sayfa, metin ve sayı hücreleri.
// Okuma: ilk çalışma sayfasının hücre değerleri (paylaşılan metinler, satır içi metin, sayı, mantıksal).
// Yazma: kalın başlık satırları ve sütun genişlikleriyle tek sayfalık dosya.
import { ZipError, readZip, writeZip } from './zip.js';

export class XlsxError extends Error {}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e]);
const escapeXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  // XML 1.0'da geçersiz kontrol karakterleri atılır
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** <t> parçalarını birleştirir (zengin metin <r><t>..</t></r> dahil; okunuş <rPh> hariç) */
function textOf(xml) {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)]
    .map((m) => unescapeXml(m[1] ?? '')).join('');
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
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
  let files;
  try {
    files = readZip(buf);
  } catch (e) {
    throw new XlsxError(e instanceof ZipError ? `Excel dosyası okunamadı (${e.message})` : 'Excel dosyası okunamadı');
  }
  const str = (name) => files.get(name)?.toString('utf8') ?? null;
  const wb = str('xl/workbook.xml');
  if (!wb) throw new XlsxError('Excel (.xlsx) dosyası değil');
  const sheetTag = wb.match(/<sheet\b[^>]*>/)?.[0];
  if (!sheetTag) throw new XlsxError('Çalışma sayfası yok');
  const sheetName = attr(sheetTag, 'name') ?? '';
  const rid = attr(sheetTag, 'r:id');
  let target = 'worksheets/sheet1.xml';
  const rels = str('xl/_rels/workbook.xml.rels');
  if (rels && rid) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attr(m[0], 'Id') === rid) target = attr(m[0], 'Target') ?? target;
    }
  }
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheet = str(path);
  if (!sheet) throw new XlsxError('Çalışma sayfası okunamadı');

  const shared = [];
  const ss = str('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(textOf(m[1] ?? ''));

  /** @type {(string | number | boolean | null)[][]} */
  const rows = [];
  let nextRow = 0;
  for (const rm of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = attr(`<row ${rm[1]}>`, 'r');
    const ri = r ? Number(r) - 1 : nextRow;
    nextRow = ri + 1;
    if (ri > 100_000) throw new XlsxError('Çok fazla satır');
    const row = [];
    let nextCol = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c ${cm[1]}>`;
      const ref = attr(tag, 'r');
      const ci = ref ? colIndex(ref) : nextCol;
      nextCol = ci + 1;
      if (ci > 200) continue;
      const t = attr(tag, 't');
      const inner = cm[2] ?? '';
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let val = null;
      if (t === 's') val = v != null ? (shared[Number(v)] ?? null) : null;
      else if (t === 'inlineStr') val = textOf(inner.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? '');
      else if (t === 'str' || t === 'e') val = v != null ? unescapeXml(v) : null;
      else if (t === 'b') val = v === '1';
      else if (v != null && v !== '') val = Number(v);
      row[ci] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
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
