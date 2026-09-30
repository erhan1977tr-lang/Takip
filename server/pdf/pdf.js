// Küçük PDF yazıcı (bağımlılık yok): A4 sayfalar, gömülü yazı tipiyle metin (TakipSans = Liberation Sans alt kümesi;
// Romence ve Türkçe harfler her görüntüleyicide aynı görünür), çizgi, dikdörtgen ve JPEG / PNG görsel.
// Comanda Depozit formu (server/pdf/depot-form.js) için yazıldı. Metin Type0 / Identity-H (glif numaraları) ile yazılır;
// ToUnicode sayesinde PDF'ten metin kopyalanabilir ve aranabilir.
// Koordinatlar punto (1/72 inç), sol üst köşeden: x sağa, y aşağı.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { FONTS } from './fonts.js';

export const A4 = { w: 595.28, h: 841.89 };

const FACES = Object.fromEntries(Object.entries({ regular: FONTS.Regular, bold: FONTS.Bold }).map(([k, f]) => [k, { ...f, cmap: new Map(f.map) }]));
const QUESTION = 63;

/** Metni glif numaralarına çevirir; yazı tipinde olmayan karakter "?" olur. */
export function glyphs(s, bold = false) {
  const f = bold ? FACES.bold : FACES.regular;
  const out = [];
  for (const ch of String(s ?? '').normalize('NFC')) {
    let cp = ch.codePointAt(0);
    if (cp === 0x162) cp = 0x21a; // Ţ → Ț
    if (cp === 0x163) cp = 0x21b; // ţ → ț
    if (ch === '\n' || ch === '\t') cp = 32;
    out.push({ gid: f.cmap.get(cp) ?? f.cmap.get(QUESTION), cp: f.cmap.has(cp) ? cp : QUESTION });
  }
  return out;
}

/** Metnin genişliği (punto) */
export function textWidth(s, size, bold = false) {
  const w = (bold ? FACES.bold : FACES.regular).widths;
  return glyphs(s, bold).reduce((sum, g) => sum + (w[g.gid] ?? 556), 0) * size / 1000;
}

/** Genişliğe sığmayan metni "…" ile kısaltır */
export function fitText(s, size, width, bold = false) {
  const text = String(s ?? '');
  if (textWidth(text, size, bold) <= width) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(text.slice(0, mid) + '…', size, bold) <= width) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

/** Metni satırlara böler (kelime sınırından) */
export function wrapText(s, size, width, bold = false) {
  const lines = [];
  for (const para of String(s ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width || !line) line = next;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

const n = (v) => (Math.round(v * 100) / 100).toString();
const hexGlyphs = (gs) => `<${gs.map((g) => g.gid.toString(16).padStart(4, '0')).join('')}>`;

// ---------- görseller ----------
/** JPEG: boyut ve renk bileşeni (SOF işaretinden) */
function jpegInfo(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), comps: buf[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

/** PNG → 8 bit RGB (saydam alanlar beyaz zemine basılır). Desteklenmeyen biçimde null. */
export function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let i = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const kind = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    i += 12 + len;
  }
  if (!w || !h || interlace || w * h > 40_000_000) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && type !== 0 && type !== 3) || (type === 3 && !palette)) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((w * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < (stride + 1) * h) return null;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev ? prev[x] : 0, c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 0xff;
    }
  }
  const out = Buffer.alloc(w * h * 3);
  const sample = (row, idx) => {
    // idx: pikseldeki örnek sırası (bit derinliğine göre)
    if (depth === 8) return px[row * stride + idx];
    if (depth === 16) return px[row * stride + idx * 2];
    const bit = idx * depth;
    const byte = px[row * stride + (bit >> 3)];
    return (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const scale = depth < 8 && type === 0 ? 255 / ((1 << depth) - 1) : 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r, g, b, alpha = 255;
      if (type === 3) {
        const k = sample(y, x);
        r = palette[k * 3] ?? 0; g = palette[k * 3 + 1] ?? 0; b = palette[k * 3 + 2] ?? 0;
        if (trns && k < trns.length) alpha = trns[k];
      } else if (type === 0 || type === 4) {
        r = g = b = Math.round(sample(y, x * channels) * scale);
        if (type === 4) alpha = sample(y, x * channels + 1);
      } else {
        r = sample(y, x * channels); g = sample(y, x * channels + 1); b = sample(y, x * channels + 2);
        if (type === 6) alpha = sample(y, x * channels + 3);
      }
      const o = (y * w + x) * 3;
      out[o] = Math.round((r * alpha + 255 * (255 - alpha)) / 255);
      out[o + 1] = Math.round((g * alpha + 255 * (255 - alpha)) / 255);
      out[o + 2] = Math.round((b * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  return { w, h, rgb: out };
}

// ---------- belge ----------
export class PdfDoc {
  constructor({ title = '', author = '' } = {}) {
    this.pages = [];
    this.images = [];
    this.used = { regular: new Map(), bold: new Map() }; // glif → Unicode (ToUnicode için)
    this.title = title;
    this.author = author;
  }

  /** Yeni A4 sayfa; çizim komutları sayfa nesnesindedir. */
  addPage() {
    const usedGlyphs = this.used;
    const ops = [];
    const Y = (y) => A4.h - y;
    const page = {
      width: A4.w, height: A4.h, ops,
      /** @param {{ size?: number, bold?: boolean, align?: 'left' | 'center' | 'right', width?: number, color?: number[] }} [o] */
      text(x, y, s, o = {}) {
        const size = o.size ?? 10;
        const bold = !!o.bold;
        let tx = x;
        if (o.align && o.align !== 'left' && o.width) {
          const tw = textWidth(s, size, bold);
          tx = o.align === 'center' ? x + (o.width - tw) / 2 : x + o.width - tw;
        }
        const color = o.color ? `${o.color.map((c) => n(c)).join(' ')} rg ` : '';
        const gs = glyphs(s, bold);
        const used = usedGlyphs[bold ? 'bold' : 'regular'];
        for (const g of gs) used.set(g.gid, g.cp);
        // y: metnin taban çizgisi
        ops.push(`BT ${color}/${bold ? 'F2' : 'F1'} ${n(size)} Tf ${n(tx)} ${n(Y(y))} Td ${hexGlyphs(gs)} Tj ET${o.color ? ' 0 0 0 rg' : ''}`);
      },
      line(x1, y1, x2, y2, width = 0.5, gray = 0) {
        ops.push(`${n(gray)} G ${n(width)} w ${n(x1)} ${n(Y(y1))} m ${n(x2)} ${n(Y(y2))} l S 0 G`);
      },
      /** @param {{ stroke?: boolean, fill?: number | null, width?: number }} [o]  fill: gri tonu (0 siyah … 1 beyaz) */
      rect(x, y, w, h, o = {}) {
        const stroke = o.stroke !== false;
        const fill = o.fill ?? null;
        const parts = [];
        if (fill != null) parts.push(`${n(fill)} g`);
        parts.push(`${n(o.width ?? 0.5)} w ${n(x)} ${n(Y(y + h))} ${n(w)} ${n(h)} re`);
        parts.push(fill != null && stroke ? 'B' : fill != null ? 'f' : 'S');
        if (fill != null) parts.push('0 g');
        ops.push(parts.join(' '));
      },
      /** Görseli kutuya en-boy oranını koruyarak ortalar. img: doc.image() sonucu */
      image(img, x, y, w, h) {
        if (!img) return;
        const s = Math.min(w / img.w, h / img.h);
        const dw = img.w * s, dh = img.h * s;
        const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
        ops.push(`q ${n(dw)} 0 0 ${n(dh)} ${n(dx)} ${n(Y(dy + dh))} cm /${img.name} Do Q`);
      },
    };
    this.pages.push(page);
    return page;
  }

  /**
   * Görseli belgeye ekler (aynı içerik bir kez). Desteklenmeyen biçimde null döner (görsel çizilmez).
   * @param {Buffer} buf JPEG ya da PNG
   */
  image(buf) {
    if (!buf?.length) return null;
    const key = crypto.createHash('sha1').update(buf).digest('hex');
    const found = this.images.find((i) => i.key === key);
    if (found) return found;
    let img = null;
    const jpg = jpegInfo(buf);
    if (jpg && [1, 3, 4].includes(jpg.comps)) {
      const cs = jpg.comps === 1 ? '/DeviceGray' : jpg.comps === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
      img = { w: jpg.w, h: jpg.h, dict: `/ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`, data: buf };
    } else {
      const png = decodePng(buf);
      if (png) img = { w: png.w, h: png.h, dict: '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode', data: zlib.deflateSync(png.rgb) };
    }
    if (!img) return null;
    const entry = { ...img, key, name: `Im${this.images.length + 1}` };
    this.images.push(entry);
    return entry;
  }

  /** @returns {Buffer} */
  toBuffer() {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null);
    const pagesId = add(null);
    const stream = (dict, data) => add(Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]));
    const font = (face, used) => {
      const raw = Buffer.from(face.data, 'base64');
      const file = stream(`/Length1 ${raw.length} /Filter /FlateDecode`, zlib.deflateSync(raw));
      const desc = add(Buffer.from(
        `<< /Type /FontDescriptor /FontName /${face.ps} /Flags 32 /FontBBox [${face.bbox.join(' ')}] /ItalicAngle ${face.italicAngle} ` +
        `/Ascent ${face.ascent} /Descent ${face.descent} /CapHeight ${face.capHeight} /StemV 80 /FontFile2 ${file} 0 R >>`, 'latin1'));
      const cid = add(Buffer.from(
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${face.ps} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
        `/FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 1000 /W [0 [${face.widths.join(' ')}]] >>`, 'latin1'));
      const hex4 = (v) => v.toString(16).padStart(4, '0');
      const pairs = [...used.entries()].sort((x, y) => x[0] - y[0]);
      const blocks = [];
      for (let i = 0; i < pairs.length; i += 100) {
        const part = pairs.slice(i, i + 100);
        blocks.push(`${part.length} beginbfchar\n${part.map(([g, cp]) => `<${hex4(g)}> <${cp > 0xffff ? Buffer.from(String.fromCodePoint(cp), 'utf16le').swap16().toString('hex') : hex4(cp)}>`).join('\n')}\nendbfchar`);
      }
      const cmap = Buffer.from(
        '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
        '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
        `${blocks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`, 'latin1');
      const toUni = stream('', cmap);
      return add(Buffer.from(`<< /Type /Font /Subtype /Type0 /BaseFont /${face.ps} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUni} 0 R >>`, 'latin1'));
    };
    const f1 = font(FACES.regular, this.used.regular);
    const f2 = font(FACES.bold, this.used.bold);
    const imgIds = this.images.map((im) => add(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} ${im.dict} /Length ${im.data.length} >>\nstream\n`, 'latin1'),
      im.data, Buffer.from('\nendstream', 'latin1'),
    ])));
    const xobj = this.images.length ? `/XObject << ${this.images.map((im, i) => `/${im.name} ${imgIds[i]} 0 R`).join(' ')} >>` : '';
    const pageIds = this.pages.map((p) => {
      const content = zlib.deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'));
      const cid = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), content, Buffer.from('\nendstream', 'latin1')]));
      return add(Buffer.from(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(A4.w)} ${n(A4.h)}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> ${xobj} >> /Contents ${cid} 0 R >>`, 'latin1'));
    });
    objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'latin1');
    objs[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'latin1');
    const hex = (s) => `<FEFF${Buffer.from(String(s), 'utf16le').swap16().toString('hex').toUpperCase()}>`;
    const info = add(Buffer.from(`<< /Title ${hex(this.title)} /Author ${hex(this.author)} /Producer (Takip) >>`, 'latin1'));

    const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = parts[0].length;
    const offsets = [];
    objs.forEach((body, i) => {
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
      const tail = Buffer.from('\nendobj\n', 'latin1');
      offsets.push(offset);
      parts.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    });
    const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}
