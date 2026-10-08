// Yükleme: dosya adı, içerik denetimi ve geçici dosya temizliği (GO-LIVE saldırı turu NEW-GL-02, karar 153).
// Eski hata: ham ada göre ".pdf" olan 184 karakterlik "….constructor.pdf" adı 180 karaktere kesilince ".constructor" ile
// bitiyordu; içerik denetimi düz nesnede "constructor" anahtarını (miras alınan işlev) bulup hata fırlatıyor, geçici dosya
// (UPLOAD_DIR/.gelen) kalıyordu — hiçbir kotanın saymadığı, kaydı olmayan kalıcı dosya. Aynı kesme, ".zip.pdf" adını
// ".zip" yapıp tür denetimini de atlatıyordu.
// Buradaki bütün dosyalar küçüktür ve geçici bir klasöre yazılır; ağ kullanılmaz (tarama işlevi testte verilir).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { checkContent } from '../server/files/signature.js';
import { ALLOWED_EXT, fileProblem } from '../server/orders/rules.js';
import { resetEnvCache } from '../server/env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj\n', 'latin1');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0]);
const EXE = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.from([0x90, 0, 3, 0, 0, 0, 4, 0])]);
/** Düz nesnenin miras aldığı bütün anahtarlar (constructor, toString, __proto__, hasOwnProperty…) */
const PROTO_KEYS = [...new Set([...Object.getOwnPropertyNames(Object.prototype), '__proto__', 'prototype'])];
/** Sabit tohumlu sözde rastgele sayı */
const rng = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const extOf = (name) => String(name).toLowerCase().split('.').pop();
/** Toplam uzunluğu n olan, verilen sonekle biten ad */
const padded = (n, tail, fill = 'a') => fill.repeat(n - tail.length) + tail;

let dir;
let store;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-yukleme-adi-'));
  process.env.UPLOAD_DIR = dir;
  resetEnvCache();
  store = await import('../server/files/store.js');
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** .gelen altındaki geçici dosyalar */
const temps = () => (fs.existsSync(path.join(dir, '.gelen')) ? fs.readdirSync(path.join(dir, '.gelen')) : []);
/** Kalıcı yerdeki dosyalar (YYYY/MM/…) */
const kept = () => {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (rel === '' && e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}`);
    }
  };
  walk(dir, '');
  return out.sort();
};
const wipe = () => { for (const k of kept()) fs.rmSync(path.join(dir, k)); };
const av = (onUnavailable = 'accept') => ({ enabled: true, host: 'x', port: 1, onUnavailable });
const scanWith = (status, extra = {}) => async () => ({ status, ...extra });

test('dosya adı: güvenli karakterler, en çok 180 karakter — kısaltırken uzantı korunur', () => {
  const { cleanFileName, FILE_NAME_MAX } = store;
  assert.equal(FILE_NAME_MAX, 180);
  // Olağan adlar aynen kalır
  for (const n of ['cizim.pdf', 'Ölçü listesi (son) – 2.xlsx', '.pdf', 'a', 'arsiv.tar.gz', 'İMZALI BELGE.JPG', 'x.constructor']) assert.equal(cleanFileName(n), n, n);
  // Klasör, yol ve denetim karakterleri
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('a\\b:c*d?"e<f>g|.pdf'), 'a_b_c_d__e_f_g_.pdf');
  assert.equal(cleanFileName('sat\u0000ır\n.pdf'), 'sat_ır_.pdf');
  assert.equal(cleanFileName('  bosluklu.pdf  '), 'bosluklu.pdf');
  for (const junk of ['', null, undefined, 42, {}, [], '   ', '/', '\n']) assert.equal(cleanFileName(junk), junk === '\n' ? '_' : 'dosya');

  // Sınır uzunlukları: 180'e kadar aynen; üstünde gövde kısalır, uzantı kalır
  for (const n of [1, 5, 179, 180]) assert.equal(cleanFileName(padded(Math.max(n, 5), '.pdf')), padded(Math.max(n, 5), '.pdf'));
  for (const n of [181, 182, 183, 184, 185, 191, 200, 255, 1000, 100_000]) {
    for (const ext of ALLOWED_EXT) {
      const out = cleanFileName(padded(n, `.${ext}`));
      assert.deepEqual([out.length, out.endsWith(`.${ext}`), out], [180, true, padded(180, `.${ext}`)], `${n} .${ext}`);
    }
  }
  // Saldırı adı: ham ad ".pdf", eski kesme ".constructor" bırakıyordu
  const attack = padded(184, '.constructor.pdf');
  assert.equal(attack.slice(0, 180).endsWith('.constructor'), true, 'eski davranış: uzantı "constructor" oluyordu');
  const cleaned = cleanFileName(attack);
  assert.deepEqual([cleaned.length, extOf(cleaned)], [180, 'pdf']);
  for (const key of PROTO_KEYS) {
    for (const n of [181, 184, 188, 200, 400]) {
      const name = padded(Math.max(n, key.length + 6), `.${key}.pdf`);
      const out = cleanFileName(name);
      assert.equal(extOf(out), 'pdf', `${key} ${n}`);
      assert.ok(out.length <= 180);
    }
  }
  // ".zip.pdf" kısalınca ".zip" olmaz (tür denetimini atlatma)
  assert.equal(extOf(cleanFileName(padded(184, '.zip.pdf'))), 'pdf');
  assert.equal(extOf(cleanFileName(padded(184, '.exe.pdf'))), 'pdf');
  // Büyük harfli uzantı aynen korunur
  assert.equal(cleanFileName(padded(300, '.PDF')).endsWith('.PDF'), true);
  // 10 karaktere kadar uzantı korunur; daha uzunu / harf-rakam dışı olanı uzantı sayılmaz (düz kesilir)
  assert.equal(cleanFileName(padded(300, '.abcdefghij')).endsWith('.abcdefghij'), true);
  assert.deepEqual([cleanFileName(padded(300, '.abcdefghijk')), cleanFileName(padded(300, '.p-f')), cleanFileName('b'.repeat(300))], ['a'.repeat(180), 'a'.repeat(180), 'b'.repeat(180)]);
  assert.equal(cleanFileName(`${'a'.repeat(200)}.`).length, 180);
  // Yarım vekil çift (emoji) bırakılmaz: sonuç her zaman geçerli metindir
  for (const lead of [175, 176, 177, 178, 179, 180]) {
    const out = cleanFileName(`${'a'.repeat(lead)}${'😀'.repeat(10)}.pdf`);
    assert.ok(out.isWellFormed() && out.length <= 180 && out.endsWith('.pdf'), `önek ${lead}`);
    const plain = cleanFileName(`${'a'.repeat(lead)}${'😀'.repeat(10)}`);
    assert.ok(plain.isWellFormed() && plain.length <= 180, `uzantısız, önek ${lead}`);
  }
  // Kendi çıktısına uygulanınca değişmez; izin verilen uzantı hiçbir uzunlukta değişmez (rastgele adlar)
  const next = rng(153);
  const alphabet = ['a', 'Z', '9', '.', ' ', '-', '_', 'ş', '😀', '/', '\\', ':', '\u0001', 'constructor', '__proto__', 'toString'];
  for (let i = 0; i < 3000; i++) {
    const ext = ALLOWED_EXT[next() % ALLOWED_EXT.length];
    const body = Array.from({ length: next() % 80 }, () => alphabet[next() % alphabet.length]).join('').repeat(1 + (next() % 4));
    const raw = `${body}x.${next() % 2 ? ext : ext.toUpperCase()}`;
    const out = cleanFileName(raw);
    assert.ok(out.length <= 180 && out.length > 0 && out.isWellFormed(), raw);
    assert.equal(extOf(out), ext, raw);
    assert.equal(extOf(out), extOf(raw), 'ham adın uzantısı = saklanan adın uzantısı');
    assert.equal(cleanFileName(out), out);
    assert.doesNotMatch(out, /[\u0000-\u001f\\/:*?"<>|]/);
  }
});

test('içerik denetimi: miras alınan anahtarlar (constructor, __proto__, toString…) bilinmeyen uzantıdır — hata fırlatılmaz', () => {
  assert.ok(PROTO_KEYS.includes('constructor') && PROTO_KEYS.includes('__proto__') && PROTO_KEYS.includes('toString') && PROTO_KEYS.includes('hasOwnProperty'));
  for (const key of PROTO_KEYS) {
    for (const name of [`a.${key}`, key, `.${key}`, `a.pdf.${key}`, `A.${key.toUpperCase()}`, `a.${key}.`]) {
      for (const head of [PDF, ZIP, EXE, Buffer.alloc(0)]) {
        let res;
        assert.doesNotThrow(() => { res = checkContent(name, head); }, `${name}`);
        assert.equal(res.ok, false, name);
        assert.deepEqual(Object.keys(res).sort(), ['kind', 'ok'], 'ret sonucu yalnızca tür bilgisini taşır');
      }
    }
  }
  // Eski hata: EXPECTED['constructor'] bir işlevdi → includes yok → TypeError
  assert.deepEqual(checkContent('a.constructor', PDF), { ok: false, kind: 'pdf' });
  assert.deepEqual(checkContent('a.__proto__', PDF), { ok: false, kind: 'pdf' });
  // Ad metin değilse de hata yok
  for (const odd of [null, undefined, 42, {}, [], Symbol.iterator.toString()]) assert.equal(checkContent(odd, PDF).ok, false);
  // Olağan türler aynen kabul edilir
  assert.deepEqual(checkContent('cizim.pdf', PDF), { ok: true, kind: 'pdf', mime: 'application/pdf' });
  assert.deepEqual(checkContent('arsiv.ZIP', ZIP), { ok: true, kind: 'zip', mime: 'application/zip' });
  assert.equal(checkContent('liste.xlsx', ZIP).ok, true);
  assert.equal(checkContent('fatura.pdf', EXE).ok, false);
  // Ham ada göre yapılan tür denetimi (çağıranlar) bu adlarda eskisi gibi: uzantı "pdf" → geçer; miras anahtarı → geçmez
  assert.equal(fileProblem(padded(184, '.constructor.pdf'), 10), null);
  for (const key of PROTO_KEYS) assert.deepEqual(fileProblem(`a.${key}`, 10), { code: 'type', name: `a.${key}` });
  assert.deepEqual(fileProblem('constructor', 10), { code: 'type', name: 'constructor' });
});

test('yükleme: "….constructor.pdf" / "….__proto__.pdf" ve sınır uzunlukları — hata yok, geçici dosya kalmaz', async () => {
  const { storeUpload, resolveKey } = store;
  wipe();
  // Saldırı adı + gerçek PDF: artık olağan bir PDF yüklemesidir (uzantı korunur)
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const name = padded(184, `.${key}.pdf`);
    const r = await storeUpload([PDF], { name }, { av: av(), scan: scanWith('clean') });
    assert.equal(r.ok, true, key);
    assert.deepEqual([r.file.name.length, extOf(r.file.name), r.file.mime, r.file.scanStatus], [180, 'pdf', 'application/pdf', 'CLEAN']);
    assert.match(r.file.storageKey, /^\d{4}\/\d{2}\/[0-9a-f]{32}\.pdf$/);
    assert.deepEqual(fs.readFileSync(resolveKey(r.file.storageKey)), PDF);
    assert.deepEqual(temps(), []);
    // Aynı ad, PDF olmayan içerik: denetimli ret
    const bad = await storeUpload([ZIP], { name }, { av: av(), scan: scanWith('clean') });
    assert.deepEqual([bad.ok, bad.code, extOf(bad.name)], [false, 'mismatch', 'pdf']);
    assert.deepEqual(temps(), []);
  }
  assert.equal(kept().length, 5);
  wipe();
  // Uzantısı doğrudan miras anahtarı olan adlar (çağıranın tür denetimi olmasa da): hata değil, ret
  for (const key of PROTO_KEYS) {
    for (const name of [`a.${key}`, key, padded(200, `.${key}`), padded(181, `.pdf.${key}`)]) {
      const r = await storeUpload([PDF], { name }, { av: av(), scan: scanWith('clean') });
      assert.deepEqual([r.ok, r.code], [false, 'mismatch'], name.slice(-30));
    }
  }
  assert.deepEqual([temps(), kept()], [[], []]);
  // Tür kararı KISALTILMAMIŞ adla verilir: olağan olmayan (uzun) uzantı düz kesilince ad ".pdf" ile bitse de kabul edilmez
  for (const [name, content] of [[`${'a'.repeat(176)}.pdf.${'x'.repeat(20)}`, PDF], [`${'a'.repeat(176)}.zip.${'y'.repeat(11)}`, ZIP], [`${'a'.repeat(176)}.pdf.p-f`, PDF]]) {
    assert.equal(/\.(pdf|zip)$/.test(name.slice(0, 180)), true, 'düz kesme adı izinli bir uzantıyla bitirirdi');
    const r = await storeUpload([content], { name }, { av: null });
    assert.deepEqual([r.ok, r.code], [false, 'mismatch'], name.slice(170));
  }
  assert.deepEqual([temps(), kept()], [[], []]);
  // Depo bağlantısı örneği: ham ad ".pdf" (izinli), içerik ZIP; eski kesme adı ".zip" yapıp ZIP'i kabul ettiriyordu
  const disguised = padded(184, '.zip.pdf');
  assert.equal(extOf(disguised.slice(0, 180)), 'zip');
  assert.deepEqual([extOf(disguised), ['pdf', 'jpg', 'jpeg', 'png'].includes(extOf(disguised))], ['pdf', true]);
  const z = await storeUpload([ZIP], { name: disguised }, { av: null });
  assert.deepEqual([z.ok, z.code], [false, 'mismatch']);
  assert.deepEqual([temps(), kept()], [[], []]);
  // Sınır uzunlukları (her biri ayrı yükleme): hepsi saklanır, ad en çok 180, uzantı aynı
  for (const n of [5, 179, 180, 181, 182, 183, 184, 185, 186, 200, 255, 4096]) {
    const r = await storeUpload([PDF], { name: padded(n, '.pdf') }, { av: null });
    assert.deepEqual([r.ok, r.file.name.length, extOf(r.file.name), r.file.scanStatus], [true, Math.min(n, 180), 'pdf', 'SKIPPED'], `uzunluk ${n}`);
    assert.equal(r.file.checksum, crypto.createHash('sha256').update(PDF).digest('hex'));
  }
  assert.deepEqual([temps(), kept().length], [[], 12]);
  // Ad hiç verilmezse / metin değilse: "dosya" → uzantısız → ret (hata değil)
  for (const meta of [{}, { name: null }, { name: 42 }, undefined]) {
    const r = await storeUpload([PDF], meta, { av: null });
    assert.deepEqual([r.ok, r.code, r.name], [false, 'mismatch', 'dosya']);
  }
  assert.deepEqual(temps(), []);
  wipe();
});

test('yükleme: her ret ve her hata aşamasında geçici dosya silinir; kalıcı yere yalnızca kabul edilen dosya geçer', async () => {
  const { storeUpload } = store;
  wipe();
  const seen = [];
  /** Tarama sırasında geçici dosya yerinde mi (ve tam içerikle mi)? */
  const spyScan = (result) => async (tmp) => {
    seen.push({ inIncoming: path.dirname(tmp) === path.join(dir, '.gelen'), bytes: fs.readFileSync(tmp).length, temps: temps().length });
    if (result instanceof Error) throw result;
    return result;
  };
  // Ret aşamaları
  assert.deepEqual(await storeUpload([Buffer.alloc(0)], { name: 'bos.pdf' }, { av: av(), scan: spyScan({ status: 'clean' }) }), { ok: false, code: 'empty', name: 'bos.pdf' });
  assert.deepEqual(await storeUpload([EXE], { name: 'sahte.pdf' }, { av: av(), scan: spyScan({ status: 'clean' }) }), { ok: false, code: 'mismatch', name: 'sahte.pdf' });
  assert.equal(seen.length, 0, 'boş / içeriği uyuşmayan dosya taranmaz');
  assert.deepEqual(await storeUpload([PDF], { name: 'v.pdf' }, { av: av(), scan: spyScan({ status: 'infected', signature: 'Eicar-Test-Signature' }) }), { ok: false, code: 'infected', name: 'v.pdf', signature: 'Eicar-Test-Signature' });
  assert.deepEqual(await storeUpload([PDF], { name: 'u.pdf' }, { av: av('reject'), scan: spyScan({ status: 'error', error: 'unreachable' }) }), { ok: false, code: 'av_unavailable', name: 'u.pdf', error: 'unreachable' });
  assert.deepEqual(seen, [{ inIncoming: true, bytes: PDF.length, temps: 1 }, { inIncoming: true, bytes: PDF.length, temps: 1 }]);
  assert.deepEqual([temps(), kept()], [[], []]);

  // Hata aşamaları: hata çağırana ulaşır, geçici dosya kalmaz
  await assert.rejects(storeUpload([PDF], { name: 't.pdf' }, { av: av(), scan: spyScan(new Error('tarama çöktü')) }), /tarama çöktü/);
  await assert.rejects(storeUpload([PDF], { name: 't.pdf' }, { av: null, io: { rename: async () => { throw Object.assign(new Error('taşınamadı'), { code: 'EXDEV' }); } } }), /taşınamadı/);
  // Kaynak akış yarıda koptu (istemci bağlantıyı kesti): yazılan parça silinir
  const broken = () => Readable.from((async function* gen() { yield PDF; yield Buffer.alloc(64 * 1024, 1); throw new Error('bağlantı koptu'); })());
  await assert.rejects(storeUpload(broken(), { name: 'yarim.pdf' }, { av: av(), scan: spyScan({ status: 'clean' }) }), /bağlantı koptu/);
  // Web akışı (File.stream()) da aynı yoldan geçer
  const web = new Blob([PDF]).stream();
  const viaWeb = await storeUpload(web, { name: 'web.pdf' }, { av: null });
  assert.equal(viaWeb.ok, true);
  // Geçersiz kaynak
  await assert.rejects(storeUpload(42, { name: 'x.pdf' }, { av: null }));
  assert.deepEqual([temps(), kept().length], [[], 1]);
  wipe();

  // Çok sayıda başarısız yükleme: diskte hiçbir şey birikmez (kota / kayıt dışı kalıcı tüketim yok)
  for (let i = 0; i < 60; i++) {
    const name = i % 3 === 0 ? padded(184, '.constructor.pdf') : i % 3 === 1 ? padded(184, '.zip.pdf') : `a${i}.__proto__`;
    const r = await storeUpload([Buffer.concat([ZIP, crypto.randomBytes(2048)])], { name }, { av: av(), scan: scanWith('clean') });
    assert.equal(r.ok, false);
  }
  assert.deepEqual([temps(), kept()], [[], []]);
});

test('yükleme: silme başarısız olursa işlem bozulmaz; bildirimde yalnızca aşama + hata kodu vardır (yol / ad / hata metni yok)', async (t) => {
  const { storeUpload, storeUploads, discardStored, cleanupCollector, reportCleanupFailure } = store;
  wipe();
  const secretPath = path.join(dir, '.gelen');
  const rmFail = (code) => async (full) => { throw Object.assign(new Error(`${code}: operation not permitted, unlink '${full}'`), { code, path: full, syscall: 'unlink' }); };
  const reports = [];
  const collect = (f) => reports.push(f);

  // Ret + silinemeyen geçici dosya: sonuç aynı ret; bildirim sabit biçimde
  const r = await storeUpload([EXE], { name: 'gizli-musteri-adi.pdf' }, { av: null, onCleanupFailure: collect, io: { rm: rmFail('EACCES') } });
  assert.deepEqual(r, { ok: false, code: 'mismatch', name: 'gizli-musteri-adi.pdf' });
  assert.deepEqual(reports, [{ stage: 'temp', code: 'EACCES' }]);
  assert.equal(temps().length, 1, 'bu testte silme bilerek engellendi');
  for (const f of temps()) fs.rmSync(path.join(secretPath, f));

  // Hata + silinemeyen geçici dosya: ASIL hata çağırana ulaşır (silme hatası onu örtmez)
  reports.length = 0;
  await assert.rejects(
    storeUpload([PDF], { name: 'a.pdf' }, { av: av(), scan: async () => { throw new Error('asıl hata'); }, onCleanupFailure: collect, io: { rm: rmFail('EBUSY') } }),
    (e) => e.message === 'asıl hata',
  );
  assert.deepEqual(reports, [{ stage: 'temp', code: 'EBUSY' }]);
  for (const f of temps()) fs.rmSync(path.join(secretPath, f));

  // Tanınmayan / biçimsiz hata kodu → UNKNOWN (kod alanına yol ya da metin sızamaz)
  for (const code of [undefined, null, 13, '', '../../etc', `EACCES ${secretPath}`, 'e'.repeat(10), 'E'.repeat(40), { toString: () => 'EACCES' }]) {
    reports.length = 0;
    const odd = async () => { throw Object.assign(new Error(`bozuk ${secretPath}`), { code }); };
    await storeUpload([EXE], { name: 'a.pdf' }, { av: null, onCleanupFailure: collect, io: { rm: odd } });
    assert.deepEqual(reports, [{ stage: 'temp', code: 'UNKNOWN' }], String(code));
    for (const f of temps()) fs.rmSync(path.join(secretPath, f));
  }
  // Hata nesnesi olmayan fırlatma ve bildirim işlevinin kendi hatası da işlemi bozmaz
  const thrown = await storeUpload([EXE], { name: 'a.pdf' }, { av: null, onCleanupFailure: () => { throw new Error('bildirim çöktü'); }, io: { rm: () => Promise.reject(null) } });
  assert.equal(thrown.code, 'mismatch');
  for (const f of temps()) fs.rmSync(path.join(secretPath, f));

  // Varsayılan bildirim (günlük): sabit metin + kod; yol, dosya adı, hata metni yok
  const log = t.mock.method(console, 'error', () => {});
  await storeUpload([EXE], { name: 'gizli-musteri-adi.pdf' }, { av: null, io: { rm: rmFail('EACCES') } });
  reportCleanupFailure({ stage: 'stored', code: 'EIO' });
  const lines = log.mock.calls.map((c) => c.arguments.join(' '));
  assert.deepEqual(lines, ['Yükleme temizliği başarısız (geçici dosya): EACCES', 'Yükleme temizliği başarısız (saklanan dosya): EIO']);
  for (const line of lines) assert.ok(!line.includes(dir) && !line.includes('gizli') && !line.includes('unlink') && !line.includes('/'), line);
  log.mock.restore();
  for (const f of temps()) fs.rmSync(path.join(secretPath, f));

  // Toplu saklamada silinemeyen (saklanmış) dosya: sonuç aynı; aşama "stored"
  reports.length = 0;
  const files = [{ name: 'bir.pdf', stream: () => [PDF] }, { name: 'iki.pdf', stream: () => [EXE] }];
  let rmCalls = 0;
  const onlyStoredFails = async (full, o) => { rmCalls++; if (!full.startsWith(secretPath)) throw Object.assign(new Error('x'), { code: 'EROFS' }); return fs.promises.rm(full, o); };
  const batch = await storeUploads(files, { av: null, onCleanupFailure: collect, io: { rm: onlyStoredFails } });
  assert.deepEqual([batch.ok, batch.problem.code, batch.problem.name], [false, 'mismatch', 'iki.pdf']);
  assert.deepEqual(reports, [{ stage: 'stored', code: 'EROFS' }]);
  assert.equal(rmCalls, 2);
  assert.deepEqual(temps(), []);
  wipe();

  // discardStored: hata fırlatmaz; silinemeyenleri sayar; geçersiz anahtarlar yok sayılır (klasör dışına çıkılamaz)
  reports.length = 0;
  const outside = path.join(os.tmpdir(), `takip-disarida-${crypto.randomBytes(6).toString('hex')}.txt`);
  fs.writeFileSync(outside, 'dokunulmaz');
  const one = await storeUpload([PDF], { name: 'sil.pdf' }, { av: null });
  assert.equal(await discardStored([{ storageKey: `../${path.basename(outside)}` }, { storageKey: outside }, { storageKey: null }, {}, null, one.file], { onCleanupFailure: collect }), 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'dokunulmaz');
  fs.rmSync(outside);
  assert.deepEqual([kept(), reports], [[], []]);
  assert.equal(await discardStored(undefined), 0);
  const two = await storeUpload([PDF], { name: 'kalir.pdf' }, { av: null });
  assert.equal(await discardStored([two.file, two.file], { onCleanupFailure: collect, rm: rmFail('EPERM') }), 2);
  assert.deepEqual(reports, [{ stage: 'stored', code: 'EPERM' }, { stage: 'stored', code: 'EPERM' }]);
  wipe();

  // Denetim kaydına girecek özet: yalnızca sayı, aşama(lar), kod(lar) — düşmanca girdide de
  const logged = [];
  const c = cleanupCollector((f) => logged.push(f));
  assert.equal(c.summary(), null);
  c.report({ stage: 'temp', code: 'EACCES' });
  c.report({ stage: 'stored', code: 'EACCES' });
  c.report({ stage: `stored ${secretPath}`, code: `EIO ${secretPath}`, path: secretPath, message: 'gizli' });
  c.report({ stage: 'stored', code: 'EIO', name: 'gizli-musteri-adi.pdf' });
  c.report(null);
  assert.deepEqual(c.summary(), { count: 5, stages: ['stored', 'temp'], codes: ['EACCES', 'EIO', 'UNKNOWN'] });
  assert.deepEqual(logged.map((f) => Object.keys(f).sort().join()), Array(5).fill('code,stage'));
  assert.ok(!JSON.stringify([c.summary(), logged]).includes('gizli') && !JSON.stringify([c.summary(), logged]).includes(dir));
  // Çok sayıda farklı kod: özet büyümez (en çok 8 kod); günlük işlevi çökerse toplama sürer
  const many = cleanupCollector(() => { throw new Error('günlük yazılamadı'); });
  for (let i = 0; i < 500; i++) many.report({ stage: 'temp', code: `E${i}` });
  assert.deepEqual([many.summary().count, many.summary().codes.length, many.summary().stages], [500, 8, ['temp']]);
});

test('toplu yükleme: ya hepsi ya hiçbiri — ret ya da hata olursa önce saklananlar da silinir', async () => {
  const { storeUploads, storeUpload } = store;
  wipe();
  const opened = [];
  const file = (name, content) => ({ name, stream: () => { opened.push(name); return typeof content === 'function' ? content() : [content]; } });
  // Hepsi geçerli: sırayla saklanır
  const all = await storeUploads([file('1.pdf', PDF), file(padded(184, '.constructor.pdf'), PDF), file('3.zip', ZIP)], { av: av(), scan: scanWith('clean') });
  assert.deepEqual([all.ok, all.files.map((f) => extOf(f.name)), all.files.map((f) => f.scanStatus)], [true, ['pdf', 'pdf', 'zip'], ['CLEAN', 'CLEAN', 'CLEAN']]);
  assert.deepEqual([temps(), kept().length], [[], 3]);
  wipe();

  // İkinci dosya reddedilir: birincisi silinir, üçüncüsü hiç açılmaz
  opened.length = 0;
  const rejected = await storeUploads([file('1.pdf', PDF), file('2.pdf', EXE), file('3.pdf', PDF)], { av: av(), scan: scanWith('clean') });
  assert.deepEqual(rejected, { ok: false, problem: { ok: false, code: 'mismatch', name: '2.pdf' } });
  assert.deepEqual([opened, temps(), kept()], [['1.pdf', '2.pdf'], [], []]);
  // Virüslü dosya: aynı
  let scans = 0;
  const secondInfected = async () => (++scans === 2 ? { status: 'infected', signature: 'Test-Imza' } : { status: 'clean' });
  const infected = await storeUploads([file('1.pdf', PDF), file('2.pdf', PDF), file('3.pdf', PDF)], { av: av(), scan: secondInfected });
  assert.deepEqual([infected.ok, infected.problem.code, infected.problem.signature, scans, temps(), kept()], [false, 'infected', 'Test-Imza', 2, [], []]);

  // İkinci dosyada HATA (akış koptu / açılamadı / taşınamadı): hata çağırana ulaşır, birincisi kalıcı yerde kalmaz
  const breaking = () => Readable.from((async function* gen() { yield PDF; throw new Error('akış koptu'); })());
  await assert.rejects(storeUploads([file('1.pdf', PDF), file('2.pdf', breaking), file('3.pdf', PDF)], { av: null }), /akış koptu/);
  assert.deepEqual([temps(), kept()], [[], []]);
  await assert.rejects(storeUploads([file('1.pdf', PDF), { name: '2.pdf', stream: () => { throw new Error('açılamadı'); } }], { av: null }), /açılamadı/);
  assert.deepEqual([temps(), kept()], [[], []]);
  let n = 0;
  const failSecondMove = async (from, to) => { if (++n === 2) throw Object.assign(new Error('disk doldu'), { code: 'ENOSPC' }); return fs.promises.rename(from, to); };
  await assert.rejects(storeUploads([file('1.pdf', PDF), file('2.pdf', PDF)], { av: null, io: { rename: failSecondMove } }), /disk doldu/);
  assert.deepEqual([n, temps(), kept()], [2, [], []]);
  // Saldırı adı toplu yüklemede: eski kod burada hata fırlatır, hem geçici dosyayı hem önceki dosyayı bırakırdı
  const mixed = await storeUploads([file('once.pdf', PDF), file(padded(184, '.constructor.pdf'), ZIP)], { av: null });
  assert.deepEqual([mixed.ok, mixed.problem.code, temps(), kept()], [false, 'mismatch', [], []]);

  // Boş liste; saklama işlevi verilebilir (testler) ve seçenekler ona aynen geçer
  assert.deepEqual(await storeUploads([], { av: null }), { ok: true, files: [] });
  const passed = [];
  await storeUploads([file('a.pdf', PDF)], { av: av('reject'), scan: scanWith('clean'), store: async (src, meta, opts) => { passed.push([meta, Object.keys(opts).sort()]); return storeUpload(src, meta, opts); } });
  assert.deepEqual(passed, [[{ name: 'a.pdf' }, ['av', 'scan']]]);
  wipe();
});

test('yapı: bütün yükleme yolları storeFiles → storeUploads üzerinden; temizlik kaydı yol / ad taşımaz', () => {
  const storeSrc = read('server/files/store.js');
  const uploads = read('lib/uploads.ts');
  // Geçici dosya her çıkışta silinir (try / finally); içerik denetimi kısaltılmamış adla; tablo yalnızca kendi anahtarlarıyla
  const fn = storeSrc.slice(storeSrc.indexOf('export async function storeUpload('), storeSrc.indexOf('export async function discardStored('));
  assert.match(fn, /let moved = false;\s*try \{[\s\S]*await rename\(tmp, full\);\s*moved = true;[\s\S]*\} finally \{[\s\S]*if \(!moved\) await removeQuietly\(tmp, 'temp', onCleanupFailure, rm\);\s*\}/);
  assert.match(fn, /const fullName = safeBase\(meta\?\.name\);\s*const name = shorten\(fullName\);/);
  assert.match(fn, /checkContent\(fullName, /);
  assert.doesNotMatch(fn, /checkContent\(name, /);
  assert.equal((fn.match(/fsp\.rm\(|\brm\(/g) ?? []).length, 0, 'storeUpload dosyayı yalnızca removeQuietly ile siler');
  assert.match(read('server/files/signature.js'), /Object\.hasOwn\(EXPECTED, ext\) \? EXPECTED\[ext\] : null/);
  assert.doesNotMatch(read('server/files/signature.js'), /= EXPECTED\[ext\];/);

  // lib/uploads.ts: tek dosya saklama işlevini doğrudan çağırmaz; silme hata fırlatmayan yoldan
  assert.match(uploads, /await storeUploads\(files\.map\(\(f\) => \(\{ name: f\.name, stream: \(\) => f\.stream\(\) \}\)\), \{ av, onCleanupFailure: cleanup\.report \}\)\s*\.finally\(\(\) => auditCleanup\(ctx, cleanup\.summary\(\)\)\);/);
  assert.doesNotMatch(uploads, /storeUpload\(|removeUpload\(|fsp\.|Promise\.all/);
  assert.match(uploads, /export async function discardFiles\([^)]*\) \{\s*const cleanup = cleanupCollector\(\);\s*await discardStored\(stored, \{ onCleanupFailure: cleanup\.report \}\);/);
  // Denetim kaydı: sayı + aşama + kod (+ depo bayrağı) — başka alan yok
  const auditFn = uploads.slice(uploads.indexOf('async function auditCleanup('), uploads.indexOf('export async function storeFiles('));
  assert.match(auditFn, /audit\('UPLOAD_CLEANUP_FAILED', 'Upload', ctx\.orderId \?\? null, ctx\.userId, \{\s*count: summary\.count, stages: summary\.stages, codes: summary\.codes, depot: ctx\.depot === true,\s*\}\);/);
  assert.doesNotMatch(auditFn, /name|path|message|storageKey/);
  // Sınır denetimi (AUD: yükleme kotaları) saklamadan önce — değişmedi
  assert.ok(uploads.indexOf('await checkUpload(') < uploads.indexOf('await storeUploads('));

  // Uygulamada dosya saklayan / silen başka yol yok
  const hits = { storeUpload: [], storeUploads: [], storeFiles: [], gelen: [] };
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (!['node_modules', '.next'].includes(e.name)) walk(p); continue; }
      if (!/\.(js|ts|tsx|mjs)$/.test(e.name)) continue;
      const code = read(p).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      if (/\bstoreUpload\(/.test(code)) hits.storeUpload.push(p);
      if (/\bstoreUploads\(/.test(code)) hits.storeUploads.push(p);
      if (/\bstoreFiles\(/.test(code)) hits.storeFiles.push(p);
      if (/'\.gelen'/.test(code)) hits.gelen.push(p);
    }
  };
  for (const d of ['app', 'lib', 'server', 'components', 'scripts']) walk(d);
  assert.deepEqual(hits.storeUpload, ['server/files/store.js']);
  assert.deepEqual(hits.storeUploads.sort(), ['lib/uploads.ts', 'server/files/store.js']);
  assert.deepEqual(hits.gelen, ['server/files/store.js'], 'geçici klasörü yalnızca saklama modülü kullanır');
  // Müşteri (yeni sipariş / taslak), ekip (çizim, dosya ekleme, teslim belgesi, katalog görseli, tedarikçi siparişinin teknik
  // eki — Paket 6) ve depo bağlantısı
  assert.deepEqual(hits.storeFiles.sort(), [
    'app/(panel)/admin/profil-katalogu/actions.ts', 'app/(panel)/siparisler/[id]/actions.ts', 'app/(panel)/siparisler/[id]/profile-actions.ts',
    'app/(panel)/siparisler/tedarik/actions.ts', 'app/(panel)/siparisler/yeni/actions.ts', 'app/depo/[token]/actions.ts', 'lib/uploads.ts',
  ]);
  // Tedarikçi siparişinin eki: işlem yapan bilgisi ve sınır denetimi dosyalar saklanmadan ÖNCE; kayıt olmazsa (hata ya da
  // red) saklanan dosyalar silinir
  const supplier = read('app/(panel)/siparisler/tedarik/actions.ts');
  const up = supplier.slice(supplier.indexOf('export async function uploadFilesAction('), supplier.indexOf('export async function removeFileAction('));
  assert.ok(up.indexOf('const actor = await actorOf(admin);') < up.indexOf('await fileQuota(') && up.indexOf('await fileQuota(') < up.indexOf('await storeFiles('));
  assert.match(up, /\} catch \(e\) \{\s*await discardFiles\(stored\.stored\);\s*throw e;\s*\}\s*if \(!r\.ok\) \{\s*await discardFiles\(stored\.stored\);/);
  // Saklandıktan sonra kayıt oluşmazsa dosyalar silinir (her yol)
  const newOrder = read('app/(panel)/siparisler/yeni/actions.ts');
  const create = newOrder.slice(0, newOrder.indexOf('function draftErrorText'));
  assert.ok(create.indexOf('const actor = await actorOf(user);') > 0 && create.indexOf('const actor = await actorOf(user);') < create.indexOf('await storeFiles('), 'saklama ile kayıt arasında hata verebilecek adım yok');
  assert.equal((create.match(/await discardFiles\(stored\.stored\);/g) ?? []).length, 2);
  const orderActions = read('app/(panel)/siparisler/[id]/actions.ts');
  assert.equal((orderActions.match(/\} catch \(e\) \{\s*await discardFiles\(stored\.stored\);\s*throw e;\s*\}/g) ?? []).length, 3, 'çizim yükleme + dosya ekleme + müşterinin düzeltilmiş DWG/DXF dosyası (karar 167)');
  // Müşterinin düzeltilmiş dosyası: yetki / durum dosyalar saklanmadan ÖNCE denetlenir; kayıt olmazsa dosyalar silinir
  const resubmit = orderActions.slice(orderActions.indexOf('export async function dwgResubmitAction('), orderActions.indexOf('export async function dwgRequestDrawingAction('));
  assert.ok(resubmit.indexOf("await ensureAllowed(user, id, 'dwg_resubmit');") > 0 && resubmit.indexOf("await ensureAllowed(user, id, 'dwg_resubmit');") < resubmit.indexOf('await storeFiles('));
  assert.match(resubmit, /await act\(user, id, 'dwg_resubmit', \{ files: stored\.stored \}\);\s*\} catch \(e\) \{\s*await discardFiles\(stored\.stored\);/);
  assert.match(read('app/(panel)/siparisler/[id]/profile-actions.ts'), /await act\(user, id, 'mark_delivered', \{ files: stored \}, \(\) => discardFiles\(stored\)\);/);
  const depot = read('app/depo/[token]/actions.ts');
  assert.equal((depot.match(/\} catch \(e\) \{\s*await discardFiles\(stored\.stored\);/g) ?? []).length, 2, 'teslim onayı + ek belge');
  assert.match(depot, /storeFiles\(files, \{ userId: null, orderId: p\.orderId, depot: true \}\)/);
  const catalogue = read('app/(panel)/admin/profil-katalogu/actions.ts');
  assert.match(catalogue, /try \{\s*data = full \? await fsp\.readFile\(full\) : null;\s*\} finally \{\s*await discardFiles\(\[s\]\);\s*\}/);
  assert.doesNotMatch(catalogue, /removeUpload/);
});
