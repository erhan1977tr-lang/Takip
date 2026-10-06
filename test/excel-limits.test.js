// Excel / ZIP okuyucularının kaynak sınırları (güvenlik denetimi 3.50.9 AUD-3, karar 140).
// Bütün girdiler küçük ve elle kurulmuştur (en büyüğü ~0,5 MB): amaç büyük bellek / işlemci tüketmek değil, sınırın
// küçük bir girdide de devreye girdiğini göstermektir (sınırlar testte küçültülerek ya da biçim bozularak denenir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { ZIP_LIMITS, ZipError, openZip, readZip, writeZip } from '../server/files/zip.js';
import { EXCEL_MAX_BYTES, SHEET_LIMITS, XlsxError, readXlsx, writeXlsx } from '../server/files/xlsx.js';
import { isXls, readXls } from '../server/files/xls.js';
import { checkContent } from '../server/files/signature.js';
import { IMPORT_MAX_COLS, IMPORT_MAX_ROWS, looksLikeHeader, validateImportRows } from '../server/orders/excel-import.js';
import { IMPORT_MAX_BYTES, readOfferExcel } from '../server/orders/excel-file.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name));
const KB = 1024;
/** Süre (ms) ve atılan hata */
const timed = (fn) => {
  const t0 = performance.now();
  let error = null;
  try { fn(); } catch (e) { error = e; }
  return { ms: performance.now() - t0, error };
};
/** Sabit tohumlu sözde rastgele sayı (testler her çalışmada aynı girdiyi üretir) */
const rng = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);

// ---------- ZIP: elle bozma yardımcıları ----------
/** Merkezi dizindeki girişler: { name, central, local } (konumlar) */
function entriesOf(zip) {
  let eocd = zip.length - 22;
  while (zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const out = [];
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < zip.readUInt16LE(eocd + 10); n++) {
    const nlen = zip.readUInt16LE(p + 28);
    out.push({ name: zip.subarray(p + 46, p + 46 + nlen).toString('utf8'), central: p, local: zip.readUInt32LE(p + 42) });
    p += 46 + nlen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return { eocd, list: out };
}
/** Bir girişin başlık alanlarını (merkezi dizin + yerel başlık) değiştirir; yeni tampon döner */
function patchEntry(zip, name, { usize, csize, method, flags } = {}) {
  const out = Buffer.from(zip);
  const e = entriesOf(out).list.find((x) => x.name === name);
  if (usize !== undefined) { out.writeUInt32LE(usize, e.central + 24); out.writeUInt32LE(usize, e.local + 22); }
  if (csize !== undefined) { out.writeUInt32LE(csize, e.central + 20); out.writeUInt32LE(csize, e.local + 18); }
  if (method !== undefined) { out.writeUInt16LE(method, e.central + 10); out.writeUInt16LE(method, e.local + 8); }
  if (flags !== undefined) { out.writeUInt16LE(flags, e.central + 8); out.writeUInt16LE(flags, e.local + 6); }
  return out;
}
const zeros = (n) => Buffer.alloc(n);
const isZipError = (e) => e instanceof ZipError;

test('ZIP: sınır beyan edilen değil GERÇEKTEN açılan bayttır — beyanı 0 / küçük / büyük olan giriş reddedilir', (t) => {
  const honest = writeZip([{ name: 'a.bin', data: zeros(256 * KB) }]);
  assert.ok(honest.length < 2 * KB, '256 KB sıfır birkaç yüz bayta sıkışır (küçük girdi, büyük çıktı)');
  assert.equal(readZip(honest).get('a.bin').length, 256 * KB, 'dürüst giriş okunur');

  // zlib'e verilen çıktı sınırı izlenir: beyan edilen boyuttan büyük olamaz
  const spy = t.mock.method(zlib, 'inflateRawSync');
  const caps = () => spy.mock.calls.map((c) => c.arguments[1].maxOutputLength);

  // Beyan 0, içerik 256 KB: eski okuyucu toplamı 0 sayıp girişi genel sınıra (50 MB) kadar açardı
  assert.throws(() => readZip(patchEntry(honest, 'a.bin', { usize: 0 })), isZipError);
  assert.deepEqual(caps(), [1], 'beyanı 0 olan giriş en çok 1 baytta durdurulur');
  // Beyan gerçeğin altında / üstünde: ikisi de reddedilir (boyut birebir aynı olmalı)
  assert.throws(() => readZip(patchEntry(honest, 'a.bin', { usize: 10 })), isZipError);
  assert.throws(() => readZip(patchEntry(honest, 'a.bin', { usize: 256 * KB + 1 })), /boyut uyuşmuyor/);
  assert.deepEqual(caps(), [1, 10, 256 * KB + 1]);

  // Çok girişli arşiv: her biri beyan 0 → ilk girişte durur (toplam, beyan 0 diye sınırsız büyümez)
  const many = Array.from({ length: 8 }, (_, i) => ({ name: `p${i}.bin`, data: zeros(64 * KB) }));
  let bomb = writeZip(many);
  for (const e of many) bomb = patchEntry(bomb, e.name, { usize: 0 });
  spy.mock.resetCalls();
  assert.throws(() => readZip(bomb, { maxTotal: 100 * KB }), isZipError);
  assert.equal(spy.mock.callCount(), 1, 'ilk bozuk girişten sonra başka giriş açılmaz');

  // Sıkıştırmasız (stored) girişte de boyut uyuşmalı
  const stored = Buffer.concat([Buffer.from('PK'), zeros(0)]);
  assert.throws(() => readZip(stored), isZipError);
  const one = writeZip([{ name: 's.txt', data: 'merhaba' }]);
  assert.throws(() => readZip(patchEntry(one, 's.txt', { method: 0 })), /boyut uyuşmuyor/, 'stored: sıkıştırılmış boyut ≠ beyan');
});

test('ZIP: giriş başına ve toplam açılmış bayt sınırı; yalnızca istenen giriş açılır', (t) => {
  assert.deepEqual(ZIP_LIMITS, { maxEntries: 2000, maxEntry: 16 * 1024 * KB, maxTotal: 32 * 1024 * KB });
  const zip = writeZip([{ name: 'kucuk.txt', data: 'abc' }, { name: 'b1.bin', data: zeros(64 * KB) }, { name: 'b2.bin', data: zeros(64 * KB) }, { name: 'b3.bin', data: zeros(64 * KB) }]);
  // Giriş sınırı
  assert.throws(() => readZip(zip, { maxEntry: 32 * KB }), /giriş çok büyük/);
  // Toplam sınır: gerçek baytla sayılır (64 + 64 sığar, üçüncüde aşılır)
  assert.throws(() => readZip(zip, { maxTotal: 150 * KB }), /açılmış boyut çok büyük/);
  assert.equal(readZip(zip, { maxTotal: 200 * KB }).size, 4);
  // Giriş sayısı
  assert.throws(() => readZip(zip, { maxEntries: 3 }), /çok fazla giriş/);

  // openZip: istenmeyen giriş hiç açılmaz; sayaç yalnızca açılanı sayar; aynı giriş ikinci kez açılmaz
  const spy = t.mock.method(zlib, 'inflateRawSync');
  const z = openZip(zip, { maxEntry: 32 * KB });
  assert.deepEqual(z.names(), ['kucuk.txt', 'b1.bin', 'b2.bin', 'b3.bin']);
  assert.equal(z.read('kucuk.txt').toString(), 'abc');
  assert.equal(z.read('kucuk.txt').toString(), 'abc');
  assert.equal(z.read('yok.txt'), null);
  assert.deepEqual([spy.mock.callCount(), z.inflated()], [1, 3]);
  assert.throws(() => z.read('b1.bin'), /giriş çok büyük/);
  assert.equal(spy.mock.callCount(), 1, 'sınırı aşan giriş açılmadan reddedilir');
});

test('ZIP: bozuk arşiv güvenle reddedilir (her zaman ZipError; RangeError sızmaz)', () => {
  const zip = writeZip([{ name: 'a.txt', data: 'bir' }, { name: 'b.txt', data: 'iki' }, { name: 'c.txt', data: 'üç'.repeat(200) }]);
  const { eocd, list } = entriesOf(zip);
  const patched = (fn) => { const b = Buffer.from(zip); fn(b); return b; };

  // Aynı veriyi gösteren iki giriş (üst üste binen girişler — küçük dosyadan çok büyük çıktı tekniği)
  assert.throws(() => readZip(patched((b) => b.writeUInt32LE(list[0].local, list[1].central + 42))), /üst üste binen/);
  // Yinelenen ad
  assert.throws(() => readZip(patched((b) => { b.write('a', list[1].central + 46); b.write('a', list[1].local + 30); })), /yinelenen giriş/);
  // Şifreli giriş, ZIP64 / çok parçalı arşiv, desteklenmeyen sıkıştırma
  assert.throws(() => readZip(patchEntry(zip, 'a.txt', { flags: 0x0801 })), /şifreli/);
  assert.throws(() => readZip(patched((b) => { b.writeUInt16LE(0xffff, eocd + 8); b.writeUInt16LE(0xffff, eocd + 10); })), /ZIP64/);
  assert.throws(() => readZip(patched((b) => b.writeUInt16LE(1, eocd + 4))), /desteklenmeyen arşiv/);
  assert.throws(() => readZip(patchEntry(zip, 'a.txt', { method: 12 })), /desteklenmeyen sıkıştırma/);
  // Veri / yerel başlık / merkezi dizin dosyanın dışını gösteriyor
  assert.throws(() => readZip(patchEntry(zip, 'c.txt', { csize: 0x7fffffff })), /bozuk giriş/);
  assert.throws(() => readZip(patched((b) => b.writeUInt32LE(0x7fffffff, list[2].central + 42))), /bozuk giriş/);
  assert.throws(() => readZip(patched((b) => b.writeUInt32LE(zip.length + 5, eocd + 16))), /bozuk merkezi dizin/);
  assert.throws(() => readZip(patched((b) => b.writeUInt16LE(0xffff, list[2].central + 28))), /bozuk merkezi dizin/, 'ad uzunluğu dizinin dışına taşıyor');
  // Bozuk sıkıştırılmış veri
  assert.throws(() => readZip(patched((b) => b.fill(0xff, list[2].local + 35, list[2].local + 45))), isZipError);
  // ZIP olmayan / çok kısa içerik
  for (const junk of [Buffer.alloc(0), Buffer.from('PK'), Buffer.from('%PDF-1.4 değil'), zeros(64)]) assert.throws(() => readZip(junk), isZipError);
  assert.throws(() => openZip('metin'), isZipError);

  // Her uzunlukta kesilmiş dosya ve rastgele bozulmuş baytlar: ya okunur ya ZipError — başka hata türü ve takılma yok
  const { ms } = timed(() => {
    for (let n = 0; n < zip.length; n += 3) {
      try { readZip(zip.subarray(0, n)); } catch (e) { assert.ok(isZipError(e), `kesik ${n}: ${e}`); }
    }
    const next = rng(7);
    for (let i = 0; i < 600; i++) {
      const b = Buffer.from(zip);
      for (let k = 0; k < 3; k++) b[next() % b.length] = next() & 0xff;
      try { readZip(b); } catch (e) { assert.ok(isZipError(e), `bozuk ${i}: ${e}`); }
    }
  });
  assert.ok(ms < 5000, `bozuk girdiler sınırlı sürede biter (${ms.toFixed(0)} ms)`);
});

// ---------- XLSX ----------
const WB = '<workbook xmlns:r="x"><sheets><sheet name="Sayfa" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
/** Parçaları elle verilen .xlsx (bozuk XML denemeleri için) */
const xlsxOf = ({ wb = WB, rels = RELS, sheet = '<worksheet><sheetData/></worksheet>', shared = null, extra = [] } = {}) => writeZip([
  { name: 'xl/workbook.xml', data: wb },
  ...(rels == null ? [] : [{ name: 'xl/_rels/workbook.xml.rels', data: rels }]),
  { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ...(shared == null ? [] : [{ name: 'xl/sharedStrings.xml', data: shared }]),
  ...extra,
]);
const sheetOf = (body) => `<worksheet><sheetData>${body}</sheetData></worksheet>`;
const isXlsxError = (e) => e instanceof XlsxError;

test('XLSX: sayfa / metin parçası beyanından fazla açılamaz; yalnızca gereken parçalar açılır', (t) => {
  const rows = [['Poz', 'En', 'Boy', 'Adet'], ['K1', 1000, 2000, 2]];
  const good = writeXlsx({ sheetName: 'Ölçüler', rows });
  assert.deepEqual(readXlsx(good).rows, rows);
  // Sayfanın beyan edilen boyutu 0 / yanlış → okunmaz
  assert.throws(() => readXlsx(patchEntry(good, 'xl/worksheets/sheet1.xml', { usize: 0 })), isXlsxError);
  assert.throws(() => readXlsx(patchEntry(good, 'xl/workbook.xml', { usize: 5 })), isXlsxError);

  // Dosyadaki öbür parçalar (resim, başka sayfa, stil) hiç açılmaz: bozuk / dev beyanlı olsalar da sayfa okunur
  let withJunk = xlsxOf({ sheet: sheetOf('<row r="1"><c r="A1" t="inlineStr"><is><t>merhaba</t></is></c><c r="B1"><v>7</v></c></row>'), extra: [{ name: 'xl/media/resim.bin', data: zeros(200 * KB) }, { name: 'xl/worksheets/sheet2.xml', data: zeros(200 * KB) }] });
  withJunk = patchEntry(patchEntry(withJunk, 'xl/media/resim.bin', { usize: 0 }), 'xl/worksheets/sheet2.xml', { usize: 0xfffffff0 });
  const spy = t.mock.method(zlib, 'inflateRawSync');
  assert.deepEqual(readXlsx(withJunk).rows, [['merhaba', 7]]);
  assert.equal(spy.mock.callCount(), 3, 'çalışma kitabı + ilişkiler + ilk sayfa (paylaşılan metin yok)');
  for (const c of spy.mock.calls) assert.ok(c.arguments[1].maxOutputLength <= ZIP_LIMITS.maxEntry);
});

test('XLSX: kapanış etiketi olmayan XML sınırlı sürede reddedilir (doğrusal tarama; karesel düzenli ifade yok)', () => {
  // Her girdi ~0,2–0,5 MB: eski tembel düzenli ifadeler kapanışı olmayan her açılış etiketinde metnin sonuna kadar
  // giderdi (bu boyutta saniyeler–dakikalar); yeni tarama ilk eksik kapanışta durur.
  const N = 40_000;
  const cell = (inner) => sheetOf(`<row r="1"><c r="A1" t="inlineStr">${inner}</c></row>`);
  const cases = {
    'row kapanmıyor': xlsxOf({ sheet: sheetOf('<row r="1">'.repeat(N)) }),
    'c kapanmıyor': xlsxOf({ sheet: sheetOf(`<row r="1">${'<c r="A1">'.repeat(N)}</row>`) }),
    'v kapanmıyor': xlsxOf({ sheet: sheetOf(`<row r="1"><c r="A1">${'<v>'.repeat(N)}</c></row>`) }),
    'is kapanmıyor': xlsxOf({ sheet: cell('<is>'.repeat(N)) }),
    't kapanmıyor': xlsxOf({ sheet: cell(`<is>${'<t>'.repeat(N)}</is>`) }),
    'rPh kapanmıyor': xlsxOf({ sheet: cell(`<is>${'<rPh>'.repeat(N)}</is>`) }),
    'si kapanmıyor': xlsxOf({ shared: `<sst>${'<si>'.repeat(N)}`, sheet: sheetOf('<row r="1"><c r="A1" t="s"><v>0</v></c></row>') }),
    'si içinde t kapanmıyor': xlsxOf({ shared: `<sst><si>${'<t>'.repeat(N)}</si></sst>` }),
    'row etiketi bitmiyor': xlsxOf({ sheet: `<worksheet><sheetData>${'<row r="1" '.repeat(N)}` }),
    'sheet etiketi bitmiyor': xlsxOf({ wb: `<workbook>${'<sheet '.repeat(N)}` }),
    'Relationship etiketi bitmiyor': xlsxOf({ rels: `<Relationships>${'<Relationship '.repeat(N)}` }),
  };
  let total = 0;
  for (const [name, buf] of Object.entries(cases)) {
    assert.ok(buf.length < 64 * KB, `${name}: küçük girdi (${buf.length} bayt)`);
    const { ms, error } = timed(() => readXlsx(buf));
    assert.ok(isXlsxError(error), `${name}: XlsxError bekleniyor, gelen: ${error}`);
    assert.ok(ms < 1500, `${name}: sınırlı süre (${ms.toFixed(0)} ms)`);
    total += ms;
  }
  assert.ok(total < 4000, `toplam ${total.toFixed(0)} ms`);

  // Çok sayıda (düzgün kapanmış) öğe de doğrusal sürede okunur: 40.000 boş satır
  const many = timed(() => assert.equal(readXlsx(xlsxOf({ sheet: sheetOf(Array.from({ length: N }, (_, i) => `<row r="${i + 1}"></row>`).join('')) })).rows.length, N));
  assert.equal(many.error, null);
  assert.ok(many.ms < 1500, `40.000 satır: ${many.ms.toFixed(0)} ms`);
});

test('XLSX: satır / hücre / metin sınırları ve bozuk değerler denetimli hata verir', () => {
  assert.deepEqual(SHEET_LIMITS, { rows: 100_000, cols: 200, cells: 2_000_000 });
  // Satır numarası sınırın üstünde / geçersiz
  assert.throws(() => readXlsx(xlsxOf({ sheet: sheetOf('<row r="100002"><c r="A100002"><v>1</v></c></row>') })), /Çok fazla satır/);
  for (const r of ['0', '-3', '1.5', 'abc', '1e9999']) assert.throws(() => readXlsx(xlsxOf({ sheet: sheetOf(`<row r="${r}"></row>`) })), isXlsxError, `r=${r}`);
  // Bellek büyütme: satır başına tek hücre ama 201. sütunda → her satır 201 yer tutar; ~10.000 satırda sınır (2.000.000 yer)
  const wide = Array.from({ length: 10_000 }, (_, i) => `<row r="${i + 1}"><c r="GS${i + 1}"><v>1</v></c></row>`).join('');
  const bomb = xlsxOf({ sheet: sheetOf(wide) });
  assert.ok(wide.length < 512 * KB && bomb.length < 64 * KB);
  const r = timed(() => readXlsx(bomb));
  assert.match(String(r.error?.message), /Çok fazla hücre/);
  assert.ok(isXlsxError(r.error) && r.ms < 3000, `${r.ms.toFixed(0)} ms`);
  // Aynı genişlikte ama sınırın altında kalan dosya okunur (sınır gerçekçi dosyayı kesmez: 2.000 satır × 201 sütun)
  const ok = readXlsx(xlsxOf({ sheet: sheetOf(Array.from({ length: 2000 }, (_, i) => `<row r="${i + 1}"><c r="GS${i + 1}"><v>${i}</v></c></row>`).join('')) })).rows;
  assert.deepEqual([ok.length, ok[1999].length, ok[1999][200]], [2000, 201, 1999]);
  // 200. sütundan sonrası yok sayılır (hata değil)
  assert.deepEqual(readXlsx(xlsxOf({ sheet: sheetOf('<row r="1"><c r="A1"><v>1</v></c><c r="ZZ1"><v>2</v></c></row>') })).rows, [[1]]);
  // Geçersiz karakter başvurusu hata fırlatmaz (U+FFFD); geçerlisi çözülür
  const chars = readXlsx(xlsxOf({ sheet: sheetOf('<row r="1"><c r="A1" t="inlineStr"><is><t>a&#x110000;b&#xD800;c&#99999999999;d&#x41;&amp;</t></is></c></row>') })).rows[0][0];
  assert.equal(chars, 'a�b�c�dA&');
  // Kendiliğinden kapanan öğeler ayrı öğedir (boş metin / boş satır); sonraki öğeyle birleşmez
  const selfClosed = xlsxOf({ shared: '<sst><si/><si><t>b</t></si><si><r><t/></r><r><t>c</t></r></si></sst>', sheet: sheetOf('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1"/></row><row r="2"/><row r="3"><c r="A3"><v>4</v></c></row>') });
  assert.deepEqual(readXlsx(selfClosed).rows, [['', 'b', 'c', null], [], [4]]);
  // Okuyucunun kendi boyut sınırı: 5 MB'tan büyük içerik hiç ayrıştırılmaz
  assert.equal(EXCEL_MAX_BYTES, 5 * 1024 * 1024);
  assert.throws(() => readXlsx(Buffer.alloc(EXCEL_MAX_BYTES + 1)), /çok büyük/);
  assert.throws(() => readXls(Buffer.alloc(EXCEL_MAX_BYTES + 1)), /çok büyük/);
  assert.throws(() => readXlsx('metin'), isXlsxError);
});

// ---------- XLS (OLE2 / BIFF8) ----------
const END = 0xfffffffe, FREE = 0xffffffff;
const u32 = (b, off, v) => b.writeUInt32LE(v >>> 0, off);
/** BIFF kaydı */
const rec = (id, data = Buffer.alloc(0)) => { const h = Buffer.alloc(4); h.writeUInt16LE(id, 0); h.writeUInt16LE(data.length, 2); return Buffer.concat([h, data]); };
const bofRec = (type) => { const d = Buffer.alloc(16); d.writeUInt16LE(0x0600, 0); d.writeUInt16LE(type, 2); return rec(0x0809, d); };
const numberRec = (row, col, v) => { const d = Buffer.alloc(14); d.writeUInt16LE(row, 0); d.writeUInt16LE(col, 2); d.writeDoubleLE(v, 6); return rec(0x0203, d); };
const labelRec = (row, col, s) => { const d = Buffer.alloc(9 + s.length * 2); d.writeUInt16LE(row, 0); d.writeUInt16LE(col, 2); d.writeUInt16LE(s.length, 6); d[8] = 1; d.write(s, 9, 'utf16le'); return rec(0x0204, d); };
/** Tek sayfalı BIFF8 akışı: genel bölüm (+ isteğe bağlı kayıtlar) + sayfa kayıtları */
function biff(sheetRecords, { globals = [] } = {}) {
  const name = 'Sayfa1';
  const bs = Buffer.alloc(8 + name.length); // konum u32, görünürlük, tür, ad uzunluğu, bayrak, ad
  bs[6] = name.length; bs.write(name, 8, 'latin1');
  const head = [bofRec(0x0005), ...globals];
  const pos = Buffer.concat(head).length + 4 + bs.length + 4; // BOUNDSHEET + EOF'tan sonra
  bs.writeUInt32LE(pos, 0);
  return Buffer.concat([...head, rec(0x0085, bs), rec(0x000a), bofRec(0x0010), ...sheetRecords, rec(0x000a)]);
}
/** En küçük OLE2 bileşik belge: FAT sektör(ler)i + dizin + "Workbook" akışı (≥ 4096 bayt: mini akış kullanılmaz) */
function ole(stream) {
  const S = 512;
  const body = Buffer.concat([stream, Buffer.alloc(Math.max(0, 4096 - stream.length))]);
  const data = Math.ceil(body.length / S);
  let nFat = 1;
  while (nFat * 128 < nFat + 1 + data) nFat++;
  const total = nFat + 1 + data;
  const out = Buffer.alloc(S * (total + 1));
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(out, 0);
  out.writeUInt16LE(0x3e, 24); out.writeUInt16LE(3, 26); out.writeUInt16LE(0xfffe, 28);
  out.writeUInt16LE(9, 30); out.writeUInt16LE(6, 32);
  u32(out, 44, nFat); u32(out, 48, nFat); u32(out, 56, 4096); u32(out, 60, END); u32(out, 68, END);
  for (let i = 0; i < 109; i++) u32(out, 76 + i * 4, i < nFat ? i : FREE);
  const fat = (n, v) => u32(out, S + n * 4, v);
  for (let n = 0; n < nFat * 128; n++) fat(n, FREE);
  for (let n = 0; n < nFat; n++) fat(n, 0xfffffffd);
  fat(nFat, END); // dizin
  for (let n = 0; n < data; n++) fat(nFat + 1 + n, n === data - 1 ? END : nFat + 2 + n);
  const dir = S * (nFat + 1);
  const entry = (i, name, type, start, size) => {
    const off = dir + i * 128;
    out.write(name, off, 'utf16le'); out.writeUInt16LE((name.length + 1) * 2, off + 64); out[off + 66] = type;
    u32(out, off + 116, start); u32(out, off + 120, size);
  };
  entry(0, 'Root Entry', 5, END, 0);
  entry(1, 'Workbook', 2, nFat + 1, body.length);
  body.copy(out, S * (nFat + 2));
  return out;
}

test('XLS: DIFAT döngüsü / yinelenen sektör ilk tekrarda reddedilir (sınırlı süre)', () => {
  const fx = fixture('olculer.xls'); // 512 baytlık başlık + 11 sektör; FAT sektörü 0
  const sectors = (fx.length - 512) / 512;
  assert.equal(readXls(fx).rows[1][1], 1000, 'özgün dosya okunur');
  /** Dosyanın sonuna DIFAT sektörü ekler: girişler `entries`, son 4 bayt sıradaki DIFAT sektörü */
  const withDifat = (list) => {
    const out = Buffer.concat([fx, Buffer.alloc(512 * list.length, 0xff)]);
    u32(out, 68, sectors); u32(out, 72, list.length);
    list.forEach(({ entries = [], next }, i) => {
      const off = 512 * (sectors + 1 + i);
      entries.forEach((e, k) => u32(out, off + k * 4, e));
      u32(out, off + 508, next);
    });
    return out;
  };
  const quick = (buf, what) => {
    const { ms, error } = timed(() => readXls(buf));
    assert.ok(isXlsxError(error), `${what}: XlsxError bekleniyor, gelen: ${error}`);
    assert.ok(ms < 1000, `${what}: ${ms.toFixed(0)} ms`);
  };
  // Düzgün (döngüsüz, boş) bir DIFAT sektörü kabul edilir — sınır geçerli dosyayı bozmaz
  assert.equal(readXls(withDifat([{ next: END }])).rows[1][1], 1000);
  // Kendini gösteren DIFAT sektörü. Eski okuyucu bunu 10.000 kez dolaşır, her turda aynı FAT sektörlerini yeniden
  // eklerdi (127 giriş × 10.000 tur → yüz milyonlarca FAT girişi); yeni okuyucu ikinci ziyarette durur.
  quick(withDifat([{ next: sectors }]), 'kendine dönen DIFAT');
  quick(withDifat([{ entries: Array(127).fill(1), next: sectors }]), 'kendine dönen, dolu DIFAT');
  // İki sektörlük döngü (A → B → A)
  quick(withDifat([{ next: sectors + 1 }, { next: sectors }]), 'iki sektörlük DIFAT döngüsü');
  // Aynı FAT sektörü iki kez listelenmiş (DIFAT içinde ve başlıkta)
  quick(withDifat([{ entries: [0], next: END }]), 'DIFAT başlıktaki FAT sektörünü yineliyor');
  quick(withDifat([{ entries: [3, 3], next: END }]), 'DIFAT aynı sektörü iki kez listeliyor');
  { const b = Buffer.from(fx); u32(b, 80, 0); quick(b, 'başlıkta yinelenen FAT sektörü'); }
  // Dosyanın dışını gösteren sektörler
  { const b = Buffer.from(fx); u32(b, 68, 5000); quick(b, 'DIFAT dosyanın dışında'); }
  { const b = Buffer.from(fx); u32(b, 80, 5000); quick(b, 'FAT sektörü dosyanın dışında'); }
  quick(withDifat([{ entries: [0x7fffffff], next: END }]), 'DIFAT girişi dosyanın dışında');
  // FAT zincirinde döngü (dizin zinciri kendine dönüyor)
  { const b = Buffer.from(fx); const dirStart = b.readUInt32LE(48); u32(b, 512 + dirStart * 4, dirStart); quick(b, 'kendine dönen dizin zinciri'); }
  // Biçimin izin vermediği sektör boyutları
  for (const [off, v] of [[30, 0], [30, 10], [30, 31], [30, 0xffff], [32, 0], [32, 9], [32, 0xffff]]) {
    const b = Buffer.from(fx); b.writeUInt16LE(v, off); quick(b, `sektör üssü @${off} = ${v}`);
  }
});

test('XLS: kesik / bozuk dosya her zaman XlsxError ile ve sınırlı sürede biter', () => {
  const fx = fixture('olculer.xls');
  const { ms } = timed(() => {
    for (let n = 0; n <= fx.length; n += 16) {
      try { readXls(fx.subarray(0, n)); } catch (e) { assert.ok(isXlsxError(e), `kesik ${n}: ${e}`); }
    }
    // Başlık, FAT ve akış baytları rastgele bozulur (sabit tohum): ya okunur ya XlsxError
    const next = rng(11);
    for (let i = 0; i < 1500; i++) {
      const b = Buffer.from(fx);
      for (let k = 0; k < 4; k++) b[next() % b.length] = next() & 0xff;
      try { readXls(b); } catch (e) { assert.ok(isXlsxError(e), `bozuk ${i}: ${e}`); }
    }
  });
  assert.ok(ms < 8000, `${ms.toFixed(0)} ms`);
});

test('XLS: elle kurulan dosya okunur; hücre / metin sınırı ve kayıt seli sınırlı kalır', () => {
  // Olağan dosya: başlık + ölçü satırları (genişlik / yükseklik / adet eşlemesi aynen çalışır)
  const normal = ole(biff([
    labelRec(0, 0, 'Poz'), labelRec(0, 1, 'Lățime'), labelRec(0, 2, 'Înălțime'), labelRec(0, 3, 'Adet'),
    labelRec(1, 0, 'K1'), numberRec(1, 1, 1000), numberRec(1, 2, 2000), numberRec(1, 3, 2),
    labelRec(2, 0, 'K2'), numberRec(2, 1, 850.4), numberRec(2, 2, 1950), numberRec(2, 3, 1),
  ]));
  assert.ok(isXls(normal));
  const { sheetName, rows } = readXls(normal);
  assert.equal(sheetName, 'Sayfa1');
  assert.deepEqual(rows, [['Poz', 'Lățime', 'Înălțime', 'Adet'], ['K1', 1000, 2000, 2], ['K2', 850.4, 1950, 1]]);
  const map = { width: 1, height: 2, qty: 3 };
  const v = validateImportRows(rows, map, { skipHeader: looksLikeHeader(rows, map) });
  assert.deepEqual([v.valid, v.invalid, v.rows.map((x) => [x.en, x.boy, x.adet])], [2, 0, [[1000, 2000, 2], [850, 1950, 1]]]);

  // Paylaşılan metin tablosu kayıt sınırında bölünmüş (SST + CONTINUE) ve iç içe bölüm (grafik) — kayıtlar tek tek okunurken de aynı sonuç
  const sstData = Buffer.concat([Buffer.from([2, 0, 0, 0, 2, 0, 0, 0]), Buffer.from([2, 0, 0]), Buffer.from('ab', 'latin1'), Buffer.from([4, 0, 0]), Buffer.from('cd', 'latin1')]);
  const labelSst = (row, col, i) => { const d = Buffer.alloc(10); d.writeUInt16LE(row, 0); d.writeUInt16LE(col, 2); d.writeUInt32LE(i, 6); return rec(0x00fd, d); };
  const split = ole(biff(
    [labelSst(0, 0, 0), labelSst(0, 1, 1), bofRec(0x0020), numberRec(5, 5, 99), rec(0x000a), numberRec(1, 0, 7)],
    { globals: [rec(0x00fc, sstData), rec(0x003c, Buffer.concat([Buffer.from([0]), Buffer.from('ef', 'latin1')]))] },
  ));
  assert.deepEqual(readXls(split).rows, [['ab', 'cdef'], [7]], 'bölünmüş metin birleşir; iç içe bölümdeki hücre okunmaz');

  // Bellek büyütme: satır başına tek sayı ama 201. sütunda → ~10.000 kayıtta (180 KB) hücre yeri sınırı
  const wide = ole(biff(Array.from({ length: 10_000 }, (_, i) => numberRec(i, 200, i))));
  assert.ok(wide.length < 256 * KB);
  const r = timed(() => readXls(wide));
  assert.match(String(r.error?.message), /Çok fazla hücre/);
  assert.ok(isXlsxError(r.error) && r.ms < 3000, `${r.ms.toFixed(0)} ms`);
  // Sınırın altındaki geniş dosya okunur (2.000 satır × 201 sütun)
  const okWide = readXls(ole(biff(Array.from({ length: 2000 }, (_, i) => numberRec(i, 200, i))))).rows;
  assert.deepEqual([okWide.length, okWide[1999].length, okWide[1999][200]], [2000, 201, 1999]);
  // 200. sütundan sonrası yok sayılır
  assert.deepEqual(readXls(ole(biff([numberRec(0, 0, 5), numberRec(0, 500, 6)]))).rows, [[5]]);

  // Paylaşılan metin tablosu: beyan edilen metin sayısı sınırın üstünde → hemen reddedilir
  const sst = Buffer.alloc(8); sst.writeUInt32LE(0xffffffff, 0); sst.writeUInt32LE(0xffffffff, 4);
  assert.throws(() => readXls(ole(biff([numberRec(0, 0, 1)], { globals: [rec(0x00fc, sst)] }))), /Çok fazla metin/);

  // Kayıt seli: 100.000 boş kayıt (400 KB) — kayıtlar biriktirilmez; dosya sınırlı sürede okunur
  const flood = ole(biff([...Array.from({ length: 100_000 }, () => rec(0x00e0)), numberRec(0, 0, 42)]));
  assert.ok(flood.length < 512 * KB);
  const f = timed(() => assert.deepEqual(readXls(flood).rows, [[42]]));
  assert.equal(f.error, null);
  assert.ok(f.ms < 3000, `${f.ms.toFixed(0)} ms`);
  // Kısa (kesik) hücre kaydı RangeError değil, denetimli hata ya da atlanan kayıt olur
  const short = ole(biff([rec(0x0204, Buffer.from([0, 0, 0, 0, 0, 0, 5]))]));
  try { readXls(short); } catch (e) { assert.ok(isXlsxError(e)); }
});

// ---------- Teklife aktarma: boyut sınırı okumadan önce ----------
test('teklif Excel\'i: 5 MB sınırı dosya okunmadan ve ayrıştırılmadan önce uygulanır', async () => {
  assert.equal(IMPORT_MAX_BYTES, 5 * 1024 * 1024);
  const calls = [];
  const io = (size) => ({
    stat: async () => { calls.push('stat'); return { size, isFile: () => true }; },
    readFile: async () => { calls.push('readFile'); return Buffer.alloc(0); },
    parse: () => { calls.push('parse'); return { rows: [] }; },
  });
  // Kayıtlı boyut sınırın üstünde: diske hiç bakılmaz
  assert.deepEqual(await readOfferExcel({ path: '/x/buyuk.xlsx', size: IMPORT_MAX_BYTES + 1 }, io(10)), { ok: false, error: 'TOO_BIG' });
  assert.deepEqual(calls, []);
  // Kayıtlı boyut küçük (ya da yok) ama diskteki dosya büyük: okunmaz, ayrıştırılmaz
  assert.deepEqual(await readOfferExcel({ path: '/x/buyuk.xlsx', size: 100 }, io(IMPORT_MAX_BYTES + 1)), { ok: false, error: 'TOO_BIG' });
  assert.deepEqual(await readOfferExcel({ path: '/x/buyuk.xlsx' }, io(90 * 1024 * 1024)), { ok: false, error: 'TOO_BIG' });
  assert.deepEqual(calls, ['stat', 'stat']);
  // Tam sınırdaki dosya okunur
  calls.length = 0;
  assert.deepEqual(await readOfferExcel({ path: '/x/sinir.xlsx', size: IMPORT_MAX_BYTES }, io(IMPORT_MAX_BYTES)), { ok: true, rows: [] });
  assert.deepEqual(calls, ['stat', 'readFile', 'parse']);
  // Okunan içerik yine de büyükse (stat ile okuma arasında değiştiyse) ayrıştırılmaz
  calls.length = 0;
  const grew = { ...io(10), readFile: async () => { calls.push('readFile'); return Buffer.alloc(IMPORT_MAX_BYTES + 1); } };
  assert.deepEqual(await readOfferExcel({ path: '/x/a.xlsx', size: 10 }, grew), { ok: false, error: 'TOO_BIG' });
  assert.deepEqual(calls, ['stat', 'readFile']);
  // Dosya yok / klasör / yol çözülemedi
  assert.deepEqual(await readOfferExcel({ path: null, size: 10 }), { ok: false, error: 'NO_FILE' });
  assert.deepEqual(await readOfferExcel({ path: path.join(os.tmpdir(), 'takip-yok-boyle-dosya.xlsx'), size: 10 }), { ok: false, error: 'NO_FILE' });
  assert.deepEqual(await readOfferExcel({ path: os.tmpdir(), size: 10 }), { ok: false, error: 'NO_FILE' });
  // Ayrıştırma hatası kullanıcıya "okunamadı" olarak döner (hata fırlatılmaz)
  assert.deepEqual(await readOfferExcel({ path: '/x/a.xlsx', size: 10 }, { ...io(10), parse: () => { throw new XlsxError('bozuk'); } }), { ok: false, error: 'UNREADABLE' });
  // Sonuç ön izleme sınırlarına kesilir ve metne çevrilir
  const big = { ...io(10), parse: () => ({ rows: Array.from({ length: IMPORT_MAX_ROWS + 50 }, (_, i) => Array.from({ length: IMPORT_MAX_COLS + 5 }, (_, c) => (c === 0 ? null : i))) }) };
  const cut = await readOfferExcel({ path: '/x/a.xlsx', size: 10 }, big);
  assert.deepEqual([cut.ok && cut.rows.length, cut.ok && cut.rows[7].length, cut.ok && cut.rows[7].slice(0, 2)], [IMPORT_MAX_ROWS, IMPORT_MAX_COLS, ['', '7']]);
});

test('teklif Excel\'i: olağan .xls ve .xlsx dosyaları diskten okunur; genişlik / yükseklik / adet eşlemesi aynı', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-excel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const map = { width: 1, height: 2, qty: 3 };
  const check = (res) => {
    assert.equal(res.ok, true);
    const v = validateImportRows(res.rows, map, { skipHeader: looksLikeHeader(res.rows, map) });
    assert.deepEqual([v.valid, v.invalid], [2, 2]);
    assert.deepEqual(v.rows.filter((x) => !x.errors.length).map((x) => [x.en, x.boy, x.adet]), [[1000, 2000, 2], [851, 1950, 1]]);
  };
  // .xls (depodaki gerçek örnek dosya)
  const xlsPath = path.join(ROOT, 'test', 'fixtures', 'olculer.xls');
  const xls = await readOfferExcel({ path: xlsPath, size: fs.statSync(xlsPath).size });
  check(xls);
  assert.deepEqual(xls.ok && xls.rows[0], ['Poz', 'Lățime', 'Înălțime', 'Adet', 'Not']);
  assert.deepEqual(xls.ok && xls.rows[1], ['K1', '1000', '2000', '2', 'Şeffaf']);
  // .xlsx (aynı satırlar) ve .xls adıyla kaydedilmiş .xlsx
  const rows = readXls(fixture('olculer.xls')).rows.map((r) => r.map((v) => v ?? ''));
  for (const name of ['olculer.xlsx', 'olculer-aslinda-xlsx.xls']) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, writeXlsx({ sheetName: 'Ölçüler', rows }));
    const res = await readOfferExcel({ path: p, size: fs.statSync(p).size });
    check(res);
    assert.deepEqual(res.ok && res.rows[1], ['K1', '1000', '2000', '2', 'Şeffaf']);
  }
  // Depodaki örnek .xlsx dosyaları (katalog, fiyat listesi) aynen okunur
  assert.equal(readXlsx(fixture('cam-katalogu.xlsx')).sheetName.length > 0, true);
  assert.ok(readXlsx(fixture('fiyat-listesi.xlsx')).rows.length > 3);
  // Bozuk içerik: denetimli sonuç
  const bad = path.join(dir, 'bozuk.xlsx');
  fs.writeFileSync(bad, 'bu bir excel değil');
  assert.deepEqual(await readOfferExcel({ path: bad, size: 18 }), { ok: false, error: 'UNREADABLE' });
});

test('yapı: Excel okuyan her işlem önce boyuta bakar; yükleme yolu Excel / ZIP okuyucusunu kullanmaz', () => {
  // Teklif işlemi: okuma ve ayrıştırma yalnızca readOfferExcel üzerinden (dosyayı kendisi okumaz)
  const action = read('app/(panel)/siparisler/[id]/actions.ts');
  const body = action.slice(action.indexOf('export async function readOfferExcelAction'));
  assert.match(body, /await readOfferExcel\(\{ path: resolveKey\(file\.storageKey\), size: file\.size \}\)/);
  assert.match(body, /requirePermission\('OFFER_PREPARE'\)/, 'yetki değişmedi');
  assert.match(body, /offer\.import\.tooBig/);
  assert.doesNotMatch(action, /readFile\(|readXlsx\(|readXls\(|from 'node:fs/, 'işlem dosyayı doğrudan okumaz');
  // Kullanıcı metni iki dilde, teknik olmayan
  for (const loc of ['tr', 'ro']) assert.match(read(`server/i18n/${loc}/offer.js`), /tooBig: '[^']*5 MB[^']*'/);
  // Yönetim Excel yüklemeleri: readXlsx'ten önce 5 MB denetimi (değişmedi)
  for (const f of ['fiyatlar', 'stok', 'katalog', 'profil-katalogu']) {
    const src = read(`app/(panel)/admin/${f}/actions.ts`);
    const gate = src.search(/file\.size > (MAX_FILE|5 \* 1024 \* 1024)/);
    assert.ok(gate > 0 && gate < src.indexOf('readXlsx(Buffer.from'), `${f}: boyut denetimi okumadan önce`);
  }
  // Okuyucuların başka çağıranı yok (yeni bir çağıran boyut denetimi olmadan eklenemesin diye)
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!['node_modules', '.next'].includes(e.name)) walk(rel); continue; }
      if (!/\.(js|ts|tsx|mjs)$/.test(e.name)) continue;
      // yorum satırları sayılmaz
      const code = read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      if (/\b(readXlsx|readXls|parseExcel|readZip|openZip)\(/.test(code)) callers.push(rel);
    }
  };
  for (const d of ['app', 'lib', 'server', 'components', 'scripts']) if (fs.existsSync(path.join(ROOT, d))) walk(d);
  assert.deepEqual(callers.sort(), [
    'app/(panel)/admin/fiyatlar/actions.ts', 'app/(panel)/admin/katalog/actions.ts', 'app/(panel)/admin/profil-katalogu/actions.ts',
    'app/(panel)/admin/stok/actions.ts', 'server/files/xls.js', 'server/files/xlsx.js', 'server/files/zip.js', 'server/orders/excel-file.js',
  ]);
  // Dosya yükleme / indirme / tarama yolu bu okuyucuları içe aktarmaz: yükleme, çizim, PDF ve katalog görselleri etkilenmez
  for (const f of ['server/files/store.js', 'server/files/limits.js', 'server/files/signature.js', 'server/files/antivirus.js', 'lib/uploads.ts', 'lib/storage.ts']) {
    assert.doesNotMatch(read(f), /files\/(zip|xlsx|xls)\.js/, f);
  }
  // İçerik türü denetimi aynı: Excel, PDF, görsel ve çizim dosyaları eskisi gibi kabul edilir
  assert.equal(checkContent('olculer.xls', fixture('olculer.xls')).ok, true);
  assert.equal(checkContent('katalog.xlsx', fixture('cam-katalogu.xlsx')).ok, true);
  assert.equal(checkContent('cizim.pdf', Buffer.from('%PDF-1.7\n1 0 obj')).ok, true);
  assert.equal(checkContent('urun.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])).ok, true);
  assert.equal(checkContent('cizim.dxf', Buffer.from('  0\r\nSECTION\r\n  2\r\nHEADER\r\n')).ok, true);
  // AUD-4'e ait ayarlara dokunulmadı
  assert.match(read('next.config.mjs'), /bodySizeLimit: '250mb'/);
});
