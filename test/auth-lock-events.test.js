// Kilit olayı = kilidi oluşturan deneme; reddedilen istek hiçbir şey yazmaz (karar 149; güvenlik denetimi 3.50.9 AUD-11).
// Gerçek servisler (server/auth/attempts.js, lock-events.js, invite-claim.js, bildirim yazıcısı) bellekte sahte veritabanıyla
// çalışır. Sahte veritabanı her sorguda bir "tık" bekler (paralel istekler araya girer), danışma kilidini anahtarına göre
// sıraya sokar, bildirimde [userId, dedupeKey] benzersizliğini uygular ve HER sorguyu kaydeder (okuma / yazma) — "kilitli
// istek yazma yapmaz" doğrudan bu kayıttan denetlenir. Aynı senaryolar gerçek PostgreSQL ile: test/db/auth-lock-events.test.js.
// E-posta gönderilmez; ağ isteği yoktur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserveAttempt, runAttempt } from '../server/auth/attempts.js';
import { verifyInviteCode } from '../server/auth/invite-claim.js';
import { MAX_ATTEMPTS, createInvite } from '../server/auth/inviteCode.js';
import { CODE_FAILED_ACTION, LOCK_ACTION, LOCK_NOTICE, lockAuditEntry, lockNoticeKey, recordCodeFailure, recordLock } from '../server/auth/lock-events.js';
import { LIMITS, LOCK_SCOPES, WINDOW_MS, filledScopes, throttleState } from '../server/auth/throttle.js';
import { AUDIENCE_ROLES, renderInApp } from '../server/notifications/inapp.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const SECRET = 'b'.repeat(40);
const TZ = 'Europe/Bucharest';
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 7, 9, 0, 0); // 07.10.2026 12:00 (Bükreş)
const at = (ms) => new Date(T0 + ms);
const tick = () => new Promise((r) => setImmediate(r));
const tally = (list, v) => list.filter((x) => x === v).length;
const result = (r) => (r.locked ? 'locked' : r.outcome.ok ? 'ok' : 'invalid');
const quiet = () => {};

const OPS = { not: (a, x) => (x === null ? a !== null && a !== undefined : a !== x), lt: (a, x) => a < x, lte: (a, x) => a <= x, gt: (a, x) => a > x, gte: (a, x) => a >= x, in: (a, x) => x.includes(a) };
const match = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return v.some((w) => match(row, w));
  if (v === null) return row[k] === null || row[k] === undefined;
  if (v instanceof Date) return +row[k] === +v;
  if (v && typeof v === 'object') return Object.entries(v).every(([op, x]) => { if (!OPS[op]) throw new Error(`sahte veritabanı: bilinmeyen işleç ${op}`); return OPS[op](row[k], x); });
  return row[k] === v;
});

/** Bellekte sahte veritabanı. st.ops: yapılan her sorgu ({ name, write }); st.failOn: hata fırlatacak sorgu adları */
function fakeDb({ users = [], invites = [], failures = [] } = {}) {
  const st = {
    users: users.map((u, i) => ({ id: `k${i + 1}`, isActive: true, passwordHash: 'ozet', name: null, appRole: 'MUSTERI', ...u })),
    invites: invites.map((v, i) => ({ id: `davet${i + 1}`, attempts: 0, usedAt: null, sentAt: at(-MIN), createdAt: at(-MIN), ...v })),
    failures: failures.map((f, i) => ({ id: `eski${i + 1}`, kind: 'LOGIN', ...f })),
    audit: [], notifications: [], ops: [], failOn: new Set(), seq: 0,
  };
  const queues = new Map();
  const step = async (name, write) => {
    await tick();
    st.ops.push({ name, write });
    // Hata iletisi bilerek bir e-posta taşır: günlüğe iletinin değil yalnızca hata türünün yazıldığı denetlenir
    if (st.failOn.has(name)) throw Object.assign(new Error(`sahte hata (${name}) sizdirma@ornek.test`), { code: 'P9999' });
  };
  const lockOn = async (key, held) => {
    const before = queues.get(key) ?? Promise.resolve();
    let release;
    queues.set(key, before.then(() => new Promise((r) => { release = r; })));
    await before;
    held.push(release);
  };
  const keyOfRaw = (strings, values) => { assert.match(strings.join('?'), /^SELECT pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)$/); return String(values[0]); };
  const model = {
    user: {
      async findUnique({ where }) { await step('user.findUnique', false); const u = st.users.find((x) => (where.email !== undefined ? x.email === where.email : x.id === where.id)); return u ? { ...u } : null; },
      async findMany({ where }) { await step('user.findMany', false); return st.users.filter((u) => match(u, where)).map((u) => ({ ...u })); },
    },
    userInvite: {
      async findFirst({ where }) { await step('userInvite.findFirst', false); const rows = st.invites.filter((i) => match(i, where)).sort((a, b) => b.createdAt - a.createdAt); return rows[0] ? { ...rows[0] } : null; },
      async updateMany({ where, data }) {
        await step('userInvite.updateMany', true);
        let n = 0;
        for (const i of st.invites) {
          if (!match(i, where)) continue;
          n += 1;
          if (data.attempts?.increment) i.attempts += data.attempts.increment;
          if (data.attempts?.decrement) i.attempts -= data.attempts.decrement;
        }
        return { count: n };
      },
    },
    authFailure: {
      async findMany({ where }) { await step('authFailure.findMany', false); return st.failures.filter((f) => match(f, where)).map((f) => ({ ...f })); },
      async create({ data }) { await step('authFailure.create', true); const row = { id: `d${++st.seq}`, ...data }; st.failures.push(row); return { id: row.id }; },
      async updateMany({ where, data }) { await step('authFailure.updateMany', true); let n = 0; for (const f of st.failures) if (match(f, where)) { Object.assign(f, data); n += 1; } return { count: n }; },
      async deleteMany({ where }) { await step('authFailure.deleteMany', true); const gone = st.failures.filter((f) => match(f, where)); st.failures = st.failures.filter((f) => !gone.includes(f)); return { count: gone.length }; },
    },
    auditLog: {
      async create({ data }) { await step('auditLog.create', true); const row = { id: `kayit${st.audit.length + 1}`, ...data }; st.audit.push(row); return row; },
    },
    notification: {
      // Tek adım: [userId, dedupeKey] benzersiz; skipDuplicates → var olan atlanır (PostgreSQL: ON CONFLICT DO NOTHING)
      async createMany({ data, skipDuplicates }) {
        await step('notification.createMany', true);
        let n = 0;
        for (const row of data) {
          const dup = st.notifications.some((x) => x.userId === row.userId && x.dedupeKey === row.dedupeKey);
          if (dup && !skipDuplicates) throw Object.assign(new Error('benzersizlik ihlali'), { code: 'P2002' });
          if (dup) continue;
          st.notifications.push({ ...row });
          n += 1;
        }
        return { count: n };
      },
    },
  };
  return {
    ...model, st,
    async $executeRaw(strings, ...values) { const held = []; await lockOn(keyOfRaw(strings, values), held); for (const r of held) r(); return 1; },
    async $transaction(fn) {
      const held = [];
      const tx = { ...model, async $executeRaw(strings, ...values) { await lockOn(keyOfRaw(strings, values), held); return 1; } };
      try {
        return await fn(tx);
      } finally {
        for (const r of held) r();
      }
    },
  };
}
const writes = (db, from = 0) => db.st.ops.slice(from).filter((o) => o.write).map((o) => o.name);
const names = (db, from = 0) => [...new Set(db.st.ops.slice(from).map((o) => o.name))].sort();
const lockRows = (db) => db.st.audit.filter((a) => a.action === LOCK_ACTION);
const codeRows = (db) => db.st.audit.filter((a) => a.action === CODE_FAILED_ACTION);

const E = 'hedef@ornek.test';
const IP = '198.51.100.7';
const TARGET = { id: 'hedef', email: E, name: 'Hedef Kişi', appRole: 'MUSTERI' };
const STAFF = [
  { id: 'y1', email: 'yonetici1@fabrika.test', name: 'Yönetici Bir', appRole: 'ADMIN' },
  { id: 'y2', email: 'yonetici2@fabrika.test', name: 'Yönetici İki', appRole: 'ADMIN' },
  { id: 'y3', email: 'eski-yonetici@fabrika.test', name: 'Pasif Yönetici', appRole: 'ADMIN', isActive: false },
  { id: 'yy1', email: 'yardimci@fabrika.test', name: 'Yönetici Yardımcısı', appRole: 'YONETICI_YARDIMCISI' },
  { id: 's1', email: 'satis@fabrika.test', name: 'Satış', appRole: 'SATIS' },
  { id: 'c1', email: 'cizim@fabrika.test', name: 'Çizim', appRole: 'CIZIM' },
  { id: 'd1', email: 'denetim@fabrika.test', name: 'Denetim', appRole: 'DENETIMCI' },
  { id: 'm1', email: 'baska-musteri@ornek.test', name: 'Başka Müşteri', appRole: 'MUSTERI' },
];
const world = (extra = {}) => fakeDb({ users: [TARGET, ...STAFF], ...extra });

/** lib/auth/throttle.ts → runAttempt ile AYNI bileşim: deneme → (başarısız + sınırı doldurduysa) kilit olayı */
async function attempt(db, { kind = 'LOGIN', email = E, ip = IP, ok = false, now = at(0), wait = null, stats = null, log = quiet } = {}) {
  const r = await runAttempt(db, { kind, email, ip, now }, async () => { if (stats) stats.verified += 1; if (wait) await wait(); return { ok }; });
  if (!r.locked && r.filled?.length) await recordLock(db, { kind, email, ip, filled: r.filled, now, timeZone: TZ, log });
  return r;
}
/** app/setup/actions.ts → verifyCodeAction ile AYNI bileşim: kod denemesi → kilit olayı → (yanlış kod karşılaştırıldıysa) CODE_FAILED */
async function codeStep(db, { email, code, ip, now = at(0) }) {
  const r = await runAttempt(db, { kind: 'CODE', email, ip, now }, () => verifyInviteCode(db, { email, code, secret: SECRET, now }));
  if (!r.locked && r.filled?.length) await recordLock(db, { kind: 'CODE', email, ip, filled: r.filled, now, timeZone: TZ, log: quiet });
  if (!r.locked && !r.outcome.ok && r.outcome.reason === 'wrong_code') await recordCodeFailure(db, { email, ip, log: quiet });
  return r;
}
const times = (n, t = 0) => Array.from({ length: n }, () => T0 + t);

// ───────────────────────── saf kural: hangi sınır doldu ─────────────────────────

test('sınırı dolduran deneme: 4 → 5 (e-posta + IP), 19 → 20 (e-posta), 29 → 30 (IP); sınırlar ve pencere değişmedi', () => {
  assert.deepEqual([LIMITS, WINDOW_MS, [...LOCK_SCOPES]], [{ account: 5, email: 20, ip: 30 }, 15 * MIN, ['account', 'email', 'ip']]);
  const none = { account: [], email: [], ip: [] };
  assert.deepEqual(filledScopes(none, T0), []);
  // e-posta + IP
  assert.deepEqual(filledScopes({ ...none, account: times(3) }, T0), []);
  assert.deepEqual(filledScopes({ ...none, account: times(4) }, T0), ['account']);
  // e-posta geneli
  assert.deepEqual(filledScopes({ ...none, email: times(18) }, T0), []);
  assert.deepEqual(filledScopes({ ...none, email: times(19) }, T0), ['email']);
  // IP geneli
  assert.deepEqual(filledScopes({ ...none, ip: times(28) }, T0), []);
  assert.deepEqual(filledScopes({ ...none, ip: times(29) }, T0), ['ip']);
  // email verilmezse boş sayılır (throttleState ile aynı varsayılan)
  assert.deepEqual(filledScopes({ account: times(4), ip: times(29) }, T0), ['account', 'ip']);
});

test('birden çok sınır aynı anda dolarsa sonuç hep aynı sırayladır; zaten kilitli kapsam "dolan" sayılmaz; pencere dışı sayılmaz', () => {
  // Üçü birden
  assert.deepEqual(filledScopes({ account: times(4), email: times(19), ip: times(29) }, T0), ['account', 'email', 'ip']);
  assert.deepEqual(filledScopes({ ip: times(29), email: times(19), account: times(4) }, T0), ['account', 'email', 'ip'], 'girdi sırası sonucu değiştirmez');
  assert.deepEqual(filledScopes({ account: times(1), email: times(19), ip: times(29) }, T0), ['email', 'ip']);
  // Zaten dolu (kilitli) kapsam yeniden "dolmaz"
  assert.deepEqual(filledScopes({ account: times(5), email: times(19), ip: times(30) }, T0), ['email']);
  assert.deepEqual(filledScopes({ account: times(9), email: times(40), ip: times(60) }, T0), []);
  // Pencere dışındaki kayıtlar sayılmaz: 4 eski + 0 yeni → dolmaz; 3 eski + 4 yeni → dolar
  const old = times(4, -WINDOW_MS);
  assert.deepEqual(filledScopes({ account: old, email: [], ip: [] }, T0), []);
  assert.deepEqual(filledScopes({ account: [...times(3, -WINDOW_MS), ...times(4, -MIN)], email: [], ip: [] }, T0), ['account']);
  // Kural lockState / throttleState ile aynı sınırı kullanır: "dolduran" deneme eklenince durum kilitlidir, öncesinde değildir
  for (const [scope, n] of Object.entries(LIMITS)) {
    const before = { account: [], email: [], ip: [], [scope]: times(n - 1) };
    assert.equal(throttleState(before, T0).locked, false, scope);
    assert.equal(throttleState({ ...before, [scope]: times(n) }, T0).locked, true, scope);
    assert.deepEqual(filledScopes(before, T0), [scope]);
  }
});

// ───────────────────────── hak ayırma ve deneme sonucu ─────────────────────────

test('reserveAttempt dolan sınırı aynı sayımdan döndürür: 5. deneme "account", 20. "email", 30. "ip"', async () => {
  const pair = world();
  const a = [];
  for (let i = 0; i < 5; i++) a.push((await reserveAttempt(pair, { email: E, ip: IP, now: at(i) })).filled);
  assert.deepEqual(a, [[], [], [], [], ['account']]);
  // Aynı e-posta, her denemede başka IP: 20. deneme e-posta genelini doldurur
  const mail = world();
  const b = [];
  for (let i = 0; i < 20; i++) b.push((await reserveAttempt(mail, { email: E, ip: `203.0.113.${i + 1}`, now: at(i) })).filled);
  assert.deepEqual([b.slice(0, 19).flat(), b[19]], [[], ['email']]);
  assert.deepEqual(await reserveAttempt(mail, { email: E, ip: '203.0.113.99', now: at(30) }), { ok: false, minutes: 15 }, 'kilitli yanıtı eskisiyle aynı (dolan sınır bilgisi yok)');
  // Aynı IP, her denemede başka e-posta: 30. deneme IP genelini doldurur
  const ipDb = world();
  const c = [];
  for (let i = 0; i < 30; i++) c.push((await reserveAttempt(ipDb, { email: `kisi${i}@ornek.test`, ip: IP, now: at(i) })).filled);
  assert.deepEqual([c.slice(0, 29).flat(), c[29]], [[], ['ip']]);
  // İkisi birden: 4 hata bu IP'den + 15 hata başka IP'lerden → 20. deneme hem çifti hem e-posta genelini doldurur
  const both = world({ failures: [...Array.from({ length: 4 }, () => ({ email: E, ip: IP, createdAt: at(-MIN) })), ...Array.from({ length: 15 }, (_, i) => ({ email: E, ip: `203.0.113.${i + 1}`, createdAt: at(-MIN) }))] });
  assert.deepEqual((await reserveAttempt(both, { email: E, ip: IP, now: at(0) })).filled, ['account', 'email']);
});

test('runAttempt: yalnızca BAŞARISIZ biten ve sınırı dolduran deneme `filled` taşır; başarılı deneme kilit olayı üretmez', async () => {
  const four = () => world({ failures: Array.from({ length: 4 }, (_, i) => ({ email: E, ip: IP, createdAt: at(-MIN + i) })) });
  // Doldurmayan başarısız deneme: sonuç eskisiyle birebir aynı (alan hiç yok)
  assert.deepEqual(await runAttempt(world(), { kind: 'LOGIN', email: E, ip: IP, now: at(0) }, async () => ({ ok: false })), { locked: false, outcome: { ok: false } });
  // Dolduran + başarısız
  assert.deepEqual(await runAttempt(four(), { kind: 'LOGIN', email: E, ip: IP, now: at(0) }, async () => ({ ok: false })), { locked: false, outcome: { ok: false }, filled: ['account'] });
  assert.deepEqual(await runAttempt(four(), { kind: 'CODE', email: E, ip: IP, now: at(0) }, async () => ({ ok: false })), { locked: false, outcome: { ok: false }, filled: ['account'] });
  // Dolduran + BAŞARILI (5. denemede doğru şifre / doğru kod): alan yok
  assert.deepEqual(await runAttempt(four(), { kind: 'LOGIN', email: E, ip: IP, now: at(0) }, async () => ({ ok: true })), { locked: false, outcome: { ok: true } });
  assert.deepEqual(await runAttempt(four(), { kind: 'CODE', email: E, ip: IP, now: at(0) }, async () => ({ ok: true })), { locked: false, outcome: { ok: true } });
  // Kilitli: doğrulama çalışmaz, alan yok
  const full = world({ failures: Array.from({ length: 5 }, (_, i) => ({ email: E, ip: IP, createdAt: at(-MIN + i) })) });
  let called = 0;
  assert.deepEqual(await runAttempt(full, { kind: 'LOGIN', email: E, ip: IP, now: at(0) }, async () => { called += 1; return { ok: true }; }), { locked: true, minutes: 14 });
  assert.equal(called, 0);
});

// ───────────────────────── kilit olayı: bir kilit = bir kayıt ─────────────────────────

test('5 hatalı giriş → tam BİR LOGIN_LOCKED: kullanıcı kimliği, IP, tür ve kapsam; e-posta / şifre yok; bildirim yok', async () => {
  const db = world();
  const rs = [];
  for (let i = 0; i < 5; i++) rs.push(result(await attempt(db, { now: at(i * 1000) })));
  assert.deepEqual(rs, Array(5).fill('invalid'));
  assert.deepEqual(db.st.audit, [{ id: 'kayit1', action: 'LOGIN_LOCKED', entityType: 'User', entityId: 'hedef', userId: 'hedef', details: { ip: IP, kind: 'LOGIN', scopes: ['account'] }, actorRole: 'MUSTERI', ip: IP }]);
  assert.equal(db.st.notifications.length, 0, 'e-posta + IP kilidi yöneticiye bildirilmez');
  assert.equal(JSON.stringify(db.st.audit).includes(E), false, 'denenen e-posta kayda girmez');
});

test('zaten kilitliyken gelen 1000 istek: SIFIR yazma (denetim kaydı, bildirim, deneme satırı yok); yalnızca iki sayım sorgusu', async () => {
  const db = world();
  const stats = { verified: 0 };
  for (let i = 0; i < 5; i++) await attempt(db, { now: at(i * 1000), stats });
  assert.deepEqual([lockRows(db).length, db.st.failures.length, stats.verified], [1, 5, 5]);
  const mark = db.st.ops.length;
  const audit = JSON.stringify(db.st.audit);
  const rows = JSON.stringify(db.st.failures);
  // Art arda 700 + aynı anda 300 istek; doğru şifreyle de (kilit açmaz)
  const out = [];
  for (let i = 0; i < 700; i++) out.push(result(await attempt(db, { now: at(10_000 + i), ok: i % 2 === 0, stats })));
  out.push(...(await Promise.all(Array.from({ length: 300 }, (_, i) => attempt(db, { now: at(20_000 + i), ok: true, stats })))).map(result));
  assert.deepEqual([out.length, tally(out, 'locked')], [1000, 1000]);
  assert.deepEqual(writes(db, mark), [], 'kilitli istek hiçbir şey yazmaz');
  assert.deepEqual(names(db, mark), ['authFailure.findMany'], 'kilitli istek yalnızca sayar (kullanıcı sorgusu da yok)');
  assert.equal(db.st.ops.length - mark, 2000, 'istek başına iki sayım sorgusu');
  assert.deepEqual([JSON.stringify(db.st.audit), JSON.stringify(db.st.failures), db.st.notifications.length, stats.verified], [audit, rows, 0, 5]);
});

test('aynı anda 200 yanlış şifre (aynı e-posta + IP): 5 doğrulama, LOGIN_LOCKED tam BİR kez', async () => {
  const db = world();
  const stats = { verified: 0 };
  const rs = (await Promise.all(Array.from({ length: 200 }, (_, i) => attempt(db, { now: at(i), stats })))).map(result);
  assert.deepEqual([tally(rs, 'invalid'), tally(rs, 'locked'), stats.verified, db.st.failures.length], [5, 195, 5, 5]);
  assert.deepEqual(lockRows(db).map((a) => [a.entityId, a.details.scopes]), [['hedef', ['account']]]);
  assert.equal(db.st.audit.length, 1);
});

test('aynı e-posta, çok IP (aynı anda 60 istek): 20 doğrulama; e-posta geneli kilit tam BİR kez yazılır ve yöneticilere tam BİR bildirim gider', async () => {
  const db = world();
  const rs = (await Promise.all(Array.from({ length: 60 }, (_, i) => attempt(db, { ip: `203.0.113.${(i % 12) + 1}`, now: at(i) })))).map(result);
  assert.deepEqual([tally(rs, 'invalid'), tally(rs, 'locked'), db.st.failures.length], [20, 40, 20]);
  const mail = lockRows(db).filter((a) => a.details.scopes.includes('email'));
  assert.equal(mail.length, 1, 'e-posta geneli sınırı tek deneme doldurur');
  assert.deepEqual([mail[0].entityId, mail[0].userId, mail[0].details.kind], ['hedef', 'hedef', 'LOGIN']);
  // Bildirim: yalnızca etkin yöneticiler, kişi başına bir satır
  assert.deepEqual(db.st.notifications.map((n) => n.userId).sort(), ['y1', 'y2']);
  // Ardından gelen kilitli istekler ne kayıt ne bildirim üretir
  const [a, n] = [db.st.audit.length, db.st.notifications.length];
  for (let i = 0; i < 50; i++) assert.equal(result(await attempt(db, { ip: `203.0.113.${200 + i}`, now: at(1000 + i), ok: true })), 'locked');
  assert.deepEqual([db.st.audit.length, db.st.notifications.length], [a, n]);
});

test('sınırı dolduran deneme BAŞARILIYSA kilit de kayıt da oluşmaz; sonraki başarısız dolduran deneme tek kayıt üretir', async () => {
  // Giriş: 4 hata + 5. denemede doğru şifre → çiftin hataları temizlenir
  const login = world({ failures: Array.from({ length: 4 }, (_, i) => ({ email: E, ip: IP, createdAt: at(-MIN + i) })) });
  assert.equal(result(await attempt(login, { ok: true, now: at(0) })), 'ok');
  assert.deepEqual([login.st.audit.length, login.st.notifications.length, login.st.failures.length], [0, 0, 0]);
  // Kod: 4 hata + 5. denemede doğru kod → yalnızca kendi satırı silinir (4 kalır), kayıt yok; ardından yanlış kod sınırı doldurur
  const code = world({ failures: Array.from({ length: 4 }, (_, i) => ({ email: E, ip: IP, kind: 'CODE', createdAt: at(-MIN + i) })) });
  assert.equal(result(await attempt(code, { kind: 'CODE', ok: true, now: at(0) })), 'ok');
  assert.deepEqual([code.st.audit.length, code.st.failures.length], [0, 4]);
  assert.equal(result(await attempt(code, { kind: 'CODE', ok: false, now: at(1000) })), 'invalid');
  assert.deepEqual(lockRows(code).map((a) => a.details), [{ ip: IP, kind: 'CODE', scopes: ['account'] }]);
  // Süren (PENDING) 5. deneme yüzünden reddedilen istek kayıt üretmez; 5. deneme başarılı biterse hiç kayıt olmaz
  const racing = world({ failures: Array.from({ length: 4 }, (_, i) => ({ email: E, ip: IP, createdAt: at(-MIN + i) })) });
  let release;
  const gate = new Promise((r) => { release = r; });
  const fifth = attempt(racing, { ok: true, now: at(0), wait: () => gate });
  for (let i = 0; i < 50 && racing.st.failures.length < 5; i++) await tick();
  assert.equal(racing.st.failures.length, 5, 'beşinci deneme ayrıldı (doğrulaması sürüyor)');
  assert.equal(result(await attempt(racing, { now: at(1) })), 'locked');
  release();
  assert.equal(result(await fifth), 'ok');
  assert.deepEqual([racing.st.audit.length, racing.st.notifications.length], [0, 0]);
});

test('pencere dolunca yeni bir kilit yeni bir kayıttır: kayıt sayısı sayılan başarısız deneme sayısını geçemez', async () => {
  const db = world();
  for (let i = 0; i < 5; i++) await attempt(db, { now: at(i * MIN) }); // 0…4. dakika
  assert.equal(lockRows(db).length, 1);
  // 15. dakikada ilk hata pencereden çıkar → bir hak açılır; onu kullanan başarısız deneme kilidi yeniden oluşturur
  assert.equal(result(await attempt(db, { now: at(15 * MIN - 1) })), 'locked');
  assert.equal(result(await attempt(db, { now: at(15 * MIN) })), 'invalid');
  assert.equal(result(await attempt(db, { now: at(15 * MIN + 1) })), 'locked');
  assert.equal(lockRows(db).length, 2);
  const counted = db.st.failures.filter((f) => f.kind === 'LOGIN').length;
  assert.ok(lockRows(db).length <= counted, `kayıt ${lockRows(db).length} ≤ sayılan hata ${counted}`);
});

// ───────────────────────── veri azaltma: hesabı olmayan e-posta ─────────────────────────

test('hesabı OLMAYAN e-posta: kullanıcıya bağlı kayıt ve bildirim yok; yalnızca IP geneli kilit, kullanıcısız ve e-postasız yazılır', async () => {
  const GHOST = 'boyle-biri-yok@ornek.test';
  // e-posta + IP kilidi
  const pair = world();
  for (let i = 0; i < 5; i++) await attempt(pair, { email: GHOST, now: at(i) });
  assert.deepEqual([pair.st.audit.length, pair.st.notifications.length, pair.st.failures.length], [0, 0, 5]);
  // e-posta geneli kilit (20 IP)
  const mail = world();
  for (let i = 0; i < 20; i++) await attempt(mail, { email: GHOST, ip: `203.0.113.${i + 1}`, now: at(i) });
  assert.equal(result(await attempt(mail, { email: GHOST, ip: '203.0.113.99', now: at(40) })), 'locked');
  assert.deepEqual([mail.st.audit.length, mail.st.notifications.length], [0, 0]);
  // IP geneli kilit: 30 ayrı uydurma e-posta, tek IP → tek kayıt (kullanıcısız), ardından her e-posta kilitli ve kayıtsız
  const ipDb = world();
  const tried = Array.from({ length: 30 }, (_, i) => `uydurma-${i}@ornek.test`);
  for (const [i, email] of tried.entries()) await attempt(ipDb, { email, now: at(i) });
  assert.deepEqual(ipDb.st.audit, [{ id: 'kayit1', action: 'LOGIN_LOCKED', entityType: 'User', entityId: null, userId: null, details: { ip: IP, kind: 'LOGIN', scopes: ['ip'] }, actorRole: null, ip: IP }]);
  for (let i = 0; i < 40; i++) assert.equal(result(await attempt(ipDb, { email: `sonraki-${i}@ornek.test`, now: at(100 + i) })), 'locked');
  assert.deepEqual([ipDb.st.audit.length, ipDb.st.notifications.length], [1, 0]);
  const dump = JSON.stringify([pair.st.audit, mail.st.audit, ipDb.st.audit, ipDb.st.notifications]);
  for (const s of [GHOST, ...tried, 'uydurma', 'sonraki']) assert.equal(dump.includes(s), false, `kayıtta "${s}" yok`);
  // Saf kural: hesap yoksa yalnızca "ip" kapsamı kalır; tür geçersizse kayıt yok
  assert.equal(lockAuditEntry({ kind: 'LOGIN', scopes: ['account', 'email'], userId: null, ip: IP }), null);
  assert.deepEqual(lockAuditEntry({ kind: 'CODE', scopes: ['ip', 'email', 'account'], userId: null, ip: IP })?.details, { ip: IP, kind: 'CODE', scopes: ['ip'] });
  assert.deepEqual(lockAuditEntry({ kind: 'LOGIN', scopes: ['ip', 'email', 'account'], userId: 'k9', ip: IP })?.details.scopes, ['account', 'email', 'ip']);
  assert.deepEqual([lockAuditEntry({ kind: 'DEPOT', scopes: ['ip'], userId: 'k9', ip: IP }), lockAuditEntry({ kind: 'LOGIN', scopes: [], userId: 'k9', ip: IP }), lockAuditEntry({ kind: 'LOGIN', scopes: null, userId: 'k9', ip: IP })], [null, null, null]);
});

// ───────────────────────── yöneticiye bildirim ─────────────────────────

test('bildirim: yalnızca gerçek kullanıcı + e-posta geneli kilit; yalnızca etkin yöneticiler; içerikte sır yok', async () => {
  // Güvenlik bildirimi yalnızca gerçek yöneticiye (karar 220): Yönetici Yardımcısı operasyonel 'admin' kitlesindedir, 'security'de değil
  assert.deepEqual(AUDIENCE_ROLES.security, ['ADMIN']);
  assert.ok(AUDIENCE_ROLES.admin.includes('YONETICI_YARDIMCISI'));
  const db = world();
  const out = await recordLock(db, { kind: 'LOGIN', email: E, ip: IP, filled: ['email'], now: at(0), timeZone: TZ, log: quiet });
  assert.deepEqual(out, { audit: true, notified: 2 });
  assert.deepEqual(db.st.notifications.map((n) => [n.userId, n.type, n.dedupeKey, n.link, n.orderId]), [['y1', 'AUTH_LOCKED', 'auth-lock:hedef:2026-10-07', '/admin/users', null], ['y2', 'AUTH_LOCKED', 'auth-lock:hedef:2026-10-07', '/admin/users', null]]);
  assert.deepEqual([LOCK_NOTICE, lockNoticeKey('hedef', '2026-10-07')], ['AUTH_LOCKED', 'auth-lock:hedef:2026-10-07']);
  // Alanlar sabit: kullanıcının adı + kayıtlı e-postası, alıcı türü. IP, tür, kapsam, şifre, kod, anahtar yok
  assert.deepEqual(db.st.notifications.map((n) => n.params), Array(2).fill({ user: 'Hedef Kişi · hedef@ornek.test', aud: 'staff' }));
  // Satış / çizim / denetimci / müşteri / pasif yönetici almaz
  for (const id of ['y3', 'yy1', 's1', 'c1', 'd1', 'm1', 'hedef']) assert.equal(db.st.notifications.some((n) => n.userId === id), false, id);
  // Metin iki dilde; yedek metin (Romence) satırda saklanır
  assert.deepEqual(renderInApp('tr', db.st.notifications[0]), { title: 'Güvenlik: bir hesabın girişi çok sayıda hatalı deneme nedeniyle kilitlendi', body: 'Hedef Kişi · hedef@ornek.test' });
  assert.deepEqual(renderInApp('ro', db.st.notifications[0]), { title: 'Securitate: autentificarea unui cont a fost blocată după prea multe încercări greșite', body: 'Hedef Kişi · hedef@ornek.test' });
  assert.equal(db.st.notifications[0].message, 'Securitate: autentificarea unui cont a fost blocată după prea multe încercări greșite — Hedef Kişi · hedef@ornek.test');
  // Öteki kapsamlar ve hesabı olmayan e-posta bildirim üretmez
  for (const [filled, email] of [[['account'], E], [['ip'], E], [['account', 'ip'], E], [['email'], 'yok@ornek.test'], [['account', 'email', 'ip'], 'yok@ornek.test']]) {
    const other = world();
    const r = await recordLock(other, { kind: 'LOGIN', email, ip: IP, filled, now: at(0), timeZone: TZ, log: quiet });
    assert.deepEqual([r.notified, other.st.notifications.length], [0, 0], `${filled} / ${email}`);
  }
  // Boş / geçersiz girdi: hiçbir sorgu yok
  const idle = world();
  for (const filled of [[], null, undefined, ['baska']]) assert.deepEqual(await recordLock(idle, { kind: 'LOGIN', email: E, ip: IP, filled, now: at(0), timeZone: TZ, log: quiet }), { audit: false, notified: 0 });
  assert.deepEqual(await recordLock(idle, { kind: 'DEPOT', email: E, ip: IP, filled: ['email'], now: at(0), timeZone: TZ, log: quiet }), { audit: false, notified: 0 });
  assert.equal(idle.st.ops.length, 0);
});

test('bildirim: aynı kullanıcı için günde en çok bir kez (yerel gün); paralel kilit olayları çift bildirim üretemez; kod denemesi de aynı anahtarı kullanır', async () => {
  const db = world();
  const lock = (o = {}) => recordLock(db, { kind: 'LOGIN', email: E, ip: IP, filled: ['email'], now: at(0), timeZone: TZ, log: quiet, ...o });
  // Aynı anda 25 kilit olayı (ör. pencere pencere yinelenen saldırı): denetim kaydı her olay için, bildirim tek
  const outs = await Promise.all(Array.from({ length: 25 }, (_, i) => lock({ ip: `203.0.113.${i + 1}`, now: at(i * MIN) })));
  assert.deepEqual([lockRows(db).length, db.st.notifications.length, outs.reduce((s, o) => s + o.notified, 0)], [25, 2, 2]);
  // Aynı gün sonra (kod adımından gelen kilit de): yeni bildirim yok
  assert.equal((await lock({ kind: 'CODE', now: at(10 * 60 * MIN) })).notified, 0);
  assert.equal(db.st.notifications.length, 2);
  // Gün, uygulamanın saat dilimine göredir: 23:59 (Bükreş) aynı gün, 00:01 ertesi gün
  const lateSameDay = new Date(Date.UTC(2026, 9, 7, 20, 59, 0)); // 23:59
  const nextDay = new Date(Date.UTC(2026, 9, 7, 21, 1, 0)); // 08.10 00:01
  assert.equal((await lock({ now: lateSameDay })).notified, 0);
  assert.equal((await lock({ now: nextDay })).notified, 2);
  assert.deepEqual([...new Set(db.st.notifications.map((n) => n.dedupeKey))], ['auth-lock:hedef:2026-10-07', 'auth-lock:hedef:2026-10-08']);
  // Başka kullanıcının kilidi ayrı bildirimdir
  assert.equal((await lock({ email: 'baska-musteri@ornek.test', now: at(0) })).notified, 2);
  assert.equal(db.st.notifications.filter((n) => n.dedupeKey === 'auth-lock:m1:2026-10-07').length, 2);
});

test('kayıt / bildirim yazılamasa da deneme sonucu ve sınır değişmez; hata fırlatılmaz; günlüğe yalnızca hata türü yazılır', async () => {
  for (const broken of ['auditLog.create', 'notification.createMany', 'user.findMany', 'user.findUnique']) {
    const db = world();
    db.st.failOn.add(broken);
    const logged = [];
    const rs = [];
    for (let i = 0; i < 20; i++) rs.push(result(await attempt(db, { ip: `203.0.113.${(i % 4) + 1}`, now: at(i), log: (...a) => logged.push(a.join(' ')) })));
    assert.deepEqual(rs, Array(20).fill('invalid'), broken);
    // Sınırlar aynen işliyor: 20 hata yazıldı, hesap her IP'den kilitli (doğru şifreyle de)
    assert.deepEqual([db.st.failures.length, db.st.failures.every((f) => f.kind === 'LOGIN')], [20, true], broken);
    assert.equal(result(await attempt(db, { ip: '203.0.113.50', ok: true, now: at(100) })), 'locked', broken);
    // 20 deneme 4 IP'ye 5'er: her IP'nin 5. denemesi çifti doldurur, sonuncusu e-posta genelini de → 4 kilit olayı,
    // biri e-posta geneli (2 etkin yöneticiye bildirim). Beklenen [kilit kaydı, bildirim]:
    const expected = {
      'auditLog.create': [0, 2], // kayıt yazılamadı; bildirim yine gitti
      'notification.createMany': [4, 0], // kayıtlar yazıldı; bildirim yazılamadı
      'user.findMany': [4, 0], // kayıtlar yazıldı; bildirimin alıcıları okunamadı
      'user.findUnique': [0, 0], // kullanıcı okunamadı: kullanıcıya bağlı kayıt da bildirim de yok
    }[broken];
    assert.deepEqual([lockRows(db).length, db.st.notifications.length], expected, broken);
    assert.ok(logged.length > 0, `${broken}: günlüğe yazıldı`);
    for (const line of logged) {
      assert.match(line, /P9999$/, 'yalnızca hata türü');
      assert.equal(/sizdirma@ornek\.test|hedef@ornek\.test|sahte hata/.test(line), false, 'hata iletisi / e-posta günlüğe girmez');
    }
  }
  // Doğrudan çağrı: hiçbir durumda hata fırlatmaz
  const db = world();
  for (const op of ['user.findUnique', 'auditLog.create', 'notification.createMany', 'user.findMany']) db.st.failOn.add(op);
  assert.deepEqual(await recordLock(db, { kind: 'LOGIN', email: E, ip: IP, filled: ['account', 'email', 'ip'], now: at(0), timeZone: TZ, log: quiet }), { audit: false, notified: 0 });
  assert.equal(await recordCodeFailure(db, { email: E, ip: IP, log: quiet }), false);
});

// ───────────────────────── kod adımı: CODE_FAILED ─────────────────────────

const GUEST = 'davetli@ornek.test';
function invited(inviteExtra = {}, userExtra = {}) {
  const { code, record } = createInvite(GUEST, SECRET, 24);
  const db = fakeDb({
    users: [{ id: 'davetli', email: GUEST, name: 'Davetli Kişi', passwordHash: null, ...userExtra }, ...STAFF],
    invites: [{ userId: 'davetli', codeHash: record.codeHash, expiresAt: record.expiresAt, ...inviteExtra }],
  });
  const wrong = (n) => { const out = []; for (let i = 0; out.length < n; i++) { const c = String(100000 + i * 7919).slice(0, 6); if (c !== code) out.push(c); } return out; };
  return { db, code, wrong, attempts: () => db.st.invites[0].attempts };
}

test('kod: gerçek davette karşılaştırılan 5 yanlış kod → 5 CODE_FAILED; 6. deneme karşılaştırılmaz ve kayıt üretmez; kod hiçbir kayıtta yok', async () => {
  const { db, code, wrong, attempts } = invited();
  const tried = wrong(6);
  const rs = [];
  for (let i = 0; i < 5; i++) rs.push((await codeStep(db, { email: GUEST, code: tried[i], ip: `203.0.113.${i + 1}`, now: at(i) })).outcome.reason);
  assert.deepEqual([rs, attempts(), MAX_ATTEMPTS], [Array(5).fill('wrong_code'), 5, 5]);
  assert.deepEqual(codeRows(db), Array.from({ length: 5 }, (_, i) => ({ id: `kayit${i + 1}`, action: 'CODE_FAILED', entityType: 'User', entityId: 'davetli', userId: 'davetli', details: { ip: `203.0.113.${i + 1}` }, actorRole: 'MUSTERI', ip: `203.0.113.${i + 1}` })));
  // 6. yanlış kod ve ardından DOĞRU kod: davet kilitli → karşılaştırılmaz → kayıt yok
  assert.equal((await codeStep(db, { email: GUEST, code: tried[5], ip: '203.0.113.6', now: at(6) })).outcome.reason, 'unavailable');
  assert.equal((await codeStep(db, { email: GUEST, code, ip: '203.0.113.7', now: at(7) })).outcome.reason, 'unavailable');
  assert.deepEqual([codeRows(db).length, db.st.audit.length, attempts()], [5, 5, 5]);
  const dump = JSON.stringify([db.st.audit, db.st.notifications]);
  for (const s of [code, ...tried, GUEST]) assert.equal(dump.includes(s), false, 'kod / e-posta kayıtta yok');
});

test('kod: doğru kod, davet yok, kullanılmış / süresi dolmuş / gönderilmemiş davet, şifresi olan ya da pasif kullanıcı → CODE_FAILED yok', async () => {
  // Doğru kod: hak geri verilir, kayıt yok
  const ok = invited();
  assert.equal((await codeStep(ok.db, { email: GUEST, code: ok.code, ip: IP })).outcome.ok, true);
  assert.deepEqual([ok.db.st.audit.length, ok.attempts()], [0, 0]);
  // Kod karşılaştırılmayan durumlar
  const cases = [
    ['hesap yok', invited(), 'kimse@ornek.test', 'no_invite'],
    ['kullanılmış davet', invited({ usedAt: at(-1000) }), GUEST, 'no_invite'],
    ['gönderilmemiş davet', invited({ sentAt: null }), GUEST, 'no_invite'],
    ['süresi dolmuş davet', invited({ expiresAt: at(-1000) }), GUEST, 'unavailable'],
    ['kilitli davet', invited({ attempts: 5 }), GUEST, 'unavailable'],
    ['şifresi olan kullanıcı', invited({}, { passwordHash: 'ozet' }), GUEST, 'no_invite'],
    ['pasif kullanıcı', invited({}, { isActive: false }), GUEST, 'no_invite'],
  ];
  for (const [name, w, email, reason] of cases) {
    const before = w.attempts();
    for (const [i, c] of [w.code, ...w.wrong(3)].entries()) assert.equal((await codeStep(w.db, { email, code: c, ip: `203.0.113.${i + 1}`, now: at(i) })).outcome.reason, reason, name);
    assert.deepEqual([w.db.st.audit.length, w.attempts()], [0, before], `${name}: kayıt yok, deneme hakkı değişmedi`);
  }
  // Saf servis: hesabı olmayan e-posta için kayıt yazmaz
  const none = world();
  assert.equal(await recordCodeFailure(none, { email: 'kimse@ornek.test', ip: IP, log: quiet }), false);
  assert.equal(await recordCodeFailure(none, { email: '', ip: IP, log: quiet }), false);
  assert.equal(none.st.audit.length, 0);
});

test('kod: aynı anda 40 yanlış kod (ayrı IP\'ler) → 5 karşılaştırma, CODE_FAILED tam 5; aynı IP\'den 5 yanlış kod → 5 CODE_FAILED + tek kilit kaydı', async () => {
  const many = invited();
  const tried = many.wrong(40);
  const rs = await Promise.all(tried.map((c, i) => codeStep(many.db, { email: GUEST, code: c, ip: `203.0.${Math.floor(i / 200)}.${(i % 200) + 1}`, now: at(i) })));
  // E-posta geneli sınır 20: 20 deneme hak ayırır (5'i karşılaştırılır, 15'i "kullanılamaz"), 20'si kilitli
  assert.deepEqual([tally(rs.map((r) => (r.locked ? 'locked' : r.outcome.reason)), 'wrong_code'), tally(rs.map((r) => r.locked), true), many.attempts()], [5, 20, 5]);
  assert.equal(codeRows(many.db).length, 5);
  // 20. deneme e-posta genelini doldurdu: tek kilit kaydı (tür CODE) + yöneticilere tek bildirim
  assert.deepEqual(lockRows(many.db).map((a) => [a.entityId, a.details.kind, a.details.scopes]), [['davetli', 'CODE', ['email']]]);
  assert.deepEqual(many.db.st.notifications.map((n) => n.userId).sort(), ['y1', 'y2']);
  const dump = JSON.stringify([many.db.st.audit, many.db.st.notifications]);
  for (const s of [many.code, ...tried]) assert.equal(dump.includes(s), false);
  // Aynı IP: 5. yanlış kod hem CODE_FAILED hem çift kilidi (LOGIN_LOCKED, tür CODE) üretir; 6. istek sınırda reddedilir
  const one = invited();
  const five = one.wrong(5);
  for (const [i, c] of five.entries()) await codeStep(one.db, { email: GUEST, code: c, ip: IP, now: at(i) });
  assert.deepEqual(one.db.st.audit.map((a) => a.action), ['CODE_FAILED', 'CODE_FAILED', 'CODE_FAILED', 'CODE_FAILED', 'LOGIN_LOCKED', 'CODE_FAILED']);
  assert.deepEqual(lockRows(one.db)[0].details, { ip: IP, kind: 'CODE', scopes: ['account'] });
  const mark = one.db.st.ops.length;
  assert.equal((await codeStep(one.db, { email: GUEST, code: one.code, ip: IP, now: at(10) })).locked, true);
  assert.deepEqual([writes(one.db, mark), one.db.st.audit.length, one.db.st.notifications.length], [[], 6, 0]);
});

// ───────────────────────── kayıt alanları ve yapı ─────────────────────────

test('kayıt alanları sabittir: LOGIN_LOCKED → ip, kind, scopes · CODE_FAILED → ip; başka alan (e-posta, şifre, kod, anahtar) yazılamaz', async () => {
  const db = world();
  // İşlevlere fazladan alan verilse de kayda geçmez
  await recordLock(db, { kind: 'LOGIN', email: E, ip: IP, filled: ['account', 'email', 'ip'], now: at(0), timeZone: TZ, log: quiet, password: 'gizli-sifre-1', code: '123456', token: 'anahtar', cookie: 'oturum' });
  await recordCodeFailure(db, { email: E, ip: IP, log: quiet, code: '654321', password: 'gizli-sifre-2' });
  assert.deepEqual(db.st.audit.map((a) => [a.action, Object.keys(a).sort(), Object.keys(a.details).sort()]), [
    ['LOGIN_LOCKED', ['action', 'actorRole', 'details', 'entityId', 'entityType', 'id', 'ip', 'userId'], ['ip', 'kind', 'scopes']],
    ['CODE_FAILED', ['action', 'actorRole', 'details', 'entityId', 'entityType', 'id', 'ip', 'userId'], ['ip']],
  ]);
  const dump = JSON.stringify([db.st.audit, db.st.notifications.map((n) => ({ ...n, params: { ...n.params, user: '' }, message: '' }))]);
  for (const s of ['gizli-sifre', '123456', '654321', 'anahtar', 'oturum', E]) assert.equal(dump.includes(s), false, s);
  // IP en çok 64 karakter saklanır (sayaç anahtarıyla aynı kırpma)
  const long = world();
  await recordLock(long, { kind: 'LOGIN', email: E, ip: 'x'.repeat(300), filled: ['account'], now: at(0), timeZone: TZ, log: quiet });
  assert.deepEqual([long.st.audit[0].ip.length, long.st.audit[0].details.ip.length], [64, 64]);
});

test('yapı: kilitli istek yolu yazmaz; kilit kaydı tek yerde; ekranlar ve sarmalayıcı doğru bileşimde; e-posta kanalı yok', () => {
  const login = strip(read('app/login/actions.ts'));
  const setup = strip(read('app/setup/actions.ts'));
  const lib = strip(read('lib/auth/throttle.ts'));
  const svc = strip(read('server/auth/lock-events.js'));
  // Giriş: kilitli dal yalnızca yönlendirir — denetim kaydı, sorgu, bildirim yok
  assert.ok(login.includes('if (attempt.locked) redirect(`${back}&error=locked&m=${attempt.minutes}`);'));
  assert.equal(/if \(attempt\.locked\) \{/.test(login) || /if \(attempt\.locked\) \{/.test(setup), false, 'kilitli dal blok değildir (yalnızca redirect)');
  assert.ok(setup.includes("if (attempt.locked) redirect(`${back(email, 'throttled')}&m=${attempt.minutes}`);"));
  assert.deepEqual([...login.matchAll(/audit\('(\w+)'/g)].map((m) => m[1]), ['LOGIN_FAILED', 'USER_LOGIN'], 'giriş ekranı kilit kaydını kendisi yazmaz');
  // LOGIN_LOCKED / CODE_FAILED yalnızca servis dosyasında geçer
  const walk = (dir, exts) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, exts) : exts.test(e.name) ? [p] : [];
  });
  const files = walk('app', /\.tsx?$/).concat(walk('lib', /\.tsx?$/), walk('components', /\.tsx?$/), walk('server', /\.js$/), walk('scripts', /\.m?js$/));
  const using = (re) => files.filter((f) => re.test(strip(read(f)))).sort();
  assert.deepEqual(using(/LOGIN_LOCKED|CODE_FAILED|AUTH_LOCKED/).filter((f) => !f.includes(`${path.sep}i18n${path.sep}`)), [path.join('server', 'auth', 'lock-events.js')]);
  assert.deepEqual(using(/\brecordLock\(/), [path.join('lib', 'auth', 'throttle.ts'), path.join('server', 'auth', 'lock-events.js')]);
  assert.deepEqual(using(/\brecordCodeFailure\(/), [path.join('app', 'setup', 'actions.ts'), path.join('server', 'auth', 'lock-events.js')]);
  // Sarmalayıcı: deneme → (kilitli değil + sınır doldu) → tek kilit olayı; yalnızca tür, e-posta, IP, dolan sınır ve saat dilimi verilir
  const run = lib.slice(lib.indexOf('export async function runAttempt'));
  const order = ['await runAttemptIn(db, { kind, email, ip }, verify)', 'if (!result.locked && result.filled?.length) {', 'await recordLock(db, { kind, email, ip, filled: result.filled, timeZone: getEnv().APP_TIMEZONE });', 'return result;'];
  const pos = order.map((s) => run.indexOf(s));
  assert.ok(pos.every((i) => i >= 0), `eksik: ${order.filter((_, i) => pos[i] < 0).join(' | ')}`);
  assert.deepEqual(pos, [...pos].sort((a, b) => a - b));
  assert.equal((run.match(/recordLock\(/g) ?? []).length, 1);
  // Kod ekranı: yalnızca 'wrong_code' sonucunda, kod değeri verilmeden
  assert.ok(setup.includes("if (result.reason === 'wrong_code') await recordCodeFailure(db, { email, ip });"));
  assert.equal((setup.match(/recordCodeFailure\(/g) ?? []).length, 1);
  // Servis: e-posta göndermez, kuyruk yazmaz, şifre / kod / çerez tanımaz; bildirimi yalnızca mevcut yazıcıyla (yönetici kümesi) yazar
  assert.deepEqual([...read('server/auth/lock-events.js').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['../orders/journal.js', '../notifications/inapp.js', '../profile/dates.js', './throttle.js']);
  assert.equal(/notificationOutbox|sendMail|sendBrandedMail|enqueueOutbox|nodemailer|fetch\(/.test(svc), false, 'e-posta / dış istek yok');
  assert.equal(/password|passwordHash|codeHash|cookie|token|userAgent|secret/i.test(svc), false, 'servis sır alanı tanımaz');
  assert.ok(svc.includes("audience: 'security'") && svc.includes("scopes.includes('email')"));
  assert.equal((svc.match(/notifyStaff\(/g) ?? []).length, 1);
  assert.equal((svc.match(/writeAudit\(/g) ?? []).length, 2);
  // Hak ayırma: dolan sınır aynı sayımdan, kilitlerin altında ve kayıttan sonra hesaplanır; kilit kararını etkilemez
  const attempts = strip(read('server/auth/attempts.js'));
  const reserve = attempts.slice(attempts.indexOf('export async function reserveAttempt('), attempts.indexOf('export async function failAttempt('));
  const seq = ['const state = throttleState(counted, now.getTime());', 'if (state.locked) return { ok: false, minutes: state.minutes };', 'tx.authFailure.create(', 'filled: filledScopes(counted, now.getTime())'];
  const p2 = seq.map((s) => reserve.indexOf(s));
  assert.ok(p2.every((i) => i >= 0), `eksik: ${seq.filter((_, i) => p2[i] < 0).join(' | ')}`);
  assert.deepEqual(p2, [...p2].sort((a, b) => a - b));
  assert.ok(attempts.includes('return !outcome?.ok && reserved.filled.length ? { locked: false, outcome, filled: reserved.filled } : { locked: false, outcome };'));
  // Depo bağlantısı sayacı ve not servisi bu kuralın dışında: kilit olayı yazmazlar
  for (const f of [path.join('app', 'depo', '[token]', 'actions.ts'), ...walk(path.join('server', 'notes'), /\.js$/)]) assert.equal(/lock-events|recordLock|filledScopes/.test(read(f)), false, f);
});
