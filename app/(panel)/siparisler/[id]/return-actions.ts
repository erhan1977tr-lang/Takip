'use server';

// Profil iadesi (DÜZELTME 10 M8) — sipariş sayfasının işlemleri. Kurallar ve yetki server/profile/returns.js'te
// (PROFILE_RETURN_MANAGE — burada ve serviste ayrı ayrı). Burada yalnızca form okuma, isteğe bağlı fotoğrafların saklanması ve
// yönlendirme. Hiçbir FGO işlemi yoktur.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getEnv } from '@/lib/env';
import { filesFrom } from '@/lib/storage';
import { discardFiles, storeFiles } from '@/lib/uploads';
import { photoProblem } from '@/server/delivery/rules.js';
import { RETURN_LIMITS } from '@/server/profile/returns-rules.js';
import { cancelReturn, confirmReturnReceipt, createReturn, markRefundDone } from '@/server/profile/returns.js';

const back = (id: string, q: string) => `/siparisler/${encodeURIComponent(id)}?${q}#iade`;
const idOf = (fd: FormData) => String(fd.get('id') ?? '');
/** Satır alanları: q-<satır> → { satır: değer } */
const fields = (fd: FormData, prefix: string) => Object.fromEntries([...fd.keys()].filter((k) => k.startsWith(prefix)).map((k) => [k.slice(prefix.length), String(fd.get(k) ?? '')]));
function finish(id: string, q: string): never {
  revalidatePath(`/siparisler/${id}`);
  revalidatePath('/admin/stok');
  redirect(back(id, q));
}

export async function createReturnAction(fd: FormData) {
  const user = await requirePermission('PROFILE_RETURN_MANAGE');
  const id = idOf(fd);
  const actor = await actorOf(user);
  const files = filesFrom(fd, 'photos');
  if (files.length > RETURN_LIMITS.photos) redirect(back(id, 'rerr=PHOTOS'));
  if (files.some((f) => photoProblem(f))) redirect(back(id, 'rerr=PHOTO_TYPE'));
  const stored = files.length ? await storeFiles(files, { userId: user.id, orderId: id }) : { ok: true as const, stored: [] };
  if (!stored.ok) redirect(back(id, 'rerr=PHOTO_TYPE'));
  let r;
  try {
    r = await createReturn(db, {
      orderId: id, reason: fd.get('reason'), note: fd.get('note'), quantities: fields(fd, 'q-'), financeAction: fd.get('financeAction'),
      requestKey: fd.get('requestKey'), photos: stored.stored,
    }, actor);
  } catch (e) {
    await discardFiles(stored.stored);
    throw e;
  }
  if (!r.ok || r.duplicate) await discardFiles(stored.stored);
  if (!r.ok) redirect(back(id, `rerr=${encodeURIComponent(r.code)}`));
  finish(id, `rok=${r.duplicate ? 'duplicate' : 'opened'}`);
}

export async function receiveReturnAction(fd: FormData) {
  const user = await requirePermission('PROFILE_RETURN_MANAGE');
  const id = idOf(fd);
  const good = fields(fd, 'g-');
  const damaged = fields(fd, 'd-');
  const quantities = Object.fromEntries([...new Set([...Object.keys(good), ...Object.keys(damaged)])].map((k) => [k, { good: good[k] ?? '', damaged: damaged[k] ?? '' }]));
  const r = await confirmReturnReceipt(db, { returnId: String(fd.get('returnId') ?? ''), quantities, note: fd.get('note') }, await actorOf(user));
  if (!r.ok) redirect(back(id, `rerr=${encodeURIComponent(r.code)}`));
  finish(id, 'rok=received');
}

export async function cancelReturnAction(fd: FormData) {
  const user = await requirePermission('PROFILE_RETURN_MANAGE');
  const id = idOf(fd);
  const r = await cancelReturn(db, { returnId: String(fd.get('returnId') ?? ''), reason: fd.get('reason') }, await actorOf(user));
  if (!r.ok) redirect(back(id, `rerr=${encodeURIComponent(r.code)}`));
  finish(id, 'rok=cancelled');
}

export async function refundDoneAction(fd: FormData) {
  const user = await requirePermission('PROFILE_RETURN_MANAGE');
  const id = idOf(fd);
  const r = await markRefundDone(db, { returnId: String(fd.get('returnId') ?? ''), doneOn: fd.get('doneOn'), reference: fd.get('reference') }, await actorOf(user), { timeZone: getEnv().APP_TIMEZONE });
  if (!r.ok) redirect(back(id, `rerr=${encodeURIComponent(r.code)}`));
  finish(id, 'rok=refund');
}
