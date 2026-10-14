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

test('kapı: CI VE kurulum testi; otomatik yayın yalnızca dal ucu; derleme sonrası uç + kapı yeniden denetlenir', () => {
  const g = fn('gate');
  assert.ok(g.includes('ci=$(ci_gate "$sha" "$b")') && g.includes('inst=$(install_gate "$sha" "$b" "$base")'));
  const a = fn('auto_deploy');
  assert.ok(a.includes('g=$(gate "$head" "$current")'));
  assert.ok(a.includes('do_deploy "$head" "$current" uc'));
  assert.ok(/\*\) info .*return 0 ;;/.test(a), 'success dışı her sonuç: yayın yok');
  const d = fn('do_deploy');
  const first = d.indexOf('head_is "$sha"');
  const second = d.indexOf('head_is "$sha"', first + 1);
  assert.ok(first > 0 && first < d.indexOf('docker build'), 'derlemeden önce uç denetimi');
  assert.ok(second > d.indexOf('docker build') && second < d.indexOf('backup_db'), 'migration / yedekten önce ikinci denetim');
  assert.ok(d.indexOf('[ "$(gate "$sha" "$prev")" != success ]') < d.indexOf('backup_db'));
  assert.ok(fn('first_deploy').includes('auto_deploy'), 'yayında sürüm varken ilk kurulum yolu da yalnızca dal ucu');
});

test('kapı atlanamaz: zamanlayıcı servisi değişkeni vermez; atlama kayda geçer; davranış testi CI\'da', () => {
  assert.ok(!read('deploy/systemd/takip-deploy.service').includes('TAKIP_SKIP_CI_GATE'));
  assert.ok(fn('gate').includes('yayın kapısı ATLANDI'));
  const wf = read('.github/workflows/deploy-test.yml');
  assert.ok(wf.includes('bash deploy/test/deploy-gate.sh'));
  assert.ok(wf.includes('deploy/test/deploy-gate.sh > shellcheck.log'));
});
