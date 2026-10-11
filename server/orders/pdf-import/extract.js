// Fabrika PDF'i aktarımı (karar 255): PDF'ten konumlu metin parçaları — pdf.js (pdfjs-dist, zaten bağımlılık: çizim
// görüntüleyici). OCR yok: fabrika formları metin tabanlıdır; metni olmayan (taranmış) PDF reddedilir.
//
// Kaynak sınırları (güvenilmeyen dosya, uygulama sürecinde): boyut (dosya okunmadan ÖNCE), sayfa, parça, karakter ve süre.
// Değerlendirme (eval) kapalı, yazı tipi yüklenmez, görsel çözülmez (yalnızca getTextContent). Hata metni dışarı verilmez:
// sabit kodlar (EXTRACT_ERRORS).

export const PDF_IMPORT_LIMITS = Object.freeze({
  maxBytes: 15 * 1024 * 1024, // fabrika formu görselleriyle ~3 MB
  maxPages: 10,
  maxItems: 20_000,
  maxChars: 400_000,
  timeoutMs: 20_000,
});

export const EXTRACT_ERRORS = Object.freeze(['TOO_BIG', 'NOT_PDF', 'ENCRYPTED', 'UNREADABLE', 'TOO_MANY_PAGES', 'TOO_MUCH_TEXT', 'NO_TEXT', 'TIMEOUT']);

class ExtractError extends Error {
  /** @param {string} code */
  constructor(code) { super(code); this.code = code; }
}

let libPromise = null;
/** pdf.js (Node, ana iş parçacığında "sahte işçi" ile). Sunucu paketine katılmaz (next.config → serverExternalPackages). */
async function loadPdfjs() {
  libPromise ??= (async () => {
    const [lib, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.mjs')]);
    // Ayrı işçi dosyası aranmaz: işçi modülü bu süreçte çalışır
    /** @type {any} */ (globalThis).pdfjsWorker = worker;
    return lib;
  })();
  return libPromise;
}

/**
 * @param {Uint8Array} data  PDF baytları
 * @param {{ limits?: typeof PDF_IMPORT_LIMITS, pdfjs?: any }} [opts]  pdfjs: testte verilebilir
 * @returns {Promise<{ ok: true, items: { page: number, x: number, y: number, str: string }[], pages: number } | { ok: false, error: string }>}
 */
export async function extractTextItems(data, { limits = PDF_IMPORT_LIMITS, pdfjs } = {}) {
  if (!(data instanceof Uint8Array)) return { ok: false, error: 'UNREADABLE' };
  if (data.length > limits.maxBytes) return { ok: false, error: 'TOO_BIG' };
  if (data.length < 5 || String.fromCharCode(...data.subarray(0, 5)) !== '%PDF-') return { ok: false, error: 'NOT_PDF' };
  let doc = null;
  let task = null;
  let timer = null;
  try {
    const lib = pdfjs ?? await loadPdfjs();
    task = lib.getDocument({
      data: new Uint8Array(data), // pdf.js veriyi devralır: kopya verilir
      isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false,
      disableAutoFetch: true, disableStream: true, verbosity: 0,
    });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new ExtractError('TIMEOUT')), limits.timeoutMs); });
    const run = (async () => {
      doc = await task.promise;
      if (doc.numPages > limits.maxPages) throw new ExtractError('TOO_MANY_PAGES');
      const items = [];
      let chars = 0;
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        for (const it of content.items) {
          if (typeof it?.str !== 'string' || !it.str.trim()) continue;
          if (items.length >= limits.maxItems) throw new ExtractError('TOO_MUCH_TEXT');
          chars += it.str.length;
          if (chars > limits.maxChars) throw new ExtractError('TOO_MUCH_TEXT');
          const tr = Array.isArray(it.transform) ? it.transform : [1, 0, 0, 1, 0, 0];
          // pdf.js: sol alt köşeden; burada sayfanın üstünden aşağı (satır sırası)
          items.push({ page: p, x: Number(tr[4]) || 0, y: vp.height - (Number(tr[5]) || 0), str: it.str, w: Number(it.width) || 0, h: Math.hypot(Number(tr[2]) || 0, Number(tr[3]) || 0) || Number(it.height) || 0 });
        }
        page.cleanup?.();
      }
      return { pages: doc.numPages, items };
    })();
    // Süre dolarsa okuma sürer ama sonucu kullanılmaz (finally belgeyi kapatır); geç gelen hata işlenmemiş kalmaz
    run.catch(() => {});
    const res = await Promise.race([run, timeout]);
    if (!res.items.length) return { ok: false, error: 'NO_TEXT' };
    return { ok: true, items: res.items, pages: res.pages };
  } catch (e) {
    if (e instanceof ExtractError) return { ok: false, error: e.code };
    const name = /** @type {any} */ (e)?.name;
    if (name === 'PasswordException') return { ok: false, error: 'ENCRYPTED' };
    if (name === 'InvalidPDFException') return { ok: false, error: 'NOT_PDF' };
    return { ok: false, error: 'UNREADABLE' };
  } finally {
    if (timer) clearTimeout(timer);
    try { await (task?.destroy?.() ?? doc?.destroy?.()); } catch { /* yok sayılır */ }
  }
}
