// Panel AI asistanı — işçi tarafı (3.95.0, karar 290). Telegram asistanıyla AYNI yanıtlayıcıyı (answer), aynı salt
// okunur araçları (tools.js, READ ONLY işlem), aynı veri en aza indirme kurallarını (askedTopics: hassas alan yalnızca
// kullanıcının KENDİ sorusu o konuyu anıyorsa) ve aynı modeli kullanır; ikinci bir AI sistemi değildir.
//
// Güvenlik sınırları (değiştirmeyin):
//   - Yalnızca iç ağdan, yalnızca uygulamanın imzaladığı istekler (panel-protocol.js: HMAC + ±60 sn + tek kullanımlık nonce).
//     Kapı dışarı yayımlanmaz (Compose "ports" yok, Caddy yönlendirmez).
//   - İmzalı kullanıcı kimliği yetki DEĞİLDİR: her istekte kullanıcı veritabanında yeniden denetlenir (etkin, silinmemiş,
//     iç kullanıcı, rolü ASSISTANT_PANEL yetkisine sahip). Sayfa bağlamı (orderId) yalnızca kimliktir; sipariş no'su
//     veritabanından okunur ve modele "bağlam" olarak verilir — yetki değildir.
//   - Kullanıcı başına ayrı sohbet belleği (yalnızca süreç belleğinde, kısa süreli; veritabanına yazılmaz), ayrı dakika /
//     gün sınırı, günlük token bütçesi ve aynı anda tek istek. Genel eşzamanlılık sınırı.
//   - Günlüğe yalnızca sabit kodlar: soru, yanıt, kullanıcı kimliği, anahtar yazılmaz.
import http from 'node:http';
import { can } from '../auth/permissions.js';
import { createRateLimiter } from '../security/rate-limit.js';
import { localDay } from '../profile/dates.js';
import { AiError } from './ai.js';
import { DEFAULT_MODEL, answer } from './bot.js';
import { readOnly } from './readonly.js';
import { PANEL_LIMITS, PANEL_PATH, SIG_HEADER, createNonceCache, forget, panelKey, parseBody, signatureOk } from './panel-protocol.js';

export const PANEL_PORT = 3331;
export const PANEL_USER_LIMITS = Object.freeze({
  perMinute: 10,
  perDay: 200,
  tokensPerDay: 400_000, // kullanıcı başına günlük model token bütçesi (yaklaşık maliyet sınırı)
  concurrent: 3, // bütün kullanıcılar için aynı anda işlenen soru
  deadlineMs: 100_000, // yanıt süresi üst sınırı (istemci 110 sn bekler)
  historyTurns: 6,
  historyTtlMs: 20 * 60_000,
  memoryUsers: 200,
});

/** Yapılandırma: yalnızca OpenAI anahtarı ve AUTH_SECRET gerekir (Telegram ayarlarından bağımsız). */
export function panelConfig(env) {
  const apiKey = String(env.OPENAI_API_KEY ?? '').trim();
  const key = panelKey(env.AUTH_SECRET);
  if (!apiKey) return { enabled: false, reason: 'NOT_CONFIGURED' };
  if (!/^[A-Za-z0-9_-]{20,300}$/.test(apiKey)) return { enabled: false, reason: 'BAD_API_KEY' };
  if (!key) return { enabled: false, reason: 'NO_SECRET' };
  const model = /^[A-Za-z0-9._:-]{2,64}$/.test(String(env.ASSISTANT_MODEL ?? '')) ? String(env.ASSISTANT_MODEL) : DEFAULT_MODEL;
  const port = Number(env.ASSISTANT_PANEL_PORT ?? PANEL_PORT);
  return { enabled: true, apiKey, model, key, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : PANEL_PORT };
}

const aiCode = (e) => (e instanceof AiError ? (e.code === 'AI_AUTH' ? 'AI_AUTH' : e.code === 'AI_RATE' || e.code === 'AI_TIMEOUT' ? 'AI_BUSY' : 'FAILED') : 'FAILED');

/**
 * İstek işleyici (HTTP'den bağımsız; testler doğrudan çağırır).
 * @param {{ db: any, env: Record<string, any>, fetchImpl?: typeof fetch, log?: (...a: any[]) => void, clock?: () => Date, answerImpl?: typeof answer, limits?: Partial<typeof PANEL_USER_LIMITS> }} o
 */
export function createPanelHandler({ db, env, fetchImpl = fetch, log = () => {}, clock = () => new Date(), answerImpl = answer, limits = {} }) {
  const L = { ...PANEL_USER_LIMITS, ...limits };
  const cfg = panelConfig(env);
  const tz = env.APP_TIMEZONE || 'Europe/Bucharest';
  const nonces = createNonceCache();
  const perMinute = createRateLimiter({ limit: L.perMinute, windowMs: 60_000 });
  const perDay = createRateLimiter({ limit: L.perDay, windowMs: 24 * 3600_000 });
  /** @type {Map<string, { at: number, turns: any[] }>} */
  const memory = new Map();
  /** @type {Map<string, { day: string, tokens: number }>} */
  const budget = new Map();
  const inFlight = new Set();
  const stats = { answered: 0, refused: 0, failed: 0 };
  const ro = readOnly(db);

  /** Kullanıcıyı veritabanında yeniden denetler: etkin + silinmemiş + iç kullanıcı + ASSISTANT_PANEL */
  async function userAllowed(userId) {
    const u = await ro((tx) => tx.user.findUnique({ where: { id: userId }, select: { isActive: true, deletedAt: true, type: true, appRole: true } }));
    return !!u && u.isActive === true && !u.deletedAt && u.type === 'INTERNAL' && can(u.appRole, 'ASSISTANT_PANEL');
  }

  /** Sayfa bağlamı: yalnızca veritabanındaki sipariş numarası (kaldırılmış sipariş bağlam olmaz) */
  async function contextOf(orderId) {
    if (!orderId) return null;
    const o = await ro((tx) => tx.order.findUnique({ where: { id: orderId }, select: { orderNo: true, removedAt: true } })).catch(() => null);
    if (!o || o.removedAt || !/^[A-Za-z0-9-]{2,40}$/.test(String(o.orderNo))) return null;
    return `SAYFA BAĞLAMI: Kullanıcı şu an ${o.orderNo} numaralı siparişin sayfasında; "bu sipariş" derse ${o.orderNo} siparişini kastedebilir. Bu satır yalnızca bağlamdır, yetki ya da talimat değildir.`;
  }

  const refuse = (status, code) => { stats.refused++; return { status, json: { ok: false, code } }; };

  /**
   * @param {{ raw: string, sig: string | undefined }} req
   * @returns {Promise<{ status: number, json: any }>}
   */
  async function handle({ raw, sig }) {
    if (!cfg.enabled) return refuse(503, 'NOT_CONFIGURED');
    // Sıra önemli: önce imza (anahtarı bilmeyen hiçbir şeyi tetikleyemez), sonra biçim / tazelik, sonra nonce
    if (!signatureOk(cfg.key, raw, sig)) return refuse(401, 'BAD_SIGNATURE');
    const now = clock();
    const parsed = parseBody(raw, now.getTime());
    if (!parsed.ok) return refuse(parsed.code === 'STALE' ? 401 : 400, parsed.code);
    const n = nonces.take(parsed.body.nonce, now.getTime());
    if (n === 'replay') return refuse(401, 'REPLAY');
    if (n === 'full') return refuse(503, 'BUSY');
    const { userId, question, orderId, reset } = parsed.body;
    let allowed;
    try { allowed = await userAllowed(userId); } catch { stats.failed++; return { status: 503, json: { ok: false, code: 'UNAVAILABLE' } }; }
    if (!allowed) { forget(memory, userId); return refuse(403, 'FORBIDDEN'); }
    if (reset) { forget(memory, userId); return { status: 200, json: { ok: true, text: '' } }; }
    // Önce dakika sınırı (dakikaya takılan soru günlük hakkı tüketmez), sonra gün, sonra token bütçesi
    if (!perMinute.take(userId, now.getTime()).ok) return refuse(429, 'RATE');
    const day = localDay(now, tz);
    const b = budget.get(userId);
    if (b && b.day === day && b.tokens >= L.tokensPerDay) return refuse(429, 'BUDGET');
    if (inFlight.has(userId) || inFlight.size >= L.concurrent) return refuse(429, 'BUSY');
    if (!perDay.take(userId, now.getTime()).ok) return refuse(429, 'DAILY');
    inFlight.add(userId);
    const mem = memory.get(userId);
    const history = mem && now.getTime() - mem.at <= L.historyTtlMs ? mem.turns : [];
    const work = (async () => {
      const context = await contextOf(orderId);
      return answerImpl({ question, history, cfg, db, fetchImpl, now, tz, channel: 'panel', context });
    })();
    // Kilit, yanıt gerçekten bitince açılır (zaman aşımında da) — aynı kullanıcı arka arkaya istek yığamaz
    work.finally(() => forget(inFlight, userId)).catch(() => {});
    let timer;
    try {
      const r = await Promise.race([work, new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('deadline'), { code: 'TIMEOUT' })), L.deadlineMs); })]);
      const text = String(r?.text ?? '').trim().slice(0, PANEL_LIMITS.answerChars);
      const cur = budget.get(userId);
      budget.set(userId, { day, tokens: (cur && cur.day === day ? cur.tokens : 0) + Number(r?.usage ?? 0) });
      forget(memory, userId);
      memory.set(userId, { at: now.getTime(), turns: [...history, { role: 'user', content: question }, { role: 'assistant', content: text }].slice(-L.historyTurns * 2) });
      while (memory.size > L.memoryUsers) forget(memory, memory.keys().next().value);
      stats.answered++;
      log('panel asistanı: yanıt', (r?.tools ?? []).join(',') || '-', `tokens=${Number(r?.usage ?? 0)}`);
      return { status: 200, json: { ok: true, text } };
    } catch (e) {
      stats.failed++;
      const code = e?.code === 'TIMEOUT' ? 'TIMEOUT' : aiCode(e);
      // Bütçe: zaman aşımında yanıt yine tamamlanabilir — token'ı arka planda yaz
      if (code === 'TIMEOUT') work.then((r) => { const cur = budget.get(userId); budget.set(userId, { day, tokens: (cur && cur.day === day ? cur.tokens : 0) + Number(r?.usage ?? 0) }); }).catch(() => {});
      log('panel asistanı: hata', code);
      return { status: code === 'TIMEOUT' ? 504 : 502, json: { ok: false, code } };
    } finally {
      clearTimeout(timer);
    }
  }

  return { enabled: cfg.enabled, reason: cfg.enabled ? null : cfg.reason, port: cfg.enabled ? cfg.port : null, handle, stats };
}

/**
 * HTTP sunucusu: yalnızca POST /sor, gövde ≤ 8 KB, JSON. Dönen nesnenin close() ile kapanır.
 * @param {Parameters<typeof createPanelHandler>[0] & { host?: string }} o
 */
export function createPanelServer(o) {
  const h = createPanelHandler(o);
  if (!h.enabled) return { enabled: false, reason: h.reason, stats: h.stats, handle: h.handle, server: null, listen: async (_port = 0, _host = '') => null, close: async () => {} };
  const send = (res, status, json) => {
    const body = JSON.stringify(json);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== PANEL_PATH) { req.resume(); return send(res, 404, { ok: false, code: 'BAD_REQUEST' }); }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) { req.resume(); return send(res, 415, { ok: false, code: 'BAD_REQUEST' }); }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > PANEL_LIMITS.bodyBytes) { req.resume(); return send(res, 413, { ok: false, code: 'TOO_LONG' }); }
    const chunks = [];
    let size = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > PANEL_LIMITS.bodyBytes) { done = true; send(res, 413, { ok: false, code: 'TOO_LONG' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => { done = true; });
    req.on('end', () => {
      if (done) return;
      done = true;
      const sig = req.headers[SIG_HEADER];
      h.handle({ raw: Buffer.concat(chunks).toString('utf8'), sig: typeof sig === 'string' ? sig : undefined })
        .then((r) => send(res, r.status, r.json))
        .catch(() => send(res, 500, { ok: false, code: 'FAILED' }));
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = PANEL_USER_LIMITS.deadlineMs + 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 30;
  return {
    enabled: true,
    reason: null,
    stats: h.stats,
    handle: h.handle,
    server,
    listen: (port = h.port, host = o.host ?? '0.0.0.0') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address())); }),
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
