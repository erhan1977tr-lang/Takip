// Profesyonel Excel raporu — TAKİP'in BÜTÜN Excel çıktılarının ortak yazıcısı (Paket 7, karar 190).
//
// Her sayfada: resmî GKH logosu (saydam PNG olduğu gibi gömülür, oranı korunur; sağ üstte, başlık satırlarının üzerinde —
// veri hücresinin üstüne binmez), başlık + tarih satırı, biçimli tablo başlığı, sütun genişlikleri, ilk tabloda AutoFilter,
// başlık satırının altından dondurulmuş bölme, sayı / birim / para biçimleri (değer SAYI olarak kalır: süzülür, toplanır),
// uzun metinde satır kaydırma, tablolar arasında tek ayraç satırı (gereksiz boş satır / sütun yok), yazdırma alanı, her
// basılı sayfada yinelenen başlık satırı, sayfaya sığdırma, altbilgide resmî firma adı ve sayfa numarası.
//
// Bu modül veri HESAPLAMAZ ve yetki bilmez: hücre değerleri çağıranın verdiğidir (rol süzgeci, maskeleme ve tutar seçimi
// çağıranda). Yeniden yüklenen Excel'ler (fiyat, cam kataloğu, profil kataloğu, stok) aynı başlık metinleri ve sütun sırasıyla
// yazılır; içe aktarma başlık satırını içerikten bulur (server/files/xlsx.js → readXlsx yalnızca hücre değerlerini okur —
// logo, biçim ve tanımlı adlar okumayı etkilemez).
import { writeZip } from './zip.js';
import { BRAND, brandLogoBytes, brandLogoSize } from '../branding/index.js';

/**
 * @typedef {'text' | 'wrap' | 'int' | 'dec2' | 'dec3' | 'kg' | 'm2' | 'mm' | 'money'} ColType
 * @typedef {{ header: string, width: number, type?: ColType, unit?: string, span?: number }} Column
 *   width: karakter · unit: para birimi (yalnızca money — hücre biçimine yazılır: "1.234,50 EUR") · span: sütunun kapladığı
 *   hücre sayısı (birleştirilir; aynı sayfadaki ikinci tablo ilk tablonun sütunlarına hizalanır — sütun genişliğini ilk tablo
 *   belirler)
 * @typedef {string | number | null | undefined} Cell
 * @typedef {{ title?: string, columns: Column[], rows: Cell[][], totals?: Cell[][], empty?: string }} Block
 *   totals: tablonun altındaki toplam satırları (kalın; süzgeç aralığına girmez) · empty: satır yoksa yazılacak cümle
 * @typedef {{ name: string, title: string, subtitle?: string, info?: [string, Cell][], blocks: Block[], notes?: string[], landscape?: boolean }} Sheet
 */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); // XML 1.0'da geçersiz kontrol karakterleri atılır

/** 0 → A, 25 → Z, 26 → AA */
export const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Sayfa adı: Excel'in yasak karakterleri olmadan, en çok 31 karakter, kitapta tek */
function sheetNames(sheets) {
  const used = new Set();
  return sheets.map((s, i) => {
    const base = String(s.name ?? '').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || `Sayfa${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}
/** Tanımlı ad başvurusundaki sayfa adı: tek tırnak içinde, tırnak ikilenir */
const quoteSheet = (name) => `'${name.replace(/'/g, "''")}'`;

// ---------------- biçimler ----------------
const FONTS = [
  '<font><sz val="11"/><color rgb="FF1B2330"/><name val="Calibri"/><family val="2"/></font>', // 0 Normal (sütun birimi bunun genişliğinden)
  '<font><sz val="10"/><color rgb="FF1B2330"/><name val="Calibri"/><family val="2"/></font>', // 1 veri
  '<font><b/><sz val="10"/><color rgb="FF1B2330"/><name val="Calibri"/><family val="2"/></font>', // 2 kalın veri / toplam / başlık hücresi
  '<font><b/><sz val="15"/><color rgb="FF1C4B91"/><name val="Calibri"/><family val="2"/></font>', // 3 belge başlığı (GKH mavisi)
  '<font><sz val="9.5"/><color rgb="FF5D6877"/><name val="Calibri"/><family val="2"/></font>', // 4 alt başlık (tarih)
  '<font><i/><sz val="9"/><color rgb="FF5D6877"/><name val="Calibri"/><family val="2"/></font>', // 5 not
  '<font><b/><sz val="11"/><color rgb="FF1C4B91"/><name val="Calibri"/><family val="2"/></font>', // 6 tablo başlığı (blok adı)
];
const FILLS = [
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEAF1FB"/><bgColor indexed="64"/></patternFill></fill>', // 2 tablo başlığı
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F1"/><bgColor indexed="64"/></patternFill></fill>', // 3 toplam
];
const THIN = 'FFD7DAE0';
const BORDERS = [
  '<border><left/><right/><top/><bottom/><diagonal/></border>',
  `<border><left style="thin"><color rgb="${THIN}"/></left><right style="thin"><color rgb="${THIN}"/></right><top style="thin"><color rgb="${THIN}"/></top><bottom style="thin"><color rgb="${THIN}"/></bottom><diagonal/></border>`,
  `<border><left style="thin"><color rgb="${THIN}"/></left><right style="thin"><color rgb="${THIN}"/></right><top style="medium"><color rgb="FF1C4B91"/></top><bottom style="thin"><color rgb="${THIN}"/></bottom><diagonal/></border>`,
];

/** Sütun türünün sayı biçimi (yerleşik kimlik ya da özel biçim kodu) */
function formatOf(col) {
  switch (col?.type) {
    case 'int': return { id: 3 }; // #,##0
    case 'dec2': return { id: 4 }; // #,##0.00
    case 'dec3': return { code: '#,##0.000' };
    case 'kg': return { code: '#,##0" kg"' };
    case 'm2': return { code: '#,##0.000" m²"' }; // m² her yerde 3 ondalık (karar 232)
    case 'mm': return { id: 1 }; // 0
    case 'money': return col.unit ? { code: `#,##0.00" ${String(col.unit).replace(/"/g, '')}"` } : { id: 4 };
    default: return { id: 0 };
  }
}
const isNumericType = (t) => ['int', 'dec2', 'dec3', 'kg', 'm2', 'mm', 'money'].includes(t ?? 'text');

/** Kitap genelinde biçim kaydı: aynı birleşim bir kez yazılır */
function styleBook() {
  const numFmts = new Map(); // kod → kimlik
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const index = new Map();
  const numId = (f) => {
    if (f.id != null) return f.id;
    if (!numFmts.has(f.code)) numFmts.set(f.code, 164 + numFmts.size);
    return numFmts.get(f.code);
  };
  /** @param {{ font?: number, fill?: number, border?: number, num?: { id?: number, code?: string }, align?: string }} s */
  const style = (s) => {
    const key = JSON.stringify(s);
    if (index.has(key)) return index.get(key);
    const num = numId(s.num ?? { id: 0 });
    const align = s.align ? `<alignment ${s.align}/>` : '';
    xfs.push(`<xf numFmtId="${num}" fontId="${s.font ?? 1}" fillId="${s.fill ?? 0}" borderId="${s.border ?? 0}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"${align ? ' applyAlignment="1"' : ''}>${align}</xf>`);
    index.set(key, xfs.length - 1);
    return xfs.length - 1;
  };
  const xml = () => {
    const fmts = numFmts.size ? `<numFmts count="${numFmts.size}">${[...numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('')}</numFmts>` : '';
    return `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">${fmts}<fonts count="${FONTS.length}">${FONTS.join('')}</fonts><fills count="${FILLS.length}">${FILLS.join('')}</fills>` +
      `<borders count="${BORDERS.length}">${BORDERS.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  };
  return { style, xml };
}

/**
 * Satır dizisi düzeninde (0 = belge başlığı; başlıkla tablo başlığı arasında anahtar / değer satırları; headerIndex = tablo
 * başlığı; sonrası veri) üretilen sayfayı rapor sayfasına çevirir. Yeniden yüklenen Excel'ler (fiyat, katalog, profil kataloğu,
 * stok) bunu kullanır: veriyi üreten işlev tek kalır, başlık metinleri ve sütun sırası değişmez; boş ayraç satırları atılır.
 * @param {{ name: string, rows: Cell[][], headerIndex: number, widths: number[], types?: (ColType | undefined)[], subtitle?: string, landscape?: boolean }} p
 * @returns {Sheet}
 */
export function sheetFromRows({ name, rows, headerIndex, widths, types = [], subtitle, landscape = false }) {
  const filled = (r) => Array.isArray(r) && r.some((c) => c != null && c !== '');
  return {
    name, title: String(rows[0]?.[0] ?? name), subtitle, landscape,
    info: rows.slice(1, headerIndex).filter(filled).map((r) => [String(r[0] ?? ''), r[1] ?? '']),
    blocks: [{
      columns: rows[headerIndex].map((h, i) => ({ header: String(h ?? ''), width: widths[i] ?? 14, type: types[i] ?? 'text' })),
      rows: rows.slice(headerIndex + 1).filter(filled),
    }],
  };
}

/** Sütun genişliğinin (karakter) ekrandaki piksel karşılığı (Calibri 11 — en geniş rakam 7 px) */
const colPx = (w) => Math.floor(((256 * w + 18) / 256) * 7);
const EMU = 9525; // 1 piksel
const LOGO_PX = 46; // logo yüksekliği (piksel) — başlık + tarih satırının içinde kalır (28 + 17 pt ≈ 60 px)

/** Kaydırılan metnin satır yüksekliği tahmini (Excel açılışta kendiliğinden uydurmaz; satır yüksekliği yazılır) */
function wrapHeight(cells, cols) {
  let lines = 1;
  cells.forEach((v, i) => {
    if (cols[i]?.type !== 'wrap' || v == null || v === '') return;
    const perLine = Math.max(4, Math.floor((cols[i].width ?? 10) * 1.15));
    const n = String(v).split('\n').reduce((s, part) => s + Math.max(1, Math.ceil(part.length / perLine)), 0);
    lines = Math.max(lines, n);
  });
  return lines > 1 ? Math.min(409, lines * 13 + 3) : null;
}

/**
 * Raporu .xlsx olarak yazar.
 * @param {{ sheets: Sheet[], company?: string, logo?: Buffer | null }} p  logo: verilmezse resmî GKH logosu (null: logosuz)
 * @returns {Buffer}
 */
export function writeReportXlsx({ sheets, company = BRAND.company, logo }) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('rapor: en az bir sayfa gerekir');
  const png = logo === undefined ? brandLogoBytes() : logo;
  const names = sheetNames(sheets);
  const book = styleBook();
  const S = {
    title: book.style({ font: 3, align: 'vertical="center"' }),
    sub: book.style({ font: 4, align: 'vertical="center"' }),
    infoKey: book.style({ font: 2, align: 'vertical="top"' }),
    infoVal: book.style({ font: 1, align: 'horizontal="left" vertical="top"' }),
    block: book.style({ font: 6, align: 'vertical="center"' }),
    note: book.style({ font: 5, align: 'vertical="top"' }),
    head: book.style({ font: 2, fill: 2, border: 1, align: 'horizontal="center" vertical="center" wrapText="1"' }),
  };
  /** Veri / toplam hücresinin biçimi (sütun türüne göre) */
  const cellStyle = (col, value, total) => {
    const numeric = isNumericType(col?.type);
    const isNum = typeof value === 'number' && Number.isFinite(value);
    const base = total ? { font: 2, fill: 3, border: 2 } : { font: 1, border: 1 };
    if (isNum) return book.style({ ...base, num: formatOf(col), align: 'vertical="top"' });
    if (numeric) return book.style({ ...base, align: 'horizontal="right" vertical="top"' });
    return book.style({ ...base, align: col?.type === 'wrap' ? 'vertical="top" wrapText="1"' : 'vertical="top"' });
  };

  const files = [];
  const defined = [];
  const sheetRels = [];
  sheets.forEach((sheet, si) => {
    const name = names[si];
    // Sütun genişlikleri İLK tablodan; sonraki tablolar yalnızca ilk tablonun bittiği yerden sonrasını belirler (hizalı düzen)
    /** @type {number[]} */
    const cols = [];
    const posOf = sheet.blocks.map((b) => {
      let p = 0;
      return b.columns.map((c) => { const at = p; p += Math.max(1, c.span ?? 1); return at; });
    });
    sheet.blocks.forEach((b, bi) => b.columns.forEach((c, i) => {
      const span = Math.max(1, c.span ?? 1);
      for (let k = 0; k < span; k++) if (cols[posOf[bi][i] + k] == null) cols[posOf[bi][i] + k] = span === 1 ? c.width ?? 10 : Math.max(6, Math.round((c.width ?? 10) / span));
    }));
    /** @type {string[]} */
    const merges = [];
    const width = Math.max(cols.length, sheet.info?.length ? 2 : 1);
    if (cols.length < width) for (let i = cols.length; i < width; i++) cols[i] = 14;
    /** @type {string[]} */
    const rowsXml = [];
    let r = 0; // son yazılan satır (1 tabanlı)
    const row = (cells, { ht = null } = {}) => {
      r += 1;
      const body = cells.map(([ci, v, s]) => {
        if (v == null || v === '') return s != null ? `<c r="${colName(ci)}${r}" s="${s}"/>` : '';
        const ref = `${colName(ci)}${r}`;
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${s ?? 0}"><v>${v}</v></c>`;
        return `<c r="${ref}" s="${s ?? 0}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }).join('');
      rowsXml.push(`<row r="${r}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${body}</row>`);
      return r;
    };
    row([[0, sheet.title, S.title]], { ht: 28 });
    if (sheet.subtitle) row([[0, sheet.subtitle, S.sub]], { ht: 17 });
    else row([], { ht: 17 }); // logonun yeri (başlık bloğu iki satır)
    for (const [k, v] of sheet.info ?? []) row([[0, k, S.infoKey], [1, v, S.infoVal]]);
    let first = null; // ilk tablonun başlık ve son veri satırı
    sheet.blocks.forEach((b, bi) => {
      if (bi > 0 || sheet.info?.length) row([]); // tablolar arasında tek ayraç satırı
      if (b.title) row([[0, b.title, S.block]], { ht: 18 });
      const pos = posOf[bi];
      // Birden çok hücre kaplayan sütun: değer ilk hücrede, kalan hücreler aynı biçimle (çerçeve) ve birleştirilir
      const spread = (values, style, ht) => {
        const cells = [];
        b.columns.forEach((c, i) => {
          const span = Math.max(1, c.span ?? 1);
          const s = style(c, values[i]);
          cells.push([pos[i], values[i], s]);
          for (let k = 1; k < span; k++) cells.push([pos[i] + k, null, s]);
        });
        const at = row(cells, { ht });
        b.columns.forEach((c, i) => { if ((c.span ?? 1) > 1) merges.push(`${colName(pos[i])}${at}:${colName(pos[i] + c.span - 1)}${at}`); });
        return at;
      };
      const head = spread(b.columns.map((c) => c.header), () => S.head, 30);
      for (const cells of b.rows) spread(cells, (c, v) => cellStyle(c, v, false), wrapHeight(cells, b.columns));
      const last = r;
      if (b.rows.length === 0 && b.empty) row([[0, b.empty, S.note]]);
      for (const cells of b.totals ?? []) spread(cells, (c, v) => cellStyle(c, v, true), null);
      const end = pos.length ? pos[pos.length - 1] + Math.max(1, b.columns[b.columns.length - 1].span ?? 1) : 1;
      if (bi === 0) first = { head, last: b.rows.length ? last : null, cols: end };
    });
    if (sheet.notes?.length) {
      row([]);
      for (const n of sheet.notes) row([[0, n, S.note]]);
    }
    const lastCol = colName(width - 1);
    const filter = first?.last ? `${'A'}${first.head}:${colName(first.cols - 1)}${first.last}` : null;
    // Dondurma: ilk tablonun başlığına kadar (başlık bloğu çok uzunsa dondurulmaz — ekranın yarısı donmasın)
    const freeze = first && first.head <= 14 ? first.head : null;
    const pane = freeze
      ? `<pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${freeze + 1}" sqref="A${freeze + 1}"/>`
      : '';
    const colsXml = `<cols>${cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
    const footer = `<headerFooter><oddFooter>${esc(`&L&8${String(company).replace(/&/g, '&&')}&R&8&P / &N`)}</oddFooter></headerFooter>`;
    const sheetXml = `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
      `<dimension ref="A1:${lastCol}${Math.max(r, 1)}"/>` +
      `<sheetViews><sheetView showGridLines="0"${si === 0 ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>` +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      colsXml +
      `<sheetData>${rowsXml.join('')}</sheetData>` +
      (filter ? `<autoFilter ref="${filter}"/>` : '') +
      (merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '') +
      '<printOptions horizontalCentered="1"/>' +
      '<pageMargins left="0.4" right="0.4" top="0.55" bottom="0.6" header="0.25" footer="0.3"/>' +
      `<pageSetup paperSize="9" orientation="${sheet.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>` +
      footer +
      (png ? '<drawing r:id="rId1"/>' : '') +
      '</worksheet>';
    files.push({ name: `xl/worksheets/sheet${si + 1}.xml`, data: sheetXml });
    const ref = quoteSheet(name);
    if (filter) defined.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${si}" hidden="1">${esc(`${ref}!$A$${first.head}:$${colName(first.cols - 1)}$${first.last}`)}</definedName>`);
    defined.push(`<definedName name="_xlnm.Print_Area" localSheetId="${si}">${esc(`${ref}!$A$1:$${lastCol}$${Math.max(r, 1)}`)}</definedName>`);
    if (first) defined.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${si}">${esc(`${ref}!$${first.head}:$${first.head}`)}</definedName>`);
    if (png) {
      // Logo: sağ üst köşe, tablonun sağ kenarına hizalı; yükseklik sabit, genişlik logonun kendi oranından (gerilmez)
      const total = cols.reduce((s, w) => s + colPx(w), 0);
      const lw = Math.round(brandLogoSize({ height: LOGO_PX }).width);
      let x = Math.max(0, total - lw - 6);
      let col = 0;
      while (col < cols.length - 1 && x >= colPx(cols[col])) { x -= colPx(cols[col]); col += 1; }
      const cx = lw * EMU, cy = LOGO_PX * EMU;
      const drawing = `${XML_HEAD}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_REL}">` +
        `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${Math.round(x * EMU)}</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>${4 * EMU}</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${cx}" cy="${cy}"/>` +
        `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="GKH logo" descr="${esc(BRAND.company)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
        '<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>` +
        '<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>';
      files.push({ name: `xl/drawings/drawing${si + 1}.xml`, data: drawing });
      files.push({ name: `xl/drawings/_rels/drawing${si + 1}.xml.rels`, data: `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/image" Target="../media/image1.png"/></Relationships>` });
      files.push({ name: `xl/worksheets/_rels/sheet${si + 1}.xml.rels`, data: `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing${si + 1}.xml"/></Relationships>` });
    }
    sheetRels.push(`<Relationship Id="rId${si + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${si + 1}.xml"/>`);
  });

  const n = sheets.length;
  const types = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    (png ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    (png ? sheets.map((_, i) => `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('') : '') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
  const workbook = `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView activeTab="0"/></bookViews>` +
    `<sheets>${names.map((nm, i) => `<sheet name="${esc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
    (defined.length ? `<definedNames>${defined.join('')}</definedNames>` : '') + '</workbook>';
  return writeZip([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: `${XML_HEAD}<Relationships xmlns="${NS_PKG}">${sheetRels.join('')}<Relationship Id="rId${n + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: book.xml() },
    ...files,
    ...(png ? [{ name: 'xl/media/image1.png', data: png }] : []),
  ]);
}
