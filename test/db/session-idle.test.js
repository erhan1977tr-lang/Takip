// 30 dakika etkinlik olmayan oturum kapanır (karar 135) — gerçek veritabanıyla; saat her çağrıya verilir (bekleme yok).
//   - okuma (sayfa, otomatik yenileme, yoklama) oturumu uzatmaz; yalnızca etkinlik bildirimi uzatır
//   - 30 dakika etkinlik yoksa oturum geçersizdir, satırı silinir, hiçbir bildirimle canlanmaz
//   - beş rol için aynı kural; yetkiler değişmez; çıkış ve "tüm oturumları kapat" çalışmaya devam eder
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, resetDb } from './helpers.js';

const { SESSION_IDLE_MS, SESSION_TTL_MS, liveSession, recordActivity, pruneSessions } = await import('../../server/auth/session-policy.js');
const { ROLES, permissionsOf } = await import('../../server/auth/permissions.js');

const MIN = 60_000;
const T0 = Date.parse('2026-10-05T09:00:00Z');
const INCLUDE = { user: { include: { customer: true } } };
const U = {};
let db, factory, firm, seq = 0;

/** Giriş: yeni oturum satırı (lib/auth/session.ts → createSession ile aynı alanlar) */
async function login(user, at = T0) {
  const tokenHash = `idle-${++seq}`;
  await db.session.create({ data: { userId: user.id, tokenHash, createdAt: new Date(at), lastSeenAt: new Date(at), expiresAt: new Date(at + SESSION_TTL_MS) } });
  return tokenHash;
}
const row = (tokenHash) => db.session.findUnique({ where: { tokenHash } });
const seenAt = async (tokenHash) => (await row(tokenHash)).lastSeenAt.getTime();

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Bosta Cam SRL', prefix: 'BOS' } });
  for (const role of ROLES) {
    U[role] = await db.user.create({
      data: { email: `${role.toLowerCase()}@bosta.test`, name: role, appRole: role, type: role === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL', customerId: role === 'MUSTERI' ? firm.id : factory.id },
    });
  }
});
after(closeDb);

dbTest('beş rol: okuma oturumu uzatmaz; 29 dk 59 sn geçerli, 30. dakikada geçersiz ve satır silinir; yetkiler aynı', async () => {
  assert.deepEqual(Object.keys(U).sort(), [...ROLES].sort());
  for (const role of ROLES) {
    const token = await login(U[role]);
    // Açık bırakılan sekme: 29 dakika boyunca dakikada bir sayfa yenilemesi + bildirim yoklaması (58 okuma)
    for (let m = 1; m < 30; m++) {
      for (let k = 0; k < 2; k++) {
        const live = await liveSession(db, token, { now: T0 + m * MIN, include: INCLUDE });
        assert.equal(live.session.user.id, U[role].id, role);
        assert.equal(live.session.user.appRole, role);
        assert.equal(live.remainingMs, SESSION_IDLE_MS - m * MIN);
        assert.deepEqual(permissionsOf(live.session.user.appRole), permissionsOf(role), `${role}: yetkiler oturumdan bağımsız`);
      }
    }
    assert.equal(await seenAt(token), T0, `${role}: okumalar son etkinlik anını değiştirmedi`);
    assert.equal((await liveSession(db, token, { now: T0 + SESSION_IDLE_MS - 1 })).reason, 'ok');
    assert.deepEqual(await liveSession(db, token, { now: T0 + SESSION_IDLE_MS }), { session: null, remainingMs: 0, reason: 'idle' }, role);
    assert.equal(await row(token), null, `${role}: geçersiz oturum satırı silindi`);
    // Eski sekme yenilenir / eski çerezle istek gelir: oturum yok
    assert.equal((await liveSession(db, token, { now: T0 + SESSION_IDLE_MS + MIN })).reason, 'none');
    assert.equal((await recordActivity(db, token, { idleMs: 0, now: T0 + SESSION_IDLE_MS + MIN })).state, 'expired');
  }
  assert.equal(await db.session.count(), 0);
  assert.equal(await db.user.count({ where: { isActive: true, id: { in: Object.values(U).map((u) => u.id) } } }), ROLES.length, 'kullanıcılar etkilenmedi');
});

dbTest('gerçek etkinlik uzatır: çalışan kullanıcı saatlerce içeride kalır; etkinlik bitince tam 30 dakikada oturum biter', async () => {
  const token = await login(U.SATIS);
  let now = T0;
  // 4 saat: 20 dakikada bir etkinlik bildirimi; arada otomatik yenilemeler (okuma)
  for (let i = 0; i < 12; i++) {
    now += 20 * MIN;
    assert.equal((await liveSession(db, token, { now })).remainingMs, 10 * MIN, 'yenileme uzatmadı: 20 dakika geçti, 10 kaldı');
    const r = await recordActivity(db, token, { idleMs: 0, now });
    assert.deepEqual(r, { state: 'active', remainingMs: SESSION_IDLE_MS, extended: true, reason: 'ok' });
    assert.equal(await seenAt(token), now);
  }
  assert.equal(now - T0, 4 * 60 * MIN);
  // Bildirim etkinliğin yaşını taşır: 40 sn önceki etkinlik → an 40 sn öncesi; daha eski bildirim anı geri almaz
  now += MIN;
  assert.equal((await recordActivity(db, token, { idleMs: 40_000, now })).remainingMs, SESSION_IDLE_MS - 40_000);
  assert.equal(await seenAt(token), now - 40_000);
  assert.equal((await recordActivity(db, token, { idleMs: 50_000, now })).extended, false);
  assert.equal(await seenAt(token), now - 40_000);
  const last = now - 40_000;
  assert.equal((await liveSession(db, token, { now: last + SESSION_IDLE_MS - 1 })).reason, 'ok');
  assert.equal((await liveSession(db, token, { now: last + SESSION_IDLE_MS })).reason, 'idle');
  assert.equal(await row(token), null);
});

dbTest('uzatmayan istekler: "boştayım" sorusu, bozuk değerler, eşzamanlı okuma / çok sekme — hiçbiri kalıcı oturum üretmez', async () => {
  const token = await login(U.MUSTERI);
  const at = T0 + 25 * MIN;
  for (const idleMs of [SESSION_IDLE_MS, 10 * SESSION_IDLE_MS, Number.NaN, Number.POSITIVE_INFINITY, null, '0', {}]) {
    const r = await recordActivity(db, token, { idleMs, now: at });
    assert.deepEqual([r.state, r.extended, r.remainingMs], ['active', false, 5 * MIN], String(idleMs));
  }
  // Üç sekme aynı anda: 30 okuma + 30 "boştayım" sorusu (paralel)
  const many = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? liveSession(db, token, { now: at }) : recordActivity(db, token, { idleMs: SESSION_IDLE_MS, now: at }))));
  assert.ok(many.every((r) => (r.session ? r.reason === 'ok' : r.state === 'active' && !r.extended)));
  assert.equal(await seenAt(token), T0, 'son etkinlik anı hiç değişmedi');
  // Aynı etkinliğin paralel bildirimleri (iki sekme): an bir kez, ileriye doğru yazılır
  const both = await Promise.all([recordActivity(db, token, { idleMs: 5_000, now: at }), recordActivity(db, token, { idleMs: 0, now: at }), recordActivity(db, token, { idleMs: 9_000, now: at })]);
  assert.ok(both.every((r) => r.state === 'active'));
  assert.equal(await seenAt(token), at, 'en yeni etkinlik kazanır');
  // Gelecekte etkinlik yazılamaz
  await recordActivity(db, token, { idleMs: -60 * MIN, now: at + MIN });
  assert.equal(await seenAt(token), at + MIN);
  // Süre dolduktan SONRA gelen bildirimler (paralel de olsa) oturumu canlandırmaz
  const dead = at + MIN + SESSION_IDLE_MS;
  const late = await Promise.all(Array.from({ length: 10 }, () => recordActivity(db, token, { idleMs: 0, now: dead })));
  assert.ok(late.every((r) => r.state === 'expired'));
  assert.equal(await row(token), null);
  // Satır silinmemiş olsaydı bile koşullu yazım boşta kalmış oturumu uzatmaz (yarış güvencesi)
  const stale = await login(U.MUSTERI, T0);
  const direct = await db.session.updateMany({
    where: { tokenHash: stale, expiresAt: { gt: new Date(dead) }, lastSeenAt: { gt: new Date(dead - SESSION_IDLE_MS), lt: new Date(dead) } },
    data: { lastSeenAt: new Date(dead) },
  });
  assert.equal(direct.count, 0);
  await db.session.deleteMany({});
});

dbTest('mutlak ömür ve pasif kullanıcı: kesintisiz etkinlik 30. günü aşamaz; pasifleştirilen kullanıcının oturumu geçersizdir', async () => {
  const token = await login(U.CIZIM);
  // 29 gün 23 saat 50 dakika boyunca etkin kullanıcı (son etkinlik anı doğrudan yazılır: 30 günü tek tek oynatmamak için)
  const near = T0 + SESSION_TTL_MS - 10 * MIN;
  await db.session.update({ where: { tokenHash: token }, data: { lastSeenAt: new Date(near - MIN) } });
  const r = await recordActivity(db, token, { idleMs: 0, now: near });
  assert.deepEqual([r.state, r.extended, r.remainingMs], ['active', true, 10 * MIN], 'kalan süre mutlak ömürle sınırlı (30 dakika değil)');
  assert.equal((await recordActivity(db, token, { idleMs: 0, now: T0 + SESSION_TTL_MS - 1 })).state, 'active');
  assert.deepEqual(await recordActivity(db, token, { idleMs: 0, now: T0 + SESSION_TTL_MS }), { state: 'expired', remainingMs: 0, extended: false, reason: 'expired' });
  assert.equal(await row(token), null);

  const t2 = await login(U.DENETIMCI);
  await db.user.update({ where: { id: U.DENETIMCI.id }, data: { isActive: false } });
  assert.equal((await liveSession(db, t2, { now: T0 + MIN })).reason, 'inactive');
  assert.equal((await recordActivity(db, t2, { idleMs: 0, now: T0 + MIN })).state, 'expired');
  assert.equal(await seenAt(t2), T0);
  await db.user.update({ where: { id: U.DENETIMCI.id }, data: { isActive: true } });
  await db.session.deleteMany({});
});

dbTest('çıkış ve temizlik: çıkış oturumu hemen kapatır (öbür cihaz etkilenmez); işçi 30 dakikadır etkinlik olmayan satırları siler', async () => {
  const a = await login(U.ADMIN);
  const b = await login(U.ADMIN); // aynı kullanıcı, başka tarayıcı
  await recordActivity(db, a, { idleMs: 0, now: T0 + 10 * MIN });
  // Çıkış (destroySession): bu tarayıcının satırı silinir
  await db.session.deleteMany({ where: { tokenHash: a } });
  assert.equal((await liveSession(db, a, { now: T0 + 11 * MIN })).reason, 'none');
  assert.equal((await recordActivity(db, a, { idleMs: 0, now: T0 + 11 * MIN })).state, 'expired', 'çıkıştan sonra etkinlik oturum açmaz');
  assert.equal((await liveSession(db, b, { now: T0 + 11 * MIN })).reason, 'ok', 'öbür tarayıcının oturumu kendi süresini sürdürür');
  assert.equal((await liveSession(db, b, { now: T0 + 29 * MIN })).remainingMs, MIN, 'bir tarayıcıdaki etkinlik öbür tarayıcının oturumunu uzatmaz');
  // Şifre sıfırlama / pasifleştirme (destroyAllSessions): kullanıcının tüm oturumları
  await db.session.deleteMany({ where: { userId: U.ADMIN.id } });
  assert.equal(await db.session.count({ where: { userId: U.ADMIN.id } }), 0);

  // İşçi temizliği gerçek saatle çalışır
  const now = new Date();
  const mk = (label, seenAgoMs, createdAgoMs = 3_600_000) => db.session.create({
    data: { userId: U.SATIS.id, tokenHash: `prune-${label}`, createdAt: new Date(now.getTime() - createdAgoMs), expiresAt: new Date(now.getTime() - createdAgoMs + SESSION_TTL_MS), lastSeenAt: new Date(now.getTime() - seenAgoMs) },
  });
  await mk('etkin', 60_000);
  await mk('yirmi-dokuz', 29 * MIN);
  await mk('otuz', SESSION_IDLE_MS);
  await mk('dun', 86_400_000, 2 * 86_400_000);
  await mk('doldu', 60_000, SESSION_TTL_MS + MIN);
  assert.equal((await pruneSessions(db, now)).sessions, 3);
  assert.deepEqual((await db.session.findMany({ orderBy: { tokenHash: 'asc' } })).map((s) => s.tokenHash), ['prune-etkin', 'prune-yirmi-dokuz']);
  await db.session.deleteMany({});
});
