'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { queueAnnouncement } from '@/server/push/announce.js';

// Müşterilere bilgi e-postası (4.2.33, karar 331): yalnızca Admin'in açık onayıyla, bir kez kuyruğa girer.
export async function queueAnnouncementAction(formData: FormData) {
  const user = await requirePermission('USER_MANAGE');
  const actor = await actorOf(user);
  const r = await queueAnnouncement(db, { actor, confirm: formData.get('confirm') === 'on', ip: actor.ip });
  redirect(r.ok ? `/admin/duyuru?ok=${r.queued}` : `/admin/duyuru?error=${r.code}`);
}
