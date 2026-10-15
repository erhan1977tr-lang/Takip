// TAKİP Telegram asistanı (3.84.0, karar 278): yapılandırma, yetki (tek kullanıcı, özel sohbet), parametre doğrulama, model ↔
// araç döngüsü, ses → metin, sınırlar, hata metinleri ve yapı (salt okunur, sır sızıntısı yok). Gerçek Telegram / AI
// çağrısı YOK: fetch sahte; ağa giden her istek testi düşürür.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ADDRESS, CLOSING, LIMITS, TEXT, TEXT_RO, VOICE_MARK, answer, assistantConfig, createAssistant, detectLang, isAllowed, splitVoice, systemPrompt, voiceInstructions } from '../server/assistant/bot.js';
import { TOOLS, ToolError, normalizeOrderNo, runTool, toolDefinitions, validateArgs } from '../server/assistant/tools.js';
import { splitText, telegramClient } from '../server/assistant/telegram.js';
import { TTS_MAX_CHARS, speech, transcribe } from '../server/assistant/ai.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TOKEN = '1234567890:AAH-sahteJetonDegeriTestIcinBurada_xyz12';
const KEY = 'sk-test-SAHTEanahtarTestIcin1234567890';
const USER = 555000111;
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER_ID: String(USER), OPENAI_API_KEY: KEY, APP_TIMEZONE: 'Europe/Bucharest' };
const NOW = new Date('2026-10-15T09:00:00Z');

// Gerçek ağa çıkışı engelle (her test sahte fetch verir)
globalThis.fetch = async (u) => { throw new Error(`test: gerçek ağ isteği (${String(u).slice(0, 40)})`); };

/** Sahte Telegram + AI: istekleri kaydeder; AI yanıtları sırayla verilir */
function fakeNet({ ai = [], transcript = 'GLA68 nerede', aiStatus = 200, ttsStatus = 200 } = {}) {
  const calls = [];
  const sent = [];
  const voices = [];
  let aiIndex = 0;
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ url: u, body, headers: init.headers ?? {} });
    if (u.startsWith('https://api.telegram.org/file/')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    if (u.startsWith('https://api.telegram.org/bot')) {
      const method = u.split('/').pop();
      if (method === 'sendMessage') sent.push(body.text);
      if (method === 'sendVoice') voices.push(body);
      if (method === 'getFile') return json(200, { ok: true, result: { file_path: 'voice/x.oga', file_size: 3 } });
      return json(200, { ok: true, result: method === 'getUpdates' ? [] : true });
    }
    if (u === 'https://api.openai.com/v1/audio/transcriptions') return json(200, { text: transcript });
    if (u === 'https://api.openai.com/v1/audio/speech') return ttsStatus === 200 ? { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([79, 103, 103, 83, 1, 2]).buffer } : json(ttsStatus, {});
    if (u === 'https://api.openai.com/v1/chat/completions') {
      if (aiStatus !== 200) return json(aiStatus, { error: { message: `iç hata ${KEY}` } });
      const next = ai[Math.min(aiIndex++, ai.length - 1)] ?? { content: 'Tamam.' };
      return json(200, { choices: [{ message: { role: 'assistant', content: next.content ?? null, tool_calls: next.tool_calls } }], usage: { total_tokens: 100 } });
    }
    throw new Error(`beklenmeyen adres ${u}`);
  };
  return { fetchImpl, calls, sent, voices };
}
/** Sahte veritabanı: READ ONLY işlem + siparis_ara'nın kullandığı okuma */
function fakeDb(rows = [{ orderNo: 'GLA68', title: 'Duş', status: 'URETIMDE', onHold: false, orderTypeCode: 'GLASS_ORDER', estimatedShipDate: new Date('2026-10-20T12:00:00Z'), createdAt: NOW, customer: { name: 'Glass and More' }, profile: null }]) {
  const sql = [];
  const where = [];
  const tx = {
    $executeRaw: async (strings) => { sql.push(strings.join('?')); return 0; },
    order: { findMany: async (q) => { where.push(q.where); return rows; }, count: async () => rows.length },
  };
  return { sql, where, db: { $transaction: async (fn, opts) => { assert.ok(opts?.timeout > 0); return fn(tx); } } };
}
const msg = (over = {}) => ({ update_id: 1, message: { message_id: 1, date: Math.floor(NOW.getTime() / 1000), from: { id: USER, is_bot: false }, chat: { id: USER, type: 'private' }, text: 'GLA68 nerede?', ...over } });

test('yapılandırma: üç değer de geçerliyse açık; eksik / hatalı değer botu kapatır (uygulama durmaz), neden kodunda değer yok', () => {
  assert.deepEqual(assistantConfig({}), { enabled: false, reason: 'NOT_CONFIGURED' });
  assert.equal(assistantConfig({ ...ENV, TELEGRAM_BOT_TOKEN: 'abc' }).reason, 'BAD_TOKEN');
  assert.equal(assistantConfig({ ...ENV, TELEGRAM_ALLOWED_USER_ID: '@erhan' }).reason, 'BAD_USER_ID');
  assert.equal(assistantConfig({ ...ENV, TELEGRAM_ALLOWED_USER_ID: '' }).reason, 'BAD_USER_ID');
  assert.equal(assistantConfig({ ...ENV, OPENAI_API_KEY: 'kısa' }).reason, 'BAD_API_KEY');
  const ok = assistantConfig(ENV);
  assert.equal(ok.enabled, true);
  assert.equal(ok.userId, USER);
  assert.equal(ok.model, 'gpt-4.1-mini');
  assert.equal(assistantConfig({ ...ENV, ASSISTANT_MODEL: 'gpt-4o-mini' }).model, 'gpt-4o-mini');
  assert.equal(assistantConfig({ ...ENV, ASSISTANT_MODEL: 'kötü model; adı' }).model, 'gpt-4.1-mini');
});

test('yetki: yalnızca izinli kullanıcı ve onunla ÖZEL sohbet; başka kullanıcı, grup, bot ve iletilmiş kimlik reddedilir', () => {
  const m = msg().message;
  assert.equal(isAllowed(m, USER), true);
  assert.equal(isAllowed({ ...m, from: { id: 1 } }, USER), false);
  assert.equal(isAllowed({ ...m, chat: { id: -100, type: 'group' } }, USER), false);
  assert.equal(isAllowed({ ...m, chat: { id: USER, type: 'group' } }, USER), false);
  assert.equal(isAllowed({ ...m, chat: { id: 9, type: 'private' } }, USER), false);
  assert.equal(isAllowed({ ...m, from: { id: USER, is_bot: true } }, USER), false);
  assert.equal(isAllowed(null, USER), false);
  assert.equal(isAllowed({ ...m, from: { id: String(USER) } }, USER), false, 'kimlik sayı olmalı');
});

test('parametre doğrulama: bilinmeyen alan, tür, uzunluk, desen, aralık ve geçersiz tarih reddedilir', () => {
  const F = TOOLS.siparis_ara.fields;
  assert.deepEqual(validateArgs(F, { metin: ' GLA ', adet: 5, sadece_aktif: true }), { metin: 'GLA', adet: 5, sadece_aktif: true });
  for (const bad of [{ sql: 'DROP' }, { metin: 'x'.repeat(41) }, { adet: 21 }, { adet: 0 }, { durum: 'SILINDI' }, { sadece_aktif: 'true' }, { metin: 5 }, null, [], 'x']) {
    assert.throws(() => validateArgs(F, bad), ToolError, JSON.stringify(bad));
  }
  const D = TOOLS.yukleme_plani.fields;
  assert.deepEqual(validateArgs(D, { baslangic: '2026-10-16' }), { baslangic: '2026-10-16' });
  for (const bad of ['2026-02-30', '16.10.2026', '2026-10-16; DROP', '2026-13-01']) assert.throws(() => validateArgs(D, { baslangic: bad }), ToolError, bad);
  assert.throws(() => validateArgs(TOOLS.siparis_detay.fields, { siparis_no: "GLA68' OR 1=1" }), ToolError);
  // Modelin gördüğü şemalar: ek alan kapalı
  for (const t of toolDefinitions()) assert.equal(t.function.parameters.additionalProperties, false, t.function.name);
  assert.deepEqual(toolDefinitions().map((t) => t.function.name).sort(), Object.keys(TOOLS).sort());
});

test('araç: doğrulanmış argümanla READ ONLY işlemde çalışır; bilinmeyen araç / hatalı argüman / sorgu hatası sabit kod', async () => {
  const f = fakeDb();
  const ro = (fn) => f.db.$transaction(async (tx) => { await tx.$executeRaw(['SET TRANSACTION READ ONLY']); return fn(tx); }, { timeout: 1 });
  const r = await runTool(ro, 'siparis_ara', '{"metin":"GLA","sadece_aktif":true}', { tz: 'Europe/Bucharest', now: NOW });
  assert.equal(r.toplam, 1);
  assert.equal(r.siparisler[0].no, 'GLA68');
  assert.equal(r.siparisler[0].tahminiYukleme, '2026-10-20');
  assert.deepEqual(f.where[0].status, { in: ['YENI', 'HAZIRLANIYOR', 'URETIMDE', 'YUKLENDI'] });
  assert.deepEqual(await runTool(ro, 'veri_sil', '{}', {}), { hata: 'UNKNOWN_TOOL' });
  assert.deepEqual(await runTool(ro, 'siparis_ara', '{"sql":"x"}', {}), { hata: 'INVALID_ARGS' });
  assert.deepEqual(await runTool(ro, 'siparis_ara', 'bozuk json', {}), { hata: 'INVALID_ARGS' });
  assert.deepEqual(await runTool(ro, '__proto__', '{}', {}), { hata: 'UNKNOWN_TOOL' });
  const boom = async () => { throw new Error('connection refused at 10.0.0.1 password=x'); };
  assert.deepEqual(await runTool(boom, 'genel_ozet', '{}', {}), { hata: 'QUERY_FAILED' });
});

test('yanıt döngüsü: model aracı çağırır → araç sonucu modele döner → Türkçe yanıt; READ ONLY işlem açılır', async () => {
  const f = fakeDb();
  const net = fakeNet({ ai: [
    { tool_calls: [{ id: 't1', type: 'function', function: { name: 'siparis_ara', arguments: '{"metin":"GLA68"}' } }] },
    { content: 'GLA68 üretimde; tahmini yükleme 20.10.2026.' },
  ] });
  const r = await answer({ question: 'GLA68 nerede?', cfg: assistantConfig(ENV), db: f.db, fetchImpl: net.fetchImpl, now: NOW, tz: 'Europe/Bucharest' });
  assert.equal(r.text, 'GLA68 üretimde; tahmini yükleme 20.10.2026.');
  assert.deepEqual(r.tools, ['siparis_ara']);
  assert.ok(f.sql.some((s) => /SET TRANSACTION READ ONLY/.test(s)), 'salt okunur işlem');
  const ai = net.calls.filter((c) => c.url.endsWith('/chat/completions'));
  assert.equal(ai.length, 2);
  assert.equal(ai[0].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(ai[0].body.model, 'gpt-4.1-mini');
  assert.ok(ai[0].body.max_completion_tokens <= 1000);
  assert.match(ai[0].body.messages[0].content, /SALT OKUNUR/);
  assert.match(ai[0].body.messages[0].content, /2026-10-15/);
  const toolMsg = ai[1].body.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /Glass and More/);
});

test('yanıt döngüsü: tur ve araç çağrısı sınırlı (sonsuz araç çağrısı kesilir, son turda araç verilmez)', async () => {
  const f = fakeDb();
  const loop = { tool_calls: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, type: 'function', function: { name: 'siparis_ara', arguments: '{}' } })) };
  const net = fakeNet({ ai: [loop, loop, loop, { content: 'son' }] });
  const r = await answer({ question: 'x', cfg: assistantConfig(ENV), db: f.db, fetchImpl: net.fetchImpl, now: NOW, tz: 'UTC' });
  const ai = net.calls.filter((c) => c.url.endsWith('/chat/completions'));
  assert.equal(ai.length, LIMITS.rounds);
  assert.equal(ai.at(-1).body.tools, undefined, 'son turda araç yok');
  assert.ok(r.tools.length <= LIMITS.toolCalls);
  assert.equal(r.text, 'son');
});

test('bot: izinsiz kullanıcı / grup → HİÇBİR istek yok (yanıt, AI çağrısı, veritabanı yok)', async () => {
  const net = fakeNet();
  const f = fakeDb();
  const bot = createAssistant({ db: f.db, env: ENV, fetchImpl: net.fetchImpl, clock: () => NOW });
  await bot.handleUpdate(msg({ from: { id: 42 }, chat: { id: 42, type: 'private' } }));
  await bot.handleUpdate(msg({ chat: { id: -1001, type: 'supergroup' } }));
  await bot.handleUpdate({ update_id: 3, edited_message: msg().message });
  assert.equal(net.calls.length, 0);
  assert.equal(f.sql.length, 0);
  assert.equal(bot.stats.ignored, 3);
});

test('bot: yazılı soru → yanıt; /yardim; /sifirla; eski ileti yok sayılır; sınır aşımı kibar metin', async () => {
  const net = fakeNet({ ai: [{ content: 'Yanıt' }] });
  const logs = [];
  const bot = createAssistant({ db: fakeDb().db, env: ENV, fetchImpl: net.fetchImpl, clock: () => NOW, log: (...a) => logs.push(a.join(' ')) });
  await bot.handleUpdate(msg());
  assert.deepEqual(net.sent, ['Yanıt']);
  await bot.handleUpdate(msg({ text: '/yardim' }));
  assert.equal(net.sent.at(-1), TEXT.help);
  await bot.handleUpdate(msg({ text: '/sifirla' }));
  assert.equal(net.sent.at(-1), TEXT.reset);
  const before = net.sent.length;
  await bot.handleUpdate(msg({ date: Math.floor(NOW.getTime() / 1000) - 3600 }));
  assert.equal(net.sent.length, before, 'yeniden başlatmadan önceki eski ileti yanıtlanmaz');
  await bot.handleUpdate(msg({ text: 'x'.repeat(1001) }));
  assert.equal(net.sent.at(-1), TEXT.tooLong);
  for (let i = 0; i < LIMITS.perMinute + 2; i++) await bot.handleUpdate(msg());
  assert.equal(net.sent.at(-1), TEXT.rate);
  // Günlükte soru, yanıt, jeton, anahtar, kullanıcı kimliği yok
  const all = logs.join('\n');
  for (const secret of [TOKEN, KEY, String(USER), 'GLA68 nerede', 'Yanıt']) assert.ok(!all.includes(secret), secret);
});

test('bot: sesli mesaj → dosya indirilir → Türkçe metne çevrilir → yanıtın başında duyulan metin; uzun ses reddedilir', async () => {
  const net = fakeNet({ ai: [{ content: 'Üretimde.' }], transcript: 'GLA68 ne durumda' });
  const bot = createAssistant({ db: fakeDb().db, env: ENV, fetchImpl: net.fetchImpl, clock: () => NOW });
  await bot.handleUpdate(msg({ text: undefined, voice: { file_id: 'F1', duration: 5, file_size: 3 } }));
  assert.equal(net.sent.at(-1), '🎤 "GLA68 ne durumda"\n\nÜretimde.');
  const stt = net.calls.find((c) => c.url.endsWith('/audio/transcriptions'));
  assert.ok(stt.body instanceof FormData);
  assert.equal(stt.body.get('language'), null, 'dil sabitlenmez: Türkçe ve Romence ses');
  assert.equal(stt.body.get('model'), 'gpt-4o-mini-transcribe');
  await bot.handleUpdate(msg({ text: undefined, voice: { file_id: 'F2', duration: 500 } }));
  assert.equal(net.sent.at(-1), TEXT.voiceTooLong);
  await bot.handleUpdate(msg({ text: undefined, photo: [{}] }));
  assert.equal(net.sent.at(-1), TEXT.unsupported);
});

test('bot: AI hatası → sabit Türkçe metin; sağlayıcının ham hatası / anahtar kullanıcıya gitmez', async () => {
  for (const [status, text] of [[401, TEXT.aiAuth], [429, TEXT.aiBusy], [500, TEXT.failed]]) {
    const net = fakeNet({ aiStatus: status });
    const bot = createAssistant({ db: fakeDb().db, env: ENV, fetchImpl: net.fetchImpl, clock: () => NOW });
    await bot.handleUpdate(msg());
    assert.equal(net.sent.at(-1), text, String(status));
    assert.ok(!net.sent.join('').includes(KEY));
  }
});

test('Telegram istemcisi: hata kodları jeton / adres içermez; uzun metin parçalanır', async () => {
  const tg = telegramClient({ token: TOKEN, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false }) }) });
  await assert.rejects(tg.getMe(), (e) => e.code === 'TG_AUTH' && !String(e.message).includes(TOKEN) && !String(e.stack).includes(TOKEN));
  const net = await telegramClient({ token: TOKEN, fetchImpl: async () => { throw new Error(`getaddrinfo ${TOKEN}`); } });
  await assert.rejects(net.getMe(), (e) => e.code === 'TG_FAILED' && !String(e.message).includes(TOKEN));
  const parts = splitText(`${'a'.repeat(3990)}\n${'b'.repeat(3000)}`);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 4000));
  await assert.rejects(transcribe({ apiKey: KEY, model: 'm', audio: Buffer.from('x'), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ text: '' }) }) }), (e) => e.code === 'AI_FAILED');
});

test('sistem yönergesi: salt okunur, uydurma yok, para birimi toplanmaz, bugünün tarihi', () => {
  const p = systemPrompt('2026-10-15');
  for (const s of ['SALT OKUNUR', 'uydurma', 'asla toplama', '2026-10-15']) assert.ok(p.includes(s), s);
});

test('yapı: asistan yalnızca okur — yazma yöntemi, ham SQL, e-posta / bildirim / FGO / iş akışı modülü yok', () => {
  const dir = path.join(ROOT, 'server', 'assistant');
  for (const f of fs.readdirSync(dir)) {
    const s = read(path.join('server', 'assistant', f));
    assert.doesNotMatch(s, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/, `${f}: yazma`);
    assert.doesNotMatch(s, /\$(executeRawUnsafe|queryRawUnsafe|queryRaw)\b/, `${f}: ham SQL`);
    assert.doesNotMatch(s, /from '\.\.\/(mail|notifications|integrations|orders\/transitions|orders\/create|glass|finance|documents)\b/, `${f}: yasak modül`);
  }
  // Tek SQL: işlemi salt okunur yapan komutlar
  const ro = read('server/assistant/readonly.js');
  assert.deepEqual([...ro.matchAll(/\$executeRaw`([^`]*)`/g)].map((m) => m[1]), ['SET TRANSACTION READ ONLY', 'SET LOCAL statement_timeout = 8000']);
  // Araçlar yalnızca okuma yöntemleri kullanır
  const tools = read('server/assistant/tools.js');
  const methods = new Set([...tools.matchAll(/tx\.\w+\.(\w+)\(/g)].map((m) => m[1]));
  for (const m of methods) assert.ok(['findMany', 'findFirst', 'findUnique', 'count', 'groupBy', 'aggregate'].includes(m), m);
  // İşçi asistanı yalnızca sürekli çalışmada başlatır; yapılandırma getEnv'den (ham process.env değil)
  const worker = read('scripts/worker.mjs');
  assert.match(worker, /if \(!once\) \{\n  const assistant = createAssistant\(\{ db, env, log \}\);/);
  assert.doesNotMatch(worker, /process\.env\.(TELEGRAM|OPENAI)/);
  // Kapanışta bekleme zamanlayıcısı süreci açık tutmaz (worker --once testleri hemen çıkmalı)
  assert.match(worker, /setTimeout\(r, 30_000\)\.unref\(\)/);
  // Kullandığı mevcut servisler salt okunur (yazma yapmaz)
  for (const fn of ['receivables', 'listDocuments', 'stockLevels', 'reservedLevels', 'supplierAccounts', 'uninvoicedLoadings']) assert.match(tools, new RegExp(`\\b${fn}\\b`));
});

// ---------------------------------------------------------------- 3.85.0 (karar 280)
test('3.85: sipariş numarası biçimi — boşluk, küçük harf, Türkçe İ / ı', () => {
  assert.equal(normalizeOrderNo('ale 40'), 'ALE40');
  assert.equal(normalizeOrderNo(' Gla68 '), 'GLA68');
  assert.equal(normalizeOrderNo('glı 68'), 'GLI68');
  assert.equal(normalizeOrderNo('ALE-40'), 'ALE-40');
  assert.deepEqual(validateArgs(TOOLS.siparis_camlari.fields, { siparis_no: 'ale 40' }), { siparis_no: 'ale 40' });
  for (const bad of ["ALE40' OR 1=1", 'ALE40;DROP', 'x'.repeat(31)]) assert.throws(() => validateArgs(TOOLS.siparis_camlari.fields, { siparis_no: bad }), ToolError, bad);
  for (const t of ['siparis_camlari', 'yukleme_durumu', 'yukleme_gunu', 'sandiklar']) assert.ok(Object.hasOwn(TOOLS, t), t);
});

test('3.85: dil algılama — Türkçe varsayılan; Romence harf ya da sözcük → ro', () => {
  assert.equal(detectLang('GLA68 ne durumda?'), 'tr');
  assert.equal(detectLang('Yarınki yükleme'), 'tr');
  assert.equal(detectLang('Câte lăzi are comanda ALE40?'), 'ro');
  assert.equal(detectLang('Care este situatia comenzii GLA68?'), 'ro');
  assert.equal(detectLang('ALE40'), 'tr');
  assert.equal(TEXT_RO.failed.length > 0 && TEXT_RO.failed !== TEXT.failed, true);
});

test('3.85 / 3.87: sistem yönergesi — dil, "Boss" hitabı ve doğal kapanış; 3 ondalık m²; bulunamadı ≠ veri eksik; ses ayracı yalnızca sesli soruda', () => {
  const p = systemPrompt('2026-10-15');
  for (const s of ['Romence', CLOSING.tr, CLOSING.ro, '"Boss"', 'mekanik', '3 ondalık', 'bulunamadi', 'veriEksik', 'bedelsiz telafi', 'sandikSayisi', 'SALT OKUNUR']) assert.ok(p.includes(s), s);
  // 3.87.0: eski hitaplar kaldırıldı; kapanışlar ürün sahibinin metni
  assert.equal(ADDRESS, 'Boss');
  assert.deepEqual({ ...CLOSING }, { tr: 'Başka bir emrin olur mu, Boss?', ro: 'Mai ai vreo solicitare, Boss?' });
  for (const prompt of [p, systemPrompt('2026-10-15', { voice: true })]) {
    for (const old of ['sahip', 'Sahip', 'stăpâne', 'poruncă']) assert.ok(!prompt.includes(old), old);
  }
  const src = fs.readFileSync(new URL('../server/assistant/bot.js', import.meta.url), 'utf8');
  for (const old of ['sahip', 'stăpâne', 'poruncă']) assert.ok(!src.includes(old), `bot.js: ${old}`);
  assert.ok(!p.includes(VOICE_MARK), 'yazılı soruda ses ayracı istenmez');
  assert.ok(systemPrompt('2026-10-15', { voice: true }).includes(VOICE_MARK));
});

test('3.85 / 3.87: sesli yanıtın bölünmesi — yazılı tam metin, sesli kısa özet; ayraç yoksa metnin başı; uzun özet son tam cümlede kesilir, kapanış mekanik eklenmez', () => {
  const r = splitVoice(`• ALE40: 10 cam, 12,343 m²\n• Yüklenen 6 cam\n${CLOSING.tr}\n${VOICE_MARK}\nBoss, ALE40'ta on cam var. ${CLOSING.tr}`, 'tr');
  assert.ok(r.text.startsWith('• ALE40') && r.text.endsWith(CLOSING.tr) && !r.text.includes(VOICE_MARK));
  assert.equal(r.speech, `Boss, ALE40'ta on cam var. ${CLOSING.tr}`);
  assert.equal(splitVoice('Üretimde.').speech, 'Üretimde.');
  const long = splitVoice(`x\n${VOICE_MARK}\n${'Uzun bir cümle burada. '.repeat(80)}`, 'ro');
  assert.ok(long.speech.length <= TTS_MAX_CHARS && long.speech.endsWith('burada.') && !long.speech.includes(CLOSING.ro));
  assert.match(voiceInstructions('ro'), /Romanian/);
  assert.match(voiceInstructions('tr'), /Turkish/);
  assert.match(voiceInstructions('tr'), /feminine, warm, soft and gently flirtatious/);
});

test('3.85: yapılandırma — ses modeli gpt-4o-mini-tts, ses coral; geçersiz ses adı varsayılana döner', () => {
  const c = assistantConfig(ENV);
  assert.equal(c.ttsModel, 'gpt-4o-mini-tts');
  assert.equal(c.ttsVoice, 'coral');
  assert.equal(assistantConfig({ ...ENV, ASSISTANT_TTS_VOICE: 'nova' }).ttsVoice, 'nova');
  assert.equal(assistantConfig({ ...ENV, ASSISTANT_TTS_VOICE: '../x' }).ttsVoice, 'coral');
});

test('3.85: yazılı soru → YALNIZCA yazılı yanıt (ses üretilmez, sesli mesaj gönderilmez)', async () => {
  const net = fakeNet({ ai: [{ content: `GLA68 üretimde. ${CLOSING.tr}` }] });
  const bot = createAssistant({ db: fakeDb().db, env: ENV, fetchImpl: net.fetchImpl, clock: () => NOW });
  await bot.handleUpdate(msg());
  assert.deepEqual(net.sent, [`GLA68 üretimde. ${CLOSING.tr}`]);
  assert.equal(net.calls.filter((c) => c.url.endsWith('/audio/speech')).length, 0);
  assert.equal(net.voices.length, 0);
  const ai = net.calls.find((c) => c.url.endsWith('/chat/completions'));
  assert.ok(!ai.body.messages[0].content.includes(VOICE_MARK));
});

test('3.85: sesli soru → yazılı tam yanıt + sesli kısa özet (gpt-4o-mini-tts, coral, OGG); Romence soruda Romence ses', async () => {
  const net = fakeNet({ ai: [{ content: `Ayrıntılı yanıt\n${CLOSING.tr}\n${VOICE_MARK}\nKısa özet. ${CLOSING.tr}` }], transcript: 'ALE40 ne kadar yüklendi' });
  const bot = createAssistant({ db: fakeDb().db, env: ENV, fetchImpl: net.fetchImpl, clock: () => NOW });
  await bot.handleUpdate(msg({ text: undefined, voice: { file_id: 'F1', duration: 5, file_size: 3 } }));
  assert.deepEqual(net.sent, [`🎤 "ALE40 ne kadar yüklendi"\n\nAyrıntılı yanıt\n${CLOSING.tr}`]);
  const tts = net.calls.filter((c) => c.url.endsWith('/audio/speech'));
  assert.equal(tts.length, 1);
  assert.equal(tts[0].body.model, 'gpt-4o-mini-tts');
  assert.equal(tts[0].body.voice, 'coral');
  assert.equal(tts[0].body.response_format, 'opus');
  assert.equal(tts[0].body.input, `Kısa özet. ${CLOSING.tr}`);
  assert.match(tts[0].body.instructions, /Turkish/);
  assert.equal(net.voices.length, 1);
  assert.ok(net.voices[0] instanceof FormData);
  assert.equal(net.voices[0].get('chat_id'), String(USER));
  assert.equal(net.voices[0].get('voice').type, 'audio/ogg');
  const ai = net.calls.find((c) => c.url.endsWith('/chat/completions'));
  assert.ok(ai.body.messages[0].content.includes(VOICE_MARK), 'sesli soruda ses özeti istenir');
  assert.equal(bot.stats.voiced, 1);

  const ro = fakeNet({ ai: [{ content: `Răspuns\n${VOICE_MARK}\nRezumat. ${CLOSING.ro}` }], transcript: 'Câte lăzi are comanda ALE40?' });
  const botRo = createAssistant({ db: fakeDb().db, env: ENV, fetchImpl: ro.fetchImpl, clock: () => NOW });
  await botRo.handleUpdate(msg({ text: undefined, voice: { file_id: 'F2', duration: 4 } }));
  assert.match(ro.calls.find((c) => c.url.endsWith('/audio/speech')).body.instructions, /Romanian/);
  assert.equal(ro.voices.length, 1);
});

test('3.85: ses üretilemezse yazılı yanıt yine gider; hata kullanıcıya ham gitmez; Romence soruda Romence hata metni', async () => {
  const net = fakeNet({ ai: [{ content: `Yanıt\n${VOICE_MARK}\nÖzet.` }], ttsStatus: 500 });
  const logs = [];
  const bot = createAssistant({ db: fakeDb().db, env: ENV, fetchImpl: net.fetchImpl, clock: () => NOW, log: (...a) => logs.push(a.join(' ')) });
  await bot.handleUpdate(msg({ text: undefined, voice: { file_id: 'F1', duration: 5 } }));
  assert.equal(net.sent.length, 1);
  assert.ok(net.sent[0].endsWith('Yanıt'));
  assert.equal(net.voices.length, 0);
  assert.ok(logs.some((l) => l === 'asistan: ses yanıtı AI_FAILED'));
  const bad = fakeNet({ aiStatus: 500 });
  const botRo = createAssistant({ db: fakeDb().db, env: ENV, fetchImpl: bad.fetchImpl, clock: () => NOW });
  await botRo.handleUpdate(msg({ text: 'Câte lăzi are comanda ALE40?' }));
  assert.equal(bad.sent.at(-1), TEXT_RO.failed);
});

test('3.85: TTS istemcisi — boş metin / boş ya da çok büyük ses reddedilir; metin kısaltılır', async () => {
  await assert.rejects(speech({ apiKey: KEY, model: 'm', voice: 'coral', input: '  ', fetchImpl: async () => { throw new Error('çağrılmamalı'); } }), (e) => e.code === 'AI_FAILED');
  await assert.rejects(speech({ apiKey: KEY, model: 'm', voice: 'coral', input: 'x', fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }) }), (e) => e.code === 'AI_FAILED');
  await assert.rejects(speech({ apiKey: KEY, model: 'm', voice: 'coral', input: 'x', fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(6 * 1024 * 1024) }) }), (e) => e.code === 'AI_FAILED');
  let sentBody;
  const buf = await speech({ apiKey: KEY, model: 'm', voice: 'coral', input: 'y'.repeat(5000), fetchImpl: async (u, init) => { sentBody = JSON.parse(init.body); assert.equal(init.redirect, 'error'); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer }; } });
  assert.equal(buf.length, 1);
  assert.equal(sentBody.input.length, TTS_MAX_CHARS);
});
