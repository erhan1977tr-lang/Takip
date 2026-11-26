// assets/kurulum/*.mp4 → server/push/guide-videos.js (base64) + guide-video-list.js (yalnız adlar). Videoyu değiştirmek: dosyayı değiştir, `node scripts/guide-videos.mjs`.
// Üretilen dosya elle düzenlenmez (test/push.test.js dosyalarla karşılaştırır).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const names = fs.readdirSync(path.join(ROOT, 'assets', 'kurulum')).filter((n) => /^(android|iphone)-(tr|ro)\.mp4$/.test(n)).sort();
const lines = names.map((n) => `  '${n}': '${fs.readFileSync(path.join(ROOT, 'assets', 'kurulum', n)).toString('base64')}',`);
const out = `// ÜRETİLMİŞ DOSYA — elle düzenlemeyin: node scripts/guide-videos.mjs (kaynak: assets/kurulum/*.mp4)\nexport const GUIDE_VIDEOS = Object.freeze({\n${lines.join('\n')}\n});\n`;
fs.writeFileSync(path.join(ROOT, 'server', 'push', 'guide-videos.js'), out);
fs.writeFileSync(path.join(ROOT, 'server', 'push', 'guide-video-list.js'),
  `// ÜRETİLMİŞ DOSYA — elle düzenlemeyin: node scripts/guide-videos.mjs\nexport const GUIDE_VIDEO_NAMES = Object.freeze(${JSON.stringify(names)});\n`);
console.log('server/push/guide-videos.js yazıldı');
