// Karar 247 — kurulum komutu `takip yonetici` (scripts/create-admin.mjs → server/auth/admin-bootstrap.js): yalnızca YENİ
// yönetici hesabı açar; var olan hesabın rolü / şifresi değişmez (sessiz rol yükseltme yok); eski --reset kaldırıldı, şifresi
// olan yönetici için acil erişim yalnızca `takip yonetici-kurtar` (karar 246). Saf karar + sahte veritabanı + yapı.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BOOTSTRAP_MESSAGES, bootstrapAdmin, bootstrapDecision } from '../server/auth/admin-bootstrap.js';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SECRET = 'x'.repeat(40);
const admin = { type: 'INTERNAL', appRole: 'ADMIN', isActive: true, deletedAt: null, hasPassword: true };

test('karar: hesap yoksa açılır; var olan hesabın rolü hiçbir durumda yükseltilmez', () => {
  assert.equal(bootstrapDecision(null), 'CREATE');
  assert.equal(bootstrapDecision(admin), 'HAS_PASSWORD');
  assert.equal(bootstrapDecision({ ...admin, hasPassword: false }), 'REISSUE');
  for (const role of ['YONETICI_YARDIMCISI', 'SATIS', 'CIZIM', 'DENETIMCI', 'MUSTERI']) {
    assert.equal(bootstrapDecision({ ...admin, appRole: role }), 'NOT_ADMIN', role);
    assert.equal(bootstrapDecision({ ...admin, appRole: role, hasPassword: false }), 'NOT_ADMIN', `${role} (davet bekleyen)`);
  }
  assert.equal(bootstrapDecision({ ...admin, type: 'CUSTOMER' }), 'NOT_INTERNAL');
  assert.equal(bootstrapDecision({ ...admin, isActive: false, hasPassword: false }), 'INACTIVE');
  assert.equal(bootstrapDecision({ ...admin, deletedAt: new Date(), hasPassword: false }), 'DELETED');
  for (const code of ['BAD_EMAIL', 'NO_SECRET', 'RESET_REMOVED', 'HAS_PASSWORD', 'NOT_ADMIN', 'NOT_INTERNAL', 'INACTIVE', 'DELETED', 'CONFLICT']) assert.ok(BOOTSTRAP_MESSAGES[code], code);
  assert.match(BOOTSTRAP_MESSAGES.RESET_REMOVED, /yonetici-kurtar/);
  assert.match(BOOTSTRAP_MESSAGES.HAS_PASSWORD, /yonetici-kurtar/);
});

function fakeDb() {
  const audits = [];
  const calls = [];
  return {
    audits, calls,
    auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
    $transaction: async () => { calls.push('transaction'); throw new Error('beklenmeyen işlem'); },
  };
}

test('servis: e-posta / AUTH_SECRET veritabanına gitmeden; --reset hiçbir şeye dokunmadan reddedilir (yalnızca denetim)', async () => {
  const db = fakeDb();
  assert.deepEqual(await bootstrapAdmin(db, { email: 'bozuk', secret: SECRET }), { ok: false, code: 'BAD_EMAIL' });
  assert.deepEqual(await bootstrapAdmin(db, { email: 'a@b.test', secret: 'kisa' }), { ok: false, code: 'NO_SECRET' });
  assert.deepEqual(db.audits, []);
  assert.deepEqual(await bootstrapAdmin(db, { email: 'a@b.test', secret: SECRET, reset: true }), { ok: false, code: 'RESET_REMOVED' });
  assert.deepEqual(db.calls, [], 'işlem açılmadı');
  assert.deepEqual([db.audits.length, db.audits[0].action, db.audits[0].details], [1, 'ADMIN_BOOTSTRAP_REFUSED', { via: 'SSH_CLI', code: 'RESET_REMOVED' }]);
  assert.ok(!JSON.stringify(db.audits).includes('a@b.test'));
});

test('yapı: rol yalnızca YENİ hesapta verilir; var olan hesap güncellenmez; HTTP yolu yok; sunucu aracı root ister', () => {
  const svc = read('server/auth/admin-bootstrap.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/\.user\.(update|updateMany|upsert)\(/.test(svc), 'kullanıcı satırı güncellenmez');
  assert.equal((svc.match(/appRole: 'ADMIN'/g) ?? []).length, 2, "yalnızca sorgu (count) ve yeni hesap (create)");
  assert.ok(svc.includes("tx.user.create({ data: { email: e, name: String(name ?? '').trim(), appRole: 'ADMIN', type: 'INTERNAL', customerId: factory.id } })"));
  assert.ok(svc.includes('FOR UPDATE'), 'hesap satırı kilitlenir');
  const script = read('scripts/create-admin.mjs').replace(/\/\/.*$/gm, '');
  assert.ok(script.includes("from '../server/auth/admin-bootstrap.js'"));
  assert.ok(!/\bdb\.(user|userInvite|session|customer|auditLog)\./.test(script), 'komut veritabanına doğrudan yazmaz');
  // HTTP yolu yok
  const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const users = ['app', 'lib', 'components', 'server', 'scripts'].flatMap(walk).filter((f) => /\.(m?js|tsx?)$/.test(f)).filter((f) => /admin-bootstrap(\.js)?['"]/.test(read(f)));
  assert.deepEqual(users, ['scripts/create-admin.mjs']);
  // Panelden yönetici rolü verilmez (değişmedi)
  assert.ok(!/ASSIGNABLE[^\n]*'ADMIN'/.test(read('app/(panel)/admin/users/actions.ts')));
  // Sunucu aracı
  const sh = read('deploy/takip.sh');
  const fn = sh.slice(sh.indexOf('cmd_admin() {'), sh.indexOf('cmd_admin_recover() {'));
  assert.ok(fn.includes('[ "$(id -u)" = 0 ]'), 'root');
  assert.ok(fn.includes('compose run --rm tools node scripts/create-admin.mjs "$email" "$name" --factory "$factory" "$@"'));
  assert.ok(!/--reset/.test(sh.split('\n').slice(0, 20).join('\n')), 'yardım metninde --reset yok');
  assert.ok(!read('deploy/install.sh').includes('--reset'));
  assert.ok(read('deploy/install.sh').includes('takip yonetici "$ADMIN_EMAIL" "$ADMIN_NAME" </dev/null'), 'ilk kurulum aynı komutu kullanır');
});
