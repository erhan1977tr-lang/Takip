'use server';

// Müşteri düzeyinde yükleme öncesi proforma (Aşama 7D-2; yalnızca yönetici, ACCOUNTING_MANAGE).
// Kurallar ve çift faturalama engeli server/glass/batch.js'te; yetki orada da denetlenir.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { cleanDays, createBatch, dispatchBatchJobs, reviewFailedBatch } from '@/server/glass/batch.js';

const PAGE = '/admin/muhasebe/cam/proforma';

/** Seçimi (müşteri + günler + elle kur) adrese geri yazar: hata sonrası aynı önizleme açılır */
function back(customerId: string, days: string[], rate: string, extra: Record<string, string>, hash = '') {
  const q = new URLSearchParams();
  if (customerId) q.set('musteri', customerId);
  for (const d of days) q.append('gun', d);
  if (rate) q.set('kur', rate);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `${PAGE}?${q.toString()}${hash}`;
}

/** "Proforma oluştur": parti oluşturulur, FGO proforması kuyruğa alınır ve hemen denenir (işçi de dakikada bir dener) */
export async function createBatchAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const customerId = String(fd.get('customerId') ?? '');
  const days = cleanDays(fd.getAll('day').map(String));
  const rate = String(fd.get('fxRate') ?? '').trim();
  const r = await createBatch(db, { customerId, days, key: String(fd.get('key') ?? ''), manualRate: rate || null, actor: await actorOf(user) });
  if (!r.ok) redirect(back(customerId, days, rate, { error: r.code }, '#onizleme'));
  await dispatchBatchJobs(db, { onlyBatchId: r.batchId });
  revalidatePath(PAGE);
  revalidatePath('/admin/muhasebe/cam');
  redirect(back(customerId, [], '', { ok: 'created', n: String(r.orders) }, '#partiler'));
}

/** Kesilemeyen parti: yeniden dene ya da vazgeç */
export async function reviewBatchAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const batchId = String(fd.get('batchId') ?? '');
  const customerId = String(fd.get('customerId') ?? '');
  const action = fd.get('do') === 'void' ? 'void' : 'retry';
  const r = await reviewFailedBatch(db, { batchId, action, actor: await actorOf(user) });
  if (!r.ok) redirect(back(customerId, [], '', { error: r.code }, '#partiler'));
  if (action === 'retry') await dispatchBatchJobs(db, { onlyBatchId: batchId });
  revalidatePath(PAGE);
  redirect(back(customerId, [], '', { ok: action }, '#partiler'));
}
