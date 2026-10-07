// Antivirüs: tarayıcının adresi yalnızca sunucu ayarından gelir; karşı tarafa güvenilmez (karar 150; güvenlik denetimi
// 3.50.9 AUD-12). Gerçek istemci (server/files/clamav.js), ayar servisi (antivirus.js) ve saklama akışı (store.js) yalnızca
// 127.0.0.1 üzerindeki sahte TCP sunucularına karşı çalışır — dış ağ yok, gerçek ClamAV yok.
//   - hedef: veritabanındaki eski host / port okunmaz, kaydedilmez; yükleme ve arka plan taraması sunucu ayarındaki adrese gider
//   - yanıt: en çok 4096 bayt; mutlak süre (5 dakikayı aşamaz) ve hareketsizlik süresi birbirinden bağımsız
//   - karar: "temiz" yalnızca tam "stream: OK"; "… FOUND" her zaman virüs; bozuk / yabancı yanıt hatadır, temiz DEĞİL
//   - dışarı çıkan: yalnızca sabit hata kodu ve temizlenmiş imza adı (ham yanıt, ağ hatası metni, dosya yolu çıkmaz)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AV_ERRORS, REPLY_MAX_BYTES, SCAN_DEADLINE_MS, SIGNATURE_MAX, avErrorCode, deadlineOf, eicar, parseReply, ping, safeSignature, scanBuffer, scanFile, version,
} from '../server/files/clamav.js';
import { resetEnvCache } from '../server/env.js';
import { translate } from '../server/i18n/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const UPLOAD = fs.mkdtempSync(path.join(os.tmpdir(), 'takip-av-sert-'));
process.env.UPLOAD_DIR = UPLOAD;
resetEnvCache();
const { avHealth, avTarget, getAvSettings, saveAvSettings, scanPending } = await import('../server/files/antivirus.js');
const { storeUpload } = await import('../server/files/store.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
/** 127.0.0.1'de sahte sunucu; bağlantıları sayar, kapatılırken açık bağlantıları keser */
function listen(handler) {
  return new Promise((resolve) => {
    const s = { socks: new Set(), connections: 0, port: 0, server: null };
    s.server = net.createServer((sock) => {
      s.connections += 1;
      s.socks.add(sock);
      sock.on('error', () => {});
      sock.on('close', () => s.socks.delete(sock));
      handler(sock, s);
    });
    s.server.listen(0, '127.0.0.1', () => { s.port = s.server.address().port; servers.push(s); resolve(s); });
  });
}
const close = (s) => new Promise((r) => { for (const k of s.socks) k.destroy(); s.server.close(() => r()); });
after(async () => {
  for (const s of servers) await close(s).catch(() => {});
  fs.rmSync(UPLOAD, { recursive: true, force: true });
});
const at = (s, extra = {}) => ({ host: '127.0.0.1', port: s.port, ...extra });
/** Her isteğe aynı yanıtı verip kapatan sunucu */
const replying = (reply) => listen((sock) => { sock.on('data', () => {}); sock.end(reply); });
/** Dürüst sahte clamd: PING / VERSION / INSTREAM (EICAR geçiyorsa FOUND) */
function honest() {
  return listen((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const text = buf.toString('latin1');
      if (text.startsWith('zPING\0')) return sock.end('PONG\0');
      if (text.startsWith('zVERSION\0')) return sock.end('ClamAV 1.4.3/27784/Tue Oct  6 08:21:03 2026\0');
      if (!text.startsWith('zINSTREAM\0')) return;
      let i = 'zINSTREAM\0'.length;
      const body = [];
      while (i + 4 <= buf.length) {
        const n = buf.readUInt32BE(i);
        if (n === 0) return sock.end(Buffer.concat(body).toString('latin1').includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0');
        if (i + 4 + n > buf.length) return;
        body.push(buf.subarray(i + 4, i + 4 + n));
        i += 4 + n;
      }
    });
  });
}
/** Asılı kalırsa testi bekletmez: süre dolunca 'asılı' döner */
const within = (p, ms) => {
  let timer;
  const guard = new Promise((r) => { timer = setTimeout(() => r('asılı'), ms); });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
};
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj', 'latin1'), crypto.randomBytes(4000)]);

// ───────────────────────── olağan davranış korunur ─────────────────────────

test('dürüst tarayıcı: PING, VERSION, temiz dosya ve EICAR (virüs kararı ve imza adı) eskisi gibi', async () => {
  const s = await honest();
  assert.equal(await ping(at(s)), true);
  // Sürüm: yalnızca kalıptan çıkan parçalar (yanıtın ham hâli döndürülmez)
  assert.deepEqual(await version(at(s)), { engine: 'ClamAV 1.4.3', signatures: 27784, signaturesDate: 'Tue Oct  6 08:21:03 2026' });
  assert.deepEqual(await scanBuffer(Buffer.from('merhaba'), at(s)), { status: 'clean' });
  assert.deepEqual(await scanBuffer(crypto.randomBytes(300 * 1024), at(s)), { status: 'clean' }, 'birden çok parça');
  assert.deepEqual(await scanBuffer(eicar(), at(s)), { status: 'infected', signature: 'Win.Test.EICAR_HDB-1' });
  assert.deepEqual(await avHealth(at(s)), { reachable: true, engine: 'ClamAV 1.4.3', signatures: 27784, signaturesDate: 'Tue Oct  6 08:21:03 2026' });
  // Sınırlar: yanıt birkaç KB, mutlak süre 5 dakika, imza adı 200 karakter
  assert.deepEqual([REPLY_MAX_BYTES, SCAN_DEADLINE_MS, SIGNATURE_MAX], [4096, 300_000, 200]);
});

// ───────────────────────── yanıt biçimi: "temiz" yalnızca tam yanıt ─────────────────────────

test('yanıt kuralı: temiz yalnızca tam "stream: OK"; "… FOUND" her zaman virüs; bozuk / bilinmeyen yanıt hatadır — asla temiz değil', () => {
  for (const ok of ['stream: OK', 'stream: OK\0', 'stream: OK\n', 'stream: OK\r\n', Buffer.from('stream: OK\0')]) assert.deepEqual(parseReply(ok), { status: 'clean' });
  // Virüs kararı korunur (clamd'nin gerçek imza adları aynen kalır)
  for (const sig of ['Eicar-Test-Signature', 'Win.Test.EICAR_HDB-1', '{HEX}EICAR.TEST.3.UNOFFICIAL', 'Heuristics.Encrypted.Zip', 'PUA.Win.Packer.Upx-57', 'Sanesecurity.Malware.28711.UNOFFICIAL']) {
    assert.deepEqual(parseReply(`stream: ${sig} FOUND\0`), { status: 'infected', signature: sig });
  }
  // İçinde ne olursa olsun "… FOUND" virüstür (temize ya da hataya çevrilmez)
  for (const odd of ['stream: X\r\nenjekte satir FOUND', 'stream: OK\0stream: Y FOUND', 'stream: \x00\x01\x02 FOUND', 'stream: OK FOUND', `stream: ${'A'.repeat(5000)} FOUND`]) {
    assert.equal(parseReply(odd).status, 'infected', JSON.stringify(odd.slice(0, 40)));
  }
  // clamd'nin hata yanıtı
  assert.deepEqual(parseReply('INSTREAM size limit exceeded. ERROR\0'), { status: 'error', error: 'scanner-error' });
  // Bozuk, yabancı ya da "temiz"e benzeyen her şey hatadır
  const malformed = ['', '\0', 'OK', 'stream: ok', 'STREAM: OK', 'stream:OK', ' stream: OK', 'stream: OK ', 'stream: OK\0x', 'stream: OK\nstream: OK', 'foo: OK', '220 posta.internal: OK',
    'x: OK', 'PONG', 'stream: OKAY', 'stream: FOUND', 'stream: X FOUND ', 'HTTP/1.1 200 OK', '220 ic-posta.internal ESMTP Postfix', 'SSH-2.0-OpenSSH_9.6', '\xff\xfe\x00\x01', 'stream: OK'.repeat(3), null, undefined, 42];
  for (const bad of malformed) {
    const r = parseReply(bad);
    assert.notEqual(r.status, 'clean', `temiz sayılmamalı: ${JSON.stringify(bad)}`);
    assert.equal(r.status, 'error', JSON.stringify(bad));
    assert.ok(AV_ERRORS.includes(r.error), `sabit kod: ${r.error}`);
  }
});

test('imza adı: yalnızca güvenli karakterler, en çok 200; denetim / yazdırılamayan karakterler temizlenir; karar virüs kalır', () => {
  assert.equal(safeSignature('A'.repeat(1_000_000)).length, 200);
  assert.equal(safeSignature('Win.Test.EICAR_HDB-1'), 'Win.Test.EICAR_HDB-1');
  // Harf dışı her karakter (aksanlı harf, satır sonu, NUL, HTML / kabuk işaretleri) "?" olur; yinelenen boşluk tek boşluktur
  assert.equal(safeSignature('Kötü\r\nSatır\0<script>alert(1)</script>"\'&`'), 'K?t???Sat?r??script?alert(1)?/script?????');
  assert.equal(safeSignature('a\t\tb   c'), 'a??b c');
  for (const empty of ['', '   ', null, undefined]) assert.equal(safeSignature(empty), 'UNKNOWN');
  assert.equal(safeSignature('\x00\x01\x02'), '???');
  // Bütün baytlar: sonuçta yalnızca izinli karakterler
  const all = safeSignature(Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString('latin1'));
  assert.match(all, /^[A-Za-z0-9._:+/(){}[\] ?-]{1,200}$/);
  // parseReply üzerinden: uzun ve denetim karakterli imza → virüs + temiz ad
  const long = parseReply(`stream: ${'B'.repeat(3000)}\x07\x1b[31m FOUND\0`);
  assert.deepEqual([long.status, long.signature.length, /^[B]+$/.test(long.signature)], ['infected', 200, true]);
  const ctl = parseReply('stream: Ad\x1b[2J\r\nSahte: OK FOUND');
  assert.deepEqual(ctl, { status: 'infected', signature: 'Ad?[2J??Sahte: OK' });
});

test('hata kodları: her hata sabit koda çevrilir; ham metin hiçbir zaman geri verilmez', () => {
  assert.deepEqual([...AV_ERRORS], ['unreachable', 'timeout', 'response-too-large', 'invalid-response', 'scanner-error', 'file-not-found', 'file-error']);
  for (const code of AV_ERRORS) assert.equal(avErrorCode(code), code);
  const errno = (code) => Object.assign(new Error(`${code}: connect ${code} 10.0.0.5:3310 /gizli/yol`), { code });
  assert.deepEqual(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN'].map((c) => avErrorCode(errno(c))), Array(6).fill('unreachable'));
  assert.equal(avErrorCode(errno('ETIMEDOUT')), 'timeout');
  assert.equal(avErrorCode(errno('ENOENT')), 'file-not-found');
  assert.deepEqual(['EACCES', 'EISDIR', 'EPERM'].map((c) => avErrorCode(errno(c))), Array(3).fill('file-error'));
  // Ham metin (eski biçim) kod değildir → genel kod; içeriği dışarı çıkmaz
  for (const raw of ['ECONNREFUSED: connect ECONNREFUSED 10.0.0.5:3310', '220 ic-posta.internal ESMTP', 'ENOENT: /data/uploads/2026/10/x.pdf', '', 'disabled']) assert.equal(avErrorCode(raw), 'scanner-error');
  for (const odd of [null, undefined, 42, {}, new Error('düz hata')]) assert.ok(AV_ERRORS.includes(avErrorCode(odd)));
  // Her kodun iki dilde sabit metni var ("bilinmeyen" dahil)
  for (const code of [...AV_ERRORS, 'unknown']) for (const lang of ['tr', 'ro']) {
    const key = `admin.integrations.av.reason.${code}`;
    assert.notEqual(translate(lang, key), key, `${lang}: ${code}`);
  }
});

// ───────────────────────── düşmanca karşı taraf ─────────────────────────

test('yanıt boyutu: tam 4096 bayt kabul edilir, 4097 bayt reddedilir; 64 MB gönderen sunucu erken kesilir (bellek yanıtla büyümez)', async () => {
  const pad = (n) => `stream: ${'A'.repeat(n - 'stream:  FOUND\0'.length)} FOUND\0`;
  assert.equal(Buffer.byteLength(pad(REPLY_MAX_BYTES)), 4096);
  const exact = await replying(pad(REPLY_MAX_BYTES));
  const r1 = await scanBuffer(Buffer.from('x'), at(exact, { timeoutMs: 3000 }));
  assert.deepEqual([r1.status, r1.signature.length], ['infected', 200], 'sınırdaki yanıt okunur (karar virüs)');
  const over = await replying(pad(REPLY_MAX_BYTES + 1));
  assert.deepEqual(await scanBuffer(Buffer.from('x'), at(over, { timeoutMs: 3000 })), { status: 'error', error: 'response-too-large' });
  // 64 MB: sunucu yazmayı bitiremeden bağlantı kesilir
  const SIZE = 64 * 1048576;
  const stats = { sent: 0, finished: false, closed: false };
  const flood = await listen((sock) => {
    const chunk = Buffer.alloc(1048576, 0x41);
    const pump = () => {
      while (stats.sent < SIZE) { stats.sent += chunk.length; if (!sock.write(chunk)) return sock.once('drain', pump); }
      stats.finished = true;
      sock.end();
    };
    sock.on('close', () => { stats.closed = true; });
    pump();
  });
  const t0 = Date.now();
  const r = await within(scanBuffer(Buffer.from('x'), at(flood, { timeoutMs: 5000 })), 8000);
  assert.deepEqual(r, { status: 'error', error: 'response-too-large' });
  assert.ok(Date.now() - t0 < 5000, 'sınır aşılınca hemen döner');
  for (let i = 0; i < 100 && !stats.closed; i++) await sleep(20);
  assert.deepEqual([stats.closed, stats.finished], [true, false], 'bağlantı istemci tarafından kesildi; sunucu 64 MB\'ı gönderemedi');
  assert.ok(stats.sent < SIZE / 2, `sunucunun yazabildiği: ${stats.sent} bayt (64 MB'ın çok altında)`);
  assert.equal(JSON.stringify(r).includes('AAAA'), false, 'yanıt içeriği sonuca çıkmaz');
});

test('mutlak süre: bayt bayt damlayan yanıt hareketsizlik sayacını sıfırlasa da tarama mutlak sürede biter', async () => {
  const drip = await listen((sock) => { const t = setInterval(() => { if (sock.destroyed) return clearInterval(t); sock.write('.'); }, 15); sock.on('close', () => clearInterval(t)); });
  const t0 = Date.now();
  // Hareketsizlik sınırı 10 saniye (damla 15 ms'de bir geldiği için hiç dolmaz); mutlak sınır 400 ms
  const r = await within(scanBuffer(Buffer.from('x'), at(drip, { timeoutMs: 10_000, deadlineMs: 400 })), 9000);
  const took = Date.now() - t0;
  assert.deepEqual(r, { status: 'error', error: 'timeout' });
  assert.ok(took >= 350 && took < 6000, `mutlak sürede bitti (${took} ms) — damla sürdüğü hâlde`);
  // Hiçbir çağıran 5 dakikayı aşamaz; verilmemiş / geçersiz değer 5 dakikadır
  assert.deepEqual([deadlineOf(undefined), deadlineOf(null), deadlineOf(0), deadlineOf('x'), deadlineOf(NaN)], Array(5).fill(300_000));
  assert.deepEqual([deadlineOf(10 * 60_000), deadlineOf(Number.MAX_SAFE_INTEGER), deadlineOf(Infinity), deadlineOf(300_001)], Array(4).fill(300_000));
  assert.deepEqual([deadlineOf(400), deadlineOf(299_999), deadlineOf(-5)], [400, 299_999, 1]);
});

test('hareketsizlik süresi ayrıca çalışır: hiç yanıt vermeyen sunucuda mutlak süre beklenmeden biter', async () => {
  const silent = await listen((sock) => { sock.on('data', () => {}); });
  const t0 = Date.now();
  // Hareketsizlik 300 ms; mutlak 60 saniye
  const r = await within(scanBuffer(Buffer.from('x'), at(silent, { timeoutMs: 300, deadlineMs: 60_000 })), 15_000);
  const took = Date.now() - t0;
  assert.deepEqual(r, { status: 'error', error: 'timeout' });
  assert.ok(took >= 250 && took < 12_000, `hareketsizlik sınırında bitti (${took} ms) — mutlak süre (60 sn) beklenmedi`);
  // PING / VERSION kendi kısa süreleriyle: sessiz sunucu "ulaşılamıyor" sayılır
  const t1 = Date.now();
  assert.equal(await within(ping(at(silent, { timeoutMs: 300, deadlineMs: 300 })), 5000), false);
  assert.ok(Date.now() - t1 < 4000);
});

test('yabancı servis: karşılama metni "geçersiz yanıt"tır; metin, adres ve ağ hatası sonuca çıkmaz', async () => {
  const banners = ['220 ic-posta.internal ESMTP Postfix 3.7.2 (gizli-surum)\r\n', 'SSH-2.0-OpenSSH_9.6 gizli-surum\r\n', 'HTTP/1.1 400 Bad Request\r\nServer: gizli-surum\r\n\r\n', '-ERR unknown command gizli-surum\r\n', 'gizli-surum: OK\0',
    'PONG gizli-surum\0', '+PONG\r\n', 'stream: OK gizli-surum\0', ''];
  for (const b of banners) {
    const s = await replying(b);
    const r = await scanBuffer(eicar(), at(s, { timeoutMs: 3000 }));
    assert.deepEqual(r, { status: 'error', error: 'invalid-response' }, JSON.stringify(b));
    assert.equal(await ping(at(s)), false);
    // Durum denetimi: PONG demeyen servis "ulaşılamıyor"dur; metin hiçbir alana çıkmaz
    assert.deepEqual(await avHealth(at(s)), { reachable: false });
  }
  // PING'e PONG deyip VERSION'a başka şey söyleyen servis: yalnızca sabit kod
  const half = await listen((sock) => { sock.on('data', (d) => sock.end(d.toString('latin1').startsWith('zPING') ? 'PONG\0' : 'OpenSSH_9.6 gizli-surum <script>\0')); });
  const h = await avHealth(at(half));
  assert.deepEqual(h, { reachable: true, error: 'invalid-response' });
  await assert.rejects(version(at(half)), (e) => e.code === 'invalid-response' && !String(e.message).includes('gizli'));
  // PING'e PONG deyip VERSION'da bağlantıyı sıfırlayan servis: ağ hatasının ham metni (ECONNRESET …) çıkmaz, sabit kod
  const reset = await listen((sock) => { sock.on('data', (d) => (d.toString('latin1').startsWith('zPING') ? sock.end('PONG\0') : sock.resetAndDestroy())); });
  const hr = await avHealth(at(reset));
  assert.deepEqual(hr, { reachable: true, error: 'unreachable' });
  assert.equal(/ECONN|read|reset/i.test(JSON.stringify(hr)), false);
  // Sürüm kalıbına uymayan "ClamAV …" yanıtları da reddedilir
  for (const v of ['ClamAV <script>alert(1)</script>', 'ClamAV 1.4.3/abc/x', `ClamAV 1.${'9'.repeat(80)}`, 'ClamAV 1.4.3/27784/Tue Oct 6\r\nX-Enjekte: 1', 'clamav 1.4.3']) {
    const s = await listen((sock) => { sock.on('data', (d) => sock.end(d.toString('latin1').startsWith('zPING') ? 'PONG\0' : `${v}\0`)); });
    assert.deepEqual(await avHealth(at(s)), { reachable: true, error: 'invalid-response' }, v.slice(0, 30));
  }
  // Kapalı port: sabit kod; ECONNREFUSED / adres / port metni yok
  const gone = await replying('x');
  const port = gone.port;
  await close(gone);
  const r = await scanBuffer(eicar(), { host: '127.0.0.1', port, timeoutMs: 2000 });
  assert.deepEqual(r, { status: 'error', error: 'unreachable' });
  assert.equal(/ECONN|127\.0\.0\.1|connect|\d{4,5}/.test(JSON.stringify(r)), false);
});

test('taranacak dosya yoksa "file-not-found" (bir daha denenmez); okunamıyorsa "file-error"; dosya yolu sonuca çıkmaz', async () => {
  const s = await honest();
  const missing = path.join(UPLOAD, 'gizli-klasor', 'yok.pdf');
  const r = await scanFile(missing, at(s, { timeoutMs: 3000 }));
  assert.deepEqual(r, { status: 'error', error: 'file-not-found' });
  assert.equal(JSON.stringify(r).includes('gizli-klasor'), false);
  assert.deepEqual(await scanFile(UPLOAD, at(s, { timeoutMs: 3000 })), { status: 'error', error: 'file-error' }, 'klasör okunamaz');
  assert.equal(s.connections, 0, 'dosya açılamadıysa tarayıcıya hiç bağlanılmaz');
  const real = path.join(UPLOAD, 'var.pdf');
  fs.writeFileSync(real, PDF);
  assert.deepEqual(await scanFile(real, at(s, { timeoutMs: 3000 })), { status: 'clean' });
  const virus = path.join(UPLOAD, 'virus.bin');
  fs.writeFileSync(virus, Buffer.concat([crypto.randomBytes(200 * 1024), eicar()]));
  assert.deepEqual(await scanFile(virus, at(s, { timeoutMs: 3000 })), { status: 'infected', signature: 'Win.Test.EICAR_HDB-1' }, 'birden çok parçalı dosyada virüs kararı');
  assert.equal(s.connections, 2);
  // Tarayıcı kapalıyken: sabit kod; dosya açık kalmaz (ardından silinebilir, yeniden taranabilir)
  const gone = await replying('x');
  const port = gone.port;
  await close(gone);
  for (let i = 0; i < 20; i++) assert.deepEqual(await scanFile(real, { host: '127.0.0.1', port, timeoutMs: 2000 }), { status: 'error', error: 'unreachable' });
  // Dosya taranırken silinmişse (işçi ile karantina yarışı) yine "dosya yok"
  fs.rmSync(real);
  assert.deepEqual(await scanFile(real, at(s, { timeoutMs: 3000 })), { status: 'error', error: 'file-not-found' });
});

// ───────────────────────── hedef: yalnızca sunucu ayarı ─────────────────────────

/** Bellekte ayar tablosu + denetim / kuyruk (yalnızca bu servislerin kullandığı sorgular) */
function settingsDb(initial = null) {
  const st = { row: initial ? { key: 'antivirus', value: initial } : null, audit: [], outbox: [], files: [] };
  const model = {
    integrationSetting: {
      findUnique: async ({ where }) => (where.key === 'antivirus' && st.row ? { ...st.row, value: { ...st.row.value } } : null),
      upsert: async ({ create, update }) => { st.row = st.row ? { ...st.row, ...update } : { ...create }; return st.row; },
    },
    auditLog: { create: async ({ data }) => { st.audit.push(data); return data; } },
    notificationOutbox: { create: async ({ data }) => { st.outbox.push(data); return data; } },
    orderFile: {
      findMany: async () => st.files.filter((f) => f.scanStatus === 'PENDING'),
      update: async ({ where, data }) => Object.assign(st.files.find((f) => f.id === where.id), data),
    },
    drawingFile: { findMany: async () => [] }, drawing: { findMany: async () => [] }, orderDraftFile: { findMany: async () => [] },
  };
  return { ...model, st, $transaction: (fn) => fn(model) };
}
const ACTOR = { id: 'yonetici', role: 'ADMIN', ip: '198.51.100.9' };
const ENV = { CLAMAV_HOST: 'clamav', CLAMAV_PORT: 3310 };

test('ayar: veritabanındaki host / port okunmaz — geçerli hedef her zaman sunucu ayarıdır (CLAMAV_HOST / CLAMAV_PORT)', async () => {
  const legacy = { enabled: true, host: 'kötü.example', port: 4444, onUnavailable: 'reject' };
  const s = await getAvSettings(settingsDb(legacy), ENV);
  assert.deepEqual([s.host, s.port, s.enabled, s.onUnavailable, s.fromDb], ['clamav', 3310, true, 'reject', true]);
  // Sunucu ayarı değişirse hedef değişir; veritabanı yine etkisiz
  assert.deepEqual(avTarget({ CLAMAV_HOST: 'tarayici.ic', CLAMAV_PORT: 3999 }), { host: 'tarayici.ic', port: 3999 });
  const other = await getAvSettings(settingsDb({ ...legacy, host: '169.254.169.254', port: 80 }), { CLAMAV_HOST: 'tarayici.ic', CLAMAV_PORT: 3999 });
  assert.deepEqual([other.host, other.port], ['tarayici.ic', 3999]);
  // Sunucu ayarı yoksa varsayılan (clamav:3310) — veritabanındaki değer yine kullanılmaz; kayıt yoksa tarama kapalıdır
  for (const db of [settingsDb(legacy), settingsDb({ host: 'db', port: 5432 }), settingsDb(null)]) {
    const d = await getAvSettings(db, {});
    assert.deepEqual([d.host, d.port], ['clamav', 3310]);
  }
  assert.equal((await getAvSettings(settingsDb(null), {})).enabled, false);
  assert.equal((await getAvSettings(settingsDb(null), ENV)).enabled, true);
  // Tür ne olursa olsun: dizgi olmayan / tuhaf değerler de hedefi etkilemez
  for (const odd of [{ host: ['x'], port: '22' }, { host: 0, port: null }, { host: '127.0.0.1:22', port: 65535 }]) {
    const d = await getAvSettings(settingsDb({ enabled: true, ...odd }), ENV);
    assert.deepEqual([d.host, d.port], ['clamav', 3310]);
  }
});

test('ayar kaydı: host / port saklanmaz (gönderilse de); aç / kapa ve "ulaşılamazsa" politikası eskisi gibi kaydedilir', async () => {
  const db = settingsDb({ enabled: true, host: 'kötü.example', port: 4444, onUnavailable: 'accept' });
  // Elle hazırlanmış istek: host / port alanlarıyla
  const saved = await saveAvSettings(db, { enabled: true, host: '203.0.113.77', port: 4444, onUnavailable: 'reject', extra: 'x' }, ACTOR);
  assert.deepEqual(saved, { enabled: true, onUnavailable: 'reject' });
  assert.deepEqual(db.st.row.value, { enabled: true, onUnavailable: 'reject' }, 'kayıtta host / port kalmaz');
  assert.deepEqual(db.st.audit.map((a) => [a.action, a.entityId, a.details.after, a.details.before.host]), [['SETTINGS_UPDATE', 'antivirus', { enabled: true, onUnavailable: 'reject' }, 'kötü.example']]);
  const s = await getAvSettings(db, ENV);
  assert.deepEqual([s.host, s.port, s.enabled, s.onUnavailable], ['clamav', 3310, true, 'reject']);
  // Kapatma ve politika değişikliği çalışır
  assert.deepEqual(await saveAvSettings(db, { enabled: false, onUnavailable: 'accept' }, ACTOR), { enabled: false, onUnavailable: 'accept' });
  assert.deepEqual([(await getAvSettings(db, ENV)).enabled, (await getAvSettings(db, ENV)).onUnavailable], [false, 'accept']);
  assert.deepEqual(await saveAvSettings(db, { enabled: 'evet', onUnavailable: 'baska' }, ACTOR), { enabled: true, onUnavailable: 'accept' });
});

test('yükleme ve arka plan taraması sunucu ayarındaki adrese gider: veritabanındaki adres hiç aranmaz; EICAR yine reddedilir', async () => {
  const real = await honest(); // sunucu ayarındaki tarayıcı
  const trap = await listen((sock) => { sock.on('data', () => {}); sock.end('stream: OK\0'); }); // veritabanında kalmış adres: her şeye "temiz" der
  const db = settingsDb({ enabled: true, host: '127.0.0.1', port: trap.port, onUnavailable: 'accept' });
  const env = { CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: real.port };
  const av = await getAvSettings(db, env);
  assert.deepEqual([av.host, av.port], ['127.0.0.1', real.port]);
  // Yükleme: temiz dosya CLEAN; içinde EICAR olan dosya reddedilir (tuzak sunucu "temiz" derdi)
  const clean = await storeUpload([PDF], { name: 'cizim.pdf' }, { av });
  assert.deepEqual([clean.ok, clean.file.scanStatus], [true, 'CLEAN']);
  const bad = await storeUpload([Buffer.concat([PDF, eicar()])], { name: 'virus.pdf' }, { av });
  assert.deepEqual([bad.ok, bad.code, bad.signature], [false, 'infected', 'Win.Test.EICAR_HDB-1']);
  // Ayar "kaydedildikten" sonra da (elle hazırlanmış istekle) hedef aynıdır
  await saveAvSettings(db, { enabled: true, host: '127.0.0.1', port: trap.port, onUnavailable: 'accept' }, ACTOR);
  const again = await getAvSettings(db, env);
  assert.deepEqual([again.host, again.port], ['127.0.0.1', real.port]);
  // Arka plan taraması (işçi): bekleyen dosyalar sunucu ayarındaki tarayıcıya gider
  for (const [i, body] of [PDF, Buffer.concat([PDF, eicar()])].entries()) {
    const key = `2026/10/bekleyen-${i}.pdf`;
    fs.mkdirSync(path.join(UPLOAD, '2026/10'), { recursive: true });
    fs.writeFileSync(path.join(UPLOAD, key), body);
    db.st.files.push({ id: `f${i}`, orderId: 'o1', storageKey: key, name: `bekleyen-${i}.pdf`, scanStatus: 'PENDING' });
  }
  const before = real.connections;
  const r = await scanPending(db, again);
  assert.deepEqual([r.scanned, r.clean, r.infected, r.stopped], [2, 1, 1, null]);
  assert.deepEqual(db.st.files.map((f) => [f.scanStatus, f.scanSignature ?? null]), [['CLEAN', null], ['INFECTED', 'Win.Test.EICAR_HDB-1']]);
  assert.equal(real.connections - before, 2);
  assert.equal(trap.connections, 0, 'veritabanındaki adrese HİÇ bağlanılmadı');
});

test('üst katmanlar: tarama hatası yalnızca sabit kod, imza adı yalnızca temiz ad olarak yazılır (durum, denetim, kuyruk, yükleme sonucu)', async () => {
  const RAW = 'ECONNREFUSED: connect ECONNREFUSED 10.0.0.5:3310 gizli-banner';
  const SIG = `Kötü\r\n<script>${'Z'.repeat(500)}`;
  const av = { enabled: true, host: 'x', port: 1, onUnavailable: 'reject', timeoutMs: 1000 };
  // Yükleme: reddet politikasında hata kodu; virüste temiz imza adı
  const rejected = await storeUpload([PDF], { name: 'a.pdf' }, { av, scan: async () => ({ status: 'error', error: RAW }) });
  assert.deepEqual([rejected.ok, rejected.code, rejected.error], [false, 'av_unavailable', 'scanner-error']);
  const infected = await storeUpload([PDF], { name: 'b.pdf' }, { av, scan: async () => ({ status: 'infected', signature: SIG }) });
  assert.deepEqual([infected.code, infected.signature.length, /^[A-Za-z0-9._:+/(){}[\] ?-]+$/.test(infected.signature)], ['infected', 200, true]);
  // Kabul politikası değişmedi: hata → kabul et, "taranmadı"; temiz → CLEAN; bilinmeyen durum CLEAN sayılmaz
  const pending = await storeUpload([PDF], { name: 'c.pdf' }, { av: { ...av, onUnavailable: 'accept' }, scan: async () => ({ status: 'error', error: 'timeout' }) });
  assert.equal(pending.file.scanStatus, 'PENDING');
  const odd = await storeUpload([PDF], { name: 'd.pdf' }, { av: { ...av, onUnavailable: 'accept' }, scan: async () => ({ status: 'tuhaf' }) });
  assert.equal(odd.file.scanStatus, 'PENDING', 'tanınmayan sonuç temiz sayılmaz');
  // Arka plan taraması: ham hata → kod ("durdu" bilgisi ve günlük); dosya yok → atlanır; virüs → temiz imza adı
  const db = settingsDb(null);
  const put = (id, name) => { fs.mkdirSync(path.join(UPLOAD, '2026/11'), { recursive: true }); fs.writeFileSync(path.join(UPLOAD, `2026/11/${name}`), PDF); db.st.files.push({ id, orderId: 'o1', storageKey: `2026/11/${name}`, name, scanStatus: 'PENDING' }); };
  put('k1', 'kayip.pdf'); put('k2', 'virus.pdf'); put('k3', 'sonra.pdf');
  const logs = [];
  const scan = async (file) => (file.endsWith('kayip.pdf') ? { status: 'error', error: 'file-not-found' } : file.endsWith('virus.pdf') ? { status: 'infected', signature: SIG } : { status: 'error', error: RAW });
  const r = await scanPending(db, av, { scan, log: (m) => logs.push(m) });
  assert.deepEqual([r.missing, r.infected, r.stopped], [1, 1, 'scanner-error']);
  assert.deepEqual(db.st.files.map((f) => f.scanStatus), ['SKIPPED', 'INFECTED', 'PENDING']);
  const dump = JSON.stringify([r, db.st.files, db.st.audit, db.st.outbox, logs, rejected, infected]);
  for (const s of ['ECONNREFUSED', '10.0.0.5', 'gizli-banner', '<script>', '\\r\\n', 'Kötü']) assert.equal(dump.includes(s), false, `ham metin yok: ${s}`);
  assert.equal(db.st.files[1].scanSignature.length, 200);
  assert.deepEqual([db.st.audit[0].details.signature, db.st.outbox[0].payload.signature], [db.st.files[1].scanSignature, db.st.files[1].scanSignature]);
});

// ───────────────────────── yapı ─────────────────────────

test('yapı: adres yalnızca sunucu ayarından; ekranda giriş alanı yok; işlemler host / port okumaz ve yetki ister; hata ayrıntısı sabit kod', () => {
  const svc = strip(read('server/files/antivirus.js'));
  const actions = strip(read('app/(panel)/admin/entegrasyonlar/actions.ts'));
  const page = strip(read('app/(panel)/admin/entegrasyonlar/page.tsx'));
  const client = strip(read('server/files/clamav.js'));
  // Servis: hedefin tek kaynağı avTarget(env); veritabanı değeri okunmaz, kaydedilmez
  assert.ok(svc.includes("return { host: env.CLAMAV_HOST || 'clamav', port: env.CLAMAV_PORT || 3310 };"));
  const get = svc.slice(svc.indexOf('export async function getAvSettings('), svc.indexOf('export async function saveAvSettings('));
  assert.ok(get.includes('...avTarget(env),'));
  assert.equal(/v\.host|v\.port|value\.host|value\.port|host:|port:/.test(get), false, 'getAvSettings veritabanından adres okumaz');
  const save = svc.slice(svc.indexOf('export async function saveAvSettings('), svc.indexOf('export async function avHealth('));
  assert.equal(/\bhost\b|\bport\b/.test(save.replace('export async function', '')), false, 'saveAvSettings adres saklamaz');
  assert.ok(save.includes("const clean = {\n    enabled: !!value.enabled,\n    onUnavailable: value.onUnavailable === 'reject' ? 'reject' : 'accept',\n  };"), 'saklanan yalnızca iki alan');
  // İşlemler: üçü de önce yetki ister; formdan host / port okunmaz
  assert.equal(/formData\.get\('(host|port)'\)|host:\s*(String|formData)|port:\s*(Number|formData)/.test(actions), false);
  for (const name of ['saveAntivirusAction', 'testAntivirusAction', 'scanNowAction']) {
    const body = actions.slice(actions.indexOf(`export async function ${name}(`));
    const first = body.slice(body.indexOf('{') + 1).trim().split('\n')[0].trim();
    assert.match(first, /^(const user = )?await requirePermission\('SETTINGS_MANAGE'\);$/, `${name}: ilk satır yetki denetimi`);
  }
  assert.ok(actions.includes("redirect(back({ error: 'testFailed', detail: avErrorCode(r.error) }));"));
  assert.ok(actions.includes("redirect(back({ error: 'scanStopped', detail: avErrorCode(r.stopped) }));"));
  assert.equal(/\.error\.slice\(|\.stopped\.slice\(|signature: r\.signature/.test(actions), false, 'ham hata / imza metni adrese yazılmaz');
  // Ekran: adres salt-okunur; hata ayrıntısı yalnızca bilinen kod → sabit metin; imza adı temizlenir
  assert.ok(page.includes("await requirePermission('SETTINGS_MANAGE');"));
  assert.equal(/name="host"|name="port"|id="av-host"|id="av-port"/.test(page), false, 'adres / port giriş alanı yok');
  assert.ok(page.includes('data-av-host>{s.host}</td>') && page.includes('data-av-port>{s.port}</td>'));
  assert.ok(page.includes("const avReason = (AV_ERRORS as readonly string[]).find((code) => code === sp.detail) ?? 'unknown';"));
  assert.ok(page.includes('t(ERR[sp.error], { error: t(`admin.integrations.av.reason.${avReason}` as MsgKey) })'));
  assert.ok(page.includes('signature: safeSignature(sp.signature)'));
  assert.equal(/t\(ERR\[sp\.error\], \{ error: sp\.detail/.test(page), false);
  // İstemci: sınır parça saklanmadan ÖNCE denetlenir; mutlak süre veriyle yeniden başlamaz; ham hata metni üretilmez
  const talk = client.slice(client.indexOf('function talk('), client.indexOf('function write('));
  const order = ['const hardMs = deadlineOf(deadlineMs);', 'hard = setTimeout(() => finish(new ClamError(\'timeout\')), hardMs);', 'socket.setTimeout(timeoutMs,', "if (size > REPLY_MAX_BYTES) return finish(new ClamError('response-too-large'));", 'chunks.push(d);'];
  const pos = order.map((s) => talk.indexOf(s));
  assert.ok(pos.every((i) => i >= 0), `eksik: ${order.filter((_, i) => pos[i] < 0).join(' | ')}`);
  assert.deepEqual(pos, [...pos].sort((a, b) => a - b));
  assert.equal((talk.match(/setTimeout\(/g) ?? []).length, 2, 'biri mutlak (setTimeout), biri hareketsizlik (socket.setTimeout)');
  assert.equal((talk.match(/clearTimeout\(hard\)/g) ?? []).length, 1);
  assert.equal(/hard = setTimeout[\s\S]*hard = setTimeout/.test(talk), false, 'mutlak süre yeniden kurulmaz');
  assert.equal(/\.message|toString\('utf8'\)/.test(client), false, 'ham hata / yanıt metni üst katmana verilmez');
  // Adres başka hiçbir yerde yazılı değil: tarama çağrıları hedefi ayar nesnesinden alır
  const walk = (dir, exts) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, exts) : exts.test(e.name) ? [p] : [];
  });
  const files = walk('app', /\.tsx?$/).concat(walk('lib', /\.tsx?$/), walk('server', /\.js$/), walk('scripts', /\.m?js$/));
  const callers = files.filter((f) => /from ['"][^'"]*clamav\.js['"]/.test(strip(read(f)))).sort();
  const P = (...parts) => path.join(...parts);
  assert.deepEqual(callers, [P('app', '(panel)', 'admin', 'entegrasyonlar', 'actions.ts'), P('app', '(panel)', 'admin', 'entegrasyonlar', 'page.tsx'), P('scripts', 'av-check.mjs'), P('server', 'files', 'antivirus.js'), P('server', 'files', 'store.js')].sort(),
    'tarayıcı istemcisini kullanan yerler (yenisi bilerek eklenmeli)');
  for (const f of callers) {
    const src = strip(read(f));
    assert.equal(/host:\s*['"`]/.test(src.replace("host: env.CLAMAV_HOST || 'clamav'", '')), false, `${f}: sabit adres yazılı değil`);
    for (const m of src.matchAll(/host:\s*([A-Za-z_.]+)/g)) assert.ok(['s.host', 'settings.host', 'av.host', 'env.CLAMAV_HOST'].includes(m[1]), `${f}: host kaynağı ${m[1]}`);
  }
  // Ayarı okuyanların hepsi getAvSettings'ten geçer; "antivirus" kaydını yazan tek yer saveAvSettings'tir
  assert.deepEqual(files.filter((f) => /AV_KEY|key: 'antivirus'/.test(strip(read(f)))).sort(), [path.join('server', 'files', 'antivirus.js')]);
});
