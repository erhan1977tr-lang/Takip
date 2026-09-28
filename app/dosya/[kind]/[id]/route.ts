import fs from 'node:fs';
import { Readable } from 'node:stream';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { orderScope } from '@/lib/orders';
import { resolveKey } from '@/lib/storage';

export const dynamic = 'force-dynamic';

// /dosya/siparis/<OrderFile id>  ·  /dosya/cizim/<Drawing id>
export async function GET(_req: Request, ctx: { params: Promise<{ kind: string; id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response('Giriş gerekli', { status: 401 });
  const { kind, id } = await ctx.params;
  const scope = orderScope(user);

  let file: { storageKey: string; name: string; mime: string | null } | null = null;
  if (kind === 'siparis') {
    const f = await db.orderFile.findFirst({
      where: { id, order: scope, ...(user.appRole === 'MUSTERI' ? { kind: 'CUSTOMER' } : {}) },
    });
    if (f) file = { storageKey: f.storageKey, name: f.name, mime: f.mime };
  } else if (kind === 'cizim') {
    const d = await db.drawing.findFirst({ where: { id, order: scope } });
    if (d) file = { storageKey: d.fileUrl, name: d.fileName || `cizim-v${d.version}`, mime: null };
  }
  if (!file) return new Response('Dosya bulunamadı', { status: 404 });

  const full = resolveKey(file.storageKey);
  if (!full || !fs.existsSync(full)) return new Response('Dosya diskte bulunamadı', { status: 404 });
  const stat = fs.statSync(full);
  const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const stream = Readable.toWeb(fs.createReadStream(full)) as unknown as ReadableStream;
  return new Response(stream, {
    headers: {
      'Content-Type': file.mime || 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
