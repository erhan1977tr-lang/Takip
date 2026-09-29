import fs from 'node:fs';
import { Readable } from 'node:stream';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { orderScope } from '@/lib/orders';
import { userCan } from '@/lib/permissions';
import { audit } from '@/lib/audit';
import { resolveKey } from '@/lib/storage';
import { getT } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

// /dosya/siparis/<OrderFile id>  ·  /dosya/cizim/<Drawing id>
export async function GET(req: Request, ctx: { params: Promise<{ kind: string; id: string }> }) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'ORDER_VIEW')) return new Response(t('common.fileNotFound'), { status: 404 });
  const { kind, id } = await ctx.params;
  const scope = orderScope(user);

  let file: { storageKey: string; name: string; mime: string | null; scanStatus: string; orderId: string } | null = null;
  if (kind === 'siparis') {
    const f = await db.orderFile.findFirst({
      // İç ekip dosyalarını yalnızca iç ekip görür; başka firmanın dosyası kapsam dışıdır → 404
      where: { id, order: scope, ...(userCan(user, 'FILE_INTERNAL_VIEW') ? {} : { kind: 'CUSTOMER' }) },
    });
    if (f) file = { storageKey: f.storageKey, name: f.name, mime: f.mime, scanStatus: f.scanStatus, orderId: f.orderId };
  } else if (kind === 'cizim') {
    const d = await db.drawing.findFirst({ where: { id, order: scope } });
    if (d) file = { storageKey: d.fileUrl, name: d.fileName || `cizim-v${d.version}`, mime: d.mime, scanStatus: d.scanStatus, orderId: d.orderId };
  }
  if (!file) return new Response(t('common.fileNotFound'), { status: 404 });
  // Virüslü dosya karantinadadır; kimseye verilmez
  if (file.scanStatus === 'INFECTED') return new Response(t('common.fileInfected'), { status: 403 });
  // Dosya erişimi denetim kaydına yazılır (CLAUDE.md "Audit": file access)
  await audit('FILE_DOWNLOAD', kind === 'cizim' ? 'Drawing' : 'OrderFile', id, user.id, { orderId: file.orderId, name: file.name });

  const full = resolveKey(file.storageKey);
  if (!full || !fs.existsSync(full)) return new Response(t('common.fileMissing'), { status: 404 });
  const stat = fs.statSync(full);
  const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  // ?ac=1 → PDF ve görseller tarayıcıda açılır; diğer türler her zaman indirilir.
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const INLINE: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
  const inline = new URL(req.url).searchParams.get('ac') === '1' && ext in INLINE;
  const stream = Readable.toWeb(fs.createReadStream(full)) as unknown as ReadableStream;
  return new Response(stream, {
    headers: {
      'Content-Type': inline ? INLINE[ext] : 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
