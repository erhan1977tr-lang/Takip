import { db } from './db';
import { audit } from './audit';
import { getAvSettings } from '../server/files/antivirus.js';
import { cleanupCollector, discardStored, storeUploads, uploadRoot } from '../server/files/store.js';
import { checkUpload } from '../server/files/limits.js';
import { getEnv } from './env';

export type StoredUpload = {
  storageKey: string; name: string; size: number; mime: string; checksum: string;
  scanStatus: 'CLEAN' | 'PENDING' | 'SKIPPED'; scanSignature: null; scannedAt: Date | null;
};
export type UploadProblem = {
  code: 'empty' | 'mismatch' | 'infected' | 'av_unavailable' | 'too_many' | 'size' | 'rate' | 'order_quota' | 'disk';
  name: string; signature?: string;
};

type UploadContext = { userId: string | null; orderId?: string | null; depot?: boolean };

/**
 * Silinemeyen yükleme dosyaları için tek bir denetim kaydı (NEW-GL-02, karar 153). Kayda yalnızca sayı, aşama
 * (geçici / saklanan) ve hata kodu girer (cleanupCollector): dosya yolu, dosya adı ve hata metni yazılmaz.
 * Denetim kaydı yazılamazsa işlem bozulmaz (audit hata fırlatmaz).
 */
async function auditCleanup(ctx: UploadContext, summary: { count: number; stages: string[]; codes: string[] } | null) {
  if (!summary) return;
  await audit('UPLOAD_CLEANUP_FAILED', 'Upload', ctx.orderId ?? null, ctx.userId, {
    count: summary.count, stages: summary.stages, codes: summary.codes, depot: ctx.depot === true,
  });
}

/**
 * Formdan gelen dosyaları içerik kontrolü ve antivirüs taramasıyla kaydeder (server/files/store.js).
 * Biri reddedilirse ya da saklanırken hata olursa o ana kadar kaydedilenler de silinir; hiçbiri kaydedilmemiş olur
 * (storeUploads: geçici dosya da her çıkışta silinir).
 * Virüslü dosya denetim kaydına ve bildirim kuyruğuna yazılır.
 * Önce yükleme sınırları (server/files/limits.js): istek / sipariş / kullanıcı kotası ve boş disk alanı — sınır aşılıyorsa
 * hiçbir dosya diske yazılmaz, taranmaz; reddedilen yükleme denetim kaydına yazılır.
 */
export async function storeFiles(
  files: File[],
  ctx: UploadContext,
): Promise<{ ok: true; stored: StoredUpload[] } | { ok: false; problem: UploadProblem }> {
  const limit = await checkUpload(db, files.map((f) => ({ name: f.name, size: f.size })), ctx, { root: uploadRoot(), minFreeMb: getEnv().UPLOAD_MIN_FREE_MB });
  if (limit) {
    if (limit.code === 'disk') console.error('Yükleme reddedildi: yükleme klasöründe boş alan sınırın altında (UPLOAD_MIN_FREE_MB)');
    await audit('UPLOAD_REJECTED', 'Upload', ctx.orderId ?? null, ctx.userId, { reason: limit.code, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) });
    return { ok: false, problem: limit };
  }
  const av = await getAvSettings(db);
  const cleanup = cleanupCollector();
  // Ya hepsi ya hiçbiri; hata fırlatılsa da (akış koptu, disk doldu…) önce saklananlar silinir, sonra denetim kaydı yazılır
  const res = await storeUploads(files.map((f) => ({ name: f.name, stream: () => f.stream() })), { av, onCleanupFailure: cleanup.report })
    .finally(() => auditCleanup(ctx, cleanup.summary()));
  if (!res.ok) {
    const r = res.problem;
    if (r.code === 'infected') {
      await audit('FILE_INFECTED', 'Upload', ctx.orderId ?? null, ctx.userId, { name: r.name, signature: r.signature ?? null, when: 'yükleme' });
      await db.notificationOutbox.create({
        data: { type: 'FILE_INFECTED', orderId: ctx.orderId ?? null, payload: { name: r.name, signature: r.signature ?? null, userId: ctx.userId } },
      });
    }
    return { ok: false, problem: { code: r.code, name: r.name, signature: r.signature } };
  }
  return { ok: true, stored: res.files as StoredUpload[] };
}

/** Kaydı oluşmayan yüklemelerin dosyalarını siler. Hata fırlatmaz: silinemeyen dosya yalnızca günlüğe ve denetim kaydına yazılır. */
export async function discardFiles(stored: { storageKey: string }[]) {
  const cleanup = cleanupCollector();
  await discardStored(stored, { onCleanupFailure: cleanup.report });
  await auditCleanup({ userId: null }, cleanup.summary());
}
