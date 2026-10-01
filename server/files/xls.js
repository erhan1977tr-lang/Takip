// Eski Excel (.xls, BIFF8 / Excel 97–2003) okuma — yalnızca bu uygulamanın ihtiyacı kadar: ilk çalışma sayfasının hücre
// değerleri (metin, sayı, mantıksal; formülün hesaplanmış sonucu). Bağımlılık yok (server/files/xlsx.js'in eşi; aynı
// biçimde { sheetName, rows } döner). Dosya bir OLE2 bileşik belgesidir: içindeki "Workbook" akışı kayıtlardan oluşur.
import { XlsxError } from './xlsx.js';

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END = 0xfffffffe, FREE = 0xffffffff;
const MAX_ROWS = 100_000, MAX_COLS = 200;

/** Dosya .xls (OLE2) mi */
export const isXls = (buf) => buf.length >= 8 && buf.subarray(0, 8).equals(OLE_MAGIC);

// ---------- OLE2 bileşik belge: "Workbook" akışı ----------
function workbookStream(buf) {
  if (!isXls(buf) || buf.length < 512) throw new XlsxError('Excel (.xls) dosyası değil');
  const sectorSize = 1 << buf.readUInt16LE(30);
  const miniSize = 1 << buf.readUInt16LE(32);
  const dirStart = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const miniFatStart = buf.readUInt32LE(60);
  let difatSector = buf.readUInt32LE(68);
  if (sectorSize < 512 || sectorSize > 4096) throw new XlsxError('Excel dosyası okunamadı');
  const sector = (n) => {
    const off = (n + 1) * sectorSize;
    if (off >= buf.length) throw new XlsxError('Excel dosyası bozuk');
    return buf.subarray(off, Math.min(off + sectorSize, buf.length));
  };
  // FAT sektörlerinin listesi (başlıkta 109, fazlası DIFAT zincirinde)
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(76 + i * 4);
    if (s !== FREE && s !== END) fatSectors.push(s);
  }
  for (let guard = 0; difatSector !== END && difatSector !== FREE && guard < 10_000; guard++) {
    const d = sector(difatSector);
    for (let i = 0; i + 4 <= d.length - 4; i += 4) {
      const s = d.readUInt32LE(i);
      if (s !== FREE && s !== END) fatSectors.push(s);
    }
    difatSector = d.readUInt32LE(d.length - 4);
  }
  const fat = [];
  for (const s of fatSectors) {
    const d = sector(s);
    for (let i = 0; i + 4 <= d.length; i += 4) fat.push(d.readUInt32LE(i));
  }
  const chain = (start, table, read) => {
    const parts = [];
    const seen = new Set();
    for (let s = start; s !== END && s !== FREE; s = table[s]) {
      if (s === undefined || seen.has(s) || seen.size > 2_000_000) throw new XlsxError('Excel dosyası bozuk');
      seen.add(s);
      parts.push(read(s));
    }
    return Buffer.concat(parts);
  };
  const dir = chain(dirStart, fat, sector);
  let root = null, book = null;
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 64);
    const type = dir[off + 66];
    if (!nameLen || (type !== 2 && type !== 5)) continue;
    const name = dir.toString('utf16le', off, off + Math.max(0, nameLen - 2));
    const entry = { start: dir.readUInt32LE(off + 116), size: dir.readUInt32LE(off + 120) };
    if (type === 5) root = entry;
    else if (name === 'Workbook' || (name === 'Book' && !book)) book = entry;
  }
  if (!book) throw new XlsxError('Excel (.xls) çalışma kitabı bulunamadı');
  if (book.size >= miniCutoff) return chain(book.start, fat, sector).subarray(0, book.size);
  // Küçük akış: kök girişin mini akışından, mini FAT ile
  if (!root) throw new XlsxError('Excel dosyası bozuk');
  const mini = chain(root.start, fat, sector);
  const miniFatBuf = chain(miniFatStart, fat, sector);
  const miniFat = [];
  for (let i = 0; i + 4 <= miniFatBuf.length; i += 4) miniFat.push(miniFatBuf.readUInt32LE(i));
  return chain(book.start, miniFat, (n) => mini.subarray(n * miniSize, (n + 1) * miniSize)).subarray(0, book.size);
}

// ---------- BIFF8 kayıtları ----------
/** Tek kayıt içindeki Unicode metin (16 bit uzunluk): LABEL, STRING, sayfa adı (8 bit uzunluk) */
function shortString(d, off, lenBytes) {
  const cch = lenBytes === 1 ? d[off] : d.readUInt16LE(off);
  const flags = d[off + lenBytes];
  let p = off + lenBytes + 1;
  if (flags & 0x08) p += 2;
  if (flags & 0x04) p += 4;
  return flags & 0x01 ? d.toString('utf16le', p, p + cch * 2) : d.toString('latin1', p, p + cch);
}

/** Paylaşılan metin tablosu (SST + CONTINUE kayıtları). Metin kayıt sınırında bölünürse devamı yeni bir bayrak baytıyla başlar. */
function readSst(chunks) {
  let ci = 0, off = 0;
  const need = () => {
    while (ci < chunks.length && off >= chunks[ci].length) { ci++; off = 0; }
    if (ci >= chunks.length) throw new XlsxError('Excel dosyası bozuk (metin tablosu)');
  };
  const bytes = (n) => {
    const out = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      need();
      const take = Math.min(n - got, chunks[ci].length - off);
      chunks[ci].copy(out, got, off, off + take);
      got += take; off += take;
    }
    return out;
  };
  const skip = (n) => {
    while (n > 0) {
      need();
      const take = Math.min(n, chunks[ci].length - off);
      n -= take; off += take;
    }
  };
  const head = bytes(8);
  const unique = head.readUInt32LE(4);
  const strings = [];
  for (let i = 0; i < unique && i < 5_000_000; i++) {
    const cch = bytes(2).readUInt16LE(0);
    const flags = bytes(1)[0];
    let high = flags & 0x01;
    const runs = flags & 0x08 ? bytes(2).readUInt16LE(0) : 0;
    const ext = flags & 0x04 ? bytes(4).readUInt32LE(0) : 0;
    let left = cch, s = '';
    while (left > 0) {
      if (off >= chunks[ci].length) {
        // Devam kaydı: ilk bayt metnin kalanının kodlaması
        ci++; off = 0;
        if (ci >= chunks.length) throw new XlsxError('Excel dosyası bozuk (metin tablosu)');
        high = chunks[ci][off++] & 0x01;
      }
      const avail = chunks[ci].length - off;
      const take = Math.min(left, high ? Math.floor(avail / 2) : avail);
      if (take <= 0) { off = chunks[ci].length; continue; }
      s += high ? chunks[ci].toString('utf16le', off, off + take * 2) : chunks[ci].toString('latin1', off, off + take);
      off += high ? take * 2 : take;
      left -= take;
    }
    skip(runs * 4 + ext);
    strings.push(s);
  }
  return strings;
}

const rkValue = (rk) => {
  let v;
  if (rk & 0x02) v = rk >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = b.readDoubleLE(0);
  }
  return rk & 0x01 ? v / 100 : v;
};

/**
 * İlk çalışma sayfasını satırlar halinde okur.
 * @param {Buffer} buf
 * @returns {{ sheetName: string, rows: (string | number | boolean | null)[][] }}
 */
export function readXls(buf) {
  const wb = workbookStream(buf);
  // Kayıtlar: [kimlik u16][uzunluk u16][veri]
  const records = [];
  for (let p = 0; p + 4 <= wb.length;) {
    const id = wb.readUInt16LE(p), len = wb.readUInt16LE(p + 2);
    records.push({ id, pos: p, data: wb.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  if (!records.length || records[0].id !== 0x0809) throw new XlsxError('Excel (.xls) dosyası okunamadı');
  if (records[0].data.readUInt16LE(0) !== 0x0600) throw new XlsxError('Bu .xls biçimi çok eski (Excel 97 öncesi); dosyayı .xlsx olarak kaydedin');

  let sst = [];
  let sheet = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.id === 0x000a) break; // genel bölümün sonu
    if (r.id === 0x002f) throw new XlsxError('Excel dosyası şifreli');
    if (r.id === 0x0085 && !sheet && r.data.length >= 8 && r.data[5] === 0) sheet = { pos: r.data.readUInt32LE(0), name: shortString(r.data, 6, 1) };
    if (r.id === 0x00fc) {
      const chunks = [r.data];
      while (records[i + 1]?.id === 0x003c) chunks.push(records[++i].data);
      sst = readSst(chunks);
    }
  }
  if (!sheet) throw new XlsxError('Çalışma sayfası yok');
  const start = records.findIndex((r) => r.pos === sheet.pos);
  if (start < 0 || records[start].id !== 0x0809) throw new XlsxError('Çalışma sayfası okunamadı');

  /** @type {(string | number | boolean | null)[][]} */
  const rows = [];
  const set = (row, col, val) => {
    if (row > MAX_ROWS) throw new XlsxError('Çok fazla satır');
    if (col > MAX_COLS) return;
    (rows[row] ??= [])[col] = val;
  };
  let pending = null; // metin sonuçlu formül: değeri sonraki STRING kaydında
  for (let i = start + 1; i < records.length; i++) {
    const { id, data: d } = records[i];
    if (id === 0x000a) break;
    if (id === 0x0809) { // iç içe bölüm (grafik vb.) atlanır
      let depth = 1;
      while (depth > 0 && ++i < records.length) depth += records[i].id === 0x0809 ? 1 : records[i].id === 0x000a ? -1 : 0;
      continue;
    }
    if (id === 0x0207) { // STRING: önceki formülün metin sonucu
      if (pending && d.length >= 3) set(pending.row, pending.col, shortString(d, 0, 2));
      pending = null;
      continue;
    }
    if (d.length < 6) continue;
    const row = d.readUInt16LE(0), col = d.readUInt16LE(2);
    if (id === 0x00fd) set(row, col, sst[d.readUInt32LE(6)] ?? null);
    else if (id === 0x0203) set(row, col, d.readDoubleLE(6));
    else if (id === 0x027e) set(row, col, rkValue(d.readInt32LE(6)));
    else if (id === 0x00bd) for (let p = 4, c = col; p + 6 <= d.length - 2; p += 6, c++) set(row, c, rkValue(d.readInt32LE(p + 2)));
    else if (id === 0x0204 || id === 0x00d6) set(row, col, shortString(d, 6, 2));
    else if (id === 0x0205) set(row, col, d[7] ? null : d[6] === 1);
    else if (id === 0x0006 && d.length >= 14) {
      if (d.readUInt16LE(12) === 0xffff) {
        if (d[6] === 0) pending = { row, col };
        else if (d[6] === 1) set(row, col, d[8] === 1);
      } else set(row, col, d.readDoubleLE(6));
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? [];
    for (let c = 0; c < r.length; c++) if (r[c] === undefined) r[c] = null;
    rows[i] = r;
  }
  return { sheetName: sheet.name, rows };
}
