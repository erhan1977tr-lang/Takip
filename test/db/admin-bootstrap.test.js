// Karar 247 — kurulum komutu `takip yonetici` (server/auth/admin-bootstrap.js + scripts/create-admin.mjs), gerçek PostgreSQL:
// ilk kurulum (fabrika + yönetici + kod), ek yönetici, var olan hesapta rol yükseltme YOK, --reset kurtarmayı dolanamaz,
// yarım kalmış yöneticiye yalnızca yeni kod, eşzamanlı açılış, gerçek komut süreci. Gerçek hesap yok (test hesapları).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { bootstrapAdmin } = await import('../../server/auth/admin-bootstrap.js');
const { hashCode } = await import('../../server/auth/inviteCode.js');
const { recoverAdmin } = await import('../../server/auth/admin-recovery.js');
const { hashPassword, verifyPassword } = await import('../../server/auth/password-hash.js');

const ROOT = new URL('../..', import.meta.url).pathname;
const SECRET = 'kurulum-testi-gizli-anahtar-0123456789abcdef';
const PW = 'mevcut şifre 12345';
let db;

const snapshot = async (email) => {
  const u = await db.user.findUnique({ where: { email } });
  if (!u) return null;
  const invites = await db.userInvite.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'asc' } });
  return { u, sessions: await db.session.count({ where: { userId: u.id } }), invites };
};
const session = (userId) => db.session.create({ data: { userId, tokenHash: `t-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000) } });
const codeMatches = async (email, code) => {
  const u = await db.user.findUniqueOrThrow({ where: { email } });
  const open = await db.userInvite.findMany({ where: { userId: u.id, usedAt: null } });
  return open.length === 1 && open[0].codeHash === hashCode(code, email, SECRET);
};

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
});
after(closeDb);

dbTest('ilk kurulum: fabrika yoksa açılır, yönetici açılır, tek kullanımlık kod; denetimde e-posta / kod yok', offline(async () => {
  const factories = await db.customer.count({ where: { type: 'FACTORY' } });
  const r = await bootstrapAdmin(db, { email: ' Ilk@Kurulum.test ', name: 'İlk Yönetici', factoryName: 'GKH Trading', secret: SECRET });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'CREATED');
  assert.match(r.code, /^\d{6}$/);
  assert.equal(r.factoryCreated, factories === 0);
  const s = await snapshot('ilk@kurulum.test');
  assert.deepEqual([s.u.appRole, s.u.type, s.u.isActive, s.u.passwordHash, s.u.name], ['ADMIN', 'INTERNAL', true, null, 'İlk Yönetici']);
  assert.equal(await codeMatches('ilk@kurulum.test', r.code), true);
  const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'ADMIN_BOOTSTRAP', entityId: s.u.id } });
  assert.deepEqual(audit.details, { via: 'SSH_CLI', mode: 'CREATED', firstAdmin: true, factoryCreated: r.factoryCreated });
  assert.ok(!JSON.stringify(audit).includes('ilk@kurulum.test') && !JSON.stringify(audit).includes(r.code));
  // Ek yönetici: yeni e-postayla açılır (fabrika yeniden açılmaz)
  const r2 = await bootstrapAdmin(db, { email: 'ikinci@kurulum.test', name: 'İkinci', secret: SECRET });
  assert.deepEqual([r2.ok, r2.mode, r2.factoryCreated], [true, 'CREATED', false]);
  assert.equal((await db.auditLog.findFirstOrThrow({ where: { action: 'ADMIN_BOOTSTRAP', entityId: r2.userId } })).details.firstAdmin, false);
}));

dbTest('yetki yükseltme yok: var olan yönetici-dışı / pasif / silinmiş hesap hiç değişmez (şifreli ya da davet bekleyen)', offline(async () => {
  const factory = await db.customer.findFirstOrThrow({ where: { type: 'FACTORY' } });
  const firm = await db.customer.create({ data: { name: 'Müşteri Firma', prefix: 'KRL' } });
  const cases = [
    ['musteri', { type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firm.id }, 'NOT_INTERNAL'],
    ['musteri-davet', { type: 'CUSTOMER', appRole: 'MUSTERI', customerId: firm.id, passwordHash: null }, 'NOT_INTERNAL'],
    ['satis', { appRole: 'SATIS' }, 'NOT_ADMIN'],
    ['satis-davet', { appRole: 'SATIS', passwordHash: null }, 'NOT_ADMIN'],
    ['cizim', { appRole: 'CIZIM' }, 'NOT_ADMIN'],
    ['denetim', { appRole: 'DENETIMCI' }, 'NOT_ADMIN'],
    ['yardimci', { appRole: 'YONETICI_YARDIMCISI' }, 'NOT_ADMIN'],
    ['pasif-yonetici', { appRole: 'ADMIN', isActive: false, passwordHash: null }, 'INACTIVE'],
    ['silinmis-yonetici', { appRole: 'ADMIN', deletedAt: new Date(), passwordHash: null }, 'DELETED'],
  ];
  const hash = await hashPassword(PW);
  for (const [key, data] of cases) {
    const u = await db.user.create({ data: { email: `${key}@kurulum.test`, name: key, type: 'INTERNAL', customerId: factory.id, passwordHash: hash, ...data } });
    await session(u.id);
  }
  const usersBefore = await db.user.count();
  for (const [key, , code] of cases) {
    const email = `${key}@kurulum.test`;
    const before = await snapshot(email);
    for (const reset of [false, true]) {
      const r = await bootstrapAdmin(db, { email, name: 'Yeni Ad', secret: SECRET, reset });
      assert.deepEqual(r, { ok: false, code: reset ? 'RESET_REMOVED' : code }, `${key} reset=${reset}`);
      assert.deepEqual(await snapshot(email), before, `${key} reset=${reset}: rol, tür, etkinlik, ad, şifre, oturum, kod aynen`);
    }
    const refused = await db.auditLog.findFirstOrThrow({ where: { action: 'ADMIN_BOOTSTRAP_REFUSED', details: { path: ['code'], equals: code } }, orderBy: { createdAt: 'desc' } });
    assert.equal(refused.userId, before.u.id);
    assert.ok(!JSON.stringify(refused).includes(email));
  }
  assert.equal(await db.user.count(), usersBefore, 'hesap açılmadı');
}));

dbTest('--reset kurtarmayı dolanamaz: şifreli yönetici değişmez; acil erişim yalnızca yonetici-kurtar ile çalışır', offline(async () => {
  const factory = await db.customer.findFirstOrThrow({ where: { type: 'FACTORY' } });
  const u = await db.user.create({ data: { email: 'aktif@kurulum.test', name: 'Aktif', type: 'INTERNAL', appRole: 'ADMIN', customerId: factory.id, passwordHash: await hashPassword(PW) } });
  await session(u.id);
  const before = await snapshot('aktif@kurulum.test');
  assert.deepEqual(await bootstrapAdmin(db, { email: 'aktif@kurulum.test', secret: SECRET, reset: true }), { ok: false, code: 'RESET_REMOVED' });
  assert.deepEqual(await bootstrapAdmin(db, { email: 'aktif@kurulum.test', secret: SECRET }), { ok: false, code: 'HAS_PASSWORD' });
  assert.deepEqual(await snapshot('aktif@kurulum.test'), before, 'şifre, oturum, kod aynen');
  assert.equal(await verifyPassword(PW, before.u.passwordHash), true);
  // Yeni kurtarma komutu değişmeden çalışır
  const rec = await recoverAdmin(db, { email: 'aktif@kurulum.test', password: 'kurtarma sonrası 2026', confirm: 'kurtarma sonrası 2026', operator: 'ops' });
  assert.deepEqual([rec.ok, rec.sessionsRevoked], [true, 1]);
}));

dbTest('yarım kalmış kurulum: şifresini belirlememiş etkin yöneticiye yalnızca yeni kod (eski kod kapanır, ad / rol değişmez)', offline(async () => {
  const first = await bootstrapAdmin(db, { email: 'yarim@kurulum.test', name: 'Yarım', secret: SECRET });
  const before = await snapshot('yarim@kurulum.test');
  const again = await bootstrapAdmin(db, { email: 'yarim@kurulum.test', name: 'Başka Ad', secret: SECRET });
  assert.deepEqual([again.ok, again.mode, again.userId], [true, 'CODE_REISSUED', first.userId]);
  const after = await snapshot('yarim@kurulum.test');
  assert.deepEqual([after.u.name, after.u.appRole, after.u.passwordHash, after.u.isActive], [before.u.name, 'ADMIN', null, true]);
  assert.equal(await codeMatches('yarim@kurulum.test', again.code), true, 'yalnızca yeni kod açık');
  assert.equal(after.invites.length, 2);
  assert.ok(after.invites[0].usedAt, 'eski kod kapandı');
  assert.equal((await db.auditLog.findFirstOrThrow({ where: { action: 'ADMIN_BOOTSTRAP', entityId: first.userId, details: { path: ['mode'], equals: 'CODE_REISSUED' } } })).details.via, 'SSH_CLI');
}));

dbTest('eşzamanlı açılış: aynı e-postayla iki komut → tek hesap, tek açık kod', offline(async () => {
  const res = await Promise.all([1, 2, 3].map(() => bootstrapAdmin(db, { email: 'paralel@kurulum.test', name: 'Paralel', secret: SECRET })));
  const ok = res.filter((r) => r.ok);
  assert.equal(ok.filter((r) => r.mode === 'CREATED').length, 1, JSON.stringify(res.map((r) => r.mode ?? r.code)));
  for (const r of res.filter((x) => !x.ok)) assert.equal(r.code, 'CONFLICT');
  assert.equal(await db.user.count({ where: { email: 'paralel@kurulum.test' } }), 1);
  const u = await db.user.findUniqueOrThrow({ where: { email: 'paralel@kurulum.test' } });
  assert.equal(await db.userInvite.count({ where: { userId: u.id, usedAt: null } }), 1);
}));

dbTest('gerçek komut süreci: yeni hesap CODE= satırı; var olan satış hesabı ve --reset reddedilir, rol değişmez', offline(async () => {
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/create-admin.mjs'), ...args], {
      cwd: ROOT, env: { PATH: process.env.PATH ?? '', DATABASE_URL: process.env.TEST_DATABASE_URL, AUTH_SECRET: SECRET }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  const created = await run(['komut@kurulum.test', 'Komut Yönetici', '--factory', 'GKH Trading']);
  assert.equal(created.code, 0, created.out);
  const code = /CODE=(\d{6})/.exec(created.out)?.[1];
  assert.ok(code && (await codeMatches('komut@kurulum.test', code)));
  const before = await snapshot('satis@kurulum.test');
  const promote = await run(['satis@kurulum.test', 'X']);
  assert.equal(promote.code, 1);
  assert.match(promote.out, /yönetici OLMAYAN/);
  const reset = await run(['satis@kurulum.test', 'X', '--reset']);
  assert.equal(reset.code, 1);
  assert.match(reset.out, /--reset artık yok/);
  assert.deepEqual(await snapshot('satis@kurulum.test'), before);
  assert.ok(!/CODE=/.test(promote.out + reset.out));
}));
