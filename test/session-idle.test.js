// 30 dakika etkinlik olmayan oturum kapanır (karar 135) — sahte saatle: gerçek sunucu kuralı (liveSession /
// recordActivity, bellek içi sahte veritabanıyla) + gerçek tarayıcı izleyicisi (createActivityTracker) birlikte oynatılır.
// Hiçbir test gerçekten beklemez; zaman `world.advance` ile ilerletilir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_IDLE_MS, SESSION_TTL_MS, liveSession, recordActivity } from '../server/auth/session-policy.js';
import { ACTIVITY_HEADER, ACTIVITY_REPORT_MS, ACTIVITY_URL, IDLE_CHECK_GRACE_MS, createActivityTracker, createMoveFilter } from '../server/auth/activity-tracker.js';
import { sameOriginRequest } from '../server/security/same-origin.js';

const MIN = 60_000;
const START = Date.parse('2026-10-05T09:00:00Z');
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

/** Bellek içi Session tablosu: kuralın kullandığı sorgular (findUnique, koşullu updateMany, deleteMany) */
function fakeDb() {
  const rows = new Map();
  const writes = [];
  const ok = (row, where) => Object.entries(where).every(([k, c]) => {
    const v = row[k];
    if (c instanceof Date || c === null || typeof c !== 'object') return v instanceof Date ? +v === +c : v === c;
    return Object.entries(c).every(([op, x]) => (op === 'gt' ? +v > +x : op === 'gte' ? +v >= +x : op === 'lt' ? +v < +x : op === 'lte' ? +v <= +x : assert.fail(`sahte db: ${op}`)));
  });
  return {
    rows, writes,
    add(tokenHash, { now, user = { isActive: true }, createdAt = now, lastSeenAt = now }) {
      rows.set(tokenHash, { id: `s-${tokenHash}`, tokenHash, userId: 'u1', user, createdAt: new Date(createdAt), expiresAt: new Date(createdAt + SESSION_TTL_MS), lastSeenAt: new Date(lastSeenAt) });
    },
    session: {
      findUnique: async ({ where }) => { const r = rows.get(where.tokenHash); return r ? { ...r, user: { ...r.user } } : null; },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const r of rows.values()) if (ok(r, where)) { Object.assign(r, data); writes.push({ id: r.id, ...data }); count++; }
        return { count };
      },
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const [k, r] of rows) if (ok(r, where)) { rows.delete(k); count++; }
        return { count };
      },
    },
  };
}

/** Sahte saat + zamanlayıcılar */
function createWorld(start = START) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const w = {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn, id }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    every(ms, fn) { const tick = () => { fn(); w.setTimer(tick, ms); }; w.setTimer(tick, ms); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.values()].filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        timers.delete(next.id);
        t = Math.max(t, next.at);
        next.fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
  return w;
}

/**
 * Bir tarayıcı sekmesi: izleyici + (istenirse) 60 saniyelik otomatik yenileme / bildirim yoklaması.
 * Yenileme sunucuda oturumu yalnızca OKUR (panel düzeni → liveSession) ve kalan süreyi izleyiciye verir.
 */
function openTab(w, db, token, { refresh = true, poll = false, name = 'sekme' } = {}) {
  const tab = { name, requests: [], expired: null, redirected: false, reads: 0, online: true };
  const first = db.rows.get(token);
  tab.tracker = createActivityTracker({
    remainingMs: first ? Math.max(0, Math.min(+first.lastSeenAt + SESSION_IDLE_MS, +first.expiresAt) - w.now()) : 0,
    idleMs: SESSION_IDLE_MS, now: w.now, setTimer: w.setTimer, clearTimer: w.clearTimer,
    onExpired: (reason) => { tab.expired = reason; },
    send: async (idleMs) => {
      if (!tab.online) throw new Error('ağ yok');
      const before = db.rows.get(token) ? +db.rows.get(token).lastSeenAt : null;
      const r = await recordActivity(db, token, { idleMs, now: w.now() });
      const after = db.rows.get(token) ? +db.rows.get(token).lastSeenAt : null;
      tab.requests.push({ at: w.now(), idleMs, extended: before != null && after != null && after > before, state: r.state });
      return r.state === 'active' ? { state: 'active', remainingMs: r.remainingMs } : { state: 'expired' };
    },
  });
  const read = async () => {
    if (tab.expired || tab.redirected) return;
    tab.reads++;
    const live = await liveSession(db, token, { now: w.now() });
    if (!live.session) { tab.redirected = true; return; }
    return live.remainingMs;
  };
  // Otomatik yenileme: sunucu bileşeni yeniden çizilir, kalan süre izleyiciye gelir (istek oturumu uzatmaz)
  if (refresh) w.every(MIN, () => { void read().then((ms) => { if (ms != null) tab.tracker.sync(ms); }); });
  // Bildirim yoklaması (arka plan sekmesi / doldurulan form): yalnızca okur, izleyiciye bir şey vermez
  if (poll) w.every(MIN, () => { void read(); });
  return tab;
}
const alive = async (w, db, token) => !!(await liveSession(db, token, { now: w.now() })).session;
const seen = (db, token) => +db.rows.get(token).lastSeenAt;

test('açık bırakılan sekme: otomatik yenileme ve yoklama oturumu UZATMAZ — 30. dakikada oturum biter, hiç etkinlik isteği gitmez', async () => {
  const w = createWorld();
  const db = fakeDb();
  db.add('t', { now: START });
  const tab = openTab(w, db, 't', { refresh: true, poll: true });
  await w.advance(29 * MIN + 59_000);
  assert.ok(tab.reads >= 58, 'otomatik istekler gerçekten yapıldı'); // 29 yenileme + 29 yoklama
  assert.equal(await alive(w, db, 't'), true);
  assert.equal(db.writes.length, 0, 'hiçbir istek son etkinlik anını yazmadı');
  assert.equal(seen(db, 't'), START);
  assert.deepEqual(tab.requests, [], 'etkinlik yokken sunucuya etkinlik isteği gitmez (kalp atışı yok)');
  await w.advance(1_000); // tam 30 dakika
  assert.equal(await alive(w, db, 't'), false, '30 dakika etkinlik yok: oturum sunucuda geçersiz');
  assert.equal(db.rows.size, 0, 'geçersiz oturum satırı silindi');
  assert.equal(tab.redirected, true, 'bir sonraki otomatik yenileme girişe yönlenir');
  await w.advance(IDLE_CHECK_GRACE_MS + 1);
  assert.equal(tab.expired, 'idle', 'izleyici de sunucuya sordu ve giriş sayfasına götürdü');
  assert.deepEqual(tab.requests.map((r) => [r.idleMs >= SESSION_IDLE_MS, r.extended, r.state]), [[true, false, 'expired']]);
  // Sonrası: sekme saatlerce açık kalsa da yeni istek yok, oturum geri gelmez
  await w.advance(5 * 60 * MIN);
  assert.equal(tab.requests.length, 1);
  assert.equal(await alive(w, db, 't'), false);
});

test('gerçek etkinlik süreyi uzatır: 20. dakikadaki etkinlikten sonra oturum 50. dakikaya kadar geçerlidir', async () => {
  const w = createWorld();
  const db = fakeDb();
  db.add('t', { now: START });
  const tab = openTab(w, db, 't');
  await w.advance(20 * MIN);
  tab.tracker.activity(); // klavye / fare / dokunma
  await settle();
  assert.deepEqual(tab.requests.map((r) => [r.idleMs, r.extended]), [[0, true]], 'ilk etkinlik hemen bildirilir');
  assert.equal(seen(db, 't'), START + 20 * MIN);
  await w.advance(25 * MIN); // 45. dakika: etkinlik olmasaydı oturum 15 dakika önce bitmişti
  assert.equal(await alive(w, db, 't'), true);
  assert.equal(tab.expired, null);
  await w.advance(5 * MIN - 1); // 49:59,999
  assert.equal(await alive(w, db, 't'), true);
  await w.advance(1 + IDLE_CHECK_GRACE_MS + 1);
  assert.equal(await alive(w, db, 't'), false);
  assert.equal(tab.expired, 'idle');
  assert.equal(tab.requests.length, 2, 'bir etkinlik bildirimi + süre dolunca tek soru');
});

test('çalışan kullanıcı içeride kalır: 3 saat süren etkinlikte oturum geçerli, bildirim en çok dakikada bir; sonra tam 30 dakikada biter', async () => {
  const w = createWorld();
  const db = fakeDb();
  db.add('t', { now: START });
  const tab = openTab(w, db, 't');
  let last = START;
  for (let i = 0; i < 3 * 60 * 6; i++) { // her 10 saniyede bir tuş / fare
    await w.advance(10_000);
    tab.tracker.activity();
    last = w.now();
    await settle();
    if (i % 90 === 0) assert.equal(await alive(w, db, 't'), true);
  }
  assert.equal(tab.expired, null);
  assert.equal(tab.redirected, false);
  assert.ok(tab.requests.length <= 181, `en çok dakikada bir bildirim (${tab.requests.length})`);
  assert.ok(tab.requests.length >= 170);
  for (let i = 1; i < tab.requests.length; i++) assert.ok(tab.requests[i].at - tab.requests[i - 1].at >= ACTIVITY_REPORT_MS, 'iki bildirim arası en az bir dakika');
  // Etkinlik durdu: bekleyen son bildirim etkinliğin YAŞIYLA gider — sunucudaki an gerçek son etkinliktir
  await w.advance(2 * MIN);
  assert.equal(seen(db, 't'), last, 'son etkinlik anı sunucuda birebir');
  const count = tab.requests.length;
  await w.advance(28 * MIN - 1);
  assert.equal(await alive(w, db, 't'), true);
  assert.equal(tab.requests.length, count, 'etkinlik bitince istek de biter');
  await w.advance(1 + IDLE_CHECK_GRACE_MS + 1);
  assert.equal(await alive(w, db, 't'), false, 'son etkinlikten tam 30 dakika sonra');
  assert.equal(tab.expired, 'idle');
});

test('bildirim gecikse de oturum fazladan uzamaz: dakikanın sonunda giden bildirim etkinliğin yaşını taşır', async () => {
  const w = createWorld();
  const db = fakeDb();
  db.add('t', { now: START });
  const tab = openTab(w, db, 't', { refresh: false });
  tab.tracker.activity(); // t0: hemen bildirilir
  await w.advance(10_000);
  tab.tracker.activity(); // t0 + 10 sn
  await w.advance(40_000);
  tab.tracker.activity(); // t0 + 50 sn — son etkinlik
  await settle();
  assert.equal(tab.requests.length, 1, 'aynı dakika içinde ikinci istek gitmez');
  await w.advance(10_000); // t0 + 60 sn: bekleyen bildirim
  assert.deepEqual(tab.requests.map((r) => r.idleMs), [0, 10_000]);
  assert.equal(seen(db, 't'), START + 50_000, 'sunucu son etkinliği 50. saniye olarak yazar (bildirimin gittiği an değil)');
  await w.advance(10 * MIN);
  assert.equal(tab.requests.length, 2, 'etkinlik yok → istek yok');
});

test('çok sekme: bir sekmedeki gerçek etkinlik aynı oturumu canlı tutar; dokunulmayan sekmeler oturumu uzatmaz ve atılmaz', async () => {
  const w = createWorld();
  const db = fakeDb();
  db.add('t', { now: START });
  const a = openTab(w, db, 't', { name: 'A (çalışılan)' });
  const b = openTab(w, db, 't', { name: 'B (görünür, dokunulmuyor)', refresh: true, poll: true });
  const c = openTab(w, db, 't', { name: 'C (arka planda)', refresh: false, poll: true });
  let last = START;
  for (let i = 0; i < 2 * 60 * 3; i++) { // 2 saat: A'da 20 saniyede bir etkinlik
    await w.advance(20_000);
    a.tracker.activity();
    last = w.now();
    await settle();
  }
  for (const tab of [a, b, c]) assert.deepEqual([tab.expired, tab.redirected], [null, false], tab.name);
  assert.equal(await alive(w, db, 't'), true);
  // B ve C hiçbir zaman oturumu uzatmadı: B hiç istek yollamadı (kalan süreyi yenilemeden öğrenir); C yalnızca süre
  // dolduğunu sandığında sordu ("bitti mi?") — yarım saatte bir, uzatmayan istek
  assert.deepEqual(b.requests, []);
  assert.ok(c.requests.length >= 3 && c.requests.length <= 5, `C: ${c.requests.length} soru`);
  for (const r of c.requests) assert.deepEqual([r.idleMs >= SESSION_IDLE_MS, r.extended, r.state], [true, false, 'active']);
  assert.ok(a.requests.every((r) => r.idleMs < SESSION_IDLE_MS));
  // A da bırakıldı: üç sekme açık, yenilemeler / yoklamalar sürüyor — oturum son gerçek etkinlikten 30 dakika sonra biter
  await w.advance(2 * MIN);
  assert.equal(seen(db, 't'), last);
  await w.advance(28 * MIN - 1);
  assert.equal(await alive(w, db, 't'), true);
  await w.advance(1);
  assert.equal(await alive(w, db, 't'), false);
  await w.advance(31 * MIN);
  for (const tab of [a, b, c]) assert.ok(tab.expired === 'idle' || tab.redirected, `${tab.name} girişe gitti`);
  assert.equal(db.rows.size, 0);
});

test('arka plan kalıcı oturum üretemez: çok sekmeli yenileme / yoklama, "boştayım" soruları ve bozuk bildirimler oturumu uzatmaz', async () => {
  const w = createWorld();
  const db = fakeDb();
  db.add('t', { now: START });
  const tabs = [openTab(w, db, 't', { poll: true }), openTab(w, db, 't', { poll: true }), openTab(w, db, 't', { refresh: false, poll: true })];
  await w.advance(25 * MIN);
  assert.equal(tabs.reduce((n, t) => n + t.reads, 0), 25 * 5, 'üç sekme 25 dakikada 125 otomatik istek yaptı');
  assert.equal(db.writes.length, 0);
  // Uzatmayan bildirimler: yaş ≥ 30 dakika, sayı olmayan değerler, gelecekten etkinlik
  for (const idleMs of [SESSION_IDLE_MS, SESSION_IDLE_MS * 10, Number.NaN, Number.POSITIVE_INFINITY, null, undefined === 0, '0', {}, []]) {
    const r = await recordActivity(db, 't', { idleMs, now: w.now() });
    assert.deepEqual([r.state, r.extended], ['active', false], `idleMs=${String(idleMs)}`);
  }
  assert.equal(seen(db, 't'), START);
  const neg = await recordActivity(db, 't', { idleMs: -5 * MIN, now: w.now() }); // "gelecekte etkinlik" olamaz: en çok şimdi
  assert.equal(neg.extended, true);
  assert.equal(seen(db, 't'), w.now());
  assert.equal(neg.remainingMs, SESSION_IDLE_MS);
  // Daha eski bir etkinlik bildirimi anı geri almaz
  await recordActivity(db, 't', { idleMs: 10 * MIN, now: w.now() });
  assert.equal(seen(db, 't'), w.now());
  // Etkinlik olmadan 30 dakika: oturum biter; biten oturum hiçbir bildirimle canlanmaz
  await w.advance(SESSION_IDLE_MS);
  assert.equal(await alive(w, db, 't'), false);
  db.add('t2', { now: w.now() - SESSION_IDLE_MS }); // tam sınırda bir oturum
  assert.deepEqual(await recordActivity(db, 't2', { idleMs: 0, now: w.now() }), { state: 'expired', remainingMs: 0, extended: false, reason: 'idle' });
  assert.equal(db.rows.has('t2'), false, 'geçersiz oturum satırı silinir, uzatılmaz');
  assert.equal((await recordActivity(db, 'yok', { idleMs: 0, now: w.now() })).state, 'expired');
  assert.equal((await recordActivity(db, '', { idleMs: 0, now: w.now() })).state, 'expired');
});

test('mutlak ömür: kesintisiz etkinlik de oturumu 30 günden uzun yaşatamaz; pasif kullanıcının oturumu geçersizdir', async () => {
  const db = fakeDb();
  db.add('t', { now: START });
  let now = START;
  let lastOk = START;
  for (;;) { // 20 dakikada bir etkinlik, 31 gün
    now += 20 * MIN;
    const r = await recordActivity(db, 't', { idleMs: 0, now });
    if (r.state !== 'active') break;
    lastOk = now;
    assert.ok(r.remainingMs <= SESSION_IDLE_MS);
    if (now > START + SESSION_TTL_MS + MIN) assert.fail('oturum 30 günü aştı');
  }
  assert.equal(lastOk, START + SESSION_TTL_MS - 20 * MIN);
  assert.equal(now, START + SESSION_TTL_MS);
  // Mutlak ömrün bitmesine 5 dakika kala: kalan süre 5 dakikadır (30 değil)
  db.add('son', { now: START });
  const near = await recordActivity(db, 'son', { idleMs: 0, now: START + SESSION_TTL_MS - 5 * MIN });
  assert.deepEqual([near.state, near.remainingMs], ['expired', 0]); // 30 gündür etkinlik yoktu: zaten boşta
  db.add('son2', { now: START, lastSeenAt: START + SESSION_TTL_MS - 10 * MIN });
  const near2 = await recordActivity(db, 'son2', { idleMs: 0, now: START + SESSION_TTL_MS - 5 * MIN });
  assert.deepEqual([near2.state, near2.remainingMs, near2.extended], ['active', 5 * MIN, true]);
  // Pasifleştirilen kullanıcı: oturum okunamaz, etkinlikle de uzatılamaz
  db.add('pasif', { now: START, user: { isActive: false } });
  assert.deepEqual((await liveSession(db, 'pasif', { now: START + MIN })).reason, 'inactive');
  assert.equal((await recordActivity(db, 'pasif', { idleMs: 0, now: START + MIN })).state, 'expired');
});

test('okuma salt okumadır: geçerli oturumda liveSession hiçbir şey yazmaz; rol kuralı etkilemez', async () => {
  const db = fakeDb();
  for (const role of ['ADMIN', 'MUSTERI', 'SATIS', 'CIZIM', 'DENETIMCI']) db.add(role, { now: START, user: { isActive: true, appRole: role } });
  for (const role of ['ADMIN', 'MUSTERI', 'SATIS', 'CIZIM', 'DENETIMCI']) {
    for (let i = 1; i < 30; i++) {
      const live = await liveSession(db, role, { now: START + i * MIN });
      assert.equal(live.session.user.appRole, role);
      assert.equal(live.remainingMs, SESSION_IDLE_MS - i * MIN, role);
    }
    assert.equal(seen(db, role), START, `${role}: 29 okuma son etkinlik anını değiştirmedi`);
    assert.deepEqual(await liveSession(db, role, { now: START + SESSION_IDLE_MS }), { session: null, remainingMs: 0, reason: 'idle' }, `${role}: 30. dakikada geçersiz`);
  }
  assert.equal(db.writes.length, 0);
  assert.equal(db.rows.size, 0);
  // Kural rol / yetki tablosuna bakmaz (her rol için aynıdır)
  const src = fs.readFileSync('server/auth/session-policy.js', 'utf8');
  assert.ok(!/permissions|appRole|role/i.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
});

test('ağ hatası ve başka yerden çıkış: bildirim yeniden denenir (sonsuz döngü yok); oturum başka sekmede kapatıldıysa girişe gidilir', async () => {
  const w = createWorld();
  const db = fakeDb();
  db.add('t', { now: START });
  const tab = openTab(w, db, 't', { refresh: false });
  tab.online = false;
  tab.tracker.activity();
  await settle();
  await w.advance(5 * MIN); // 1., 2., … 5. dakikada yeniden denendi: ağ yok
  assert.equal(seen(db, 't'), START, 'bildirim sunucuya ulaşmadı');
  tab.online = true;
  await w.advance(MIN);
  assert.equal(tab.requests.length, 1, 'ağ gelince bekleyen etkinlik bildirildi');
  assert.equal(seen(db, 't'), START, 'etkinliğin yaşıyla: an değişmedi (etkinlik en başta olmuştu)');
  assert.deepEqual([tab.requests[0].idleMs, tab.requests[0].extended], [6 * MIN, false]);
  // Ağ hiç gelmezse: etkinlik 30 dakikayı geçince bildirim denemesi de biter (yalnızca süre sorusu kalır)
  const w2 = createWorld();
  const db2 = fakeDb();
  db2.add('t', { now: START });
  const off = openTab(w2, db2, 't', { refresh: false });
  off.online = false;
  off.tracker.activity();
  await settle();
  await w2.advance(3 * 60 * MIN);
  off.online = true;
  await w2.advance(2 * MIN);
  assert.equal(off.expired, 'idle', 'ağ gelince sunucuya soruldu: oturum çoktan bitmişti');
  assert.deepEqual(off.requests.map((r) => [r.idleMs, r.state]), [[SESSION_IDLE_MS, 'expired']], 'eski etkinlik artık bildirilmez; yalnızca süre sorusu');
  // Çalışan kullanıcının oturumu başka sekmede "Çıkış" ile kapatıldı: bir sonraki bildirim 401 → giriş (boşta kalma değil)
  const w3 = createWorld();
  const db3 = fakeDb();
  db3.add('t', { now: START });
  const active = openTab(w3, db3, 't', { refresh: false });
  active.tracker.activity();
  await w3.advance(30_000);
  await db3.session.deleteMany({ where: { tokenHash: 't' } }); // logoutAction → destroySession
  active.tracker.activity();
  await w3.advance(MIN);
  assert.equal(active.expired, 'ended');
  assert.equal(await alive(w3, db3, 't'), false, 'çıkıştan sonra oturum hiçbir yolla geri gelmez');
  active.tracker.activity();
  await w3.advance(10 * MIN);
  assert.equal(active.requests.length, 2, 'izleyici durdu: yeni istek yok');
});

test('süresi dolmuş sekmeye dönen kullanıcı: etkinlik oturumu canlandırmaz; başka sekme canlı tutuyorsa çalışmaya devam eder', async () => {
  const w = createWorld();
  const db = fakeDb();
  db.add('t', { now: START });
  const tab = openTab(w, db, 't', { refresh: false });
  // Bilgisayar uyudu: zamanlayıcılar çalışmadı, 45 dakika geçti (saat ilerledi)
  const sleeping = createWorld(START + 45 * MIN);
  const late = createActivityTracker({
    remainingMs: 0, idleMs: SESSION_IDLE_MS, now: sleeping.now, setTimer: () => 0, clearTimer: () => undefined,
    onExpired: (reason) => { tab.expired = reason; },
    send: async (idleMs) => { const r = await recordActivity(db, 't', { idleMs, now: sleeping.now() }); tab.requests.push({ idleMs, state: r.state }); return r.state === 'active' ? { state: 'active', remainingMs: r.remainingMs } : { state: 'expired' }; },
  });
  late.activity(); // kullanıcı fareyi oynattı
  await settle();
  assert.deepEqual(tab.requests, [{ idleMs: SESSION_IDLE_MS, state: 'expired' }], 'uzatma denenmedi; yalnızca soruldu');
  assert.equal(tab.expired, 'idle');
  assert.equal(db.rows.size, 0);
  // Aynı durum ama oturum başka sekmede canlı: soru "sürüyor" döner, etkinlik işlenir
  const db2 = fakeDb();
  db2.add('t', { now: START, lastSeenAt: START + 44 * MIN });
  const reqs = [];
  let expired = null;
  const back = createActivityTracker({
    remainingMs: 0, idleMs: SESSION_IDLE_MS, now: sleeping.now, setTimer: () => 0, clearTimer: () => undefined, onExpired: (r) => { expired = r; },
    send: async (idleMs) => { const r = await recordActivity(db2, 't', { idleMs, now: sleeping.now() }); reqs.push([idleMs, r.state, r.extended]); return r.state === 'active' ? { state: 'active', remainingMs: r.remainingMs } : { state: 'expired' }; },
  });
  back.wake(); // sekme yeniden göründü
  await settle();
  back.activity();
  await settle();
  assert.deepEqual(reqs, [[SESSION_IDLE_MS, 'active', false], [0, 'active', true]]);
  assert.equal(expired, null);
  assert.equal(seen(db2, 't'), START + 45 * MIN);
});

test('fare hareketi: konum değişmeyen "hareket" (sayfa imlecin altında yenilenince tarayıcının ürettiği olay) etkinlik değildir', () => {
  const moved = createMoveFilter();
  assert.equal(moved(100, 200), false, 'ilk olay yalnızca başlangıç konumu');
  for (let i = 0; i < 50; i++) assert.equal(moved(100, 200), false, 'imleç duruyor');
  assert.equal(moved(101, 200), true);
  assert.equal(moved(101, 200), false);
  assert.equal(moved(101, 180), true);
});

test('etkinlik isteğinin kaynağı: yalnızca aynı siteden; başka site / alt alan reddedilir', () => {
  const ok = (h) => sameOriginRequest(h);
  assert.equal(ok({ secFetchSite: 'same-origin', origin: 'https://takip.example', host: 'takip.example' }), true);
  for (const site of ['cross-site', 'same-site', 'none']) assert.equal(ok({ secFetchSite: site, origin: 'https://takip.example', host: 'takip.example' }), false, site);
  assert.equal(ok({ origin: 'https://takip.example', host: 'takip.example' }), true);
  assert.equal(ok({ origin: 'https://takip.example', host: '127.0.0.1:3000', forwardedHost: 'takip.example' }), true, 'vekil arkasında');
  assert.equal(ok({ origin: 'https://kotu.example', host: 'takip.example' }), false);
  assert.equal(ok({ origin: 'https://takip.example.kotu.example', host: 'takip.example' }), false);
  assert.equal(ok({ origin: 'null', host: 'takip.example' }), false);
  assert.equal(ok({ origin: 'https://takip.example', host: '' }), false);
  assert.equal(ok({ host: 'takip.example' }), true, 'tarayıcı dışı istek (kaynak başlığı yok): CSRF konusu değil');
});

// ---------- yapı: oturumu uzatan tek yol ----------
const read = (f) => fs.readFileSync(f, 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : /\.(js|mjs|ts|tsx)$/.test(e.name) ? [p] : [];
});
const SOURCES = ['app', 'components', 'lib', 'server', 'scripts'].flatMap(walk);

test('yapı: son etkinlik anını yalnızca recordActivity yazar; onu yalnızca etkinlik adresi çağırır; otomatik istekler o adrese gitmez', () => {
  // 1) lastSeenAt yazan tek yer: server/auth/session-policy.js (recordActivity)
  const writers = SOURCES.filter((f) => /lastSeenAt\s*:/.test(read(f).replace(/\/\/.*$/gm, '')) && !f.endsWith('schema.prisma'));
  assert.deepEqual(writers, ['server/auth/session-policy.js']);
  const policy = read('server/auth/session-policy.js');
  assert.equal((policy.match(/\.session\.update/g) ?? []).length, 1, 'tek güncelleme: recordActivity');
  const live = policy.slice(policy.indexOf('export async function liveSession'), policy.indexOf('export async function recordActivity'));
  assert.ok(!/update|upsert|create/.test(live.replace(/\/\/.*$/gm, '')), 'liveSession yazmaz (yalnızca geçersiz satırı siler)');
  // 2) Çerez tarafı: oturum okuma hiçbir şey güncellemez
  const sessionTs = read('lib/auth/session.ts');
  assert.ok(!/session\.(update|upsert)/.test(sessionTs));
  assert.equal((sessionTs.match(/recordActivity\(/g) ?? []).length, 1);
  // 3) recordActivity / reportSessionActivity çağıranlar
  const users = (name) => SOURCES.filter((f) => new RegExp(`\\b${name}\\b`).test(read(f))).sort();
  assert.deepEqual(users('recordActivity'), ['lib/auth/session.ts', 'server/auth/session-policy.js']);
  assert.deepEqual(users('reportSessionActivity'), ['app/oturum/etkinlik/route.ts', 'lib/auth/session.ts']);
  // 4) Etkinlik adresine istek yollayan tek istemci: SessionActivity (otomatik yenileme, zil, işçi yollamaz)
  assert.equal(ACTIVITY_URL, '/oturum/etkinlik');
  assert.ok(fs.existsSync('app/oturum/etkinlik/route.ts'));
  const callers = SOURCES.filter((f) => /ACTIVITY_URL|oturum\/etkinlik/.test(read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))).sort();
  assert.deepEqual(callers, ['components/SessionActivity.tsx', 'server/auth/activity-tracker.js']);
  for (const f of ['components/AutoRefresh.tsx', 'components/NotificationCenter.tsx', 'scripts/worker.mjs']) {
    assert.ok(!/SessionActivity|activity-tracker|recordActivity|reportSessionActivity/.test(read(f)), f);
  }
  // 5) Etkinlik adresi yalnızca POST'tur (GET ile kayıt değişmez) ve özel başlık + aynı kaynak + istek sınırı ister
  const route = read('app/oturum/etkinlik/route.ts');
  assert.deepEqual(route.match(/export async function (\w+)/g), ['export async function POST']);
  for (const need of ['ACTIVITY_HEADER', 'sameOriginRequest', 'limiter.take', "typeof idle !== 'number'"]) assert.ok(route.includes(need), need);
  assert.equal(ACTIVITY_HEADER, 'x-takip-activity');
});

test('yapı: izleyici yalnızca gerçek kullanıcı olaylarını sayar (isTrusted); zamanlayıcı / görünürlük / odak etkinlik değildir', () => {
  const src = read('components/SessionActivity.tsx');
  const kinds = /const kinds = \[([^\]]+)\]/.exec(src)[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(kinds, ['keydown', 'pointerdown', 'wheel', 'touchstart', 'touchmove']);
  assert.ok(src.includes("window.addEventListener('pointermove', onMove"));
  assert.ok(/onAct = \(e: Event\) => \{ if \(e\.isTrusted\) t\.activity\(\); \}/.test(src));
  assert.ok(/e\.isTrusted && moved\(/.test(src));
  assert.equal((src.match(/\.activity\(\)/g) ?? []).length, 2, 'etkinlik yalnızca iki olay işleyicisinden doğar');
  assert.ok(!/setInterval/.test(src), 'yoklama döngüsü yok');
  for (const never of ['focus', 'scroll', 'takip:poll', 'mouseover', 'load']) assert.ok(!new RegExp(`addEventListener\\('${never}'`).test(src), never);
  assert.ok(/visibilitychange', onVisible/.test(src) && /t\.wake\(\)/.test(src), 'görünürlük yalnızca "süre doldu mu" sorusudur');
  // Panel düzeni izleyiciyi her role aynı biçimde verir; giriş sayfası açıklamayı gösterir (iki dilde)
  assert.ok(read('app/(panel)/layout.tsx').includes('<SessionActivity remainingMs={await sessionRemainingMs()} />'));
  assert.ok(read('app/login/page.tsx').includes("sp.info === 'idle' ? t('auth.login.infoIdle')"));
  assert.ok(read('lib/auth/session.ts').includes("redirect(idle ? '/login?info=idle' : '/login')"));
});
