// assets/pwa/*.png → server/push/icons.js (base64). Simgeyi değiştirmek: dosyayı değiştir, `node scripts/pwa-icons.mjs`.
// Üretilen dosya elle düzenlenmez (test/push.test.js dosyalarla karşılaştırır).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const names = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'badge-96.png'];
const lines = names.map((n) => `  '${n}': '${fs.readFileSync(path.join(ROOT, 'assets', 'pwa', n)).toString('base64')}',`);
const out = `// ÜRETİLMİŞ DOSYA — elle düzenlemeyin: node scripts/pwa-icons.mjs (kaynak: assets/pwa/*.png)\nexport const PWA_ICONS = Object.freeze({\n${lines.join('\n')}\n});\n`;
fs.writeFileSync(path.join(ROOT, 'server', 'push', 'icons.js'), out);
console.log('server/push/icons.js yazıldı');
