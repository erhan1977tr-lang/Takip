// CAD önizleme kaynak tüketimi (karar 289; güvenlik denetimi 3.93.2 Y-2). Zararlı örnekler AYRI bir alt süreçte, kesin
// süre sınırıyla çalıştırılır: düzeltme bozulursa test asılı kalmaz, zaman aşımıyla başarısız olur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { blockBomb, blockCycle, hugeArc, hugeEllipse, hugeHatch } from './fixtures/cad-dos.js';
import { dxfToPreview, CAD_LIMITS, sweepOf } from '../server/cad/dxf.js';
import { createCadGuard, CAD_DETERMINISTIC } from '../server/files/cad-preview.js';

const DXF = new URL('../server/cad/dxf.js', import.meta.url).href;

/** dxfToPreview'i ayrı süreçte çalıştırır → { code: 'OK' | CadError kodu | 'TIMEOUT', ms } */
function isolated(text, timeout = 8000) {
  const script = `import(${JSON.stringify(DXF)}).then((m) => {
    let t = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (t += c)).on('end', () => {
      const s = Date.now();
      try { m.dxfToPreview(t); console.log(JSON.stringify({ code: 'OK', ms: Date.now() - s })); }
      catch (e) { console.log(JSON.stringify({ code: e.code || 'ERROR', ms: Date.now() - s })); }
    });
  });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input: text, timeout, encoding: 'utf8' });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return { code: 'TIMEOUT', ms: timeout };
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

for (const [name, text] of [
  ['ARC 1e17', hugeArc()],
  ['ARC -1e300 → 1e300', hugeArc('-1e300', '1e300')],
  ['ARC 1e308', hugeArc('1e308', '-1e308')],
  ['ELLIPSE 1e17', hugeEllipse()],
  ['HATCH yay kenarı 1e17', hugeHatch(2)],
  ['HATCH elips kenarı 1e17', hugeHatch(3)],
]) {
  test(`çok büyük açı sonsuz döngüye girmez: ${name}`, () => {
    const r = isolated(text);
    assert.notEqual(r.code, 'TIMEOUT');
    assert.ok(['OK', 'INVALID'].includes(r.code), r.code);
    assert.ok(r.ms < 2000, `${r.ms} ms`);
  });
}

test('iç içe blok bombası (10^16 genişletme, çıktısız) hızla TOO_COMPLEX', () => {
  const text = blockBomb(16, 10);
  assert.ok(text.length < 8000, `küçük dosya (${text.length} bayt)`);
  const r = isolated(text);
  assert.equal(r.code, 'TOO_COMPLEX');
  assert.ok(r.ms < 3000, `${r.ms} ms`);
});

test('iş bütçesi: sınırın altındaki iç içe çizim çalışır, üstü TOO_COMPLEX', () => {
  assert.ok(CAD_LIMITS.work >= 1_000_000 && CAD_LIMITS.work <= 20_000_000);
  // 10^4 boş genişletme: bütçenin çok altında
  assert.equal(isolated(blockBomb(4, 10)).code, 'OK');
  assert.equal(isolated(blockBomb(8, 10)).code, 'TOO_COMPLEX');
});

test('döngüsel blok başvurusu çizilmez, bildirilir; sonsuza gitmez', () => {
  const out = dxfToPreview(blockCycle());
  assert.ok(out.notes.unsupported.BLOCK_CYCLE >= 1);
  assert.ok(out.paths.length >= 1);
});

test('yay açıklığı (sweep) eski döngüyle aynı sonucu verir (olağan açılar)', () => {
  const TAU = Math.PI * 2;
  const old = (a0, a1) => {
    while (a1 <= a0) a1 += TAU;
    return a1 - a0;
  };
  let seed = 7;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647 - 0.5) * 40;
  for (let i = 0; i < 5000; i++) {
    const a0 = rnd();
    const a1 = rnd();
    // Tam TAU katı farkta eski döngü kayan nokta gürültüsüyle ~0 da verebilir; bu durum aşağıda ayrıca denetlenir
    if (Math.abs(((a0 - a1) / TAU) - Math.round((a0 - a1) / TAU)) < 1e-9) continue;
    assert.ok(Math.abs(sweepOf(a0, a1) - old(a0, a1)) < 1e-9, `${a0} ${a1}`);
  }
  // Başlangıç = bitiş (ya da tam tur farkı): tam daire
  assert.equal(sweepOf(0, 0), TAU);
  assert.equal(sweepOf(TAU, 0), TAU);
  assert.equal(sweepOf(0, TAU), TAU);
  assert.throws(() => sweepOf(Number.NaN, 0), { code: 'INVALID' });
});

// ---------- hizmet koruması (server/files/cad-preview.js → createCadGuard) ----------

test('olumsuz önbellek: zararlı dosya bir kez dönüştürülür, sonra hizmete gitmeden aynı kod', async () => {
  let t = 1000;
  const g = createCadGuard({ now: () => t });
  let calls = 0;
  const run = async () => { calls++; return { ok: false, code: 'TOO_COMPLEX' }; };
  assert.equal((await g.run({ key: 'f1', userId: 'u1', run })).code, 'TOO_COMPLEX');
  for (let i = 0; i < 50; i++) assert.equal((await g.run({ key: 'f1', userId: `u${i}`, run })).code, 'TOO_COMPLEX');
  assert.equal(calls, 1);
  t += 31 * 60_000; // süre dolunca yeniden denenir
  await g.run({ key: 'f1', userId: 'u1', run });
  assert.equal(calls, 2);
  assert.ok(CAD_DETERMINISTIC.includes('TIMEOUT'));
});

test('geçici hatalar (meşgul / ulaşılamıyor) önbelleğe alınmaz', async () => {
  const g = createCadGuard();
  let calls = 0;
  for (const code of ['BUSY', 'UNAVAILABLE']) {
    const run = async () => { calls++; return { ok: false, code }; };
    await g.run({ key: code, userId: 'u', run });
    await g.run({ key: code, userId: 'u', run });
  }
  assert.equal(calls, 4);
  assert.equal(g.negativeSize(), 0);
});

test('kullanıcı başına tek eşzamanlı dönüştürme; başka kullanıcı etkilenmez; aynı dosya ortak iş', async () => {
  const g = createCadGuard();
  let release;
  const slow = () => new Promise((r) => { release = () => r({ ok: true, json: '{}' }); });
  let calls = 0;
  const run = () => { calls++; return slow(); };
  const a = g.run({ key: 'f1', userId: 'kotu', run });
  assert.equal((await g.run({ key: 'f2', userId: 'kotu', run: async () => ({ ok: true, json: '{}' }) })).code, 'BUSY');
  const shared = g.run({ key: 'f1', userId: 'baska', run });
  const other = await g.run({ key: 'f3', userId: 'baska', run: async () => ({ ok: true, json: '{"x":1}' }) });
  assert.equal(other.ok, true);
  release();
  assert.equal((await a).ok, true);
  assert.equal((await shared).ok, true);
  assert.equal(calls, 1);
  // iş bitince aynı kullanıcı yeniden dönüştürebilir
  assert.equal((await g.run({ key: 'f4', userId: 'kotu', run: async () => ({ ok: true, json: '{}' }) })).ok, true);
});

test('kullanıcı başına dönüştürme sınırı (önbellekten dönenler sayılmaz)', async () => {
  const g = createCadGuard({ limits: { convertLimit: 3 } });
  const ok = async () => ({ ok: false, code: 'INVALID' });
  for (let i = 0; i < 3; i++) assert.equal((await g.run({ key: `k${i}`, userId: 'u', run: ok })).code, 'INVALID');
  assert.equal((await g.run({ key: 'k9', userId: 'u', run: ok })).code, 'PREVIEW_LIMIT');
  // önbellekteki olumsuz sonuç sınırı tüketmez
  assert.equal((await g.run({ key: 'k0', userId: 'u', run: ok })).code, 'INVALID');
});

test('çalışma hata fırlatırsa kullanıcı kilidi bırakılır', async () => {
  const g = createCadGuard();
  await assert.rejects(g.run({ key: 'x', userId: 'u', run: async () => { throw new Error('ağ'); } }));
  assert.equal((await g.run({ key: 'y', userId: 'u', run: async () => ({ ok: true, json: '{}' }) })).ok, true);
});
