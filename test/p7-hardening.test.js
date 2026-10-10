// P7 sertleştirme (karar 248): PNG sıkıştırma bombası çözülmez (AUD-16); `takip smtp` işçiyi de yeniden başlatır.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PNG_MAX_PIXELS, decodePng } from '../server/pdf/pdf.js';

const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
const png = (w, h, idat) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
};

test('AUD-16: piksel sınırının üstü çözülmez; IDAT beklenenden büyük açılıyorsa (bomba) çözülmez; normal görsel çözülür', () => {
  assert.equal(PNG_MAX_PIXELS, 16_000_000);
  // 5000 × 5000 = 25 MP: sınır üstü — IDAT hiç açılmaz
  assert.equal(decodePng(png(5000, 5000, zlib.deflateSync(Buffer.alloc(10)))), null);
  // 2 × 2 RGB görsel ama IDAT 64 MB'a açılıyor: beklenen (2*3+1)*2 = 14 bayt; fazlası okunmaz → null
  const bomb = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024));
  assert.ok(bomb.length < 200_000);
  const before = process.memoryUsage().arrayBuffers;
  assert.equal(decodePng(png(2, 2, bomb)), null);
  assert.ok(process.memoryUsage().arrayBuffers - before < 32 * 1024 * 1024, 'bomba belleğe açılmadı');
  // Normal 2 × 2 kırmızı
  const ok = decodePng(png(2, 2, zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]))));
  assert.deepEqual([ok.w, ok.h, [...ok.rgb]], [2, 2, [255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]]);
});

test('takip smtp: ayar değişince uygulama ve işçi (e-postayı gönderen) birlikte yeniden başlar', () => {
  const sh = fs.readFileSync(new URL('../deploy/takip.sh', import.meta.url), 'utf8');
  const fn = sh.slice(sh.indexOf('cmd_smtp() {'), sh.indexOf('cmd_admin() {'));
  assert.ok(fn.includes('compose up -d app worker'));
  assert.ok(!/compose up -d app >/.test(fn));
});
