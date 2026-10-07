import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { checkContent, detectKind } from '../server/files/signature.js';
import { eicar, parseReply, ping, scanBuffer, version } from '../server/files/clamav.js';
import { resetEnvCache } from '../server/env.js';

const b = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const SAMPLES = {
  pdf: b('%PDF-1.7\n%âãÏÓ\n1 0 obj'),
  png: b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  jpeg: b([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]),
  zip: b([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]),
  ole: b([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]),
  dwg: b('AC1032\0\0\0\0\0'),
  dxf: b('  0\r\nSECTION\r\n  2\r\nHEADER\r\n'),
  step: b('ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION'),
  iges: b(`${'IGES dosyasi'.padEnd(72)}S      1\n${' '.repeat(72)}G      1\n`),
  exe: b('MZ', [0x90, 0, 3, 0, 0, 0, 4, 0]),
  text: b('En;Boy;Adet\n1000;500;2\n'),
  rtf: b('{\\rtf1\\ansi\\deff0'),
};

test('dosya türü: içerikten belirlenir', () => {
  for (const kind of ['pdf', 'png', 'jpeg', 'zip', 'ole', 'dwg', 'dxf', 'step', 'iges', 'rtf']) {
    assert.equal(detectKind(SAMPLES[kind]), kind, kind);
  }
  assert.equal(detectKind(SAMPLES.text), 'text');
  assert.equal(detectKind(SAMPLES.exe), null);
  assert.equal(detectKind(Buffer.alloc(0)), null);
});

test('dosya türü: uzantı içerikle uyuşmalı (uzantıya güvenilmez)', () => {
  const ok = (name, head) => checkContent(name, head).ok;
  assert.ok(ok('cizim.PDF', SAMPLES.pdf));
  assert.ok(ok('foto.jpeg', SAMPLES.jpeg) && ok('foto.jpg', SAMPLES.jpeg));
  assert.ok(ok('plan.dwg', SAMPLES.dwg) && ok('plan.dxf', SAMPLES.dxf));
  assert.ok(ok('parca.step', SAMPLES.step) && ok('parca.stp', SAMPLES.step));
  assert.ok(ok('parca.igs', SAMPLES.iges) && ok('parca.iges', SAMPLES.iges));
  assert.ok(ok('liste.xlsx', SAMPLES.zip) && ok('liste.docx', SAMPLES.zip) && ok('arsiv.zip', SAMPLES.zip));
  assert.ok(ok('eski.xls', SAMPLES.ole) && ok('eski.doc', SAMPLES.ole));
  assert.ok(ok('liste.xls', SAMPLES.text), 'bazı programlar CSV\'yi .xls diye kaydeder');
  assert.ok(ok('mektup.doc', SAMPLES.rtf));
  assert.equal(checkContent('cizim.pdf', SAMPLES.pdf).mime, 'application/pdf');

  assert.ok(!ok('fatura.pdf', SAMPLES.exe), 'kılık değiştirmiş program');
  assert.ok(!ok('fatura.pdf', SAMPLES.text));
  assert.ok(!ok('foto.png', SAMPLES.jpeg));
  assert.ok(!ok('plan.dwg', SAMPLES.pdf));
  assert.ok(!ok('liste.xlsx', SAMPLES.text));
  assert.ok(!ok('program.exe', SAMPLES.exe));
});

test('clamd cevabı çözülür', () => {
  assert.deepEqual(parseReply('stream: OK'), { status: 'clean' });
  assert.deepEqual(parseReply('stream: Eicar-Test-Signature FOUND'), { status: 'infected', signature: 'Eicar-Test-Signature' });
  assert.equal(parseReply('INSTREAM size limit exceeded. ERROR').status, 'error');
});

// Sahte clamd: INSTREAM verisini okur, EICAR geçiyorsa "FOUND" der
let fake;
let port;
before(async () => {
  fake = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const text = buf.toString('latin1');
      if (text.startsWith('zPING\0')) return sock.end('PONG\0');
      if (text.startsWith('zVERSION\0')) return sock.end('ClamAV 1.4.1/27412/Tue Sep 29 08:21:03 2026\0');
      if (!text.startsWith('zINSTREAM\0')) return;
      // parçaları çöz; 0 uzunluklu parça bitiş
      let i = 'zINSTREAM\0'.length;
      const body = [];
      while (i + 4 <= buf.length) {
        const n = buf.readUInt32BE(i);
        if (n === 0) {
          const data = Buffer.concat(body).toString('latin1');
          return sock.end(data.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
        }
        if (i + 4 + n > buf.length) return;
        body.push(buf.subarray(i + 4, i + 4 + n));
        i += 4 + n;
      }
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  port = fake.address().port;
});
after(() => fake.close());

test('clamd istemcisi: temiz, virüslü, büyük dosya, ping, sürüm', async () => {
  const opts = { host: '127.0.0.1', port };
  assert.deepEqual(await scanBuffer(Buffer.from('merhaba'), opts), { status: 'clean' });
  assert.deepEqual(await scanBuffer(eicar(), opts), { status: 'infected', signature: 'Eicar-Test-Signature' });
  assert.deepEqual(await scanBuffer(crypto.randomBytes(300 * 1024), opts), { status: 'clean' }, 'birden çok parça');
  assert.equal(await ping(opts), true);
  assert.equal((await version(opts)).engine, 'ClamAV 1.4.1');
});

test('clamd istemcisi: ulaşılamazsa hata döner (çökmez)', async () => {
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const p = closed.address().port;
  await new Promise((r) => closed.close(r));
  const r = await scanBuffer(Buffer.from('x'), { host: '127.0.0.1', port: p, timeoutMs: 2000 });
  // Hata sabit koddur; ağ hatasının ham metni (ECONNREFUSED, adres, port) sonuca çıkmaz (karar 150)
  assert.deepEqual(r, { status: 'error', error: 'unreachable' });
  assert.equal(await ping({ host: '127.0.0.1', port: p }), false);
});

test('dosya saklama: özet, içerik kontrolü, antivirüs politikası', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-yukleme-'));
  process.env.UPLOAD_DIR = dir;
  resetEnvCache();
  const { storeUpload, resolveKey } = await import('../server/files/store.js');
  const pdf = Buffer.concat([SAMPLES.pdf, crypto.randomBytes(20000)]);
  const scanWith = (status, extra = {}) => async () => ({ status, ...extra });
  const av = (onUnavailable = 'accept') => ({ enabled: true, host: 'x', port: 1, onUnavailable });

  const clean = await storeUpload([pdf], { name: 'cizim.pdf' }, { av: av(), scan: scanWith('clean') });
  assert.equal(clean.ok, true);
  assert.equal(clean.file.checksum, crypto.createHash('sha256').update(pdf).digest('hex'));
  assert.equal(clean.file.size, pdf.length);
  assert.equal(clean.file.scanStatus, 'CLEAN');
  assert.equal(clean.file.mime, 'application/pdf');
  assert.match(clean.file.storageKey, /^\d{4}\/\d{2}\/[0-9a-f]{32}\.pdf$/);
  assert.ok(fs.existsSync(resolveKey(clean.file.storageKey)));

  const off = await storeUpload([pdf], { name: 'b.pdf' }, { av: null });
  assert.equal(off.file.scanStatus, 'SKIPPED');

  const infected = await storeUpload([pdf], { name: 'c.pdf' }, { av: av(), scan: scanWith('infected', { signature: 'Eicar-Test-Signature' }) });
  assert.deepEqual([infected.ok, infected.code, infected.signature], [false, 'infected', 'Eicar-Test-Signature']);

  const pending = await storeUpload([pdf], { name: 'd.pdf' }, { av: av('accept'), scan: scanWith('error', { error: 'ECONNREFUSED' }) });
  assert.equal(pending.file.scanStatus, 'PENDING', 'karar: ulaşılamazsa kabul et, taranmadı işaretle');

  const rejected = await storeUpload([pdf], { name: 'e.pdf' }, { av: av('reject'), scan: scanWith('error', { error: 'ECONNREFUSED' }) });
  assert.deepEqual([rejected.ok, rejected.code], [false, 'av_unavailable']);

  const fake = await storeUpload([SAMPLES.exe], { name: 'fatura.pdf' }, { av: av(), scan: scanWith('clean') });
  assert.deepEqual([fake.ok, fake.code], [false, 'mismatch']);

  // Reddedilen dosyalar diskte kalmaz
  const left = fs.readdirSync(path.join(dir, '.gelen'));
  assert.deepEqual(left, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
