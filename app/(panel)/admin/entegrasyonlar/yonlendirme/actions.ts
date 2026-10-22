'use server';

// Ayarlar → Satış Yönlendirme (karar 300). Kural ve kayıt server/orders/sales-routing.js → saveRoutingRule; burada
// yalnızca form okuma. Yetki: SETTINGS_MANAGE (yönetici) — burada ve serviste ayrı ayrı.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { saveRoutingRule } from '@/server/orders/sales-routing.js';

const PATH = '/admin/entegrasyonlar/yonlendirme';

export async function saveRoutingRuleAction(fd: FormData) {
  const admin = await requirePermission('SETTINGS_MANAGE');
  const r = await saveRoutingRule(db, {
    input: { mode: fd.get('mode'), targetUserId: fd.get('targetUserId'), startsAt: fd.get('startsAt'), note: fd.get('note') },
    actor: await actorOf(admin),
  });
  if (!r.ok) redirect(`${PATH}?error=${encodeURIComponent(r.code)}#yeni-kural`);
  revalidatePath(PATH);
  redirect(`${PATH}?ok=saved`);
}
