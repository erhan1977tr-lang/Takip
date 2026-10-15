// Dosya önizleme kuralları (karar 283) — bağımlılıksız; dosya yolu (app/dosya/[kind]/[id]/route.ts) ve testler kullanır.
// Önizleme, İNDİRME ile birebir aynı erişim kuralından geçer (aynı sorgu); burada yalnızca "bu dosya hangi görüntüleyiciyle,
// hangi içerik türüyle gösterilebilir" kararı verilir. Tür UZANTIDAN değil, dosyanın ilk baytlarından belirlenir ve uzantının
// ailesiyle uyuşmalıdır (sahte uzantı / MIME taklidi → önizleme yok).

/** Önizleme verilen dosya yolları (urun: katalog görseli, rapor: üretilen PDF — önizleme düğmesi yok) */
export const PREVIEW_ROUTE_KINDS = Object.freeze(['siparis', 'cizim', 'teslimat', 'teslim-belgesi', 'tedarik']);

/** Uzantı → görüntüleyici ailesi */
const FAMILY = Object.freeze({ pdf: 'pdf', jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', dwg: 'cad', dxf: 'cad' });

/** İçerik → aile + sunulacak içerik türü */
const CONTENT = Object.freeze({
  pdf: { family: 'pdf', mime: 'application/pdf' },
  png: { family: 'image', mime: 'image/png' },
  jpeg: { family: 'image', mime: 'image/jpeg' },
  webp: { family: 'image', mime: 'image/webp' },
  dwg: { family: 'cad', mime: null },
  dxf: { family: 'cad', mime: null },
});

/** Bayt sınırları — aşan dosya önizlenmez ("indirerek açın"); indirme sınırı değişmez */
export const PREVIEW_LIMITS = Object.freeze({ pdf: 60_000_000, image: 30_000_000, dwg: 40_000_000, dxf: 60_000_000 });

/** İlk baytlardan okunacak uzunluk */
export const SNIFF_BYTES = 64;

/**
 * Dosya adının uzantısına göre önizleme ailesi (düğmenin gösterilip gösterilmeyeceği); bilinmeyen → null
 * @param {string | null | undefined} name @returns {'pdf' | 'image' | 'cad' | null}
 */
export function previewFamily(name) {
  if (typeof name !== 'string') return null;
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return Object.hasOwn(FAMILY, ext) ? /** @type {any} */ (FAMILY[/** @type {keyof typeof FAMILY} */ (ext)]) : null;
}

/**
 * İçerik imzası
 * @param {Uint8Array} head ilk baytlar
 * @returns {'pdf' | 'png' | 'jpeg' | 'webp' | 'dwg' | 'dxf' | 'dxf-binary' | null}
 */
export function sniffContent(head) {
  if (!head || head.length < 4) return null;
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  const s = b.subarray(0, 32).toString('latin1');
  if (s.startsWith('%PDF-')) return 'pdf';
  if (b.length >= 8 && b[0] === 0x89 && s.slice(1, 8) === 'PNG\r\n\x1a\n') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'webp';
  if (/^AC(?:1\.\d|2\.\d|10\d\d)/.test(s)) return 'dwg';
  if (s.startsWith('AutoCAD Binary DXF')) return 'dxf-binary';
  // ASCII DXF: (BOM) boşluk + "0" ya da "999" grup kodu satırı; ilk baytlarda NUL yok
  if (b.includes(0)) return null;
  const t = b.toString('latin1').replace(/^\xEF\xBB\xBF/, '');
  if (/^\s*(?:0|999)\s*\r?\n/.test(t)) return 'dxf';
  return null;
}

/**
 * Önizleme kararı: uzantının ailesi ile içeriğin ailesi aynı olmalı.
 * @param {string} name @param {Uint8Array} head @param {number} size
 * @returns {{ ok: true, family: 'pdf' | 'image' | 'cad', content: 'pdf' | 'png' | 'jpeg' | 'webp' | 'dwg' | 'dxf', mime: string | null }
 *   | { ok: false, code: 'UNSUPPORTED' | 'MISMATCH' | 'BINARY_DXF' | 'TOO_LARGE' }}
 */
export function previewDecision(name, head, size) {
  const family = previewFamily(name);
  if (!family) return { ok: false, code: 'UNSUPPORTED' };
  const content = sniffContent(head);
  if (content === 'dxf-binary') return { ok: false, code: 'BINARY_DXF' };
  if (!content || CONTENT[content].family !== family) return { ok: false, code: 'MISMATCH' };
  // CAD: uzantı da içerikle aynı olmalı (.dxf adlı DWG ya da tersi önizlenmez)
  if (family === 'cad' && previewExt(name) !== content) return { ok: false, code: 'MISMATCH' };
  const limit = content === 'dwg' ? PREVIEW_LIMITS.dwg : content === 'dxf' ? PREVIEW_LIMITS.dxf : family === 'pdf' ? PREVIEW_LIMITS.pdf : PREVIEW_LIMITS.image;
  if (!(Number.isFinite(size) && size > 0) || size > limit) return { ok: false, code: 'TOO_LARGE' };
  return { ok: true, family, content, mime: CONTENT[content].mime };
}

/** @param {string} name */
function previewExt(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** Önizleme hata kodu → HTTP durumu (yanıt gövdesi yalnızca sabit kod taşır) */
export const PREVIEW_STATUS = Object.freeze({
  UNSUPPORTED: 415, MISMATCH: 415, BINARY_DXF: 415, TOO_LARGE: 413, RATE_LIMIT: 429, UNAVAILABLE: 503, BUSY: 503,
  TIMEOUT: 504, CONVERT_FAILED: 422, INVALID: 422, NOT_DXF: 415, TOO_COMPLEX: 422,
});

/** Kullanıcıya gösterilebilecek sabit kodlar (hizmetten gelen başka her şey INVALID sayılır) */
export function previewCode(code) {
  return typeof code === 'string' && Object.hasOwn(PREVIEW_STATUS, code) ? code : 'INVALID';
}
