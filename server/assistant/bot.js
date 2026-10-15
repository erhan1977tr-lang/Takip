// TAKİP Telegram asistanı (3.84.0, karar 278): Türkçe yazılı / sesli soruları gerçek TAKİP verisiyle yanıtlar.
//
// Güvenlik sınırları (değiştirmeyin):
//   - Yalnızca TELEGRAM_ALLOWED_USER_ID: ileti hem bu kullanıcıdan hem de onunla ÖZEL sohbetten gelmeli; başka herkes yanıtsız
//     kalır (bot varlığını bile doğrulamaz). Grup / kanal iletileri yok sayılır.
//   - SALT OKUNUR: model veritabanına erişemez, SQL yazamaz; yalnızca server/assistant/tools.js araçlarını doğrulanmış
//     parametrelerle çağırır ve her araç READ ONLY işlemde çalışır. Veri değiştirme, belge / fatura kesme, FGO, e-posta,
//     bildirim yok. Asistan veritabanına kayıt bile yazmaz (sohbet geçmişi yalnızca süreç belleğinde, kısa süreli).
//   - Sınırlar: dakikada / günde ileti sayısı, ileti başına model turu ve araç çağrısı, metin / ses boyutu, yanıt uzunluğu.
//   - Sırlar (bot jetonu, API anahtarı) yalnızca ortamdan; günlüğe yalnızca sabit durum kodları yazılır — soru, yanıt,
//     kullanıcı kimliği, jeton yazılmaz.
// Çalıştığı yer: işçi süreci (scripts/worker.mjs) — yalnızca giden bağlantı (Telegram uzun sorgulama + AI API).
import { createRateLimiter } from '../security/rate-limit.js';
import { localDay } from '../profile/dates.js';
import { AiError, chat, transcribe } from './ai.js';
import { TelegramError, isBotToken, telegramClient } from './telegram.js';
import { readOnly } from './readonly.js';
import { runTool, toolDefinitions } from './tools.js';

export const LIMITS = Object.freeze({
  perMinute: 8, perDay: 300, rounds: 4, toolCalls: 8, textChars: 1000, voiceSeconds: 120, toolResultChars: 12_000,
  historyTurns: 6, historyTtlMs: 20 * 60_000, staleMs: 10 * 60_000,
});
export const DEFAULT_MODEL = 'gpt-4.1-mini';
export const DEFAULT_STT_MODEL = 'gpt-4o-mini-transcribe';

/** Yapılandırma: üç değer de geçerliyse açık; değilse kapalı + sabit neden (değer yazılmaz). Uygulamayı / işçiyi durdurmaz. */
export function assistantConfig(env) {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const user = String(env.TELEGRAM_ALLOWED_USER_ID ?? '').trim();
  const apiKey = String(env.OPENAI_API_KEY ?? '').trim();
  if (!token && !user && !apiKey) return { enabled: false, reason: 'NOT_CONFIGURED' };
  if (!isBotToken(token)) return { enabled: false, reason: 'BAD_TOKEN' };
  if (!/^[1-9]\d{4,14}$/.test(user)) return { enabled: false, reason: 'BAD_USER_ID' };
  if (!/^[A-Za-z0-9_-]{20,300}$/.test(apiKey)) return { enabled: false, reason: 'BAD_API_KEY' };
  const model = /^[A-Za-z0-9._:-]{2,64}$/.test(String(env.ASSISTANT_MODEL ?? '')) ? String(env.ASSISTANT_MODEL) : DEFAULT_MODEL;
  const sttModel = /^[A-Za-z0-9._:-]{2,64}$/.test(String(env.ASSISTANT_STT_MODEL ?? '')) ? String(env.ASSISTANT_STT_MODEL) : DEFAULT_STT_MODEL;
  return { enabled: true, token, userId: Number(user), apiKey, model, sttModel };
}

/** İleti izinli kullanıcıdan, onunla özel sohbette mi? */
export function isAllowed(msg, userId) {
  return !!msg && msg.from?.id === userId && msg.from?.is_bot !== true && msg.chat?.type === 'private' && msg.chat?.id === userId;
}

export const TEXT = Object.freeze({
  help: 'TAKİP asistanı — yalnızca bilgi verir, hiçbir kaydı değiştirmez.\nÖrnekler:\n• Bugünün genel durumu nedir?\n• GLA68 siparişinin durumu ne?\n• Yarın hangi yüklemeler var?\n• Kritik stokta hangi ürünler var?\n• Cam alacakları ne kadar, en çok kim borçlu?\n• Faturası kesilmemiş yüklemeler hangileri?\nSesli mesaj da gönderebilirsiniz. /sifirla: sohbeti sıfırlar.',
  reset: 'Sohbet geçmişi sıfırlandı.',
  rate: 'Çok sık soru geldi; lütfen biraz sonra tekrar deneyin.',
  daily: 'Günlük soru sınırına ulaşıldı; yarın tekrar deneyin.',
  tooLong: 'Soru çok uzun; lütfen kısaltın (en çok 1000 karakter).',
  voiceTooLong: 'Sesli mesaj çok uzun (en çok 2 dakika).',
  voiceFailed: 'Sesli mesaj anlaşılamadı; lütfen tekrar deneyin ya da yazın.',
  unsupported: 'Yalnızca yazılı ve sesli Türkçe soruları yanıtlayabilirim.',
  aiAuth: 'Yapay zekâ servisine bağlanılamadı (anahtar). Yönetici sunucudaki ayarı kontrol etmeli.',
  aiBusy: 'Yapay zekâ servisi şu an yoğun; lütfen biraz sonra tekrar deneyin.',
  failed: 'Şu an yanıt üretilemedi; lütfen biraz sonra tekrar deneyin.',
  empty: 'Bu soruya veriyle yanıt bulamadım.',
});

/** Sistem yönergesi (Türkçe); bugünün tarihi ve kurallar */
export function systemPrompt(today) {
  return [
    `Sen GKH Trading Invest'in TAKİP sipariş ve üretim sisteminin Türkçe asistanısın. Bugün: ${today} (Europe/Bucharest).`,
    'Yalnızca verilen araçlardan gelen GERÇEK verilerle yanıt ver; veri yoksa ya da araç hata verdiyse bunu açıkça söyle, asla tahmin etme veya uydurma.',
    'Sen SALT OKUNURSUN: hiçbir kaydı değiştiremez, sipariş / teklif / fatura / FGO belgesi oluşturamaz, e-posta gönderemezsin. Böyle bir istek gelirse yapamayacağını kısaca söyle ve TAKİP panelini öner.',
    'Farklı para birimlerini (EUR, RON) asla toplama. Tutarları para birimiyle yaz. Tarihleri GG.AA.YYYY biçiminde yaz.',
    'Kısa, net, maddeli yaz; düz metin kullan (Markdown tablo yok). En çok 3000 karakter.',
    'Sipariş durumları: YENI=yeni, HAZIRLANIYOR=hazırlanıyor, URETIMDE=üretimde, YUKLENDI=yüklendi, ARSIVLENDI=arşivlendi, IPTAL=iptal. Teklif: HAZIRLANIYOR=satışta, YONETIMDE=yönetici onayında, GONDERILDI=müşteriye gönderildi.',
    '"Yarın", "bu hafta" gibi ifadeleri bugünün tarihine göre YYYY-AA-GG gününe çevirip araca ver.',
  ].join('\n');
}

const errText = (e) => {
  if (e instanceof AiError) return e.code === 'AI_AUTH' ? TEXT.aiAuth : e.code === 'AI_RATE' || e.code === 'AI_TIMEOUT' ? TEXT.aiBusy : TEXT.failed;
  return TEXT.failed;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…(kısaltıldı)` : s);

/**
 * Soruyu yanıtlar: model ↔ araçlar döngüsü (en çok LIMITS.rounds tur, LIMITS.toolCalls araç çağrısı).
 * @param {{ question: string, history?: any[], cfg: any, db: any, fetchImpl?: typeof fetch, now?: Date, tz: string }} o
 * @returns {Promise<{ text: string, tools: string[], usage: number }>}
 */
export async function answer({ question, history = [], cfg, db, fetchImpl = fetch, now = new Date(), tz }) {
  const today = localDay(now, tz);
  const messages = [{ role: 'system', content: systemPrompt(today) }, ...history, { role: 'user', content: question }];
  const tools = toolDefinitions();
  const ro = readOnly(db);
  const used = [];
  let calls = 0, tokens = 0;
  for (let round = 0; round < LIMITS.rounds; round++) {
    const { message, usage } = await chat({ apiKey: cfg.apiKey, model: cfg.model, messages, tools: round < LIMITS.rounds - 1 ? tools : undefined, fetchImpl });
    tokens += Number(usage?.total_tokens ?? 0);
    if (!message.tool_calls?.length) return { text: (message.content ?? '').trim() || TEXT.empty, tools: used, usage: tokens };
    messages.push(message);
    for (const tc of message.tool_calls) {
      const name = String(tc?.function?.name ?? '');
      let result;
      if (++calls > LIMITS.toolCalls) result = { hata: 'TOO_MANY_CALLS' };
      else {
        used.push(name);
        result = await runTool(ro, name, tc?.function?.arguments ?? '{}', { tz, now });
      }
      messages.push({ role: 'tool', tool_call_id: String(tc?.id ?? ''), content: clip(JSON.stringify(result), LIMITS.toolResultChars) });
    }
  }
  return { text: TEXT.failed, tools: used, usage: tokens };
}

/**
 * Bot: güncellemeleri işler ve uzun sorgulama döngüsünü çalıştırır.
 * @param {{ db: any, env: Record<string, any>, fetchImpl?: typeof fetch, log?: (...a: any[]) => void, clock?: () => Date }} o
 */
export function createAssistant({ db, env, fetchImpl = fetch, log = () => {}, clock = () => new Date() }) {
  const cfg = assistantConfig(env);
  const tz = env.APP_TIMEZONE || 'Europe/Bucharest';
  const stats = { ignored: 0, answered: 0, failed: 0 };
  if (!cfg.enabled) return { enabled: false, reason: cfg.reason, stats, handleUpdate: async () => {}, run: async () => {} };
  const tg = telegramClient({ token: cfg.token, fetchImpl });
  const perMinute = createRateLimiter({ limit: LIMITS.perMinute, windowMs: 60_000 });
  const perDay = createRateLimiter({ limit: LIMITS.perDay, windowMs: 24 * 3600_000 });
  /** @type {{ at: number, turns: any[] }} */
  let memory = { at: 0, turns: [] };

  const reply = (text) => tg.sendMessage(cfg.userId, text).catch(() => { stats.failed++; });

  async function handleUpdate(update) {
    const msg = update?.message;
    if (!isAllowed(msg, cfg.userId)) { stats.ignored++; return; }
    const now = clock();
    if (Number(msg.date) * 1000 < now.getTime() - LIMITS.staleMs) { stats.ignored++; return; } // yeniden başlatmadan önceki eski ileti
    let question = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (question === '/start' || question === '/yardim' || question === '/help') return reply(TEXT.help);
    if (question === '/sifirla') { memory = { at: 0, turns: [] }; return reply(TEXT.reset); }
    const key = String(cfg.userId);
    if (!perDay.take(key).ok) return reply(TEXT.daily);
    if (!perMinute.take(key).ok) return reply(TEXT.rate);
    let heard = null;
    if (!question && msg.voice) {
      if (Number(msg.voice.duration) > LIMITS.voiceSeconds) return reply(TEXT.voiceTooLong);
      try {
        await tg.sendChatAction(cfg.userId, 'typing').catch(() => {});
        const audio = await tg.downloadFile(String(msg.voice.file_id ?? ''));
        question = heard = await transcribe({ apiKey: cfg.apiKey, model: cfg.sttModel, audio, fetchImpl });
      } catch (e) {
        log('asistan: ses', e?.code ?? 'ERR');
        stats.failed++;
        return reply(e instanceof AiError && e.code === 'AI_AUTH' ? TEXT.aiAuth : TEXT.voiceFailed);
      }
    }
    if (!question) return reply(TEXT.unsupported);
    if (question.length > LIMITS.textChars) return reply(TEXT.tooLong);
    if (now.getTime() - memory.at > LIMITS.historyTtlMs) memory = { at: 0, turns: [] };
    await tg.sendChatAction(cfg.userId, 'typing').catch(() => {});
    try {
      const r = await answer({ question, history: memory.turns, cfg, db, fetchImpl, now, tz });
      memory = { at: now.getTime(), turns: [...memory.turns, { role: 'user', content: question }, { role: 'assistant', content: r.text }].slice(-LIMITS.historyTurns * 2) };
      stats.answered++;
      log('asistan: yanıt', r.tools.join(',') || '-', `tokens=${r.usage}`);
      return reply(heard ? `🎤 "${heard}"\n\n${r.text}` : r.text);
    } catch (e) {
      stats.failed++;
      log('asistan: hata', e?.code ?? 'ERR');
      return reply(errText(e));
    }
  }

  /** Uzun sorgulama döngüsü; signal.aborted olunca biter. Hata → artan bekleme (en çok 60 sn). */
  async function run(signal) {
    let offset = 0, backoff = 1000;
    const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener?.('abort', () => { clearTimeout(t); r(); }, { once: true }); });
    try { await tg.deleteWebhook(); } catch (e) { log('asistan: webhook', e?.code ?? 'ERR'); }
    log('asistan: açık');
    while (!signal?.aborted) {
      let updates;
      try {
        updates = await tg.getUpdates(offset, 25);
        backoff = 1000;
      } catch (e) {
        log('asistan: telegram', e?.code ?? 'ERR');
        const wait = e instanceof TelegramError && e.code === 'TG_AUTH' ? 300_000 : e instanceof TelegramError && e.retryAfter ? e.retryAfter * 1000 : backoff;
        backoff = Math.min(backoff * 2, 60_000);
        await sleep(wait);
        continue;
      }
      for (const u of Array.isArray(updates) ? updates : []) {
        offset = Math.max(offset, Number(u.update_id) + 1);
        try { await handleUpdate(u); } catch (e) { stats.failed++; log('asistan: işlem', e?.code ?? 'ERR'); }
      }
    }
    log('asistan: kapandı');
  }

  return { enabled: true, reason: null, stats, handleUpdate, run, config: { model: cfg.model, sttModel: cfg.sttModel } };
}
