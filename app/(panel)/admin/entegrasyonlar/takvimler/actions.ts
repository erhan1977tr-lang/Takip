'use server';

// Ayarlar → Çalışma Takvimleri (Paket 8, karar 192). Kural ve kayıt server/calendar/*'te; burada yalnızca form okuma ve
// yönlendirme. Yetki: SETTINGS_MANAGE (yalnızca yönetici) — burada ve serviste ayrı ayrı.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { setOverride } from '@/server/calendar/service.js';
import { isCalendar } from '@/server/calendar/rules.js';

const PATH = '/admin/entegrasyonlar/takvimler';

/** Bir günü elle açık / kapalı işaretle ya da kararı kaldır (AUTO) */
export async function setOverrideAction(fd: FormData) {
  const admin = await requirePermission('SETTINGS_MANAGE');
  const calendar = String(fd.get('calendar') ?? '');
  const day = String(fd.get('day') ?? '');
  const month = /^\d{4}-\d{2}$/.test(String(fd.get('month') ?? '')) ? String(fd.get('month')) : day.slice(0, 7);
  const keep = `takvim=${encodeURIComponent(isCalendar(calendar) ? calendar : 'RO_DEPOT')}${/^\d{4}-\d{2}$/.test(month) ? `&ay=${month}` : ''}`;
  const r = await setOverride(db, { calendar, day, mode: fd.get('mode'), note: fd.get('note') }, await actorOf(admin));
  if (!r.ok) redirect(`${PATH}?${keep}&error=${encodeURIComponent(r.code)}#isaretle`);
  revalidatePath(PATH);
  redirect(`${PATH}?${keep}&ok=${r.changed ? 'saved' : 'unchanged'}`);
}
