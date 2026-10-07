// Kilit olayı = kilidi oluşturan deneme; reddedilen istek hiçbir şey yazmaz (karar 149; güvenlik denetimi 3.50.9 AUD-11).
// GERÇEK PostgreSQL ile: paralel isteklerde bir sınırı yalnızca BİR denemenin doldurduğu (tek LOGIN_LOCKED), kilitli
// isteklerin hiçbir tabloya yazmadığı, yönetici bildiriminin veritabanındaki benzersiz anahtarla çiftlenemediği,
// CODE_FAILED kaydının yalnızca gerçekten karşılaştırılan yanlış kod için (davet başına en çok 5) yazıldığı ve AUD-10
// kurallarının (PENDING, sınırlar) aynen korunduğu denetlenir.
// AuditLog silinemez (yalnızca eklenir): her test kendi kullanıcısını / IP'sini kullanır ve kayıtları ona göre süzer.
// Dış servis yok: testler ağ engeliyle (offline) çalışır; şifre doğrulaması sahte işlevdir; e-posta gönderilmez.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const at = await import('../../server/auth/attempts.js');
const ev = await import('../../server/auth/lock-events.js');
const { verifyInviteCode } = await import('../../server/auth/invite-claim.js');
const { createInvite } = await import('../../server/auth/inviteCode.js');
const { LIMITS } = await import('../../server/auth/throttle.js');
const { localDay } = await import('../../server/profile/dates.js');

const SECRET = 'e'.repeat(40);
const TZ = 'Europe/Bucharest';
const quiet = () => {};
let db, factory, seq = 0, admins = [];
const tally = (list, v) => list.filter((x) => x === v).length;
const result = (r) => (r.locked ? 'locked' : r.outcome.ok ? 'ok' : 'invalid');
const nextIp = () => { seq += 1; return `198.18.${Math.floor(seq / 250)}.${(seq % 250) + 1}`; };

async function person(extra = {}) {
  seq += 1;
  return db.user.create({ data: { email: `kilit${seq}@deneme.test`, name: `Kilit Kişi ${seq}`, type: 'CUSTOMER', appRole: 'MUSTERI', customerId: factory.id, passwordHash: 'ozet', ...extra } });
}
/** lib/auth/throttle.ts → runAttempt ile AYNI bileşim: deneme → (başarısız + sınırı doldurduysa) kilit olayı */
async function attempt({ kind = 'LOGIN', email, ip, now = new Date() }, ok = false) {
  const r = await at.runAttempt(db, { kind, email, ip, now }, async () => ({ ok }));
  if (!r.locked && r.filled?.length) await ev.recordLock(db, { kind, email, ip, filled: r.filled, now, timeZone: TZ, log: quiet });
  return r;
}
/** app/setup/actions.ts → verifyCodeAction ile AYNI bileşim */
async function codeStep({ email, code, ip, now = new Date() }) {
  const r = await at.runAttempt(db, { kind: 'CODE', email, ip, now }, () => verifyInviteCode(db, { email, code, secret: SECRET, now }));
  if (!r.locked && r.filled?.length) await ev.recordLock(db, { kind: 'CODE', email, ip, filled: r.filled, now, timeZone: TZ, log: quiet });
  if (!r.locked && !r.outcome.ok && r.outcome.reason === 'wrong_code') await ev.recordCodeFailure(db, { email, ip, log: quiet });
  return r;
}
const lockRows = (where) => db.auditLog.findMany({ where: { action: 'LOGIN_LOCKED', ...where }, orderBy: { createdAt: 'asc' } });
const codeRows = (where) => db.auditLog.findMany({ where: { action: 'CODE_FAILED', ...where }, orderBy: { createdAt: 'asc' } });
const notices = (userId, day = localDay(new Date(), TZ)) => db.notification.findMany({ where: { dedupeKey: `auth-lock:${userId}:${day}` }, include: { user: { select: { appRole: true, isActive: true } } } });
/** Bütün tabloların yazma durumu (kilitli isteğin hiçbir şey yazmadığını göstermek için) */
const snapshot = async () => [await db.auditLog.count(), await db.notification.count(), await db.authFailure.count(), await db.notificationOutbox.count()];
/** Denetim kayıtlarının İÇERİK alanları (rastgele üretilen kimlikler ve zaman dışarıda): sır / e-posta araması bunda yapılır */
const textOf = (rows) => JSON.stringify(rows.map((a) => [a.action, a.entityType, a.actorRole, a.ip, a.details]));
/** Davet bekleyen kullanıcı + gönderilmiş davet */
async function invited(inviteExtra = {}) {
  const user = await person({ passwordHash: null });
  const { code, record } = createInvite(user.email, SECRET, 24);
  const invite = await db.userInvite.create({ data: { userId: user.id, codeHash: record.codeHash, expiresAt: record.expiresAt, sentAt: new Date(), ...inviteExtra } });
  const wrong = (n) => { const out = []; for (let i = 0; out.length < n; i++) { const c = String(100000 + i * 7919).slice(0, 6); if (c !== code) out.push(c); } return out; };
  const attempts = async () => (await db.userInvite.findUniqueOrThrow({ where: { id: invite.id } })).attempts;
  return { user, email: user.email, code, wrong, attempts };
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  factory = await db.customer.create({ data: { name: 'Kilit Cam SRL', prefix: 'KLT' } });
  const staff = (email, appRole, extra = {}) => db.user.create({ data: { email, name: `${appRole} ${email}`, type: 'INTERNAL', appRole, passwordHash: 'ozet', ...extra } });
  await staff('yonetici-a@kilit.test', 'ADMIN');
  await staff('yonetici-b@kilit.test', 'ADMIN');
  await staff('yonetici-pasif@kilit.test', 'ADMIN', { isActive: false });
  await staff('satis@kilit.test', 'SATIS');
  await staff('cizim@kilit.test', 'CIZIM');
  await staff('denetim@kilit.test', 'DENETIMCI');
  admins = (await db.user.findMany({ where: { appRole: 'ADMIN', isActive: true }, select: { id: true } })).map((u) => u.id).sort();
});
after(closeDb);

dbTest('aynı anda 60 yanlış deneme (aynı e-posta + IP): 5 doğrulama, LOGIN_LOCKED tam BİR kez; ardından 50 kilitli istek hiçbir tabloya yazmaz', offline(async () => {
  assert.equal(admins.length, 2);
  const u = await person();
  const ip = nextIp();
  const rs = await Promise.all(Array.from({ length: 60 }, () => attempt({ email: u.email, ip })));
  assert.deepEqual([tally(rs.map(result), 'invalid'), tally(rs.map(result), 'locked')], [5, 55]);
  // Sınırı tek deneme doldurdu ve o deneme tek kayıt üretti
  assert.equal(rs.filter((r) => !r.locked && r.filled).length, 1);
  const rows = await lockRows({ entityId: u.id });
  assert.deepEqual(rows.map((a) => [a.userId, a.entityType, a.actorRole, a.ip, a.details]), [[u.id, 'User', 'MUSTERI', ip, { ip, kind: 'LOGIN', scopes: ['account'] }]]);
  assert.deepEqual([(await notices(u.id)).length, (await db.authFailure.findMany({ where: { email: u.email } })).map((f) => f.kind)], [0, Array(5).fill('LOGIN')]);
  // Zaten kilitli: 50 istek daha (aynı anda; doğru şifreyle de) — denetim kaydı, bildirim, deneme satırı, kuyruk: hiçbiri değişmez
  const before = await snapshot();
  const more = await Promise.all(Array.from({ length: 50 }, (_, i) => attempt({ email: u.email, ip }, i % 2 === 0)));
  assert.equal(tally(more.map(result), 'locked'), 50);
  assert.deepEqual(await snapshot(), before, 'kilitli istek hiçbir tabloya yazmaz');
  assert.equal((await lockRows({ entityId: u.id })).length, 1);
}));

dbTest('aynı e-posta, çok IP (aynı anda 60 istek, 12 IP): 20 doğrulama; e-posta geneli kilit tam BİR kez; yöneticilere kişi başına tam BİR bildirim', offline(async () => {
  const u = await person();
  const ips = Array.from({ length: 12 }, () => nextIp());
  const now = new Date(); // bütün istekler aynı anı kullanır: bildirimin günü test boyunca tektir
  const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => attempt({ email: u.email, ip: ips[i % 12], now })));
  assert.deepEqual([tally(rs.map(result), 'invalid'), tally(rs.map(result), 'locked'), (await db.authFailure.count({ where: { email: u.email } }))], [LIMITS.email, 40, 20]);
  const rows = await lockRows({ entityId: u.id });
  const mail = rows.filter((a) => a.details.scopes.includes('email'));
  assert.equal(mail.length, 1, 'e-posta geneli sınırı tek deneme doldurur');
  assert.equal(rs.filter((r) => !r.locked && r.filled?.includes('email')).length, 1);
  // Her kayıt, sınırı dolduran BİR denemeye karşılık gelir (çift kilitleri dahil); fazlası yok
  assert.equal(rows.length, rs.filter((r) => !r.locked && r.filled).length);
  assert.ok(rows.every((a) => a.userId === u.id && a.details.kind === 'LOGIN' && ips.includes(a.ip)));
  // Bildirim: yalnızca etkin yöneticiler, kişi başına bir satır; içerik sabit
  const sent = await notices(u.id, localDay(now, TZ));
  assert.deepEqual(sent.map((n) => n.userId).sort(), admins);
  assert.ok(sent.every((n) => n.user.appRole === 'ADMIN' && n.user.isActive && n.type === 'AUTH_LOCKED' && n.link === '/admin/users' && n.orderId === null));
  assert.deepEqual(sent.map((n) => n.params), Array(2).fill({ user: `${u.name} · ${u.email}`, aud: 'staff' }));
  // Kilitliyken başka IP'lerden gelen 40 istek: yeni kayıt / bildirim yok
  const before = await snapshot();
  const more = await Promise.all(Array.from({ length: 40 }, () => attempt({ email: u.email, ip: nextIp(), now }, true)));
  assert.equal(tally(more.map(result), 'locked'), 40);
  assert.deepEqual(await snapshot(), before);
}));

dbTest('bildirim günde bir kezdir ve paralel kilit olayları çift bildirim üretemez; yönetici dışındaki roller hiç almaz', offline(async () => {
  const u = await person();
  const day1 = new Date('2026-11-03T08:00:00Z');
  const lock = (now, kind = 'LOGIN') => ev.recordLock(db, { kind, email: u.email, ip: nextIp(), filled: ['email'], now, timeZone: TZ, log: quiet });
  // Aynı anda 30 kilit olayı → bildirim yönetici başına tek satır (veritabanındaki benzersiz anahtar)
  const outs = await Promise.all(Array.from({ length: 30 }, () => lock(day1)));
  assert.deepEqual([outs.every((o) => o.audit), outs.reduce((s, o) => s + o.notified, 0)], [true, admins.length]);
  assert.deepEqual((await notices(u.id, '2026-11-03')).map((n) => n.userId).sort(), admins);
  assert.equal((await lockRows({ entityId: u.id })).length, 30, 'her kilit olayı kayıttadır; bildirim tektir');
  // Aynı (yerel) gün içinde sonra — kod adımından gelen kilit dahil — yeni bildirim yok; ertesi gün yeni bildirim
  assert.equal((await lock(new Date('2026-11-03T21:59:00Z'), 'CODE')).notified, 0); // 23:59 Bükreş
  assert.equal((await lock(new Date('2026-11-03T22:01:00Z'))).notified, admins.length); // 04.11 00:01 Bükreş
  assert.deepEqual([(await notices(u.id, '2026-11-03')).length, (await notices(u.id, '2026-11-04')).length], [2, 2]);
  // Öteki kapsamlar ve hesabı olmayan e-posta bildirim üretmez
  const other = await person();
  for (const filled of [['account'], ['ip'], ['account', 'ip']]) assert.equal((await ev.recordLock(db, { kind: 'LOGIN', email: other.email, ip: nextIp(), filled, now: day1, timeZone: TZ, log: quiet })).notified, 0);
  assert.equal((await notices(other.id, '2026-11-03')).length, 0);
  assert.deepEqual(await ev.recordLock(db, { kind: 'LOGIN', email: 'hesabi-yok@deneme.test', ip: nextIp(), filled: ['account', 'email'], now: day1, timeZone: TZ, log: quiet }), { audit: false, notified: 0 });
  // Bu veritabanındaki BÜTÜN kilit bildirimleri: alıcıların hepsi etkin yönetici
  const all = await db.notification.findMany({ where: { type: 'AUTH_LOCKED' }, include: { user: { select: { appRole: true, isActive: true } } } });
  assert.ok(all.length >= 4);
  assert.deepEqual([...new Set(all.map((n) => `${n.user.appRole}:${n.user.isActive}`))], ['ADMIN:true']);
  // E-posta kanalı yok: bildirim kuyruğuna (e-postanın kaynağı) hiçbir şey yazılmadı
  assert.equal(await db.notificationOutbox.count(), 0);
}));

dbTest('hesabı olmayan e-posta: kullanıcıya bağlı kayıt yok; IP geneli kilit aynı anda 50 istekte tam BİR kez, kullanıcısız ve e-postasız yazılır', offline(async () => {
  // e-posta + IP kilidi (hesap yok): kayıt yok
  const ghost = `hayalet-${Date.now()}@deneme.test`;
  const ipA = nextIp();
  const pair = await Promise.all(Array.from({ length: 20 }, () => attempt({ email: ghost, ip: ipA })));
  assert.deepEqual([tally(pair.map(result), 'invalid'), (await db.auditLog.count({ where: { ip: ipA } }))], [5, 0]);
  // IP geneli: 50 ayrı uydurma e-posta, tek IP, aynı anda → 30 doğrulama, tek kayıt
  const ipB = nextIp();
  const tried = Array.from({ length: 50 }, (_, i) => `uydurma-${i}-${Date.now()}@deneme.test`);
  const rs = await Promise.all(tried.map((email) => attempt({ email, ip: ipB })));
  assert.deepEqual([tally(rs.map(result), 'invalid'), tally(rs.map(result), 'locked')], [LIMITS.ip, 20]);
  const rows = await db.auditLog.findMany({ where: { ip: ipB } });
  assert.deepEqual(rows.map((a) => [a.action, a.entityType, a.entityId, a.userId, a.actorRole, a.details]), [['LOGIN_LOCKED', 'User', null, null, null, { ip: ipB, kind: 'LOGIN', scopes: ['ip'] }]]);
  // Kilitliyken o IP'den gelen her e-posta reddedilir ve kayıt üretmez
  const before = await snapshot();
  const more = await Promise.all(Array.from({ length: 30 }, (_, i) => attempt({ email: `sonraki-${i}@deneme.test`, ip: ipB })));
  assert.equal(tally(more.map(result), 'locked'), 30);
  assert.deepEqual(await snapshot(), before);
  // Denenen e-posta dizgileri hiçbir denetim kaydında yok
  const dump = textOf(await db.auditLog.findMany({ where: { ip: { in: [ipA, ipB] } } }));
  for (const s of [ghost, 'uydurma-', 'sonraki-', '@deneme.test']) assert.equal(dump.includes(s), false, s);
}));

dbTest('başarılı deneme kilit olayı üretmez; paralel başarılı / başarısız karışımda her kayıt başarısız bir dolduran denemeye karşılık gelir; PENDING kalmaz', offline(async () => {
  // 4 hata + 5. denemede doğru şifre: kilit yok, kayıt yok, çiftin hataları temizlenir
  const a = await person();
  const ipA = nextIp();
  for (let i = 0; i < 4; i++) assert.equal(result(await attempt({ email: a.email, ip: ipA })), 'invalid');
  assert.equal(result(await attempt({ email: a.email, ip: ipA }, true)), 'ok');
  assert.deepEqual([(await lockRows({ entityId: a.id })).length, await db.authFailure.count({ where: { email: a.email } })], [0, 0]);
  // Mevcut 4 hata + aynı anda 30 yanlış deneme: yalnızca 1 hak → o deneme sınırı doldurur → tek kayıt
  const b = await person();
  const ipB = nextIp();
  await db.authFailure.createMany({ data: Array.from({ length: 4 }, () => ({ kind: 'LOGIN', email: b.email, ip: ipB })) });
  const burst = await Promise.all(Array.from({ length: 30 }, () => attempt({ email: b.email, ip: ipB })));
  assert.deepEqual([tally(burst.map(result), 'invalid'), tally(burst.map(result), 'locked'), (await lockRows({ entityId: b.id })).length], [1, 29, 1]);
  // Karışım: aynı e-posta + IP'ye 80 paralel deneme, her 9.'su doğru şifre. Kaç kilit oluşacağı sıraya bağlıdır; değişmezler:
  const c = await person();
  const ipC = nextIp();
  const mix = await Promise.all(Array.from({ length: 80 }, (_, i) => attempt({ email: c.email, ip: ipC }, i % 9 === 4)));
  const filled = mix.filter((r) => !r.locked && r.filled);
  assert.ok(filled.every((r) => r.outcome.ok === false), 'başarılı deneme hiçbir zaman kilit olayı taşımaz');
  assert.equal((await lockRows({ entityId: c.id })).length, filled.length, 'kayıt sayısı = sınırı dolduran başarısız deneme sayısı');
  const left = await db.authFailure.findMany({ where: { email: c.email } });
  assert.ok(left.length <= LIMITS.account, `çiftte en çok 5 satır (${left.length})`);
  assert.equal(left.filter((f) => f.kind === 'PENDING').length, 0, 'süren deneme kalmadı');
  assert.ok((await lockRows({ entityId: c.id })).length <= mix.filter((r) => !r.locked && !r.outcome.ok).length, 'kayıt ≤ sayılan başarısız deneme');
}));

dbTest('kod adımı: aynı anda 8 yanlış kod → 5 karşılaştırma ve tam 5 CODE_FAILED; 6. deneme, doğru kod, davet yok / kullanılmış / süresi dolmuş → kayıt yok; kod hiçbir kayıtta yok', offline(async () => {
  const w = await invited();
  const tried = w.wrong(9);
  const rs = await Promise.all(tried.slice(0, 8).map((code) => codeStep({ email: w.email, code, ip: nextIp() })));
  assert.deepEqual([tally(rs.map((r) => r.outcome.reason), 'wrong_code'), tally(rs.map((r) => r.outcome.reason), 'unavailable'), await w.attempts()], [5, 3, 5]);
  const rows = await codeRows({ entityId: w.user.id });
  assert.equal(rows.length, 5);
  assert.ok(rows.every((a) => a.userId === w.user.id && a.entityType === 'User' && a.actorRole === 'MUSTERI' && a.ip && Object.keys(a.details).join() === 'ip' && a.details.ip === a.ip));
  // Kilitli davette yanlış kod da doğru kod da karşılaştırılmaz → yeni kayıt yok
  assert.equal((await codeStep({ email: w.email, code: tried[8], ip: nextIp() })).outcome.reason, 'unavailable');
  assert.equal((await codeStep({ email: w.email, code: w.code, ip: nextIp() })).outcome.reason, 'unavailable');
  assert.deepEqual([(await codeRows({ entityId: w.user.id })).length, await w.attempts()], [5, 5]);
  // Doğru kod (taze davet): hak geri verilir, kayıt yok
  const ok = await invited();
  assert.equal((await codeStep({ email: ok.email, code: ok.code, ip: nextIp() })).outcome.ok, true);
  assert.deepEqual([(await codeRows({ entityId: ok.user.id })).length, await ok.attempts()], [0, 0]);
  // Kod karşılaştırılmayan durumlar: davet yok (hesap yok), kullanılmış, süresi dolmuş, gönderilmemiş
  const used = await invited({ usedAt: new Date() });
  const expired = await invited({ expiresAt: new Date(Date.now() - 1000) });
  const unsent = await invited({ sentAt: null });
  const ipNone = nextIp();
  for (const code of ['111111', '222222', '333333']) assert.equal((await codeStep({ email: 'daveti-yok@deneme.test', code, ip: ipNone })).outcome.reason, 'no_invite');
  for (const [x, reason] of [[used, 'no_invite'], [expired, 'unavailable'], [unsent, 'no_invite']]) {
    for (const code of [x.code, ...x.wrong(2)]) assert.equal((await codeStep({ email: x.email, code, ip: nextIp() })).outcome.reason, reason);
    assert.deepEqual([(await codeRows({ entityId: x.user.id })).length, await x.attempts()], [0, 0]);
  }
  assert.equal(await db.auditLog.count({ where: { ip: ipNone } }), 0);
  // Kodlar ve e-postalar bu testin hiçbir denetim kaydında / bildiriminde yok
  const ids = [w, ok, used, expired, unsent].map((x) => x.user.id);
  const dump = textOf(await db.auditLog.findMany({ where: { OR: [{ entityId: { in: ids } }, { ip: ipNone }] } }))
    + JSON.stringify(await db.notification.findMany({ where: { type: 'AUTH_LOCKED' }, select: { params: true, message: true } }));
  for (const s of [w.code, ok.code, used.code, expired.code, unsent.code, ...tried, '111111', '222222', '333333', w.email, 'daveti-yok@deneme.test']) assert.equal(dump.includes(s), false, `kayıtta "${s}" yok`);
}));

dbTest('kod adımı: aynı anda 40 yanlış kod (ayrı IP\'ler) → CODE_FAILED tam 5; e-posta geneli kilit (tür CODE) tam BİR kez ve yöneticilere tek bildirim', offline(async () => {
  const w = await invited();
  const tried = w.wrong(40);
  const now = new Date();
  const rs = await Promise.all(tried.map((code) => codeStep({ email: w.email, code, ip: nextIp(), now })));
  const kinds = rs.map((r) => (r.locked ? 'locked' : r.outcome.reason));
  // E-posta geneli sınır 20 hak ayırır: 5'i karşılaştırılır, 15'i "kullanılamaz"; 20 istek sınırda reddedilir
  assert.deepEqual([tally(kinds, 'wrong_code'), tally(kinds, 'unavailable'), tally(kinds, 'locked'), await w.attempts()], [5, 15, 20, 5]);
  assert.equal((await codeRows({ entityId: w.user.id })).length, 5);
  const locks = await lockRows({ entityId: w.user.id });
  assert.deepEqual(locks.map((a) => [a.details.kind, a.details.scopes]), [['CODE', ['email']]]);
  assert.deepEqual((await notices(w.user.id, localDay(now, TZ))).map((n) => n.userId).sort(), admins);
  // Kilit girişi de kapatır (aynı sayaç) ve o istek hiçbir şey yazmaz
  const before = await snapshot();
  assert.equal(result(await attempt({ email: w.email, ip: nextIp(), now }, true)), 'locked');
  assert.deepEqual(await snapshot(), before);
}));

dbTest('kayıt alanları sabittir ve sır içermez: bu veritabanındaki BÜTÜN LOGIN_LOCKED / CODE_FAILED kayıtları', offline(async () => {
  const all = await db.auditLog.findMany({ where: { action: { in: ['LOGIN_LOCKED', 'CODE_FAILED'] } } });
  assert.ok(all.length > 40);
  for (const a of all) {
    assert.equal(a.entityType, 'User');
    assert.equal(a.entityId, a.userId, 'kayıt hesabı yalnızca kullanıcı kimliğiyle gösterir');
    assert.deepEqual(Object.keys(a.details).sort(), a.action === 'LOGIN_LOCKED' ? ['ip', 'kind', 'scopes'] : ['ip']);
    assert.equal(a.details.ip, a.ip);
    if (a.action === 'LOGIN_LOCKED') {
      assert.ok(['LOGIN', 'CODE'].includes(a.details.kind));
      assert.ok(a.details.scopes.length >= 1 && a.details.scopes.every((s) => ['account', 'email', 'ip'].includes(s)));
      assert.deepEqual(a.details.scopes, ['account', 'email', 'ip'].filter((s) => a.details.scopes.includes(s)), 'kapsamlar sabit sırada');
      if (a.userId === null) assert.deepEqual(a.details.scopes, ['ip'], 'kullanıcısız kayıt yalnızca IP geneli kilittir');
    } else {
      assert.ok(a.userId, 'CODE_FAILED her zaman gerçek bir kullanıcıya bağlıdır');
    }
  }
  // İçerik alanlarında (rastgele kimlikler ve olayın adı / türü dışında) e-posta, şifre, kod, anahtar izi yok
  const dump = JSON.stringify(all.map((a) => [a.entityType, a.actorRole, a.ip, { ...a.details, kind: undefined }]));
  assert.equal(/@|ozet|password|sifre|code|token|cookie|session/i.test(dump), false, 'e-posta / şifre / kod / anahtar alanı yok');
}));
