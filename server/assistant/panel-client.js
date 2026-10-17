// Panel AI asistanı — uygulama tarafı istemci (3.95.0, karar 290). Uygulama kapsayıcısında çalışır: yapay zekâ anahtarı,
// yanıtlayıcı ya da araç kodu İÇERMEZ (bu dosya ai.js / bot.js / tools.js'i içe aktarmaz — test denetler). Soruyu,
// sunucu eyleminin oturum + yetki denetiminden sonra, imzalayıp işçinin iç adresine (ASSISTANT_PANEL_URL) iletir.
import { randomBytes } from 'node:crypto';
import { PANEL_CODES, PANEL_LIMITS, PANEL_PATH, SIG_HEADER, buildBody, panelKey, signBody } from './panel-protocol.js';

export const CLIENT_TIMEOUT_MS = 110_000;

/**
 * @param {{ url: string | undefined, authSecret: string | undefined, userId: string, question?: string, orderId?: string | null,
 *   reset?: boolean, fetchImpl?: typeof fetch, now?: number, timeoutMs?: number }} o
 * @returns {Promise<{ ok: true, text: string } | { ok: false, code: string }>}
 */
export async function askPanel({ url, authSecret, userId, question = '', orderId = null, reset = false, fetchImpl = fetch, now = Date.now(), timeoutMs = CLIENT_TIMEOUT_MS }) {
  const key = panelKey(authSecret);
  let base;
  try { base = new URL(String(url ?? '')); } catch { return { ok: false, code: 'NOT_CONFIGURED' }; }
  if (!key || base.protocol !== 'http:' || base.username || base.password) return { ok: false, code: 'NOT_CONFIGURED' };
  const raw = buildBody({ userId, question, orderId, reset, now, nonce: randomBytes(18).toString('base64url') });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(new URL(PANEL_PATH, base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [SIG_HEADER]: signBody(key, raw) },
        body: raw,
        signal: ctl.signal,
        redirect: 'error',
        cache: 'no-store',
      });
    } catch (e) {
      return { ok: false, code: e?.name === 'AbortError' ? 'TIMEOUT' : 'UNAVAILABLE' };
    }
    const text = await readBounded(res);
    let json = null;
    try { json = text === null ? null : JSON.parse(text); } catch { json = null; }
    if (json && json.ok === true && typeof json.text === 'string') return { ok: true, text: json.text.slice(0, PANEL_LIMITS.answerChars) };
    if (json && json.ok === false && PANEL_CODES.includes(json.code)) return { ok: false, code: json.code };
    return { ok: false, code: 'UNAVAILABLE' };
  } catch (e) {
    return { ok: false, code: e?.name === 'AbortError' ? 'TIMEOUT' : 'UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
  }
}

/** Yanıt gövdesini en çok PANEL_LIMITS.responseBytes okur; aşarsa null (akış iptal edilir) */
async function readBounded(res) {
  if (!res?.body?.getReader) {
    const t = await res.text();
    return Buffer.byteLength(t) > PANEL_LIMITS.responseBytes ? null : t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PANEL_LIMITS.responseBytes) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
