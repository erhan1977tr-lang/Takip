// P6 — yönetici acil erişim kurtarma (karar 246), gerçek PostgreSQL: yalnızca belirtilen yönetici hesabı; şifre özeti,
// oturum iptali, davet kodu kapatma, denetim kaydı (giriş deneme sayaçlarına dokunulmaz) tek işlemde; hatalı hesap / yetki / tekrar /
// eşzamanlı / başarısız işlem; komut süreci terminal dışında çalışmaz. Gerçek yönetici hesabı yok (test hesapları).
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { closeDb, dbTest, getDb, offline, resetDb } from './helpers.js';

const { recoverAdmin, findRecoveryTarget } = await import('../../server/auth/admin-recovery.js');
const { runRecoveryCli } = await import('../../server/auth/admin-recovery-cli.js');
const { hashPassword, verifyPassword } = await import('../../server/auth/password-hash.js');

const ROOT = new URL('../..', import.meta.url).pathname;
const OLD = 'eski şifre 12345';
const NEW = 'yeni uzun parola 2026';
let db;
const U = {};

async function user(key, data) {
  U[key] = await db.user.create({ data: { email: `${key}@kurtarma.test`, name: key, type: 'INTERNAL', appRole: 'ADMIN', passwordHash: await hashPassword(OLD), ...data } });
}
const session = (key, tag) => db.session.create({ data: { userId: U[key].id, tokenHash: `${key}-${tag}-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000) } });
const snapshot = async (key) => {
  const u = await db.user.findUniqueOrThrow({ where: { id: U[key].id } });
  return { u, sessions: await db.session.count({ where: { userId: u.id } }), openInvites: await db.userInvite.count({ where: { userId: u.id, usedAt: null } }) };
};

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = await getDb();
  await resetDb(db);
  const factory = await db.customer.create({ data: { name: 'GKH', type: 'FACTORY' } });
  const firm = await db.customer.create({ data: { name: 'Müşteri', prefix: 'KRT' } });
  await user('admin', { customerId: factory.id });
  await user('admin2', { customerId: factory.id });
  await user('assistant', { appRole: 'YONETICI_YARDIMCISI', customerId: factory.id });
  await user('sales', { appRole: 'SATIS', customerId: factory.id });
  await user('customer', { appRole: 'MUSTERI', type: 'CUSTOMER', customerId: firm.id });
  await user('inactive', { isActive: false, customerId: factory.id });
  await user('deleted', { deletedAt: new Date(), customerId: factory.id });
  for (const k of ['admin', 'admin2', 'sales', 'assistant']) { await session(k, 'a'); await session(k, 'b'); }
  await db.userInvite.create({ data: { userId: U.admin.id, codeHash: 'x', expiresAt: new Date(Date.now() + 3_600_000), sentAt: new Date() } });
  await db.authFailure.createMany({ data: [
    ...Array.from({ length: 5 }, () => ({ kind: 'LOGIN', email: 'admin@kurtarma.test', ip: '10.0.0.1' })),
    { kind: 'LOGIN', email: 'sales@kurtarma.test', ip: '10.0.0.1' },
  ] });
});
after(closeDb);

dbTest('kurtarma: yalnızca belirtilen yönetici — şifre değişir, oturumları kapanır, açık kodu geçersiz, giriş deneme sayaçlarına dokunulmaz, denetim kaydı; başka hiçbir şey değişmez', offline(async () => {
  const usersBefore = await db.user.count();
  const others = { admin2: await snapshot('admin2'), sales: await snapshot('sales'), assistant: await snapshot('assistant') };
  const auditsBefore = await db.auditLog.count();
  const r = await recoverAdmin(db, { email: ' ADMIN@kurtarma.test ', password: NEW, confirm: NEW, operator: 'ops-user', host: 'sunucu-1' });
  assert.deepEqual(r, { ok: true, userId: U.admin.id, sessionsRevoked: 2, invitesClosed: 1 });
  const after = await snapshot('admin');
  assert.equal(await verifyPassword(NEW, after.u.passwordHash), true, 'yeni şifre geçerli');
  assert.equal(await verifyPassword(OLD, after.u.passwordHash), false, 'eski şifre geçersiz');
  assert.deepEqual([after.sessions, after.openInvites], [0, 0]);
  // Rol, ad, e-posta, firma, etkinlik aynen
  for (const f of ['appRole', 'type', 'name', 'email', 'customerId', 'isActive', 'deletedAt', 'language']) assert.deepEqual(after.u[f], U.admin[f], f);
  // Başka kullanıcılar ve başka e-postanın kilit sayacı aynen; yeni hesap yok
  for (const [k, v] of Object.entries(others)) assert.deepEqual(await snapshot(k), v, k);
  assert.equal(await db.authFailure.count({ where: { email: 'sales@kurtarma.test' } }), 1);
  assert.equal(await db.authFailure.count({ where: { email: 'admin@kurtarma.test' } }), 5, 'kilit sayaçları aynen (karar 148–149)');
  assert.equal(await db.user.count(), usersBefore);
  // Denetim: tek kayıt; şifre / özet / e-posta yok
  const audits = await db.auditLog.findMany({ where: { action: 'ADMIN_RECOVERY' } });
  assert.equal(await db.auditLog.count(), auditsBefore + 1);
  assert.deepEqual([audits.length, audits[0].entityId, audits[0].userId, audits[0].actorRole, audits[0].details], [1, U.admin.id, U.admin.id, 'SYSTEM', {
    via: 'SSH_CLI', operator: 'ops-user', host: 'sunucu-1', sessionsRevoked: 2, invitesClosed: 1,
  }]);
  const text = JSON.stringify(audits);
  for (const s of [NEW, after.u.passwordHash, 'admin@kurtarma.test']) assert.ok(!text.includes(s), 'denetimde gizli değer yok');
  // Denetim kaydı değiştirilemez (append-only tetikleyici)
  await assert.rejects(db.auditLog.update({ where: { id: audits[0].id }, data: { action: 'X' } }));
}));

dbTest('tekrar deneme: ikinci kurtarma da çalışır (yeni oturum yine kapanır); eşzamanlı iki kurtarma sırayla, ikisi de kayıtlı', offline(async () => {
  await session('admin', 'yeni');
  const again = await recoverAdmin(db, { email: 'admin@kurtarma.test', password: `${NEW} ikinci`, confirm: `${NEW} ikinci`, operator: 'ops' });
  assert.deepEqual([again.ok, again.sessionsRevoked, again.invitesClosed], [true, 1, 0]);
  assert.equal(await verifyPassword(`${NEW} ikinci`, (await snapshot('admin')).u.passwordHash), true);
  const [a, b] = await Promise.all([
    recoverAdmin(db, { email: 'admin@kurtarma.test', password: 'paralel birinci 1', confirm: 'paralel birinci 1' }),
    recoverAdmin(db, { email: 'admin@kurtarma.test', password: 'paralel ikinci 22', confirm: 'paralel ikinci 22' }),
  ]);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  const hash = (await snapshot('admin')).u.passwordHash;
  assert.ok((await verifyPassword('paralel birinci 1', hash)) !== (await verifyPassword('paralel ikinci 22', hash)), 'son yazan kazanır, ikisi birden değil');
  assert.equal(await db.auditLog.count({ where: { action: 'ADMIN_RECOVERY' } }), 4);
}));

dbTest('hatalı hesap / yetersiz yetki: yönetici yardımcısı, satış, müşteri, pasif, silinmiş, olmayan hesap — hiçbir şey yazılmaz, hesap açılmaz', offline(async () => {
  const usersBefore = await db.user.count();
  for (const [k, code] of [['assistant', 'NOT_ADMIN'], ['sales', 'NOT_ADMIN'], ['customer', 'NOT_INTERNAL'], ['inactive', 'INACTIVE'], ['deleted', 'DELETED']]) {
    const before = await snapshot(k);
    const r = await recoverAdmin(db, { email: `${k}@kurtarma.test`, password: NEW, confirm: NEW });
    assert.deepEqual([r.ok, r.code], [false, code], k);
    assert.deepEqual(await snapshot(k), before, `${k} değişmedi`);
  }
  assert.deepEqual(await recoverAdmin(db, { email: 'yok@kurtarma.test', password: NEW, confirm: NEW }), { ok: false, code: 'NOT_FOUND', userId: null });
  assert.equal(await db.user.count(), usersBefore, 'yeni hesap açılmadı');
  assert.equal(await db.user.findUnique({ where: { email: 'yok@kurtarma.test' } }), null);
  assert.deepEqual((await findRecoveryTarget(db, 'admin2@kurtarma.test')).ok, true);
}));

dbTest('başarısız işlem: işlemin bir adımı hata verirse hiçbir şey yazılmaz (şifre, oturum, kod, kilit sayacı aynen)', offline(async () => {
  await db.authFailure.create({ data: { kind: 'LOGIN', email: 'admin2@kurtarma.test', ip: '10.0.0.2' } });
  await db.userInvite.create({ data: { userId: U.admin2.id, codeHash: 'y', expiresAt: new Date(Date.now() + 3_600_000), sentAt: new Date() } });
  const before = await snapshot('admin2');
  await assert.rejects(recoverAdmin(db, { email: 'admin2@kurtarma.test', password: NEW, confirm: NEW, audit: async () => { throw Object.assign(new Error('denetim yazılamadı'), { code: 'SIM' }); } }), /denetim yazılamadı/);
  assert.deepEqual(await snapshot('admin2'), before);
  assert.equal(await db.authFailure.count({ where: { email: 'admin2@kurtarma.test' } }), 1);
}));

dbTest('komut akışı (gerçek veritabanı, sahte terminal): başarı çıktısında şifre yok; yetersiz yetki denetime yalnızca kodla', offline(async () => {
  const output = [];
  const answers = ['admin2@kurtarma.test', 'kisa', 'kisa', NEW, NEW];
  const io = { isTTY: true, ask: async () => answers.shift(), askHidden: async () => answers.shift(), print: (s) => output.push(s) };
  assert.equal(await runRecoveryCli({ argv: ['admin2@kurtarma.test'], db, io, operator: 'ops' }), 0);
  assert.equal(await verifyPassword(NEW, (await snapshot('admin2')).u.passwordHash), true);
  const all = output.join('\n');
  assert.match(all, /Şifre değiştirildi\. 2 açık oturum kapatıldı/);
  for (const s of [NEW, 'kisa']) assert.ok(!all.includes(s));
  const out2 = [];
  const io2 = { isTTY: true, ask: async () => 'sales@kurtarma.test', askHidden: async () => NEW, print: (s) => out2.push(s) };
  assert.equal(await runRecoveryCli({ argv: ['sales@kurtarma.test'], db, io: io2, operator: 'ops' }), 1);
  const fail = await db.auditLog.findFirstOrThrow({ where: { action: 'ADMIN_RECOVERY_FAILED' }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual([fail.userId, fail.details.code, fail.details.via], [U.sales.id, 'NOT_ADMIN', 'SSH_CLI']);
  assert.ok(!JSON.stringify(fail).includes('sales@kurtarma.test'));
}));

dbTest('komut süreci: terminal yoksa (boru) ve şifre argüman olarak verilirse çalışmaz; veritabanı değişmez', offline(async () => {
  const before = await snapshot('admin');
  const run = (args, input) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/admin-recover.mjs'), ...args], {
      cwd: ROOT, env: { PATH: process.env.PATH ?? '', DATABASE_URL: process.env.TEST_DATABASE_URL }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, out }));
  });
  const piped = await run(['admin@kurtarma.test'], `admin@kurtarma.test\n${NEW}\n${NEW}\n`);
  assert.equal(piped.code, 2);
  assert.match(piped.out, /etkileşimli terminal/);
  assert.ok(!piped.out.includes(NEW));
  const arg = await run(['admin@kurtarma.test', '--password', NEW], '');
  assert.equal(arg.code, 2);
  assert.match(arg.out, /Kullanım/);
  assert.deepEqual(await snapshot('admin'), before);
}));
