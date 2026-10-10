// Giriş / kod denemesi sınırı ve davet kodu deneme hakkı — atomik (karar 148; güvenlik denetimi 3.50.9 AUD-10).
// Gerçek servisler (server/auth/attempts.js, server/auth/invite-claim.js) bellekte sahte veritabanıyla çalışır. Sahte
// veritabanı her sorguda bir "tık" bekler (paralel istekler araya girer), işlem içindeki danışma kilidini
// (pg_advisory_xact_lock) anahtarına göre sıraya sokar ve koşullu updateMany'yi tek adımda uygular (PostgreSQL'in satır
// kilidi + koşulu yeniden değerlendirmesi). Aynı senaryolar gerçek PostgreSQL ile: test/db/auth-attempts.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTEMPT_KINDS, ATTEMPT_PENDING, clearAttempts, failAttempt, releaseAttempt, reserveAttempt, runAttempt } from '../server/auth/attempts.js';
import { verifyInviteCode } from '../server/auth/invite-claim.js';
import { MAX_ATTEMPTS, checkInvite, codeMatches, createInvite } from '../server/auth/inviteCode.js';
import { LIMITS, WINDOW_MS } from '../server/auth/throttle.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const SECRET = 'a'.repeat(40);
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 7, 9, 0, 0);
const at = (ms) => new Date(T0 + ms);
const tick = () => new Promise((r) => setImmediate(r));
const count = (list, v) => list.filter((x) => x === v).length;
/** Koşul sağlanana kadar bekler; sağlanmazsa test asılı kalmaz, hata verir */
const until = async (cond, max = 500) => { for (let i = 0; i < max; i++) { if (cond()) return; await tick(); } throw new Error('beklenen durum oluşmadı'); };

const OPS = { not: (a, x) => (x === null ? a !== null && a !== undefined : a !== x), lt: (a, x) => a < x, lte: (a, x) => a <= x, gt: (a, x) => a > x, gte: (a, x) => a >= x, in: (a, x) => x.includes(a) };
const match = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return v.some((w) => match(row, w));
  if (v === null) return row[k] === null || row[k] === undefined;
  if (v instanceof Date) return +row[k] === +v;
  if (v && typeof v === 'object') return Object.entries(v).every(([op, x]) => { if (!OPS[op]) throw new Error(`sahte veritabanı: bilinmeyen işleç ${op}`); return OPS[op](row[k], x); });
  return row[k] === v;
});

/** Bellekte sahte veritabanı (yalnızca bu servislerin kullandığı sorgular) */
function fakeDb({ users = [], invites = [], failures = [] } = {}) {
  const st = {
    users: users.map((u) => ({ isActive: true, passwordHash: null, ...u })),
    invites: invites.map((i) => ({ attempts: 0, usedAt: null, sentAt: at(-MIN), createdAt: at(-MIN), ...i })),
    failures: failures.map((f, i) => ({ id: `eski${i + 1}`, ...f })),
    seq: 0, openTx: 0, heldLocks: 0, txOptions: [], lockOrders: [], maxAttempts: 0, minAttempts: 0, maxPairRows: 0, pendingDeletedByOthers: 0,
    hooks: new Map(),
  };
  const queues = new Map();
  const hook = async (name, arg) => { await tick(); const list = st.hooks.get(name); if (list?.length) await list.shift()(arg); };
  const pairRows = (email, ip) => st.failures.filter((f) => f.email === email && f.ip === ip).length;
  const lockOn = async (key, held, order) => {
    const before = queues.get(key) ?? Promise.resolve();
    let release;
    queues.set(key, before.then(() => new Promise((r) => { release = r; })));
    await before;
    st.heldLocks += 1;
    order?.push(key);
    held.push(() => { st.heldLocks -= 1; release(); });
  };
  const keyOfRaw = (strings, values) => { assert.match(strings.join('?'), /^SELECT pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)$/); return String(values[0]); };
  const model = {
    user: { async findUnique({ where }) { await hook('user.findUnique'); const u = st.users.find((x) => x.email === where.email); return u ? { ...u } : null; } },
    userInvite: {
      async findFirst({ where }) {
        await hook('userInvite.findFirst');
        const rows = st.invites.filter((i) => match(i, where)).sort((a, b) => b.createdAt - a.createdAt);
        return rows[0] ? { ...rows[0] } : null;
      },
      // Tek adım: koşul o anki satıra uygulanır, eşleşirse aynı adımda değiştirilir
      async updateMany({ where, data }) {
        await hook(data.attempts?.decrement ? 'userInvite.refund' : 'userInvite.claim');
        let n = 0;
        for (const i of st.invites) {
          if (!match(i, where)) continue;
          n += 1;
          if (data.attempts?.increment) i.attempts += data.attempts.increment;
          if (data.attempts?.decrement) i.attempts -= data.attempts.decrement;
          st.maxAttempts = Math.max(st.maxAttempts, i.attempts);
          st.minAttempts = Math.min(st.minAttempts, i.attempts);
        }
        return { count: n };
      },
    },
    authFailure: {
      async findMany({ where }) { await hook('authFailure.findMany'); return st.failures.filter((f) => match(f, where)).map((f) => ({ ...f })); },
      async create({ data }) {
        await hook('authFailure.create');
        const row = { id: `d${++st.seq}`, ...data };
        st.failures.push(row);
        st.maxPairRows = Math.max(st.maxPairRows, pairRows(row.email, row.ip));
        return { id: row.id };
      },
      async updateMany({ where, data }) { await hook('authFailure.updateMany'); let n = 0; for (const f of st.failures) if (match(f, where)) { Object.assign(f, data); n += 1; } return { count: n }; },
      async deleteMany({ where }) {
        await hook('authFailure.deleteMany');
        const own = where.id ?? where.OR?.find((w) => 'id' in w)?.id;
        const gone = st.failures.filter((f) => match(f, where));
        st.pendingDeletedByOthers += gone.filter((f) => f.kind === ATTEMPT_PENDING && f.id !== own).length;
        st.failures = st.failures.filter((f) => !gone.includes(f));
        return { count: gone.length };
      },
    },
  };
  return {
    ...model, st,
    /** Bir sonraki adlı sorgudan hemen önce çalışacak tek seferlik işlev (araya girme / bekletme) */
    before(name, fn) { if (!st.hooks.has(name)) st.hooks.set(name, []); st.hooks.get(name).push(fn); },
    // İşlem dışında alınan işlem kilidi (otomatik onay): alınır ve ifade bitince hemen bırakılır — hiçbir şeyi korumaz
    async $executeRaw(strings, ...values) { const held = []; await lockOn(keyOfRaw(strings, values), held); for (const r of held) r(); return 1; },
    async $transaction(fn, options) {
      st.txOptions.push(options ?? null);
      st.openTx += 1;
      const held = [];
      const order = [];
      st.lockOrders.push(order);
      const tx = { ...model, async $executeRaw(strings, ...values) { await lockOn(keyOfRaw(strings, values), held, order); return 1; } };
      try {
        return await fn(tx);
      } finally {
        st.openTx -= 1;
        for (const r of held) r();
      }
    },
  };
}
const rowsOf = (db, where = {}) => db.st.failures.filter((f) => match(f, where));
const E = 'hedef@ornek.test';
const IP = '198.51.100.7';
/** Bir deneme: hak ayır → (isteğe bağlı bekleme) → sonuç */
const attempt = (db, { kind = 'LOGIN', email = E, ip = IP, ok = false, now = at(0), wait = null, stats = null } = {}) =>
  runAttempt(db, { kind, email, ip, now }, async () => { if (stats) { stats.verified += 1; if (!ok) stats.wrong += 1; } if (wait) await wait(); return { ok }; });
const result = (r) => (r.locked ? 'locked' : r.outcome.ok ? 'ok' : 'invalid');

// ───────────────────────── deneme sınırı (giriş + kod) ─────────────────────────

test('sınırlar ve pencere değişmedi: e-posta + IP 5, e-posta 20, IP 30, 15 dakika; süren deneme "PENDING" türüyle yazılır', () => {
  assert.deepEqual([LIMITS, WINDOW_MS], [{ account: 5, email: 20, ip: 30 }, 15 * MIN]);
  assert.deepEqual([ATTEMPT_PENDING, [...ATTEMPT_KINDS]], ['PENDING', ['LOGIN', 'CODE']]);
  assert.equal(ATTEMPT_KINDS.includes(ATTEMPT_PENDING), false, 'tamamlanmış hata türü PENDING olamaz');
});

test('hak ayırma: 5 deneme ayrılır, 6. kilitlidir (doğrulama hiç çalışmaz — doğru şifre de açmaz); süren denemeler de sayılır', async () => {
  const db = fakeDb();
  const rs = [];
  for (let i = 0; i < 5; i++) rs.push(await reserveAttempt(db, { email: E, ip: IP, now: at(i * 1000) }));
  assert.equal(rs.every((r) => r.ok && typeof r.id === 'string'), true);
  assert.deepEqual(rowsOf(db).map((f) => [f.kind, f.email, f.ip, +f.createdAt]), [0, 1, 2, 3, 4].map((i) => ['PENDING', E, IP, T0 + i * 1000]));
  // Beş satırın hepsi PENDING (hiçbiri henüz "hata" olmadı) — yine de sınır doludur
  const sixth = await reserveAttempt(db, { email: E, ip: IP, now: at(5000) });
  assert.deepEqual(sixth, { ok: false, minutes: 15 });
  assert.equal(rowsOf(db).length, 5, 'kilitli istek satır yazmaz');
  let called = 0;
  const locked = await runAttempt(db, { kind: 'LOGIN', email: E, ip: IP, now: at(6000) }, async () => { called += 1; return { ok: true }; });
  assert.deepEqual([locked, called], [{ locked: true, minutes: 15 }, 0]);
});

test('paralel istekler: aynı e-posta + IP → en çok 5 hak (40 ve 200 istek)', async () => {
  for (const n of [40, 200]) {
    const db = fakeDb();
    const rs = await Promise.all(Array.from({ length: n }, () => reserveAttempt(db, { email: E, ip: IP, now: at(0) })));
    assert.deepEqual([count(rs.map((r) => r.ok), true), count(rs.map((r) => r.ok), false), rowsOf(db).length, db.st.maxPairRows], [5, n - 5, 5, 5], `${n} istek`);
  }
});

test('paralel istekler: aynı e-posta, farklı IP → en çok 20; farklı e-posta, aynı IP → en çok 30', async () => {
  const a = fakeDb();
  const byEmail = await Promise.all(Array.from({ length: 60 }, (_, i) => reserveAttempt(a, { email: E, ip: `203.0.113.${i + 1}`, now: at(0) })));
  assert.deepEqual([count(byEmail.map((r) => r.ok), true), rowsOf(a, { email: E }).length], [20, 20]);
  const b = fakeDb();
  const byIp = await Promise.all(Array.from({ length: 80 }, (_, i) => reserveAttempt(b, { email: `k${i}@ornek.test`, ip: IP, now: at(0) })));
  assert.deepEqual([count(byIp.map((r) => r.ok), true), rowsOf(b, { ip: IP }).length], [30, 30]);
  // Karışık: her IP'den 3 istek, 12 IP, aynı e-posta → çift başına en çok 3 (5'in altında), toplam en çok 20
  const c = fakeDb();
  const mixed = await Promise.all(Array.from({ length: 36 }, (_, i) => reserveAttempt(c, { email: E, ip: `203.0.113.${(i % 12) + 1}`, now: at(0) })));
  assert.deepEqual([count(mixed.map((r) => r.ok), true), c.st.maxPairRows <= 3], [20, true]);
});

test('mevcut K hata varken paralel isteklerde yalnızca kalan hak kadar deneme ayrılır (K = 0 … 5)', async () => {
  for (let k = 0; k <= 5; k++) {
    const db = fakeDb({ failures: Array.from({ length: k }, (_, i) => ({ kind: 'LOGIN', email: E, ip: IP, createdAt: at(-i * 1000) })) });
    const rs = await Promise.all(Array.from({ length: 40 }, () => reserveAttempt(db, { email: E, ip: IP, now: at(0) })));
    assert.deepEqual([count(rs.map((r) => r.ok), true), rowsOf(db).length], [5 - k, 5], `K=${k}`);
  }
  // E-posta geneli: başka IP'lerden 18 hata varken yeni IP'lerden 30 paralel istek → 2
  const db = fakeDb({ failures: Array.from({ length: 18 }, (_, i) => ({ kind: 'CODE', email: E, ip: `192.0.2.${i + 1}`, createdAt: at(-1000) })) });
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => reserveAttempt(db, { email: E, ip: `203.0.113.${i + 1}`, now: at(0) })));
  assert.equal(count(rs.map((r) => r.ok), true), 2);
});

test('pencere: 15 dakika dolunca yeniden izin verilir; kilit süresi en eski hatanın pencereden çıkmasına kadardır', async () => {
  const db = fakeDb();
  for (let i = 0; i < 5; i++) assert.equal(result(await attempt(db, { now: at(i * MIN) })), 'invalid');   // 0., 1., 2., 3., 4. dakikada
  assert.deepEqual(await attempt(db, { now: at(5 * MIN) }), { locked: true, minutes: 10 });
  assert.deepEqual(await attempt(db, { now: at(15 * MIN - 1) }), { locked: true, minutes: 1 });
  assert.equal(result(await attempt(db, { now: at(15 * MIN) })), 'invalid', 'ilk hata pencereden çıktı: bir hak');
  assert.equal((await attempt(db, { now: at(15 * MIN + 1) })).locked, true);
  // Hepsi pencereden çıkınca beş hak yeniden
  const later = [];
  for (let i = 0; i < 6; i++) later.push(result(await attempt(db, { now: at(40 * MIN + i) })));
  assert.deepEqual(later, ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'locked']);
});

test('başarısız doğrulama: AYNI satır tamamlanmış hata olur (ikinci satır yazılmaz); doğrulama işlem ve kilit DIŞINDA çalışır', async () => {
  const db = fakeDb();
  let seen = null;
  const r = await runAttempt(db, { kind: 'LOGIN', email: E, ip: IP, now: at(0) }, async () => {
    // Doğrulama sırasında: hak ayrılmış (satır PENDING), açık işlem ve tutulan kilit yok
    seen = { rows: rowsOf(db).map((f) => f.kind), openTx: db.st.openTx, heldLocks: db.st.heldLocks };
    await tick();
    return { ok: false, why: 'yanlış şifre' };
  });
  assert.deepEqual(seen, { rows: ['PENDING'], openTx: 0, heldLocks: 0 });
  assert.deepEqual(r, { locked: false, outcome: { ok: false, why: 'yanlış şifre' } });
  assert.deepEqual(rowsOf(db).map((f) => [f.kind, f.email, f.ip]), [['LOGIN', E, IP]], 'tek satır, türü LOGIN');
  const c = await runAttempt(db, { kind: 'CODE', email: E, ip: IP, now: at(1000) }, async () => ({ ok: false }));
  assert.equal(c.locked, false);
  assert.deepEqual(rowsOf(db).map((f) => f.kind), ['LOGIN', 'CODE']);
  // İşlem ayarı: her hak ayırma açıkça READ COMMITTED işlemdedir
  assert.equal(db.st.txOptions.length, 2);
  assert.ok(db.st.txOptions.every((o) => o?.isolationLevel === 'ReadCommitted'));
  await assert.rejects(runAttempt(db, { kind: 'PENDING', email: E, ip: IP }, async () => ({ ok: true })), /geçersiz deneme türü/);
  await assert.rejects(failAttempt(db, { id: 'x', kind: 'DEPOT' }), /geçersiz deneme türü/);
});

test('başarılı giriş: kendi denemesi ve aynı e-posta + IP\'nin tamamlanmış hataları silinir; başka e-posta / IP ve süren denemeler kalır', async () => {
  const other = '203.0.113.9';
  const db = fakeDb({ failures: [
    { kind: 'LOGIN', email: E, ip: IP, createdAt: at(-3000) },
    { kind: 'CODE', email: E, ip: IP, createdAt: at(-2000) },
    { kind: 'LOGIN', email: E, ip: other, createdAt: at(-2000) },                 // aynı e-posta, başka IP
    { kind: 'LOGIN', email: 'baska@ornek.test', ip: IP, createdAt: at(-2000) },   // başka e-posta, aynı IP
    { kind: 'DEPOT', email: '-', ip: IP, createdAt: at(-2000) },                  // depo bağlantısı sayacı (kapsam dışı)
  ] });
  const r = await attempt(db, { ok: true });
  assert.equal(result(r), 'ok');
  assert.deepEqual(rowsOf(db).map((f) => [f.kind, f.email, f.ip]), [['LOGIN', E, other], ['LOGIN', 'baska@ornek.test', IP], ['DEPOT', '-', IP]]);
  assert.equal(db.st.pendingDeletedByOthers, 0);
  // Başarılı girişten sonra çift için beş hak yeniden vardır (eski davranış)
  const rs = [];
  for (let i = 0; i < 6; i++) rs.push(result(await attempt(db, { now: at(1000 + i) })));
  assert.deepEqual(rs, ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'locked']);
});

test('başarılı giriş, doğrulaması SÜREN başka denemelerin hakkını serbest bırakmaz: 4 süren deneme + 1 başarılı → yalnızca 1 hak açılır', async () => {
  const db = fakeDb();
  const gates = [];
  const hold = () => new Promise((r) => { gates.push(r); });
  // A, B, C, D: hak ayrıldı, doğrulamaları sürüyor (yanlış şifre)
  const inflight = [0, 1, 2, 3].map((i) => attempt(db, { ok: false, now: at(i), wait: hold }));
  await until(() => gates.length === 4);
  assert.deepEqual(rowsOf(db).map((f) => f.kind), ['PENDING', 'PENDING', 'PENDING', 'PENDING']);
  // S: beşinci hak, doğru şifre → başarılı
  assert.equal(result(await attempt(db, { ok: true, now: at(10) })), 'ok');
  assert.deepEqual(rowsOf(db).map((f) => f.kind), ['PENDING', 'PENDING', 'PENDING', 'PENDING'], 'süren dört deneme yerinde');
  assert.equal(db.st.pendingDeletedByOthers, 0);
  // Başarılı girişten sonra: yalnızca S'nin hakkı açıldı → 1 deneme daha, sonra kilit
  const extra = attempt(db, { ok: false, now: at(20), wait: hold });
  await until(() => gates.length === 5);
  assert.equal((await attempt(db, { ok: true, now: at(30) })).locked, true, 'altıncı eşzamanlı deneme kilitli');
  for (const g of gates) g();
  assert.deepEqual((await Promise.all([...inflight, extra])).map(result), ['invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
  assert.deepEqual(rowsOf(db).map((f) => f.kind), ['LOGIN', 'LOGIN', 'LOGIN', 'LOGIN', 'LOGIN']);
  assert.equal(db.st.maxPairRows, 5);
  assert.equal((await attempt(db, { ok: true, now: at(40) })).locked, true, 'beş hata: kilit (doğru şifre de açmaz)');
});

test('başarısız deneme, aynı anda biten başarılı girişle yarışsa da kaybolmaz', async () => {
  // W'nin hata yazımı S'nin temizliğinden SONRA gelirse satır kalır (PENDING → LOGIN); ÖNCE gelirse S onu temizler (eski davranış)
  const db = fakeDb();
  let release;
  const w = attempt(db, { ok: false, now: at(0), wait: () => new Promise((r) => { release = r; }) });
  await until(() => release);
  await attempt(db, { ok: true, now: at(1) });           // S temizledi: W'nin satırı PENDING olduğu için duruyor
  assert.deepEqual(rowsOf(db).map((f) => f.kind), ['PENDING']);
  release();
  await w;
  assert.deepEqual(rowsOf(db).map((f) => f.kind), ['LOGIN'], 'hata sayıldı');
});

test('doğru kod (CODE): yalnızca ayrılan deneme silinir; öteki hatalar olduğu gibi kalır', async () => {
  const db = fakeDb({ failures: [{ kind: 'CODE', email: E, ip: IP, createdAt: at(-2000) }, { kind: 'LOGIN', email: E, ip: IP, createdAt: at(-1000) }] });
  const r = await attempt(db, { kind: 'CODE', ok: true });
  assert.equal(result(r), 'ok');
  assert.deepEqual(rowsOf(db).map((f) => f.kind), ['CODE', 'LOGIN']);
  // Alt işlevler de aynı kural
  const a = await reserveAttempt(db, { email: E, ip: IP, now: at(0) });
  await releaseAttempt(db, { id: a.id });
  assert.equal(rowsOf(db).length, 2);
  const b = await reserveAttempt(db, { email: E, ip: IP, now: at(0) });
  await clearAttempts(db, { id: b.id, email: E, ip: IP });
  assert.equal(rowsOf(db).length, 0);
});

test('beklenmeyen hata (doğrulama ya da sonuç yazımı): deneme HATA sayılır, PENDING kalmaz; asıl hata yukarı iletilir', async () => {
  const db = fakeDb();
  const boom = new Error('veritabanı bağlantısı koptu');
  await assert.rejects(runAttempt(db, { kind: 'LOGIN', email: E, ip: IP, now: at(0) }, async () => { throw boom; }), (e) => e === boom);
  assert.deepEqual(rowsOf(db).map((f) => f.kind), ['LOGIN'], 'satır PENDING değil: tamamlanmış hata');
  // Sonuç yazımı (başarılı girişin temizliği) hata verirse: giriş başarısız sayılır, deneme hata olur
  const db2 = fakeDb();
  db2.before('authFailure.deleteMany', () => { throw boom; });
  await assert.rejects(runAttempt(db2, { kind: 'LOGIN', email: E, ip: IP, now: at(0) }, async () => ({ ok: true })), (e) => e === boom);
  assert.deepEqual(rowsOf(db2).map((f) => f.kind), ['LOGIN']);
  // Hata sayılan deneme sıradan bir hatadır: sonraki başarılı giriş temizler
  assert.equal(result(await attempt(db, { ok: true, now: at(1000) })), 'ok');
  assert.equal(rowsOf(db).length, 0);
  // Hata yazımı da başarısız olursa asıl hata gizlenmez; satır PENDING kalır (aşağıdaki test: kalıcı kilit yaratmaz)
  const db3 = fakeDb();
  db3.before('authFailure.updateMany', () => { throw new Error('ikinci hata'); });
  await assert.rejects(runAttempt(db3, { kind: 'CODE', email: E, ip: IP, now: at(0) }, async () => { throw boom; }), (e) => e === boom);
  assert.deepEqual(rowsOf(db3).map((f) => f.kind), ['PENDING']);
  // Beş kez üst üste hata fırlatan doğrulama: beş hata, altıncı kilitli — hiçbir satır PENDING birikmez
  const db4 = fakeDb();
  for (let i = 0; i < 5; i++) await assert.rejects(runAttempt(db4, { kind: 'LOGIN', email: E, ip: IP, now: at(i) }, async () => { throw boom; }));
  assert.deepEqual([rowsOf(db4, { kind: 'PENDING' }).length, rowsOf(db4, { kind: 'LOGIN' }).length], [0, 5]);
  assert.equal((await attempt(db4, { ok: true, now: at(10) })).locked, true);
  assert.equal(result(await attempt(db4, { ok: true, now: at(15 * MIN + 5) })), 'ok', 'pencere dolunca yeniden');
});

test('yarıda kalmış (PENDING) deneme kalıcı kilit yaratmaz: pencere boyunca sayılır, sonra etkisizdir; bir günden eskisi silinir', async () => {
  // Sunucu doğrulama sırasında kapandı: iki satır PENDING kaldı (2. ve 3. saniyede ayrılmıştı)
  const db = fakeDb({ failures: [{ kind: 'PENDING', email: E, ip: IP, createdAt: at(2000) }, { kind: 'PENDING', email: E, ip: IP, createdAt: at(3000) }] });
  // Pencere içinde: hak kullanır (5 − 2 = 3 deneme)
  const rs = [];
  for (let i = 0; i < 4; i++) rs.push(result(await attempt(db, { now: at(5000 + i) })));
  assert.deepEqual(rs, ['invalid', 'invalid', 'invalid', 'locked']);
  // Yarıda kalmış satırlar da bir hak kullandığı için çiftte en çok 5 satır olabilir: olağan kilitten fazlası olmaz
  assert.deepEqual([rowsOf(db).length, db.st.maxPairRows], [5, 5]);
  // Pencere dolunca PENDING satırlar sayılmaz (silinmemiş olsalar da): tam beş hak
  assert.equal(rowsOf(db, { kind: 'PENDING' }).length, 2);
  const later = [];
  for (let i = 0; i < 6; i++) later.push(result(await attempt(db, { now: at(15 * MIN + 5010 + i) })));
  assert.deepEqual(later, ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'locked']);
  // Başarılı giriş yarıda kalmış satırı silmez (süren denemeden ayırt edilemez) ama o da 15 dakikada etkisizleşir
  const db2 = fakeDb({ failures: [{ kind: 'PENDING', email: E, ip: IP, createdAt: at(0) }] });
  assert.equal(result(await attempt(db2, { ok: true, now: at(1000) })), 'ok');
  assert.deepEqual(rowsOf(db2).map((f) => f.kind), ['PENDING']);
  const four = [];
  for (let i = 0; i < 5; i++) four.push(result(await attempt(db2, { now: at(2000 + i) })));
  assert.deepEqual(four, ['invalid', 'invalid', 'invalid', 'invalid', 'locked'], 'pencere içinde bir hak eksik');
  // Bir günden eski kayıtlar (PENDING dahil) bir sonraki hatada silinir
  await failAttempt(db2, { id: 'yok', kind: 'LOGIN', now: at(24 * 60 * MIN + 10_000) });
  assert.equal(rowsOf(db2).length, 0);
});

test('farklı e-posta / IP birbirini bloklamaz; kilit sırası sabittir (önce e-posta, sonra IP) ve çapraz ızgarada kilitlenme olmaz', async () => {
  const db = fakeDb();
  const emails = Array.from({ length: 6 }, (_, i) => `e${i}@ornek.test`);
  const ips = Array.from({ length: 6 }, (_, i) => `203.0.113.${i + 1}`);
  const cells = emails.flatMap((email) => ips.map((ip) => ({ email, ip })));
  // Her çift için 2 istek (72 paralel), sıra karıştırılmış: hepsi ayrılır (çift 2 ≤ 5, e-posta 12 ≤ 20, IP 12 ≤ 30)
  const order = [...cells, ...cells.slice().reverse()];
  const rs = await Promise.all(order.map((c) => reserveAttempt(db, { ...c, now: at(0) })));
  assert.equal(count(rs.map((r) => r.ok), true), 72);
  assert.deepEqual([rowsOf(db).length, db.st.maxPairRows, db.st.heldLocks, db.st.openTx], [72, 2, 0, 0]);
  // Her işlem tam iki kilit alır: önce e-posta anahtarı, sonra IP anahtarı
  assert.equal(db.st.lockOrders.length, 72);
  for (const o of db.st.lockOrders) assert.deepEqual([o.length, o[0].startsWith('auth-email:'), o[1].startsWith('auth-ip:')], [2, true, true]);
  assert.deepEqual(db.st.lockOrders[0], ['auth-email:e0@ornek.test', 'auth-ip:203.0.113.1']);
  // Bir çiftin kilidi dolu olsa da başkası etkilenmez
  const db2 = fakeDb();
  for (let i = 0; i < 5; i++) await attempt(db2, { now: at(i) });
  assert.equal((await attempt(db2, { now: at(10) })).locked, true);
  assert.equal(result(await attempt(db2, { email: 'baska@ornek.test', now: at(10) })), 'invalid', 'aynı IP, başka e-posta');
  assert.equal(result(await attempt(db2, { ip: '203.0.113.200', now: at(10) })), 'invalid', 'aynı e-posta, başka IP');
  // Anahtar kırpılmış değerdir: saklanan, sayılan ve kilitlenen aynı
  const long = `${'x'.repeat(250)}@ornek.test`;
  const db3 = fakeDb();
  const got = await Promise.all(Array.from({ length: 12 }, () => reserveAttempt(db3, { email: long, ip: IP, now: at(0) })));
  assert.deepEqual([count(got.map((r) => r.ok), true), rowsOf(db3)[0].email.length], [5, 200]);
});

test('paralel başarılı / başarısız karışım sınırı açmaz: çiftte hiçbir an 5\'ten çok satır olmaz, süren deneme silinmez', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const db = fakeDb();
    const stats = { verified: 0, wrong: 0 };
    let x = seed * 7919;
    const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
    const wait = () => async () => { const n = Math.floor(rnd() * 6); for (let i = 0; i < n; i++) await tick(); };
    // 60 yanlış + 3 doğru deneme, aynı e-posta + IP, aynı anda
    const flows = Array.from({ length: 63 }, (_, i) => attempt(db, { ok: i % 21 === 10, now: at(i), wait: wait(), stats }));
    const rs = (await Promise.all(flows)).map(result);
    const ok = count(rs, 'ok');
    assert.equal(db.st.maxPairRows <= 5, true, `tohum ${seed}: çiftte en çok 5 satır`);
    assert.equal(db.st.pendingDeletedByOthers, 0, `tohum ${seed}: başarılı giriş süren denemeyi silmedi`);
    assert.equal(stats.verified, 63 - count(rs, 'locked'));
    // Her başarılı giriş çifti sıfırlar (eski davranış): yanlış doğrulama sayısı en çok 5 × (başarılı giriş + 1) − başarılılar
    assert.equal(stats.wrong <= 5 * (ok + 1) - ok, true, `tohum ${seed}: ${stats.wrong} yanlış, ${ok} başarılı`);
    assert.equal(rowsOf(db, { kind: 'PENDING' }).length, 0, 'bittiğinde süren deneme yok');
    assert.equal(rowsOf(db).length <= 5, true);
  }
  // Başarılı giriş yokken: 200 paralel yanlış deneme → tam 5 doğrulama
  const db = fakeDb();
  const stats = { verified: 0, wrong: 0 };
  const rs = (await Promise.all(Array.from({ length: 200 }, (_, i) => attempt(db, { now: at(i), stats })))).map(result);
  assert.deepEqual([stats.wrong, count(rs, 'invalid'), count(rs, 'locked'), rowsOf(db, { kind: 'LOGIN' }).length], [5, 5, 195, 5]);
});

// ───────────────────────── davet kodu ─────────────────────────

/** Davet bekleyen kullanıcı + açık davet */
function invited(extra = {}, userExtra = {}) {
  const { code, record } = createInvite(E, SECRET, 24, at(0));
  const db = fakeDb({ users: [{ id: 'u1', email: E, ...userExtra }], invites: [{ id: 'i1', userId: 'u1', ...record, ...extra }] });
  const spy = { calls: 0, wrong: 0 };
  const compare = (o) => { spy.calls += 1; const same = codeMatches(o); if (!same) spy.wrong += 1; return same; };
  const verify = (c, o = {}) => verifyInviteCode(db, { email: E, code: c, secret: SECRET, now: at(1000), compare, ...o });
  const wrong = (n) => { const out = []; for (let i = 0; out.length < n; i++) { const c = String(i).padStart(6, '0'); if (c !== code) out.push(c); } return out; };
  return { db, code, spy, verify, wrong, invite: () => db.st.invites[0] };
}

test('davet: 5 yanlış kod karşılaştırılır; 6. deneme karşılaştırılmaz — doğru kod olsa da reddedilir', async () => {
  const t = invited();
  for (const c of t.wrong(5)) assert.deepEqual(await t.verify(c), { ok: false, reason: 'wrong_code' });
  assert.deepEqual([t.spy.calls, t.invite().attempts], [5, 5]);
  assert.deepEqual(await t.verify(t.wrong(6)[5]), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await t.verify(t.code), { ok: false, reason: 'unavailable' }, 'kilitli davette doğru kod da geçmez');
  assert.deepEqual([t.spy.calls, t.invite().attempts, t.db.st.maxAttempts], [5, 5, 5], 'altıncı ve yedinci istekte kod karşılaştırılmadı');
  assert.equal(MAX_ATTEMPTS, 5);
});

test('davet: paralel 40 ve 200 yanlış kodda yalnızca 5 karşılaştırma; attempts tam 5 ve hiçbir an 5\'i geçmez', async () => {
  for (const n of [40, 200]) {
    const t = invited();
    const rs = await Promise.all(t.wrong(n).map((c) => t.verify(c)));
    assert.deepEqual([count(rs.map((r) => r.reason), 'wrong_code'), count(rs.map((r) => r.reason), 'unavailable')], [5, n - 5], `${n} istek`);
    assert.deepEqual([t.spy.calls, t.invite().attempts, t.db.st.maxAttempts], [5, 5, 5], `${n} istek`);
  }
});

test('davet: doğru kod alınan hakkı geri verir (deneme saymaz); art arda doğrulamalar ve önceki yanlışlar değişmez', async () => {
  const t = invited();
  assert.deepEqual(await t.verify(t.code), { ok: true, inviteId: 'i1', userId: 'u1' });
  assert.equal(t.invite().attempts, 0);
  for (let i = 0; i < 10; i++) assert.equal((await t.verify(t.code)).ok, true);
  assert.deepEqual([t.invite().attempts, t.db.st.maxAttempts, t.db.st.minAttempts], [0, 1, 0]);
  for (const c of t.wrong(3)) await t.verify(c);
  assert.equal(t.invite().attempts, 3);
  assert.equal((await t.verify(`  ${t.code} `)).ok, true, 'baştaki / sondaki boşluk');
  assert.equal(t.invite().attempts, 3, 'doğru kod önceki yanlışları silmez, kendi hakkını geri verir');
  // Biçimi bozuk kod da bir denemedir (eski davranış)
  assert.deepEqual(await t.verify('12345'), { ok: false, reason: 'wrong_code' });
  assert.deepEqual(await t.verify('abcdef'), { ok: false, reason: 'wrong_code' });
  assert.equal(t.invite().attempts, 5);
  assert.deepEqual(await t.verify(t.code), { ok: false, reason: 'unavailable' });
});

test('davet: süresi dolmuş / kullanılmış / gönderilmemiş davet ve uygun olmayan kullanıcı hak alamaz — kod karşılaştırılmaz, attempts değişmez', async () => {
  const cases = [
    ['süresi dolmuş', { expiresAt: at(999) }, {}, 'unavailable'],
    ['tam şimdi doluyor', { expiresAt: at(1000) }, {}, 'unavailable'],
    ['kullanılmış', { usedAt: at(0) }, {}, 'no_invite'],
    ['gönderilmemiş', { sentAt: null }, {}, 'no_invite'],
    ['şifresi olan kullanıcı', {}, { passwordHash: 'scrypt$…' }, 'no_invite'],
    ['pasif kullanıcı', {}, { isActive: false }, 'no_invite'],
  ];
  for (const [name, inviteExtra, userExtra, reason] of cases) {
    const t = invited(inviteExtra, userExtra);
    assert.deepEqual(await t.verify(t.code), { ok: false, reason }, name);
    assert.deepEqual([t.spy.calls, t.invite().attempts], [0, 0], name);
  }
  const t = invited();
  assert.deepEqual(await verifyInviteCode(t.db, { email: 'yok@ornek.test', code: t.code, secret: SECRET, compare: () => { throw new Error('çağrılmamalı'); } }), { ok: false, reason: 'no_invite' });
  assert.deepEqual(await verifyInviteCode(t.db, { email: '', code: t.code, secret: SECRET, compare: () => { throw new Error('çağrılmamalı'); } }), { ok: false, reason: 'no_invite' });
  assert.equal((await t.verify(t.code, { email: ` ${E.toUpperCase()} ` })).ok, true, 'e-posta küçük harfe çevrilir');
  // Davet okunduktan sonra, hak alınmadan hemen önce değişirse (yenisi üretildi / süresi doldu): koşul o anki satıra uygulanır
  const used = invited();
  used.db.before('userInvite.claim', () => { used.invite().usedAt = at(900); });
  assert.deepEqual(await used.verify(used.code), { ok: false, reason: 'unavailable' });
  const expired = invited();
  expired.db.before('userInvite.claim', () => { expired.invite().expiresAt = at(500); });
  assert.deepEqual(await expired.verify(expired.code), { ok: false, reason: 'unavailable' });
  const full = invited();
  full.db.before('userInvite.claim', () => { full.invite().attempts = 5; });
  assert.deepEqual(await full.verify(full.code), { ok: false, reason: 'unavailable' });
  assert.deepEqual([used.spy.calls, expired.spy.calls, full.spy.calls, used.invite().attempts, expired.invite().attempts, full.invite().attempts], [0, 0, 0, 0, 0, 5]);
});

test('davet: hakkın geri verilmesi başka isteğin hakkını açmaz — süren doğru doğrulama bir hak tutar; geri verince yalnızca KENDİ hakkı açılır', async () => {
  const t = invited();
  for (const c of t.wrong(4)) await t.verify(c);
  assert.equal(t.invite().attempts, 4);
  // D: doğru kod, hakkını aldı (5), geri vermesi bekletiliyor
  let release;
  t.db.before('userInvite.refund', () => new Promise((r) => { release = r; }));
  const d = t.verify(t.code);
  await until(() => release);
  assert.equal(t.invite().attempts, 5);
  // D sürerken gelen yanlış kod hak alamaz (karşılaştırılmaz)
  const w = t.wrong(7);
  assert.deepEqual(await t.verify(w[4]), { ok: false, reason: 'unavailable' });
  assert.equal(t.spy.wrong, 4);
  release();
  assert.equal((await d).ok, true);
  assert.equal(t.invite().attempts, 4, 'D yalnızca kendi hakkını geri verdi');
  // Açılan tek hak: bir yanlış karşılaştırma daha → 5; sonrası kapalı
  assert.deepEqual(await t.verify(w[5]), { ok: false, reason: 'wrong_code' });
  assert.deepEqual(await t.verify(w[6]), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await t.verify(t.code), { ok: false, reason: 'unavailable' });
  assert.deepEqual([t.spy.wrong, t.invite().attempts, t.db.st.maxAttempts, t.db.st.minAttempts], [5, 5, 5, 0]);
  // İki doğru doğrulama aynı anda sürerken (3 → 5): yanlış kod giremez; ikisi de geri verince 3
  const u = invited();
  for (const c of u.wrong(3)) await u.verify(c);
  const gates = [];
  u.db.before('userInvite.refund', () => new Promise((r) => { gates.push(r); }));
  u.db.before('userInvite.refund', () => new Promise((r) => { gates.push(r); }));
  const both = [u.verify(u.code), u.verify(u.code)];
  await until(() => gates.length === 2);
  assert.equal(u.invite().attempts, 5);
  assert.deepEqual(await u.verify(u.wrong(4)[3]), { ok: false, reason: 'unavailable' });
  for (const g of gates) g();
  assert.deepEqual((await Promise.all(both)).map((r) => r.ok), [true, true]);
  assert.deepEqual([u.invite().attempts, u.spy.wrong, u.db.st.maxAttempts], [3, 3, 5]);
});

test('davet: paralel doğru / yanlış karışımda sınır açılmaz — yanlış karşılaştırma en çok 5; attempts = yanlış karşılaştırma sayısı, 0 … 5 arasında', async () => {
  for (const [nWrong, nRight] of [[100, 100], [200, 5], [40, 1], [3, 50]]) {
    const t = invited();
    const codes = t.wrong(nWrong).map((c, i) => [i * 2, c]).concat(Array.from({ length: nRight }, (_, i) => [i * 2 + 1, t.code])).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const rs = await Promise.all(codes.map((c) => t.verify(c)));
    const expectWrong = Math.min(nWrong, 5);
    assert.equal(t.spy.wrong <= 5, true, `${nWrong}/${nRight}: ${t.spy.wrong} yanlış karşılaştırma`);
    assert.equal(t.invite().attempts, t.spy.wrong, `${nWrong}/${nRight}: attempts yanlış karşılaştırma sayısına eşit (geri verme başkasının hakkını açmadı)`);
    assert.deepEqual([t.db.st.maxAttempts <= 5, t.db.st.minAttempts >= 0], [true, true], `${nWrong}/${nRight}`);
    assert.equal(count(rs.map((r) => r.reason), 'wrong_code'), t.spy.wrong);
    assert.equal(count(rs.map((r) => r.ok), true) + count(rs.map((r) => r.reason), 'unavailable') + t.spy.wrong, nWrong + nRight);
    // Karışımdan sonra: kalan hak kadar yanlış deneme daha, sonra kapalı
    for (const c of t.wrong(nWrong + 10).slice(nWrong)) await t.verify(c);
    assert.deepEqual([t.spy.wrong, t.invite().attempts], [5, 5], `${nWrong}/${nRight}: toplam yanlış karşılaştırma ${expectWrong} → 5`);
  }
});

test('saf kurallar: codeMatches yalnızca karşılaştırır; checkInvite bellekteki kopyaya göre aynı sonuçları verir', () => {
  const { code, record } = createInvite('Ali@Unsal.ro', SECRET, 24, at(0));
  const o = { email: 'ali@unsal.ro', codeHash: record.codeHash, secret: SECRET };
  assert.equal(codeMatches({ ...o, code }), true);
  const other = code === '000000' ? '000001' : '000000';
  for (const bad of [other, '', null, undefined, '12345', '1234567', 'abcdef', `${code}0`]) assert.equal(codeMatches({ ...o, code: bad }), false, String(bad));
  assert.equal(codeMatches({ ...o, code, email: 'baska@unsal.ro' }), false);
  assert.equal(codeMatches({ ...o, code, codeHash: '' }), false);
  assert.equal(codeMatches({ ...o, code, codeHash: null }), false);
  assert.deepEqual(checkInvite({ code, email: 'ali@unsal.ro', record, secret: SECRET, now: at(1) }), { ok: true });
  assert.equal(checkInvite({ code, email: 'ali@unsal.ro', record: { ...record, attempts: 5 }, secret: SECRET, now: at(1) }).reason, 'locked');
});

// ───────────────────────── yapı ─────────────────────────

test('yapı: giriş ve kod ekranı yalnızca runAttempt\'i kullanır; "say → doğrula → kaydet" yolu ve koşulsuz attempts artırması yok', () => {
  const login = strip(read('app/login/actions.ts'));
  const setup = strip(read('app/setup/actions.ts'));
  const lib = strip(read('lib/auth/throttle.ts'));
  for (const [name, src] of [['login', login], ['setup', setup], ['lib', lib]]) {
    assert.equal(/throttleCheck|recordFailure|clearFailures|checkInvite|authFailure\./.test(src), false, `${name}: eski yol / doğrudan kayıt yok`);
  }
  assert.ok(login.includes("import { requestIp, runAttempt } from '@/lib/auth/throttle';") && setup.includes("import { requestIp, runAttempt } from '@/lib/auth/throttle';"));
  // Giriş: şifre doğrulaması runAttempt'e verilen işlevin İÇİNDE (hak ayrıldıktan sonra, işlem / kilit dışında)
  const call = login.indexOf("await runAttempt('LOGIN', email, ip, async () => {");
  const end = login.indexOf('  });', call);
  assert.ok(call > 0 && end > call);
  for (const s of ['db.user.findUnique({ where: { email } })', 'burnPasswordCheck(password)', 'verifyPassword(password, found.passwordHash)']) {
    const i = login.indexOf(s);
    assert.ok(i > call && i < end, `giriş: ${s} doğrulama işlevinin içinde`);
    assert.equal(login.indexOf(s, i + 1), -1, `giriş: ${s} bir kez`);
  }
  assert.ok(login.indexOf('createSession(user.id)') > end && login.indexOf('if (attempt.locked)') > end);
  // Kod ekranı: davet doğrulaması yalnızca runAttempt içinden; davet kaydı burada yazılmaz
  assert.ok(setup.includes("await runAttempt('CODE', email, ip, () => verifyInviteCode(db, { email, code, secret: authSecret() }));"));
  assert.equal((setup.match(/verifyInviteCode\(/g) ?? []).length, 1);
  const verifyBody = setup.slice(setup.indexOf('export async function verifyCodeAction'), setup.indexOf('export async function setPasswordAction'));
  assert.equal(/userInvite\.|attempts/.test(verifyBody), false, 'kod adımında davet kaydına doğrudan dokunulmaz');
  // lib: tek sarmalayıcı
  assert.deepEqual([...lib.matchAll(/^export (?:async )?(?:function|type|const) (\w+)/gm)].map((m) => m[1]), ['AttemptKind', 'requestIp', 'runAttempt']);
});

test('yapı: hak ayırma sırası — işlem → e-posta kilidi → IP kilidi → sayım → kilit kararı → kayıt; doğrulama işlemin dışında; davet hakkı karşılaştırmadan önce', () => {
  const svc = strip(read('server/auth/attempts.js'));
  const reserve = svc.slice(svc.indexOf('export async function reserveAttempt('), svc.indexOf('export async function failAttempt('));
  const order = ['db.$transaction(async (tx) => {', 'pg_advisory_xact_lock(hashtextextended(${`auth-email:${k.email}`}, 0))', 'pg_advisory_xact_lock(hashtextextended(${`auth-ip:${k.ip}`}, 0))',
    'tx.authFailure.findMany({ where: { email: k.email, createdAt: { gte: since } }', 'tx.authFailure.findMany({ where: { ip: k.ip, createdAt: { gte: since } }', 'throttleState(', 'if (state.locked) return',
    'tx.authFailure.create({ data: { kind: ATTEMPT_PENDING, email: k.email, ip: k.ip, createdAt: now }', "isolationLevel: 'ReadCommitted'"];
  const pos = order.map((s) => reserve.indexOf(s));
  assert.ok(pos.every((i) => i >= 0), `eksik: ${order.filter((_, i) => pos[i] < 0).join(' | ')}`);
  assert.deepEqual(pos, [...pos].sort((a, b) => a - b), 'sıra');
  assert.equal(/db\.authFailure\.|verify\(|kind: \{/.test(reserve), false, 'sayım ve kayıt yalnızca işlemin içinde (tx); sayım türe bakmaz; doğrulama burada çağrılmaz');
  assert.equal((reserve.match(/pg_advisory_xact_lock/g) ?? []).length, 2);
  // runAttempt: önce hak, sonra doğrulama, sonra sonuç; hata yolunda deneme hata sayılır
  const run = svc.slice(svc.indexOf('export async function runAttempt('));
  const steps = ['await reserveAttempt(db, { email, ip, now })', 'if (!reserved.ok) return { locked: true', 'await verify()', 'await failAttempt(db, { id: reserved.id, kind, now })', 'await clearAttempts(db, { id: reserved.id, email, ip })',
    'await releaseAttempt(db, { id: reserved.id })', 'finally', 'if (!settled) await failAttempt(db, { id: reserved.id, kind, now })'];
  const at2 = steps.map((s) => run.indexOf(s));
  assert.ok(at2.every((i) => i >= 0), `eksik: ${steps.filter((_, i) => at2[i] < 0).join(' | ')}`);
  assert.deepEqual(at2, [...at2].sort((a, b) => a - b));
  assert.equal(/\$transaction|\$executeRaw/.test(run), false, 'doğrulama çevresinde işlem / kilit yok');
  // Servis saf veritabanı kodudur: şifre / ağ / ortam yüklemez
  assert.deepEqual([...read('server/auth/attempts.js').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['./throttle.js']);
  assert.deepEqual([...read('server/auth/invite-claim.js').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['./inviteCode.js']);
  // Davet: koşullu hak alma → karşılaştırma → geri verme
  const claim = strip(read('server/auth/invite-claim.js'));
  const seq = ['where: { id: invite.id, usedAt: null, sentAt: { not: null }, expiresAt: { gt: now }, attempts: { lt: MAX_ATTEMPTS } }', 'data: { attempts: { increment: 1 } }', "if (claimed.count !== 1) return { ok: false, reason: 'unavailable' }",
    'compare({ code, email: mail, codeHash: invite.codeHash, secret })', 'where: { id: invite.id, attempts: { gt: 0 } }, data: { attempts: { decrement: 1 } }'];
  const p3 = seq.map((s) => claim.indexOf(s));
  assert.ok(p3.every((i) => i >= 0), `eksik: ${seq.filter((_, i) => p3[i] < 0).join(' | ')}`);
  assert.deepEqual(p3, [...p3].sort((a, b) => a - b));
  assert.equal((claim.match(/compare\(/g) ?? []).length, 1);
});

test('yapı: deneme kaydını ve davet deneme sayısını yazan başka uygulama kodu yok', () => {
  const walk = (dir, exts) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, exts) : exts.test(e.name) ? [p] : [];
  });
  const files = walk('app', /\.tsx?$/).concat(walk('lib', /\.tsx?$/), walk('components', /\.tsx?$/), walk('server', /\.js$/), walk('scripts', /\.m?js$/));
  const using = (re) => files.filter((f) => re.test(strip(read(f)))).sort();
  // AuthFailure yazanlar: deneme servisi; eski kayıt temizliği (işçi); depo bağlantısı sayacı (kendi türü — karar 148 kapsamı dışı)
  assert.deepEqual(using(/authFailure\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/), [path.join('app', 'depo', '[token]', 'actions.ts'), path.join('server', 'auth', 'attempts.js'), path.join('server', 'auth', 'session-policy.js')]);
  assert.equal(/authFailure\.(create|update|updateMany|upsert)\(/.test(strip(read('server/auth/session-policy.js'))), false, 'temizlik yalnızca siler');
  // Davetin deneme sayısı yalnızca koşullu hak alma / geri verme ile değişir
  const inviteWriters = using(/userInvite\.(create|update|updateMany|upsert)\(/);
  // server/users/lifecycle.js: yöneticinin e-posta değişikliği (karar 222) — eski davetleri kapatır, yeni adrese davet yazar; attempts'e dokunmaz
  // server/auth/admin-bootstrap.js: kurulum komutu takip yonetici (karar 247; eskiden scripts/create-admin.mjs) — attempts'e dokunmaz
  // server/auth/admin-recovery.js: SSH acil kurtarma (karar 246) — açık davetleri kapatır (usedAt); attempts'e dokunmaz
  assert.deepEqual(inviteWriters, [path.join('app', 'setup', 'actions.ts'), path.join('lib', 'invite.ts'), path.join('server', 'auth', 'admin-bootstrap.js'), path.join('server', 'auth', 'admin-recovery.js'), path.join('server', 'auth', 'invite-claim.js'), path.join('server', 'users', 'lifecycle.js')]);
  assert.deepEqual(inviteWriters.filter((f) => /attempts/.test(strip(read(f)))), [path.join('server', 'auth', 'invite-claim.js')], 'attempts yalnızca hak alma / geri verme ile değişir');
  assert.deepEqual(using(/verifyInviteCode\(/), [path.join('app', 'setup', 'actions.ts'), path.join('server', 'auth', 'invite-claim.js')]);
  assert.deepEqual(using(/\b(runAttempt|runAttemptIn)\(/), [path.join('app', 'login', 'actions.ts'), path.join('app', 'setup', 'actions.ts'), path.join('lib', 'auth', 'throttle.ts'), path.join('server', 'auth', 'attempts.js')]);
  assert.deepEqual(using(/\b(reserveAttempt|failAttempt|releaseAttempt|clearAttempts)\(/), [path.join('server', 'auth', 'attempts.js')]);
});
