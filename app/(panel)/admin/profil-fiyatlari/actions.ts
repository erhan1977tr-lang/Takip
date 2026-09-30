'use server';

// Müşteriye özel profil fiyat tabloları (yönetici, Aşama 6). Kurallar server/profile/pricing.js'te.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { audit } from '@/lib/audit';
import { saveTablePrices, validateTableName } from '@/server/profile/pricing.js';

const PATH = '/admin/profil-fiyatlari';
const back = (tableId: string | null, q: string) => `${PATH}?${tableId ? `tablo=${encodeURIComponent(tableId)}&` : ''}${q}`;

/** Tablo oluştur ya da adını değiştir */
export async function saveProfileTableAction(fd: FormData) {
  const admin = await requirePermission('PRICE_TABLE_MANAGE');
  const id = String(fd.get('tableId') ?? '') || null;
  const v = validateTableName(fd.get('name'));
  if (!v.ok) redirect(back(id, 'error=name'));
  const clash = await db.profilePriceTable.findUnique({ where: { name: v.name } });
  if (clash && clash.id !== id) redirect(back(id, 'error=exists'));
  if (id) {
    const cur = await db.profilePriceTable.findUnique({ where: { id } });
    if (!cur) redirect(back(null, 'error=not_found'));
    await db.profilePriceTable.update({ where: { id }, data: { name: v.name } });
    await audit('PROFILE_PRICE_TABLE_UPDATE', 'ProfilePriceTable', id, admin.id, { before: cur.name, after: v.name });
    revalidatePath(PATH);
    redirect(back(id, 'ok=saved'));
  }
  const tbl = await db.profilePriceTable.create({ data: { name: v.name } });
  await audit('PROFILE_PRICE_TABLE_CREATE', 'ProfilePriceTable', tbl.id, admin.id, { name: v.name });
  revalidatePath(PATH);
  redirect(back(tbl.id, 'ok=created'));
}

export async function toggleProfileTableAction(fd: FormData) {
  const admin = await requirePermission('PRICE_TABLE_MANAGE');
  const id = String(fd.get('tableId') ?? '');
  const cur = await db.profilePriceTable.findUnique({ where: { id } });
  if (!cur) redirect(back(null, 'error=not_found'));
  await db.profilePriceTable.update({ where: { id }, data: { isActive: !cur.isActive } });
  await audit('PROFILE_PRICE_TABLE_UPDATE', 'ProfilePriceTable', id, admin.id, { isActive: !cur.isActive });
  revalidatePath(PATH);
  redirect(back(id, 'ok=saved'));
}

/** Fiyatlar: formdaki tüm ürünler (boş → tablodan kaldırılır, liste fiyatı geçerli olur) */
export async function saveProfileTablePricesAction(fd: FormData) {
  const admin = await requirePermission('PRICE_TABLE_MANAGE');
  const id = String(fd.get('tableId') ?? '');
  const ids = fd.getAll('p_id').map(String);
  const prices = fd.getAll('p_price').map((v) => String(v).trim());
  const changes = Object.fromEntries(ids.map((pid, i) => [pid, prices[i] ?? '']));
  const r = await saveTablePrices(db, id, changes, await actorOf(admin));
  if (!r.ok) redirect(back(id, r.code === 'BAD_PRICE' ? 'error=bad_price' : 'error=not_found'));
  revalidatePath(PATH);
  redirect(back(id, `ok=prices&n=${r.changed}`));
}

/** Firmayı tabloya bağla ya da bağlantıyı kaldır */
export async function assignProfileTableAction(fd: FormData) {
  const admin = await requirePermission('PRICE_TABLE_MANAGE');
  const id = String(fd.get('tableId') ?? '');
  const customerId = String(fd.get('customerId') ?? '');
  const remove = fd.get('intent') === 'unassign';
  const firm = await db.customer.findFirst({ where: { id: customerId, type: 'CUSTOMER' } });
  const table = await db.profilePriceTable.findUnique({ where: { id } });
  if (!firm || !table) redirect(back(id || null, 'error=not_found'));
  const before = firm.profilePriceTableId;
  const after = remove ? (before === id ? null : before) : id;
  await db.customer.update({ where: { id: firm.id }, data: { profilePriceTableId: after } });
  await audit('PROFILE_PRICE_TABLE_ASSIGN', 'Customer', firm.id, admin.id, { before, after });
  revalidatePath(PATH);
  redirect(back(id, 'ok=assigned#firmalar'));
}
