// P6 — yönetici acil erişim kurtarma (karar 246): saf kurallar, komut akışı (sahte veritabanı + sahte terminal) ve yapı
// (HTTP yolu yok, şifre komut satırından / ortamdan / kabuktan alınmaz).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newPasswordProblem, operatorLabel, recoverAdmin, targetProblem } from '../server/auth/admin-recovery.js';
import { MAX_TRIES, runRecoveryCli } from '../server/auth/admin-recovery-cli.js';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const admin = { id: 'u1', name: 'Yönetici', email: 'yonetici@firma.test', type: 'INTERNAL', appRole: 'ADMIN', isActive: true, deletedAt: null };
const GOOD = 'uzun bir parola 2026';

test('hedef: yalnızca var olan, etkin, silinmemiş, iç ekip ADMIN hesabı', () => {
  assert.equal(targetProblem(admin), null);
  assert.equal(targetProblem(null), 'NOT_FOUND');
  assert.equal(targetProblem({ ...admin, deletedAt: new Date() }), 'DELETED');
  assert.equal(targetProblem({ ...admin, isActive: false }), 'INACTIVE');
  assert.equal(targetProblem({ ...admin, type: 'CUSTOMER' }), 'NOT_INTERNAL');
  for (const role of ['YONETICI_YARDIMCISI', 'SATIS', 'CIZIM', 'DENETIM', 'MUSTERI']) assert.equal(targetProblem({ ...admin, appRole: role }), 'NOT_ADMIN', role);
});

test('yeni şifre: ortak kural + iki giriş aynı; operatör etiketi güvenli', () => {
  assert.equal(newPasswordProblem('kisa', 'kisa'), 'short');
  assert.equal(newPasswordProblem('aaaaaaaaaaaa', 'aaaaaaaaaaaa'), 'trivial');
  assert.equal(newPasswordProblem('x'.repeat(150) + 'abcdefghij'.repeat(6), 'y'), 'long');
  assert.equal(newPasswordProblem(GOOD, `${GOOD} `), 'MISMATCH');
  assert.equal(newPasswordProblem(GOOD, GOOD), null);
  assert.equal(operatorLabel('erhan; rm -rf /'), 'erhanrm-rf');
  assert.equal(operatorLabel(''), 'unknown');
});

/** Sahte veritabanı: yalnızca okuma + denetim kaydı; her yazma çağrısı kaydedilir */
function fakeDb(user) {
  const writes = [];
  const audits = [];
  return {
    writes, audits,
    user: {
      findUnique: async ({ where }) => (user && where.email === user.email ? user : null),
      update: async (a) => { writes.push(['user.update', a]); return user; },
      create: async (a) => { writes.push(['user.create', a]); return a.data; },
    },
    auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
    $transaction: async () => { writes.push(['transaction']); throw new Error('beklenmeyen işlem'); },
  };
}
/** Sahte terminal: sıradaki yanıtlar; çıktı birikir */
function fakeIo(answers, { tty = true } = {}) {
  const output = [];
  const q = [...answers];
  return { output, io: { isTTY: tty, ask: async () => q.shift() ?? '', askHidden: async () => q.shift() ?? '', print: (s) => output.push(s) } };
}

test('komut: argüman / terminal denetimi — şifre komut satırından alınmaz, borudan okunmaz', async () => {
  const db = fakeDb(admin);
  for (const argv of [[], ['a@b.test', 'ikinci'], ['--password', GOOD], ['-p']]) {
    const t = fakeIo([]);
    assert.equal(await runRecoveryCli({ argv, db, io: t.io }), 2, JSON.stringify(argv));
    assert.match(t.output.join('\n'), /Kullanım/);
  }
  const pipe = fakeIo([GOOD, GOOD], { tty: false });
  assert.equal(await runRecoveryCli({ argv: [admin.email], db, io: pipe.io }), 2);
  assert.match(pipe.output.join('\n'), /etkileşimli terminal/);
  assert.deepEqual(db.writes, [], 'hiçbir yazma yok');
});

test('komut: hatalı hesap / yetersiz yetki / onay eşleşmezse yazma yok; başarısızlık denetime yalnızca kodla yazılır', async () => {
  for (const [user, code] of [[null, 'NOT_FOUND'], [{ ...admin, appRole: 'YONETICI_YARDIMCISI' }, 'NOT_ADMIN'], [{ ...admin, appRole: 'MUSTERI', type: 'CUSTOMER' }, 'NOT_INTERNAL'], [{ ...admin, isActive: false }, 'INACTIVE']]) {
    const db = fakeDb(user);
    const t = fakeIo([admin.email, GOOD, GOOD]);
    assert.equal(await runRecoveryCli({ argv: [admin.email], db, io: t.io, operator: 'ops' }), 1, code);
    assert.deepEqual(db.writes, [], `${code}: yazma yok (yeni hesap da açılmaz)`);
    assert.equal(db.audits.length, 1);
    assert.deepEqual([db.audits[0].action, db.audits[0].details.code, db.audits[0].details.via, db.audits[0].details.operator], ['ADMIN_RECOVERY_FAILED', code, 'SSH_CLI', 'ops']);
    assert.ok(!JSON.stringify(db.audits).includes(admin.email) && !JSON.stringify(db.audits).includes(GOOD), 'denetimde e-posta / şifre yok');
  }
  // Onay e-postası farklı
  const db = fakeDb(admin);
  const t = fakeIo(['baska@firma.test', GOOD, GOOD]);
  assert.equal(await runRecoveryCli({ argv: [admin.email], db, io: t.io }), 1);
  assert.deepEqual(db.writes, []);
  assert.equal(db.audits[0].details.code, 'CONFIRM_MISMATCH');
});

test(`komut: zayıf / eşleşmeyen şifre ${MAX_TRIES} denemede biter; hiçbir şey yazılmaz; şifre çıktıya düşmez`, async () => {
  const db = fakeDb(admin);
  const bad = ['kisa1', 'kisa1', GOOD, `${GOOD}x`, 'aaaaaaaaaaaa', 'aaaaaaaaaaaa'];
  const t = fakeIo([admin.email, ...bad]);
  assert.equal(await runRecoveryCli({ argv: [admin.email], db, io: t.io }), 1);
  assert.deepEqual(db.writes, []);
  assert.equal(db.audits.at(-1).details.code, 'TOO_MANY_TRIES');
  const all = t.output.join('\n');
  for (const p of bad) assert.ok(!all.includes(p), `çıktıda şifre yok: ${p}`);
});

test('servis: şifre kuralı ve e-posta biçimi veritabanına gitmeden reddedilir', async () => {
  const db = fakeDb(admin);
  assert.deepEqual(await recoverAdmin(db, { email: 'bozuk', password: GOOD, confirm: GOOD }), { ok: false, code: 'BAD_EMAIL' });
  assert.deepEqual(await recoverAdmin(db, { email: admin.email, password: 'kisa', confirm: 'kisa' }), { ok: false, code: 'WEAK_SHORT' });
  assert.deepEqual(await recoverAdmin(db, { email: admin.email, password: GOOD, confirm: 'x' }), { ok: false, code: 'MISMATCH' });
  assert.deepEqual(db.writes, []);
});

test('yapı: HTTP yolu yok — kurtarma modülünü hiçbir sayfa / işlem / route / bileşen içe aktarmaz; yalnızca sunucu komutu', () => {
  const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const users = ['app', 'lib', 'components', 'server', 'scripts'].flatMap(walk)
    .filter((f) => /\.(m?js|tsx?)$/.test(f))
    .filter((f) => /admin-recovery(-cli)?(\.js)?['"]/.test(read(f)));
  assert.deepEqual(users.sort(), ['scripts/admin-recover.mjs', 'server/auth/admin-recovery-cli.js'].sort());
  assert.ok(!fs.existsSync(path.join(root, 'middleware.ts')) || !read('middleware.ts').includes('recover'));
  // Komut: şifreyi yalnızca terminalden, görünmeden okur; komut satırı / ortam / dosya yok
  const script = read('scripts/admin-recover.mjs');
  assert.ok(script.includes('askHidden: (q) => readLine(q, false)'));
  assert.ok(!/process\.env\.[A-Z_]*(PASS|SIFRE|ŞİFRE)/i.test(script), 'ortamdan şifre okunmaz');
  assert.ok(!/console\.log/.test(script), 'stdout günlüğüne yazılmaz');
  // Sunucu aracı: root + etkileşimli terminal; şifreyi kabukta okumaz
  const sh = read('deploy/takip.sh');
  const fn = sh.slice(sh.indexOf('cmd_admin_recover() {'), sh.indexOf('cmd_github() {'));
  assert.ok(fn.includes('[ "$(id -u)" = 0 ]'), 'root');
  assert.ok(fn.includes('[ ! -t 0 ] || [ ! -t 1 ]'), 'etkileşimli terminal');
  assert.ok(!/tty_read|read -/.test(fn), 'şifre kabukta okunmaz');
  assert.ok(fn.includes('compose run --rm -e TAKIP_OPERATOR="${op:-unknown}" tools node scripts/admin-recover.mjs "$1"'));
  assert.ok(sh.includes('yonetici-kurtar | admin-recover) cmd_admin_recover "$@" ;;'));
  // Servis yalnızca şifre özetini değiştirir (rol / ad / e-posta / firma / etkinlik yazmaz)
  const svc = read('server/auth/admin-recovery.js');
  assert.ok(svc.includes('await tx.user.update({ where: { id }, data: { passwordHash } });'));
  const code = svc.replace(/\/\/.*$/gm, '');
  assert.ok(!/\.user\.create|\.user\.upsert|\.user\.updateMany/.test(code), 'hesap açılmaz, toplu yazma yok');
  assert.equal((code.match(/\.user\.update\(/g) ?? []).length, 1, 'tek kullanıcı yazımı: yalnızca şifre özeti');
});
