'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { audit } from '@/lib/audit';
import { getAvSettings, saveAvSettings, scanPending } from '@/server/files/antivirus.js';
import { eicar, scanBuffer } from '@/server/files/clamav.js';

const back = (q: Record<string, string | number>) =>
  `/admin/entegrasyonlar?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString()}`;

export async function saveAntivirusAction(formData: FormData) {
  const user = await requirePermission('SETTINGS_MANAGE');
  await saveAvSettings(db, {
    enabled: formData.get('enabled') === 'on',
    host: String(formData.get('host') ?? ''),
    port: Number(formData.get('port') ?? 3310),
    onUnavailable: formData.get('onUnavailable') === 'reject' ? 'reject' : 'accept',
  }, await actorOf(user));
  revalidatePath('/admin/entegrasyonlar');
  redirect(back({ ok: 'saved' }));
}

/** Zararsız EICAR test dosyasını tarar: tarayıcı çalışıyor ve virüs yakalıyor mu? */
export async function testAntivirusAction() {
  const user = await requirePermission('SETTINGS_MANAGE');
  const s = await getAvSettings(db);
  const r = await scanBuffer(eicar(), { host: s.host, port: s.port, timeoutMs: 20_000 });
  await audit('ANTIVIRUS_TEST', 'IntegrationSetting', 'antivirus', user.id, { result: r.status, signature: r.status === 'infected' ? r.signature : null });
  if (r.status === 'infected') redirect(back({ ok: 'testOk', signature: r.signature }));
  if (r.status === 'clean') redirect(back({ error: 'testNotDetected' }));
  redirect(back({ error: 'testFailed', detail: r.error.slice(0, 200) }));
}

/** Taranmayı bekleyen dosyaları hemen tarar (normalde arka plan işçisi birkaç dakikada bir yapar). */
export async function scanNowAction() {
  await requirePermission('SETTINGS_MANAGE');
  const s = await getAvSettings(db);
  const r = await scanPending(db, s, { limit: 50 });
  revalidatePath('/admin/entegrasyonlar');
  if (r.stopped && r.stopped !== 'disabled') redirect(back({ error: 'scanStopped', detail: r.stopped.slice(0, 200) }));
  redirect(back({ ok: 'scanned', scanned: r.scanned, clean: r.clean, infected: r.infected }));
}
