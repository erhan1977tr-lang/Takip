'use server';

// Ayarlar → Tedarikçiler (Paket 6, karar 179). Kurallar server/suppliers/{rules,service}.js'te; burada yalnızca form okuma
// ve yönlendirme. Yetki: SUPPLIER_MANAGE (yalnızca yönetici) — burada ve serviste ayrı ayrı.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { saveSupplier, setSupplierActive } from '@/server/suppliers/service.js';

const PATH = '/admin/entegrasyonlar/tedarikciler';
const back = (q: string) => `${PATH}?${q}`;

export async function saveSupplierAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = String(fd.get('supplierId') ?? '') || null;
  const edit = id ? `&duzenle=${encodeURIComponent(id)}` : '';
  const r = await saveSupplier(db, {
    id,
    name: fd.get('name'),
    contactName: fd.get('contactName'),
    email: fd.get('email'),
    phone: fd.get('phone'),
    address: fd.get('address'),
    currency: fd.get('currency'),
    // Yeni tedarikçi etkin başlar; düzenlemede kutunun durumu
    isActive: id ? fd.get('isActive') === 'on' : true,
  }, await actorOf(admin));
  if (!r.ok) redirect(back(`error=${encodeURIComponent(r.code)}${edit}#tedarikci`));
  revalidatePath(PATH);
  redirect(back(`ok=${id ? 'saved' : 'added'}#t-${r.id}`));
}

export async function toggleSupplierAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = String(fd.get('supplierId') ?? '');
  const r = await setSupplierActive(db, { id, active: fd.get('active') === '1' }, await actorOf(admin));
  if (!r.ok) redirect(back(`error=${encodeURIComponent(r.code)}`));
  revalidatePath(PATH);
  redirect(back(`ok=toggled#t-${id}`));
}
