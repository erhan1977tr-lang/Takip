'use server';

// Kırık / telafi camı ve siparişi silme / geri yükleme (Aşama 9). Kurallar ve kayıt server/orders/compensation.js ile
// server/orders/removal.js'tedir; burada yalnızca oturum, form okuma ve sonuç yönlendirmesi var. Yetki hem burada
// (requirePermission) hem de servisin içinde denetlenir — düğmeyi gizlemek yetki değildir.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { loadOrder } from '@/lib/orders';
import { actorOf } from '@/lib/actor';
import { createCompensation, decideCompensation } from '@/server/orders/compensation.js';
import { removeOrder, restoreOrder } from '@/server/orders/removal.js';

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

function refresh(...ids: string[]) {
  revalidatePath('/siparisler');
  revalidatePath('/teklifler');
  revalidatePath('/yuklemeler');
  revalidatePath('/admin/kararlar');
  for (const id of ids) if (id) revalidatePath(`/siparisler/${id}`);
}

/**
 * "Telafi camını ekle": teklif tablosundaki "Kırık / Telafi" ve "Önemli kararlar"daki düğme aynı forma, aynı işleme
 * gelir (tek telafi mantığı). Satış ve yönetici (OFFER_PREPARE).
 */
export async function createCompensationAction(formData: FormData) {
  const user = await requirePermission('OFFER_PREPARE');
  const id = text(formData, 'id');
  // Kaynak sipariş kullanıcının kapsamında olmalı (değilse 404)
  await loadOrder(id, user);
  const lineId = text(formData, 'lineId');
  const back = (code: string) => `/siparisler/${id}?telafi=${encodeURIComponent(lineId || 'sec')}&telafiHata=${code}#telafi`;
  const destType = text(formData, 'destType');
  // Hedef her zaman kullanıcının seçimidir: müşterinin ileri tarihli siparişi YA DA yeni telafi siparişi (varsayılan yok)
  if (destType !== 'NEW' && destType !== 'EXISTING') redirect(back('BAD_DEST'));
  const dest = destType === 'NEW' ? { type: 'NEW' as const, day: text(formData, 'day') } : { type: 'EXISTING' as const, orderId: text(formData, 'destOrderId') };
  const r = await createCompensation(db, {
    orderId: id, lineId, quantity: text(formData, 'quantity'), mode: text(formData, 'mode'), price: text(formData, 'price') || null, dest,
    notLoadedItemId: text(formData, 'itemId') || null, requestKey: text(formData, 'key'), confirm: formData.get('confirm') === 'on',
    actor: await actorOf(user),
  });
  if (r.ok) {
    refresh(id, r.destOrderId);
    const kind = r.duplicate ? 'duplicate' : r.status === 'PENDING' ? 'pending' : 'created';
    redirect(`/siparisler/${id}?telafiOk=${kind}&hedef=${encodeURIComponent(r.destOrderNo)}#kararlar`);
  }
  redirect(back(r.code));
}

/** Yönetici: satışın onay bekleyen telafisini onaylar (teklifin yeni sürümü müşteriye gider) ya da reddeder. */
export async function decideCompensationAction(formData: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = text(formData, 'id');
  const approve = text(formData, 'do') === 'approve';
  const r = await decideCompensation(db, {
    id: text(formData, 'compId'), approve, price: text(formData, 'price') || null, free: formData.get('free') === 'on',
    note: text(formData, 'note') || null, actor: await actorOf(user),
  });
  if (r.ok) {
    refresh(id, r.destOrderId);
    redirect(`/siparisler/${id}?telafiOk=${approve ? 'applied' : 'rejected'}#kararlar`);
  }
  redirect(`/siparisler/${id}?telafiHata=${r.code}#kararlar`);
}

/** "Siparişi sil" (yalnızca yönetici): iki adımlı — ikinci adımın onay kutusu işaretlenmeden sunucu da silmez. */
export async function removeOrderAction(formData: FormData) {
  const user = await requirePermission('ORDER_CANCEL');
  const id = text(formData, 'id');
  const r = await removeOrder(db, { orderId: id, confirm: formData.get('confirm') === 'on', actor: await actorOf(user) });
  if (r.ok) {
    refresh(id);
    revalidatePath('/', 'layout');
    redirect(`/siparisler?silindi=${encodeURIComponent(r.orderNo)}#silinen`);
  }
  redirect(r.code === 'NOT_FOUND' || r.code === 'ALREADY_REMOVED' ? `/siparisler?silHata=${r.code}` : `/siparisler/${id}?silHata=${r.code}#sil`);
}

/** Silinmiş siparişi geri yükler (yalnızca yönetici). */
export async function restoreOrderAction(formData: FormData) {
  const user = await requirePermission('ORDER_CANCEL');
  const id = text(formData, 'id');
  const r = await restoreOrder(db, { orderId: id, actor: await actorOf(user) });
  if (r.ok) {
    refresh(id);
    revalidatePath('/', 'layout');
    redirect(`/siparisler/${id}?ok=restored`);
  }
  redirect(`/siparisler?silHata=${r.code}#silinen`);
}
