import fs from 'node:fs/promises';
import path from 'node:path';
import { getCurrentUser } from '@/lib/auth/session';

// pdf.js'in çizim görüntüleyicide (components/DrawingViewer.tsx) gereken kendi varlıkları: standart yazı tipleri
// (yazı tipi gömülmemiş PDF'ler) ve cMap'ler (CJK metin). Paketin içinden (node_modules/pdfjs-dist) sunulur — dış
// sunucuya (CDN) istek atılmaz. Üretim çıktısına (standalone) next.config.mjs → outputFileTracingIncludes ile girer.
//   /pdfjs/standard_fonts/<dosya>.ttf|.pfb   ·   /pdfjs/cmaps/<dosya>.bcmap
// Yalnızca giriş yapmış kullanıcıya; yalnızca bu iki klasör ve bu uzantılar (yol dışına çıkılamaz).
const ROOT = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
const DIRS: Record<string, { dir: string; types: Record<string, string> }> = {
  standard_fonts: { dir: path.join(ROOT, 'standard_fonts'), types: { ttf: 'font/ttf', pfb: 'application/octet-stream' } },
  cmaps: { dir: path.join(ROOT, 'cmaps'), types: { bcmap: 'application/octet-stream' } },
};

export async function GET(_req: Request, ctx: { params: Promise<{ kind: string; file: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 401 });
  const { kind, file } = await ctx.params;
  const def = Object.hasOwn(DIRS, kind) ? DIRS[kind] : null;
  const type = def && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(file) ? def.types[file.split('.').pop() ?? ''] : undefined;
  if (!def || !type) return new Response(null, { status: 404 });
  try {
    const data = await fs.readFile(path.join(def.dir, file));
    return new Response(new Uint8Array(data), {
      headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
