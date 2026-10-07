// Giriş / kod denemesi sınırı ve davet kodu deneme hakkı — atomik (karar 148; güvenlik denetimi 3.50.9 AUD-10).
// GERÇEK PostgreSQL ile: paralel isteklerin sınırları aşamadığı, danışma kilitlerinin gerçekten beklediği ve sabit sırayla
// alındığı (pg_locks), koşullu güncellemenin (davet hakkı) ve geri vermenin eşzamanlılık altında doğru kaldığı.
// Dış servis yok: testler ağ engeliyle (offline) çalışır; şifre / kod doğrulaması sahte işlevdir.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const at = await import('../../server/auth/attempts.js');
const { verifyInviteCode } = await import('../../server/auth/invite-claim.js');
const { MAX_ATTEMPTS, codeMatches, createInvite } = await import('../../server/auth/inviteCode.js');
const { LIMITS, WINDOW_MS } = await import('../../server/auth/throttle.js');

const SECRET = 'd'.repeat(40);
const MIN = 60_000;
let db, factory, seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = (list, v) => list.filter((x) => x === v).length;
const fresh = () => { seq += 1; return { email: `kisi${seq}@deneme.test`, ip: `198.51.${Math.floor(seq / 250)}.${(seq % 250) + 1}` }; };
const rows = (where) => db.authFailure.findMany({ where, orderBy: { createdAt: 'asc' } });
const kinds = async (where) => (await rows(where)).map((r) => r.kind);
const result = (r) => (r.locked ? 'locked' : r.outcome.ok ? 'ok' : 'invalid');
const attempt = (o, ok = false, wait = null) => at.runAttempt(db, { kind: 'LOGIN', ...o }, async () => { if (wait) await wait(); return { ok }; });

/** Koşul sağlanana kadar bekler (en çok ~10 sn) */
async function until(cond) {
  for (let i = 0; i < 200; i++) { if (await cond()) return true; await sleep(50); }
  return false;
}
/** İşlev sürerken `read` değerini sürekli okur (ara durumları yakalamak için) */
async function watching(read, fn) {
  let stop = false;
  const seen = [];
  const loop = (async () => { while (!stop) seen.push(await read()); })();
  try {
    return { out: await fn(), seen };
  } finally {
    stop = true;
    await loop;
  }
}
/** Bu anahtarın kilidini bekleyen (henüz alamamış) oturum sayısı */
const waitingOn = async (key) => (await db.$queryRaw`
  SELECT count(*)::int AS n FROM pg_locks
  WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`)[0].n;
/** `held` anahtarını ALMIŞ ve aynı anda `wanted` anahtarını BEKLEYEN oturum sayısı (kilit sırası) */
const holdsAndWaits = async (held, wanted) => (await db.$queryRaw`
  SELECT count(*)::int AS n FROM pg_locks a JOIN pg_locks b ON a.pid = b.pid
  WHERE a.locktype = 'advisory' AND a.granted AND ((a.classid::bigint << 32) | a.objid::bigint) = hashtextextended(${held}, 0)
    AND b.locktype = 'advisory' AND NOT b.granted AND ((b.classid::bigint << 32) | b.objid::bigint) = hashtextextended(${wanted}, 0)`)[0].n;
/** Verilen anahtarların kilidini başka bir işlemde tutar; release(fn) → (isteğe bağlı) fn(tx) çalışır ve işlem biter */
function holder(keys) {
  let release;
  let ready;
  const gate = new Promise((r) => { release = r; });
  const got = new Promise((r) => { ready = r; });
  const done = db.$transaction(async (tx) => {
    for (const k of keys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
    ready();
    const fn = await gate;
    if (fn) await fn(tx);
  }, { timeout: 30_000 });
  return { got, release: (fn = null) => { release(fn); return done; } };
}
/** Davet bekleyen kullanıcı + gönderilmiş davet */
async function invited(inviteExtra = {}, userExtra = {}) {
  seq += 1;
  const email = `davet${seq}@deneme.test`;
  const user = await db.user.create({ data: { email, name: `Davet ${seq}`, type: 'CUSTOMER', appRole: 'MUSTERI', customerId: factory.id, ...userExtra } });
  const { code, record } = createInvite(email, SECRET, 24);
  const invite = await db.userInvite.create({ data: { userId: user.id, codeHash: record.codeHash, expiresAt: record.expiresAt, sentAt: new Date(), ...inviteExtra } });
  const spy = { calls: 0, wrong: 0 };
  const compare = (o) => { spy.calls += 1; const same = codeMatches(o); if (!same) spy.wrong += 1; return same; };
  const verify = (c, o = {}) => verifyInviteCode(db, { email, code: c, secret: SECRET, compare, ...o });
  const wrong = (n) => { const out = []; for (let i = 0; out.length < n; i++) { const c = String(i).padStart(6, '0'); if (c !== code) out.push(c); } return out; };
  const attempts = async () => (await db.userInvite.findUniqueOrThrow({ where: { id: invite.id } })).attempts;
  return { email, user, invite, code, spy, verify, wrong, attempts };
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  factory = await db.customer.create({ data: { name: 'Deneme Cam SRL', prefix: 'DNM' } });
});
after(closeDb);

// ───────────────────────── deneme sınırı ─────────────────────────

dbTest('paralel isteklerle sınır aşılamaz: aynı e-posta + IP en çok 5 · aynı e-posta, farklı IP en çok 20 · farklı e-posta, aynı IP en çok 30', offline(async () => {
  assert.deepEqual([LIMITS, WINDOW_MS], [{ account: 5, email: 20, ip: 30 }, 15 * MIN]);
  // Aynı e-posta + IP: 40 paralel istek → tam 5 hak; satırların hepsi PENDING (doğrulaması süren deneme)
  const a = fresh();
  const same = await Promise.all(Array.from({ length: 40 }, () => at.reserveAttempt(db, a)));
  assert.deepEqual([tally(same.map((r) => r.ok), true), tally(same.map((r) => r.ok), false)], [5, 35]);
  assert.deepEqual(await kinds({ email: a.email }), ['PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING']);
  assert.ok(same.filter((r) => !r.ok).every((r) => r.minutes >= 1 && r.minutes <= 15));
  // Süren denemeler sayılır: altıncı istek (sırayla) da kilitli
  assert.equal((await at.reserveAttempt(db, a)).ok, false);
  // Aynı e-posta, 30 ayrı IP → tam 20
  const b = fresh();
  const byEmail = await Promise.all(Array.from({ length: 30 }, (_, i) => at.reserveAttempt(db, { email: b.email, ip: `203.0.113.${i + 1}` })));
  assert.deepEqual([tally(byEmail.map((r) => r.ok), true), (await rows({ email: b.email })).length], [20, 20]);
  // Farklı 40 e-posta, aynı IP → tam 30
  const c = fresh();
  const byIp = await Promise.all(Array.from({ length: 40 }, (_, i) => at.reserveAttempt(db, { email: `ip${i}-${c.email}`, ip: c.ip })));
  assert.deepEqual([tally(byIp.map((r) => r.ok), true), (await rows({ ip: c.ip })).length], [30, 30]);
  // Başka e-posta + IP bunlardan etkilenmez
  assert.equal((await at.reserveAttempt(db, fresh())).ok, true);
}));

dbTest('mevcut K hata varken paralel isteklerde yalnızca kalan hak kadar deneme ayrılır; 15 dakikalık pencere dolunca yeniden izin verilir', offline(async () => {
  const T0 = new Date('2026-10-07T09:00:00Z').getTime();
  for (const k of [0, 3, 5]) {
    const p = fresh();
    await db.authFailure.createMany({ data: Array.from({ length: k }, (_, i) => ({ kind: i % 2 ? 'CODE' : 'LOGIN', email: p.email, ip: p.ip, createdAt: new Date(T0 - (i + 1) * 1000) })) });
    const rs = await Promise.all(Array.from({ length: 20 }, () => at.reserveAttempt(db, { ...p, now: new Date(T0) })));
    assert.deepEqual([tally(rs.map((r) => r.ok), true), (await rows({ email: p.email })).length], [5 - k, 5], `K=${k}`);
  }
  // Pencere: 5 hata (0. … 4. dakika) → kilit; 15. dakikada ilk hata pencereden çıkar; 40. dakikada hepsi
  const p = fresh();
  for (let i = 0; i < 5; i++) assert.equal(result(await attempt({ ...p, now: new Date(T0 + i * MIN) })), 'invalid');
  assert.deepEqual(await attempt({ ...p, now: new Date(T0 + 5 * MIN) }, true), { locked: true, minutes: 10 });
  assert.deepEqual(await attempt({ ...p, now: new Date(T0 + 15 * MIN - 1) }, true), { locked: true, minutes: 1 });
  assert.equal(result(await attempt({ ...p, now: new Date(T0 + 15 * MIN) })), 'invalid');
  assert.equal((await attempt({ ...p, now: new Date(T0 + 15 * MIN + 1) })).locked, true);
  const later = await Promise.all(Array.from({ length: 20 }, () => at.reserveAttempt(db, { ...p, now: new Date(T0 + 40 * MIN) })));
  assert.equal(tally(later.map((r) => r.ok), true), 5, 'pencere sonrası yine tam 5');
}));

dbTest('deneme yaşam döngüsü: başarısız → AYNI satır hata olur · giriş başarılı → kendi satırı + çiftin tamamlanmış hataları silinir · doğru kod → yalnızca kendi satırı', offline(async () => {
  const p = fresh();
  const other = fresh();
  // Başarısız: tek satır, PENDING → LOGIN (ikinci satır yok); doğrulama sırasında satır PENDING'dir
  let during = null;
  const r1 = await at.runAttempt(db, { kind: 'LOGIN', ...p }, async () => { during = await kinds({ email: p.email }); return { ok: false, user: null }; });
  assert.deepEqual([during, r1, await kinds({ email: p.email })], [['PENDING'], { locked: false, outcome: { ok: false, user: null } }, ['LOGIN']]);
  await at.runAttempt(db, { kind: 'CODE', ...p }, async () => ({ ok: false }));
  assert.deepEqual(await kinds({ email: p.email }), ['LOGIN', 'CODE']);
  // Aynı e-postanın başka IP'si, aynı IP'nin başka e-postası, süren başka deneme (PENDING) ve depo sayacı
  await db.authFailure.createMany({ data: [
    { kind: 'LOGIN', email: p.email, ip: other.ip },
    { kind: 'LOGIN', email: other.email, ip: p.ip },
    { kind: 'PENDING', email: p.email, ip: p.ip },
    { kind: 'DEPOT', email: '-', ip: p.ip },
  ] });
  // Doğru kod: yalnızca kendi satırı silinir, öteki hatalar kalır
  assert.equal(result(await at.runAttempt(db, { kind: 'CODE', ...p }, async () => ({ ok: true }))), 'ok');
  assert.deepEqual((await kinds({ email: p.email, ip: p.ip })).sort(), ['CODE', 'LOGIN', 'PENDING']);
  // Başarılı giriş: kendi satırı + bu çiftin tamamlanmış hataları silinir; süren deneme, başka IP / e-posta ve depo satırı kalır
  assert.equal(result(await attempt(p, true)), 'ok');
  assert.deepEqual(await kinds({ email: p.email, ip: p.ip }), ['PENDING'], 'süren deneme silinmedi');
  assert.deepEqual([await kinds({ email: p.email, ip: other.ip }), await kinds({ email: other.email, ip: p.ip }), await kinds({ email: '-', ip: p.ip })], [['LOGIN'], ['LOGIN'], ['DEPOT']]);
  // Kilitliyken doğrulama hiç çalışmaz (doğru şifre de açmaz)
  const q = fresh();
  for (let i = 0; i < 5; i++) await attempt(q);
  let called = 0;
  const locked = await at.runAttempt(db, { kind: 'LOGIN', ...q }, async () => { called += 1; return { ok: true }; });
  assert.deepEqual([locked.locked, called, (await rows({ email: q.email })).length], [true, 0, 5]);
}));

dbTest('beklenmeyen hata ve yarıda kalan deneme kalıcı kilit yaratmaz: hata → deneme hata sayılır (PENDING kalmaz); PENDING satır pencere sonunda etkisizdir, bir gün sonra silinir', offline(async () => {
  const T0 = new Date('2026-10-07T10:00:00Z').getTime();
  const boom = new Error('doğrulama sırasında beklenmeyen hata');
  const p = fresh();
  // Doğrulama hata fırlatırsa: asıl hata yukarı gider, satır tamamlanmış hatadır
  await assert.rejects(at.runAttempt(db, { kind: 'LOGIN', ...p, now: new Date(T0) }, async () => { throw boom; }), (e) => e === boom);
  assert.deepEqual(await kinds({ email: p.email }), ['LOGIN']);
  // Beş kez üst üste: beş hata, PENDING yok → olağan kilit; sonraki başarılı giriş (pencere sonrası) temizler
  for (let i = 1; i < 5; i++) await assert.rejects(at.runAttempt(db, { kind: 'LOGIN', ...p, now: new Date(T0 + i) }, async () => { throw boom; }));
  assert.deepEqual([(await rows({ email: p.email, kind: 'PENDING' })).length, (await rows({ email: p.email, kind: 'LOGIN' })).length], [0, 5]);
  assert.equal((await attempt({ ...p, now: new Date(T0 + 10) }, true)).locked, true);
  assert.equal(result(await attempt({ ...p, now: new Date(T0 + 15 * MIN + 10) }, true)), 'ok');
  assert.equal((await rows({ email: p.email })).length, 0);

  // Sunucu doğrulama sırasında kapandı: iki satır PENDING kaldı
  const s = fresh();
  await db.authFailure.createMany({ data: [{ kind: 'PENDING', email: s.email, ip: s.ip, createdAt: new Date(T0) }, { kind: 'PENDING', email: s.email, ip: s.ip, createdAt: new Date(T0 + 1000) }] });
  // Pencere içinde hak kullanır (5 − 2 = 3) ve başarılı giriş onları silmez — ama çiftte 5'ten çok satır olamaz
  const inWindow = await Promise.all(Array.from({ length: 12 }, () => at.reserveAttempt(db, { ...s, now: new Date(T0 + 2000) })));
  assert.deepEqual([tally(inWindow.map((r) => r.ok), true), (await rows({ email: s.email })).length], [3, 5]);
  // Pencere dolunca PENDING satırlar (silinmemiş olsalar da) sayılmaz: tam 5 hak
  assert.equal((await rows({ email: s.email, kind: 'PENDING' })).length, 5);
  const after15 = await Promise.all(Array.from({ length: 12 }, () => at.reserveAttempt(db, { ...s, now: new Date(T0 + 15 * MIN + 2001) })));
  assert.equal(tally(after15.map((r) => r.ok), true), 5);
  // Bir günden eski kayıtlar bir sonraki hatada silinir (PENDING dahil); yeni kayıtlar kalır
  const keep = fresh();
  await db.authFailure.create({ data: { kind: 'LOGIN', email: keep.email, ip: keep.ip, createdAt: new Date(T0 + 25 * 60 * MIN - 1000) } });
  await at.failAttempt(db, { id: 'yok', kind: 'LOGIN', now: new Date(T0 + 25 * 60 * MIN) });
  assert.deepEqual([(await rows({ email: s.email })).length, (await rows({ email: keep.email })).length], [0, 1]);
  await db.authFailure.deleteMany({ where: { email: keep.email } });
}));

dbTest('kilit gerçekten bekler ve karar güncel sayıma göre verilir: e-posta kilidi başka işlemdeyken hak ayırma BEKLER; o işlem 5 hata yazıp bitince istek reddedilir', offline(async () => {
  const p = fresh();
  const emailKey = `auth-email:${p.email}`;
  const h = holder([emailKey]);
  await h.got;
  let done = false;
  const pending = at.reserveAttempt(db, p).then((r) => { done = true; return r; });
  const waited = await until(async () => done || (await waitingOn(emailKey)) === 1);
  try {
    assert.equal(waited && !done, true, 'hak ayırma e-posta kilidinde bekliyor');
    assert.equal((await rows({ email: p.email })).length, 0, 'beklerken hiçbir şey yazılmadı');
  } finally {
    // Kilidi tutan işlem, bırakmadan önce bu çift için 5 hata yazar
    await h.release((tx) => tx.authFailure.createMany({ data: Array.from({ length: 5 }, () => ({ kind: 'LOGIN', email: p.email, ip: p.ip })) }));
  }
  // Bekleyen istek GÜNCEL sayıyı (5) görür → kilitli; eski sayıyla (0) karar verseydi altıncı satırı yazardı
  const r = await pending;
  assert.deepEqual([r.ok, (await rows({ email: p.email })).length, await waitingOn(emailKey)], [false, 5, 0]);
}));

dbTest('kilit sırası sabittir (önce e-posta, sonra IP); başka e-posta + IP beklemez; çapraz ızgarada kilitlenme (deadlock) olmaz', offline(async () => {
  const p = fresh();
  const emailKey = `auth-email:${p.email}`;
  const ipKey = `auth-ip:${p.ip}`;
  // Yalnızca IP kilidi başkasında: istek e-posta kilidini ALIR, IP kilidinde BEKLER
  const h = holder([ipKey]);
  await h.got;
  let done = false;
  const pending = at.reserveAttempt(db, p).then((r) => { done = true; return r; });
  const ordered = await until(async () => done || (await holdsAndWaits(emailKey, ipKey)) === 1);
  try {
    assert.equal(ordered && !done, true, 'e-posta kilidi alınmış, IP kilidi bekleniyor');
    assert.equal(await holdsAndWaits(ipKey, emailKey), 0, 'ters sıra yok');
    // Aynı anda başka e-posta + IP hiçbir şey beklemeden hak ayırır
    assert.equal((await at.reserveAttempt(db, fresh())).ok, true);
  } finally {
    await h.release();
  }
  assert.equal((await pending).ok, true);
  // Çapraz ızgara: 5 e-posta × 5 IP, her çift için 2 istek, karışık sırayla (50 paralel işlem) → hepsi tamamlanır
  const tag = fresh().email;
  const cells = [];
  for (let e = 0; e < 5; e++) for (let i = 0; i < 5; i++) cells.push({ email: `g${e}-${tag}`, ip: `192.0.2.${i + 1}` });
  const order = [...cells, ...cells.slice().reverse()];
  const rs = await Promise.all(order.map((c) => at.reserveAttempt(db, c)));
  assert.equal(tally(rs.map((r) => r.ok), true), 50, 'kilitlenme / hata yok; hepsi sınırların altında');
  for (let e = 0; e < 5; e++) assert.equal((await rows({ email: `g${e}-${tag}` })).length, 10);
  await db.authFailure.deleteMany({ where: { ip: { startsWith: '192.0.2.' } } });
}));

dbTest('başarılı giriş, doğrulaması süren başka denemelerin hakkını açmaz; paralel başarılı / başarısız karışımda çiftte hiçbir an 5\'ten çok satır olmaz', offline(async () => {
  // Belirli sıra: A–D sürüyor (hak ayrıldı), S başarılı olur → yalnızca S'nin hakkı açılır
  const p = fresh();
  const gates = [];
  const hold = () => new Promise((r) => { gates.push(r); });
  const inflight = [0, 1, 2, 3].map(() => attempt(p, false, hold));
  assert.equal(await until(async () => gates.length === 4), true);
  assert.equal(result(await attempt(p, true)), 'ok');
  assert.deepEqual(await kinds({ email: p.email }), ['PENDING', 'PENDING', 'PENDING', 'PENDING'], 'süren dört deneme yerinde');
  const extra = attempt(p, false, hold);
  assert.equal(await until(async () => gates.length === 5), true);
  assert.equal((await attempt(p, true)).locked, true, 'yalnızca bir hak açılmıştı');
  for (const g of gates) g();
  assert.deepEqual((await Promise.all([...inflight, extra])).map(result), ['invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
  assert.deepEqual(await kinds({ email: p.email }), ['LOGIN', 'LOGIN', 'LOGIN', 'LOGIN', 'LOGIN']);

  // Karışım: 45 yanlış + 3 doğru deneme, aynı e-posta + IP, aynı anda, rastgele sürelerle
  const q = fresh();
  const stats = { wrong: 0 };
  const flow = (i) => at.runAttempt(db, { kind: 'LOGIN', ...q }, async () => {
    await sleep((i * 7) % 23);
    const ok = i % 16 === 7;
    if (!ok) stats.wrong += 1;
    return { ok };
  });
  const { out, seen } = await watching(() => db.authFailure.count({ where: { email: q.email, ip: q.ip } }), () => Promise.all(Array.from({ length: 48 }, (_, i) => flow(i))));
  const rs = out.map(result);
  const ok = tally(rs, 'ok');
  assert.equal(Math.max(...seen) <= 5, true, `çiftte en çok 5 satır (görülen en çok: ${Math.max(...seen)})`);
  assert.equal(stats.wrong <= 5 * (ok + 1) - ok, true, `${stats.wrong} yanlış doğrulama, ${ok} başarılı giriş`);
  assert.equal((await rows({ email: q.email, kind: 'PENDING' })).length, 0, 'bittiğinde süren deneme yok');
  assert.equal((await rows({ email: q.email })).length <= 5, true);
  // Başarılı giriş yokken: 60 paralel yanlış deneme → tam 5 doğrulama
  const w = fresh();
  let verified = 0;
  const all = await Promise.all(Array.from({ length: 60 }, () => at.runAttempt(db, { kind: 'LOGIN', ...w }, async () => { verified += 1; await sleep(5); return { ok: false }; })));
  assert.deepEqual([verified, tally(all.map(result), 'invalid'), tally(all.map(result), 'locked'), await kinds({ email: w.email })], [5, 5, 55, ['LOGIN', 'LOGIN', 'LOGIN', 'LOGIN', 'LOGIN']]);
}));

// ───────────────────────── davet kodu ─────────────────────────

dbTest('davet: 5 yanlış kod karşılaştırılır; 6. deneme karşılaştırılmaz — doğru kod olsa da reddedilir; doğru kod hakkı geri verir', offline(async () => {
  assert.equal(MAX_ATTEMPTS, 5);
  const t = await invited();
  for (const c of t.wrong(5)) assert.deepEqual(await t.verify(c), { ok: false, reason: 'wrong_code' });
  assert.deepEqual([t.spy.calls, await t.attempts()], [5, 5]);
  assert.deepEqual(await t.verify(t.wrong(6)[5]), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await t.verify(t.code), { ok: false, reason: 'unavailable' }, 'kilitli davette doğru kod da geçmez');
  assert.deepEqual([t.spy.calls, await t.attempts()], [5, 5], 'altıncı ve yedinci istekte kod karşılaştırılmadı');
  // Doğru kod: hak geri verilir; art arda doğrulamalar ve önceki yanlışlar değişmez
  const u = await invited();
  assert.deepEqual(await u.verify(u.code), { ok: true, inviteId: u.invite.id, userId: u.user.id });
  for (let i = 0; i < 8; i++) assert.equal((await u.verify(u.code)).ok, true);
  assert.equal(await u.attempts(), 0);
  for (const c of u.wrong(3)) await u.verify(c);
  assert.equal((await u.verify(u.code)).ok, true);
  assert.equal(await u.attempts(), 3, 'doğru kod önceki yanlışları silmez, yalnızca kendi hakkını geri verir');
}));

dbTest('davet: süresi dolmuş / kullanılmış / gönderilmemiş davet ve uygun olmayan kullanıcı hak alamaz — kod karşılaştırılmaz, attempts değişmez', offline(async () => {
  const cases = [
    ['süresi dolmuş', { expiresAt: new Date(Date.now() - 1000) }, {}, 'unavailable'],
    ['kullanılmış', { usedAt: new Date() }, {}, 'no_invite'],
    ['gönderilmemiş', { sentAt: null }, {}, 'no_invite'],
    ['şifresi olan kullanıcı', {}, { passwordHash: 'scrypt$16384$8$1$x$y' }, 'no_invite'],
    ['pasif kullanıcı', {}, { isActive: false }, 'no_invite'],
  ];
  for (const [name, inviteExtra, userExtra, reason] of cases) {
    const t = await invited(inviteExtra, userExtra);
    assert.deepEqual(await t.verify(t.code), { ok: false, reason }, name);
    assert.deepEqual([t.spy.calls, await t.attempts()], [0, 0], name);
  }
  const t = await invited();
  assert.deepEqual(await verifyInviteCode(db, { email: 'yok@deneme.test', code: t.code, secret: SECRET }), { ok: false, reason: 'no_invite' });
  // Süre, hak alınırken o anki zamana göre denetlenir: süresinden bir an sonra hak alınamaz
  assert.deepEqual(await t.verify(t.code, { now: new Date(t.invite.expiresAt.getTime()) }), { ok: false, reason: 'unavailable' });
  assert.equal((await t.verify(t.code, { now: new Date(t.invite.expiresAt.getTime() - 1) })).ok, true);
  assert.deepEqual([t.spy.calls, await t.attempts()], [1, 0]);
  // Yeni davet üretilince (eskisi "kullanıldı" işaretlenir) eski kod hak alamaz
  await db.userInvite.update({ where: { id: t.invite.id }, data: { usedAt: new Date() } });
  assert.deepEqual(await t.verify(t.code), { ok: false, reason: 'no_invite' });
}));

dbTest('davet: paralel 40 ve 200 yanlış kodda yalnızca 5 karşılaştırma; attempts tam 5 ve hiçbir an 5\'i geçmez', offline(async () => {
  for (const n of [40, 200]) {
    const t = await invited();
    const { out, seen } = await watching(t.attempts, () => Promise.all(t.wrong(n).map((c) => t.verify(c))));
    assert.deepEqual([tally(out.map((r) => r.reason), 'wrong_code'), tally(out.map((r) => r.reason), 'unavailable')], [5, n - 5], `${n} istek`);
    assert.deepEqual([t.spy.calls, await t.attempts()], [5, 5], `${n} istek`);
    assert.equal(Math.max(...seen, 0) <= 5, true, `${n} istek: attempts hiçbir an 5'i geçmedi`);
    assert.deepEqual(await t.verify(t.code), { ok: false, reason: 'unavailable' });
  }
}));

dbTest('davet: hakkın geri verilmesi başka isteğin hakkını açmaz — süren doğru doğrulama bir hak tutar, geri verince yalnızca kendi hakkı açılır; paralel doğru / yanlış karışımda sınır açılmaz', offline(async () => {
  // Belirli sıra: 4 yanlış → D (doğru kod) hakkını aldı ve karşılaştırması bekletiliyor (attempts 5)
  const t = await invited();
  for (const c of t.wrong(4)) await t.verify(c);
  let release;
  let entered = false;
  const slow = (o) => { entered = true; return new Promise((r) => { release = () => r(codeMatches(o)); }); };
  const d = verifyInviteCode(db, { email: t.email, code: t.code, secret: SECRET, compare: slow });
  assert.equal(await until(async () => entered), true);
  assert.equal(await t.attempts(), 5, 'süren doğrulama bir hak tutuyor');
  const w = t.wrong(7);
  assert.deepEqual(await t.verify(w[4]), { ok: false, reason: 'unavailable' }, 'D sürerken yanlış kod hak alamaz');
  assert.equal(t.spy.wrong, 4);
  release();
  assert.equal((await d).ok, true);
  assert.equal(await t.attempts(), 4, 'D yalnızca kendi hakkını geri verdi');
  assert.deepEqual(await t.verify(w[5]), { ok: false, reason: 'wrong_code' });
  assert.deepEqual(await t.verify(w[6]), { ok: false, reason: 'unavailable' });
  assert.deepEqual([t.spy.wrong, await t.attempts()], [5, 5], 'toplam yanlış karşılaştırma 5');

  // Karışım: paralel doğru + yanlış istekler; attempts her an 0 … 5 arasında, sonunda yanlış karşılaştırma sayısına eşit
  for (const [nWrong, nRight] of [[60, 60], [120, 4], [3, 40]]) {
    const m = await invited();
    const codes = m.wrong(nWrong).map((c, i) => [i * 2, c]).concat(Array.from({ length: nRight }, (_, i) => [i * 2 + 1, m.code])).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const { out, seen } = await watching(m.attempts, () => Promise.all(codes.map((c) => m.verify(c))));
    assert.equal(m.spy.wrong <= 5, true, `${nWrong}/${nRight}: ${m.spy.wrong} yanlış karşılaştırma`);
    assert.equal(await m.attempts(), m.spy.wrong, `${nWrong}/${nRight}: attempts = yanlış karşılaştırma (geri verme başkasının hakkını açmadı)`);
    assert.deepEqual([Math.max(...seen, 0) <= 5, Math.min(...seen, 0) >= 0], [true, true], `${nWrong}/${nRight}`);
    assert.equal(tally(out.map((r) => r.reason), 'wrong_code'), m.spy.wrong);
    // Karışımdan sonra kalan hak kadar yanlış deneme, sonra kapalı
    for (const c of m.wrong(nWrong + 8).slice(nWrong)) await m.verify(c);
    assert.deepEqual([m.spy.wrong, await m.attempts()], [5, 5], `${nWrong}/${nRight}`);
  }
}));

dbTest('kod adımı uçtan uca (deneme sınırı + davet hakkı birlikte): ayrı IP\'lerden 12 paralel yanlış kod → 5 karşılaştırma; doğru kod kendi denemesini siler, hata saymaz', offline(async () => {
  const t = await invited();
  const step = (code, ip) => at.runAttempt(db, { kind: 'CODE', email: t.email, ip }, () => t.verify(code));
  // 12 ayrı IP (e-posta sınırı 20'nin altında): deneme sınırı hepsine izin verir, davet hakkı yalnızca 5'ine
  const rs = await Promise.all(t.wrong(12).map((c, i) => step(c, `203.0.114.${i + 1}`)));
  assert.deepEqual([tally(rs.map((r) => r.locked), false), tally(rs.map((r) => r.outcome.reason), 'wrong_code'), tally(rs.map((r) => r.outcome.reason), 'unavailable')], [12, 5, 7]);
  assert.deepEqual([t.spy.calls, await t.attempts(), await kinds({ email: t.email })], [5, 5, Array(12).fill('CODE')]);
  // Kilitli davette doğru kod: reddedilir ve bu da bir hatadır
  const r = await step(t.code, '203.0.114.50');
  assert.deepEqual([r.outcome, (await rows({ email: t.email })).length], [{ ok: false, reason: 'unavailable' }, 13]);
  // Yeni davette doğru kod: ayrılan deneme silinir; attempts 0
  const u = await invited();
  await db.authFailure.create({ data: { kind: 'CODE', email: u.email, ip: '203.0.114.60' } });
  const ok = await at.runAttempt(db, { kind: 'CODE', email: u.email, ip: '203.0.114.60' }, () => u.verify(u.code));
  assert.deepEqual([ok.outcome.ok, await u.attempts(), await kinds({ email: u.email })], [true, 0, ['CODE']], 'önceki hata duruyor, doğru kodun denemesi silindi');
}));
