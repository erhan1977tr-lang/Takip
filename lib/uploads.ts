import { db } from './db';
import { audit } from './audit';
import { getAvSettings } from '../server/files/antivirus.js';
import { removeUpload, storeUpload } from '../server/files/store.js';

export type StoredUpload = {
  storageKey: string; name: string; size: number; mime: string; checksum: string;
  scanStatus: 'CLEAN' | 'PENDING' | 'SKIPPED'; scanSignature: null; scannedAt: Date | null;
};
export type UploadProblem = { code: 'empty' | 'mismatch' | 'infected' | 'av_unavailable'; name: string; signature?: string };

/**
 * Formdan gelen dosyaları içerik kontrolü ve antivirüs taramasıyla kaydeder (server/files/store.js).
 * Biri reddedilirse o ana kadar kaydedilenler de silinir; hiçbiri kaydedilmemiş olur.
 * Virüslü dosya denetim kaydına ve bildirim kuyruğuna yazılır.
 */
export async function storeFiles(
  files: File[],
  ctx: { userId: string; orderId?: string | null },
): Promise<{ ok: true; stored: StoredUpload[] } | { ok: false; problem: UploadProblem }> {
  const av = await getAvSettings(db);
  const stored: StoredUpload[] = [];
  for (const f of files) {
    const r = await storeUpload(f.stream(), { name: f.name }, { av });
    if (!r.ok) {
      await Promise.all(stored.map((s) => removeUpload(s.storageKey)));
      if (r.code === 'infected') {
        await audit('FILE_INFECTED', 'Upload', ctx.orderId ?? null, ctx.userId, { name: r.name, signature: r.signature ?? null, when: 'yükleme' });
        await db.notificationOutbox.create({
          data: { type: 'FILE_INFECTED', orderId: ctx.orderId ?? null, payload: { name: r.name, signature: r.signature ?? null, userId: ctx.userId } },
        });
      }
      return { ok: false, problem: { code: r.code, name: r.name, signature: r.signature } };
    }
    stored.push(r.file as StoredUpload);
  }
  return { ok: true, stored };
}

export async function discardFiles(stored: { storageKey: string }[]) {
  await Promise.all(stored.map((s) => removeUpload(s.storageKey)));
}
