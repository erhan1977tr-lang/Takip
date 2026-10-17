// Yayın zinciri (karar 289; güvenlik denetimi 3.93.2 Y-1, Y-9, Y-10): CI en az yetkiyle çalışır, yazma yetkili jeton
// npm / uygulama kodu çalışırken yoktur, CI izlenen dala geri yazmaz, üçüncü taraf eylemler tam commit SHA'sıyla
// sabitlenmiştir ve yayın kapısında yazar / konu istisnası yoktur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/demo-env.yml', '.github/workflows/deploy-test.yml'];
const ci = read('.github/workflows/ci.yml');
const [head, writeJob] = ci.split('\n  geri-yaz:\n');
const buildJob = head.slice(head.indexOf('\n  build-test:\n'));

test('her iş akışının üst düzey izni yalnızca okuma; yazma izni yalnızca geri-yaz işinde', () => {
  for (const p of WORKFLOWS) {
    const s = read(p);
    assert.match(s, /^permissions:\n {2}contents: read\n/m, p);
    const writes = s.match(/contents: write/g) || [];
    if (p.endsWith('ci.yml')) {
      assert.equal(writes.length, 1, 'ci.yml: tek yazma izni');
      assert.ok(writeJob.includes('contents: write'), 'yazma izni geri-yaz işinde');
    } else assert.equal(writes.length, 0, p);
  }
  assert.match(buildJob, /\n {4}permissions:\n {6}contents: read\n/);
});

test('test işi jetonu diske bırakmaz ve jetona hiç dokunmaz', () => {
  assert.match(buildJob, /uses: actions\/checkout@[0-9a-f]{40} # v4\n {8}with:\n {10}persist-credentials: false/);
  assert.doesNotMatch(buildJob, /github\.token|secrets\.|x-access-token|git push/);
  for (const p of ['.github/workflows/demo-env.yml', '.github/workflows/deploy-test.yml']) {
    for (const m of read(p).matchAll(/uses: actions\/checkout@\S+[^\n]*\n((?: {8,}.*\n)*)/g)) {
      assert.match(m[1], /persist-credentials: false/, p);
    }
  }
});

test('geri-yaz işi npm / uygulama kodu çalıştırmaz, yalnızca izin verilen yolları yazar, izlenen dala yazmaz', () => {
  assert.ok(writeJob, 'geri-yaz işi var');
  assert.doesNotMatch(writeJob, /\bnpm\b|\bnpx\b|\bnode\b|setup-node|scripts\//);
  assert.match(writeJob, /package-lock\.json \|\| \$f == server\/geo\/ranges\.js \|\| \$f =~ \^prisma\/migrations\/\[0-9\]\{14\}_ci\/migration\\\.sql\$/);
  assert.match(writeJob, /github\.ref_name != 'main' && github\.ref_name != 'backend'/);
  assert.match(writeJob, /needs: build-test/);
  // Test işinde geri yazma / migration üretimi izlenen dalda kapalı
  assert.match(buildJob, /Şema değiştiyse yeni migration üret[^\n]*\n {8}if: github\.ref_name != 'main' && github\.ref_name != 'backend'/);
  assert.match(buildJob, /Üretilen dosyaları ayır[^\n]*\n[^\n]*\n {8}if: github\.event_name == 'push' && github\.ref_name != 'main' && github\.ref_name != 'backend'/);
});

test('bütün üçüncü taraf eylemler tam commit SHA ile sabitlenmiş', () => {
  for (const p of WORKFLOWS) {
    for (const m of read(p).matchAll(/uses:\s*(\S+)/g)) {
      assert.match(m[1], /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${p}: ${m[1]}`);
    }
  }
});

test('bağımlılık taraması CI\'da çalışır', () => {
  assert.match(buildJob, /run: node scripts\/ci-audit\.mjs/);
});

test('yayın kapısında yazar / konu istisnası yok (sahte "CI:" commit\'i atlatamaz)', () => {
  const sh = read('deploy/takip.sh');
  const gate = sh.slice(sh.indexOf('ci_gate() {'), sh.indexOf('install_gate()'));
  assert.doesNotMatch(gate, /github-actions|CI:\*|%ae|%s%x09|is_bot_commit|parents/);
  assert.doesNotMatch(sh, /is_bot_commit/);
});
