// Mali belge PDF'ine erişimin korunması (güvenlik denetimi SEC-09, karar 120) — /belgeler/<belge>/pdf yolu kullanır.
// Sahiplik denetimi YOLDA yapılır (server/documents/customer.js); buradakiler onun ARDINDAN gelen korumalardır:
//   - kullanıcı başına istek sınırı: 5 dakikada 30 PDF isteği (aşılırsa 429) — bir hesap FGO'ya art arda istek yaptıramaz;
//   - kısa önbellek: indirilen PDF 5 dakika bellekte tutulur (aynı belge yeniden açılınca FGO'ya gidilmez); başarısız
//     indirme de 1 dakika hatırlanır (FGO yanıt vermiyorken her tıklama yeni istek olmaz);
//   - yedek bağlantı: PDF sunucudan alınamazsa okuyan yalnızca FGO'nun KENDİ adresine yönlendirilir (pdfUrl — https ve
//     fgo.ro / alt alan adları); başka bir adres https olsa bile kullanılmaz.
// Bellek içi durum tek uygulama sürecine yeter (mevcut kurulum); süreç yeniden başlayınca sıfırlanır.
import { createRateLimiter } from '../security/rate-limit.js';
import { fetchDocPdf, pdfUrl } from './delivery.js';

export const PDF_RATE_LIMIT = 30;
export const PDF_RATE_WINDOW_MS = 5 * 60_000;
export const PDF_CACHE_MS = 5 * 60_000;
export const PDF_FAIL_CACHE_MS = 60_000;
export const PDF_CACHE_MAX_ENTRIES = 20;
export const PDF_CACHE_MAX_BYTES = 40 * 1024 * 1024;

/**
 * @param {{ limit?: number, windowMs?: number, cacheMs?: number, failCacheMs?: number, maxEntries?: number, maxBytes?: number,
 *   fetchDoc?: typeof fetchDocPdf }} [o]
 */
export function createPdfAccess({
  limit = PDF_RATE_LIMIT, windowMs = PDF_RATE_WINDOW_MS, cacheMs = PDF_CACHE_MS, failCacheMs = PDF_FAIL_CACHE_MS,
  maxEntries = PDF_CACHE_MAX_ENTRIES, maxBytes = PDF_CACHE_MAX_BYTES, fetchDoc = fetchDocPdf,
} = {}) {
  const limiter = createRateLimiter({ limit, windowMs });
  /** @type {Map<string, { at: number, bytes?: Buffer, fail?: { link: string | null, error: string } }>} */
  const cache = new Map();
  const size = () => [...cache.values()].reduce((n, e) => n + (e.bytes?.length ?? 0), 0);
  const put = (id, entry) => {
    cache.delete(id);
    cache.set(id, entry);
    while (cache.size > maxEntries || size() > maxBytes) cache.delete(cache.keys().next().value);
  };
  return {
    /** Kullanıcı başına istek sınırı. @returns {{ ok: true } | { ok: false, retryAfterSec: number }} */
    allow(userId, now = Date.now()) {
      const r = limiter.take(String(userId), now);
      return r.ok ? { ok: true } : { ok: false, retryAfterSec: Math.ceil(r.retryAfterMs / 1000) };
    },
    /**
     * Belgenin PDF'i: önbellekten ya da FGO'dan (sunucu tarafında). ok değilse `link` yalnızca FGO'nun kendi adresidir
     * (değilse null) — çağıran yalnızca buna yönlendirebilir.
     * @returns {Promise<{ ok: true, bytes: Buffer, cached: boolean } | { ok: false, link: string | null, error: string, cached: boolean }>}
     */
    async get(db, doc, ctx = {}, now = Date.now()) {
      const hit = cache.get(doc.id);
      if (hit?.bytes && now - hit.at < cacheMs) return { ok: true, bytes: hit.bytes, cached: true };
      if (hit?.fail && now - hit.at < failCacheMs) return { ok: false, ...hit.fail, cached: true };
      const r = await fetchDoc(db, doc, ctx);
      if (r.ok) {
        put(doc.id, { at: now, bytes: r.bytes });
        return { ok: true, bytes: r.bytes, cached: false };
      }
      const fail = { link: pdfUrl(r.link), error: r.error };
      put(doc.id, { at: now, fail });
      return { ok: false, ...fail, cached: false };
    },
    entries: () => cache.size,
  };
}

/** Uygulama sürecinin ortak örneği (yol bunu kullanır) */
export const pdfAccess = createPdfAccess();
