// Panel AI asistanı (3.95.0, karar 290): iç protokol (imza, tazelik, tekrar), işçide yetkinin YENİDEN denetimi, kullanıcı
// yalıtımı, sınırlar, zaman aşımı, HTTP kapısı, istemci, güvenli yanıt ayrıştırma ve yapı kuralları. Gerçek AI / ağ yok:
// answerImpl ya da fetchImpl sahte; HTTP denemeleri yalnızca 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_LIMITS, PANEL_PATH, SIG_HEADER, buildBody, createNonceCache, panelKey, parseBody, signBody, signatureOk } from '../server/assistant/panel-protocol.js';
import { PANEL_USER_LIMITS, createPanelHandler, createPanelServer, panelConfig } from '../server/assistant/panel.js';
import { askPanel } from '../server/assistant/panel-client.js';
import { MD_LIMITS, orderHref, parseAnswer } from '../server/assistant/markdown.js';
import { systemPrompt } from '../server/assistant/bot.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SECRET = 's'.repeat(48);
const KEY = panelKey(SECRET);
const ENV = { OPENAI_API_KEY: 'sk-test_' + 'a'.repeat(30), AUTH_SECRET: SECRET, APP_TIMEZONE: 'Europe/Bucharest' };
const NOW = new Date('2026-10-17T09:00:00Z');
let seq = 0;
const nonce = () => `nonce-${String(++seq).padStart(16, '0')}`;

const USERS = {
  adminone: { isActive: true, deletedAt: null, type: 'INTERNAL', appRole: 'ADMIN' },
  admintwo: { isActive: true, deletedAt: null, type: 'INTERNAL', appRole: 'ADMIN' },
  helper01: { isActive: true, deletedAt: null, type: 'INTERNAL', appRole: 'YONETICI_YARDIMCISI' },
  sales001: { isActive: true, deletedAt: null, type: 'INTERNAL', appRole: 'SATIS' },
  drawer01: { isActive: true, deletedAt: null, type: 'INTERNAL', appRole: 'CIZIM' },
  inspect1: { isActive: true, deletedAt: null, type: 'INTERNAL', appRole: 'DENETIMCI' },
  custom01: { isActive: true, deletedAt: null, type: 'CUSTOMER', appRole: 'MUSTERI' },
  custadm1: { isActive: true, deletedAt: null, type: 'CUSTOMER', appRole: 'ADMIN' }, // bozuk veri: müşteri tipi asla açılmaz
  inactive: { isActive: false, deletedAt: null, type: 'INTERNAL', appRole: 'ADMIN' },
  deleted1: { isActive: true, deletedAt: new Date(), type: 'INTERNAL', appRole: 'ADMIN' },
};
const ORDERS = { ordergla68x: { orderNo: 'GLA68', removedAt: null }, orderremoved: { orderNo: 'ALE40', removedAt: new Date() } };

/** Salt okunur işlemi taklit eden sahte veritabanı: yalnızca okuma yöntemleri vardır; her çağrı kaydedilir */
function fakeDb() {
  const calls = [];
  const tx = {
    $executeRaw: async (strings) => { calls.push(['sql', strings.join('?')]); return 0; },
    user: { findUnique: async ({ where }) => { calls.push(['user', where.id]); return USERS[where.id] ?? null; } },
    order: { findUnique: async ({ where }) => { calls.push(['order', where.id]); return ORDERS[where.id] ?? null; } },
  };
  return { calls, $transaction: async (fn) => fn(tx) };
}

function req({ userId = 'adminone', question = 'GLA68 yüklendi mi?', orderId = null, reset = false, ts = NOW.getTime(), n = nonce(), key = KEY } = {}) {
  const raw = buildBody({ userId, question, orderId, reset, now: ts, nonce: n });
  return { raw, sig: signBody(key, raw) };
}

function setup(over = {}) {
  const db = fakeDb();
  const seen = [];
  const answerImpl = over.answerImpl ?? (async (a) => { seen.push(a); return { text: `yanıt ${seen.length}`, tools: [], usage: 100 }; });
  const h = createPanelHandler({ db, env: over.env ?? ENV, clock: over.clock ?? (() => NOW), answerImpl, limits: over.limits });
  return { db, seen, h };
}

// ---------------------------------------------------------------- protokol
test('protokol: imza doğru gövdede geçer; tek bayt değişince, başka anahtarla ya da bozuk imzada geçmez', () => {
  const { raw, sig } = req();
  assert.equal(signatureOk(KEY, raw, sig), true);
  assert.equal(signatureOk(KEY, raw.replace('GLA68', 'GLA69'), sig), false);
  assert.equal(signatureOk(panelKey('t'.repeat(48)), raw, sig), false);
  for (const bad of [undefined, '', 'zz', sig.toUpperCase(), sig.slice(0, 63), `${sig}0`]) assert.equal(signatureOk(KEY, raw, bad), false);
  assert.equal(panelKey('kisa'), null, 'kısa sırda protokol kapalı');
  // Amaca özgü anahtar: ham AUTH_SECRET ile yapılan imza geçmez
  assert.equal(signatureOk(KEY, raw, signBody(Buffer.from(SECRET), raw)), false);
});

test('protokol: biçim — bilinmeyen alan, yanlış tür, eski / gelecek zaman damgası, uzun / boş soru reddedilir', () => {
  const t = NOW.getTime();
  const ok = buildBody({ userId: 'adminone', question: 'soru', now: t, nonce: 'n'.repeat(20) });
  assert.equal(parseBody(ok, t).ok, true);
  const mut = (o) => JSON.stringify({ ...JSON.parse(ok), ...o });
  assert.equal(parseBody(mut({ admin: true }), t).code, 'BAD_REQUEST');
  assert.equal(parseBody(mut({ userId: 'x' }), t).code, 'BAD_REQUEST');
  assert.equal(parseBody(mut({ userId: '../../etc' }), t).code, 'BAD_REQUEST');
  assert.equal(parseBody(mut({ orderId: 5 }), t).code, 'BAD_REQUEST');
  assert.equal(parseBody(mut({ reset: 'true' }), t).code, 'BAD_REQUEST');
  assert.equal(parseBody(mut({ v: 2 }), t).code, 'BAD_REQUEST');
  assert.equal(parseBody('[]', t).code, 'BAD_REQUEST');
  assert.equal(parseBody('{bozuk', t).code, 'BAD_REQUEST');
  assert.equal(parseBody(mut({ ts: t - PANEL_LIMITS.skewMs - 1 }), t).code, 'STALE');
  assert.equal(parseBody(mut({ ts: t + PANEL_LIMITS.skewMs + 1 }), t).code, 'STALE');
  assert.equal(parseBody(mut({ question: 'x'.repeat(PANEL_LIMITS.questionChars + 1) }), t).code, 'TOO_LONG');
  assert.equal(parseBody(mut({ question: '   ' }), t).code, 'EMPTY');
  assert.equal(parseBody(mut({ question: '', reset: true }), t).ok, true);
});

test('protokol: nonce tek kullanımlık; taze nonce dolu önbellekte unutulmaz (istek reddedilir)', () => {
  const c = createNonceCache({ ttlMs: 1000, max: 2 });
  assert.equal(c.take('a'.repeat(16), 0), 'ok');
  assert.equal(c.take('a'.repeat(16), 10), 'replay');
  assert.equal(c.take('b'.repeat(16), 20), 'ok');
  assert.equal(c.take('c'.repeat(16), 30), 'full');
  assert.equal(c.take('a'.repeat(16), 40), 'replay', 'dolu önbellek taze nonce\'u atmaz');
  assert.equal(c.take('c'.repeat(16), 1500), 'ok', 'süresi geçenler atılır');
});

// ---------------------------------------------------------------- işçi: yetki ve yalıtım
test('işçi: imzasız / yanlış imzalı istek veritabanına ve AI\'a hiç ulaşmaz', async () => {
  const { db, seen, h } = setup();
  const r1 = await h.handle({ raw: req().raw, sig: undefined });
  const r2 = await h.handle({ ...req(), sig: signBody(panelKey('k'.repeat(40)), req().raw) });
  const forged = req({ key: Buffer.from('saldirgan-anahtari-saldirgan-anahtari') });
  const r3 = await h.handle(forged);
  for (const r of [r1, r2, r3]) assert.deepEqual([r.status, r.json.code], [401, 'BAD_SIGNATURE']);
  assert.deepEqual(db.calls, []);
  assert.equal(seen.length, 0);
});

test('işçi: tekrar gönderilen (replay) ve eski istek reddedilir', async () => {
  const { seen, h } = setup();
  const r = req();
  assert.equal((await h.handle(r)).status, 200);
  assert.deepEqual((await h.handle(r)).json.code, 'REPLAY');
  assert.deepEqual((await h.handle(req({ ts: NOW.getTime() - 120_000 }))).json.code, 'STALE');
  assert.equal(seen.length, 1);
});

test('işçi: yalnızca etkin, silinmemiş, iç ADMIN — diğer roller, müşteri, pasif, silinmiş, bilinmeyen 403', async () => {
  const { seen, h } = setup();
  assert.equal((await h.handle(req({ userId: 'adminone' }))).status, 200);
  for (const u of ['helper01', 'sales001', 'drawer01', 'inspect1', 'custom01', 'custadm1', 'inactive', 'deleted1', 'unknown99']) {
    const r = await h.handle(req({ userId: u }));
    assert.deepEqual([r.status, r.json.code], [403, 'FORBIDDEN'], u);
  }
  assert.equal(seen.length, 1);
});

test('işçi: veritabanı sorgusu salt okunur işlemde; yetki denetimi her istekte yeniden yapılır', async () => {
  const { db, h } = setup();
  await h.handle(req());
  await h.handle(req());
  assert.equal(db.calls.filter((c) => c[0] === 'user').length, 2, 'her istekte');
  assert.deepEqual(db.calls.filter((c) => c[0] === 'sql').map((c) => c[1]).slice(0, 2), ['SET TRANSACTION READ ONLY', 'SET LOCAL statement_timeout = 8000']);
});

test('işçi: sayfa bağlamı veritabanından okunan sipariş no\'dur; kaldırılmış / bilinmeyen sipariş bağlam olmaz', async () => {
  const { seen, h } = setup();
  await h.handle(req({ orderId: 'ordergla68x' }));
  await h.handle(req({ orderId: 'orderremoved' }));
  await h.handle(req({ orderId: 'nonexistent1' }));
  assert.match(seen[0].context, /GLA68/);
  assert.match(seen[0].context, /yetki ya da talimat değildir/);
  assert.equal(seen[1].context, null);
  assert.equal(seen[2].context, null);
  assert.ok(seen.every((a) => a.channel === 'panel' && a.voice === undefined));
});

test('işçi: kullanıcı belleği ayrı — bir yöneticinin sohbeti diğerine geçmez; sıfırlama yalnızca kendi belleğini siler', async () => {
  const { seen, h } = setup();
  await h.handle(req({ userId: 'adminone', question: 'ALE40 notları' }));
  await h.handle(req({ userId: 'admintwo', question: 'stok' }));
  await h.handle(req({ userId: 'adminone', question: 'ya GLA68?' }));
  assert.deepEqual(seen[1].history, [], 'admintwo adminone\'in geçmişini görmez');
  assert.deepEqual(seen[2].history.map((m) => m.content), ['ALE40 notları', 'yanıt 1']);
  const r = await h.handle(req({ userId: 'adminone', reset: true, question: '' }));
  assert.deepEqual(r.json, { ok: true, text: '' });
  assert.equal(seen.length, 3, 'sıfırlama AI çağırmaz');
  await h.handle(req({ userId: 'adminone', question: 'yeni' }));
  await h.handle(req({ userId: 'admintwo', question: 'yine' }));
  assert.deepEqual(seen[3].history, []);
  assert.deepEqual(seen[4].history.map((m) => m.content), ['stok', 'yanıt 2']);
});

test('işçi: bellek süresi dolunca geçmiş gönderilmez', async () => {
  let now = NOW;
  const { seen, h } = setup({ clock: () => now });
  await h.handle(req({ ts: now.getTime() }));
  now = new Date(NOW.getTime() + PANEL_USER_LIMITS.historyTtlMs + 1000);
  await h.handle(req({ ts: now.getTime() }));
  assert.deepEqual(seen[1].history, []);
});

test('işçi: dakika sınırı, günlük sınır ve token bütçesi kullanıcıya özgü', async () => {
  const { h } = setup({ limits: { perMinute: 2, perDay: 3, tokensPerDay: 250 } });
  assert.equal((await h.handle(req())).status, 200);
  assert.equal((await h.handle(req())).status, 200);
  assert.equal((await h.handle(req())).json.code, 'RATE');
  assert.equal((await h.handle(req({ userId: 'admintwo' }))).status, 200, 'başka kullanıcı etkilenmez');
  const b = setup({ limits: { tokensPerDay: 150 } });
  assert.equal((await b.h.handle(req())).status, 200);
  assert.equal((await b.h.handle(req())).status, 200);
  assert.equal((await b.h.handle(req())).json.code, 'BUDGET', '100 + 100 ≥ 150');
  const d = setup({ limits: { perDay: 1 } });
  assert.equal((await d.h.handle(req())).status, 200);
  assert.equal((await d.h.handle(req())).json.code, 'DAILY');
});

test('işçi: aynı kullanıcı aynı anda tek soru; genel eşzamanlılık sınırı', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { h } = setup({ answerImpl: async () => { await gate; return { text: 'ok', tools: [], usage: 1 }; }, limits: { concurrent: 2 } });
  const p1 = h.handle(req({ userId: 'adminone' }));
  await new Promise((r) => setImmediate(r));
  assert.equal((await h.handle(req({ userId: 'adminone' }))).json.code, 'BUSY');
  const p2 = h.handle(req({ userId: 'admintwo' }));
  await new Promise((r) => setImmediate(r));
  release();
  assert.equal((await p1).status, 200);
  assert.equal((await p2).status, 200);
  assert.equal((await h.handle(req({ userId: 'adminone' }))).status, 200, 'bitince kilit açılır');
});

test('işçi: zaman aşımı TIMEOUT döner; kilit yanıt gerçekten bitene kadar sürer; AI hataları sabit kod', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { h } = setup({ answerImpl: async () => { await gate; return { text: 'geç', tools: [], usage: 5 }; }, limits: { deadlineMs: 20 } });
  const r = await h.handle(req());
  assert.deepEqual([r.status, r.json.code], [504, 'TIMEOUT']);
  assert.equal((await h.handle(req())).json.code, 'BUSY', 'önceki iş sürerken');
  release();
  await new Promise((res) => setTimeout(res, 5));
  const { AiError } = await import('../server/assistant/ai.js');
  for (const [code, want] of [['AI_AUTH', 'AI_AUTH'], ['AI_RATE', 'AI_BUSY'], ['AI_TIMEOUT', 'AI_BUSY'], ['AI_FAILED', 'FAILED']]) {
    const e = setup({ answerImpl: async () => { throw new AiError(code); } });
    const x = await e.h.handle(req());
    assert.deepEqual([x.status, x.json], [502, { ok: false, code: want }]);
  }
  const boom = setup({ answerImpl: async () => { throw new Error('sk-gizli-anahtar ECONNREFUSED 10.0.0.1'); } });
  const y = await boom.h.handle(req());
  assert.deepEqual(y.json, { ok: false, code: 'FAILED' }, 'ham hata metni dışarı çıkmaz');
});

test('işçi: anahtar yoksa / bozuksa kapalı; yanıt uzunluğu sınırlı', async () => {
  assert.equal(panelConfig({}).reason, 'NOT_CONFIGURED');
  assert.equal(panelConfig({ OPENAI_API_KEY: 'kısa', AUTH_SECRET: SECRET }).reason, 'BAD_API_KEY');
  assert.equal(panelConfig({ OPENAI_API_KEY: ENV.OPENAI_API_KEY, AUTH_SECRET: 'kisa' }).reason, 'NO_SECRET');
  assert.equal(panelConfig(ENV).enabled, true);
  assert.equal(panelConfig({ ...ENV, TELEGRAM_BOT_TOKEN: '' }).enabled, true, 'Telegram ayarından bağımsız');
  const off = setup({ env: {} });
  assert.deepEqual((await off.h.handle(req())).json, { ok: false, code: 'NOT_CONFIGURED' });
  const long = setup({ answerImpl: async () => ({ text: 'x'.repeat(10_000), tools: [], usage: 1 }) });
  assert.equal((await long.h.handle(req())).json.text.length, PANEL_LIMITS.answerChars);
});

test('işçi: gerçek yanıtlayıcı (answer) panel yönergesi + bağlamla çağrılır; Telegram yönergesi değişmez', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    assert.equal(init.redirect, 'error');
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'GLA68 yüklendi.' } }], usage: { total_tokens: 42 } }), { status: 200 });
  };
  const db = fakeDb();
  const h = createPanelHandler({ db, env: ENV, clock: () => NOW, fetchImpl });
  const r = await h.handle(req({ orderId: 'ordergla68x', question: 'bu sipariş yüklendi mi?' }));
  assert.deepEqual(r.json, { ok: true, text: 'GLA68 yüklendi.' });
  const msgs = bodies[0].messages;
  assert.equal(msgs[0].content, systemPrompt('2026-10-17', { channel: 'panel' }));
  assert.match(msgs[1].content, /^SAYFA BAĞLAMI: .*GLA68/);
  assert.equal(msgs.at(-1).content, 'bu sipariş yüklendi mi?');
  // Panel yönergesi: Boss hitabı / flört yok, güvenlik ve en az veri kuralları aynı
  const panel = systemPrompt('2026-10-17', { channel: 'panel' });
  const tg = systemPrompt('2026-10-17');
  assert.doesNotMatch(panel, /Boss|flört(?!.* etme)/);
  for (const rule of ['GÜVENİLMEYEN VERİ', 'VERİ EN AZ', 'SALT OKUNURSUN', 'asla toplama']) {
    assert.ok(panel.includes(rule) && tg.includes(rule), rule);
  }
  assert.match(tg, /Boss/);
});

// ---------------------------------------------------------------- HTTP kapısı + istemci (yalnızca 127.0.0.1)
test('HTTP: uçtan uca imzalı istek; yanlış yol / yöntem / tür / büyük gövde reddedilir', async (t) => {
  const seen = [];
  const s = createPanelServer({ db: fakeDb(), env: ENV, answerImpl: async (a) => { seen.push(a); return { text: '**GLA68** tamam', tools: [], usage: 1 }; }, host: '127.0.0.1' });
  const addr = await s.listen(0, '127.0.0.1');
  t.after(() => s.close());
  const url = `http://127.0.0.1:${addr.port}`;
  const ok = await askPanel({ url, authSecret: SECRET, userId: 'adminone', question: 'durum?' });
  assert.deepEqual(ok, { ok: true, text: '**GLA68** tamam' });
  assert.deepEqual(await askPanel({ url, authSecret: SECRET, userId: 'sales001', question: 'durum?' }), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(await askPanel({ url, authSecret: 'y'.repeat(40), userId: 'adminone', question: 'durum?' }), { ok: false, code: 'BAD_SIGNATURE' });
  const raw = buildBody({ userId: 'adminone', question: 'q', now: Date.now(), nonce: nonce() });
  const post = (p, init) => fetch(`${url}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [SIG_HEADER]: signBody(KEY, raw) }, body: raw, ...init });
  assert.equal((await post('/baska')).status, 404);
  assert.equal((await fetch(`${url}${PANEL_PATH}`)).status, 404);
  assert.equal((await post(PANEL_PATH, { headers: { 'Content-Type': 'text/plain', [SIG_HEADER]: signBody(KEY, raw) } })).status, 415);
  const big = 'x'.repeat(PANEL_LIMITS.bodyBytes + 10);
  assert.equal((await post(PANEL_PATH, { body: big })).status, 413);
  assert.equal(seen.length, 1);
});

test('istemci: adres / sır yoksa kapalı; büyük, bozuk ya da bilinmeyen yanıt UNAVAILABLE; yönlendirme izlenmez', async () => {
  assert.deepEqual(await askPanel({ url: undefined, authSecret: SECRET, userId: 'adminone', question: 'q' }), { ok: false, code: 'NOT_CONFIGURED' });
  assert.deepEqual(await askPanel({ url: 'https://worker:3331', authSecret: SECRET, userId: 'adminone', question: 'q' }), { ok: false, code: 'NOT_CONFIGURED' });
  assert.deepEqual(await askPanel({ url: 'http://u:p@worker:3331', authSecret: SECRET, userId: 'adminone', question: 'q' }), { ok: false, code: 'NOT_CONFIGURED' });
  assert.deepEqual(await askPanel({ url: 'http://worker:3331', authSecret: 'kisa', userId: 'adminone', question: 'q' }), { ok: false, code: 'NOT_CONFIGURED' });
  const inits = [];
  const respond = (body) => async (u, init) => { inits.push([String(u), init]); return new Response(body, { status: 200 }); };
  const base = { url: 'http://worker:3331', authSecret: SECRET, userId: 'adminone', question: 'q' };
  assert.deepEqual(await askPanel({ ...base, fetchImpl: respond('x'.repeat(PANEL_LIMITS.responseBytes + 1)) }), { ok: false, code: 'UNAVAILABLE' });
  assert.deepEqual(await askPanel({ ...base, fetchImpl: respond('<html>') }), { ok: false, code: 'UNAVAILABLE' });
  assert.deepEqual(await askPanel({ ...base, fetchImpl: respond('{"ok":false,"code":"<script>"}') }), { ok: false, code: 'UNAVAILABLE' });
  assert.deepEqual(await askPanel({ ...base, fetchImpl: respond('{"ok":false,"code":"RATE"}') }), { ok: false, code: 'RATE' });
  assert.deepEqual(await askPanel({ ...base, fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { ok: false, code: 'UNAVAILABLE' });
  assert.deepEqual(await askPanel({ ...base, timeoutMs: 10, fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) }), { ok: false, code: 'TIMEOUT' });
  assert.equal(inits[0][0], 'http://worker:3331/sor');
  assert.equal(inits[0][1].redirect, 'error');
  const body = inits[0][1].body;
  assert.equal(signatureOk(KEY, body, inits[0][1].headers[SIG_HEADER]), true);
  assert.equal(JSON.parse(body).userId, 'adminone');
});

// ---------------------------------------------------------------- yanıt ayrıştırma (XSS)
test('yanıt: HTML / script / bağlantı metin kalır; yalnızca sipariş numarası sabit iç bağlantı olur', () => {
  const evil = '<img src=x onerror=alert(1)> [tıkla](javascript:alert(1)) <a href="https://kotu.example">x</a> ```<script>alert(1)</script>```';
  const blocks = parseAnswer(`${evil}\n- **ALE40** <b>kalın</b> **önemli**\n\n| No | Not |\n|---|---|\n| GLA68 | <svg onload=x> |`);
  const flat = JSON.stringify(blocks);
  const types = new Set();
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.t) types.add(x.t); if (x.type) types.add(x.type); Object.values(x).forEach(walk); } };
  walk(blocks);
  assert.deepEqual([...types].sort(), ['b', 'order', 'p', 'table', 'text', 'ul']);
  assert.ok(flat.includes('<img src=x onerror=alert(1)>'), 'metin olarak durur');
  const orders = [];
  const collect = (x) => { if (Array.isArray(x)) x.forEach(collect); else if (x && typeof x === 'object') { if (x.t === 'order') orders.push(x.v); Object.values(x).forEach(collect); } };
  collect(blocks);
  assert.deepEqual(orders, ['ALE40', 'GLA68']);
  assert.equal(orderHref('GLA64-1'), '/siparisler?q=GLA64-1');
  assert.equal(orderHref('ABC124-T2'), '/siparisler?q=ABC124-T2');
});

test('yanıt: sipariş olmayan kodlar bağlantı olmaz; tablo ve uzunluk sınırları', () => {
  const ids = (s) => JSON.stringify(parseAnswer(s)).match(/"t":"order","v":"[^"]+"/g) ?? [];
  assert.deepEqual(ids('RAL7016, FBL90, GKH101, PRF12, EUR100'), []);
  assert.equal(ids('GLAP12 ve ABC124-T ve ALE40-1').length, 3);
  const wide = `| ${Array.from({ length: 12 }, (_, i) => `c${i}`).join(' | ')} |\n|${'---|'.repeat(12)}\n${Array.from({ length: 100 }, () => `| ${'v | '.repeat(12)}`).join('\n')}`;
  const t = parseAnswer(wide).find((b) => b.type === 'table');
  assert.equal(t.head.length, MD_LIMITS.tableCols);
  assert.equal(t.rows.length, MD_LIMITS.tableRows);
  assert.ok(JSON.stringify(parseAnswer('a'.repeat(50_000))).length < MD_LIMITS.chars + 200);
});

// ---------------------------------------------------------------- yapı
test('yapı: uygulama tarafı yapay zekâ kodu / anahtarı içermez; yetki eylemde ve düzende; sayfa açılışında istek yok', () => {
  const appSide = ['app/(panel)/asistan-actions.ts', 'components/AssistantChat.tsx', 'server/assistant/panel-client.js', 'server/assistant/panel-protocol.js', 'server/assistant/markdown.js'];
  for (const f of appSide) {
    const s = read(f);
    assert.doesNotMatch(s, /assistant\/(ai|bot|tools|panel|readonly|telegram)(\.js)?'|from '\.\/(ai|bot|tools|panel|readonly|telegram)\.js'/, `${f}: AI modülü yok`);
    assert.doesNotMatch(s, /OPENAI|TELEGRAM|api\.openai/, `${f}: anahtar / sağlayıcı yok`);
  }
  const action = read('app/(panel)/asistan-actions.ts');
  assert.match(action, /^'use server';/);
  const iUser = action.indexOf('await getCurrentUser()');
  const iPerm = action.indexOf("userCan(user, 'ASSISTANT_PANEL')");
  const iAsk = action.indexOf('askPanel(');
  assert.ok(iUser > 0 && iPerm > iUser && iAsk > iPerm, 'önce oturum, sonra yetki, sonra iletme');
  const layout = read('app/(panel)/layout.tsx');
  assert.match(layout, /userCan\(user, 'ASSISTANT_PANEL'\) && <AssistantChat /);
  const ui = read('components/AssistantChat.tsx');
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|innerHTML|eval\(|new Function/);
  // İstek yalnızca kullanıcı eylemiyle (ask / reset): useEffect içinde çağrı yok
  assert.equal([...ui.matchAll(/askAssistantAction\(/g)].length, 2);
  for (const m of ui.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[/g)) assert.doesNotMatch(m[1], /askAssistantAction/);
  assert.doesNotMatch(ui, /localStorage/, 'kalıcı tarayıcı kaydı yok');
});

test('yapı: işçi kapısı dışarı yayımlanmaz; anahtar yalnızca işçide; uygulama iç adresi sabit', () => {
  const compose = read('deploy/docker-compose.yml');
  const block = (name) => { const s = compose.indexOf(`\n  ${name}:\n`); const rest = compose.slice(s + 1); const n = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n|\nnetworks:\n/); return n < 0 ? rest : rest.slice(0, n + 1); };
  assert.doesNotMatch(block('worker'), /ports:|expose:/);
  assert.match(block('app'), /\n {6}ASSISTANT_PANEL_URL: http:\/\/worker:3331\n/);
  assert.match(block('app'), /\n {6}OPENAI_API_KEY: ""\n/);
  assert.doesNotMatch(read('deploy/Caddyfile'), /worker|3331/);
  const worker = read('scripts/worker.mjs');
  assert.match(worker, /if \(!once\) \{\n {2}const p = createPanelServer\(\{ db, env, log \}\);/);
  assert.match(worker, /if \(panel\) await Promise\.race\(\[panel\.close\(\)/);
});
