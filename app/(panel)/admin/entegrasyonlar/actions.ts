'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { audit } from '@/lib/audit';
import { getAvSettings, saveAvSettings, scanPending } from '@/server/files/antivirus.js';
import { eicar, scanBuffer } from '@/server/files/clamav.js';
import { parseRecipients, saveWarehouseSettings } from '@/server/profile/warehouse.js';
import { fgoKey, fgoTest, getFgoSettings, saveFgoSettings, validateFgoSettings } from '@/server/integrations/fgo.js';
import { fetchBtEurSell, parseManualRate, saveDailyRate } from '@/server/fx/bt.js';
import { localDay } from '@/server/profile/dates.js';
import { writeAudit } from '@/server/orders/journal.js';
import { getEnv } from '@/lib/env';

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

/** Profil siparişi: depo e-postası alıcıları (Aşama 6) */
export async function saveWarehouseAction(formData: FormData) {
  const user = await requirePermission('SETTINGS_MANAGE');
  const r = parseRecipients(String(formData.get('recipients') ?? ''));
  if (!r.ok) redirect(back({ error: 'warehouse', detail: r.bad.join(', ') }) + '#depo');
  await saveWarehouseSettings(db, { recipients: r.recipients }, await actorOf(user));
  revalidatePath('/admin/entegrasyonlar');
  redirect(back({ ok: 'warehouse' }) + '#depo');
}

/** FGO (fatura sistemi; Aşama 6b). Özel anahtar boş bırakılırsa kayıtlı olan kalır; sohbete/koda yazılmaz. */
export async function saveFgoAction(formData: FormData) {
  const user = await requirePermission('SETTINGS_MANAGE');
  const res = validateFgoSettings({
    enabled: formData.get('enabled') === 'on', env: formData.get('env'), cui: formData.get('cui'),
    proformaSeries: formData.get('proformaSeries'), invoiceSeries: formData.get('invoiceSeries'),
    proformaType: formData.get('proformaType'), invoiceType: formData.get('invoiceType'),
    vatRate: formData.get('vatRate'), fxUrl: formData.get('fxUrl'),
  });
  if (!res.ok) redirect(back({ error: 'fgo', detail: res.errors.join(', ') }) + '#fgo');
  const key = String(formData.get('privateKey') ?? '');
  const clearKey = formData.get('clearKey') === 'on';
  const current = await getFgoSettings(db);
  if (res.value.enabled && !key && !current.hasKey) redirect(back({ error: 'fgo', detail: 'KEY' }) + '#fgo');
  await saveFgoSettings(db, res.value, { key, clearKey, secret: getEnv().AUTH_SECRET }, await actorOf(user));
  revalidatePath('/admin/entegrasyonlar');
  redirect(back({ ok: 'fgo' }) + '#fgo');
}

/** FGO bağlantısını dener (kimlik + belge türleri). Hiçbir belge kesilmez. */
export async function testFgoAction() {
  const user = await requirePermission('SETTINGS_MANAGE');
  const s = await getFgoSettings(db);
  const key = fgoKey(s, getEnv().AUTH_SECRET);
  if (!s.cui || !key) redirect(back({ error: 'fgoTest', detail: 'CUI / KEY' }) + '#fgo');
  const r = await fgoTest(s, key);
  await audit('FGO_TEST', 'IntegrationSetting', 'fgo', user.id, { ok: r.ok, env: s.env, types: r.types });
  redirect(back({ [r.ok ? 'ok' : 'error']: 'fgoTest', detail: r.message.slice(0, 200), types: r.types.join(', ').slice(0, 300) }) + '#fgo');
}

/** BT EUR satış kurunu dener (kayıtlı adresten). */
export async function testFxAction() {
  await requirePermission('SETTINGS_MANAGE');
  const s = await getFgoSettings(db);
  const r = await fetchBtEurSell({ url: s.fxUrl });
  if (r.ok) redirect(back({ ok: 'fx', rate: r.rate.toFixed(4) }) + '#fgo');
  redirect(back({ error: 'fx', detail: r.error }) + '#fgo');
}

/** Günün BT EUR satış kuru (elle): BT sitesi sunucudan okunamazsa bugünkü proformalar bu kurla kesilir. */
export async function saveDailyRateAction(formData: FormData) {
  const user = await requirePermission('SETTINGS_MANAGE');
  const rate = parseManualRate(String(formData.get('rate') ?? ''));
  if (rate == null) redirect(back({ error: 'fxDaily' }) + '#fgo');
  await saveDailyRate(db, { day: localDay(new Date(), getEnv().APP_TIMEZONE), rate }, await actorOf(user), writeAudit);
  revalidatePath('/admin/entegrasyonlar');
  redirect(back({ ok: 'fxDaily', rate: rate.toFixed(4) }) + '#fgo');
}
