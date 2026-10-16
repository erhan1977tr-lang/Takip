// Güvenli geri dönüş, yayın sağlığı ve son sağlıklı sürüm kaydı (3.92.0, karar 287). Buradaki denetimler sunucu aracının
// (deploy/takip.sh) yapısına ve alarm e-postasına bakar; davranış sahte docker ile deploy/test/release-rollback.sh'ta, gerçek
// Docker + PostgreSQL + Caddy ile deploy/test/release-rollback-real.sh'ta (deploy-test.yml) sınanır.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { RELEASE_CODES, RELEASE_ALERT_KINDS, cleanReleaseCodes, cleanVersion, renderReleaseAlert, sendReleaseAlert } from '../server/release/alert.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sh = read('deploy/takip.sh');
const fn = (name) => {
  const i = sh.indexOf(`\n${name}() {`);
  assert.ok(i >= 0, `${name} yok`);
  return sh.slice(i, sh.indexOf('\n}\n', i) + 3);
};
const NOW = new Date('2026-10-16T10:00:00Z');

test('geri dönüş veritabanına dokunmaz: migration, geri yükleme, silme, sıfırlama YOK', () => {
  for (const name of ['do_rollback', 'rollback_verdict', 'cmd_rollback', 'release_recover', 'post_deploy_unhealthy', 'cmd_rollback_check', 'cmd_rollback_status', 'cmd_release_status']) {
    const body = fn(name);
    assert.doesNotMatch(body, /compose run --rm tools\s*(>|\)|$|;)/m, `${name}: migration çalıştırmaz`);
    assert.doesNotMatch(body, /prisma migrate|pg_restore|restore_into|cmd_restore|DROP |TRUNCATE|DELETE FROM|docker volume|volume rm|system prune|image prune -a/, `${name}: veri / birim / yedek işlemi yok`);
  }
  // Geri dönüş yalnızca imaj etiketini ve kapsayıcıları değiştirir
  const r = fn('do_rollback');
  assert.ok(r.includes('env_set APP_TAG "$tag"') && r.includes('compose up -d --remove-orphans'));
  assert.ok(r.indexOf('rollback_verdict "$t" yoklama') < r.indexOf('env_set APP_TAG'), 'önce denetim, sonra geçiş');
  assert.ok(r.indexOf('op_begin rollback') < r.indexOf('env_set APP_TAG'), 'kesinti işareti geçişten önce');
});

test('uyumluluk: veritabanının kendi migration kaydı (ad + checksum) hedefin doğrulandığı andakiyle BİREBİR aynı olmalı', () => {
  const m = fn('mig_state');
  assert.ok(m.includes('migration_name') && m.includes('checksum') && m.includes('finished_at IS NOT NULL AND rolled_back_at IS NULL'));
  const v = fn('rollback_verdict');
  assert.ok(v.includes('diff <(cat "$REL/$t.migrations")'), 'kayıttaki listeyle karşılaştırılır');
  for (const c of ['NO_RECORD', 'IMAGE_MISSING', 'IMAGE_CHANGED', 'MIGRATION_CHANGED', 'MIGRATION_FAILED', 'DB', 'NO_SOURCE', 'CADDY_INVALID', 'PROBE']) assert.ok(v.includes(c), c);
  // Dosya adına / sürüm numarasına bakılarak uyumluluk VARSAYILMAZ: hedefin kaynağındaki migration klasörleri kararda kullanılmaz
  assert.doesNotMatch(v, /mig_tree|mig_pending|version_of/);
  // Yoklama salt okunur işlemde
  const p = fn('probe_tag');
  assert.ok(p.includes("SET TRANSACTION READ ONLY") && p.includes('findFirst'));
  assert.doesNotMatch(p, /\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/);
  assert.ok(p.includes('compose run --rm --no-deps -T tools node -'), 'betik araca gömülü: eski imajlarda da çalışır');
});

test('gözlem kipi varsayılan; otomatik geçiş yalnızca "otomatik" kip VE güvenli değerlendirmede', () => {
  assert.ok(fn('rollback_mode').includes('= otomatik ]; then echo otomatik; else echo gozlem'));
  const u = fn('post_deploy_unhealthy');
  const call = u.indexOf('do_rollback "$t" otomatik');
  assert.ok(call > 0);
  assert.ok(u.slice(0, call).includes('if [ "$mode" = otomatik ] && [ "$verdict" = SAFE ]; then'));
  assert.equal((sh.match(/do_rollback "\$[a-z]+" otomatik/g) ?? []).length, 1, 'başka otomatik geri dönüş yolu yok');
  assert.ok(!fs.existsSync(new URL('../deploy/systemd/takip-rollback.timer', import.meta.url)));
  // Kipi yalnızca root komutu değiştirir; araç kendisi "otomatik" yazmaz
  assert.equal((sh.match(/atomic_write "\$REL_MODE"/g) ?? []).length, 1);
  assert.ok(fn('cmd_rollback_mode').includes('require_root'));
});

test('yayın açılmazsa önceki sürüme yalnızca migration uygulanmadıysa dönülür', () => {
  const d = fn('deploy_failed');
  assert.ok(d.indexOf('if mig_unchanged_since "$sha"; then') < d.indexOf('revert_release'));
  assert.ok(d.includes('NOT_REVERTED MIGRATION_CHANGED'));
  const pre = fn('predeploy_checks');
  assert.ok(pre.includes('atomic_write "$REL/pre-$sha.migrations"'), 'yayın öncesi durum saklanır');
  assert.ok(pre.includes("PostgreSQL'e erişilemiyor") && pre.includes('yarım kalmış migration'));
  const main = fn('deploy_main');
  assert.ok(main.indexOf('predeploy_checks "$sha"') < main.indexOf('backup_db'), 'yayın öncesi denetim yedek ve migration\'dan önce');
});

test('son sağlıklı kayıt yalnızca tam sağlık denetiminden SONRA yazılır; başarısız yayın üzerine yazmaz', () => {
  const main = fn('deploy_main');
  const health = main.indexOf('if ! release_health "$sha" "$ver" "$edge"; then');
  const record = main.indexOf('release_record "$sha" "$sha" deploy');
  assert.ok(health > 0 && record > health);
  assert.ok(main.slice(health, record).includes('post_deploy_unhealthy "$sha"\n    return 1'));
  for (const name of ['deploy_failed', 'post_deploy_unhealthy']) assert.doesNotMatch(fn(name), /release_record|REL_HEALTHY/, name);
  const h = fn('health_once');
  for (const c of ['APP_DOWN', 'APP_IMAGE', 'WORKER_DOWN', 'WORKER_IMAGE', 'DB', 'MIGRATION_FAILED', 'EDGE', 'VERSION', 'PROBE']) assert.ok(h.includes(c), c);
  assert.ok(fn('release_health').includes('HEALTH_TRIES'), 'sınırlı tekrar');
  const r = fn('release_record');
  for (const k of ['sha=', 'version=', 'tag=', 'app_image=', 'tools_image=', 'deployed_at=', 'verified_at=', 'migrations_count=', 'migrations_sha256=', 'health=', 'source=']) assert.ok(r.includes(`echo "${k}`), k);
  assert.ok(fn('atomic_write').includes('mv -f "$t" "$1"'), 'kayıt geçici dosyadan taşınarak yazılır');
});

test('imaj temizliği son sağlıklı sürümü ve geri dönüş adayını korur; yalnızca takip imajları', () => {
  const p = fn('protected_tags');
  assert.ok(p.includes('REL_HEALTHY') && p.includes('REL_PREV') && p.includes('env_get APP_TAG'));
  const r = fn('release_prune_images');
  assert.ok(r.includes('docker images takip') && r.includes('docker rmi "takip:$t"'));
  const code = sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /docker (system|volume) prune|image prune -a|image prune --all/);
  assert.equal((code.match(/docker rmi /g) ?? []).length, 1, 'imaj silen tek yer');
});

test('kilit: geri dönüş / doğrulama yayın kilidini bekletmeden dener; komutlar yalnızca root', () => {
  for (const name of ['cmd_rollback', 'cmd_release_verify']) {
    const b = fn(name);
    assert.ok(b.indexOf('require_root') < b.indexOf('flock -n 9'), name);
    assert.ok(b.includes('exec 9>"$STATE/deploy.lock"'));
  }
  for (const name of ['cmd_release_status', 'cmd_rollback_status', 'cmd_rollback_check', 'cmd_rollback_mode']) assert.match(fn(name), /^\s+require_root /m, name);
  // Yarıda kalan işlem kilit alındıktan sonra değerlendirilir
  assert.ok(fn('auto_deploy').indexOf('release_recover') > fn('auto_deploy').indexOf('flock -n 9'));
  assert.ok(fn('do_deploy').includes('op_begin deploy') && fn('do_deploy').includes('op_end'));
});

test('alarm: yalnızca sabit metin + bilinen kodlar + sürüm numarası; sır / serbest metin girmez', () => {
  assert.deepEqual(cleanReleaseCodes(['WORKER_DOWN', 'WORKER_DOWN', 'SMTP_PASS=gizli', '__proto__', '']), ['WORKER_DOWN', 'UNKNOWN']);
  assert.equal(cleanVersion('3.92.0; rm -rf /'), '3.92.0');
  const m = renderReleaseAlert({ kind: 'DEPLOY_UNHEALTHY', codes: ['WORKER_DOWN', 'ROLLBACK_SAFE', 'ghp_TOKEN', '<script>'], host: 'srv; rm', from: '3.92.0', to: '3.91.1', mode: 'gozlem', now: NOW });
  assert.match(m.subject, /^\[TAKİP\] Yayın sağlık denetiminden geçmedi — srvrm$/);
  for (const c of ['WORKER_DOWN', 'ROLLBACK_SAFE', 'UNKNOWN']) assert.ok(m.text.includes(RELEASE_CODES[c]) && m.html.includes(c), c);
  assert.ok(m.text.includes('GÖZLEM') && m.text.includes('3.92.0') && m.text.includes('3.91.1'));
  assert.ok(m.text.includes('otomatik olarak yedeğe döndürülmez'));
  for (const s of ['ghp_TOKEN', '<script>', 'rm -rf']) assert.ok(!m.text.includes(s) && !m.html.includes(s), s);
  assert.ok(m.html.includes('gkh-logo@takip'), 'ortak GKH düzeni');
  assert.equal(renderReleaseAlert({ kind: 'BILINMEYEN' }), null);
  for (const k of Object.keys(RELEASE_ALERT_KINDS)) assert.ok(sh.includes(`release_alert ${k}`) || sh.includes(`release_alert "${k}"`), `araç ${k} gönderir`);
});

test('alarm gönderimi: her alıcıya ayrı; biri başarısızsa ötekiler sürer; alıcı yoksa gönderilmez', async () => {
  const sent = [];
  const transport = { sendMail: async (m) => { if (m.to === 'b@x.test') throw new Error('hata'); sent.push(m.to); return {}; } };
  const r = await sendReleaseAlert({ transport, from: 'n@x.test', recipients: ['a@x.test', 'b@x.test', 'c@x.test'], kind: 'ROLLBACK_DONE', fromVersion: '3.92.0', toVersion: '3.91.1', now: NOW });
  assert.deepEqual(sent, ['a@x.test', 'c@x.test']);
  assert.equal(r.code, 'PARTIAL');
  assert.equal((await sendReleaseAlert({ transport, from: 'n', recipients: [], kind: 'ROLLBACK_DONE' })).code, 'NO_RECIPIENTS');
  assert.equal((await sendReleaseAlert({ transport, from: 'n', recipients: ['a@x.test'], kind: 'X' })).code, 'BAD_KIND');
});

test('davranış testleri iş akışına bağlı; betikler sözdizimi ve shellcheck listesinde', () => {
  const wf = read('.github/workflows/deploy-test.yml');
  for (const f of ['deploy/test/release-rollback.sh', 'deploy/test/release-rollback-real.sh']) {
    execFileSync('bash', ['-n', new URL(`../${f}`, import.meta.url).pathname]);
    assert.ok(wf.includes(`bash ${f}`), f);
    assert.match(wf, new RegExp(`shellcheck [^\\n]*${f.replace(/[.]/g, '\\.')}`));
  }
  assert.match(read('deploy/test/release-rollback-real.sh'), /^\[ "\$\{GITHUB_ACTIONS:-\}" = true \] \|\| \{ .*exit 2; \}$/m);
  execFileSync('bash', ['-n', new URL('../deploy/takip.sh', import.meta.url).pathname]);
});
