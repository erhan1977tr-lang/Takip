// Yayın kapısı (deploy/takip.sh, karar 276): yalnızca izlenen dalın (backend) KENDİ GitHub koşuları sayılır; sunucu kurulum
// testinin yolları iş akışındaki "paths" ile aynı; zamanlayıcı kapıyı atlamaz; davranış testi deploy/test/deploy-gate.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sh = read('deploy/takip.sh');
const fn = (name) => {
  const i = sh.indexOf(`\n${name}() {`);
  assert.ok(i >= 0, `${name} yok`);
  return sh.slice(i, sh.indexOf('\n}\n', i) + 3);
};

test('kurulum testi yolları deploy-test.yml "paths" listesiyle aynı', () => {
  const wf = read('.github/workflows/deploy-test.yml');
  const block = wf.slice(wf.indexOf('paths:'), wf.indexOf('workflow_dispatch'));
  const paths = [...block.matchAll(/- '([^']+)'/g)].map((m) => m[1].replace(/\/\*\*$/, '')).sort();
  const m = sh.match(/^INSTALL_TEST_PATHS=\(([^)]*)\)$/m);
  assert.ok(m, 'INSTALL_TEST_PATHS');
  assert.deepEqual(m[1].trim().split(/\s+/).sort(), paths);
  assert.match(sh, /^CI_WORKFLOW_PATH=\.github\/workflows\/ci\.yml$/m);
  assert.match(sh, /^INSTALL_WORKFLOW_PATH=\.github\/workflows\/deploy-test\.yml$/m);
  assert.ok(fs.existsSync(new URL('../.github/workflows/ci.yml', import.meta.url)));
});

test('demo testi yolları demo-env.yml "paths" listesiyle aynı (karar 287)', () => {
  const wf = read('.github/workflows/demo-env.yml');
  const block = wf.slice(wf.indexOf('paths:'), wf.indexOf('workflow_dispatch'));
  const paths = [...block.matchAll(/- '([^']+)'/g)].map((m) => m[1].replace(/\/\*\*$/, '')).sort();
  const m = sh.match(/^DEMO_TEST_PATHS=\(([^)]*)\)$/m);
  assert.ok(m, 'DEMO_TEST_PATHS');
  assert.deepEqual(m[1].trim().split(/\s+/).sort(), paths);
  assert.match(sh, /^DEMO_WORKFLOW_PATH=\.github\/workflows\/demo-env\.yml$/m);
});

test('koşu kimliği: commit + dal + push + iş akışı yolu + depo; en yeni koşu; yalnızca "success" başarı', () => {
  const r = fn('run_state');
  assert.ok(r.includes('/actions/runs?head_sha=$sha&branch=$b&event=push'), 'API sorgusu dal / olay süzer');
  for (const s of ['.head_sha == $s', '.head_branch == $b', '.event == "push"', '.path == $p', '.repository.full_name', '.head_repository.full_name'])
    assert.ok(r.includes(s), `istemci tarafı süzgeç: ${s}`);
  assert.ok(r.includes('sort_by(.created_at, .run_number) | last'));
  assert.ok(r.includes('elif [ "$co" = success ]; then echo success'));
  assert.ok(!/select\(\.name ==/.test(sh), 'ada göre seçim kalmadı');
  assert.ok(!/CI_WORKFLOW=CI/.test(sh));
});

test('kapı: CI VE kurulum testi VE demo testi; otomatik yayın yalnızca dal ucu; derleme sonrası uç + kapı yeniden denetlenir', () => {
  const g = fn('gate');
  assert.ok(g.includes('ci=$(ci_gate "$sha" "$b")') && g.includes('inst=$(install_gate "$sha" "$b" "$base")'));
  assert.ok(g.includes('demo_gate "$sha" "$b" "$base"'), 'demo testi de kapının parçası');
  assert.ok(g.indexOf('install_gate') < g.indexOf('demo_gate'));
  const a = fn('auto_deploy');
  assert.ok(a.includes('g=$(gate "$head" "$current")'));
  assert.ok(a.includes('do_deploy "$head" "$current" uc'));
  assert.ok(/\*\) info .*return 0 ;;/.test(a), 'success dışı her sonuç: yayın yok');
  const w = fn('do_deploy');
  assert.ok(w.indexOf('head_is "$sha"') > 0 && w.indexOf('head_is "$sha"') < w.indexOf('deploy_main'), 'derlemeden önce uç denetimi');
  const d = fn('deploy_main');
  const second = d.indexOf('head_is "$sha"');
  assert.ok(second > d.indexOf('docker build') && second < d.indexOf('backup_db'), 'migration / yedekten önce ikinci denetim');
  assert.ok(d.indexOf('[ "$(gate "$sha" "$prev")" != success ]') < d.indexOf('backup_db'));
  // Derlenen kaynak ve imaj onaylanan commit'in kendisi (karar 287)
  assert.ok(d.includes('rev-parse HEAD') && d.indexOf('rev-parse HEAD') < d.indexOf('docker build'));
  assert.ok(d.includes('image_git_sha "takip:$sha"') && d.indexOf('image_git_sha') < d.indexOf('backup_db'));
  assert.ok(fn('first_deploy').includes('auto_deploy'), 'yayında sürüm varken ilk kurulum yolu da yalnızca dal ucu');
});

test('kapı atlanamaz: zamanlayıcı servisi değişkeni vermez; atlama kayda geçer; davranış testi CI\'da', () => {
  assert.ok(!read('deploy/systemd/takip-deploy.service').includes('TAKIP_SKIP_CI_GATE'));
  assert.ok(fn('gate').includes('yayın kapısı ATLANDI'));
  const wf = read('.github/workflows/deploy-test.yml');
  assert.ok(wf.includes('bash deploy/test/deploy-gate.sh'));
  assert.match(wf, /shellcheck [^\n]*deploy\/test\/deploy-gate\.sh /);
});

test('testten geçmeyen commit yayın başarısızlığı sayılmaz; yeniden çalıştırma başarılıysa aynı commit yayınlanır (karar 291)', () => {
  const a = fn('auto_deploy');
  const fail = a.slice(a.indexOf('    failure)'), a.indexOf('    *) info'));
  assert.ok(!fail.includes('$STATE/failed'), 'kapı başarısızlığı $STATE/failed\'a yazılmaz');
  assert.ok(fail.includes('"$STATE/gate-failed"'), 'kapı başarısızlığı ayrı kayıtta');
  assert.ok(a.includes('success) rm -f "$STATE/gate-failed"'), 'başarılı kapı kaydı temizler');
  // Gerçek yayın başarısızlığı (do_deploy / sağlık / geri dönüş) yine yeni commit gelene dek korunur
  assert.ok(a.indexOf('"$(cat "$STATE/failed"') < a.indexOf('g=$(gate "$head" "$current")'));
  assert.ok(fn('do_deploy').length > 0);
  // Koşunun EN SON denemesi değerlendirilir: GitHub listesi aynı koşuyu son denemeyle döndürür; yalnızca success başarı
  assert.ok(fn('run_state').includes('if [ "$st" != completed ]; then echo pending'));
  const t = read('deploy/test/deploy-gate.sh');
  for (const s of ['ilk deneme başarısız', 'yeniden çalıştırma sürüyor', 'yeniden çalıştırma da başarısız', 'yeniden çalıştırma başarılı', 'API hatası', 'çalışma dalında / PR\'da / başka commit\'te'])
    assert.ok(t.includes(s), `davranış testi: ${s}`);
});
