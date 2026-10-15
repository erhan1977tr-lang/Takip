// Güvenli dosya önizlemesi (karar 283): DXF ayrıştırıcı, dönüştürücü raporu, içerik kararı (MIME taklidi), CAD hizmeti
// (sahte dwg2dxf ile: süre / eşzamanlılık / boyut sınırı, geçici dosya temizliği, dosya adının komuta girmemesi),
// iç istemci ve önbellek, yapı denetimleri (aynı erişim kuralı, kısıtlı kapsayıcı, sabit LibreDWG sürümü).
// Ağ yalnızca 127.0.0.1; gerçek DWG örnekleri sunucu kurulum testinde (deploy/test/cad-preview.sh).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CAD_LIMITS, CadError, converterReport, dxfToPreview, mergeConverterReport, mtextPlain } from '../server/cad/dxf.js';
import { aciColor, trueColor } from '../server/cad/aci.js';
import { decodeDxf, run as runCli } from '../server/cad/dxf-cli.mjs';
import { createCadService, sniff } from '../server/cad/service.mjs';
import { PREVIEW_LIMITS, PREVIEW_ROUTE_KINDS, previewCode, previewDecision, previewFamily, sniffContent } from '../server/files/preview.js';
import { createCadCache, cadCacheKey, requestCadPreview } from '../server/files/cad-preview.js';
import { arc, circle, dimension, dxf, insert, line, lwpoly, mtext, paperLine, raw, text } from './fixtures/cad.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------------------------------------------------
// DXF ayrıştırıcı
// ---------------------------------------------------------------------------------------------------------------------

test('DXF: çizgi, daire, yay, katman rengi / görünürlüğü, birim ve sürüm dosyadan; kapsam hesaplanır', () => {
  const d = dxfToPreview(dxf({
    insunits: 4,
    layers: [{ name: 'CAM', color: 1 }, { name: 'GIZLI', color: 3, frozen: true }, { name: 'KAPALI', color: -5 }],
    entities: [line(0, 0, 10, 0, 'CAM'), circle(5, 5, 2, 'GIZLI'), arc(0, 0, 10, 0, 90, 'KAPALI')],
  }));
  assert.equal(d.version, 'AC1015');
  assert.equal(d.units, 'mm');
  assert.deepEqual(d.layers.map((l) => [l.name, l.color, l.on]), [['CAM', '#ff0000', true], ['GIZLI', '#00ff00', false], ['KAPALI', '#0000ff', false]]);
  assert.equal(d.paths.length, 3);
  const [ln, ci, ar] = d.paths;
  assert.deepEqual(ln[3], [[0, 0, 10, 0]]);
  // Daire kapalı, her nokta merkeze 2 uzaklıkta
  assert.equal(ci[2] & 1, 1);
  for (let k = 0; k < ci[3][0].length; k += 2) assert.ok(close(Math.hypot(ci[3][0][k] - 5, ci[3][0][k + 1] - 5), 2, 1e-3));
  // Yay 0° → 90°: (10,0) → (0,10)
  const a = ar[3][0];
  assert.ok(close(a[0], 10) && close(a[1], 0) && close(a.at(-2), 0, 1e-3) && close(a.at(-1), 10));
  assert.deepEqual(d.extents, [0, 0, 10, 10]);
  assert.deepEqual(d.notes, { unsupported: {}, partial: {}, paperSpace: 0 });
});

test('DXF: şişkinlikli polyline yarım daire çizer; blok ekleme ölçek + dönme + taban noktasıyla doğru konumlanır', () => {
  const d = dxfToPreview(dxf({
    blocks: [{ name: 'KARE', base: [1, 1], entities: [line(1, 1, 2, 1), line(2, 1, 2, 2)] }],
    entities: [lwpoly([[0, 0], [10, 0]], { bulges: [1] }), insert('KARE', 100, 100, { sx: 10, sy: 10, rot: 90 })],
  }));
  const poly = d.paths[0][3][0];
  // bulge 1 = yarım daire: orta nokta merkezden (5,0) 5 uzakta ve y = −5 (saat yönünün tersi, sağa doğru)
  for (let k = 0; k < poly.length; k += 2) assert.ok(close(Math.hypot(poly[k] - 5, poly[k + 1]), 5, 1e-3));
  assert.ok(poly.some((v, k) => k % 2 === 1 && close(v, -5, 1e-3)));
  // Bloktaki (1,1)→(2,1): taban (1,1) çıkarılır → (0,0)→(1,0), ×10 → (0,0)→(10,0), 90° → (0,0)→(0,10), +(100,100)
  assert.deepEqual(d.paths[1][3][0].map((v) => Math.round(v * 1000) / 1000), [100, 100, 100, 110]);
  assert.deepEqual(d.paths[2][3][0].map((v) => Math.round(v * 1000) / 1000), [100, 110, 90, 110]);
});

test('DXF: yazı (TEXT / MTEXT biçim kodları temizlenir), ölçülendirme bloğu çizilir; desteklenmeyen nesne ve kağıt alanı bildirilir', () => {
  const d = dxfToPreview(dxf({
    blocks: [{ name: '*D1', entities: [line(0, 0, 50, 0), text(20, 2, 2.5, '50')] }],
    entities: [
      text(1, 2, 3, 'Ø10 %%c12 %%d'), mtext(0, 20, 2, '\\fArial|b1;Cam\\Pkalınlığı {\\C1;8 mm}'),
      dimension('*D1'), dimension('*YOK'), raw('3DSOLID'), raw('MULTILEADER'), paperLine(0, 0, 1, 1),
    ],
  }));
  assert.deepEqual(d.texts.map((t) => t[6]), ['Ø10 Ø12 °', 'Cam\nkalınlığı 8 mm', '50']);
  assert.equal(d.paths.length, 1, 'ölçü çizgisi bloktan');
  assert.deepEqual(d.notes.unsupported, { DIMENSION: 1, '3DSOLID': 1, MULTILEADER: 1 });
  assert.equal(d.notes.paperSpace, 1);
  assert.equal(mtextPlain('A\\~B\\PC'), 'A B\nC');
});

test('DXF: aynı adla birden çok blok tahmin edilmez (çizilmeyen sayılır); blok döngüsü ve dizi sınırı', () => {
  const dup = dxfToPreview(dxf({
    blocks: [{ name: '*D', entities: [line(0, 0, 1, 0)] }, { name: '*D', entities: [line(0, 0, 9, 9)] }],
    entities: [dimension('*D'), dimension('*D')],
  }));
  assert.equal(dup.paths.length, 0);
  assert.deepEqual(dup.notes.unsupported, { DIMENSION: 2 });
  const cyc = dxfToPreview(dxf({ blocks: [{ name: 'A', entities: [insert('B', 0, 0)] }, { name: 'B', entities: [insert('A', 0, 0), line(0, 0, 1, 1)] }], entities: [insert('A', 0, 0)] }));
  assert.equal(cyc.notes.unsupported.BLOCK_CYCLE, 1);
  const big = [[0, 'INSERT'], [8, '0'], [2, 'B'], [10, 0], [20, 0], [70, 200], [71, 200], [44, 1], [45, 1]];
  assert.throws(() => dxfToPreview(dxf({ blocks: [{ name: 'B', entities: [line(0, 0, 1, 0)] }], entities: [big] })), (e) => e instanceof CadError && e.code === 'TOO_COMPLEX');
});

test('DXF: bozuk / sahte girdiler sabit kodla reddedilir', () => {
  const code = (fn) => { try { fn(); return 'OK'; } catch (e) { return e instanceof CadError ? e.code : `HATA ${e}`; } };
  assert.equal(code(() => dxfToPreview('AutoCAD Binary DXF\r\n\x1a\x00')), 'BINARY_DXF');
  assert.equal(code(() => dxfToPreview('<html><script>alert(1)</script>')), 'NOT_DXF');
  assert.equal(code(() => dxfToPreview('  0\nLINE\n  8\n0\n')), 'NOT_DXF');
  assert.equal(code(() => dxfToPreview('  0\nSECTION\n  2\nENTITIES\n  0\nLINE\nxx\n1\n')), 'INVALID');
  assert.equal(code(() => dxfToPreview('  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n 10\nNaN\n 20\n0\n 11\n1\n 21\n1\n')), 'INVALID');
  assert.equal(code(() => dxfToPreview(/** @type {any} */ (null))), 'INVALID');
  // Boş çizim: kapsam yok, hata değil
  assert.equal(dxfToPreview(dxf()).extents, null);
  // Sınırlar sabit
  assert.ok(CAD_LIMITS.primitives > 0 && CAD_LIMITS.bytes > 0);
});

test('DXF: UTF-8 (R2007+) ve Windows-1252 (eski) çözülür; ACI / gerçek renk', () => {
  assert.equal(decodeDxf(Buffer.from('Çeliş', 'utf8')), 'Çeliş');
  assert.equal(decodeDxf(Buffer.from([0xc7, 0x61, 0xf0])), 'Çað');
  assert.equal(aciColor(1), '#ff0000');
  assert.equal(aciColor(7), '#ffffff');
  assert.equal(aciColor(10), '#ff0000');
  assert.equal(aciColor(0), null);
  assert.equal(aciColor(256), null);
  assert.equal(trueColor(0x123456), '#123456');
  assert.equal(trueColor(-1), null);
});

test('dönüştürücü raporu: düşürülen tür yalnızca DXF\'te yoksa "çizilmeyen" olur; önizleme resmi hataları sayılmaz', () => {
  const stderr = [
    'Warning: Unhandled Class entity 528 ACAD_TABLE (0x401) 31/1A',
    'Warning: Unhandled Class entity 528 ACAD_TABLE (0x401) 31/0',
    'Warning: Unhandled Class entity 528 ACAD_TABLE (0x401) 44/2C',
    'Warning: Unstable Class entity 525 ARC_DIMENSION (0x401) 248/399',
    'Warning: Unstable Class object 506 MATERIAL (0x481) 114/269',
    'ERROR: Preview overflow 302120 + 119 > 302223',
    'ERROR: bit_read_BL: unexpected 2-bit code: \'11\'',
    'ERROR: Invalid num_pages 0, skip',
  ].join('\n');
  const rep = converterReport(stderr);
  assert.deepEqual(rep, { dropped: { ACAD_TABLE: 2, ARC_DIMENSION: 1 }, errors: 2 });
  const d = dxfToPreview(dxf({ entities: [line(0, 0, 1, 1), [[0, 'ARC_DIMENSION'], [8, '0'], [2, '*YOK']]] }));
  mergeConverterReport(d, rep);
  assert.deepEqual(d.notes.dropped, { ACAD_TABLE: 2 }, 'DXF\'te bulunan ARC_DIMENSION önizleyicinin kendi kuralıyla değerlendirilir');
  assert.equal(d.notes.unsupported.ACAD_TABLE, 2);
  assert.equal(d.notes.unsupported.ARC_DIMENSION, 1, 'bloğu olmayan ölçü yine bildirilir');
  assert.equal(d.notes.converterErrors, 2);
  // Rapor metninden başka hiçbir şey çıkmaz
  assert.deepEqual(converterReport('rm -rf / ; Class entity 1 a-b ; ERROR\n'), { dropped: {}, errors: 0 });
  const bad = dxfToPreview(dxf({ entities: [line(0, 0, 1, 1)] }));
  mergeConverterReport(bad, { dropped: { '<script>': 5, 'OK_TYPE': -1, 'X': 'çok' }, errors: 'x' });
  assert.deepEqual(bad.notes.dropped, {});
  assert.equal(bad.notes.converterErrors, 0);
});

test('CLI: DXF → JSON; bozuk girdi sabit kod; ikili DXF reddedilir; rapor dosyası birleştirilir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-cli-'));
  try {
    const inp = path.join(dir, 'a.dxf');
    const out = path.join(dir, 'a.json');
    const rep = path.join(dir, 'r.json');
    fs.writeFileSync(inp, dxf({ entities: [line(0, 0, 3, 4)] }));
    fs.writeFileSync(rep, JSON.stringify({ dropped: { ACAD_TABLE: 1 }, errors: 1 }));
    runCli(inp, out, rep);
    const r = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.extents, [0, 0, 3, 4]);
    assert.deepEqual(r.data.notes.dropped, { ACAD_TABLE: 1 });
    fs.writeFileSync(inp, 'AutoCAD Binary DXF\r\n\x1a\x00junk');
    runCli(inp, out);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { ok: false, code: 'BINARY_DXF' });
    fs.writeFileSync(inp, '%PDF-1.7 sahte');
    runCli(inp, out);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { ok: false, code: 'NOT_DXF' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// İçerik kararı (uzantıya güvenilmez)
// ---------------------------------------------------------------------------------------------------------------------

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const WEBP = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1');
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\n', 'latin1');
const DWG = Buffer.from('AC1032\x00\x00\x00\x00\x00', 'latin1');
const DXF = Buffer.from('  0\nSECTION\n  2\nHEADER\n', 'latin1');
const HTML = Buffer.from('<html><script>alert(1)</script>', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'latin1');

test('önizleme kararı: tür ilk baytlardan; uzantı ailesiyle uyuşmazsa (MIME taklidi) önizleme yok', () => {
  assert.deepEqual([PNG, JPG, WEBP, PDF, DWG, DXF, HTML, SVG].map(sniffContent), ['png', 'jpeg', 'webp', 'pdf', 'dwg', 'dxf', null, null]);
  assert.equal(sniffContent(Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1')), 'dxf-binary');
  const ok = (name, head) => previewDecision(name, head, 1000);
  assert.deepEqual(ok('a.PDF', PDF), { ok: true, family: 'pdf', content: 'pdf', mime: 'application/pdf' });
  assert.deepEqual(ok('a.jpg', PNG), { ok: true, family: 'image', content: 'png', mime: 'image/png' }, 'resim ailesinde içerik türü imzadan');
  assert.deepEqual(ok('cizim.dwg', DWG), { ok: true, family: 'cad', content: 'dwg', mime: null });
  assert.deepEqual(ok('cizim.dxf', DXF), { ok: true, family: 'cad', content: 'dxf', mime: null });
  for (const [name, head] of [['a.pdf', HTML], ['a.png', HTML], ['a.png', SVG], ['a.pdf', PNG], ['a.png', PDF], ['a.dwg', DXF], ['a.dxf', DWG], ['a.jpg', DWG]]) {
    assert.deepEqual(ok(name, head), { ok: false, code: 'MISMATCH' }, name);
  }
  assert.deepEqual(ok('a.svg', SVG), { ok: false, code: 'UNSUPPORTED' }, 'SVG önizlenmez (betik taşıyabilir)');
  assert.deepEqual(ok('a.html', HTML), { ok: false, code: 'UNSUPPORTED' });
  assert.deepEqual(ok('a', PDF), { ok: false, code: 'UNSUPPORTED' });
  assert.deepEqual(ok('a.dxf', Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1')), { ok: false, code: 'BINARY_DXF' });
  // Boyut sınırları
  assert.deepEqual(previewDecision('a.pdf', PDF, PREVIEW_LIMITS.pdf + 1), { ok: false, code: 'TOO_LARGE' });
  assert.deepEqual(previewDecision('a.dwg', DWG, PREVIEW_LIMITS.dwg + 1), { ok: false, code: 'TOO_LARGE' });
  assert.equal(previewDecision('a.dwg', DWG, PREVIEW_LIMITS.dwg).ok, true);
  assert.deepEqual(previewDecision('a.pdf', PDF, 0), { ok: false, code: 'TOO_LARGE' });
  // Düğme ailesi yalnızca uzantıdan; prototip anahtarları bilinmeyen tür
  assert.deepEqual(['a.pdf', 'b.JPEG', 'c.webp', 'd.Dwg', 'e.dxf', 'f.zip', 'g.constructor', 'h.__proto__', '', null].map(previewFamily),
    ['pdf', 'image', 'image', 'cad', 'cad', null, null, null, null, null]);
  assert.deepEqual([...PREVIEW_ROUTE_KINDS].sort(), ['cizim', 'siparis', 'tedarik', 'teslim-belgesi', 'teslimat']);
  assert.equal(previewCode('TIMEOUT'), 'TIMEOUT');
  assert.equal(previewCode('stream: Eicar FOUND /tmp/x'), 'INVALID');
  assert.equal(previewCode('constructor'), 'INVALID');
});

// ---------------------------------------------------------------------------------------------------------------------
// CAD hizmeti (sahte dwg2dxf)
// ---------------------------------------------------------------------------------------------------------------------

/** Sahte dwg2dxf: argümanları kaydeder, davranışı FAKE_MODE dosyasından okur */
function fakeConverter(dir) {
  const bin = path.join(dir, 'dwg2dxf');
  const ok = dxf({ entities: [line(0, 0, 10, 0), circle(5, 5, 1)] }).replace(/\n/g, '\\n');
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args.txt"
mode=$(cat "${dir}/mode" 2>/dev/null)
out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { shift; out="$1"; }; shift; done
case "$mode" in
  sleep) sleep 5 ;;
  nooutput) echo "ERROR: Failed to decode" >&2; exit 1 ;;
  dropped) echo "Warning: Unhandled Class entity 528 ACAD_TABLE (0x401) 31/1A" >&2; echo "ERROR: bit_read_BL: x" >&2; printf '${ok}' > "$out" ;;
  partial) printf '${ok}' > "$out"; exit 3 ;;
  *) printf '${ok}' > "$out" ;;
esac
`, { mode: 0o755 });
  return bin;
}

async function withService(opts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-svc-'));
  const tmpRoot = path.join(dir, 'tmp');
  fs.mkdirSync(tmpRoot);
  const svc = createCadService({ dwgBin: fakeConverter(dir), tmpRoot, ...opts });
  const srv = http.createServer(svc.handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
  const post = async (type, body, headers = {}) => {
    const res = await fetch(`${url}/preview?type=${type}`, { method: 'POST', body, headers });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn({ dir, tmpRoot, url, post, svc, mode: (m) => fs.writeFileSync(path.join(dir, 'mode'), m) });
  } finally {
    await new Promise((r) => srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const waitEmpty = async (dir) => {
  for (let i = 0; i < 50 && fs.readdirSync(dir).length; i++) await new Promise((r) => setTimeout(r, 20));
  return fs.readdirSync(dir);
};

test('CAD hizmeti: DWG dönüştürülür; komutta yalnızca sabit geçici adlar (dosya adı yok); geçici klasör silinir', async () => {
  await withService({}, async ({ dir, tmpRoot, post }) => {
    const r = await post('dwg', Buffer.concat([DWG, Buffer.alloc(100)]));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.converted, true);
    assert.equal(r.body.warning, false);
    assert.equal(r.body.data.paths.length, 2);
    const args = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').trim().split('\n');
    assert.equal(args[0], '-y');
    assert.equal(args[1], '-o');
    assert.match(args[2], /\/cad-[^/]+\/out\.dxf$/);
    assert.match(args[3], /\/cad-[^/]+\/in\.dwg$/);
    assert.deepEqual(await waitEmpty(tmpRoot), []);
    // DXF dönüştürücüsüz
    const d = await post('dxf', dxf({ entities: [line(0, 0, 1, 1)] }));
    assert.equal(d.body.ok, true);
    assert.equal(d.body.converted, false);
    assert.deepEqual(await waitEmpty(tmpRoot), []);
  });
});

test('CAD hizmeti: düşürülen nesneler ve dönüştürücü hataları bildirilir; çıktısız / süre aşımı / sahte içerik sabit kod', async () => {
  await withService({ limits: { dwgTimeoutMs: 400 } }, async ({ tmpRoot, post, mode }) => {
    mode('dropped');
    let r = await post('dwg', DWG);
    assert.deepEqual(r.body.data.notes.dropped, { ACAD_TABLE: 1 });
    assert.equal(r.body.data.notes.converterErrors, 1);
    mode('partial');
    r = await post('dwg', DWG);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.warning, true, 'hata koduyla bitip çıktı veren dönüşüm uyarıyla gösterilir');
    mode('nooutput');
    assert.deepEqual(await post('dwg', DWG), { status: 422, body: { ok: false, code: 'CONVERT_FAILED' } });
    mode('sleep');
    assert.deepEqual(await post('dwg', DWG), { status: 504, body: { ok: false, code: 'TIMEOUT' } });
    mode('');
    assert.deepEqual(await post('dwg', DXF), { status: 415, body: { ok: false, code: 'MISMATCH' } });
    assert.deepEqual(await post('dxf', PNG), { status: 415, body: { ok: false, code: 'MISMATCH' } });
    assert.deepEqual(await post('dxf', Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1')), { status: 415, body: { ok: false, code: 'BINARY_DXF' } });
    assert.deepEqual(await post('dxf', '  0\nSECTION\n  2\nENTITIES\n  0\nLINE\nxx\n'), { status: 422, body: { ok: false, code: 'INVALID' } });
    assert.deepEqual(await post('pdf', PDF), { status: 400, body: { ok: false, code: 'BAD_TYPE' } });
    assert.deepEqual(await waitEmpty(tmpRoot), []);
  });
});

test('CAD hizmeti: boyut sınırı, eşzamanlılık (tek iş + kısa kuyruk → meşgul), DWG aracı yoksa kullanılamaz', async () => {
  await withService({ limits: { dwgBytes: 1000, active: 1, queue: 0, waitMs: 50 } }, async ({ post, mode, url }) => {
    assert.deepEqual(await post('dwg', Buffer.concat([DWG, Buffer.alloc(2000)])), { status: 413, body: { ok: false, code: 'TOO_LARGE' } });
    mode('sleep');
    const slow = post('dwg', DWG);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await post('dwg', DWG), { status: 503, body: { ok: false, code: 'BUSY' } });
    await slow;
    const h = await (await fetch(`${url}/health`)).json();
    assert.deepEqual(h, { ok: true, dwg: true });
  });
  await withService({ dwgBin: '/yok/dwg2dxf' }, async ({ post, url }) => {
    assert.deepEqual(await post('dwg', DWG), { status: 503, body: { ok: false, code: 'UNAVAILABLE' } });
    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true, dwg: false });
    assert.equal((await fetch(`${url}/baska`)).status, 404);
  });
  assert.equal(sniff('dwg', DWG), null);
  assert.equal(sniff('dxf', HTML), 'MISMATCH');
});

// ---------------------------------------------------------------------------------------------------------------------
// Uygulama tarafı istemci ve önbellek
// ---------------------------------------------------------------------------------------------------------------------

test('istemci: yalnızca sunucu ortamındaki http adresi; yönlendirme izlenmez; hata kodları sabit; yanıt boyutu sınırlı', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-cli-'));
  const file = path.join(dir, 'a.dxf');
  fs.writeFileSync(file, 'x');
  try {
    const calls = [];
    const fake = (body, init = {}) => async (u, o) => { calls.push([String(u), o.redirect, o.headers['Content-Length']]); return new Response(body, init); };
    assert.deepEqual(await requestCadPreview({ url: undefined, type: 'dxf', path: file, size: 1 }), { ok: false, code: 'UNAVAILABLE' });
    assert.deepEqual(await requestCadPreview({ url: 'https://cad:3311', type: 'dxf', path: file, size: 1, fetchImpl: fake('{}') }), { ok: false, code: 'UNAVAILABLE' });
    const ok = await requestCadPreview({ url: 'http://cad:3311', type: 'dxf', path: file, size: 1, fetchImpl: fake(JSON.stringify({ ok: true, converted: false, warning: false, data: { paths: [] }, extra: 'gizli' })) });
    assert.equal(ok.ok, true);
    assert.deepEqual(JSON.parse(/** @type {any} */ (ok).json), { ok: true, converted: false, warning: false, data: { paths: [] } }, 'yalnızca bilinen alanlar');
    assert.deepEqual(calls.at(-1), ['http://cad:3311/preview?type=dxf', 'error', '1']);
    assert.deepEqual(await requestCadPreview({ url: 'http://cad', type: 'dxf', path: file, size: 1, fetchImpl: fake(JSON.stringify({ ok: false, code: 'TIMEOUT' }), { status: 504 }) }), { ok: false, code: 'TIMEOUT' });
    assert.deepEqual(await requestCadPreview({ url: 'http://cad', type: 'dxf', path: file, size: 1, fetchImpl: fake(JSON.stringify({ ok: false, code: '/etc/passwd' }), { status: 422 }) }), { ok: false, code: 'INVALID' });
    assert.deepEqual(await requestCadPreview({ url: 'http://cad', type: 'dxf', path: file, size: 1, fetchImpl: fake('<html>', { status: 502 }) }), { ok: false, code: 'UNAVAILABLE' });
    assert.deepEqual(await requestCadPreview({ url: 'http://cad', type: 'dxf', path: file, size: 1, fetchImpl: fake('{}', { status: 200, headers: { 'content-length': '999999999' } }) }), { ok: false, code: 'TOO_COMPLEX' });
    assert.deepEqual(await requestCadPreview({ url: 'http://cad', type: 'dxf', path: file, size: 1, fetchImpl: async () => { throw new TypeError('redirect'); } }), { ok: false, code: 'UNAVAILABLE' });
    assert.deepEqual(await requestCadPreview({ url: 'http://cad', type: 'dxf', path: file, size: 1, timeoutMs: 20, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('abort')))) }), { ok: false, code: 'TIMEOUT' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('özel önbellek: anahtar dosyanın kendisi (depolama anahtarı + boyut + değişme zamanı); en eski çıkar, boyut sınırı', () => {
  const c = createCadCache({ entries: 2, bytes: 10 });
  assert.equal(cadCacheKey({ storageKey: '2026/10/a', size: 5, mtimeMs: 1.9 }), '2026/10/a|5|1');
  c.set('a', '1234');
  c.set('b', '1234');
  assert.equal(c.get('a'), '1234');
  c.set('c', '12');
  assert.equal(c.get('b'), null, 'en az kullanılan çıktı');
  c.set('d', '123456789');
  assert.equal(c.size(), 1, 'toplam boyut sınırı');
  c.set('e', 'x'.repeat(11));
  assert.equal(c.get('e'), null, 'sınırdan büyük değer saklanmaz');
});

// ---------------------------------------------------------------------------------------------------------------------
// Yapı
// ---------------------------------------------------------------------------------------------------------------------

test('yapı: önizleme indirme ile AYNI sorgu / virüs / disk denetiminden sonra; ayrı denetim kaydı; güvenli başlıklar', () => {
  const route = read('app/dosya/[kind]/[id]/route.ts');
  const at = (s) => { const i = route.indexOf(s); assert.ok(i > 0, s); return i; };
  const preview = at("const onizle = new URL(req.url).searchParams.get('onizle');");
  assert.ok(at("if (!file) return new Response(t('common.fileNotFound'), { status: 404 });") < preview);
  assert.ok(at("if (file.scanStatus === 'INFECTED')") < preview);
  assert.ok(at('if (!full || !stat || !stat.isFile())') < preview);
  assert.ok(preview < at("await audit('FILE_DOWNLOAD'"), 'önizleme indirme kaydı yazmaz');
  const fn = route.slice(at('async function previewResponse('));
  assert.equal((fn.match(/await audit\('FILE_PREVIEW'/g) ?? []).length, 2);
  assert.ok(fn.indexOf('previewDecision(') < fn.indexOf("await audit('FILE_PREVIEW'"), 'kayıt içerik kararından sonra');
  assert.ok(fn.indexOf('previewLimiter.take(') < fn.indexOf('fs.openSync('), 'istek sınırı dosya okunmadan önce');
  for (const h of ["'Content-Security-Policy': \"sandbox; default-src 'none'", "'X-Content-Type-Options': 'nosniff'", "'Cache-Control': 'private, no-store'", "'Content-Disposition': 'inline'"]) assert.ok(fn.includes(h), h);
  assert.ok(!fn.includes('file.mime'), 'içerik türü kayıttaki MIME\'den değil imzadan');
  // Önizleme düğmesi yalnızca indirme adresine parametre ekler
  const btn = read('components/FilePreviewViewer.tsx');
  assert.ok(btn.includes('`${href}?onizle=1`') && btn.includes('`${href}?onizle=cad`'));
  assert.ok(!/dangerouslySetInnerHTML|innerHTML|eval\(/.test(btn), 'dosya içeriği HTML olarak yorumlanmaz');
});

test('yapı: CAD hizmeti ayrı, kısıtlı kapsayıcı; uygulamanın iç ağı; LibreDWG sabit sürüm + SHA-256; lisans imajda', () => {
  const compose = read('deploy/docker-compose.yml');
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === '  cad:');
  assert.ok(start > 0);
  const def = [];
  for (const l of lines.slice(start + 1)) { if (/^ {0,2}[^\s#]/.test(l)) break; if (!/^\s*#/.test(l)) def.push(l); }
  const cad = def.join('\n');
  for (const s of ['user: "65534:65534"', 'read_only: true', '- ALL', 'no-new-privileges:true', 'mem_limit:', 'cpus:', 'pids_limit:', 'command: ["node", "/app/cad/service.mjs"]', 'noexec']) assert.ok(cad.includes(s), s);
  assert.doesNotMatch(cad, /env_file|volumes:|ports:|privileged|cap_add|DATABASE_URL|depends_on/);
  assert.match(cad, /^ {4}networks:\n {6}- cad$/m, 'yalnızca iç ağ');
  assert.match(compose, /^ {2}cad:\n {4}internal: true$/m, 'iç ağın dışarı çıkışı yok');
  assert.match(compose, /CAD_SERVICE_URL: http:\/\/cad:3311/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /ARG LIBREDWG_VERSION=0\.14\n/);
  assert.match(dockerfile, /ARG LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275\n/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /COPY --from=libredwg \/opt\/libredwg\/share\/ \/usr\/share\/doc\/libredwg\//);
  // Hizmet kabuk kullanmaz; dönüştürücü prlimit ile sınırlanır
  const svc = read('server/cad/service.mjs');
  assert.ok(!/shell:\s*true|exec\(|execSync|spawnSync/.test(svc));
  assert.ok(svc.includes("['-y', '-o', dxf, input]"));
  for (const l of ['--as=', '--cpu=', '--fsize=', '--core=0']) assert.ok(svc.includes(l), l);
  // Başka hiçbir kod CAD hizmetine / dönüştürücüye gitmez
  const env = read('server/env.js');
  assert.match(env, /CAD_SERVICE_URL: \{ group: 'app', parse: parseUrl\(\['http:'\]\)/);
});
