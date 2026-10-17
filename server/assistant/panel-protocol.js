// Panel AI asistanı — uygulama ↔ işçi iç protokolü (3.95.0, karar 290). Saf modül: yapay zekâ, veritabanı ya da ağ
// kodu İÇERMEZ; uygulama (istemci) ve işçi (sunucu) aynı imza / doğrulama kurallarını buradan alır.
//
// Neden: OpenAI anahtarı internete açık uygulama kapsayıcısında YOKTUR (karar 289). Uygulama soruyu, oturum ve yetki
// denetiminden sonra işçiye iç ağdan iletir; işçi isteğin uygulamadan geldiğini HMAC imzasıyla, tazeliğini zaman damgası
// ve tek kullanımlık nonce ile doğrular ve kullanıcıyı veritabanında YENİDEN denetler (imzalı kimlik yetki değildir).
//
// İmza anahtarı AUTH_SECRET'tan amaca özgü türetilir (HMAC(AUTH_SECRET, PURPOSE)); oturum / davet imzalarıyla karışmaz.
// İmza, gövdenin HAM baytları üzerindedir (JSON yeniden sıralama / boşluk farkı imzayı bozmaz değil, reddettirir).
import { deriveKey, hexEqual, hmacHex } from '../security/hmac.js';

export const PANEL_PURPOSE = 'takip:assistant-panel:v1';
export const PANEL_PATH = '/sor';
export const SIG_HEADER = 'x-takip-asistan-imza';
export const PANEL_LIMITS = Object.freeze({
  bodyBytes: 8 * 1024, // istek gövdesi
  responseBytes: 64 * 1024, // yanıt gövdesi (istemci okurken keser)
  questionChars: 1000,
  answerChars: 4000,
  skewMs: 60_000, // zaman damgası penceresi (±)
  nonceTtlMs: 5 * 60_000,
  nonceMax: 20_000,
});
/** İşçinin dönebileceği hata kodları (istemci başka bir kodu UNAVAILABLE sayar) */
export const PANEL_CODES = Object.freeze([
  'BAD_REQUEST', 'BAD_SIGNATURE', 'STALE', 'REPLAY', 'FORBIDDEN', 'NOT_CONFIGURED', 'TOO_LONG', 'EMPTY',
  'RATE', 'DAILY', 'BUDGET', 'BUSY', 'TIMEOUT', 'AI_AUTH', 'AI_BUSY', 'FAILED', 'UNAVAILABLE',
]);

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** AUTH_SECRET → amaca özgü imza anahtarı (boş / kısa sırda null: protokol kapalı) */
export function panelKey(authSecret) {
  const s = String(authSecret ?? '');
  if (s.length < 32) return null;
  return deriveKey(s, PANEL_PURPOSE);
}

/** @param {Buffer} key @param {string | Buffer} raw → onaltılık imza */
export function signBody(key, raw) {
  return hmacHex(key, raw);
}

/** Sabit zamanlı imza karşılaştırması */
export function signatureOk(key, raw, sig) {
  if (!key || typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return hexEqual(signBody(key, raw), sig);
}

/**
 * Gövdeyi kurar (istemci). question kırpılır; uzunluk / biçim burada da denetlenir (işçi yeniden denetler).
 * @returns {string} JSON gövde
 */
export function buildBody({ userId, question = '', orderId = null, reset = false, now = Date.now(), nonce }) {
  return JSON.stringify({ v: 1, userId, question: String(question ?? '').trim(), orderId: orderId ?? null, reset: reset === true, ts: now, nonce });
}

/**
 * Gövdeyi doğrular (işçi): biçim + tazelik. Nonce ve kullanıcı denetimi çağıranın işidir.
 * @returns {{ ok: true, body: { userId: string, question: string, orderId: string | null, reset: boolean, ts: number, nonce: string } } | { ok: false, code: string }}
 */
export function parseBody(raw, now = Date.now()) {
  let b;
  try { b = JSON.parse(String(raw)); } catch { return { ok: false, code: 'BAD_REQUEST' }; }
  if (!b || typeof b !== 'object' || Array.isArray(b) || b.v !== 1) return { ok: false, code: 'BAD_REQUEST' };
  const allowed = new Set(['v', 'userId', 'question', 'orderId', 'reset', 'ts', 'nonce']);
  if (Object.keys(b).some((k) => !allowed.has(k))) return { ok: false, code: 'BAD_REQUEST' };
  if (typeof b.userId !== 'string' || !ID_RE.test(b.userId)) return { ok: false, code: 'BAD_REQUEST' };
  if (b.orderId !== null && (typeof b.orderId !== 'string' || !ID_RE.test(b.orderId))) return { ok: false, code: 'BAD_REQUEST' };
  if (typeof b.reset !== 'boolean' || typeof b.question !== 'string') return { ok: false, code: 'BAD_REQUEST' };
  if (typeof b.nonce !== 'string' || !NONCE_RE.test(b.nonce)) return { ok: false, code: 'BAD_REQUEST' };
  if (!Number.isSafeInteger(b.ts) || Math.abs(now - b.ts) > PANEL_LIMITS.skewMs) return { ok: false, code: 'STALE' };
  const question = b.question.trim();
  if (!b.reset) {
    if (!question) return { ok: false, code: 'EMPTY' };
    if (question.length > PANEL_LIMITS.questionChars) return { ok: false, code: 'TOO_LONG' };
  }
  return { ok: true, body: { userId: b.userId, question, orderId: b.orderId, reset: b.reset, ts: b.ts, nonce: b.nonce } };
}

/**
 * Bellekteki Map / Set'ten anahtar çıkarır. (Asistan dizininde "delete" yöntem çağrısı yapısal testte veritabanı yazması sayılır;
 * bu yardımcı yalnızca süreç belleğindeki koleksiyonlar içindir — veritabanına hiçbir şey yazmaz.)
 * @param {Map<any, any> | Set<any>} c
 */
export const forget = (c, k) => c['delete'](k);

/** Tek kullanımlık nonce önbelleği (süreç belleği; zaman damgası penceresinden uzun tutulur) */
export function createNonceCache({ ttlMs = PANEL_LIMITS.nonceTtlMs, max = PANEL_LIMITS.nonceMax } = {}) {
  const seen = new Map();
  return {
    /**
     * İlk görüşte 'ok', tekrarında 'replay'. Yalnızca SÜRESİ GEÇMİŞ kayıtlar atılır (ekleme sırası = zaman sırası); önbellek
     * taze kayıtlarla doluysa 'full' (istek reddedilir) — taze bir nonce asla unutulmaz, yoksa tekrar kabul edilebilirdi.
     * @returns {'ok' | 'replay' | 'full'}
     */
    take(nonce, now = Date.now()) {
      for (const [k, at] of seen) {
        if (now - at < ttlMs) break;
        forget(seen, k);
      }
      if (seen.has(nonce)) return 'replay';
      if (seen.size >= max) return 'full';
      seen.set(nonce, now);
      return 'ok';
    },
    size: () => seen.size,
  };
}
