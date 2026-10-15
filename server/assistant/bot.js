// TAKİP Telegram asistanı (3.84.0, karar 278; 3.85.0, karar 280): Türkçe / Romence yazılı ve sesli soruları gerçek TAKİP
// verisiyle yanıtlar. Yazılı soruya yalnızca yazılı, sesli soruya yazılı (tam ayrıntı) + sesli (kısa özet) yanıt verir.
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
import { AiError, TTS_MAX_CHARS, chat, speech, transcribe } from './ai.js';
import { TelegramError, isBotToken, telegramClient } from './telegram.js';
import { readOnly } from './readonly.js';
import { runTool, toolDefinitions } from './tools.js';

export const LIMITS = Object.freeze({
  perMinute: 8, perDay: 300, rounds: 4, toolCalls: 8, textChars: 1000, voiceSeconds: 120, toolResultChars: 12_000,
  historyTurns: 6, historyTtlMs: 20 * 60_000, staleMs: 10 * 60_000,
});
export const DEFAULT_MODEL = 'gpt-4.1-mini';
export const DEFAULT_STT_MODEL = 'gpt-4o-mini-transcribe';
export const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_TTS_VOICE = 'coral';
export const TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
/** Sesli yanıtta modelin yazılı yanıttan sonra koyduğu ayraç; ardından sesli okunacak kısa özet gelir (yazılı yanıta girmez) */
export const VOICE_MARK = '<<SES>>';
/** Kapanış cümlesi (Türkçe / Romence) */
export const CLOSING = Object.freeze({ tr: 'Başka bir emrin olur mu, sahip?', ro: 'Mai ai vreo poruncă, stăpâne?' });

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
  const ttsModel = /^[A-Za-z0-9._:-]{2,64}$/.test(String(env.ASSISTANT_TTS_MODEL ?? '')) ? String(env.ASSISTANT_TTS_MODEL) : DEFAULT_TTS_MODEL;
  const ttsVoice = TTS_VOICES.includes(String(env.ASSISTANT_TTS_VOICE ?? '')) ? String(env.ASSISTANT_TTS_VOICE) : DEFAULT_TTS_VOICE;
  return { enabled: true, token, userId: Number(user), apiKey, model, sttModel, ttsModel, ttsVoice };
}

/** İleti izinli kullanıcıdan, onunla özel sohbette mi? */
export function isAllowed(msg, userId) {
  return !!msg && msg.from?.id === userId && msg.from?.is_bot !== true && msg.chat?.type === 'private' && msg.chat?.id === userId;
}

export const TEXT = Object.freeze({
  help: 'TAKİP asistanı — yalnızca bilgi verir, hiçbir kaydı değiştirmez. Türkçe ya da Romence sorabilirsin.\nÖrnekler:\n• Bugünün genel durumu nedir?\n• ALE40 siparişinin camları ve toplam m²si?\n• GLA68 ne kadar yüklendi, ne kadar kaldı?\n• Yarınki yükleme: firmalar, m², sandıklar?\n• GLA68 hangi sandıklarda?\n• Kritik stokta hangi ürünler var?\n• Cam alacakları ne kadar, en çok kim borçlu?\nSesli mesaj gönderirsen yazılı yanıtla birlikte kısa bir sesli özet de gönderirim. /sifirla: sohbeti sıfırlar.',
  reset: 'Sohbet geçmişi sıfırlandı.',
  rate: 'Çok sık soru geldi; lütfen biraz sonra tekrar deneyin.',
  daily: 'Günlük soru sınırına ulaşıldı; yarın tekrar deneyin.',
  tooLong: 'Soru çok uzun; lütfen kısaltın (en çok 1000 karakter).',
  voiceTooLong: 'Sesli mesaj çok uzun (en çok 2 dakika).',
  voiceFailed: 'Sesli mesaj anlaşılamadı; lütfen tekrar deneyin ya da yazın.',
  unsupported: 'Yalnızca yazılı ve sesli (Türkçe / Romence) soruları yanıtlayabilirim.',
  aiAuth: 'Yapay zekâ servisine bağlanılamadı (anahtar). Yönetici sunucudaki ayarı kontrol etmeli.',
  aiBusy: 'Yapay zekâ servisi şu an yoğun; lütfen biraz sonra tekrar deneyin.',
  failed: 'Şu an yanıt üretilemedi; lütfen biraz sonra tekrar deneyin.',
  empty: 'Bu soruya veriyle yanıt bulamadım.',
});
/** Romence sabit metinler (soru Romence ise) */
export const TEXT_RO = Object.freeze({
  rate: 'Prea multe întrebări într-un timp scurt; te rog încearcă puțin mai târziu.',
  daily: 'S-a atins limita zilnică de întrebări; încearcă mâine.',
  tooLong: 'Întrebarea este prea lungă; te rog scurteaz-o (cel mult 1000 de caractere).',
  voiceTooLong: 'Mesajul vocal este prea lung (cel mult 2 minute).',
  voiceFailed: 'Nu am înțeles mesajul vocal; te rog încearcă din nou sau scrie.',
  aiAuth: 'Nu m-am putut conecta la serviciul de inteligență artificială (cheie). Administratorul trebuie să verifice setarea.',
  aiBusy: 'Serviciul de inteligență artificială este ocupat acum; te rog încearcă puțin mai târziu.',
  failed: 'Nu am putut genera un răspuns acum; te rog încearcă puțin mai târziu.',
  empty: 'Nu am găsit date pentru această întrebare.',
});
/** Sabit metin sorunun dilinde */
export const textFor = (lang, key) => (lang === 'ro' && Object.hasOwn(TEXT_RO, key) ? TEXT_RO[key] : TEXT[key]);

/**
 * Sorunun dili: 'ro' ya da 'tr' (varsayılan). Türkçeye özgü harf (ğ, ı, İ, ö, ü, ç) → tr; Romenceye özgü harf (ă, â, î, ș, ț,
 * ţ) → ro; harf yoksa sık Romence sözcükler. Model yanıtı zaten sorunun dilinde yazar; bu yalnızca sabit metinler ve ses tonu için.
 */
export function detectLang(text) {
  const s = String(text ?? '');
  const tr = (s.match(/[ğıİöüçĞÖÜÇ]/g) ?? []).length;
  const ro = (s.match(/[ăâîșțţĂÂÎȘȚŢ]/g) ?? []).length;
  if (ro > tr) return 'ro';
  if (tr > 0) return 'tr';
  return /\b(comanda|comenzi|comenzii|cate|livrare|incarcare|maine|astazi|azi|care|este|sunt|pentru|unde|cat|cati|ce|si|lazi|lada|sticla|metri)\b/i.test(s) ? 'ro' : 'tr';
}

/** Sistem yönergesi; bugünün tarihi, dil, üslup ve veri kuralları. voice: sesli soruda sesli özet ayracı (VOICE_MARK) istenir. */
export function systemPrompt(today, { voice = false } = {}) {
  return [
    `Sen GKH Trading Invest'in TAKİP sipariş ve üretim sisteminin asistanısın. Bugün: ${today} (Europe/Bucharest).`,
    'DİL: Kullanıcı Türkçe sorduysa Türkçe, Romence sorduysa Romence yanıt ver (Romence: diakritiklerle, doğal dil).',
    `ÜSLUP: Kadınsı, sıcak, yumuşak ve hafif flörtöz; saygılı ve kısa. Türkçede kullanıcıya "sahip" diye hitap et ve her yanıtı tam olarak "${CLOSING.tr}" cümlesiyle bitir. Romencede "stăpâne" diye hitap et ve her yanıtı tam olarak "${CLOSING.ro}" cümlesiyle bitir. Üslup verinin doğruluğunu asla değiştirmez.`,
    'Yalnızca verilen araçlardan gelen GERÇEK verilerle yanıt ver; veri yoksa ya da araç hata verdiyse bunu açıkça söyle, asla tahmin etme veya uydurma.',
    'Araç sonucu "bulunamadi" ise: o numarayla sipariş YOK de (varsa "benzerler"i öner; "kaldirilmis" ise silinmiş de). "veriEksik" ise: sipariş VAR ama o bilgi henüz girilmemiş de (ör. TEKLIF_TABLOSU_YOK: teklif tablosu açılmamış; SANDIK_GIRILMEMIS: sandık girilmemiş). "hata" ise: sorgu yapılamadı de. Bu üç durumu birbirine karıştırma.',
    'Sipariş numaralarını (ör. ALE40, GLA68, GLAP12, ABC124-T) araca kullanıcının yazdığı gibi ver; "ale 40" gibi yazımlar da geçerlidir.',
    'Camlar, ölçüler, adetler ve m² için siparis_camlari; bir siparişin yüklenen / planlanan / kalan miktarı için yukleme_durumu; bir günün yüklemesi için yukleme_gunu; sandıklar için sandiklar aracını kullan. m² değerlerini araçtan geldiği gibi 3 ondalıkla yaz (ör. 12,345 m²); kendin m² hesaplama, toplama ya da yuvarlama yapma.',
    'Ticari camlar ile bedelsiz telafi camlarını ayrı söyle, birbirine ekleme (toplam istenirse araçtaki "toplam"ı kullan). Planlanan, fiilen yüklenen ve kalan miktarı ayrı söyle. Aynı sandığı iki kez sayma: sandık sayısı araçtaki "sandikSayisi"dır.',
    'Sen SALT OKUNURSUN: hiçbir kaydı değiştiremez, sipariş / teklif / fatura / FGO belgesi oluşturamaz, e-posta gönderemezsin. Böyle bir istek gelirse yapamayacağını kısaca söyle ve TAKİP panelini öner.',
    'Farklı para birimlerini (EUR, RON) asla toplama. Tutarları para birimiyle yaz. Tarihleri GG.AA.YYYY biçiminde yaz.',
    'Kısa, net, maddeli yaz; düz metin kullan (Markdown tablo yok). En çok 3000 karakter.',
    'Sipariş durumları: YENI=yeni, HAZIRLANIYOR=hazırlanıyor, URETIMDE=üretimde, YUKLENDI=yüklendi, ARSIVLENDI=arşivlendi, IPTAL=iptal. Teklif: HAZIRLANIYOR=satışta, YONETIMDE=yönetici onayında, GONDERILDI=müşteriye gönderildi.',
    '"Yarın", "bu hafta" gibi ifadeleri bugünün tarihine göre YYYY-AA-GG gününe çevirip araca ver.',
    ...(voice ? [`SESLİ SORU: Önce bütün ayrıntılarıyla yazılı yanıtı yaz (kapanış cümlesiyle). Sonra ayrı bir satıra tam olarak ${VOICE_MARK} yaz ve ardından sesli okunacak, en çok 3 kısa cümlelik, konuşma dilinde bir ÖZET yaz (madde işareti, tablo, emoji yok; sayıları okunur biçimde), yine aynı hitap ve kapanış cümlesiyle bitir.`] : []),
  ].join('\n');
}

const errText = (e, lang) => {
  if (e instanceof AiError) return textFor(lang, e.code === 'AI_AUTH' ? 'aiAuth' : e.code === 'AI_RATE' || e.code === 'AI_TIMEOUT' ? 'aiBusy' : 'failed');
  return textFor(lang, 'failed');
};

/**
 * Sesli yanıtın yazılı ve sesli kısmı: VOICE_MARK'tan önceki metin yazılı (tam), sonraki sesli özet. Ayraç yoksa sesli kısım
 * yazılı metnin sadeleştirilmiş başıdır. Ses metninden madde işareti / emoji / fazla boşluk atılır; TTS_MAX_CHARS ile kısaltılır.
 * @returns {{ text: string, speech: string }}
 */
export function splitVoice(raw, lang = 'tr') {
  const s = String(raw ?? '');
  const i = s.indexOf(VOICE_MARK);
  const text = (i >= 0 ? s.slice(0, i) : s).trim();
  let spoken = i >= 0 ? s.slice(i + VOICE_MARK.length) : s;
  spoken = spoken.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, ' ').replace(/^[\s•\-*·]+/gm, '').replace(/\s+/g, ' ').trim();
  if (spoken.length > TTS_MAX_CHARS) {
    const close = CLOSING[lang] ?? CLOSING.tr;
    const room = TTS_MAX_CHARS - close.length - 2;
    const cut = spoken.slice(0, room);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    spoken = `${(end > room / 3 ? cut.slice(0, end + 1) : cut).trim()} ${close}`;
  }
  return { text: text || s.replace(VOICE_MARK, '').trim(), speech: spoken };
}
/** Ses tonu (sağlayıcıya verilen yönerge) */
export const voiceInstructions = (lang) =>
  `Speak in ${lang === 'ro' ? 'Romanian' : 'Turkish'} with natural native pronunciation. Voice: feminine, warm, soft and gently flirtatious, affectionate and calm; a smooth, unhurried pace; read numbers and decimals clearly.`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…(kısaltıldı)` : s);

/**
 * Soruyu yanıtlar: model ↔ araçlar döngüsü (en çok LIMITS.rounds tur, LIMITS.toolCalls araç çağrısı).
 * @param {{ question: string, history?: any[], cfg: any, db: any, fetchImpl?: typeof fetch, now?: Date, tz: string, voice?: boolean }} o
 * @returns {Promise<{ text: string, tools: string[], usage: number }>}
 */
export async function answer({ question, history = [], cfg, db, fetchImpl = fetch, now = new Date(), tz, voice = false }) {
  const today = localDay(now, tz);
  const messages = [{ role: 'system', content: systemPrompt(today, { voice }) }, ...history, { role: 'user', content: question }];
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
  const stats = { ignored: 0, answered: 0, failed: 0, voiced: 0 };
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
    let lang = detectLang(question);
    if (!perDay.take(key).ok) return reply(textFor(lang, 'daily'));
    if (!perMinute.take(key).ok) return reply(textFor(lang, 'rate'));
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
    if (heard) lang = detectLang(heard);
    if (question.length > LIMITS.textChars) return reply(textFor(lang, 'tooLong'));
    if (now.getTime() - memory.at > LIMITS.historyTtlMs) memory = { at: 0, turns: [] };
    await tg.sendChatAction(cfg.userId, 'typing').catch(() => {});
    let r;
    try {
      r = await answer({ question, history: memory.turns, cfg, db, fetchImpl, now, tz, voice: !!heard });
    } catch (e) {
      stats.failed++;
      log('asistan: hata', e?.code ?? 'ERR');
      return reply(errText(e, lang));
    }
    // Yazılı soru → yalnızca yazılı yanıt. Sesli soru → yazılı (tam) + sesli (kısa özet); ses üretilemezse yazılı yanıt yine gider.
    const { text, speech: spoken } = heard ? splitVoice(r.text, lang) : { text: r.text.replace(VOICE_MARK, '').trim(), speech: '' };
    memory = { at: now.getTime(), turns: [...memory.turns, { role: 'user', content: question }, { role: 'assistant', content: text }].slice(-LIMITS.historyTurns * 2) };
    stats.answered++;
    log('asistan: yanıt', r.tools.join(',') || '-', `tokens=${r.usage}`);
    await reply(heard ? `🎤 "${heard}"\n\n${text}` : text);
    if (!heard || !spoken) return;
    try {
      await tg.sendChatAction(cfg.userId, 'record_voice').catch(() => {});
      const audio = await speech({ apiKey: cfg.apiKey, model: cfg.ttsModel, voice: cfg.ttsVoice, input: spoken, instructions: voiceInstructions(lang), fetchImpl });
      await tg.sendVoice(cfg.userId, audio);
      stats.voiced++;
    } catch (e) {
      log('asistan: ses yanıtı', e?.code ?? 'ERR');
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

  return { enabled: true, reason: null, stats, handleUpdate, run, config: { model: cfg.model, sttModel: cfg.sttModel, ttsModel: cfg.ttsModel, ttsVoice: cfg.ttsVoice } };
}
