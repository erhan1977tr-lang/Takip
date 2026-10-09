'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { audit } from '@/lib/audit';
import { getAvSettings, saveAvSettings, scanPending } from '@/server/files/antivirus.js';
import { avErrorCode, eicar, safeSignature, scanBuffer } from '@/server/files/clamav.js';
import { parseRecipients, saveWarehouseSettings } from '@/server/profile/warehouse.js';
import { fgoKey, fgoTest, getFgoSettings, saveFgoSettings, validateFgoSettings } from '@/server/integrations/fgo.js';
import { parseManualRate, saveDailyRate } from '@/server/fx/bt.js';
import { localDay } from '@/server/profile/dates.js';
import { writeAudit } from '@/server/orders/journal.js';
import { getEnv } from '@/lib/env';
import { parseUninvoicedDays, saveAccountingSettings } from '@/server/accounting/uninvoiced.js';
import { saveTranslateSettings, testTranslation } from '@/server/notes/translation.js';

const back = (q: Record<string, string | number>) =>
  `/admin/entegrasyonlar?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString()}`;

// Antivirüs (karar 150; güvenlik denetimi AUD-12): tarayıcının adresi ve portu buradan DEĞİŞTİRİLEMEZ — formdan okunmaz,
// kaydedilmez; hedef yalnızca sunucu ayarındandır (server/files/antivirus.js → avTarget). İsteğe "host" / "port" alanı
// eklense de yok sayılır. Yalnızca açık / kapalı ve "ulaşılamazsa" politikası kaydedilir.
export async function saveAntivirusAction(formData: FormData) {
  const user = await requirePermission('SETTINGS_MANAGE');
  await saveAvSettings(db, {
    enabled: formData.get('enabled') === 'on',
    onUnavailable: formData.get('onUnavailable') === 'reject' ? 'reject' : 'accept',
  }, await actorOf(user));
  revalidatePath('/admin/entegrasyonlar');
  redirect(back({ ok: 'saved' }));
}

/**
 * Zararsız EICAR test dosyasını tarar: tarayıcı çalışıyor ve virüs yakalıyor mu? Sonuç adrese yalnızca sabit kod
 * (AV_ERRORS) ve temizlenmiş imza adı olarak yazılır; tarayıcının ham yanıtı ya da ağ hatası metni dışarı çıkmaz.
 */
export async function testAntivirusAction() {
  const user = await requirePermission('SETTINGS_MANAGE');
  const s = await getAvSettings(db);
  const r = await scanBuffer(eicar(), { host: s.host, port: s.port, timeoutMs: 20_000, deadlineMs: 20_000 });
  const signature = r.status === 'infected' ? safeSignature(r.signature) : null;
  await audit('ANTIVIRUS_TEST', 'IntegrationSetting', 'antivirus', user.id, { result: r.status, signature, reason: r.status === 'error' ? avErrorCode(r.error) : null });
  if (r.status === 'infected') redirect(back({ ok: 'testOk', signature: signature ?? '' }));
  if (r.status === 'clean') redirect(back({ error: 'testNotDetected' }));
  redirect(back({ error: 'testFailed', detail: avErrorCode(r.error) }));
}

/** Taranmayı bekleyen dosyaları hemen tarar (normalde arka plan işçisi birkaç dakikada bir yapar). */
export async function scanNowAction() {
  await requirePermission('SETTINGS_MANAGE');
  const s = await getAvSettings(db);
  const r = await scanPending(db, s, { limit: 50 });
  revalidatePath('/admin/entegrasyonlar');
  if (r.stopped && r.stopped !== 'disabled') redirect(back({ error: 'scanStopped', detail: avErrorCode(r.stopped) }));
  redirect(back({ ok: 'scanned', scanned: r.scanned, clean: r.clean, infected: r.infected }));
}

// Operasyonel ayarlar (karar 219): depo alıcıları, fatura uyarı günü ve günün BT kuru OPS_SETTINGS_MANAGE ister — yönetici
// ve Yönetici Yardımcısı. FGO bağlantısı, not çevirisi anahtarı ve antivirüs SETTINGS_MANAGE (yalnızca yönetici) kalır.

/** Profil siparişi: depo e-postası alıcıları (Aşama 6) */
export async function saveWarehouseAction(formData: FormData) {
  const user = await requirePermission('OPS_SETTINGS_MANAGE');
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
    vatRate: formData.get('vatRate'), dailyLimit: formData.get('dailyLimit'),
    invoiceNext: formData.get('invoiceNext'),
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

/** Muhasebe uyarısı (karar 126): "Fatura edilmemiş sipariş uyarısı" — yüklemeden sonra kaç takvim günü (0–60; boş = 6) */
export async function saveAccountingAction(formData: FormData) {
  const user = await requirePermission('OPS_SETTINGS_MANAGE');
  const r = parseUninvoicedDays(formData.get('uninvoicedDays'));
  if (!r.ok) redirect(back({ error: 'accounting' }) + '#muhasebe');
  await saveAccountingSettings(db, { uninvoicedDays: r.value }, await actorOf(user));
  revalidatePath('/admin/entegrasyonlar');
  revalidatePath('/admin/muhasebe/cam');
  redirect(back({ ok: 'accounting' }) + '#muhasebe');
}

/**
 * Not çevirisi (karar 127): aç / kapat + Google Cloud API anahtarı. Anahtar boş bırakılırsa kayıtlı olan kalır;
 * şifreli saklanır, hiçbir yanıta / günlüğe / denetim kaydına yazılmaz (server/notes/translation.js).
 */
export async function saveTranslateAction(formData: FormData) {
  const user = await requirePermission('SETTINGS_MANAGE');
  const r = await saveTranslateSettings(
    db,
    { enabled: formData.get('enabled') === 'on' },
    { key: String(formData.get('apiKey') ?? ''), clearKey: formData.get('clearKey') === 'on', secret: getEnv().AUTH_SECRET },
    await actorOf(user),
  );
  if (!r.ok) redirect(back({ error: 'translate', detail: r.code }) + '#ceviri');
  revalidatePath('/admin/entegrasyonlar');
  redirect(back({ ok: 'translate' }) + '#ceviri');
}

/** Çeviri bağlantısını dener: kayıtlı anahtarla zararsız bir ifade çevrilir. Hiçbir not okunmaz / değişmez. */
export async function testTranslateAction() {
  const user = await requirePermission('SETTINGS_MANAGE');
  const r = await testTranslation(db, { actor: await actorOf(user) });
  if (r.ok) redirect(back({ ok: 'translateTest', detail: r.sample }) + '#ceviri');
  redirect(back({ error: 'translateTest', code: r.code, detail: r.detail ?? '' }) + '#ceviri');
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

/** Günün BT EUR satış kuru (elle): kur politikası BT olan müşterilerin bugünkü belgeleri bu kurla kesilir (karar 95, 98). */
export async function saveDailyRateAction(formData: FormData) {
  const user = await requirePermission('OPS_SETTINGS_MANAGE');
  const rate = parseManualRate(String(formData.get('rate') ?? ''));
  if (rate == null) redirect(back({ error: 'fxDaily' }) + '#kur');
  await saveDailyRate(db, { day: localDay(new Date(), getEnv().APP_TIMEZONE), rate }, await actorOf(user), writeAudit);
  revalidatePath('/admin/entegrasyonlar');
  redirect(back({ ok: 'fxDaily', rate: rate.toFixed(4) }) + '#kur');
}
