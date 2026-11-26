'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { queueAnnouncement, wallToUtc } from '@/server/push/announce.js';

// Müşterilere bilgi e-postası (4.2.33, karar 331): yalnızca Admin'in açık onayıyla, bir kez kuyruğa girer.
export async function queueAnnouncementAction(formData: FormData) {
  const user = await requirePermission('USER_MANAGE');
  const actor = await actorOf(user);
  // Gönderim zamanı Romanya saatiyle girilir (tarih + saat); sunucu UTC'ye çevirir ve doğrular
  const sendAt = wallToUtc(String(formData.get('day') ?? ''), String(formData.get('time') ?? ''));
  // Bu duyuru için düzeltilmiş adresler (alan adı addr_<firma kimliği>); sunucu doğrular, firma kaydı değişmez
  const overrides: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith('addr_') && typeof v === 'string') overrides[k.slice(5)] = v;
  }
  const r = await queueAnnouncement(db, { actor, confirm: formData.get('confirm') === 'on', sendAt, overrides, ip: actor.ip });
  redirect(r.ok ? `/admin/duyuru?ok=${r.queued}` : `/admin/duyuru?error=${r.code}`);
}
