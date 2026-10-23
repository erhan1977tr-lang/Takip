'use server';

// Ayarlar → Fabrika Ekipleri (4.3.19, karar 304). Kural, kilit ve denetim kaydı server/teams/service.js'te; burada yalnızca
// form okuma. Yetki: USER_MANAGE (sayfa ve işlem) + PRICE_TABLE_MANAGE — serviste ilk deyim olarak yeniden denetlenir.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { saveTeam, setTeamActive } from '@/server/teams/service.js';

const PATH = '/admin/entegrasyonlar/ekipler';
const field = (fd: FormData, k: string) => String(fd.get(k) ?? '').slice(0, 200);

export async function saveTeamAction(fd: FormData) {
  const admin = await requirePermission('USER_MANAGE');
  const id = field(fd, 'id');
  const r = await saveTeam(db, {
    input: { id, name: field(fd, 'name'), salesUserId: field(fd, 'salesUserId'), drawerId: field(fd, 'drawerId'), priceTableId: field(fd, 'priceTableId') },
    actor: await actorOf(admin),
  });
  revalidatePath(PATH);
  if (!r.ok) redirect(`${PATH}?error=${encodeURIComponent(r.code)}${id ? `&duzenle=${encodeURIComponent(id)}` : ''}#ekip-formu`);
  redirect(`${PATH}?ok=${r.created ? 'created' : 'saved'}`);
}

export async function setTeamActiveAction(fd: FormData) {
  const admin = await requirePermission('USER_MANAGE');
  const active = fd.get('active') === '1';
  const r = await setTeamActive(db, { id: field(fd, 'id'), active, actor: await actorOf(admin) });
  revalidatePath(PATH);
  if (!r.ok) redirect(`${PATH}?error=${encodeURIComponent(r.code)}`);
  redirect(`${PATH}?ok=${active ? 'activated' : r.routingWarning ? 'deactivatedRouting' : 'deactivated'}`);
}
