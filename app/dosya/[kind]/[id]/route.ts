import fs from 'node:fs';
import { Readable } from 'node:stream';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { orderScope } from '@/lib/orders';
import { userCan } from '@/lib/permissions';
import { audit } from '@/lib/audit';
import { resolveKey } from '@/lib/storage';
import { getT } from '@/lib/i18n';
import { findDrawingFile } from '@/server/orders/drawing-access.js';

export const dynamic = 'force-dynamic';

// /dosya/siparis/<OrderFile id>  ·  /dosya/cizim/<DrawingFile id> (eski: <Drawing id>)  ·  /dosya/urun/<ProfileImage id>
// /dosya/tedarik/<SupplierOrderFile id> — tedarikçi siparişinin teknik eki: yalnızca SUPPLIER_MANAGE (yönetici; karar 181)
export async function GET(req: Request, ctx: { params: Promise<{ kind: string; id: string }> }) {
  const user = await getCurrentUser();
  const { t } = await getT();
  if (!user) return new Response(t('common.fileLoginRequired'), { status: 401 });
  if (!userCan(user, 'ORDER_VIEW')) return new Response(t('common.fileNotFound'), { status: 404 });
  const { kind, id } = await ctx.params;
  const scope = orderScope(user);

  // Profil ürün görseli (katalog görseli; giriş yapmış herkese). Görsel kayıtları değişmez → önbelleğe alınabilir.
  if (kind === 'urun') {
    const img = await db.profileImage.findUnique({ where: { id }, select: { data: true, mime: true } });
    if (!img || !['image/jpeg', 'image/png'].includes(img.mime)) return new Response(t('common.fileNotFound'), { status: 404 });
    return new Response(new Uint8Array(img.data), {
      headers: { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  // orderId: dosyanın bağlı olduğu sipariş (tedarik ekinde tedarikçi siparişi — denetim kaydında supplierOrderId)
  let file: { storageKey: string; name: string; mime: string | null; scanStatus: string; orderId: string } | null = null;
  if (kind === 'siparis') {
    const f = await db.orderFile.findFirst({
      // İç ekip dosyalarını yalnızca iç ekip görür; başka firmanın dosyası kapsam dışıdır → 404
      where: { id, order: scope, ...(userCan(user, 'FILE_INTERNAL_VIEW') ? {} : { kind: 'CUSTOMER' }) },
    });
    if (f) file = { storageKey: f.storageKey, name: f.name, mime: f.mime, scanStatus: f.scanStatus, orderId: f.orderId };
  } else if (kind === 'cizim') {
    // Çizim sürümünün dosyası (dosya kimliği; eski bağlantılarda sürüm kimliği). Erişim kuralı tek yerdedir
    // (server/orders/drawing-access.js, karar 146): müşteri taslak ve GERİ ÇEKİLMİŞ sürümün dosyasını alamaz → 404.
    // "?ac=1" (tarayıcıda aç) aynı yoldan geçer. Verilmeyen dosya için aşağıdaki FILE_DOWNLOAD kaydı da yazılmaz.
    file = await findDrawingFile(db, { id, scope, role: user.appRole });
  } else if (kind === 'tedarik' && userCan(user, 'SUPPLIER_MANAGE')) {
    // Tedarikçi siparişinin eki: yetkisi olmayan herkese 404 (varlığı da belli olmaz)
    const f = await db.supplierOrderFile.findUnique({ where: { id }, select: { storageKey: true, name: true, mime: true, scanStatus: true, revision: { select: { orderId: true } } } });
    if (f) file = { storageKey: f.storageKey, name: f.name, mime: f.mime, scanStatus: f.scanStatus, orderId: f.revision.orderId };
  }
  if (!file) return new Response(t('common.fileNotFound'), { status: 404 });
  // Virüslü dosya karantinadadır; kimseye verilmez
  if (file.scanStatus === 'INFECTED') return new Response(t('common.fileInfected'), { status: 403 });
  // Dosya erişimi denetim kaydına yazılır (CLAUDE.md "Audit": file access)
  await audit('FILE_DOWNLOAD', kind === 'cizim' ? 'DrawingFile' : kind === 'tedarik' ? 'SupplierOrderFile' : 'OrderFile', id, user.id,
    { ...(kind === 'tedarik' ? { supplierOrderId: file.orderId } : { orderId: file.orderId }), name: file.name });

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
