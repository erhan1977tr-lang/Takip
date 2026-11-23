'use server';

// Müşteri düzeyinde yükleme öncesi proforma (Aşama 7D-2; yalnızca yönetici, ACCOUNTING_MANAGE).
// Kurallar ve çift faturalama engeli server/glass/batch.js'te; yetki orada da denetlenir.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { cleanDays, createBatch, dispatchBatchJobs, reviewFailedBatch } from '@/server/glass/batch.js';
import { recordBatchPayment } from '@/server/finance/batch-payment.js';
import { getT, type MsgKey } from '@/lib/i18n';
import { matchLines, type MatchView } from '@/lib/finance';
import type { PaymentFormState } from '@/app/(panel)/siparisler/[id]/finance-actions';

const PAGE = '/admin/muhasebe/cam/proforma';
const BATCH_PAYMENT_CODES = ['DATE', 'FUTURE', 'AMOUNT', 'CURRENCY', 'METHOD', 'REFERENCE', 'NOTE', 'NO_PROFORMA', 'ORDER_STATE', 'NOT_FOUND', 'REQUEST_KEY', 'FORBIDDEN'];

/** Seçimi (müşteri + günler + elle kur + seçilen siparişler) adrese geri yazar: hata sonrası aynı önizleme açılır */
function back(customerId: string, days: string[], rate: string, extra: Record<string, string>, hash = '', orderIds: string[] | null = null) {
  const q = new URLSearchParams();
  if (customerId) q.set('musteri', customerId);
  for (const d of days) q.append('gun', d);
  if (rate) q.set('kur', rate);
  if (orderIds) {
    q.set('sec', '1');
    for (const id of orderIds) q.append('sip', id);
  }
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `${PAGE}?${q.toString()}${hash}`;
}

/** "Proforma oluştur": parti oluşturulur, FGO proforması kuyruğa alınır ve hemen denenir (işçi de dakikada bir dener) */
export async function createBatchAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const customerId = String(fd.get('customerId') ?? '');
  const days = cleanDays(fd.getAll('day').map(String));
  const rate = String(fd.get('fxRate') ?? '').trim();
  // Sipariş seçimi (karar 125): önizlemede seçili siparişler; alan hiç yoksa uygun siparişlerin hepsi. Uygunluk sunucuda yeniden doğrulanır.
  const orderIds = fd.get('selected') === '1' ? [...new Set(fd.getAll('orderId').map(String).filter(Boolean))].slice(0, 500) : null;
  const r = await createBatch(db, { customerId, days, orderIds, key: String(fd.get('key') ?? ''), manualRate: rate || null, actor: await actorOf(user) });
  if (!r.ok) redirect(back(customerId, days, rate, { error: r.code }, '#onizleme', orderIds));
  await dispatchBatchJobs(db, { onlyBatchId: r.batchId });
  revalidatePath(PAGE);
  revalidatePath('/admin/muhasebe/cam');
  redirect(back(customerId, [], '', { ok: 'created', n: String(r.orders) }, '#partiler'));
}

/** Kesilemeyen parti: yeniden dene ya da vazgeç */
export async function reviewBatchAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const batchId = String(fd.get('batchId') ?? '');
  const customerId = String(fd.get('customerId') ?? '');
  const action = fd.get('do') === 'void' ? 'void' : 'retry';
  const r = await reviewFailedBatch(db, { batchId, action, actor: await actorOf(user) });
  if (!r.ok) redirect(back(customerId, [], '', { error: r.code }, '#partiler'));
  if (action === 'retry') await dispatchBatchJobs(db, { onlyBatchId: batchId });
  revalidatePath(PAGE);
  redirect(back(customerId, [], '', { ok: action }, '#partiler'));
}

/**
 * Belirsiz sonuçlu müşteri belgesi (parti; karar 209): yöneticinin kararı — FGO'daki belgeyi kaydet (FGO'dan doğrulanır),
 * yeniden gönder (aynı IdExtern) ya da vazgeç (parti FAILED olur; mevcut "yeniden dene / vazgeç" kuralı).
 */
export async function resolveBatchUncertainAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const { getEnv } = await import('@/lib/env');
  const { resolveUncertainJob } = await import('@/server/finance/uncertain.js');
  const { UNCERTAIN_RECORDERS } = await import('@/server/finance/recorders.js');
  const customerId = String(fd.get('customerId') ?? '');
  // İki onaylı düğme (RETRY / ABANDON) aynı formda: basılanın değeri dolu olan alandır (ConfirmButton)
  const action = fd.getAll('do').map(String).find(Boolean) ?? '';
  const env = getEnv();
  const jobId = String(fd.get('jobId') ?? '');
  // Yeniden gönderilecek partinin kimliği formdan değil, işin kendisinden
  const job = await db.notificationOutbox.findUnique({ where: { id: jobId }, select: { payload: true } });
  const batchId = String((job?.payload as { batchId?: unknown } | null)?.batchId ?? '');
  const r = await resolveUncertainJob(db, {
    jobId, action: action as 'RECORD' | 'RETRY' | 'ABANDON', series: String(fd.get('series') ?? ''), number: String(fd.get('number') ?? ''),
    confirm: fd.get('confirm') === '1', actor: await actorOf(user), secret: env.AUTH_SECRET, appUrl: env.APP_URL ?? '', recorders: UNCERTAIN_RECORDERS,
  });
  if (r.ok && action === 'RETRY' && batchId) await dispatchBatchJobs(db, { onlyBatchId: batchId });
  revalidatePath(PAGE);
  revalidatePath('/admin/kararlar');
  if (!r.ok) {
    const extra: Record<string, string> = { uncError: r.code };
    if (r.code === 'TOTAL_MISMATCH' && 'fgoTotal' in r) Object.assign(extra, { fgoTotal: String(r.fgoTotal), expected: String(r.expected) });
    redirect(back(customerId, [], '', extra, '#belirsiz'));
  }
  redirect(back(customerId, [], '', { uncOk: action }, '#belirsiz'));
}

/**
 * Proforma satırından elle ödeme kaydı (karar 326): kayıt partinin zincirine yazılır (server/finance/batch-payment.js →
 * recordManualPayment). Belge kesmez; aynı müşteride aynı tutar varsa onay istenir. Sonuç formda gösterilir.
 */
export async function recordBatchPaymentAction(_prev: PaymentFormState, fd: FormData): Promise<PaymentFormState> {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const { t } = await getT();
  const batchId = String(fd.get('batchId') ?? '');
  const r = await recordBatchPayment(db, {
    batchId: /^[a-z0-9]{8,40}$/i.test(batchId) ? batchId : '',
    input: { paidOn: fd.get('paidOn'), amount: fd.get('amount'), currency: fd.get('currency'), method: fd.get('method'), reference: fd.get('reference'), note: fd.get('note') },
    requestKey: String(fd.get('requestKey') ?? ''),
    ack: String(fd.get('ack') ?? '') || null,
    actor: await actorOf(user),
  });
  if (r.ok) {
    revalidatePath(PAGE);
    return { ok: true, at: Date.now() };
  }
  if (r.code === 'DUPLICATE_RISK') return { ok: false, error: t('finance.payment.duplicate'), matches: matchLines(t, ((r as { matches?: unknown[] }).matches ?? []) as MatchView[]), ackKey: (r as { ackKey?: string }).ackKey };
  return { ok: false, error: t(`finance.payment.errors.${BATCH_PAYMENT_CODES.includes(r.code) ? r.code : 'NOT_FOUND'}` as MsgKey) };
}
