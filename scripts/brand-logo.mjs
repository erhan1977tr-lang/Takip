// Resmî GKH Trading Invest logosunu (assets/brand/gkh-trading-invest-logo.jpg) sunucu modülüne gömer:
//   node scripts/brand-logo.mjs          → server/branding/logo.js yeniden üretilir
// PDF'ler ve e-postalar logoyu bu modülden okur (derlenmiş çıktıda dosya yolu aranmaz, dış adres kullanılmaz).
// Logo değişecekse: yalnızca assets/brand/ içindeki dosyayı değiştirin (JPEG ya da PNG) ve bu betiği çalıştırın.
// test/branding.test.js modülün dosyayla aynı olduğunu denetler.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'gkh-trading-invest-logo.jpg';
const src = path.join(root, 'assets', 'brand', FILE);

/** JPEG (SOF) ya da PNG (IHDR) boyutu */
export function imageSize(buf) {
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('logo JPEG ya da PNG olmalı');
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('JPEG boyutu okunamadı');
}

export function logoModule(buf, file = FILE) {
  const { mime, width, height } = imageSize(buf);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return `// ÜRETİLMİŞ DOSYA — elle düzenlemeyin. Kaynak: assets/brand/${file}  (node scripts/brand-logo.mjs)
// Resmî GKH Trading Invest SRL logosu: TAKİP'in ürettiği PDF'ler ve bütün HTML e-postalar bunu kullanır (server/branding).
export const LOGO = {
  file: '${file}',
  mime: '${mime}',
  width: ${width},
  height: ${height},
  sha256: '${sha256}',
  base64:
    '${buf.toString('base64')}',
};
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(root, 'server', 'branding', 'logo.js');
  fs.writeFileSync(out, logoModule(fs.readFileSync(src)));
  console.log(`yazıldı: ${path.relative(root, out)}`);
}
