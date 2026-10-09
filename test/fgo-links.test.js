// FGO'nun verdiği belge bağlantıları (güvenlik denetimi 3.50.9 AUD-5 + AUD-7, karar 144).
//   - pdfUrl: bağlantı yalnızca FGO'nun kendi adresiyse (https, fgo.ro / *.fgo.ro, kullanıcı bilgisi ve özel port yok) kullanılır
//   - downloadFgoPdf: yönlendirme otomatik izlenmez; her hedef, istek gönderilmeden ÖNCE doğrulanır; en çok 3 yönlendirme;
//     yanıt akışla ve sınırlı okunur (Content-Length'e güvenilmez); tek süre bütün adımları ve gövdeyi kapsar
//   - bağlantı e-postaya ve ekrana yalnızca doğrulanmışsa yazılır; sayfalarda ham bağlantılı href kalmadı
// Yalnızca sahte fetch ve yerel (127.0.0.1) deneme sunucuları kullanılır: FGO'ya ya da başka bir dış adrese istek gitmez.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDF_MAX_BYTES, PDF_MAX_REDIRECTS, PDF_TIMEOUT_MS, downloadFgoPdf, pdfUrl } from '../server/documents/fgo-pdf.js';
import * as delivery from '../server/documents/delivery.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Yorumsuz kaynak: önce satır yorumları, sonra blok yorumlar */
const noComments = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/([^:])\/\/.*$/gm, '$1');
const MiB = 1024 * 1024;
const PDF = Buffer.from('%PDF-1.4\n% deneme belgesi\n%%EOF\n');
const A = 'https://www.fgo.ro/facturi/PRF1.pdf';
const pdfOf = (size) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size - 9, 0x20)]);
const pdfRes = (body = PDF, headers = {}) => new Response(body, { headers: { 'content-type': 'application/pdf', ...headers } });
const redirect = (location, status = 302) => new Response(null, { status, headers: location === undefined ? {} : { location } });

/** Sahte ağ: adres → yanıt. Her istek `calls`a yazılır; tanımsız adrese istek testi düşürür (`stray`). */
function net(routes) {
  const calls = [], stray = [], inits = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    inits.push(init);
    const r = routes[u];
    if (r === undefined) {
      stray.push(u);
      throw new Error(`test: beklenmeyen istek ${u}`);
    }
    return typeof r === 'function' ? r(init) : r;
  };
  return { fetchImpl, calls, stray, inits };
}
/** Sayaçlı gövde akışı: kaç bayt ÇEKİLDİ, iptal edildi mi. chunks: dizi ya da (i) => Buffer | null üreteci */
function body(chunks, { hang = false } = {}) {
  const state = { pulled: 0, pulls: 0, cancelled: false, done: false };
  let i = 0;
  const next = typeof chunks === 'function' ? chunks : (n) => chunks[n] ?? null;
  const stream = new ReadableStream({
    pull(controller) {
      state.pulls++;
      const c = next(i++);
      if (c == null) {
        if (hang) return new Promise(() => {});
        state.done = true;
        controller.close();
        return undefined;
      }
      state.pulled += c.length;
      controller.enqueue(new Uint8Array(c));
      return undefined;
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}
const failed = (r, error) => assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error }, `beklenen: ${error}`);

// ---------- pdfUrl ----------
test('pdfUrl: yalnızca https + fgo.ro / *.fgo.ro; kullanıcı bilgisi ve varsayılan dışı port reddedilir; geçerli adres normalleşir', () => {
  const ok = {
    'https://fgo.ro/facturi/001_BV.pdf': 'https://fgo.ro/facturi/001_BV.pdf',
    'https://www.fgo.ro/x.pdf': 'https://www.fgo.ro/x.pdf',
    'https://api.fgo.ro/v1/factura/print/abc?x=1&y=%C8%99': 'https://api.fgo.ro/v1/factura/print/abc?x=1&y=%C8%99',
    'https://api-testuat.fgo.ro/v1/x': 'https://api-testuat.fgo.ro/v1/x',
    'https://a.b.fgo.ro/': 'https://a.b.fgo.ro/',
    // normalleşme: büyük harf, varsayılan port, nokta parçaları
    'HTTPS://WWW.FGO.RO/x.pdf': 'https://www.fgo.ro/x.pdf',
    'https://www.fgo.ro:443/x.pdf': 'https://www.fgo.ro/x.pdf',
    'https://www.fgo.ro/a/../b.pdf': 'https://www.fgo.ro/b.pdf',
    'https://fgo.ro': 'https://fgo.ro/',
  };
  for (const [input, expected] of Object.entries(ok)) {
    assert.equal(pdfUrl(input), expected, input);
    assert.equal(pdfUrl(expected), expected, `kararlı: ${expected}`);
  }
  const bad = [
    // şema
    'http://fgo.ro/x.pdf', 'http://www.fgo.ro/x.pdf', 'ftp://fgo.ro/x', 'file:///etc/passwd', 'javascript:alert(1)', 'data:application/pdf;base64,JVBERi0=', 'blob:https://fgo.ro/x',
    // benzer adlar
    'https://evilfgo.ro/x.pdf', 'https://fgo.ro.evil.example/x.pdf', 'https://fgo.ro.evil.test/x.pdf', 'https://xfgo.ro/', 'https://fgo.ro.ro/', 'https://fgo.com/', 'https://fgo.ro./x',
    'https://www.fgo.r0/x', 'https://fgo-ro/x', 'https://evil.example/fgo.ro/x.pdf', 'https://evil.example/?u=https://fgo.ro/x.pdf', 'https://evil.example/#https://fgo.ro/',
    // kullanıcı bilgisi
    'https://api.fgo.ro@evil.example/x.pdf', 'https://fgo.ro:x@evil.example/', 'https://user@fgo.ro/x.pdf', 'https://user:pass@www.fgo.ro/x.pdf', 'https://:pass@fgo.ro/x',
    // port
    'https://fgo.ro:8443/x.pdf', 'https://www.fgo.ro:80/x.pdf', 'https://www.fgo.ro:444/x', 'https://fgo.ro:1/x',
    // yerel / özel / bağlantıya özgü adresler
    'https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x', 'https://10.0.0.5/x', 'https://192.168.1.10/x', 'https://172.16.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://0.0.0.0/x',
    'http://127.0.0.1:3000/oturum/govde-izni', 'https://app:3000/x', 'https://db/x',
    // adres olmayanlar
    '//evil.example/x.pdf', '//fgo.ro/x.pdf', '/belgeler', 'fgo.ro/x.pdf', 'www.fgo.ro', '', ' ', 'https://', 'https:///x', `https://fgo.ro/${'a'.repeat(2100)}`,
  ];
  for (const input of bad) assert.equal(pdfUrl(input), null, JSON.stringify(input).slice(0, 80));
  for (const v of [null, undefined, 0, 42, true, {}, [], ['https://fgo.ro/x.pdf'], new URL('https://fgo.ro/x.pdf'), Symbol('x')]) assert.equal(pdfUrl(v), null, 'dize olmayan değer');
  // Eski içe aktarma yolu aynı işlevi verir (tek kural)
  assert.equal(delivery.pdfUrl, pdfUrl);
  assert.equal(delivery.PDF_MAX_BYTES, PDF_MAX_BYTES);
  assert.deepEqual([PDF_MAX_BYTES, PDF_TIMEOUT_MS, PDF_MAX_REDIRECTS], [15 * MiB, 20_000, 3]);
});

// ---------- indirme: doğrudan ----------
test('indirme: geçerli FGO PDF\'i aynen alınır; istek redirect: "manual" ile, tek süre işaretiyle ve kimlik bilgisi olmadan gider', async () => {
  const n = net({ [A]: () => pdfRes() });
  const r = await downloadFgoPdf(A, { fetchImpl: n.fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(r.bytes.equals(PDF));
  assert.deepEqual(n.calls, [A]);
  const [init] = n.inits;
  assert.equal(init.redirect, 'manual');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, { accept: 'application/pdf' });
  assert.deepEqual(Object.keys(init).sort(), ['headers', 'redirect', 'signal'], 'gövde / yöntem / kimlik seçeneği yok');
  // Adres FGO adresi değilse hiçbir istek gönderilmez
  for (const bad of ['https://evil.example/x.pdf', 'http://www.fgo.ro/x.pdf', 'https://www.fgo.ro:8443/x.pdf', 'https://a:b@www.fgo.ro/x.pdf', null, '']) {
    const m = net({});
    failed(await downloadFgoPdf(bad, { fetchImpl: m.fetchImpl }), 'PDF adresi FGO adresi değil');
    assert.deepEqual(m.calls, [], String(bad));
  }
  // HTTP hatası: durum çağırana döner (404 / 410'da bağlantı FGO'dan yenilenir — fetchDocPdf)
  for (const status of [400, 403, 404, 410, 429, 500, 503]) {
    const m = net({ [A]: () => new Response('hata', { status }) });
    assert.deepEqual(await downloadFgoPdf(A, { fetchImpl: m.fetchImpl }), { ok: false, status, error: `HTTP ${status}` });
  }
  // Yönlendirme sayılmayan 3xx (300 / 304) izlenmez
  for (const status of [300, 304]) {
    const m = net({ [A]: () => new Response(null, { status, headers: { location: 'https://www.fgo.ro/b.pdf' } }) });
    assert.equal((await downloadFgoPdf(A, { fetchImpl: m.fetchImpl })).ok, false, String(status));
    assert.deepEqual(m.calls, [A]);
  }
});

// ---------- indirme: yönlendirme ----------
test('yönlendirme: FGO → FGO (301 / 302 / 303 / 307 / 308) izlenir; göreli Location o anki adrese göre çözülür; her adım aynı seçeneklerle', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const B = 'https://cdn.fgo.ro/dosya/PRF1.pdf';
    const n = net({ [A]: () => redirect(B, status), [B]: () => pdfRes() });
    const r = await downloadFgoPdf(A, { fetchImpl: n.fetchImpl });
    assert.equal(r.ok, true, String(status));
    assert.ok(r.bytes.equals(PDF));
    assert.deepEqual(n.calls, [A, B]);
    assert.ok(n.inits.every((i) => i.redirect === 'manual' && i.signal === n.inits[0].signal), 'her adım manual ve AYNI süre işaretiyle');
  }
  const relative = {
    '/facturi/b.pdf': 'https://www.fgo.ro/facturi/b.pdf',
    'b.pdf': 'https://www.fgo.ro/facturi/b.pdf',
    '../print/c.pdf': 'https://www.fgo.ro/print/c.pdf',
    '?v=2': 'https://www.fgo.ro/facturi/PRF1.pdf?v=2',
    '//api.fgo.ro/v1/d.pdf': 'https://api.fgo.ro/v1/d.pdf',
    'HTTPS://WWW.FGO.RO:443/e.pdf': 'https://www.fgo.ro/e.pdf',
  };
  for (const [location, target] of Object.entries(relative)) {
    const n = net({ [A]: () => redirect(location), [target]: () => pdfRes() });
    assert.equal((await downloadFgoPdf(A, { fetchImpl: n.fetchImpl })).ok, true, location);
    assert.deepEqual(n.calls, [A, target], location);
  }
});

test('yönlendirme: en çok 3 adım — 3 yönlendirme kabul, 4.\'sü reddedilir ve 5. adrese istek gitmez; döngü reddedilir', async () => {
  const U = (i) => `https://www.fgo.ro/adim/${i}.pdf`;
  const chain = (hops) => Object.fromEntries(Array.from({ length: hops + 1 }, (_, i) => [U(i), () => (i < hops ? redirect(U(i + 1)) : pdfRes())]));
  for (const hops of [1, 2, 3]) {
    const n = net(chain(hops));
    assert.equal((await downloadFgoPdf(U(0), { fetchImpl: n.fetchImpl })).ok, true, `${hops} yönlendirme`);
    assert.equal(n.calls.length, hops + 1);
  }
  for (const hops of [4, 5, 20]) {
    const n = net(chain(hops));
    failed(await downloadFgoPdf(U(0), { fetchImpl: n.fetchImpl }), 'çok fazla yönlendirme');
    assert.deepEqual(n.calls, [U(0), U(1), U(2), U(3)], 'ilk istek + 3 yönlendirme; 4. yönlendirmenin hedefine gidilmez');
  }
  // Döngü: A → B → A (ve kendine dönen adres; parça — #… — döngüyü gizleyemez)
  const B = 'https://www.fgo.ro/b.pdf';
  const loop = net({ [A]: () => redirect(B), [B]: () => redirect(A) });
  failed(await downloadFgoPdf(A, { fetchImpl: loop.fetchImpl }), 'yönlendirme döngüsü');
  assert.deepEqual(loop.calls, [A, B], 'A\'ya ikinci kez gidilmez');
  for (const location of [A, `${A}#x`, 'PRF1.pdf']) {
    const self = net({ [A]: () => redirect(location) });
    failed(await downloadFgoPdf(A, { fetchImpl: self.fetchImpl }), 'yönlendirme döngüsü');
    assert.deepEqual(self.calls, [A], location);
  }
});

test('yönlendirme: FGO dışı hedef — http, yerel / özel / bağlantıya özgü adres, benzer ad, kullanıcı bilgisi, özel port — hedefe İSTEK GİTMEDEN reddedilir', async () => {
  const targets = [
    'https://evil.example/x.pdf', 'http://www.fgo.ro/x.pdf', 'http://fgo.ro/x.pdf',
    'http://127.0.0.1/x', 'https://127.0.0.1/x', 'http://localhost:3000/oturum/govde-izni', 'https://localhost/x', 'https://[::1]/x', 'http://[::1]:5432/',
    'https://10.0.0.5/x', 'https://192.168.1.10/x', 'https://172.16.0.1/x', 'https://169.254.169.254/latest/meta-data/', 'http://169.254.169.254/', 'https://0.0.0.0/x',
    'http://app:3000/x', 'http://db:5432/', 'http://clamav:3310/',
    'https://fgo.ro.evil.example/x.pdf', 'https://evilfgo.ro/x.pdf', 'https://xfgo.ro/x.pdf', 'https://fgo.ro./x.pdf',
    'https://www.fgo.ro@evil.example/x.pdf', 'https://user:pass@www.fgo.ro/x.pdf', 'https://user@fgo.ro/x.pdf',
    'https://www.fgo.ro:8443/x.pdf', 'https://fgo.ro:80/x.pdf',
    '//evil.example/x.pdf', 'file:///etc/passwd', 'javascript:alert(1)', 'data:application/pdf;base64,JVBERi0=', 'ftp://fgo.ro/x.pdf', 'gopher://fgo.ro/', 'https://',
    '', undefined,
  ];
  for (const location of targets) {
    for (const status of [302, 307]) {
      const n = net({ [A]: () => redirect(location, status) });
      const r = await downloadFgoPdf(A, { fetchImpl: n.fetchImpl });
      failed(r, 'yönlendirme FGO dışı bir adrese');
      assert.equal(r.status, 0);
      assert.deepEqual(n.calls, [A], `hedefe istek gitmedi: ${String(location)}`);
      assert.deepEqual(n.stray, []);
    }
  }
  // İkinci adımda FGO dışına: ilk iki FGO adresine gidilir, üçüncüye gidilmez
  const B = 'https://cdn.fgo.ro/b.pdf';
  const n = net({ [A]: () => redirect(B), [B]: () => redirect('https://evil.example/son') });
  failed(await downloadFgoPdf(A, { fetchImpl: n.fetchImpl }), 'yönlendirme FGO dışı bir adrese');
  assert.deepEqual(n.calls, [A, B]);
  // fetch yönlendirmeyi kendisi izlediyse (seçenek uygulanmadıysa) yanıt kabul edilmez
  const followed = net({ [A]: () => Object.defineProperty(pdfRes(), 'redirected', { value: true }) });
  failed(await downloadFgoPdf(A, { fetchImpl: followed.fetchImpl }), 'beklenmeyen yönlendirme');
  const opaque = net({ [A]: () => Object.defineProperty(new Response(null, { status: 200 }), 'type', { value: 'opaqueredirect' }) });
  failed(await downloadFgoPdf(A, { fetchImpl: opaque.fetchImpl }), 'beklenmeyen yönlendirme');
});

// ---------- indirme: boy ----------
test('boy: Content-Length sınırı aşıyorsa gövde OKUNMADAN reddedilir; bildirim yoksa / yanlışsa okunan bayt sayılır ve sınırda durulur', async () => {
  const LIMIT = 64 * 1024;
  // 1) Bildirilen boy büyük: gövdeden tek bayt çekilmez, akış iptal edilir
  for (const declared of [String(LIMIT + 1), '999999999999', ` ${LIMIT * 2} `]) {
    const b = body((i) => (i === 0 ? pdfOf(1024) : Buffer.alloc(1024, 0x20)));
    const n = net({ [A]: () => pdfRes(b.stream, { 'content-length': declared }) });
    failed(await downloadFgoPdf(A, { fetchImpl: n.fetchImpl, maxBytes: LIMIT }), 'PDF çok büyük');
    assert.deepEqual([b.state.pulled, b.state.cancelled], [0, true], declared);
  }
  // 2) Bildirim yok (chunked): sınır aşılınca okuma durur — sonsuz gövde bile sınırlıdır
  const endless = body((i) => (i === 0 ? pdfOf(4096) : Buffer.alloc(4096, 0x20)));
  const n2 = net({ [A]: () => pdfRes(endless.stream) });
  failed(await downloadFgoPdf(A, { fetchImpl: n2.fetchImpl, maxBytes: LIMIT }), 'PDF çok büyük');
  assert.ok(endless.state.pulled > LIMIT && endless.state.pulled <= LIMIT + 2 * 4096, `sınırda durdu (${endless.state.pulled})`);
  assert.equal(endless.state.cancelled, true);
  // 3) Bildirim YANLIŞ (küçük / sıfır / sayı değil): Content-Length'e güvenilmez, sayım geçerlidir
  for (const declared of ['10', '0', 'abc', '-5', '1e3', '']) {
    const b = body((i) => (i === 0 ? pdfOf(4096) : Buffer.alloc(4096, 0x20)));
    const n = net({ [A]: () => pdfRes(b.stream, { 'content-length': declared }) });
    failed(await downloadFgoPdf(A, { fetchImpl: n.fetchImpl, maxBytes: LIMIT }), 'PDF çok büyük');
    assert.ok(b.state.pulled <= LIMIT + 2 * 4096 && b.state.cancelled, declared);
  }
  // 4) Tam sınır kabul; bir bayt fazlası ret (tek parça ve çok parça)
  for (const chunk of [LIMIT, 1000]) {
    const exact = pdfOf(LIMIT);
    const parts = (buf) => Array.from({ length: Math.ceil(buf.length / chunk) }, (_, i) => buf.subarray(i * chunk, (i + 1) * chunk));
    const okBody = body(parts(exact));
    const ok = await downloadFgoPdf(A, { fetchImpl: net({ [A]: () => pdfRes(okBody.stream) }).fetchImpl, maxBytes: LIMIT });
    assert.equal(ok.ok, true, `tam sınır (${chunk})`);
    assert.ok(ok.bytes.equals(exact));
    const over = body(parts(pdfOf(LIMIT + 1)));
    failed(await downloadFgoPdf(A, { fetchImpl: net({ [A]: () => pdfRes(over.stream) }).fetchImpl, maxBytes: LIMIT }), 'PDF çok büyük');
  }
});

test('boy: varsayılan sınır 15 MB — tam 15 MB\'lık PDF kabul, 15 MB + 1 bayt ret; indirme arrayBuffer() kullanmaz', async () => {
  const piece = Buffer.alloc(MiB, 0x20);
  const head = pdfOf(MiB);
  const make = (extra) => body((i) => (i === 0 ? head : i < 15 ? piece : i === 15 && extra ? Buffer.alloc(extra, 0x20) : null));
  const exact = make(0);
  const forbidden = () => { throw new Error('arrayBuffer / text / blob kullanılmamalı'); };
  const guard = (res) => Object.assign(res, { arrayBuffer: forbidden, text: forbidden, blob: forbidden, json: forbidden, bytes: forbidden });
  const ok = await downloadFgoPdf(A, { fetchImpl: net({ [A]: () => guard(pdfRes(exact.stream)) }).fetchImpl });
  assert.equal(ok.ok, true);
  assert.equal(ok.bytes.length, PDF_MAX_BYTES);
  assert.equal(ok.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  const over = make(1);
  failed(await downloadFgoPdf(A, { fetchImpl: net({ [A]: () => guard(pdfRes(over.stream)) }).fetchImpl }), 'PDF çok büyük');
  assert.equal(over.state.cancelled, true);
  // Bildirilen boy tam sınırdaysa okunur; sınır + 1 ise okunmaz
  const declared = make(0);
  assert.equal((await downloadFgoPdf(A, { fetchImpl: net({ [A]: () => pdfRes(declared.stream, { 'content-length': String(PDF_MAX_BYTES) }) }).fetchImpl })).ok, true);
  const tooBig = make(0);
  failed(await downloadFgoPdf(A, { fetchImpl: net({ [A]: () => pdfRes(tooBig.stream, { 'content-length': String(PDF_MAX_BYTES + 1) }) }).fetchImpl }), 'PDF çok büyük');
  assert.equal(tooBig.state.pulled, 0);
});

// ---------- indirme: içerik ----------
test('içerik: boş gövde ve PDF olmayan yanıt (HTML, JSON, kısa / bozuk başlık) reddedilir; PDF değilse gerisi okunmaz', async () => {
  // Boş
  for (const make of [() => new Response(null, { status: 200 }), () => pdfRes(body([]).stream), () => pdfRes(body([Buffer.alloc(0), Buffer.alloc(0)]).stream), () => pdfRes('', { 'content-length': '0' })]) {
    failed(await downloadFgoPdf(A, { fetchImpl: net({ [A]: make }).fetchImpl }), 'PDF boş');
  }
  // PDF değil
  const notPdf = ['<html><body>Autentificare</body></html>', '{"Success":false,"Message":"Hash invalid"}', 'PDF-1.4', '%PD', '%pdf-1.4', ' %PDF-1.4', '\n%PDF-1.4', '%PDF', 'Not Found'];
  for (const text of notPdf) {
    for (const type of ['application/pdf', 'text/html', 'application/json']) {
      failed(await downloadFgoPdf(A, { fetchImpl: net({ [A]: () => new Response(text, { headers: { 'content-type': type } }) }).fetchImpl }), 'yanıt PDF değil');
    }
  }
  // Büyük bir HTML yanıtı: ilk parçadan sonra bırakılır (tamamı okunmaz)
  const html = body((i) => (i < 5000 ? Buffer.from(`<p>satır ${i}</p>`.padEnd(1024, ' ')) : null));
  failed(await downloadFgoPdf(A, { fetchImpl: net({ [A]: () => pdfRes(html.stream) }).fetchImpl }), 'yanıt PDF değil');
  assert.ok(html.state.pulled <= 2048 && html.state.cancelled, `gerisi okunmadı (${html.state.pulled})`);
  // "%PDF-" parçalara bölünmüş gelse de tanınır; içerik türü başlığı belirleyici değildir (içeriğe bakılır)
  const split = body([Buffer.from('%'), Buffer.from('PD'), Buffer.from('F-1.7\nx')]);
  const r = await downloadFgoPdf(A, { fetchImpl: net({ [A]: () => new Response(split.stream, { headers: { 'content-type': 'application/octet-stream' } }) }).fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.bytes.toString('latin1'), '%PDF-1.7\nx');
});

// ---------- indirme: süre ve hata metni ----------
test('süre: tek süre yönlendirmeleri ve gövdeyi kapsar — yanıt vermeyen istek, akmayan gövde ve yavaş adımlar süre dolunca kesilir', async () => {
  const quick = async (routes, timeoutMs = 80) => {
    const t0 = Date.now();
    const r = await downloadFgoPdf(A, { fetchImpl: net(routes).fetchImpl, timeoutMs });
    return { r, ms: Date.now() - t0 };
  };
  // 1) İstek hiç yanıtlanmıyor (fetch süreyi uygulamasa bile)
  const hung = await quick({ [A]: () => new Promise(() => {}) });
  failed(hung.r, 'zaman aşımı');
  assert.ok(hung.ms < 2000, `beklemeden döndü (${hung.ms} ms)`);
  // 2) Başlık geldi, gövde akmıyor
  const stuck = body([Buffer.from('%PDF-1.4\n')], { hang: true });
  const s = await quick({ [A]: () => pdfRes(stuck.stream) });
  failed(s.r, 'zaman aşımı');
  assert.ok(s.ms < 2000);
  assert.equal(stuck.state.cancelled, true, 'yarım kalan okuma iptal edildi');
  // 3) Süre adımlara bölünmez: her adım 60 ms süren 3 yönlendirme, 150 ms'lik toplam süreye sığmaz
  const slow = (res) => () => new Promise((resolve) => setTimeout(() => resolve(res()), 60));
  const U = (i) => `https://www.fgo.ro/yavas/${i}.pdf`;
  const t = await quick({ [A]: slow(() => redirect(U(1))), [U(1)]: slow(() => redirect(U(2))), [U(2)]: slow(() => redirect(U(3))), [U(3)]: slow(() => pdfRes()) }, 150);
  failed(t.r, 'zaman aşımı');
  // Süre yeterliyse aynı zincir tamamlanır
  const fine = await quick({ [A]: slow(() => redirect(U(1))), [U(1)]: slow(() => redirect(U(2))), [U(2)]: slow(() => redirect(U(3))), [U(3)]: slow(() => pdfRes()) }, 5000);
  assert.equal(fine.r.ok, true);
});

test('hata metni: adres, Location, IP ya da ağ hatasının ayrıntısı içermez (kayda ve ekrana yazılır)', async () => {
  const secret = 'https://www.fgo.ro/facturi/PRF1.pdf?token=GIZLI-ANAHTAR';
  const errors = [];
  const run = async (routes, o = {}) => errors.push((await downloadFgoPdf(secret, { fetchImpl: net(routes).fetchImpl, ...o })).error);
  await run({ [secret]: () => { throw new TypeError(`fetch failed: connect ECONNREFUSED 10.0.0.5:443 (${secret})`); } });
  assert.equal(errors.at(-1), 'bağlantı hatası');
  await run({ [secret]: () => { throw Object.assign(new Error(`aborted ${secret}`), { name: 'AbortError' }); } });
  assert.equal(errors.at(-1), 'zaman aşımı');
  await run({ [secret]: () => redirect('https://evil.example/cal?t=GIZLI-2') });
  await run({ [secret]: () => redirect(`${secret}&a=1`), [`${secret}&a=1`]: () => redirect(secret) });
  await run({ [secret]: () => new Response('yok', { status: 404 }) });
  await run({ [secret]: () => new Response('<html>', { status: 200 }) });
  await run({ [secret]: () => pdfRes('', {}) });
  await run({ [secret]: () => pdfRes(pdfOf(2000)) }, { maxBytes: 100 });
  await run({ [secret]: () => new Promise(() => {}) }, { timeoutMs: 30 });
  assert.deepEqual(errors, ['bağlantı hatası', 'zaman aşımı', 'yönlendirme FGO dışı bir adrese', 'yönlendirme döngüsü', 'HTTP 404', 'yanıt PDF değil', 'PDF boş', 'PDF çok büyük', 'zaman aşımı']);
  for (const e of errors) assert.doesNotMatch(e, /GIZLI|fgo\.ro|www\.|evil|example|:\/\/|token|PRF1|\d+\.\d+\.\d+\.\d+/i, e);
});

// ---------- gerçek fetch + yerel sunucu ----------
/** Yerel HTTP sunucusu (127.0.0.1, rastgele port) */
async function listen(handler) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, hits, port: server.address().port, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}
/**
 * FGO adlarını yerel sunuculara bağlayan fetch: https://<ad>/yol → http://127.0.0.1:<port>/yol, GERÇEK fetch ile ve
 * verilen seçeneklerle (redirect: 'manual', süre işareti). Tabloda olmayan ada istek = dışarıya çıkma girişimi (kaydedilir, reddedilir).
 */
function viaLoopback(hosts) {
  const asked = [], escaped = [];
  const fetchImpl = (url, init) => {
    const u = new URL(String(url));
    asked.push(u.toString());
    const port = hosts[u.hostname];
    if (!port) {
      escaped.push(u.toString());
      return Promise.reject(new Error('test: tabloda olmayan ada istek'));
    }
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  };
  return { fetchImpl, asked, escaped };
}

test('gerçek fetch: yönlendirme kendiliğinden izlenmez — FGO dışı hedefin sunucusu TEK İSTEK ALMAZ; FGO → FGO izlenir', async () => {
  const outside = await listen((_req, res) => res.writeHead(200, { 'content-type': 'application/pdf' }).end(PDF));
  const cdn = await listen((_req, res) => res.writeHead(200, { 'content-type': 'application/pdf' }).end(PDF));
  const www = await listen((req, res) => {
    if (req.url === '/dogrudan.pdf') return res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(PDF.length) }).end(PDF);
    if (req.url === '/fgo-ici') return res.writeHead(302, { location: 'https://cdn.fgo.ro/dosya.pdf' }).end();
    if (req.url === '/goreli') return res.writeHead(307, { location: '/dogrudan.pdf' }).end();
    // FGO dışı hedefler: fetch yönlendirmeyi kendisi izleseydi bu yerel "dış" sunucuya giderdi (dış ağa değil)
    if (req.url === '/disari-ip') return res.writeHead(302, { location: `http://127.0.0.1:${outside.port}/calinan` }).end();
    if (req.url === '/disari-308') return res.writeHead(308, { location: `http://localhost:${outside.port}/calinan` }).end();
    if (req.url === '/disari-ad') return res.writeHead(301, { location: 'https://evil.example/calinan' }).end();
    return res.writeHead(404).end('yok');
  });
  const lo = viaLoopback({ 'www.fgo.ro': www.port, 'cdn.fgo.ro': cdn.port });
  try {
    const direct = await downloadFgoPdf('https://www.fgo.ro/dogrudan.pdf', { fetchImpl: lo.fetchImpl });
    assert.equal(direct.ok, true);
    assert.ok(direct.bytes.equals(PDF));
    assert.equal((await downloadFgoPdf('https://www.fgo.ro/fgo-ici', { fetchImpl: lo.fetchImpl })).ok, true);
    assert.deepEqual(cdn.hits, ['GET /dosya.pdf']);
    assert.equal((await downloadFgoPdf('https://www.fgo.ro/goreli', { fetchImpl: lo.fetchImpl })).ok, true);
    for (const p of ['/disari-ip', '/disari-308', '/disari-ad']) {
      const before = lo.asked.length;
      failed(await downloadFgoPdf(`https://www.fgo.ro${p}`, { fetchImpl: lo.fetchImpl }), 'yönlendirme FGO dışı bir adrese');
      assert.equal(lo.asked.length, before + 1, `${p}: yalnızca ilk adres istendi`);
    }
    assert.deepEqual(outside.hits, [], 'FGO dışı hedef hiçbir istek almadı');
    assert.deepEqual(lo.escaped, [], 'tabloda olmayan bir ada istek denenmedi');
    assert.deepEqual(await downloadFgoPdf('https://www.fgo.ro/yok.pdf', { fetchImpl: lo.fetchImpl }), { ok: false, status: 404, error: 'HTTP 404' });
  } finally {
    await Promise.all([www.close(), cdn.close(), outside.close()]);
  }
});

test('gerçek fetch: sıkıştırılmış, boyu bildirilmeyen ve boyu büyük bildirilen yanıtlar sınırda kesilir; akmayan gövde süreyle kesilir', async () => {
  const LIMIT = 64 * 1024;
  const state = { chunkedWritten: 0, chunkedClosedEarly: false, declaredClosedEarly: false, hangClosed: false };
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * MiB, 0x20)]);
  const www = await listen((req, res) => {
    if (req.url === '/gzip-buyuk') {
      // ~2 KB'lık yanıt, açılınca 2 MB: Content-Length (sıkıştırılmış boy) sınırın çok altında
      const z = zlib.gzipSync(big);
      return res.writeHead(200, { 'content-type': 'application/pdf', 'content-encoding': 'gzip', 'content-length': String(z.length) }).end(z);
    }
    if (req.url === '/gzip-kucuk') {
      const z = zlib.gzipSync(PDF);
      return res.writeHead(200, { 'content-type': 'application/pdf', 'content-encoding': 'gzip', 'content-length': String(z.length) }).end(z);
    }
    if (req.url === '/chunked-buyuk') {
      // Boy bildirilmez; istemci bağlantıyı kesene kadar (ya da 40 MB'a kadar) yazılır
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.write(Buffer.from('%PDF-1.4\n'));
      const piece = Buffer.alloc(64 * 1024, 0x20);
      let n = 0;
      const timer = setInterval(() => {
        if (res.destroyed || n >= 640) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          return;
        }
        n++;
        state.chunkedWritten += piece.length;
        res.write(piece);
      }, 1);
      res.on('close', () => { state.chunkedClosedEarly = n < 640; clearInterval(timer); });
      return undefined;
    }
    if (req.url === '/boy-buyuk') {
      // 20 MB bildirilir; yalnızca başlangıç yollanır, gerisi beklenir
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(20 * MiB) });
      res.write(Buffer.from('%PDF-1.4\n'));
      res.on('close', () => { state.declaredClosedEarly = true; });
      return undefined;
    }
    if (req.url === '/akmayan') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.write(Buffer.from('%PDF-1.4\n'));
      res.on('close', () => { state.hangClosed = true; });
      return undefined;
    }
    return res.writeHead(404).end();
  });
  const lo = viaLoopback({ 'www.fgo.ro': www.port });
  const closed = (key) => new Promise((resolve) => { const t = setInterval(() => { if (state[key]) { clearInterval(t); resolve(true); } }, 5); setTimeout(() => { clearInterval(t); resolve(state[key]); }, 3000); });
  try {
    failed(await downloadFgoPdf('https://www.fgo.ro/gzip-buyuk', { fetchImpl: lo.fetchImpl, maxBytes: LIMIT }), 'PDF çok büyük');
    const small = await downloadFgoPdf('https://www.fgo.ro/gzip-kucuk', { fetchImpl: lo.fetchImpl, maxBytes: LIMIT });
    assert.equal(small.ok, true, 'sıkıştırılmış küçük PDF açılmış hâliyle alınır');
    assert.ok(small.bytes.equals(PDF));
    failed(await downloadFgoPdf('https://www.fgo.ro/chunked-buyuk', { fetchImpl: lo.fetchImpl, maxBytes: LIMIT }), 'PDF çok büyük');
    assert.equal(await closed('chunkedClosedEarly'), true, 'bağlantı gövde bitmeden kapandı');
    assert.ok(state.chunkedWritten < 40 * MiB, `sunucu gövdenin tamamını yollayamadı (${state.chunkedWritten})`);
    failed(await downloadFgoPdf('https://www.fgo.ro/boy-buyuk', { fetchImpl: lo.fetchImpl }), 'PDF çok büyük');
    assert.equal(await closed('declaredClosedEarly'), true, 'büyük bildirilen gövde beklenmeden bağlantı kapandı');
    const t0 = Date.now();
    failed(await downloadFgoPdf('https://www.fgo.ro/akmayan', { fetchImpl: lo.fetchImpl, timeoutMs: 200 }), 'zaman aşımı');
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(await closed('hangClosed'), true, 'süre dolunca bağlantı kapandı');
    assert.deepEqual(lo.escaped, []);
  } finally {
    await www.close();
  }
});

// ---------- e-posta ----------
test('e-posta: FGO\'nun verdiği bağlantı yalnızca FGO adresiyse yazılır; değilse bağlantı satırı hiç yok (metin ve HTML)', () => {
  const base = { kind: 'INVOICE', series: 'GKH', number: '90', orderNos: ['UMI7'], total: 121, firmName: 'Umi', attached: false, portalUrl: 'https://takip.test/belgeler' };
  const good = delivery.renderDocEmail({ ...base, link: 'https://www.fgo.ro/f/GKH90.pdf' });
  assert.match(good.text, /Document \(PDF\): https:\/\/www\.fgo\.ro\/f\/GKH90\.pdf/);
  assert.match(good.html, /<a href="https:\/\/www\.fgo\.ro\/f\/GKH90\.pdf">Deschide documentul \(PDF\)<\/a>/);
  for (const link of ['https://evil.example/fatura.pdf', 'http://www.fgo.ro/f.pdf', 'https://www.fgo.ro@evil.example/f.pdf', 'https://user:pw@www.fgo.ro/f.pdf', 'https://www.fgo.ro:8443/f.pdf', 'https://fgo.ro.evil.example/f.pdf', 'javascript:alert(1)', '//evil.example/x', '"><script>x</script>']) {
    const mail = delivery.renderDocEmail({ ...base, link });
    for (const part of [mail.text, mail.html]) {
      assert.ok(!part.includes('Document (PDF)') && !part.includes('Deschide documentul'), link);
      assert.doesNotMatch(part, /evil|javascript:|script>|8443|user:pw|http:\/\/www\.fgo/, link);
    }
    // Belge bilgisi ve portal bağlantısı yerinde
    assert.match(mail.text, /Număr document: GKH90/);
    assert.match(mail.text, /https:\/\/takip\.test\/belgeler/);
  }
  // PDF ekteyken bağlantı zaten yazılmaz
  assert.ok(!/fgo\./.test(delivery.renderDocEmail({ ...base, attached: true, link: 'https://www.fgo.ro/f/GKH90.pdf' }).text));
});

// ---------- yapı ----------
const walk = (dir, exts) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
  if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
  const p = `${dir}/${e.name}`;
  return e.isDirectory() ? walk(p, exts) : exts.test(e.name) ? [p] : [];
});

test('yapı: FGO\'nun verdiği adrese istek gönderen TEK yer downloadFgoPdf; bağlantı kayda ve çağırana yalnızca doğrulanmış gider', () => {
  const pdf = noComments(read('server/documents/fgo-pdf.js'));
  // Bağımsız dosya: içe aktarma yok; tek fetch çağrısı manual yönlendirme ile; gövde sınırsız okunmaz
  assert.doesNotMatch(pdf, /^\s*import\s/m);
  assert.equal((pdf.match(/fetchImpl\(/g) ?? []).length, 1);
  assert.match(pdf, /fetchImpl\(url, \{ redirect: 'manual', signal, headers: \{ accept: 'application\/pdf' \} \}\)/);
  for (const never of ['.arrayBuffer(', '.text(', '.blob(', '.json(', '.bytes(', "redirect: 'follow'", 'console.']) assert.ok(!pdf.includes(never), never);
  assert.match(pdf, /pdfUrl\(new URL\(location, url\)\.toString\(\)\)/, 'Location çözülür ve doğrulanır');
  // Hedef doğrulaması isteğin ÖNÜNDE: döngüde fetch yalnızca pdfUrl'den geçmiş `url` ile çağrılır
  assert.ok(pdf.indexOf('let url = pdfUrl(link)') < pdf.indexOf('fetchImpl(url'));
  // Sunucuda başka hiçbir yer redirect seçeneği vermez / FGO bağlantısını kendisi indirmez
  const server = walk('server', /\.js$/).concat(walk('lib', /\.tsx?$/), walk('app', /\.tsx?$/), walk('scripts', /\.m?js$/));
  assert.deepEqual(server.filter((f) => /redirect:\s*['"]/.test(noComments(read(f)))), ['server/documents/fgo-pdf.js']);
  const del = noComments(read('server/documents/delivery.js'));
  assert.ok(!del.includes('fetchImpl(') && !del.includes('.arrayBuffer('), 'delivery.js kendisi indirme yapmaz');
  assert.equal((del.match(/downloadFgoPdf\(/g) ?? []).length, 2);
  // factura/print bağlantısı: önce doğrulanır, sonra (yalnızca doğrulanmış değer) kayda yazılır
  const fetchDoc = del.slice(del.indexOf('export async function fetchDocPdf'), del.indexOf('// ---------- e-posta metni') === -1 ? undefined : del.indexOf('export const DOC_KIND_RO'));
  const order = ['let link = pdfUrl(doc.link)', 'await fgoPrint(', 'const fresh = pdfUrl(given)', "if (!fresh) return { ok: false, link, error: 'PDF adresi FGO adresi değil' }", 'data: { link: fresh }', 'downloadFgoPdf(fresh'].map((s) => fetchDoc.indexOf(s));
  assert.ok(order.every((i) => i >= 0), `fetchDocPdf adımları bulunamadı: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'doğrula → yaz → indir sırası');
  assert.equal((fetchDoc.match(/data: \{ link:/g) ?? []).length, 1);
  assert.ok(!/link: given|link = given|link = doc\.link/.test(fetchDoc), 'ham bağlantı yazılmaz / döndürülmez');
  // E-posta şablonu bağlantıyı kendisi de doğrular
  assert.match(del.slice(del.indexOf('export function renderDocEmail')), /link = pdfUrl\(link\);/);
  // PDF yolu (müşteri / muhasebe) yedek yönlendirmede yine doğrulanmış bağlantıyı kullanır
  assert.match(noComments(read('server/documents/pdf-access.js')), /link: pdfUrl\(r\.link\)/);
  // Sipariş okunurken profil belgesi bağlantıları doğrulanır (sayfaya ham değer taşınmaz)
  assert.match(noComments(read('lib/orders.ts')), /proformaLink: pdfUrl\(order\.profile\.proformaLink\), invoiceLink: pdfUrl\(order\.profile\.invoiceLink\)/);
});

test('yapı: sayfalarda ham mali belge bağlantılı href yok — her yer FgoDocLink (pdfUrl) kullanır', () => {
  const pages = walk('app', /\.tsx$/).concat(walk('components', /\.tsx$/));
  // href={…} ifadesinde "link" geçen her yer (Next <Link href> bileşeni hariç): yalnızca uygulama içi bildirim bağlantıları kalabilir
  const raw = [];
  for (const f of pages) {
    const src = noComments(read(f));
    for (const m of src.matchAll(/href=\{([^}]*)\}/g)) if (/link/i.test(m[1])) raw.push(`${f}: ${m[1].trim()}`);
  }
  assert.deepEqual(raw.sort(), ['components/NotificationCenter.tsx: n.link', 'components/NotificationCenter.tsx: toast.link'], 'bildirim bağlantıları uygulama içi yoldur (safeLink); FGO bağlantısı değildir');
  // FGO belge bağlantısı gösteren yerler ve kullanım sayıları
  const sites = {
    'app/(panel)/admin/muhasebe/ReceivablesView.tsx': 1,
    'app/(panel)/admin/muhasebe/cam/proforma/page.tsx': 1,
    'app/(panel)/siparisler/[id]/GlassFinance.tsx': 2,
    // Ödemeler ve avans kartı (Paket 10): profil siparişinin FGO belgeleri
    'app/(panel)/siparisler/[id]/OrderPayments.tsx': 1,
    'app/(panel)/siparisler/[id]/ProfileOrderView.tsx': 2,
    'app/(panel)/siparisler/[id]/page.tsx': 1,
    'app/(panel)/yuklemeler/LoadingBilling.tsx': 1,
  };
  const users = Object.fromEntries(pages.filter((f) => f !== 'components/FgoDocLink.tsx').map((f) => [f, (noComments(read(f)).match(/<FgoDocLink\b/g) ?? []).length]).filter(([, n]) => n > 0));
  assert.deepEqual(users, sites);
  // Belge bağlantısı alanı (link / proformaLink / invoiceLink) JSX'te yalnızca FgoDocLink'e verilir
  for (const f of Object.keys(sites)) {
    const src = noComments(read(f));
    // (üye erişimi: d.link, p.proformaLink, x.batch.document.link … — seçim / tür tanımındaki "link:" bunlara girmez)
    const uses = [...src.matchAll(/[\w.?]+\.(?:link|proformaLink|invoiceLink)\b/g)].map((m) => m[0]);
    assert.ok(uses.length >= sites[f], f);
    const given = [...src.matchAll(/<FgoDocLink\b[^>]*\blink=\{([^}]+)\}/g)].map((m) => m[1].trim());
    assert.equal(given.length, sites[f], f);
    for (const u of uses) assert.ok(given.includes(u), `${f}: ${u} yalnızca FgoDocLink'e verilmeli`);
  }
  // Bileşen: sunucuda çalışır, bağlantıyı pdfUrl'den geçirir, reddedilen adresi hiçbir biçimde yazmaz
  const comp = noComments(read('components/FgoDocLink.tsx'));
  assert.ok(!comp.includes("'use client'"));
  assert.match(comp, /const href = pdfUrl\(link\);/);
  assert.match(comp, /if \(!href\) return <>\{fallback === undefined \? children : fallback\}<\/>;/);
  assert.equal((comp.match(/\blink\b/g) ?? []).length, 3, 'link yalnızca parametre, tür ve pdfUrl çağrısında geçer');
  assert.match(comp, /<a className=\{className\} href=\{href\} target="_blank" rel="noopener noreferrer">/);
});
