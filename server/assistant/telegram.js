// TAKİP Telegram asistanı — Telegram Bot API istemcisi (3.84.0, karar 278).
// Yalnızca giden istek (uzun sorgulama — getUpdates): sunucuda gelen bağlantı / webhook / yeni açık port YOKTUR.
// Bot jetonu adrese girer (Telegram'ın kuralı); bu yüzden adres hiçbir günlüğe, hata metnine yazılmaz — hatalar sabit
// kodlardır. Testler gerçek Telegram'ı çağırmaz: fetchImpl verilir.

export const TG_BASE = 'https://api.telegram.org';
export const TG_TEXT_MAX = 4000;
export const VOICE_MAX_BYTES = 5 * 1024 * 1024;

export class TelegramError extends Error {
  /** @param {string} code TG_AUTH | TG_CONFLICT | TG_RATE | TG_TIMEOUT | TG_FAILED | TG_TOO_LARGE */
  constructor(code, retryAfter = 0) { super(code); this.code = code; this.retryAfter = retryAfter; }
}

/** Telegram jetonu biçimi: <sayı>:<35 civarı güvenli karakter> */
export const isBotToken = (v) => typeof v === 'string' && /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(v);

/**
 * @param {{ token: string, fetchImpl?: typeof fetch }} o
 */
export function telegramClient({ token, fetchImpl = fetch }) {
  async function call(method, body, timeoutMs = 15_000, form = null) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${TG_BASE}/bot${token}/${method}`, {
        method: 'POST', ...(form ? { body: form } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }), signal: ctl.signal, redirect: 'error',
      });
    } catch (e) {
      throw new TelegramError(e?.name === 'AbortError' ? 'TG_TIMEOUT' : 'TG_FAILED');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401 || res.status === 404) throw new TelegramError('TG_AUTH');
    if (res.status === 409) throw new TelegramError('TG_CONFLICT');
    if (res.status === 429) throw new TelegramError('TG_RATE', Number(data?.parameters?.retry_after) || 5);
    if (!res.ok || !data?.ok) throw new TelegramError('TG_FAILED');
    return data.result;
  }

  return {
    /** Uzun sorgulama: en çok `timeout` saniye bekler; yalnızca "message" güncellemeleri */
    getUpdates: (offset, timeout = 25) => call('getUpdates', { offset, timeout, allowed_updates: ['message'] }, (timeout + 10) * 1000),
    deleteWebhook: () => call('deleteWebhook', { drop_pending_updates: false }),
    getMe: () => call('getMe', {}),
    sendChatAction: (chatId, action = 'typing') => call('sendChatAction', { chat_id: chatId, action }),
    /** Düz metin (biçimlendirme yok — modelin metni yorumlanmaz); uzun metin parçalanır */
    async sendMessage(chatId, text) {
      for (const part of splitText(String(text ?? ''))) await call('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true });
    },
    /** Sesli yanıt (OGG / Opus — Telegram sesli mesajı); boyut sınırı */
    async sendVoice(chatId, audio) {
      if (!audio?.length || audio.length > VOICE_MAX_BYTES) throw new TelegramError('TG_TOO_LARGE');
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('voice', new Blob([audio], { type: 'audio/ogg' }), 'yanit.ogg');
      return call('sendVoice', null, 60_000, form);
    },
    /** Sesli mesaj dosyası (boyut sınırı; adres günlüğe yazılmaz) */
    async downloadFile(fileId, maxBytes = VOICE_MAX_BYTES) {
      const f = await call('getFile', { file_id: fileId });
      if (!f?.file_path || (f.file_size && f.file_size > maxBytes)) throw new TelegramError('TG_TOO_LARGE');
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30_000);
      try {
        const res = await fetchImpl(`${TG_BASE}/file/bot${token}/${f.file_path}`, { signal: ctl.signal, redirect: 'error' });
        if (!res.ok) throw new TelegramError('TG_FAILED');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) throw new TelegramError('TG_TOO_LARGE');
        return buf;
      } catch (e) {
        throw e instanceof TelegramError ? e : new TelegramError(e?.name === 'AbortError' ? 'TG_TIMEOUT' : 'TG_FAILED');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Telegram ileti sınırı (4096) altında, satır sınırından bölünmüş parçalar */
export function splitText(text, max = TG_TEXT_MAX) {
  const t = text.trim() || '—';
  const out = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  out.push(rest);
  return out.slice(0, 5);
}
