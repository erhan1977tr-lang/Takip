// Not yazma ve not çevirisi sınırları — karar 147 (güvenlik denetimi 3.50.9 AUD-9).
// Gerçek işlevler (addNote, retryNoteTranslation) bellekteki sahte veritabanıyla ve sayan sahte çevirmenle çalışır:
// ağ yok (global fetch her çağrıda hata fırlatır), Google yok. Sahte veritabanı, siparişe özel kilidi
// (pg_advisory_xact_lock) ve sorguların araya girmesini modelleyerek paralel istekleri de sınar; gerçek PostgreSQL ile
// aynı senaryolar test/db/note-translation.test.js'tedir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addNote, retryNoteTranslation, notesFor, translationState } from '../server/notes/translation.js';
import { NOTE_LIMITS, TRANSLATION_RATE_LIMITED, createNoteLimits, isNoteStaff, noteLimits } from '../server/notes/limits.js';
import { TRANSLATE_ERRORS } from '../server/notes/view.js';
import { TranslateError } from '../server/notes/provider.js';
import { sealSecret } from '../server/crypto/secret.js';
import { translate } from '../server/i18n/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async (u) => { throw new Error(`test: ağ isteği yapılmamalı (${u})`); }; });
test.after(() => { globalThis.fetch = realFetch; });

const SECRET = 's'.repeat(40);
const READY = { enabled: true, keySealed: sealSecret('k'.repeat(30), SECRET, 'translate-key') };
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 7, 8, 0, 0);
const at = (ms) => new Date(T0 + ms);

const cust = (n = 1, firm = 'A') => ({ id: `cust${n}`, role: 'MUSTERI', customerId: firm });
const staff = (role, n = 1) => ({ id: `${role}${n}`, role, customerId: 'F', ip: '127.0.0.1' });
const inspector = { id: 'insp', role: 'DENETIMCI', customerId: 'F' };

/**
 * Bellekte sahte veritabanı. Sorgular bir "tık" bekler (paralel istekler araya girer); $transaction içindeki
 * $executeRaw, anahtarına göre sıraya sokar (pg_advisory_xact_lock gibi) ve işlem bitince bırakır.
 */
function fakeDb({ settings = READY, orders = [{ id: 'o1', customerId: 'A' }, { id: 'o2', customerId: 'A' }, { id: 'oB', customerId: 'B' }] } = {}) {
  const notes = [];
  const audits = [];
  const outbox = [];
  const queues = new Map();
  const tick = () => new Promise((r) => setImmediate(r));
  const match = (n, w) => Object.entries(w).every(([k, v]) => {
    if (k === 'OR') return v.some((x) => match(n, x));
    if (k === 'order') return true;
    if (v && typeof v === 'object' && 'not' in v) return n[k] !== v.not;
    if (v && typeof v === 'object' && 'lt' in v) return n[k] < v.lt;
    return n[k] === v;
  });
  const model = {
    order: {
      async findFirst({ where }) {
        await tick();
        const o = orders.find((x) => x.id === where.id && (where.customerId === undefined || x.customerId === where.customerId));
        return o ? { id: o.id } : null;
      },
    },
    integrationSetting: { async findUnique() { await tick(); return settings ? { value: settings } : null; } },
    orderNote: {
      async count({ where }) { await tick(); return notes.filter((n) => match(n, where)).length; },
      async create({ data }) {
        await tick();
        const n = { id: `n${notes.length + 1}`, translation: null, translationLang: null, translationStatus: null, translationError: null, translationAt: null, ...data };
        notes.push(n);
        return { ...n };
      },
      async updateMany({ where, data }) { await tick(); let c = 0; for (const n of notes) if (match(n, where)) { Object.assign(n, data); c += 1; } return { count: c }; },
      async findFirst({ where }) { await tick(); const n = notes.find((x) => x.id === where.id && x.orderId === where.orderId); return n ? { ...n } : null; },
    },
    auditLog: { async create({ data }) { audits.push(data); return data; } },
    // Mesaj bildirimi (karar 199): müşteriye açık not aynı işlemde tek kuyruk olayı yazar
    notificationOutbox: { async create({ data }) { await tick(); const r = { id: `ob${outbox.length + 1}`, ...data }; outbox.push(r); return r; } },
  };
  return {
    ...model, notes, audits, outbox,
    /** Sipariş notlarını doğrudan ekler (test verisi; sınırlardan geçmez) */
    seed(orderId, count, extra = {}) { for (let i = 0; i < count; i++) notes.push({ id: `seed${notes.length + 1}`, orderId, userId: 'seed', text: 'x', internal: false, translation: null, translationLang: null, translationStatus: null, translationError: null, translationAt: null, ...extra }); },
    async $transaction(fn) {
      const held = [];
      const tx = {
        ...model,
        async $executeRaw(strings, ...values) {
          assert.match(strings.join('?'), /pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)/);
          const key = String(values[0]);
          const before = queues.get(key) ?? Promise.resolve();
          let release;
          queues.set(key, before.then(() => new Promise((r) => { release = r; })));
          await before;
          held.push(() => release());
          return 1;
        },
      };
      try {
        return await fn(tx);
      } finally {
        for (const r of held) r();
      }
    },
  };
}
/** Sayan sahte çevirmen */
function provider(impl = async ({ text, target }) => ({ text: `[${target}] ${text}` })) {
  const calls = [];
  return { calls, fn: async (o) => { calls.push(o); return impl(o); } };
}
const add = (db, actor, o = {}) => addNote(db, { orderId: 'o1', actor, text: 'Bună ziua', secret: SECRET, translator: provider().fn, now: at(0), ...o });
const codes = (rs) => rs.map((r) => (r.ok ? 'ok' : r.code));
const count = (list, v) => list.filter((x) => x === v).length;
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

test('sınır değerleri ürün kararındaki gibidir (karar 147)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(NOTE_LIMITS)), {
    customerNotes: { limit: 20, windowMs: 600_000 },
    staffNotes: { limit: 60, windowMs: 600_000 },
    perOrder: 500,
    customerTranslations: { limit: 30, windowMs: 3_600_000 },
    retries: { limit: 20, windowMs: 600_000 },
  });
  assert.equal(Object.isFrozen(NOTE_LIMITS) && Object.isFrozen(NOTE_LIMITS.customerNotes) && Object.isFrozen(NOTE_LIMITS.retries), true);
  assert.equal(noteLimits.perOrder, 500);
  assert.equal(TRANSLATION_RATE_LIMITED, 'RATE_LIMIT');
  assert.ok(TRANSLATE_ERRORS.includes('RATE_LIMIT'), 'güvenli kod listesinde');
  // İç ekip = not yazan + iç notları gören rol (yönetici, satış, çizim); müşteri ayrı sınırdadır; denetimci not yazamaz
  assert.deepEqual(['ADMIN', 'SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI', undefined].map((r) => isNoteStaff(r)), [true, true, true, false, false, false]);
});

test('müşteri: kullanıcı başına 10 dakikada 20 not — 21. reddedilir, yazılmaz; pencere geçince yeniden kabul; sınır kullanıcıya özeldir', async () => {
  const db = fakeDb({ settings: null });
  const limits = createNoteLimits();
  const p = provider();
  const o = (ms, actor = cust(1)) => add(db, actor, { limits, translator: p.fn, now: at(ms) });
  const first = [];
  for (let i = 0; i < 20; i++) first.push(await o(i * 1000));
  assert.equal(count(codes(first), 'ok'), 20);
  assert.deepEqual(await o(20_000), { ok: false, code: 'RATE_LIMIT' });
  assert.deepEqual(await o(9 * MIN + 59_000), { ok: false, code: 'RATE_LIMIT' }, 'pencere dolmadan');
  assert.equal(db.notes.length, 20, 'reddedilen not yazılmaz');
  // Aynı firmanın başka kullanıcısı ve başka firmanın kullanıcısı etkilenmez (sınır kullanıcı başınadır)
  assert.equal((await o(21_000, cust(2))).ok, true);
  assert.equal((await addNote(db, { orderId: 'oB', actor: cust(3, 'B'), text: 'x', limits, secret: SECRET, translator: p.fn, now: at(21_000) })).ok, true);
  // İlk notun üzerinden tam 10 dakika geçince bir hak açılır (kayan pencere), hepsi geçince 20 hak yeniden
  assert.equal((await o(10 * MIN)).ok, true);
  assert.deepEqual(await o(10 * MIN + 500), { ok: false, code: 'RATE_LIMIT' });
  const again = [];
  for (let i = 0; i < 21; i++) again.push(await o(21 * MIN + i));
  assert.deepEqual([count(codes(again), 'ok'), count(codes(again), 'RATE_LIMIT')], [20, 1]);
  // Başka siparişe yazmak sınırı aşmaz: hak kullanıcınındır
  assert.deepEqual(await addNote(db, { orderId: 'o2', actor: cust(1), text: 'x', limits, secret: SECRET, translator: p.fn, now: at(21 * MIN + 100) }), { ok: false, code: 'RATE_LIMIT' });
});

test('iç ekip (yönetici, satış, çizim): kullanıcı başına 10 dakikada 60 not — 61. reddedilir; müşteri sınırından ayrıdır; iç not da sayılır', async () => {
  for (const role of ['ADMIN', 'SATIS', 'CIZIM']) {
    const db = fakeDb({ settings: null });
    const limits = createNoteLimits();
    const rs = [];
    for (let i = 0; i < 61; i++) rs.push(await add(db, staff(role), { limits, now: at(i * 100), internal: i % 2 === 0 }));
    assert.deepEqual([count(codes(rs), 'ok'), count(codes(rs), 'RATE_LIMIT'), codes(rs)[60]], [60, 1, 'RATE_LIMIT'], role);
    assert.equal(db.notes.length, 60, role);
    // Aynı roldeki başka kullanıcı ve müşteri kendi sınırındadır
    assert.equal((await add(db, staff(role, 2), { limits, now: at(7000) })).ok, true, role);
    assert.equal((await add(db, cust(1), { limits, now: at(7000) })).ok, true, role);
    assert.equal((await add(db, staff(role), { limits, now: at(10 * MIN + 6100) })).ok, true, `${role}: pencere sonrası`);
  }
  // Not yazamayan rol (denetimci): yetki hatası; sınır sayacına dokunmaz
  const db = fakeDb({ settings: null });
  const limits = createNoteLimits();
  for (let i = 0; i < 30; i++) assert.deepEqual(await add(db, inspector, { limits }), { ok: false, code: 'FORBIDDEN' });
  assert.equal(db.notes.length, 0);
});

test('paralel istekler not hızı sınırını aşamaz: aynı anda 100 istek → tam 20 not', async () => {
  const db = fakeDb({ settings: null });
  const limits = createNoteLimits();
  const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => add(db, cust(1), { limits, orderId: i % 2 ? 'o1' : 'o2', text: `not ${i}` })));
  assert.deepEqual([count(codes(rs), 'ok'), count(codes(rs), 'RATE_LIMIT')], [20, 80]);
  assert.equal(db.notes.length, 20);
  const s = await Promise.all(Array.from({ length: 150 }, () => add(db, staff('SATIS'), { limits })));
  assert.deepEqual([count(codes(s), 'ok'), count(codes(s), 'RATE_LIMIT')], [60, 90]);
});

test('sipariş başına 500 not: 500. yazılır, 501. reddedilir (ORDER_LIMIT); iç notlar da sayılır; başka sipariş etkilenmez', async () => {
  const db = fakeDb({ settings: null });
  db.seed('o1', 300);
  db.seed('o1', 198, { internal: true });
  const limits = createNoteLimits();
  assert.equal((await add(db, cust(1), { limits })).ok, true, '499.');
  assert.equal((await add(db, staff('SATIS'), { limits, internal: true })).ok, true, '500.');
  assert.equal(db.notes.filter((n) => n.orderId === 'o1').length, 500);
  for (const actor of [cust(1), cust(2), staff('ADMIN'), staff('SATIS'), staff('CIZIM')]) {
    assert.deepEqual(await add(db, actor, { limits }), { ok: false, code: 'ORDER_LIMIT' }, actor.id);
    assert.deepEqual(await add(db, actor, { limits, internal: true }), { ok: false, code: 'ORDER_LIMIT' }, actor.id);
  }
  assert.equal(db.notes.filter((n) => n.orderId === 'o1').length, 500);
  assert.equal((await add(db, cust(1), { limits, orderId: 'o2' })).ok, true, 'başka sipariş');
  // Dolu siparişe çeviri açıkken yazma denemesi sağlayıcıyı çağırmaz ve çeviri hakkı harcamaz
  const full = fakeDb();
  full.seed('o1', 500);
  const p = provider();
  const l2 = createNoteLimits({ ...NOTE_LIMITS, customerTranslations: { limit: 3, windowMs: 60 * MIN } });
  for (let i = 0; i < 5; i++) assert.deepEqual(await add(full, cust(1), { limits: l2, translator: p.fn }), { ok: false, code: 'ORDER_LIMIT' });
  assert.equal(p.calls.length, 0);
  // (çeviri sınırı burada 3: dolu siparişe yapılan 5 deneme hak harcasaydı aşağıdaki notlar çevrilmezdi)
  for (let i = 0; i < 3; i++) assert.equal((await add(full, cust(1), { limits: l2, translator: p.fn, orderId: 'o2' })).translation, 'DONE');
  assert.equal((await add(full, cust(1), { limits: l2, translator: p.fn, orderId: 'o2' })).translation, 'FAILED');
  assert.equal(p.calls.length, 3);
});

test('paralel istekler sipariş sınırını aşamaz: 495 notlu siparişe aynı anda 40 farklı kullanıcıdan 80 istek → tam 5 not, toplam 500', async () => {
  const db = fakeDb({ settings: null });
  db.seed('o1', 495);
  const limits = createNoteLimits();
  const actors = Array.from({ length: 40 }, (_, i) => (i % 2 ? cust(i + 10) : staff('SATIS', i + 10)));
  const rs = await Promise.all(actors.flatMap((a) => [add(db, a, { limits }), add(db, a, { limits, internal: true })]));
  assert.deepEqual([count(codes(rs), 'ok'), count(codes(rs), 'ORDER_LIMIT')], [5, 75]);
  assert.equal(db.notes.filter((n) => n.orderId === 'o1').length, 500, 'sınırın üstüne çıkılmadı');
  // Çeviri açıkken de: sınırı geçemeyen istek için sağlayıcı çağrılmaz
  const db2 = fakeDb();
  db2.seed('o1', 497);
  const p = provider();
  const rs2 = await Promise.all(Array.from({ length: 30 }, (_, i) => add(db2, cust(i + 100), { limits: createNoteLimits(), translator: p.fn })));
  assert.deepEqual([count(codes(rs2), 'ok'), count(codes(rs2), 'ORDER_LIMIT'), db2.notes.length, p.calls.length], [3, 27, 500, 3]);
});

test('müşteri çevirisi: kullanıcı başına saatte 30 sağlayıcı çağrısı — sonraki notlar YİNE kaydedilir, sağlayıcı çağrılmaz, not "RATE_LIMIT" ile işaretlenir', async () => {
  const db = fakeDb();
  const limits = createNoteLimits();
  const p = provider();
  const o = (ms, i) => add(db, cust(1), { limits, translator: p.fn, now: at(ms), text: `Nota ${i}` });
  // Gerçek sınırlarla: 10 dakikada 20 not → ilk 20 not (20 çağrı), 10 dakika sonra 20 not daha (yalnızca 10 çağrı kalır)
  const a = [];
  for (let i = 0; i < 20; i++) a.push(await o(i * 1000, i));
  assert.deepEqual([count(a.map((r) => r.translation), 'DONE'), p.calls.length], [20, 20]);
  const b = [];
  for (let i = 0; i < 20; i++) b.push(await o(10 * MIN + 20_000 + i * 1000, 20 + i));
  assert.equal(count(codes(b), 'ok'), 20, 'çeviri sınırı notu ENGELLEMEZ');
  assert.deepEqual(b.map((r) => r.translation), [...Array(10).fill('DONE'), ...Array(10).fill('FAILED')]);
  assert.equal(p.calls.length, 30, 'tam 30 sağlayıcı çağrısı');
  assert.equal(db.notes.length, 40, 'bütün notlar kayıtlı');
  const limited = db.notes.slice(30);
  for (const n of limited) {
    assert.deepEqual([n.text.startsWith('Nota '), n.internal, n.translation, n.translationLang, n.translationStatus, n.translationError], [true, false, null, 'tr', 'FAILED', 'RATE_LIMIT']);
  }
  assert.deepEqual(db.notes.slice(0, 30).map((n) => n.translationStatus), Array(30).fill('DONE'));
  // Başka müşteri kullanıcısının çeviri hakkı ayrıdır
  assert.equal((await add(db, cust(2), { limits, translator: p.fn, now: at(10 * MIN + 50_000) })).translation, 'DONE');
  assert.equal(p.calls.length, 31);
  // İlk çağrıların üzerinden bir saat geçince hak yeniden açılır
  const later = await o(61 * MIN, 99);
  assert.deepEqual([later.ok, later.translation], [true, 'DONE']);
  assert.equal(p.calls.length, 32);
});

test('paralel istekler çeviri sınırını aşamaz: aynı anda 100 müşteri notu → hepsi kaydedilir, tam 30 sağlayıcı çağrısı', async () => {
  const db = fakeDb();
  // Not hızı bu testte geniş tutulur (yalnızca çeviri sınırı sınanır)
  const limits = createNoteLimits({ ...NOTE_LIMITS, customerNotes: { limit: 1000, windowMs: 10 * MIN }, perOrder: 5000 });
  let open = 0;
  let peak = 0;
  const p = provider(async ({ text, target }) => { open += 1; peak = Math.max(peak, open); await new Promise((r) => setImmediate(r)); open -= 1; return { text: `[${target}] ${text}` }; });
  const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => add(db, cust(1), { limits, translator: p.fn, text: `Nota ${i}`, orderId: i % 2 ? 'o1' : 'o2' })));
  assert.equal(count(codes(rs), 'ok'), 100);
  assert.deepEqual([count(rs.map((r) => r.translation), 'DONE'), count(rs.map((r) => r.translation), 'FAILED')], [30, 70]);
  assert.equal(p.calls.length, 30);
  assert.equal(db.notes.filter((n) => n.translationError === 'RATE_LIMIT' && n.translationStatus === 'FAILED').length, 70);
  assert.ok(peak <= 30);
});

test('çeviri hakkı yalnızca sağlayıcı gerçekten çağrılacaksa harcanır: çeviri kapalıyken, iç notta ve iç ekibin notunda harcanmaz', async () => {
  const limits = createNoteLimits({ ...NOTE_LIMITS, customerNotes: { limit: 1000, windowMs: 10 * MIN } });
  const p = provider();
  // Çeviri kapalı: 40 müşteri notu, çağrı yok, hak durur
  const off = fakeDb({ settings: { enabled: false, keySealed: READY.keySealed } });
  for (let i = 0; i < 40; i++) assert.deepEqual(await add(off, cust(1), { limits, translator: p.fn }), { ok: true, noteId: `n${i + 1}`, translation: null, outboxId: `ob${i + 1}` });
  assert.equal(p.calls.length, 0);
  assert.deepEqual(off.notes.map((n) => n.translationStatus), Array(40).fill(null));
  const on = fakeDb();
  for (let i = 0; i < 30; i++) assert.equal((await add(on, cust(1), { limits, translator: p.fn })).translation, 'DONE');
  assert.equal(p.calls.length, 30);
  assert.equal((await add(on, cust(1), { limits, translator: p.fn })).translation, 'FAILED');
  assert.equal(p.calls.length, 30);
  // İç ekibin müşteriye açık notu Romenceye çevrilir; müşteri çeviri sınırına takılmaz (not hızı sınırı içinde)
  const sp = provider();
  const l2 = createNoteLimits();
  const s = fakeDb();
  for (let i = 0; i < 60; i++) assert.equal((await add(s, staff('SATIS'), { limits: l2, translator: sp.fn, text: 'Merhaba' })).translation, 'DONE');
  assert.deepEqual([sp.calls.length, new Set(sp.calls.map((c) => c.target)).size, sp.calls[0].target], [60, 1, 'ro']);
});

test('iç not sağlayıcıyı hiç çağırmaz (sınırdan önce de sonra da); çeviri alanı yazılmaz', async () => {
  const db = fakeDb();
  const limits = createNoteLimits();
  const p = provider();
  for (const role of ['ADMIN', 'SATIS', 'CIZIM']) {
    for (let i = 0; i < 20; i++) assert.deepEqual((await add(db, staff(role), { limits, translator: p.fn, internal: true })).translation, null, role);
  }
  assert.equal(p.calls.length, 0);
  assert.deepEqual([db.notes.length, db.notes.every((n) => n.internal && n.translationStatus === null && n.translationLang === null)], [60, true]);
  // Müşteri "iç not" işaretleyemez: notu müşteriye açık nottur ve çevrilir
  const r = await add(db, cust(1), { limits, translator: p.fn, internal: true });
  assert.deepEqual([r.translation, db.notes.at(-1).internal, p.calls.length], ['DONE', false, 1]);
});

test('sağlayıcı hatası notu kaybettirmez: not kayıtlıdır, güvenli kod yazılır; hata da bir sağlayıcı çağrısıdır (hak harcar)', async () => {
  const db = fakeDb();
  const limits = createNoteLimits({ ...NOTE_LIMITS, customerNotes: { limit: 1000, windowMs: 10 * MIN } });
  const failing = provider(async () => { throw new TranslateError('QUOTA'); });
  const rs = await quiet(async () => { const out = []; for (let i = 0; i < 35; i++) out.push(await add(db, cust(1), { limits, translator: failing.fn, text: `Nota ${i}` })); return out; });
  assert.equal(count(codes(rs), 'ok'), 35, 'hiçbir not kaybolmadı');
  assert.equal(db.notes.length, 35);
  assert.equal(failing.calls.length, 30, 'başarısız çağrı da sayılır; 31. nottan sonra sağlayıcı çağrılmaz');
  assert.deepEqual(db.notes.map((n) => n.translationError), [...Array(30).fill('QUOTA'), ...Array(5).fill('RATE_LIMIT')]);
  assert.ok(db.notes.every((n) => n.translationStatus === 'FAILED' && n.translation === null && n.text.startsWith('Nota ')));
});

test('hız sınırı yüzünden çevrilmeyen not: iç ekip nedenini güvenli kodla görür; müşteri ve denetimci çeviri alanı almaz; okuma (yenileme) sağlayıcıyı çağırmaz', async () => {
  const db = fakeDb();
  const limits = createNoteLimits({ ...NOTE_LIMITS, customerTranslations: { limit: 1, windowMs: 60 * MIN } });
  const p = provider();
  await add(db, cust(1), { limits, translator: p.fn, text: 'Prima notă' });
  const r = await add(db, cust(1), { limits, translator: p.fn, text: 'A doua notă' });
  assert.deepEqual([r.ok, r.translation, p.calls.length], [true, 'FAILED', 1]);
  const row = db.notes.find((n) => n.id === r.noteId);
  assert.deepEqual(translationState(row, at(1000)), { state: 'failed', code: 'RATE_LIMIT' });
  const seen = (role) => notesFor(role, db.notes.map((n) => ({ ...n }))).find((n) => n.id === r.noteId);
  for (const role of ['ADMIN', 'SATIS', 'CIZIM']) {
    const n = seen(role);
    assert.deepEqual([n.text, n.translation, n.translationLang, n.translationStatus, n.translationError], ['A doua notă', null, 'tr', 'FAILED', 'RATE_LIMIT'], role);
  }
  for (const role of ['MUSTERI', 'DENETIMCI']) {
    const n = seen(role);
    assert.deepEqual([n.text, n.translation, n.translationLang, n.translationStatus, n.translationError, n.translationAt], ['A doua notă', null, null, null, null, null], role);
  }
  // Okuma saf işlevdir: kaç kez okunursa okunsun sağlayıcı çağrılmaz, kayıt değişmez
  const before = JSON.stringify(db.notes);
  for (let i = 0; i < 50; i++) for (const role of ['ADMIN', 'SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI']) notesFor(role, db.notes.map((n) => ({ ...n })));
  assert.deepEqual([p.calls.length, JSON.stringify(db.notes)], [1, before]);
  // Müşteri yeniden deneyemez; iç ekip "yeniden dene" ile çevirtir (mevcut denetimli yol)
  assert.deepEqual(await retryNoteTranslation(db, { noteId: r.noteId, orderId: 'o1', actor: cust(1), limits, secret: SECRET, translator: p.fn, now: at(2000) }), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(await retryNoteTranslation(db, { noteId: r.noteId, orderId: 'o1', actor: inspector, limits, secret: SECRET, translator: p.fn, now: at(2000) }), { ok: false, code: 'FORBIDDEN' });
  assert.equal(p.calls.length, 1);
  assert.deepEqual(await retryNoteTranslation(db, { noteId: r.noteId, orderId: 'o1', actor: staff('SATIS'), limits, secret: SECRET, translator: p.fn, now: at(3000) }), { ok: true, translation: 'DONE' });
  const done = db.notes.find((n) => n.id === r.noteId);
  assert.deepEqual([done.translationStatus, done.translation, done.translationError, p.calls.length], ['DONE', '[tr] A doua notă', null, 2]);
  assert.equal(db.audits.at(-1).details.beforeError, 'RATE_LIMIT');
});

test('"yeniden dene": kullanıcı başına 10 dakikada 20 sağlayıcı çağrısı — 21. reddedilir, nota dokunulmaz, sağlayıcı çağrılmaz; pencere sonrası yeniden', async () => {
  const db = fakeDb();
  const limits = createNoteLimits();
  const failing = provider(async () => { throw new TranslateError('TIMEOUT'); });
  const first = await quiet(() => add(db, cust(1), { limits, translator: failing.fn, text: 'Nota care nu se traduce' }));
  assert.equal(first.translation, 'FAILED');
  const retry = (actor, ms, translator = failing.fn) => quiet(() => retryNoteTranslation(db, { noteId: first.noteId, orderId: 'o1', actor, limits, secret: SECRET, translator, now: at(ms) }));
  const sales = staff('SATIS');
  const rs = [];
  for (let i = 0; i < 20; i++) rs.push(await retry(sales, 1000 + i * 100));
  assert.deepEqual(rs, Array(20).fill({ ok: true, translation: 'FAILED' }));
  assert.equal(failing.calls.length, 21, 'ilk çeviri + 20 yeniden deneme');
  const audits = db.audits.length;
  const row = () => JSON.stringify(db.notes.find((n) => n.id === first.noteId));
  const before = row();
  for (let i = 0; i < 5; i++) assert.deepEqual(await retry(sales, 4000 + i), { ok: false, code: 'RATE_LIMIT' });
  assert.deepEqual([failing.calls.length, db.audits.length, row()], [21, audits, before], 'çağrı yok, denetim kaydı yok, not aynı');
  // Sınır kullanıcı başınadır: başka iç ekip kullanıcısı deneyebilir
  assert.deepEqual(await retry(staff('ADMIN'), 5000), { ok: true, translation: 'FAILED' });
  assert.equal(failing.calls.length, 22);
  // 10 dakika sonra yeniden; bu kez çeviri başarılı
  const ok = provider();
  assert.deepEqual(await retry(sales, 10 * MIN + 1000, ok.fn), { ok: true, translation: 'DONE' });
  assert.equal(ok.calls.length, 1);
  // Tamamlanmış çeviri yeniden yapılamaz (mevcut kural): sağlayıcı çağrılmaz
  assert.deepEqual(await retry(sales, 10 * MIN + 2000, ok.fn), { ok: false, code: 'NOT_ALLOWED' });
  assert.equal(ok.calls.length, 1);
});

test('paralel "yeniden dene": 60 çevrilemeyen nota aynı anda istek → tam 20 sağlayıcı çağrısı; kalan notlar olduğu gibi (yeniden denenebilir) kalır', async () => {
  const db = fakeDb();
  db.seed('o1', 60, { translationLang: 'tr', translationStatus: 'FAILED', translationError: 'RATE_LIMIT', translationAt: at(0) });
  const limits = createNoteLimits();
  const p = provider();
  const ids = db.notes.map((n) => n.id);
  const rs = await Promise.all(ids.map((noteId) => retryNoteTranslation(db, { noteId, orderId: 'o1', actor: staff('CIZIM'), limits, secret: SECRET, translator: p.fn, now: at(1000) })));
  assert.deepEqual([count(codes(rs), 'ok'), count(codes(rs), 'RATE_LIMIT'), p.calls.length], [20, 40, 20]);
  assert.deepEqual([db.notes.filter((n) => n.translationStatus === 'DONE').length, db.notes.filter((n) => n.translationStatus === 'FAILED' && n.translationError === 'RATE_LIMIT').length], [20, 40]);
  // Çeviri kapalıyken ya da not bulunamadığında "yeniden dene" hakkı harcanmaz
  const off = fakeDb({ settings: { enabled: false, keySealed: READY.keySealed } });
  off.seed('o1', 1, { translationLang: 'tr', translationStatus: 'FAILED', translationError: 'RATE_LIMIT', translationAt: at(0) });
  const l2 = createNoteLimits();
  for (let i = 0; i < 30; i++) {
    assert.deepEqual(await retryNoteTranslation(off, { noteId: off.notes[0].id, orderId: 'o1', actor: staff('SATIS'), limits: l2, secret: SECRET, translator: p.fn, now: at(1000) }), { ok: false, code: 'DISABLED' });
    assert.deepEqual(await retryNoteTranslation(off, { noteId: 'yok', orderId: 'o1', actor: staff('SATIS'), limits: l2, secret: SECRET, translator: p.fn, now: at(1000) }), { ok: false, code: 'NOT_FOUND' });
  }
  assert.equal(l2.retry(staff('SATIS'), T0 + 1000), true, 'hak duruyor');
});

test('sipariş kapsamı ve yetkiler değişmedi: başka firmanın siparişi NOT_FOUND, boş not EMPTY, denetimci FORBIDDEN — sınır dolu olsa da başka firmanın siparişi görünmez', async () => {
  const db = fakeDb();
  const limits = createNoteLimits();
  const p = provider();
  assert.deepEqual(await add(db, cust(1), { limits, translator: p.fn, orderId: 'oB' }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await add(db, cust(9, 'B'), { limits, translator: p.fn, orderId: 'o1' }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await add(db, cust(1), { limits, translator: p.fn, orderId: 'yok' }), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(await add(db, cust(1), { limits, translator: p.fn, text: '   ' }), { ok: false, code: 'EMPTY' });
  assert.deepEqual(await add(db, inspector, { limits, translator: p.fn }), { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual([db.notes.length, p.calls.length], [0, 0]);
  // Boş not ve yetkisiz istek hak harcamaz; bulunamayan siparişe yapılan iki deneme (oB, yok) kullanıcının KENDİ hakkından
  // düşer: 20 haktan 18'i kalır
  const own = [];
  for (let i = 0; i < 20; i++) own.push(await add(db, cust(1), { limits, translator: p.fn }));
  assert.deepEqual([count(codes(own), 'ok'), count(codes(own), 'RATE_LIMIT')], [18, 2]);
  // Sınır dolduktan sonra: kendi siparişi de başkasınınki de aynı yanıtı verir (sipariş varlığı sızmaz), not yazılmaz
  assert.deepEqual(await add(db, cust(1), { limits, translator: p.fn, orderId: 'oB' }), { ok: false, code: 'RATE_LIMIT' });
  assert.deepEqual(await add(db, cust(1), { limits, translator: p.fn, orderId: 'yok' }), { ok: false, code: 'RATE_LIMIT' });
  assert.equal(db.notes.filter((n) => n.orderId === 'oB').length, 0);
});

test('kullanıcı iletileri: iki dilde vardır, anlaşılırdır ve sayı / sınır ayrıntısı içermez', () => {
  for (const key of ['order.errors.noteRateLimit', 'order.errors.noteOrderLimit', 'order.notes.translation.retryLimit', 'order.notes.translation.reason.RATE_LIMIT']) {
    for (const lang of ['ro', 'tr']) {
      const text = translate(lang, key);
      assert.ok(typeof text === 'string' && text.length > 20 && text !== key, `${lang} ${key}`);
      assert.equal(/\d/.test(text), false, `${lang} ${key}: sayı yok`);
      assert.equal(/limit|rate|Google|RATE_LIMIT|ORDER_LIMIT/i.test(text.replace(/limita de traduceri/i, '')), false, `${lang} ${key}: iç ayrıntı yok`);
    }
  }
  assert.equal(translate('ro', 'order.errors.noteRateLimit'), 'Ați trimis prea multe note într-un timp scurt. Vă rugăm să încercați din nou peste câteva minute.');
  assert.equal(translate('ro', 'order.errors.noteOrderLimit'), 'Această comandă a atins numărul maxim de note; nu se mai pot adăuga note noi.');
});

test('sınırlar tek yerde, sunucuda: notu yazan tek kod addNote; sıra — hak → kapsam → kilit → sayım → kayıt; sağlayıcı işlemden sonra', () => {
  const svc = strip(read('server/notes/translation.js'));
  const body = svc.slice(svc.indexOf('export async function addNote('), svc.indexOf('export async function retryNoteTranslation('));
  const order = ["can(actor?.role, 'NOTE_ADD')", 'limits.note(actor, now.getTime())', 'db.order.findFirst(', 'db.$transaction(', 'pg_advisory_xact_lock(hashtextextended(${`order-notes:${order.id}`}, 0))',
    'tx.orderNote.count({ where: { orderId: order.id } }) >= limits.perOrder', 'limits.translation(actor, now.getTime())', 'tx.orderNote.create(', "{ isolationLevel: 'ReadCommitted' }", 'await runTranslation(db, note, '];
  const pos = order.map((s) => body.indexOf(s));
  assert.ok(pos.every((i) => i >= 0), `eksik: ${order.filter((_, i) => pos[i] < 0).join(' | ')}`);
  assert.deepEqual(pos, [...pos].sort((a, b) => a - b), 'sıra');
  assert.equal(/db\.orderNote\.(create|count)\(/.test(body), false, 'sayım ve kayıt yalnızca kilitli işlemin içinde (tx)');
  // "Yeniden dene": hak, not sahiplenilmeden (PENDING yapılmadan) önce alınır
  const retry = svc.slice(svc.indexOf('export async function retryNoteTranslation('), svc.indexOf('export async function translateRevision('));
  assert.ok(retry.indexOf('limits.retry(actor, now.getTime())') > retry.indexOf('translateReady(settings)'));
  assert.ok(retry.indexOf('limits.retry(actor, now.getTime())') < retry.indexOf('db.orderNote.updateMany('));
  // Varsayılan sayaçlar uygulamanın ortak örneğidir; sunucu işlemi kendi sayaç / sınırını veremez (addNote,
  // retryNoteTranslation, translateRevision — revizyon notu müşterinin aynı çeviri hakkını kullanır, karar 163 —,
  // translateDrawingNote ve retryDrawingTranslation — çizim alanının notları, karar 168)
  // + translateOrderNote (siparişin ilk mesajı — karar 225): müşterinin aynı çeviri hakkı, sahiplenmeden önce
  assert.equal((svc.match(/limits = noteLimits/g) ?? []).length, 6);
  const first = svc.slice(svc.indexOf('export async function translateOrderNote('), svc.indexOf('export async function translateDrawingNote('));
  assert.ok(first.indexOf('translateReady(settings)') < first.indexOf('limits.translation(actor, now.getTime())'));
  assert.ok(first.indexOf('limits.translation(actor, now.getTime())') < first.indexOf("translationStatus: 'PENDING'"));
  const revision = svc.slice(svc.indexOf('export async function translateRevision('), svc.indexOf('export async function translateDrawingNote('));
  assert.ok(revision.includes('limits.translation(actor, now.getTime())'), 'revizyon notunun çevirisi müşterinin çeviri hakkından düşer');
  // Çizim alanı (karar 168): sürüm notunun çevirisi çeviri hakkından, "yeniden dene" yeniden deneme hakkından — ikisi de
  // not sahiplenilmeden (PENDING yapılmadan) ÖNCE alınır; hak yoksa sağlayıcı çağrılmaz
  const drawingNote = svc.slice(svc.indexOf('export async function translateDrawingNote('), svc.indexOf('export async function retryDrawingTranslation('));
  assert.ok(drawingNote.indexOf('translateReady(settings)') < drawingNote.indexOf('limits.translation(actor, now.getTime())'));
  assert.ok(drawingNote.indexOf('limits.translation(actor, now.getTime())') < drawingNote.indexOf("translationStatus: 'PENDING'"));
  const drawingRetry = svc.slice(svc.indexOf('export async function retryDrawingTranslation('), svc.indexOf('export async function testTranslation('));
  assert.ok(drawingRetry.indexOf('translateReady(settings)') < drawingRetry.indexOf('limits.retry(actor, now.getTime())'));
  assert.ok(drawingRetry.indexOf('limits.retry(actor, now.getTime())') < drawingRetry.indexOf('db[table].updateMany('));
  const actions = strip(read('app/(panel)/siparisler/[id]/actions.ts'));
  assert.equal(/limits\s*:|createNoteLimits|note-?limits|notes\/limits/i.test(actions), false);
  assert.ok(actions.includes("r.code === 'RATE_LIMIT' ? 'order.errors.noteRateLimit'") && actions.includes("r.code === 'ORDER_LIMIT' ? 'order.errors.noteOrderLimit'"));
  assert.ok(actions.includes("r.code === 'RATE_LIMIT' ? 'order.notes.translation.retryLimit'"));
  // Not kaydı yazan başka kod yok; sınır modülünü yalnızca çeviri servisi kullanır
  const walk = (dir, exts) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, exts) : exts.test(e.name) ? [p] : [];
  });
  const files = walk('app', /\.tsx?$/).concat(walk('lib', /\.tsx?$/), walk('components', /\.tsx?$/), walk('server', /\.js$/), walk('scripts', /\.m?js$/));
  // (scripts/demo/seed.mjs: demo veritabanını dolduran komut — istekle çalışmaz, birkaç örnek not yazar)
  assert.deepEqual(files.filter((f) => /orderNote\.(create|createMany|upsert)\(/.test(strip(read(f)))).sort(), [path.join('scripts', 'demo', 'seed.mjs'), path.join('server', 'notes', 'translation.js')]);
  assert.deepEqual(files.filter((f) => /notes\/limits(\.js)?['"]|from '\.\/limits\.js'/.test(read(f))), [path.join('server', 'notes', 'translation.js')]);
  // Sınır modülü saf: yalnızca ortak sınırlayıcıyı ve rol kuralını yükler; ağ / veritabanı / ortam yok
  const lim = read('server/notes/limits.js');
  assert.deepEqual([...lim.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['../security/rate-limit.js', './view.js']);
  assert.equal(/\bfetch\s*\(|process\.env|getEnv|prisma/i.test(strip(lim)), false);
});
