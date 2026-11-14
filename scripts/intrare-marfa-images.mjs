// INTRAREA MARFĂ formunun ürün görsellerini (assets/intrare-marfa/*.png — ürün sahibinin Excel şablonundan alındı) sunucu
// modülüne gömer:  node scripts/intrare-marfa-images.mjs  → server/pdf/intrare-marfa-images.js yeniden üretilir.
// PDF belgeyi bu modülden okur (derlenmiş çıktıda dosya yolu aranmaz). test/intrare-marfa.test.js modülün dosyalarla aynı
// olduğunu denetler.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IMAGE_DIR = path.join(root, 'assets', 'intrare-marfa');
export const MODULE_PATH = path.join(root, 'server', 'pdf', 'intrare-marfa-images.js');

export function imagesModule(dir = IMAGE_DIR) {
  const files = fs.readdirSync(dir).filter((f) => /^[a-z0-9-]+\.png$/.test(f)).sort();
  const body = files.map((f) => `  '${f.replace(/\.png$/, '')}': '${fs.readFileSync(path.join(dir, f)).toString('base64')}',`).join('\n');
  return `// ÜRETİLMİŞ DOSYA — elle düzenlemeyin: node scripts/intrare-marfa-images.mjs (kaynak: assets/intrare-marfa/*.png)\n`
    + `const DATA = Object.freeze({\n${body}\n});\n\n`
    + `/** @param {string} key  @returns {Buffer | null} */\nexport const imImage = (key) => (Object.hasOwn(DATA, key) ? Buffer.from(DATA[key], 'base64') : null);\n`
    + `export const IM_IMAGE_KEYS = Object.freeze(Object.keys(DATA));\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(MODULE_PATH, imagesModule());
  console.log(`yazıldı: ${path.relative(root, MODULE_PATH)}`);
}
