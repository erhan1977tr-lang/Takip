// Yönetici raporları 3.89.0 (karar 284) — saf kurallar ve yapı: filtre / dönem (Europe/Bucharest), cam miktar kuralı (kısmi
// yükleme, bedelsiz telafi), gösterim (panel = Excel hücreleri, Telegram özeti), yetki (veritabanına dokunmadan red), Telegram
// rapor aracı (allowlist, salt okunur, sesli Coral akışı — sahte ağ), yapı taraması (yazma yok, ham SQL yok, tek servis).
// Gerçek Telegram / TTS / SMTP / FGO çağrısı yok.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dayStartUtc, filterQuery, filtersFromQuery, instantRange, monthRange, parseReportFilters, periodRange } from '../server/reports/filters.js';
import { fold, orderGlass, runReport, ASSISTANT_ACTOR } from '../server/reports/service.js';
import { cellLabel, reportForAi, reportSheets } from '../server/reports/present.js';
import { TOOLS, runTool, validateArgs } from '../server/assistant/tools.js';
import { VOICE_MARK, assistantConfig, createAssistant, systemPrompt } from '../server/assistant/bot.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TZ = 'Europe/Bucharest';
const NOW = new Date('2026-10-15T09:00:00Z');
globalThis.fetch = async (u) => { throw new Error(`test: gerçek ağ isteği (${String(u).slice(0, 40)})`); };

test('filtre: hazır dönemler Romanya saatine göre (gece yarısı sınırı, hafta pazartesi, son 3 ay, geçen ay yıl başında)', () => {
  const r = (p, now) => periodRange(p, { now: new Date(now), timeZone: TZ });
  assert.deepEqual(r('this_month', '2026-10-15T09:00:00Z'), { from: '2026-10-01', to: '2026-10-15' });
  // UTC'de 31 Ekim 22:30 = Bükreş'te 1 Kasım 00:30
  assert.deepEqual(r('this_month', '2026-10-31T22:30:00Z'), { from: '2026-11-01', to: '2026-11-01' });
  assert.deepEqual(r('last_month', '2026-10-31T22:30:00Z'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r('last_month', '2026-01-10T09:00:00Z'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(r('this_week', '2026-10-15T09:00:00Z'), { from: '2026-10-12', to: '2026-10-18' }); // Perşembe → Pzt–Paz
  assert.deepEqual(r('last_week', '2026-10-12T09:00:00Z'), { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(r('this_year', '2026-10-15T09:00:00Z'), { from: '2026-01-01', to: '2026-10-15' });
  assert.deepEqual(r('last_year', '2026-10-15T09:00:00Z'), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(r('last_3_months', '2026-02-10T09:00:00Z'), { from: '2025-12-01', to: '2026-02-10' });
  assert.deepEqual(r('last_30_days', '2026-10-15T09:00:00Z'), { from: '2026-09-16', to: '2026-10-15' });
  assert.equal(r('yarin', NOW), null);
  assert.deepEqual(monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.equal(monthRange('2026-13'), null);
});

test('filtre: öncelik (aralık → ay → yıl → dönem → bu ay), hatalar sessizce yok sayılmaz, en çok iki yıl', () => {
  const p = (i) => parseReportFilters(i, { now: NOW, timeZone: TZ });
  assert.equal(p({}).period, 'this_month');
  assert.deepEqual([p({ from: '2026-09-01', to: '2026-09-30', month: '2026-01' }).from, p({ from: '2026-09-01', to: '2026-09-30' }).period], ['2026-09-01', 'custom']);
  assert.deepEqual([p({ month: '2026-09', year: 2025 }).from, p({ month: '2026-09' }).to], ['2026-09-01', '2026-09-30']);
  assert.deepEqual([p({ year: '2025' }).from, p({ year: 2025 }).to], ['2025-01-01', '2025-12-31']);
  assert.deepEqual(p({ from: '2026-09-01' }).errors, ['RANGE_INVALID']);
  assert.deepEqual(p({ from: '2026-09-30', to: '2026-09-01' }).errors, ['RANGE_INVALID']);
  assert.deepEqual(p({ from: '2026-02-30', to: '2026-03-01' }).errors, ['DAY_INVALID']);
  assert.deepEqual(p({ from: '2023-01-01', to: '2026-01-01' }).errors, ['RANGE_TOO_LONG']);
  assert.deepEqual(p({ month: '2026-13' }).errors, ['MONTH_INVALID']);
  assert.deepEqual(p({ period: 'yarin' }).errors, ['PERIOD_INVALID']);
  // Bilinmeyen seçimler varsayılana döner; firma kimliği biçimi denetlenir
  const x = p({ kind: 'x', orderType: 'Z', status: 'IPTAL', loading: 'X', customerId: "1' OR 1=1" });
  assert.deepEqual([x.kind, x.orderType, x.status, x.loading, x.customerId], ['orders', 'ALL', '', 'ALL', '']);
  // Panel adresi ↔ filtre (Excel bağlantısı aynı filtreler)
  const f = p({ kind: 'finance', month: '2026-09', customerId: 'cabcdefgh12345', orderType: 'GLASS', status: 'URETIMDE', product: 'Temper', loading: 'PARTIAL' });
  const back = p(filtersFromQuery(Object.fromEntries(new URLSearchParams(filterQuery(f)))));
  assert.deepEqual({ ...back, errors: [] }, { ...f, errors: [] });
});

test('filtre: yerel gün başlangıcı yaz / kış saatinde doğru (anlık alanlar yerel güne göre süzülür)', () => {
  assert.equal(dayStartUtc('2026-07-01', TZ).toISOString(), '2026-06-30T21:00:00.000Z'); // UTC+3
  assert.equal(dayStartUtc('2026-12-01', TZ).toISOString(), '2026-11-30T22:00:00.000Z'); // UTC+2
  assert.equal(dayStartUtc('2026-10-25', TZ).toISOString(), '2026-10-24T21:00:00.000Z'); // geçiş günü
  assert.deepEqual(instantRange({ from: '2026-10-01', to: '2026-10-31' }, TZ), { gte: new Date('2026-09-30T21:00:00.000Z'), lt: new Date('2026-10-31T22:00:00.000Z') });
  assert.equal(fold('İSTANBUL Şeffaf ıı'), fold('istanbul seffaf ii'));
});

/** Kısmi yüklenmiş sipariş: 10 cam (parça m² 1,234321), 2 bedelsiz telafi; 6 + 2 yüklendi, 3 aktarıldı, 1 kaldı */
function partialOrder() {
  const lines = [
    { id: 'L1', description: 'Temper 8 mm', enMm: 1111, boyMm: 1111, adet: 10, unit: 'm2', kind: 'CAM', pieceM2: '1.234321', pieceBase: 0 },
    { id: 'L2', description: 'CNC', adet: 2, unit: 'adet', kind: 'CNC' },
    { id: 'L3', description: 'Temper 8 mm', enMm: 500, boyMm: 600, adet: 2, unit: 'm2', kind: 'CAM', free: true, pieceBase: 0 },
    { id: 'L4', description: 'Sandık parası', adet: 1, unit: 'adet', kind: 'CAM', crateFee: true },
  ];
  const conf = { shipDay: new Date('2026-10-10T00:00:00Z') };
  return {
    estimatedShipDate: new Date('2026-10-10T12:00:00Z'),
    offers: [{ status: 'GONDERILDI', lines }],
    loadedItems: [
      { confirmationId: 'C', offerLineId: 'L1', status: 'LOADED', quantity: 6, revision: 0, confirmation: conf },
      { confirmationId: 'C', offerLineId: 'L1', status: 'NOT_LOADED', quantity: 4, revision: 0, confirmation: conf },
      { confirmationId: 'C', offerLineId: 'L3', status: 'LOADED', quantity: 2, revision: 0, confirmation: conf },
    ],
    replans: [{ status: 'ACTIVE', quantity: 3, shipDay: new Date('2026-10-20T00:00:00Z'), sourceItem: { offerLineId: 'L1' } }],
  };
}

test('cam kuralı: sipariş / yüklenen (yalnızca onaylı) / planlanan / planlanmamış — ticari ve bedelsiz telafi ayrı, bölümler toplamı paylaşır', () => {
  const g = orderGlass(partialOrder());
  assert.equal(g.state, 'PARTIAL');
  assert.deepEqual(g.loadedDays, ['2026-10-10']);
  const com = [...g.types.values()].find((t) => !t.free);
  const free = [...g.types.values()].find((t) => t.free);
  assert.deepEqual(com.ordered, [10, 12343]);
  assert.deepEqual(com.loaded, [6, 7406]);
  assert.deepEqual(com.planned, [3, 3703]);
  assert.deepEqual(com.open, [1, 1234]);
  assert.equal(com.loaded[1] + com.planned[1] + com.open[1], com.ordered[1], 'parçalar toplamı = sipariş');
  assert.deepEqual([free.ordered, free.loaded], [[2, 600], [2, 600]]);
  // Teklif tablosu yok → miktar bilinmiyor (sıfır değil)
  assert.equal(orderGlass({ offers: [{ status: 'HAZIRLANIYOR', lines: [] }] }).noOffer, true);
  // Ürün filtresi satır düzeyinde
  assert.equal(orderGlass(partialOrder(), (l) => fold(l.description).includes('lamine')).types.size, 0);
  // Hiç onay yok → yüklenmedi; tamamı onaylı → yüklendi
  assert.equal(orderGlass({ ...partialOrder(), loadedItems: [], replans: [] }).state, 'NOT_LOADED');
});

test('yetki: rapor servisi yetkisiz aktörü veritabanına HİÇ dokunmadan reddeder; asistan aktörü yalnızca sabit nesne', async () => {
  const trap = new Proxy({}, { get: () => { throw new Error('veritabanına dokunuldu'); } });
  for (const role of ['SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI', 'BILINMEYEN', null]) {
    assert.deepEqual(await runReport(trap, { kind: 'finance' }, { actor: role ? { role } : null, now: NOW, timeZone: TZ }), { ok: false, code: 'FORBIDDEN' }, String(role));
  }
  assert.deepEqual(await runReport(trap, { kind: 'finance' }, { actor: { assistant: 'true' }, now: NOW, timeZone: TZ }), { ok: false, code: 'FORBIDDEN' });
  assert.ok(Object.isFrozen(ASSISTANT_ACTOR));
  // Geçersiz filtre: hesaplanmaz, sorgu yok
  assert.deepEqual(await runReport(trap, { from: '2026-10-05' }, { actor: { role: 'ADMIN' }, now: NOW, timeZone: TZ }), { ok: false, code: 'INVALID_FILTERS', errors: ['RANGE_INVALID'] });
});

/** Boş veritabanı (her okuma boş) — gerçek servis koşar, sorgular sayılır */
function emptyDb() {
  const calls = [];
  const model = (name) => new Proxy({}, { get: (_, fn) => async () => { calls.push(`${name}.${String(fn)}`); return fn === 'count' ? 0 : fn === 'findUnique' || fn === 'findFirst' ? null : []; } });
  const db = new Proxy({}, { get: (_, name) => (name === '$transaction' ? async (fn) => fn(db) : name === '$executeRaw' ? async () => 0 : model(String(name))) });
  return { db, calls };
}

test('servis: boş veride beş rapor da sıfır döner (eksik veri değil); yazma yöntemi hiç çağrılmaz', async () => {
  for (const kind of ['orders', 'glass', 'profile', 'loading', 'finance']) {
    const e = emptyDb();
    const r = await runReport(e.db, { kind }, { actor: { role: 'YONETICI_YARDIMCISI' }, now: NOW, timeZone: TZ });
    assert.equal(r.ok, true, kind);
    assert.deepEqual(r.report.range, { from: '2026-10-01', to: '2026-10-15' });
    assert.ok(e.calls.every((c) => /\.(findMany|findUnique|findFirst|count|groupBy|aggregate)$/.test(c)), e.calls.join());
    for (const c of r.report.cards) if (c.type !== 'money') assert.equal(c.value, 0, `${kind}/${c.key}`);
  }
});

const SAMPLE = {
  kind: 'loading', range: { from: '2026-10-01', to: '2026-10-31' }, basis: 'LOADING_DAY', period: 'month', generatedAt: NOW.toISOString(),
  filters: { customer: null, orderType: 'ALL', status: '', product: '', loading: 'ALL' },
  cards: [{ key: 'loadedM2', value: 7.406, type: 'm2' }, { key: 'profit', value: null, type: 'money', unit: 'RON', note: 'MISSING_COST' }],
  tables: [{
    key: 'loadingOrders', columns: [{ key: 'day', type: 'day' }, { key: 'dayState', type: 'code', dict: 'dayState' }, { key: 'orderNo', type: 'text' }, { key: 'commercialM2', type: 'm2' }, { key: 'note', type: 'note' }],
    rows: Array.from({ length: 12 }, (_, i) => ['2026-10-10', 'ACTUAL', `ALE${i}`, i + 0.5, i === 0 ? 'REPLAN:2026-10-02' : null]), totals: [['', null, null, 72, null]],
  }],
  notes: ['M2_RULE'],
};
const t = (k, p) => (p ? `${k}${JSON.stringify(p)}` : k);

test('gösterim: Excel hücreleri ekrandakiyle aynı (sayılar sayı, kodlar çevrilir, eksik değer boş), özet sayfası filtre / aralık / esas tarih', () => {
  const sheets = reportSheets(SAMPLE, t, { generatedText: '15.10.2026' });
  assert.equal(sheets.length, 2);
  assert.deepEqual(sheets[0].info.map((r) => r[1]).slice(0, 3), ['reports.kinds.loading', '01.10.2026 – 31.10.2026', 'reports.basis.LOADING_DAY']);
  assert.deepEqual(sheets[0].blocks[0].rows[1].slice(1, 6), [null, null, null, 'RON', 'reports.val.note.MISSING_COST'], 'eksik kâr sıfır yazılmaz');
  const b = sheets[1].blocks[0];
  assert.equal(b.rows.length, 12);
  assert.deepEqual(b.rows[0], ['10.10.2026', 'reports.val.dayState.ACTUAL', 'ALE0', 0.5, 'reports.val.note.REPLAN{"day":"02.10.2026"}']);
  assert.deepEqual(b.columns.map((c) => c.type), ['text', 'text', 'text', 'm2', 'wrap']);
  assert.equal(b.totals[0][0], 'reports.totals');
  assert.equal(cellLabel({ type: 'code', dict: 'status' }, 'URETIMDE', t), 'status.order.URETIMDE');
  assert.equal(cellLabel({ type: 'm2' }, null, t), null);
});

test('gösterim: Telegram özeti kısa — ilk satırlar + toplam + satır sayısı; eksik değer işaretli; sayılar servisten aynen', () => {
  const ai = reportForAi(SAMPLE, { rows: 5 });
  assert.deepEqual(ai.aralik, SAMPLE.range);
  assert.equal(ai.esasTarih, 'LOADING_DAY');
  assert.deepEqual(ai.ozet, [{ loadedM2: 7.406 }, { profit: null, birim: 'RON', eksikVeri: 'MISSING_COST' }]);
  const tb = ai.tablolar[0];
  assert.equal(tb.satirSayisi, 12);
  assert.equal(tb.gosterilen, 5);
  assert.equal(tb.satirlar.length, 5);
  assert.deepEqual(tb.toplam, [{ commercialM2: 72 }]);
  assert.ok(JSON.stringify(ai).length < 4000);
});

test('telegram: rapor aracı allowlist alanlarıyla doğrulanır (serbest SQL / bilinmeyen alan / geçersiz ay reddedilir)', () => {
  const F = TOOLS.rapor.fields;
  assert.deepEqual(validateArgs(F, { tur: 'finans', donem: 'bu_ay', firma: 'ALE' }), { tur: 'finans', donem: 'bu_ay', firma: 'ALE' });
  assert.deepEqual(validateArgs(F, { tur: 'cam', ay: '2026-09' }), { tur: 'cam', ay: '2026-09' });
  for (const bad of [{ tur: 'sql' }, { tur: 'cam', sql: 'SELECT 1' }, { tur: 'cam', ay: '09.2026' }, { tur: 'cam', yil: 1999 }, { tur: 'cam', donem: 'yarin' }, { tur: 'cam', satir: 100 }, { tur: 'cam', baslangic: '2026-02-30' }]) {
    assert.throws(() => validateArgs(F, bad), JSON.stringify(bad));
  }
});

test('telegram: rapor aracı aynı servisi READ ONLY işlemde çağırır; dönem Romanya saatiyle; hata kodu ayrı', async () => {
  const e = emptyDb();
  const sql = [];
  const ro = (fn) => (async () => { sql.push('SET TRANSACTION READ ONLY'); return fn(e.db); })();
  const r = await runTool(ro, 'rapor', JSON.stringify({ tur: 'yukleme', donem: 'bu_hafta' }), { tz: TZ, now: NOW });
  assert.deepEqual(r.aralik, { from: '2026-10-12', to: '2026-10-18' });
  assert.equal(r.rapor, 'loading');
  assert.deepEqual(sql, ['SET TRANSACTION READ ONLY']);
  assert.deepEqual(await runTool(ro, 'rapor', JSON.stringify({ tur: 'cam', baslangic: '2026-10-01' }), { tz: TZ, now: NOW }), { hata: 'INVALID_FILTERS', ayrinti: ['RANGE_INVALID'] });
  assert.deepEqual(await runTool(ro, 'rapor', '{}', { tz: TZ, now: NOW }), { hata: 'INVALID_ARGS' });
});

test('telegram: yönergeler — rapor aracı, dönem yorumu, belirsizlikte soru, aralığı yazma, sıfır / eksik / hata ayrımı, sesli okuma', () => {
  const p = systemPrompt('2026-10-15', { voice: true });
  assert.match(p, /rapor aracını kullan/);
  assert.match(p, /donem=bu_ay/);
  assert.match(p, /belirsizse/);
  assert.match(p, /tarih aralığını/);
  assert.match(p, /"sıfır" de/);
  assert.match(p, /"veri eksik" de/);
  assert.match(p, /kendin toplama/);
  assert.match(p, /metrekare/);
  assert.match(p, /lei/);
  assert.doesNotMatch(systemPrompt('2026-10-15'), /metrekare/, 'yazılı soruda ses yönergesi yok');
});

const TOKEN = '1234567890:AAH-sahteJetonDegeriTestIcinBurada_xyz12';
const KEY = 'sk-test-SAHTEanahtarTestIcin1234567890';
const USER = 555000111;
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER_ID: String(USER), OPENAI_API_KEY: KEY, APP_TIMEZONE: TZ };
function fakeNet({ ai, transcript }) {
  const calls = [];
  const sent = [];
  const voices = [];
  let i = 0;
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ url: u, body });
    if (u.startsWith('https://api.telegram.org/file/')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    if (u.startsWith('https://api.telegram.org/bot')) {
      const method = u.split('/').pop();
      if (method === 'sendMessage') sent.push(body.text);
      if (method === 'sendVoice') voices.push(body);
      if (method === 'getFile') return json(200, { ok: true, result: { file_path: 'voice/x.oga', file_size: 3 } });
      return json(200, { ok: true, result: true });
    }
    if (u === 'https://api.openai.com/v1/audio/transcriptions') return json(200, { text: transcript });
    if (u === 'https://api.openai.com/v1/audio/speech') return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([79, 103, 103, 83, 1]).buffer };
    if (u === 'https://api.openai.com/v1/chat/completions') {
      const next = ai[Math.min(i++, ai.length - 1)];
      return json(200, { choices: [{ message: { role: 'assistant', content: next.content ?? null, tool_calls: next.tool_calls } }], usage: { total_tokens: 100 } });
    }
    throw new Error(`beklenmeyen adres ${u}`);
  };
  return { fetchImpl, calls, sent, voices };
}
const msg = (over = {}) => ({ update_id: 1, message: { message_id: 1, date: Math.floor(NOW.getTime() / 1000), from: { id: USER, is_bot: false }, chat: { id: USER, type: 'private' }, ...over } });

for (const [lang, q, answerText] of [['tr', 'Bu ay kaç metrekare cam yükledik?', 'Bu ay (01.10.2026 – 15.10.2026) yüklenen cam: sıfır.'], ['ro', 'Câți metri pătrați de sticlă am încărcat luna asta?', 'Luna aceasta (01.10.2026 – 15.10.2026) nu s-a încărcat sticlă: zero.']]) {
  test(`telegram sesli rapor (${lang}): ses → yazı → rapor aracı (aynı servis) → yazılı tam yanıt + Coral sesli özet (sahte ağ)`, async () => {
    const e = emptyDb();
    const net = fakeNet({ transcript: q, ai: [
      { tool_calls: [{ id: 't1', type: 'function', function: { name: 'rapor', arguments: JSON.stringify({ tur: 'yukleme', donem: 'bu_ay' }) } }] },
      { content: `${answerText}\n${VOICE_MARK}\n${answerText}` },
    ] });
    const bot = createAssistant({ db: e.db, env: ENV, fetchImpl: net.fetchImpl, clock: () => NOW });
    await bot.handleUpdate(msg({ voice: { file_id: 'F1', duration: 4, file_size: 3 } }));
    const ai = net.calls.filter((c) => c.url.endsWith('/chat/completions'));
    const toolMsg = JSON.parse(ai[1].body.messages.find((m) => m.role === 'tool').content);
    assert.deepEqual(toolMsg.aralik, { from: '2026-10-01', to: '2026-10-15' });
    assert.equal(toolMsg.ozet.find((o) => 'loadedM2' in o).loadedM2, 0);
    assert.equal(net.sent.length, 1);
    assert.ok(net.sent[0].endsWith(answerText));
    const tts = net.calls.filter((c) => c.url.endsWith('/audio/speech'));
    assert.equal(tts.length, 1);
    assert.equal(tts[0].body.voice, 'coral');
    assert.match(tts[0].body.instructions, lang === 'ro' ? /Romanian/ : /Turkish/);
    assert.equal(net.voices.length, 1);
  });
}

test('telegram: yetkisiz kullanıcı ya da grup rapor sorusu → hiçbir istek, hiçbir sorgu', async () => {
  const e = emptyDb();
  const net = fakeNet({ ai: [{ content: 'x' }] });
  const bot = createAssistant({ db: e.db, env: ENV, fetchImpl: net.fetchImpl, clock: () => NOW });
  await bot.handleUpdate(msg({ from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'Bu yıl satışlarımız kaç EUR?' }));
  await bot.handleUpdate(msg({ chat: { id: -100, type: 'group' }, text: 'Bu yıl satışlarımız kaç EUR?' }));
  assert.equal(net.calls.length, 0);
  assert.equal(e.calls.length, 0);
  assert.equal(assistantConfig(ENV).userId, USER);
});

test('yapı: rapor servisi salt okunur (yazma / ham SQL yok); panel ve Excel REPORT_VIEW ister; Telegram aynı servisi kullanır', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'server/reports'))) {
    const s = read(`server/reports/${f}`);
    assert.doesNotMatch(s, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/, `${f}: yazma`);
    assert.doesNotMatch(s, /\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)/, `${f}: ham SQL`);
    assert.doesNotMatch(s, /from '\.\.\/(mail|notifications|integrations|orders\/transitions|documents)\b/, `${f}: yasak modül`);
  }
  const page = read('app/(panel)/admin/raporlar/page.tsx');
  assert.match(page, /await requirePermission\('REPORT_VIEW'\)/);
  assert.match(page, /runReport\(db, input/);
  const xl = read('app/(panel)/admin/raporlar/excel/route.ts');
  assert.match(xl, /if \(!userCan\(user, 'REPORT_VIEW'\)\) return new Response\(t\('common\.fileNotFound'\), \{ status: 404 \}\)/);
  assert.match(xl, /runReport\(db, filtersFromQuery\(sp\)/);
  const tools = read('server/assistant/tools.js');
  assert.match(tools, /const r = await runReport\(tx, \{/);
  // Rapor toplamları başka yerde hesaplanmaz: rapor servisini yalnızca panel, Excel ve Telegram aracı çağırır
  const callers = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      if (['node_modules', '.next', '.git', 'test', 'e2e'].includes(e.name)) continue;
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|ts|tsx)$/.test(e.name) && /runReport\(/.test(read(p)) && !p.startsWith('./server/reports/')) callers.push(p.slice(2));
    }
  };
  walk('.');
  assert.deepEqual(callers.sort(), ['app/(panel)/admin/raporlar/excel/route.ts', 'app/(panel)/admin/raporlar/page.tsx', 'server/assistant/tools.js']);
});
