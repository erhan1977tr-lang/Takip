'use server';

// Depo bağlantısı (giriş gerektirmez; e-postadaki tek kullanımlık adres). Anahtarın özeti ProfileOrder'dadır.
// Depo imzalı teslim belgesini yükler ve teslimi onaylar → sipariş TESLIM_EDILDI (server/profile/transitions.js).
// Teslimden sonra da bağlantı süresince ek belge yüklenebilir. Geçersiz anahtar denemeleri IP başına sınırlıdır.
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { requestIp } from '@/lib/auth/throttle';
import { filesFrom } from '@/lib/storage';
import { discardFiles, storeFiles } from '@/lib/uploads';
import { findDepotOrder } from '@/server/profile/warehouse.js';
import { depotActor, runProfileAction, WorkflowError } from '@/server/profile/transitions.js';
import { WINDOW_MS } from '@/server/auth/throttle.js';

const EXT = ['pdf', 'jpg', 'jpeg', 'png'];
const MAX = 20 * 1024 * 1024;
const DEPOT_FAIL_LIMIT = 30;

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
  const stored = await storeFiles(files, { userId: null, orderId: p.orderId });
  if (!stored.ok) redirect(`${base}?e=type&n=${encodeURIComponent(stored.problem.name)}`);

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
