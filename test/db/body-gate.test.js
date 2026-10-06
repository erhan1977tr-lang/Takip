// Gövde kapısı (karar 143) — gerçek veritabanıyla: kapının kararı mevcut oturum / depo denetimleriyle aynıdır ve kapı
// HİÇBİR ŞEY YAZMAZ. Kanıt iki yoldan: (1) kapı, PostgreSQL'in SALT OKUNUR işleminde (yazan her komutun hata verdiği
// yerde) çalışır; (2) yüzlerce sorudan sonra ilgili tablolar satır satır aynıdır. Saat her çağrıya verilir (bekleme yok).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { gateDecision } = await import('../../server/security/body-gate.js');
const { SESSION_IDLE_MS, SESSION_TTL_MS, liveSession, peekSession, recordActivity } = await import('../../server/auth/session-policy.js');
const { findDepotOrder, hashToken } = await import('../../server/profile/warehouse.js');

const MIN = 60_000;
const T0 = Date.parse('2026-10-06T09:00:00Z');
let db, admin, passive, firm, seq = 0;
const S = {};
const D = {};

/** Giriş: oturum satırı (lib/auth/session.ts → createSession ile aynı alanlar; özet: SHA-256) */
async function login(user, { createdAt = T0, lastSeenAt = T0 } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.session.create({ data: { userId: user.id, tokenHash, createdAt: new Date(createdAt), lastSeenAt: new Date(lastSeenAt), expiresAt: new Date(createdAt + SESSION_TTL_MS) } });
  return tokenHash;
}
/** Depoya gönderilmiş profil siparişi + depo bağlantısı (yalnızca özeti saklanır) */
async function depot({ expiresAt = T0 + 86_400_000, status } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const n = ++seq;
  await db.order.create({
    data: {
      orderNo: `KAPP${n}`, customerOrderNo: n, title: `kapı ${n}`, orderTypeCode: 'PROFILE_ORDER', customerId: firm.id, createdById: admin.id, ...(status ? { status } : {}),
      profile: { create: { stage: 'DEPODA', pickupDate: new Date('2027-03-19T00:00:00Z'), warehouseSentAt: new Date(T0), depotTokenHash: hashToken(token), depotTokenExpiresAt: new Date(expiresAt) } },
    },
  });
  return token;
}
/** Kapının dokunmaması gereken her şey: satır satır */
async function snapshot() {
  return JSON.stringify({
    sessions: await db.session.findMany({ orderBy: { id: 'asc' } }),
    profiles: await db.profileOrder.findMany({ orderBy: { id: 'asc' } }),
    orders: await db.order.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, version: true, updatedAt: true } }),
    failures: await db.authFailure.count(),
    audits: await db.auditLog.count(),
    events: await db.orderEvent.count(),
    files: await db.orderFile.count(),
    outbox: await db.notificationOutbox.count(),
    users: await db.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, isActive: true, updatedAt: true } }),
  });
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  firm = await db.customer.create({ data: { name: 'Kapi Deneme SRL', prefix: 'KAP' } });
  admin = await db.user.create({ data: { email: 'yonetici@kapi.test', name: 'Yönetici', appRole: 'ADMIN', type: 'INTERNAL', customerId: factory.id } });
  passive = await db.user.create({ data: { email: 'pasif@kapi.test', name: 'Pasif', appRole: 'SATIS', type: 'INTERNAL', customerId: factory.id, isActive: false } });
  S.valid = await login(admin);
  S.idle = await login(admin, { createdAt: T0 - 60 * MIN, lastSeenAt: T0 - SESSION_IDLE_MS });
  S.expired = await login(admin, { createdAt: T0 - SESSION_TTL_MS, lastSeenAt: T0 - MIN });
  S.inactive = await login(passive);
  D.valid = await depot();
  D.expired = await depot({ expiresAt: T0 });
  D.cancelled = await depot({ status: 'IPTAL' });
});
after(closeDb);

/** Kapıya sorulan sorular ve beklenen yanıtlar (now = T0) */
const cases = () => [
  // oturum sayfaları
  ['/siparisler/yeni', S.valid, true],
  ['/siparisler/yeni?tip=GLASS_ORDER', S.valid, true],
  ['/siparisler/cmyoksiparis0000000000000', S.valid, true], // kapı siparişe bakmaz (yetkiyi işlem denetler)
  ['/admin/katalog', S.valid, true],
  ['/admin/stok', S.valid, true],
  ['/siparisler/yeni', S.idle, false],
  ['/siparisler/yeni', S.expired, false],
  ['/siparisler/yeni', S.inactive, false],
  ['/siparisler/yeni', 'f'.repeat(64), false],
  ['/siparisler/yeni', null, false],
  ['/siparisler/yeni', '', false],
  ['/admin/katalog', S.idle, false],
  // depo bağlantısı
  [`/depo/${D.valid}`, null, true],
  [`/depo/${D.valid}?e=file`, null, true],
  [`/depo/${D.valid}`, S.idle, true], // oturumun durumu depo adresinde önemsiz
  [`/depo/${D.expired}`, null, false],
  [`/depo/${D.cancelled}`, null, false],
  [`/depo/${crypto.randomBytes(32).toString('base64url')}`, null, false],
  [`/depo/${crypto.randomBytes(32).toString('base64url')}`, S.valid, false], // geçerli oturum anahtarın yerini tutmaz
  ['/depo/kisa', null, false],
  [`/siparisler/${D.valid}`, null, false], // geçerli anahtar oturum sayfasını açmaz
  // bilinmeyen adresler: geçerli oturum da olsa izin yok
  ['/login', S.valid, false],
  ['/siparisler', S.valid, false],
  ['/SIPARISLER/yeni', S.valid, false],
  ['//siparisler/yeni', S.valid, false],
  ['/siparisler/%79eni', S.valid, false],
  ['/admin/users', S.valid, false],
  ['/oturum/govde-izni', S.valid, false],
  [null, S.valid, false],
];

dbTest('karar: geçerli oturum / geçerli depo bağlantısı geçer; boşta, süresi dolmuş, pasif, uydurma oturum ve geçersiz bağlantı geçmez', offline(async () => {
  for (const [uri, tokenHash, expected] of cases()) {
    assert.equal(await gateDecision(db, { uri, tokenHash, now: T0 }), expected, `${uri} · ${tokenHash ? `${tokenHash.slice(0, 6)}…` : tokenHash}`);
  }
  // Kapı, mevcut denetimlerle aynı şeyi söyler (ikinci bir kural yok)
  for (const key of Object.keys(S)) {
    const peek = await peekSession(db, S[key], { now: T0 });
    assert.equal(await gateDecision(db, { uri: '/siparisler/yeni', tokenHash: S[key], now: T0 }), peek.reason === 'ok', key);
  }
  for (const key of Object.keys(D)) {
    assert.equal(await gateDecision(db, { uri: `/depo/${D[key]}`, tokenHash: null, now: T0 }), (await findDepotOrder(db, D[key], new Date(T0))) !== null, key);
  }
  // Zamanla: 29 dk 59 sn → izin; 30. dakikada → izin yok (kapı oturumu uzatmadı)
  assert.equal(await gateDecision(db, { uri: '/siparisler/yeni', tokenHash: S.valid, now: T0 + SESSION_IDLE_MS - 1000 }), true);
  assert.equal(await gateDecision(db, { uri: '/siparisler/yeni', tokenHash: S.valid, now: T0 + SESSION_IDLE_MS }), false);
  // Depo bağlantısının süresi dolduğu anda kapı da kapanır
  assert.equal(await gateDecision(db, { uri: `/depo/${D.valid}`, tokenHash: null, now: T0 + 86_400_000 - 1 }), true);
  assert.equal(await gateDecision(db, { uri: `/depo/${D.valid}`, tokenHash: null, now: T0 + 86_400_000 }), false);
}));

dbTest('salt okunur (1): kapı PostgreSQL\'in salt okunur işleminde çalışır — yazan tek bir komut olsaydı hata verirdi', offline(async () => {
  const answers = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const out = [];
    for (const [uri, tokenHash] of cases()) out.push(await gateDecision(tx, { uri, tokenHash, now: T0 }));
    // İşlem hâlâ sağlam: kapı hata veren (yazan) tek bir komut bile çalıştırmadı — aksi hâlde bu sorgu da hata verirdi
    assert.equal((await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM "Session"'))[0].n, 4);
    return out;
  });
  assert.deepEqual(answers, cases().map((c) => c[2]));
  // Salt okunur kip gerçekten etkindi: aynı kipte bir yazma denemesi reddedilir (ayrı işlem; hata işlemi bitirir)
  await assert.rejects(db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe('UPDATE "Session" SET "lastSeenAt" = now()');
  }), /read-only/i);
  assert.equal((await db.session.findUnique({ where: { tokenHash: S.valid } })).lastSeenAt.getTime(), T0);
  // Karşılaştırma: liveSession aynı salt okunur işlemde boşta kalmış oturumun satırını silmeye çalışır — kapı bu yüzden
  // liveSession'ı değil, onun salt okunur yarısını (peekSession) kullanır
  let attempted = false;
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const spy = { session: { findUnique: (a) => tx.session.findUnique(a), deleteMany: async () => { attempted = true; return { count: 0 }; } } };
    assert.equal((await liveSession(spy, S.idle, { now: T0 })).reason, 'idle');
    assert.equal((await peekSession(tx, S.idle, { now: T0 })).reason, 'idle');
  });
  assert.equal(attempted, true);
}));

dbTest('salt okunur (2): yüzlerce sorudan sonra oturumlar, depo bağlantıları, hatalı deneme / denetim / olay / dosya / bildirim kayıtları satır satır aynı', offline(async () => {
  const before = await snapshot();
  const all = cases();
  // Art arda ve eşzamanlı sorular (geçerli + geçersiz karışık)
  for (let round = 0; round < 5; round++) for (const [uri, tokenHash] of all) await gateDecision(db, { uri, tokenHash, now: T0 + round * MIN });
  const parallel = await Promise.all(Array.from({ length: 120 }, (_, i) => gateDecision(db, { uri: all[i % all.length][0], tokenHash: all[i % all.length][1], now: T0 })));
  assert.deepEqual(parallel, Array.from({ length: 120 }, (_, i) => all[i % all.length][2]));
  assert.equal(await snapshot(), before);
  // Boşta kalmış ve süresi dolmuş oturum satırları YERİNDE (kapı silmedi); geçerli oturumun son etkinlik anı aynı (uzamadı)
  for (const key of ['idle', 'expired', 'inactive', 'valid']) assert.ok(await db.session.findUnique({ where: { tokenHash: S[key] } }), key);
  assert.equal((await db.session.findUnique({ where: { tokenHash: S.valid } })).lastSeenAt.getTime(), T0);
  // Geçersiz depo denemeleri sayılmadı (sayaç depo işlemindedir; kapı yazmaz)
  assert.equal(await db.authFailure.count(), 0);
}));

dbTest('kapı oturumun yerini tutmaz: asıl denetim (liveSession) ve etkinlik bildirimi olduğu gibi çalışır', offline(async () => {
  // Uygulamanın kendi oturum okuması boşta kalmış satırı siler (mevcut davranış); kapı bundan sonra da "izin yok" der
  assert.equal((await liveSession(db, S.idle, { now: T0 })).reason, 'idle');
  assert.equal(await db.session.findUnique({ where: { tokenHash: S.idle } }), null);
  assert.equal(await gateDecision(db, { uri: '/siparisler/yeni', tokenHash: S.idle, now: T0 }), false);
  // Etkinlik bildirimi oturumu uzatır (tek uzatan yol); kapı uzatılmış oturumu görür ama kendisi uzatmaz
  const r = await recordActivity(db, S.valid, { idleMs: 0, now: T0 + 20 * MIN });
  assert.equal(r.extended, true);
  assert.equal(await gateDecision(db, { uri: '/siparisler/yeni', tokenHash: S.valid, now: T0 + 45 * MIN }), true);
  assert.equal(await gateDecision(db, { uri: '/siparisler/yeni', tokenHash: S.valid, now: T0 + 50 * MIN }), false);
  assert.equal((await db.session.findUnique({ where: { tokenHash: S.valid } })).lastSeenAt.getTime(), T0 + 20 * MIN);
  // Kullanıcı pasifleştirilirse kapı da hemen kapanır
  await db.user.update({ where: { id: admin.id }, data: { isActive: false } });
  assert.equal(await gateDecision(db, { uri: '/siparisler/yeni', tokenHash: S.valid, now: T0 + 21 * MIN }), false);
  await db.user.update({ where: { id: admin.id }, data: { isActive: true } });
  assert.equal(await gateDecision(db, { uri: '/siparisler/yeni', tokenHash: S.valid, now: T0 + 21 * MIN }), true);
  // Çıkış (oturum satırı silinir) → kapı kapanır
  await db.session.deleteMany({ where: { tokenHash: S.valid } });
  assert.equal(await gateDecision(db, { uri: '/siparisler/yeni', tokenHash: S.valid, now: T0 + 21 * MIN }), false);
}));
