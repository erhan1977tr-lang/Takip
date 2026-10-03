'use server';

// Cam siparişi FGO belgeleri (yönetici). Kurallar ve tekrar kesim engeli server/glass/billing.js'te.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { dispatchGlassJobs, markGlassPaid, requestGlassDocument } from '@/server/glass/billing.js';
import { parseAmount } from '@/server/accounting/supplier.js';

const back = (id: string, q: string) => `/siparisler/${id}?${q}#finans`;

/** Proforma / avans faturası / fatura iste: kuyruğa alınır ve hemen denenir (işçi de dakikada bir dener). */
export async function glassDocumentAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = String(fd.get('id') ?? '');
  const kind = String(fd.get('kind') ?? '');
  if (!['PROFORMA', 'ADVANCE', 'INVOICE'].includes(kind)) redirect(back(id, 'fgoError=NOT_ALLOWED'));
  // Elle kur (isteğe bağlı): geçerliliği ve "kur zaten belirli" denetimi requestGlassDocument'ta
  const r = await requestGlassDocument(db, { orderId: id, kind, actor: await actorOf(user), manualRate: String(fd.get('fxRate') ?? '').trim() || null });
  if (!r.ok) redirect(back(id, `fgoError=${r.code}`));
  await dispatchGlassJobs(db, { onlyOrderId: id });
  revalidatePath(`/siparisler/${id}`);
  revalidatePath('/admin/muhasebe/cam');
  redirect(back(id, 'fgoOk=requested'));
}

/** Proforma ödendi (FGO'da tahsilat görünmüyorsa): tahsil edilen tutar, RON, TVA dahil */
export async function glassPaidAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = String(fd.get('id') ?? '');
  const amount = parseAmount(fd.get('amount'));
  if (amount == null) redirect(back(id, 'fgoError=BAD_AMOUNT'));
  const r = await markGlassPaid(db, { orderId: id, amount, actor: await actorOf(user) });
  revalidatePath(`/siparisler/${id}`);
  redirect(back(id, r.ok ? 'fgoOk=paid' : `fgoError=${r.code}`));
}
