'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { resolveAlert } from '@/server/pricing/alerts.js';

/** Yönetici "Gördüm": uyarı kapanır (kim, ne zaman denetim kaydına yazılır). */
export async function resolveAlertAction(formData: FormData) {
  const admin = await requirePermission('ALERT_VIEW');
  const id = String(formData.get('alertId') ?? '');
  await resolveAlert(db, id, await actorOf(admin));
  revalidatePath('/admin/kararlar');
  revalidatePath('/siparisler');
  redirect('/admin/kararlar?ok=resolved');
}
