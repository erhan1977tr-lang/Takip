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
import { renderDeliveryReport, reportLimiter } from '@/server/delivery/service.js';
import { signedDocServable, signedDocWhere } from '@/server/delivery/rules.js';
import { contentDisposition } from '@/server/files/export-name.js';
import { getEnv } from '@/server/env.js';
import { PREVIEW_ROUTE_KINDS, PREVIEW_STATUS, SNIFF_BYTES, previewDecision } from '@/server/files/preview.js';
import { cadCache, cadCacheKey, previewLimiter, requestCadPreview } from '@/server/files/cad-preview.js';

export const dynamic = 'force-dynamic';

// /dosya/siparis/<OrderFile id>  ·  /dosya/cizim/<DrawingFile id> (eski: <Drawing id>)  ·  /dosya/urun/<ProfileImage id>
// /dosya/tedarik/<SupplierOrderFile id> — tedarikçi siparişinin teknik eki: yalnızca SUPPLIER_MANAGE (yönetici; karar 181)
// /dosya/teslimat/<DeliveryPhoto id> — profil teslimat fotoğrafı: siparişi gören (müşteri yalnızca kendi siparişi; karar 195)
// /dosya/teslim-belgesi/<OrderFile id> — depodan yüklenen imzalı teslim belgesi (profil): siparişi gören (müşteri yalnızca kendi
//   siparişi; karar 273). Koşul tek yerde: signedDocWhere (server/delivery/rules.js) — başka kaynaklı iç dosya bu yoldan verilmez.
// /dosya/rapor/<DeliveryReport id> — teslimat raporu PDF'i, kopyadan görenin dilinde üretilir (karar 196); süreli bağlantı yok
export async function GET(req: Request, ctx: { params: Promise<{ kind: string; id: string }> }) {
  const user = await getCurrentUser();
  const { t, locale } = await getT();
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

  // Teslimat raporu (karar 196): PDF rapor KOPYASINDAN üretilir (aşağıda deliveryReportResponse)
  if (kind === 'rapor') return deliveryReportResponse({ id, userId: user.id, scope, locale, staff: userCan(user, 'NOTE_INTERNAL_VIEW'), t });

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
  } else if (kind === 'teslimat') {
    // Teslimat fotoğrafı (karar 195): siparişin kapsamı yeter — müşteri kendi siparişinin fotoğrafını görür (iç dosya kuralı
    // bu türe uygulanmaz); başka firmanın fotoğrafı kapsam dışıdır → 404
    const ph = await db.deliveryPhoto.findFirst({ where: { id, order: scope }, select: { file: { select: { storageKey: true, name: true, mime: true, scanStatus: true, orderId: true } } } });
    if (ph) file = ph.file;
  } else if (kind === 'teslim-belgesi') {
    // İmzalı teslim belgesi (karar 273): yalnızca depo bağlantısından yüklenen belge (source = DEPOT_LINK) ve profil siparişi;
    // siparişin kapsamı yeter (müşteri kendi siparişinin belgesini görür). Başka firmanın / başka türdeki dosya → 404
    // Yalnızca taraması tamamlanmış TEMİZ belge (karar 274): sorgu koşulu + ikinci denetim; aksi hâlde "bulunamadı" (404) —
    // tarama durumu ve dosyanın varlığı dışarıya söylenmez, içerik gönderilmez, indirme kaydı yazılmaz
    const f = await db.orderFile.findFirst({ where: { id, ...signedDocWhere(scope) }, select: { storageKey: true, name: true, mime: true, scanStatus: true, orderId: true } });
    if (f && signedDocServable(f.scanStatus)) file = f;
  } else if (kind === 'tedarik' && userCan(user, 'SUPPLIER_MANAGE')) {
    // Tedarikçi siparişinin eki: yetkisi olmayan herkese 404 (varlığı da belli olmaz)
    const f = await db.supplierOrderFile.findUnique({ where: { id }, select: { storageKey: true, name: true, mime: true, scanStatus: true, revision: { select: { orderId: true } } } });
    if (f) file = { storageKey: f.storageKey, name: f.name, mime: f.mime, scanStatus: f.scanStatus, orderId: f.revision.orderId };
  }
  if (!file) return new Response(t('common.fileNotFound'), { status: 404 });
  // Virüslü dosya karantinadadır; kimseye verilmez
  if (file.scanStatus === 'INFECTED') return new Response(t('common.fileInfected'), { status: 403 });
  // Diskteki dosya ÖNCE doğrulanır: yoksa (ya da okunamıyorsa) 404 ve indirme kaydı yazılmaz — kayıt yalnızca gerçekten
  // gönderilecek dosya için (karar 275)
  const full = resolveKey(file.storageKey);
  let stat: fs.Stats | null = null;
  try { stat = full ? fs.statSync(full) : null; } catch { stat = null; }
  if (!full || !stat || !stat.isFile()) return new Response(t('common.fileMissing'), { status: 404 });
  const entity = kind === 'cizim' ? 'DrawingFile' : kind === 'tedarik' ? 'SupplierOrderFile' : kind === 'teslimat' ? 'DeliveryPhoto' : 'OrderFile';
  const owner: Record<string, string> = kind === 'tedarik' ? { supplierOrderId: file.orderId } : { orderId: file.orderId };
  // Önizleme (karar 283): erişim kuralı İNDİRMEYLE BİREBİR aynıdır — yukarıdaki sorgu, virüs ve disk denetiminden sonra gelir
  const onizle = new URL(req.url).searchParams.get('onizle');
  if (onizle !== null) {
    if (!(PREVIEW_ROUTE_KINDS as readonly string[]).includes(kind)) return new Response(t('common.fileNotFound'), { status: 404 });
    return previewResponse({ onizle, full, stat, file, userId: user.id, entity, id, owner });
  }
  // Dosya erişimi denetim kaydına yazılır (CLAUDE.md "Audit": file access)
  await audit('FILE_DOWNLOAD', entity, id, user.id, { ...owner, name: file.name });
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
      // Teslimat fotoğrafı değişmez: sayfadaki küçük görsel her yenilemede yeniden indirilmesin (yalnızca bu tarayıcı, 1 saat)
      'Cache-Control': kind === 'teslimat' && inline ? 'private, max-age=3600' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const previewFail = (code: string) =>
  Response.json({ ok: false, code }, {
    status: PREVIEW_STATUS[code as keyof typeof PREVIEW_STATUS] ?? 422,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });

/**
 * Önizleme yanıtı (karar 283). Türü dosyanın İÇERİĞİ belirler (uzantı ailesiyle uyuşmalı — previewDecision):
 * - "?onizle=1": PDF / resim dosyanın kendisi; içerik türü imzadan, tarayıcıda çalıştırılabilir içerik engelli
 *   (CSP sandbox), önbellek yok.
 * - "?onizle=cad": DWG / DXF → iç CAD hizmeti → geometri JSON'u (özel süreç içi önbellek; anahtar = dosyanın kendisi).
 * Kullanıcı başına istek sınırı; her başarılı önizleme FILE_PREVIEW olarak kaydedilir (indirme kaydından ayrı).
 */
async function previewResponse({ onizle, full, stat, file, userId, entity, id, owner }: {
  onizle: string; full: string; stat: fs.Stats; file: { storageKey: string; name: string }; userId: string; entity: string; id: string;
  owner: Record<string, string>;
}) {
  if (onizle !== '1' && onizle !== 'cad') return previewFail('UNSUPPORTED');
  const gate = previewLimiter.take(userId);
  if (!gate.ok) return previewFail('RATE_LIMIT');
  const head = Buffer.alloc(SNIFF_BYTES);
  let n = 0;
  try {
    const fd = fs.openSync(full, 'r');
    try { n = fs.readSync(fd, head, 0, SNIFF_BYTES, 0); } finally { fs.closeSync(fd); }
  } catch {
    return previewFail('INVALID');
  }
  const d = previewDecision(file.name, head.subarray(0, n), stat.size);
  if (!d.ok) return previewFail(d.code);
  if (onizle === '1') {
    if (d.family === 'cad' || !d.mime) return previewFail('UNSUPPORTED');
    await audit('FILE_PREVIEW', entity, id, userId, { ...owner, name: file.name, preview: d.content });
    const stream = Readable.toWeb(fs.createReadStream(full)) as unknown as ReadableStream;
    return new Response(stream, {
      headers: {
        'Content-Type': d.mime,
        'Content-Length': String(stat.size),
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    });
  }
  if (d.family !== 'cad') return previewFail('UNSUPPORTED');
  const key = cadCacheKey({ storageKey: file.storageKey, size: stat.size, mtimeMs: stat.mtimeMs });
  let json = cadCache.get(key);
  if (!json) {
    const r = await requestCadPreview({ url: getEnv().CAD_SERVICE_URL, type: d.content as 'dwg' | 'dxf', path: full, size: stat.size });
    if (!r.ok) return previewFail(r.code);
    json = r.json;
    cadCache.set(key, json);
  }
  await audit('FILE_PREVIEW', entity, id, userId, { ...owner, name: file.name, preview: d.content });
  return new Response(json, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

/**
 * Teslimat raporu (karar 196): erişim siparişi görme kapsamıdır (müşteri yalnızca kendi firması; satış / çizim profil siparişini
 * zaten göremez) — bulunamazsa / başka firmanınsa 404, indirme kaydı yazılmaz. PDF her istekte rapor KOPYASINDAN görenin
 * dilinde üretilir (süreli bağlantı yok); kullanıcı başına istek sınırı vardır. Müşteriye iç ekipten kişi adı yazılmaz.
 */
async function deliveryReportResponse({ id, userId, scope, locale, staff, t }: {
  id: string; userId: string; scope: ReturnType<typeof orderScope>; locale: 'tr' | 'ro'; staff: boolean; t: Awaited<ReturnType<typeof getT>>['t'];
}) {
  const gate = reportLimiter.take(userId);
  if (!gate.ok) {
    return new Response(t('delivery.report.tooMany'), {
      status: 429, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)) },
    });
  }
  const pdf = await renderDeliveryReport(db, { reportId: id, orderWhere: scope, locale, staff, appUrl: getEnv().APP_URL });
  if (!pdf) return new Response(t('common.fileNotFound'), { status: 404 });
  // Görüntüleme kaydı ayrı eylemle (mali belge PDF'indeki FINANCE_DOC_VIEW gibi): FILE_DOWNLOAD diskteki dosyaların tek kayıt noktası
  await audit('DELIVERY_REPORT_VIEW', 'DeliveryReport', id, userId, { orderId: pdf.orderId, name: pdf.name, revision: pdf.revision });
  return new Response(new Uint8Array(pdf.buf), {
    headers: {
      'Content-Type': 'application/pdf', 'Content-Length': String(pdf.buf.length), 'Content-Disposition': contentDisposition(pdf.name, { inline: true }),
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    },
  });
}
