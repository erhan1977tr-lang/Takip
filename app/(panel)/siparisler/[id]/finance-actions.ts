'use server';

// Sipariş finansı (Paket 10, kararlar 206–209) — yalnızca yönetici (ACCOUNTING_MANAGE; servisler de ilk iş denetler).
// Kurallar server/finance/*: elle ödeme kaydı belge kesmez; avans faturası ayrı ve açık istekle; belirsiz FGO sonucu
// yöneticinin FGO'yu kontrol ettikten sonraki kararıyla.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { matchLines, type MatchView } from '@/lib/finance';
import { recordManualPayment, requestProfileAdvance, voidManualPayment } from '@/server/finance/service.js';
import { resolveUncertainJob } from '@/server/finance/uncertain.js';
import { UNCERTAIN_RECORDERS } from '@/server/finance/recorders.js';
import { dispatchProfileAdvanceJobs } from '@/server/profile/fgo-jobs.js';
import { dispatchGlassJobs } from '@/server/glass/billing.js';

// Ödemeler kartı (#odemeler) ve belirsiz belge kutusu (#belirsiz) — cam ve profil siparişinde aynı yerler
const back = (id: string, q: string, at = 'odemeler') => `/siparisler/${id}?${q}#${at}`;
const safeId = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '');
  return /^[a-z0-9]{8,40}$/i.test(s) ? s : '';
};
const PAYMENT_CODES = ['DATE', 'FUTURE', 'AMOUNT', 'CURRENCY', 'METHOD', 'REFERENCE', 'NOTE', 'NO_PROFORMA', 'ORDER_STATE', 'NOT_FOUND', 'REQUEST_KEY', 'FORBIDDEN'];

/** matches: eşleşen kayıtlar, okunacak satır olarak (sunucuda biçimlenir) · ackKey: onay anahtarı · at: başarı anı (form temizlenir) */
export type PaymentFormState = { ok: boolean; error?: string; matches?: string[]; ackKey?: string; at?: number };

/** Elle ödeme kaydı (formdan; sonuç ekranda — eşleşme varsa onay istenir) */
export async function recordPaymentAction(_prev: PaymentFormState, fd: FormData): Promise<PaymentFormState> {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const { t } = await getT();
  const orderId = safeId(fd.get('orderId'));
  const r = await recordManualPayment(db, {
    orderId,
    input: { paidOn: fd.get('paidOn'), amount: fd.get('amount'), currency: fd.get('currency'), method: fd.get('method'), reference: fd.get('reference'), note: fd.get('note') },
    requestKey: String(fd.get('requestKey') ?? ''),
    ack: String(fd.get('ack') ?? '') || null,
    actor: await actorOf(user),
  });
  if (r.ok) {
    revalidatePath(`/siparisler/${orderId}`);
    return { ok: true, at: Date.now() };
  }
  if (r.code === 'DUPLICATE_RISK') return { ok: false, error: t('finance.payment.duplicate'), matches: matchLines(t, (r.matches ?? []) as MatchView[]), ackKey: r.ackKey };
  return { ok: false, error: t(`finance.payment.errors.${PAYMENT_CODES.includes(r.code) ? r.code : 'NOT_FOUND'}` as MsgKey) };
}

/** Elle kaydı geçersiz kılar (gerekçeyle; silinmez) */
export async function voidPaymentAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const orderId = safeId(fd.get('orderId'));
  const r = await voidManualPayment(db, { paymentId: safeId(fd.get('paymentId')), reason: fd.get('reason'), actor: await actorOf(user) });
  revalidatePath(`/siparisler/${orderId}`);
  redirect(back(orderId, r.ok ? 'finOk=voided' : `finError=${r.code}`));
}

/** Profil avans faturası iste (açık onayla; aynı tutar riski varsa onay kutusu) */
export async function profileAdvanceAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const orderId = safeId(fd.get('orderId'));
  const r = await requestProfileAdvance(db, { orderId, ack: String(fd.get('ack') ?? '') || null, actor: await actorOf(user) });
  if (!r.ok) redirect(back(orderId, `finError=${r.code}`));
  await dispatchProfileAdvanceJobs(db, { onlyOrderId: orderId });
  revalidatePath(`/siparisler/${orderId}`);
  revalidatePath('/admin/muhasebe/profil');
  redirect(back(orderId, 'finOk=advance'));
}

/** Belirsiz FGO belgesi: yöneticinin kararı (FGO'daki belgeyi kaydet / yeniden gönder / vazgeç) — sipariş sayfasından */
export async function resolveUncertainAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const orderId = safeId(fd.get('orderId'));
  const env = getEnv();
  // İki onaylı düğme (RETRY / ABANDON) aynı formda: basılanın değeri dolu olan alandır (ConfirmButton)
  const action = fd.getAll('do').map(String).find(Boolean) ?? '';
  const r = await resolveUncertainJob(db, {
    jobId: safeId(fd.get('jobId')), action: action as 'RECORD' | 'RETRY' | 'ABANDON', series: String(fd.get('series') ?? ''), number: String(fd.get('number') ?? ''),
    confirm: fd.get('confirm') === '1', actor: await actorOf(user), secret: env.AUTH_SECRET, appUrl: env.APP_URL ?? '', recorders: UNCERTAIN_RECORDERS,
  });
  if (r.ok && action === 'RETRY') {
    // Aynı iş aynı IdExtern ile hemen denenir (cam / profil avansı); profil proforma / faturası işçinin turunda
    await dispatchGlassJobs(db, { onlyOrderId: orderId });
    await dispatchProfileAdvanceJobs(db, { onlyOrderId: orderId });
  }
  revalidatePath(`/siparisler/${orderId}`);
  revalidatePath('/admin/kararlar');
  if (!r.ok) {
    const extra = r.code === 'TOTAL_MISMATCH' && 'fgoTotal' in r ? `&fgoTotal=${encodeURIComponent(String(r.fgoTotal))}&expected=${encodeURIComponent(String(r.expected))}` : '';
    redirect(back(orderId, `uncError=${r.code}${extra}`, 'belirsiz'));
  }
  redirect(back(orderId, `uncOk=${action}`, 'belirsiz'));
}
