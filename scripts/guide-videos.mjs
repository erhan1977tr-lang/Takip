// assets/kurulum/{tr,ro}.mp4 → server/push/guide-videos.js (base64). Videoyu değiştirmek: dosyayı değiştir, `node scripts/guide-videos.mjs`.
// Üretilen dosya elle düzenlenmez (test/push.test.js dosyalarla karşılaştırır).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const names = ['tr.mp4', 'ro.mp4'];
const lines = names.map((n) => `  '${n}': '${fs.readFileSync(path.join(ROOT, 'assets', 'kurulum', n)).toString('base64')}',`);
const out = `// ÜRETİLMİŞ DOSYA — elle düzenlemeyin: node scripts/guide-videos.mjs (kaynak: assets/kurulum/*.mp4)\nexport const GUIDE_VIDEOS = Object.freeze({\n${lines.join('\n')}\n});\n`;
fs.writeFileSync(path.join(ROOT, 'server', 'push', 'guide-videos.js'), out);
console.log('server/push/guide-videos.js yazıldı');
