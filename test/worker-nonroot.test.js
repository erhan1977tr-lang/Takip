// İşçi (worker) root değil (SEC-12, karar 137) ve ayrıcalıksız (karar 138: cap_drop ALL + no-new-privileges, yalnızca
// işçide): sunucu düzeninin (deploy/docker-compose.yml) kuralları ve yükleme biriminin sahipliğini düzelten tek seferlik
// servisin (uploads-init) komutu.
// Gerçek Docker ile uçtan uca deneme: deploy/test/worker-nonroot.sh (.github/workflows/deploy-test.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const compose = read('deploy/docker-compose.yml');

/** Bir servisin tanımı (yorum satırları olmadan). */
function service(name) {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start > 0, `${name} servisi tanımlı`);
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}[^\s#]/.test(line)) break;
    if (!/^\s*#/.test(line)) out.push(line);
  }
  return out.join('\n');
}
const SERVICES = ['db', 'app', 'uploads-init', 'worker', 'clamav', 'tools', 'caddy'];

test('işçi uygulamanın kullanıcısıyla (1001:1001) çalışır; imajı (tools) aynı kalır', () => {
  const worker = service('worker');
  assert.match(worker, /^ {4}user: "1001:1001"$/m);
  assert.match(worker, /^ {4}image: .*-tools$/m, 'işçi tools imajını kullanmaya devam eder');
  assert.match(worker, /^ {4}command: \["node", "scripts\/worker\.mjs"\]$/m);
  assert.match(worker, /^ {6}- uploads:\/data\/uploads$/m);
  // Uygulamanın kullanıcısı da 1001: imajda tanımlı (Dockerfile, runner aşaması)
  const dockerfile = read('Dockerfile');
  const runner = dockerfile.slice(dockerfile.indexOf('FROM base AS runner'));
  assert.match(runner, /groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app/);
  assert.match(runner, /^USER app$/m);
});

test('tools imajı ve servisi değişmedi: migration / yönetim / yedek komutları root kalır', () => {
  assert.doesNotMatch(service('tools'), /\buser:/);
  const dockerfile = read('Dockerfile');
  const tools = dockerfile.slice(dockerfile.indexOf('FROM builder AS tools'), dockerfile.indexOf('FROM base AS runner'));
  assert.doesNotMatch(tools, /^USER /m, 'tools aşamasında kullanıcı tanımlanmaz');
  // Kullanıcı yalnızca işçide ve sahiplik servisinde tanımlı
  for (const name of SERVICES) {
    const has = /^ {4}user:/m.test(service(name));
    assert.equal(has, name === 'worker' || name === 'uploads-init', `${name}: user`);
  }
});

test('işçi, sahiplik servisi tamamlanmadan başlamaz', () => {
  const worker = service('worker');
  assert.match(worker, /^ {6}uploads-init:\n {8}condition: service_completed_successfully$/m);
  assert.match(worker, /^ {6}db:\n {8}condition: service_healthy$/m);
  // Uygulama sahiplik servisini beklemez (sitenin açılması ona bağlı değildir)
  assert.doesNotMatch(service('app'), /uploads-init/);
});

test('sahiplik servisi: root, ağsız, yalnızca yükleme birimi; gizli ayar ya da port almaz', () => {
  const init = service('uploads-init');
  assert.match(init, /^ {4}user: "0:0"$/m);
  assert.match(init, /^ {4}network_mode: none$/m);
  assert.match(init, /^ {4}restart: "no"$/m);
  assert.doesNotMatch(init, /env_file|environment:|ports:|depends_on|privileged|cap_add/);
  const volumes = init.slice(init.indexOf('    volumes:')).split('\n').filter((l) => /^ {6}- /.test(l));
  assert.deepEqual(volumes, ['      - uploads:/data/uploads']);
  // Uygulamanın imajı (tools değil): içinde yalnızca çalışan uygulama var
  assert.match(init, /^ {4}image: \$\{APP_IMAGE:-[^}]+\}:\$\{APP_TAG:-latest\}$/m);
});

/** uploads-init komutu: Compose kaçışları ($$) çözülmüş kabuk betiği. */
function initScript() {
  const init = service('uploads-init');
  const at = init.indexOf('      - |\n');
  assert.ok(at > 0, 'komut blok olarak yazılı');
  const body = [];
  for (const line of init.slice(at).split('\n').slice(1)) {
    if (!line.startsWith('        ')) break;
    body.push(line.slice(8));
  }
  return body.join('\n').replaceAll('$$', '$');
}

test('sahiplik komutu yalnızca sahiplik değiştirir: silme / taşıma / izin / içerik yok, bağlantı izlenmez, birimin dışına çıkılmaz', () => {
  const script = initScript();
  assert.match(script, /find \/data\/uploads -xdev ! \\\( -uid 1001 -gid 1001 \\\) -exec chown -h 1001:1001 \{\} \+ -print/);
  assert.match(script, /\nexit 0$/, 'her durumda 0 ile biter (sahiplik sorunu yayını durdurmaz)');
  for (const banned of [/\brm\b/, /\bmv\b/, /-delete/, /\bchmod\b/, /\bcp\b/, /\btruncate\b/, /\bdd\b/, /\btar\b/, / -L\b/, /[^-]>/, /\bchown -R\b/]) {
    assert.doesNotMatch(script, banned, `komutta olmamalı: ${banned}`);
  }
  // Yalnızca yükleme birimi adı geçer
  assert.deepEqual([...new Set(script.match(/\/[a-z][\w/.-]*/g))], ['/data/uploads']);
});

test('sahiplik komutu çalışır: düzeltilecek kayıt yoksa hiçbir şeye dokunmaz; (root ile) yalnızca sahipliği değiştirir', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-uploads-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '2026/10'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.karantina'));
  fs.writeFileSync(path.join(dir, '2026/10/depo.pdf'), '%PDF-1.4 depo');
  fs.writeFileSync(path.join(dir, '2026/10/gizli.pdf'), 'gizli', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, '.karantina/2026_10_virus'), 'virus');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-disari-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'hedef'), 'birimin dışı');
  fs.symlinkSync(path.join(outside, 'hedef'), path.join(dir, '2026/10/baglanti'));

  const me = process.getuid();
  const isRoot = me === 0;
  // Testte hedef kullanıcı: root ile çalışırken 1001 (gerçek değer); değilse testi çalıştıran kullanıcı (chown gerekmez)
  const [uid, gid] = isRoot ? [1001, 1001] : [me, process.getgid()];
  const script = initScript().replaceAll('/data/uploads', dir).replaceAll('1001:1001', `${uid}:${gid}`).replaceAll('-uid 1001 -gid 1001', `-uid ${uid} -gid ${gid}`);
  const run = () => execFileSync('sh', ['-c', script], { encoding: 'utf8' });
  const all = () => ['', '2026', '2026/10', '2026/10/depo.pdf', '2026/10/gizli.pdf', '2026/10/baglanti', '.karantina', '.karantina/2026_10_virus'];
  const snapshot = (withOwner) =>
    all().map((p) => {
      const s = fs.lstatSync(path.join(dir, p));
      return [p, s.mode, s.isFile() ? s.size : 0, s.isDirectory() ? 0 : s.mtimeMs, withOwner ? `${s.uid}:${s.gid}` : '', withOwner ? s.ctimeMs : 0].join('|');
    });
  const foreign = () => all().filter((p) => { const s = fs.lstatSync(path.join(dir, p)); return s.uid !== uid || s.gid !== gid; });

  if (isRoot) {
    // Eski sürümlerden kalan durum: root'a ait dosyalar / klasörler / bağlantı; biri yalnızca grubuyla farklı
    fs.chownSync(path.join(dir, '2026/10/depo.pdf'), uid, 0);
    const before = snapshot(false);
    const target = fs.statSync(path.join(outside, 'hedef'));
    assert.equal(foreign().length, all().length);
    const out = run();
    assert.match(out, new RegExp(`yapılan kayıt: ${all().length}\\n$`));
    assert.doesNotMatch(out, /UYARI/);
    assert.deepEqual(foreign(), [], 'hiçbir kayıt başka kullanıcıda kalmadı');
    assert.deepEqual(snapshot(false), before, 'tür, izin, boyut, değişiklik zamanı aynı');
    assert.equal(fs.readFileSync(path.join(dir, '2026/10/depo.pdf'), 'utf8'), '%PDF-1.4 depo');
    assert.equal(fs.readlinkSync(path.join(dir, '2026/10/baglanti')), path.join(outside, 'hedef'));
    const after = fs.statSync(path.join(outside, 'hedef'));
    assert.deepEqual([after.uid, after.gid, after.ctimeMs], [target.uid, target.gid, target.ctimeMs], 'bağlantının hedefine (birimin dışı) dokunulmadı');
  }
  // Yinelenebilir: düzeltilecek kayıt yokken hiçbir chown yapılmaz (ctime dahil hiçbir şey değişmez)
  const before = snapshot(true);
  const out = run();
  assert.match(out, /yapılan kayıt: 0\n$/);
  assert.deepEqual(snapshot(true), before);
  assert.equal(fs.readdirSync(dir, { recursive: true }).length, all().length - 1, 'kayıt eklenmedi / silinmedi');
});

test('işçi ayrıcalıksız: bütün yetenekler bırakılır, no-new-privileges açık, kullanıcı 1001:1001 kalır (karar 138)', () => {
  const worker = service('worker');
  assert.match(worker, /^ {4}user: "1001:1001"$/m);
  assert.match(worker, /^ {4}cap_drop:\n {6}- ALL\n {4}\S/m, 'cap_drop yalnızca ALL');
  assert.match(worker, /^ {4}security_opt:\n {6}- no-new-privileges:true\n {4}\S/m, 'security_opt yalnızca no-new-privileges');
  assert.doesNotMatch(worker, /cap_add|privileged|seccomp|apparmor|unconfined/);
});

test('ayrıcalık ayarı YALNIZCA işçide: diğer servisler ve kaynak sınırları bu kararda değişmedi', () => {
  for (const name of SERVICES) {
    const def = service(name);
    assert.equal(/^ {4}cap_drop:/m.test(def), name === 'worker', `${name}: cap_drop`);
    assert.equal(/^ {4}security_opt:/m.test(def), name === 'worker', `${name}: security_opt`);
    assert.doesNotMatch(def, /cap_add|privileged:|read_only:|tmpfs:/, `${name}: başka ayrıcalık ayarı yok`);
    // Kaynak sınırı (bellek / işlemci / süreç sayısı) bu kararın kapsamında değil
    assert.doesNotMatch(def, /mem_limit|memswap_limit|cpus:|cpu_shares|pids_limit|ulimits:|deploy:/, `${name}: kaynak sınırı yok`);
  }
  const body = compose.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.equal(body.match(/cap_drop/g).length, 1);
  assert.equal(body.match(/no-new-privileges/g).length, 1);
});

test('sunucu aracı: geri yükleme dosyaları yine 1001:1001 yapar; durum satırı yalnızca okur', () => {
  const takip = read('deploy/takip.sh');
  assert.equal(takip.match(/tar -xzpf .* -C \/u && chown -R 1001:1001 \/u/g)?.length, 2, 'geri yükleme ve geri alma: sahiplik 1001');
  const status = takip.slice(takip.indexOf('worker_status() {'), takip.indexOf('cmd_status() {'));
  assert.ok(status.length > 100);
  assert.doesNotMatch(status, /\bchown\b|\brm\b|\bmv\b|chmod|compose (up|run|stop|restart)|docker (run|exec|rm)/);
  // Sunucu aracında başka sahiplik değişikliği yok (düzeltme yalnızca uploads-init'te)
  assert.equal(takip.match(/\bchown\b/g).length, 2);
});

test('test betikleri üretim imajına girmez ve yalnızca kurulum testinde çalışır', () => {
  assert.match(read('.dockerignore'), /^deploy\/test$/m);
  const fixtures = read('deploy/test/worker-fixtures.mjs');
  assert.match(fixtures, /process\.env\.TAKIP_TEST_FIXTURES !== '1'/);
  assert.match(fixtures, /localhost/);
  assert.match(fixtures, /depo@kurulum\.test/, 'depo alıcısı deneme adresi');
  assert.match(read('deploy/test/worker-nonroot.sh'), /^\[ "\$\{GITHUB_ACTIONS:-\}" = true \] \|\| \{ .*exit 2; \}$/m);
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'deploy/test/worker-fixtures.mjs')]);
  execFileSync('bash', ['-n', path.join(ROOT, 'deploy/test/worker-nonroot.sh')]);
});
