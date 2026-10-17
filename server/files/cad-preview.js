// DWG / DXF önizleme: yetki denetimi YAPILDIKTAN SONRA (app/dosya/[kind]/[id]/route.ts) dosyanın baytları iç CAD hizmetine
// (server/cad/service.mjs, ayrı kapsayıcı) gönderilir; dönen geometri JSON'u istemciye verilir (karar 283).
// - Adres yalnızca sunucu ortamından gelir (CAD_SERVICE_URL); yönlendirme izlenmez; tek süre sınırı; yanıt boyutu sınırlı.
// - Sonuç süreç içi, ÖZEL bir önbellekte tutulur: anahtar dosyanın depolama anahtarı + boyutu + değişme zamanıdır; önbellek
//   yalnızca o istekte yetkisi doğrulanmış dosya için okunur (herkese açık bir adres / paylaşılan önbellek yok).
// - Yanıtta yalnızca sabit hata kodları vardır; hizmetin / aracın iletisi dışarı verilmez.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { previewCode } from './preview.js';
import { createRateLimiter } from '../security/rate-limit.js';

export const CAD_CLIENT_LIMITS = Object.freeze({ timeoutMs: 180_000, responseBytes: 70_000_000, cacheEntries: 12, cacheBytes: 120_000_000 });

/** Süreç içi LRU önbellek (JSON metni) */
export function createCadCache({ entries = CAD_CLIENT_LIMITS.cacheEntries, bytes = CAD_CLIENT_LIMITS.cacheBytes } = {}) {
  /** @type {Map<string, string>} */
  const map = new Map();
  let total = 0;
  return {
    get(key) {
      const v = map.get(key);
      if (v === undefined) return null;
      map.delete(key);
      map.set(key, v);
      return v;
    },
    set(key, value) {
      if (typeof value !== 'string' || value.length > bytes) return;
      const old = map.get(key);
      if (old !== undefined) {
        total -= old.length;
        map.delete(key);
      }
      map.set(key, value);
      total += value.length;
      while (map.size > entries || total > bytes) {
        const [k, v] = map.entries().next().value;
        map.delete(k);
        total -= v.length;
      }
    },
    size: () => map.size,
  };
}

export const cadCache = createCadCache();

/**
 * @param {{ storageKey: string, mtimeMs: number, size: number }} f
 */
export const cadCacheKey = (f) => `${f.storageKey}|${f.size}|${Math.trunc(f.mtimeMs)}`;

/** Yanıt gövdesini sınırlı okur; sınır aşılırsa null */
async function readCapped(res, max) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

/**
 * DWG / DXF dosyasını hizmete gönderir.
 * @param {{ url: string | undefined, type: 'dwg' | 'dxf', path: string, size: number, fetchImpl?: typeof fetch, timeoutMs?: number }} o
 * @returns {Promise<{ ok: true, json: string } | { ok: false, code: string }>}
 */
export async function requestCadPreview({ url, type, path, size, fetchImpl = fetch, timeoutMs = CAD_CLIENT_LIMITS.timeoutMs }) {
  if (!url) return { ok: false, code: 'UNAVAILABLE' };
  let target;
  try {
    target = new URL('/preview', url);
    if (target.protocol !== 'http:') return { ok: false, code: 'UNAVAILABLE' };
    target.searchParams.set('type', type);
  } catch {
    return { ok: false, code: 'UNAVAILABLE' };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const body = /** @type {any} */ (Readable.toWeb(fs.createReadStream(path)));
    const res = await fetchImpl(target, {
      method: 'POST', body, duplex: 'half', redirect: 'error', signal: ac.signal,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    });
    const text = await readCapped(res, CAD_CLIENT_LIMITS.responseBytes);
    if (text === null) return { ok: false, code: 'TOO_COMPLEX' };
    /** @type {any} */
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { ok: false, code: res.ok ? 'INVALID' : 'UNAVAILABLE' }; }
    if (!res.ok || !parsed || parsed.ok !== true || !parsed.data || typeof parsed.data !== 'object') {
      return { ok: false, code: previewCode(parsed?.code) };
    }
    // Yalnızca bilinen alanlar istemciye gider
    const out = { ok: true, converted: parsed.converted === true, warning: parsed.warning === true, data: parsed.data };
    return { ok: true, json: JSON.stringify(out) };
  } catch (e) {
    return { ok: false, code: ac.signal.aborted ? 'TIMEOUT' : 'UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * CAD işi koruması (karar 289; güvenlik denetimi 3.93.2 Y-2) — tek hizmet yuvası bir kullanıcının dosyalarıyla
 * doldurulamasın, aynı zararlı dosya tekrar tekrar dönüştürülmesin:
 *  - olumsuz önbellek: belirleyici hatalar (dosyanın kendisinden kaynaklanan) anahtar = dosyanın kendisi için TTL süresince
 *    hizmete gönderilmeden aynı kodla döner; geçici hatalar (meşgul / ulaşılamıyor) önbelleğe alınmaz;
 *  - kullanıcı başına aynı anda TEK dönüştürme (ikincisi hemen BUSY);
 *  - aynı dosyanın eşzamanlı istekleri tek dönüştürmeyi paylaşır;
 *  - kullanıcı başına ayrı, düşük dönüştürme sınırı (önbellekten dönenler sayılmaz).
 */
export const CAD_GUARD = Object.freeze({ negativeTtlMs: 30 * 60_000, negativeEntries: 2000, convertLimit: 20, convertWindowMs: 5 * 60_000 });
/** Dosyanın kendisinden kaynaklanan (tekrarı aynı sonucu veren) hatalar */
export const CAD_DETERMINISTIC = Object.freeze(['TOO_COMPLEX', 'INVALID', 'CONVERT_FAILED', 'NOT_DXF', 'BINARY_DXF', 'TOO_LARGE', 'TIMEOUT']);

/**
 * @param {{ now?: () => number, limits?: Partial<typeof CAD_GUARD> }} [o]
 */
export function createCadGuard({ now = Date.now, limits = {} } = {}) {
  const L = { ...CAD_GUARD, ...limits };
  /** @type {Map<string, { code: string, until: number }>} */
  const negative = new Map();
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map();
  /** @type {Set<string>} */
  const users = new Set();
  const convertLimiter = createRateLimiter({ limit: L.convertLimit, windowMs: L.convertWindowMs });
  return {
    /**
     * @param {{ key: string, userId: string, run: () => Promise<{ ok: true, json: string } | { ok: false, code: string }> }} o
     */
    async run({ key, userId, run }) {
      const bad = negative.get(key);
      if (bad) {
        if (bad.until > now()) return { ok: false, code: bad.code, cached: true };
        negative.delete(key);
      }
      const shared = inflight.get(key);
      if (shared) return shared;
      if (users.has(userId)) return { ok: false, code: 'BUSY' };
      if (!convertLimiter.take(userId, now()).ok) return { ok: false, code: 'PREVIEW_LIMIT' };
      users.add(userId);
      const p = (async () => {
        try {
          const r = await run();
          if (!r.ok && CAD_DETERMINISTIC.includes(r.code)) {
            negative.delete(key);
            negative.set(key, { code: r.code, until: now() + L.negativeTtlMs });
            while (negative.size > L.negativeEntries) negative.delete(negative.keys().next().value);
          }
          return r;
        } finally {
          users.delete(userId);
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
    negativeSize: () => negative.size,
  };
}

export const cadGuard = createCadGuard();

/** Önizleme istek sınırı (kullanıcı başına; PDF / resim / CAD birlikte) */
export const PREVIEW_RATE = Object.freeze({ limit: 120, windowMs: 5 * 60_000 });
export const previewLimiter = createRateLimiter(PREVIEW_RATE);
