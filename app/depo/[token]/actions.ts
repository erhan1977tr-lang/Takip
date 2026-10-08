'use server';

// Depo bağlantısı (giriş gerektirmez; e-postadaki tek kullanımlık adres). Anahtarın özeti ProfileOrder'dadır.
// Depo imzalı teslim belgesini yükler ve teslimi onaylar → sipariş TESLIM_EDILDI (server/profile/transitions.js).
// Teslimden sonra da bağlantı süresince ek belge yüklenebilir. Geçersiz anahtar denemeleri IP başına sınırlıdır.
// Paket 8 (karar 195–196): teslimat fotoğrafları (fotoğraf başına ayrı istek — biri reddedilirse ötekiler kalır) ve teslimat
// raporu (kopya) da buradan; ikisi de siparişin depoya iletilmiş olmasını ister (server/delivery/*).
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { requestIp } from '@/lib/auth/throttle';
import { filesFrom } from '@/lib/storage';
import { discardFiles, storeFiles } from '@/lib/uploads';
import { getT } from '@/lib/i18n';
import { findDepotOrder } from '@/server/profile/warehouse.js';
import { depotActor, runProfileAction, WorkflowError } from '@/server/profile/transitions.js';
import { WINDOW_MS } from '@/server/auth/throttle.js';
import { photoProblem, takesDeliveryDocs } from '@/server/delivery/rules.js';
import { createDeliveryReport, recordDeliveryPhoto } from '@/server/delivery/service.js';
import { photoUploadError } from '@/lib/delivery';
import type { PhotoUploadResult } from '@/components/DeliveryPhotoUpload';

const EXT = ['pdf', 'jpg', 'jpeg', 'png'];
const MAX = 20 * 1024 * 1024;
const DEPOT_FAIL_LIMIT = 30;
// Yükleme sınırları (server/files/limits.js): depo bağlantısından sipariş başına toplam 200 MB / 40 dosya + disk koruması
const LIMIT_CODES = ['too_many', 'size', 'rate', 'order_quota', 'disk'];

async function blocked(ip: string) {
  const n = await db.authFailure.count({ where: { kind: 'DEPOT', ip, createdAt: { gte: new Date(Date.now() - WINDOW_MS) } } });
  return n >= DEPOT_FAIL_LIMIT;
}

export async function depotAction(fd: FormData) {
  const token = String(fd.get('token') ?? '');
  const intent = fd.get('intent') === 'add' ? 'add' : 'confirm';
  const ip = await requestIp();
  const base = `/depo/${encodeURIComponent(token)}`;
  if (await blocked(ip)) redirect(`${base}?e=many`);
  const p = await findDepotOrder(db, token);
  if (!p) {
    await db.authFailure.create({ data: { kind: 'DEPOT', email: '-', ip: ip.slice(0, 64) } });
    redirect(`${base}?e=invalid`);
  }
  const files = filesFrom(fd, 'files');
  if (files.length === 0) redirect(`${base}?e=file`);
  for (const f of files) {
    const ext = f.name.toLowerCase().split('.').pop() ?? '';
    if (!EXT.includes(ext) || f.size > MAX) redirect(`${base}?e=type&n=${encodeURIComponent(f.name)}`);
  }
  // Dosyalar içerik kontrolü ve antivirüsten geçer; yükleyen kişi yok (depo bağlantısı)
  const stored = await storeFiles(files, { userId: null, orderId: p.orderId, depot: true });
  if (!stored.ok) redirect(LIMIT_CODES.includes(stored.problem.code) ? `${base}?e=limit` : `${base}?e=type&n=${encodeURIComponent(stored.problem.name)}`);

  if (intent === 'confirm' && p.stage === 'DEPODA') {
    try {
      await runProfileAction(db, { orderId: p.orderId, action: 'mark_delivered', actor: depotActor(ip), payload: { files: stored.stored } });
    } catch (e) {
      await discardFiles(stored.stored);
      if (e instanceof WorkflowError) redirect(`${base}?e=state`);
      throw e;
    }
  } else {
    // Teslimden sonra ek belge
    try {
      await db.orderFile.createMany({
        data: stored.stored.map((s) => ({ ...s, orderId: p.orderId, kind: 'INTERNAL' as const, source: 'DEPOT_LINK', uploadedById: null })),
      });
    } catch (e) {
      await discardFiles(stored.stored);
      throw e;
    }
    await audit('DEPOT_FILES_ADDED', 'Order', p.orderId, null, { names: stored.stored.map((s) => s.name), ip });
  }
  revalidatePath(`/siparisler/${p.orderId}`);
  redirect(`${base}?ok=${intent === 'confirm' ? 'done' : 'added'}`);
}

/** Geçerli depo bağlantısının siparişi; geçersiz anahtar sayılır (IP başına sınır) */
async function depotOrder(token: string, ip: string) {
  const p = await findDepotOrder(db, token);
  if (!p) await db.authFailure.create({ data: { kind: 'DEPOT', email: '-', ip: ip.slice(0, 64) } });
  return p;
}

/**
 * Depo: tek teslimat fotoğrafı (istemci seçilen fotoğrafları sırayla, her birini ayrı istekle gönderir). Dosya içerik
 * denetimi, antivirüs ve depo bağlantısı kotasından geçer; aynı fotoğraf ikinci kez gelirse yeni kayıt yazılmaz.
 */
export async function depotPhotoAction(fd: FormData): Promise<PhotoUploadResult> {
  const { t } = await getT();
  const token = String(fd.get('token') ?? '');
  const ip = await requestIp();
  if (await blocked(ip)) return { ok: false, error: t('delivery.photos.errors.many') };
  const p = await depotOrder(token, ip);
  if (!p) return { ok: false, error: t('delivery.photos.errors.invalid') };
  const files = filesFrom(fd, 'photo');
  if (files.length !== 1) return { ok: false, error: t('delivery.photos.errors.empty') };
  const problem = photoProblem(files[0]);
  if (problem) return { ok: false, error: t(`delivery.photos.errors.${problem}`) };
  if (!takesDeliveryDocs({ stage: p.stage, status: p.order.status })) return { ok: false, error: t('delivery.photos.errors.state') };
  const stored = await storeFiles(files, { userId: null, orderId: p.orderId, depot: true });
  if (!stored.ok) return { ok: false, error: photoUploadError(t, stored.problem.code) };
  let r;
  try {
    r = await recordDeliveryPhoto(db, { orderId: p.orderId, stored: stored.stored[0], actor: depotActor(ip) });
  } catch (e) {
    await discardFiles(stored.stored);
    throw e;
  }
  // Kayıt yazılmadıysa (aynı fotoğraf zaten var ya da adım uygun değil) az önce saklanan dosya silinir
  if (!r.ok || r.duplicate) await discardFiles(stored.stored);
  if (!r.ok) return { ok: false, error: t(r.code === 'STATE' ? 'delivery.photos.errors.state' : 'delivery.photos.errors.other') };
  revalidatePath(`/siparisler/${p.orderId}`);
  return { ok: true, duplicate: r.duplicate };
}

/** Depo: teslimat raporu oluştur (açıklama isteğe bağlı; tek kullanımlık form anahtarı) */
export async function depotReportAction(fd: FormData) {
  const token = String(fd.get('token') ?? '');
  const ip = await requestIp();
  const base = `/depo/${encodeURIComponent(token)}`;
  if (await blocked(ip)) redirect(`${base}?e=many`);
  const p = await depotOrder(token, ip);
  if (!p) redirect(`${base}?e=invalid`);
  const r = await createDeliveryReport(db, { orderId: p.orderId, note: fd.get('note'), requestKey: fd.get('key'), actor: depotActor(ip) });
  if (!r.ok) redirect(`${base}?e=${r.code === 'STATE' ? 'report_state' : 'state'}`);
  revalidatePath(`/siparisler/${p.orderId}`);
  redirect(`${base}?ok=${r.duplicate ? 'report_same' : 'report'}&n=${r.revision}#rapor`);
}
