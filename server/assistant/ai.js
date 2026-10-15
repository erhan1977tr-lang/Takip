// TAKİP Telegram asistanı — yapay zekâ sağlayıcısı (OpenAI uyumlu API; 3.84.0, karar 278).
// İki çağrı: sohbet (araç çağırma ile) ve ses → metin. Anahtar yalnızca sunucu ortamından (OPENAI_API_KEY) gelir; hiçbir
// günlüğe, hata metnine ya da kullanıcıya yazılmaz. Hata metinleri sabit kodlardır (sağlayıcının ham yanıtı dışarı çıkmaz).
// Testler gerçek API'yi çağırmaz: fetchImpl verilir.

export const AI_BASE = 'https://api.openai.com/v1';
export const AI_TIMEOUT_MS = 45_000;
export const MAX_OUTPUT_TOKENS = 900;

export class AiError extends Error {
  /** @param {string} code AI_AUTH | AI_RATE | AI_TIMEOUT | AI_FAILED */
  constructor(code) { super(code); this.code = code; }
}

async function post(path, { apiKey, body, json = true, fetchImpl = fetch, timeoutMs = AI_TIMEOUT_MS }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${AI_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body: json ? JSON.stringify(body) : body,
      signal: ctl.signal,
      redirect: 'error',
    });
  } catch (e) {
    throw new AiError(e?.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_FAILED');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new AiError('AI_AUTH');
  if (res.status === 429) throw new AiError('AI_RATE');
  if (!res.ok) throw new AiError('AI_FAILED');
  try {
    return await res.json();
  } catch {
    throw new AiError('AI_FAILED');
  }
}

/**
 * Sohbet tamamlama (araçlarla). Dönen: modelin mesajı { content, tool_calls } ve kullanım.
 * @returns {Promise<{ message: { role: 'assistant', content: string | null, tool_calls?: any[] }, usage: any }>}
 */
export async function chat({ apiKey, model, messages, tools, fetchImpl, timeoutMs }) {
  const data = await post('/chat/completions', {
    apiKey, fetchImpl, timeoutMs,
    body: { model, messages, tools, tool_choice: 'auto', temperature: 0.1, max_completion_tokens: MAX_OUTPUT_TOKENS, parallel_tool_calls: true },
  });
  const message = data?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') throw new AiError('AI_FAILED');
  return { message: { role: 'assistant', content: typeof message.content === 'string' ? message.content : null, ...(Array.isArray(message.tool_calls) && message.tool_calls.length ? { tool_calls: message.tool_calls } : {}) }, usage: data.usage ?? null };
}

/**
 * Ses → metin (Türkçe). audio: Telegram sesli mesajı (OGG/Opus).
 * @returns {Promise<string>}
 */
export async function transcribe({ apiKey, model, audio, fetchImpl, timeoutMs }) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'ses.ogg');
  form.append('model', model);
  form.append('language', 'tr');
  form.append('response_format', 'json');
  const data = await post('/audio/transcriptions', { apiKey, body: form, json: false, fetchImpl, timeoutMs });
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  if (!text) throw new AiError('AI_FAILED');
  return text.slice(0, 1000);
}
