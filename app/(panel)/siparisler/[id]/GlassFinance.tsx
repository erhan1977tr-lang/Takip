import { db } from '@/lib/db';
import type { T, MsgKey } from '@/lib/i18n';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { getEnv } from '@/lib/env';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { FxInfo, FxUnavailableNote, fxPolicyLabel } from '@/components/FxInfo';
import { bnrRate } from '@/server/fx/bnr.js';
import { padRate } from '@/server/fx/decimal.js';
import { previewExchangeRate } from '@/server/fx/resolve.js';
import { paymentStatus, remaining } from '@/server/accounting/receivables.js';
import { DOC_EMAIL, GLASS_FGO, billingState, isLoaded } from '@/server/glass/billing.js';
import { localDay } from '@/server/profile/dates.js';
import { glassDocumentAction, glassPaidAction } from './glass-billing-actions';

const TONE = { UNKNOWN: 'muted', UNPAID: 'danger', PARTIAL: 'warn', PAID: 'ok' } as const;
const KIND_ACTION = { proforma: 'PROFORMA', advance: 'ADVANCE', invoice: 'INVOICE' } as const;
type Doc = { id: string; kind: string; series: string; number: string; link: string | null; issuedAt: Date; total: { toString(): string } | null; paid: { toString(): string } | null };
type Job = { type: string; status: string; lastError: string | null; payload: unknown; createdAt: Date; sentAt: Date | null };

/**
 * Cam siparişinin Finans / FGO bölümü (yönetici). Muhasebe → Cam Tahsilat ile aynı kayıtlar (FgoDocument).
 * Düğmeler belge durumuna göre: proforma → (ödeme) → avans faturası → (yüklenince) fatura.
 */
export async function GlassFinance({ order, t, sp }: {
  order: { id: string; status: string; actualShipDate: Date | null; estimatedShipDate: Date | null; offers: { status: string }[] };
  t: T; sp: Record<string, string | undefined>;
}) {
  const [docs, billing, jobs, batchOrders] = await Promise.all([
    db.fgoDocument.findMany({ where: { orderId: order.id }, orderBy: { issuedAt: 'asc' } }) as Promise<Doc[]>,
    db.glassBilling.findUnique({ where: { orderId: order.id } }),
    db.notificationOutbox.findMany({ where: { orderId: order.id, type: { in: [GLASS_FGO, DOC_EMAIL] } }, orderBy: { createdAt: 'desc' }, take: 10 }) as Promise<Job[]>,
    // Sipariş etkin bir müşteri partisinde mi (müşteri proforması, karar 100): sipariş başına belge istenemez
    db.billingBatchOrder.findMany({
      where: { orderId: order.id, activeKey: { not: null } }, orderBy: { batch: { createdAt: 'asc' } },
      select: { batch: { select: { status: true, customerId: true, document: { select: { series: true, number: true, link: true } } } } },
    }),
  ]);
  const today = localDay(new Date(), getEnv().APP_TIMEZONE);
  const pending = jobs.filter((j) => j.type === GLASS_FGO && j.status === 'PENDING');
  const st = billingState({
    status: order.status, loaded: isLoaded(order, today), docs, billing,
    pending: pending.map((j) => (j.payload as { kind?: string } | null)?.kind ?? ''), hasOffer: order.offers.some((o) => o.status === 'GONDERILDI'),
    inBatch: batchOrders.length > 0,
  });
  // Müşteri düzeyindeki belgeler (müşteri proforması, onaylı yüklemeden müşteri faturası): numaraları ya da durumu
  const batchRefs = batchOrders.map((x) => (x.batch.document ? `${x.batch.document.series}${x.batch.document.number}` : t(`accounting.batch.status.${x.batch.status}` as MsgKey)));
  // Kur henüz belirlenmediyse (proforma ya da doğrudan fatura bu belgeyle belirleyecek) ve teklif EUR ise:
  // müşterinin kur politikasıyla bugünün kuru gösterilir, yönetici isterse elle kur girer (karar 95–96).
  const setsRate = billing?.fxRate == null && (st.actions.includes('proforma') || st.actions.includes('invoice'));
  const fxOrder = setsRate ? await db.order.findUnique({
    where: { id: order.id },
    select: { customer: { select: { fxPolicy: true, fxMarkupPercent: true } }, offers: { where: { status: 'GONDERILDI' }, orderBy: { createdAt: 'desc' }, take: 1, select: { currency: true } } },
  }) : null;
  const fxCurrency = fxOrder?.offers[0]?.currency ?? null;
  const askRate = setsRate && fxCurrency === 'EUR';
  const fxNow = askRate && fxOrder
    ? await previewExchangeRate(db, { customer: fxOrder.customer, currency: 'EUR', day: today, bnrImpl: (o) => bnrRate({ ...o, timeoutMs: 6000 }) })
    : null;
  const lastJob = jobs.find((j) => j.type === GLASS_FGO);
  const lastMail = jobs.find((j) => j.type === DOC_EMAIL);
  const hidden = <input type="hidden" name="id" value={order.id} />;
  return (
    <div className="card" id="finans">
      <h2>{t('glassBilling.title')}</h2>
      {sp.fgoOk && <div className="alert alert-ok">{t(`glassBilling.ok.${sp.fgoOk === 'paid' ? 'paid' : 'requested'}` as MsgKey)}</div>}
      {sp.fgoError && <div className="alert alert-error">{t(`glassBilling.errors.${['FGO_DISABLED', 'FGO_DAILY_LIMIT', 'BAD_AMOUNT', 'BAD_RATE', 'RATE_LOCKED'].includes(sp.fgoError) ? sp.fgoError : 'NOT_ALLOWED'}` as MsgKey)}</div>}
      {docs.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('accounting.receivables.col.kind')}</th><th>{t('accounting.receivables.col.doc')}</th><th>{t('accounting.receivables.col.date')}</th>
                <th className="num">{t('accounting.receivables.col.total')}</th><th className="num">{t('accounting.receivables.col.paid')}</th>
                <th className="num">{t('accounting.receivables.col.rest')}</th><th>{t('accounting.receivables.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const s = paymentStatus(d.total, d.paid);
                const rest = remaining(d.total, d.paid);
                return (
                  <tr key={d.id}>
                    <td>{t(`accounting.receivables.kind.${d.kind}` as MsgKey)}</td>
                    <td className="mono">{d.link ? <a href={d.link} target="_blank" rel="noopener noreferrer">{d.series}{d.number}</a> : `${d.series}${d.number}`}</td>
                    <td>{fmtDate(d.issuedAt)}</td>
                    <td className="num">{d.total != null ? fmtMoney(d.total.toString(), 'RON') : '—'}</td>
                    <td className="num">{d.paid != null ? fmtMoney(d.paid.toString(), 'RON') : '—'}</td>
                    <td className="num"><b>{rest != null ? fmtMoney(rest, 'RON') : '—'}</b></td>
                    <td><Badge tone={TONE[s]}>{t(`accounting.receivables.status.${s}` as MsgKey)}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">{t('glassBilling.none')}</p>}
      {billing?.fxRate != null && <p className="small muted">{t('glassBilling.rate', { rate: Number(billing.fxRate).toFixed(4).replace('.', ','), date: fmtDate(billing.fxDate) })}</p>}
      {/* Belgeyle saklanan kur kaydı: sonradan BNR / BT ya da politika değişse de değişmez */}
      {billing?.fxRate != null && billing.fxPolicy && billing.fxSource !== 'RON' && (
        <div className="fx-block" id="belge-kuru">
          <h3>{t('fx.docTitle')}</h3>
          <FxInfo t={t} fx={{
            policy: billing.fxPolicy, currency: billing.fxCurrency ?? 'EUR', baseRate: padRate((billing.fxBaseRate ?? billing.fxRate).toString()) ?? '',
            markupPercent: billing.fxMarkupPercent?.toString() ?? null, finalRate: Number(billing.fxRate).toFixed(4), source: billing.fxSource ?? '',
            sourceDate: billing.fxSourceDate ?? billing.fxDate, manual: billing.fxManual === true,
          }} />
        </div>
      )}
      {askRate && (
        <div className="fx-block" id="kur-onizleme">
          <h3>{t('fx.todayTitle')}</h3>
          {fxNow?.ok ? (
            <>
              <FxInfo fx={fxNow.fx} t={t} />
              {fxOrder?.customer.fxPolicy === 'BT_UNIT_SELL' && <p className="muted small">{t('fx.btAutoNote')}</p>}
            </>
          ) : fxNow && (
            <>
              <p className="small"><b>{t('fx.policyLabel')}:</b> {fxPolicyLabel(t, fxOrder?.customer.fxPolicy, fxOrder?.customer.fxMarkupPercent?.toString())}</p>
              <FxUnavailableNote code={fxNow.code} error={fxNow.error} t={t} />
            </>
          )}
        </div>
      )}
      {billing?.paidAmount != null && <p className="small">{t('glassBilling.paidManual', { amount: fmtMoney(billing.paidAmount.toString(), 'RON'), date: fmtDateTime(billing.paidAt) })}</p>}
      {/* Ödenmiş proforma + avans faturası yok + yüklenmiş: kapanış faturası engellenir, nedeni belirgin gösterilir (karar 94) */}
      {st.wait === 'paid_no_advance'
        ? <div className="alert alert-warn" id="fatura-engeli">{t('glassBilling.wait.paid_no_advance')}</div>
        : st.wait === 'batch' && batchOrders.length > 0 ? (
          <div className="alert alert-info" id="musteri-proformasi">
            {t('glassBilling.wait.batch', { ref: batchRefs.join(', ') })}{' '}
            {batchOrders.map((x) => x.batch.document?.link && (
              <a key={x.batch.document.link} href={x.batch.document.link} target="_blank" rel="noopener noreferrer">{x.batch.document.series}{x.batch.document.number} </a>
            ))}
            <a href={`/admin/muhasebe/cam/proforma?musteri=${batchOrders[0].batch.customerId}#partiler`}>{t('accounting.batch.open')}</a>
          </div>
        ) : st.wait && <p className="small muted">{t(`glassBilling.wait.${st.wait}` as MsgKey)}</p>}
      {lastJob?.status === 'FAILED' && <div className="alert alert-error">{t('glassBilling.failed', { error: lastJob.lastError ?? '—' })}</div>}
      {lastJob?.status === 'PENDING' && lastJob.lastError && <div className="alert alert-warn">{t('glassBilling.retry', { error: lastJob.lastError })}</div>}
      {lastMail && (
        <p className="small">
          <b>{t('glassBilling.mail')}:</b>{' '}
          {lastMail.status === 'SENT' ? t('glassBilling.mailSent', { date: fmtDateTime(lastMail.sentAt) })
            : lastMail.status === 'FAILED' ? <span className="danger">{t('glassBilling.mailFailed', { error: lastMail.lastError ?? '—' })}</span>
              : t('glassBilling.mailPending')}
        </p>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        {st.actions.filter((a): a is keyof typeof KIND_ACTION => a in KIND_ACTION).map((a) => (
          <form key={a} action={glassDocumentAction} className="row">
            {hidden}
            <input type="hidden" name="kind" value={KIND_ACTION[a]} />
            {/* Elle kur: yalnızca kuru bu belge belirleyecekse; doldurulursa belge MANUAL diye işaretlenir */}
            {askRate && a !== 'advance' && (
              <span className="fx-manual">
                <label htmlFor={`gb-rate-${a}`} style={{ margin: 0 }}>{t('fx.manualLabel')}</label>
                <input id={`gb-rate-${a}`} name="fxRate" inputMode="decimal" maxLength={10} style={{ width: 110 }} title={t('fx.manualHint')} />
              </span>
            )}
            <ConfirmButton primary message={t(`glassBilling.confirm.${a}` as MsgKey)}>{t(`glassBilling.button.${a}` as MsgKey)}</ConfirmButton>
          </form>
        ))}
        {st.actions.includes('mark_paid') && (
          <form action={glassPaidAction} className="row">
            {hidden}
            <label htmlFor="gb-paid" style={{ margin: 0 }}>{t('glassBilling.paidLabel')}</label>
            <input id="gb-paid" name="amount" inputMode="decimal" required style={{ width: 140 }} defaultValue={docs.find((d) => d.kind === 'PROFORMA')?.total?.toString() ?? ''} />
            <button className="btn">{t('glassBilling.button.mark_paid')}</button>
          </form>
        )}
      </div>
    </div>
  );
}
