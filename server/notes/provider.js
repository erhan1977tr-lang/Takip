// Not çevirisi sağlayıcısı (karar 127): Google Cloud Translation (Basic, v2) — yalnızca sunucuda.
//   - Anahtar istek BAŞLIĞINDA gider (X-Goog-Api-Key); adrese, günlüğe, hata metnine ya da istemciye hiç yazılmaz.
//   - Kaynak dil gönderilmez (Google kendisi tanır); HEDEF dil çağıran tarafından, yazanın rolünden belirlenir.
//   - format = "text": metin olduğu gibi çevrilir (HTML kaçışı yok).
//   - Her hata güvenli bir KOD'a çevrilir (TranslateError.code). Google'ın açıklaması yalnızca yöneticinin "Bağlantıyı
//     dene" sonucunda, anahtar ayıklanmış ve kısaltılmış olarak gösterilir (detail); nota hiçbir zaman yazılmaz.
// Testler: TRANSLATE_FAKE=1 iken sahte sağlayıcı kullanılır (ağa hiç çıkmaz); birim / veritabanı testleri sağlayıcıyı
// ya da fetchImpl'i kendisi verir. Testlerde gerçek Google'a istek gitmez.
import { getEnv } from '../env.js';

export const GOOGLE_TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';
export const TRANSLATE_TIMEOUT_MS = 6000;
/** Çevirinin saklanan en büyük uzunluğu (not en çok 4000 karakter; çeviri uzayabilir) */
export const TRANSLATION_MAX = 12000;
/** Güvenli hata kodları (nota yazılan / ekranda metne çevrilen) */
export const TRANSLATE_ERRORS = ['TIMEOUT', 'NETWORK', 'QUOTA', 'AUTH', 'BAD_REQUEST', 'SERVER', 'HTTP', 'BAD_RESPONSE', 'NO_KEY', 'INTERRUPTED', 'ERROR'];

export class TranslateError extends Error {
  /** @param {string} code  @param {string} [detail]  yalnızca yönetici bağlantı denemesi için (anahtar ayıklanmış) */
  constructor(code, detail = '') {
    super(`çeviri yapılamadı: ${code}`);
    this.code = TRANSLATE_ERRORS.includes(code) ? code : 'ERROR';
    this.detail = detail;
  }
}

/** Dış sistemin metninden anahtarı ayıklar, tek satıra indirir ve kısaltır */
export function safeDetail(message, key) {
  let s = String(message ?? '');
  if (key) s = s.split(String(key)).join('***');
  return s.replace(/AIza[0-9A-Za-z_-]{10,}/g, '***').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Google hata yanıtı → güvenli kod */
export function googleErrorCode(http, body) {
  const err = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const reasons = [...list(err.errors), ...list(err.details)].map((e) => String(e?.reason ?? '')).filter(Boolean);
  const status = String(err.status ?? '');
  const message = String(err.message ?? '');
  if (http === 429 || status === 'RESOURCE_EXHAUSTED' || reasons.some((r) => /limit|quota/i.test(r))) return 'QUOTA';
  if (http === 401 || http === 403 || status === 'PERMISSION_DENIED' || status === 'UNAUTHENTICATED'
    || reasons.some((r) => /API_KEY|keyInvalid|forbidden|accessNotConfigured|SERVICE_DISABLED|BILLING/i.test(r)) || /API key/i.test(message)) return 'AUTH';
  if (http === 400) return 'BAD_REQUEST';
  if (http >= 500) return 'SERVER';
  return 'HTTP';
}

/**
 * Metni Google ile çevirir. Başarısızlıkta TranslateError fırlatır (kod güvenlidir).
 * @param {{ text: string, target: 'tr' | 'ro', key: string, fetchImpl?: typeof fetch, timeoutMs?: number }} o
 * @returns {Promise<{ text: string }>}
 */
export async function googleTranslate({ text, target, key, fetchImpl = fetch, timeoutMs = TRANSLATE_TIMEOUT_MS }) {
  if (!key) throw new TranslateError('NO_KEY');
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new TranslateError('TIMEOUT'));
    }, timeoutMs);
  });
  try {
    let res;
    try {
      res = await Promise.race([
        fetchImpl(GOOGLE_TRANSLATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Goog-Api-Key': key },
          body: JSON.stringify({ q: text, target, format: 'text' }),
          signal: ctrl.signal,
        }),
        timeout,
      ]);
    } catch (e) {
      if (e instanceof TranslateError) throw e;
      throw new TranslateError(e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK');
    }
    let body = null;
    try {
      body = await Promise.race([res.json(), timeout]);
    } catch (e) {
      if (e instanceof TranslateError) throw e;
      body = null;
    }
    if (!res.ok) throw new TranslateError(googleErrorCode(res.status, body), safeDetail(body?.error?.message ?? `HTTP ${res.status}`, key));
    const out = body?.data?.translations?.[0]?.translatedText;
    if (typeof out !== 'string' || !out.trim()) throw new TranslateError('BAD_RESPONSE');
    return { text: out.slice(0, TRANSLATION_MAX) };
  } finally {
    clearTimeout(timer);
  }
}

/** Sahte sağlayıcıda hata / "aynı dil" durumunu tetikleyen işaretler (yalnızca TRANSLATE_FAKE=1 iken anlamlıdır) */
export const FAKE_FAIL_MARK = '#çeviri-hata';
export const FAKE_SAME_MARK = '#aynı-dil';

/**
 * Sahte sağlayıcı (yalnızca test): ağa çıkmaz. "[hedef] metin" döner; işaretli metinde hata verir ya da metni aynen döner.
 * @param {{ text: string, target: string }} o
 * @returns {Promise<{ text: string }>}
 */
export async function fakeTranslate({ text, target }) {
  if (String(text).includes(FAKE_FAIL_MARK)) throw new TranslateError('TIMEOUT', 'sahte sağlayıcı: zaman aşımı');
  if (String(text).includes(FAKE_SAME_MARK)) return { text: String(text) };
  return { text: `[${target}] ${text}` };
}

/** Sahte sağlayıcı açık mı (TRANSLATE_FAKE=1 — yalnızca geliştirme / test) */
export const fakeTranslateOn = (env = getEnv()) => env.TRANSLATE_FAKE === true;

/** Ortamın sağlayıcısı: TRANSLATE_FAKE=1 → sahte; aksi hâlde Google */
export const translatorFor = (env = getEnv()) => (fakeTranslateOn(env) ? fakeTranslate : googleTranslate);
