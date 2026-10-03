'use server';

// Cam siparişi FGO belgeleri (yönetici). Kurallar ve tekrar kesim engeli server/glass/billing.js'te.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { dispatchGlassJobs, requestGlassDocument } from '@/server/glass/billing.js';

const back = (id: string, q: string) => `/siparisler/${id}?${q}#finans`;

/**
 * Proforma / avans faturası / fatura iste: kuyruğa alınır ve hemen denenir (işçi de dakikada bir dener).
 * Avans faturasının tutarı formdan GELMEZ: FGO'nun proformada gösterdiği tahsilat − avansı kesilen (karar 104).
 */
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
