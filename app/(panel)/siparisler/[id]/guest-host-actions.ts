'use server';

// "Özel durum — başka firmanın yüklemesiyle gidecek" (karar 124): yönetici sipariş sayfasında yalnızca EV SAHİBİ FİRMAYI
// seçer / değiştirir / kaldırır. Sandık burada seçilmez (Yüklemeler ekranında satış seçer). Kurallar ve yetki
// server/loading/crates.js → setGuestHost içinde, sunucuda da denetlenir (LOADING_CONFIRM — yalnızca yönetici).
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { setGuestHost } from '@/server/loading/crates.js';

export async function setGuestHostAction(formData: FormData) {
  const user = await requirePermission('LOADING_CONFIRM');
  const orderId = String(formData.get('orderId') ?? '');
  // İşaret kaldırıldıysa firma alanı gönderilmez → ilişki kaldırılır
  const hostId = formData.get('on') ? String(formData.get('hostId') ?? '') : '';
  const back = (q: string) => `/siparisler/${encodeURIComponent(orderId)}?${q}#ozel-durum`;
  if (formData.get('on') && !hostId) redirect(back('ozelHata=NOT_SAME_LOADING'));
  const r = await setGuestHost(db, { orderId, hostId: hostId || null, actor: await actorOf(user) });
  revalidatePath(`/siparisler/${orderId}`);
  revalidatePath('/yuklemeler');
  redirect(r.ok ? back(r.changed ? `ozel=${r.hostId ? 'set' : 'removed'}` : '') : back(`ozelHata=${r.code}`));
}
