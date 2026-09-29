// Dosya türünü uzantıya değil İÇERİĞE (ilk baytlara) göre belirler. Uzantısı .pdf olup içi PDF olmayan,
// kılık değiştirmiş çalıştırılabilir dosyalar ve benzerleri reddedilir. Kural listesi ürün sahibinin verdiği
// dosya türleriyle aynıdır (server/orders/rules.js → ALLOWED_EXT).

/** İçerik türü → saklanacak MIME */
export const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  zip: 'application/zip',
  ole: 'application/x-ole-storage', // eski Office (doc, xls)
  rtf: 'application/rtf',
  dwg: 'image/vnd.dwg',
  dxf: 'image/vnd.dxf',
  step: 'model/step',
  iges: 'model/iges',
  text: 'text/plain',
};

/** Uzantı → kabul edilen içerik türleri */
const EXPECTED = {
  pdf: ['pdf'],
  png: ['png'],
  jpg: ['jpeg'],
  jpeg: ['jpeg'],
  zip: ['zip'],
  docx: ['zip'],
  xlsx: ['zip'],
  // Eski Office dosyaları; bazı programlar .doc'u RTF, .xls'i metin (CSV/HTML) olarak kaydeder, yeni biçimi de eski adla
  doc: ['ole', 'rtf', 'zip'],
  xls: ['ole', 'zip', 'text'],
  dwg: ['dwg'],
  dxf: ['dxf'],
  step: ['step'],
  stp: ['step'],
  igs: ['iges'],
  iges: ['iges'],
};

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);
const ascii = (buf, n = 4096) => buf.subarray(0, n).toString('latin1');

/** İlk bayt(lar)da NUL yoksa ve çoğu yazdırılabilir karakterse metin kabul edilir. */
function isText(buf) {
  const n = Math.min(buf.length, 4096);
  if (n === 0) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / n < 0.02;
}

/**
 * İçerik türünü belirler.
 * @param {Buffer} head  dosyanın ilk baytları (en az 4 KB önerilir)
 * @returns {string | null} pdf | png | jpeg | zip | ole | rtf | dwg | dxf | step | iges | text | null
 */
export function detectKind(head) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head);
  if (buf.length === 0) return null;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x50, 0x4b]) && [0x0304, 0x0506, 0x0708].includes(buf.readUInt16BE(2))) return 'zip';
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  const s = ascii(buf);
  if (/^AC(\d{4}|[12]\.\d)/.test(s)) return 'dwg';
  if (s.startsWith('AutoCAD Binary DXF')) return 'dxf';
  // PDF: başlık ilk 1024 baytın içinde olabilir
  if (s.slice(0, 1024).includes('%PDF-')) return 'pdf';
  if (!isText(buf)) return null;
  const t = s.replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  if (t.startsWith('{\\rtf')) return 'rtf';
  if (t.startsWith('ISO-10303-21')) return 'step';
  // DXF (metin): grup kodu satırları "0 / SECTION" ya da "999 / yorum" ile başlar
  if (/^(0|999)\s*\r?\n/.test(t) && /\r?\n\s*SECTION\s*\r?\n/.test(s)) return 'dxf';
  // IGES: sabit 80 sütunlu satırlar; 73. sütunda bölüm harfi (ilk bölüm S = Start)
  const first = s.split(/\r?\n/, 1)[0];
  if (first.length >= 73 && /[SG]/.test(first[72]) && /^\s*\d+\s*$/.test(first.slice(73, 80) || '1')) return 'iges';
  return 'text';
}

/**
 * İçerik uzantıyla uyuşuyor mu?
 * @param {string} name  dosya adı
 * @param {Buffer} head  dosyanın ilk baytları
 * @returns {{ ok: true, kind: string, mime: string } | { ok: false, kind: string | null }}
 */
export function checkContent(name, head) {
  const ext = String(name || '').toLowerCase().split('.').pop() ?? '';
  const kind = detectKind(head);
  const expected = EXPECTED[ext];
  if (!expected || !kind || !expected.includes(kind)) return { ok: false, kind };
  return { ok: true, kind, mime: MIME[kind] };
}
