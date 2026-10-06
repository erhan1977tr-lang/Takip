// Yayın ön sunucuyu (Caddy) da doğrular (karar 142). Buradaki denetimler sunucu aracının (deploy/takip.sh) yapısına
// bakar; davranışın kendisi gerçek Docker + gerçek Caddy + gerçek "takip guncelle" ile deploy/test/caddy-deploy.sh'ta denenir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tool = read('deploy/takip.sh');
/** Bir kabuk işlevinin gövdesi (adı() { … \n}) */
const fn = (name) => {
  const m = new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n([\\s\\S]*?)^\\}$`, 'm').exec(tool);
  assert.ok(m, `${name} işlevi bulunamadı`);
  return m[1];
};
// Gerçek yayın yolu: "yalnızca test / belge değişti" kısa yolundan sonraki bölüm
const whole = fn('do_deploy');
const deploy = whole.slice(whole.indexOf('# Caddyfile bu yayında değişiyor mu'));
assert.ok(deploy.length > 1000 && deploy.length < whole.length);
const at = (s) => { const i = deploy.indexOf(s); assert.ok(i >= 0, `do_deploy içinde yok: ${s}`); return i; };

test('yayın: Caddyfile değiştiyse derleme ve veritabanı adımlarından ÖNCE çalışan Caddy ile doğrulanır', () => {
  // Doğrulama: dosya çalışan kapsayıcıya geçici yola kopyalanır, caddy validate çalışır; yayındaki ayara dokunulmaz
  const v = fn('caddy_validate');
  assert.match(v, /docker exec -i "\$id" sh -c '[^']*caddy validate --config "\$f" --adapter caddyfile[^']*' <"\$1"/);
  assert.match(v, /rm -f "\$f"/);
  assert.doesNotMatch(v, /caddy (reload|run|start|stop)|restart/, 'doğrulama çalışan Caddy\'yi değiştirmez');
  assert.match(v, /return 2; fi/, 'Caddy çalışmıyorsa: denetlenemedi (2), geçersiz (1) değil');
  // Sıra: değişiklik saptanır → kaynak yeni sürüme alınır → doğrulama → derleme → yedek → migration → başlatma
  const order = ['-- deploy/Caddyfile', 'checkout --quiet --force "$sha"', 'caddy_validate "$SRC/deploy/Caddyfile"', 'docker build', 'backup_db', 'compose run --rm tools', 'compose up -d --remove-orphans'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // Geçersizse: önceki kaynağa dönülür, commit "yayınlanamadı" işaretlenir, işlev 1 ile biter — derleme başlamaz
  const invalid = deploy.slice(at('Caddyfile geçersiz') - 200, at('docker build'));
  assert.match(invalid, /checkout --quiet --force "\$prev"\n\s+echo "\$sha" >"\$STATE\/failed"/);
  assert.match(invalid, /return 1/);
  // Yalnızca Caddyfile bu yayında değiştiyse doğrulanır (her yayında değil)
  assert.match(deploy, /if \[ "\$caddy_changed" = 1 \]; then\n\s+verr=\$\(caddy_validate/);
});

test('yayın: uygulama açıldıktan sonra site HTTPS üzerinden, Caddy içinden YENİ sürümle doğrulanır; olmazsa geri dönülür', () => {
  // Denetim sunucunun kendisine, alan adıyla ve HTTPS ile gider; yanıt /surum ve beklenen sürüm
  const e = fn('edge_ok');
  assert.match(e, /curl -fsSk --max-time 10 --resolve "\$domain:443:127\.0\.0\.1" "https:\/\/\$domain\/surum"/);
  assert.match(e, /\\"build\\":\\"\$1\\"/);
  // Sıra: Caddy yeni dosyayla başlatılır → uygulama sağlıklı → site doğrulanır → "yayında" işareti
  const order = ['compose restart caddy', 'wait_healthy 240', 'wait_edge "${TAKIP_EDGE_WAIT:-90}" "$s"', 'echo "$sha" >"$STATE/deployed"'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // Yayından önce yanıt veren site sonra vermiyorsa: başarısız + geri dönüş; önce de vermiyorduysa yalnızca uyarı
  assert.match(deploy, /if edge_ok; then edge_before=1; fi/);
  const failed = deploy.slice(at('elif [ "$edge_before" = 1 ]; then'), at('echo "$sha" >"$STATE/deployed"'));
  assert.match(failed, /revert_release "\$sha" "\$prev" "\$prev_tag" "\$blog" "\$caddy_changed"[\s\S]*return 1\n\s+else\n\s+log "⚠/);
  // Geri dönüş: önceki imaj + önceki kaynak + (Caddyfile değiştiyse) Caddy önceki dosyayla yeniden başlatılır
  const r = fn('revert_release');
  const steps = ['env_set APP_TAG "$prev_tag"', 'checkout --quiet --force "$prev"', 'compose up -d --remove-orphans', 'if [ "$caddy_changed" = 1 ]; then compose restart caddy', 'echo "$sha" >"$STATE/failed"'].map((s) => { const i = r.indexOf(s); assert.ok(i >= 0, s); return i; });
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
  // Uygulama açılmadığında da aynı geri dönüş kullanılır
  assert.equal((deploy.match(/revert_release /g) ?? []).length, 2);
});

test('yayın kaydına Caddy günlüğü yazılmaz; gerçek yayın testi iş akışına bağlı', () => {
  // İstek adresleri depo bağlantısı anahtarı taşıyabilir: Caddy'nin günlük satırları yayın kaydına kopyalanmaz
  assert.doesNotMatch(tool, /compose logs[^\n]*caddy/);
  assert.match(tool, /^caddy_state\(\) \{ docker inspect -f 'durum=\{\{\.State\.Status\}\} yeniden-başlatma=\{\{\.RestartCount\}\}'/m);
  // Sözdizimi ve gerçek yayın testi
  execFileSync('bash', ['-n', path.join(ROOT, 'deploy/takip.sh')]);
  const script = 'deploy/test/caddy-deploy.sh';
  assert.match(read(script), /^\[ "\$\{GITHUB_ACTIONS:-\}" = true \] \|\| \{ .*exit 2; \}$/m);
  execFileSync('bash', ['-n', path.join(ROOT, script)]);
  const wf = read('.github/workflows/deploy-test.yml');
  assert.match(wf, /bash deploy\/test\/caddy-deploy\.sh\b/);
  assert.match(wf, /shellcheck [^\n]*deploy\/test\/caddy-deploy\.sh/);
});
