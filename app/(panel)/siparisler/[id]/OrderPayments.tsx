import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { db } from '@/lib/db';
import type { Dict, MsgKey, T } from '@/lib/i18n';
import { fmtDate, fmtMoney } from '@/lib/format';
import { dupTexts, matchLines, type MatchView } from '@/lib/finance';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { DuplicateAck } from '@/components/DuplicateAck';
import { FgoDocLink } from '@/components/FgoDocLink';
import { UncertainReview } from '@/components/UncertainReview';
import { orderFinanceView } from '@/server/finance/view.js';
import { localDay } from '@/server/profile/dates.js';
import { getEnv } from '@/server/env.js';
import { ManualPaymentForm } from './ManualPaymentForm';
import { profileAdvanceAction, resolveUncertainAction, voidPaymentAction } from './finance-actions';

const MATCH_TONE = { NONE: 'muted', FGO_ONLY: 'info', MANUAL_ONLY: 'warn', MATCHED: 'ok', MISMATCH: 'danger' } as const;
const BASIS_TONE = { FGO: 'info', MANUAL: 'purple', FGO_MANUAL: 'ok' } as const;
const FIN_ERRORS = ['FORBIDDEN', 'REASON', 'ALREADY_VOID', 'INVOICED', 'BUSY', 'NOT_FOUND', 'FGO_DISABLED', 'FGO_DAILY_LIMIT', 'NOT_ALLOWED', 'NO_PROFORMA', 'PENDING', 'NOTHING_TO_ADVANCE', 'DUPLICATE_RISK'];
const rateText = (r: string | null) => (r == null ? null : Number(r).toFixed(4).replace('.', ','));

/**
 * Siparişin ödemeleri ve avansı (Paket 10, karar 210; yalnızca yönetici — ACCOUNTING_MANAGE). Kaynaklar ayrı gösterilir:
 * FGO'nun doğruladığı tahsilat ("FGO") ve yöneticinin elle kaydettiği ödemeler ("Elle"). Hesap yok: veriler
 * server/finance/view.js → orderFinanceView (tek kaynak). Cam siparişinin belge düğmeleri (proforma / avans / fatura)
 * Finans / FGO kartındadır; profil siparişinin avans faturası burada istenir. Sonucu belirsiz FGO işi #belirsiz kutusunda.
 * Sipariş toplamı teklifin para biriminde, ödemeler ve belgeler RON — birbirine eklenmez.
 */
export async function OrderPayments({ orderId, t, m, sp, total, profile }: {
  orderId: string; t: T; m: Dict['finance']; sp: Record<string, string | undefined>;
  total: { amount: number; currency: string } | null; profile: boolean;
}) {
  const v = await orderFinanceView(db, orderId);
  if (!v) return null;
  const st = v.state;
  const today = localDay(new Date(), getEnv().APP_TIMEZONE);
  const rate = v.chain.currency === 'EUR' ? rateText(v.chain.rate) : null;
  const currencies = rate ? ['EUR', 'RON'] : ['RON'];
  const proformaTotal = v.chain.proforma?.total ?? null;
  const remaining = proformaTotal != null && st ? Math.max(0, Math.round((proformaTotal - st.basis) * 100) / 100) : null;
  const finError = sp.finError ? (FIN_ERRORS.includes(sp.finError) ? sp.finError : 'NOT_ALLOWED') : null;
  const hiddenOrder = <input type="hidden" name="orderId" value={orderId} />;
  const cancelled = (await db.order.findUnique({ where: { id: orderId }, select: { status: true, removedAt: true } }))?.status === 'IPTAL';
  return (
    <div className="card" id="odemeler" data-finance={v.chain.kind}>
      <h2>{t('finance.title')}</h2>
      {sp.finOk && ['voided', 'advance'].includes(sp.finOk) && <div className="alert alert-ok">{t(`finance.ok.${sp.finOk}` as MsgKey)}</div>}
      {finError && <div className="alert alert-error" data-finance-error={finError}>{t(`finance.errors.${finError}` as MsgKey)}</div>}
      <p className="muted small">{t('finance.intro')}</p>
      {v.chain.kind === 'BATCH' && (
        <div className="alert alert-info" data-finance-batch>
          {t('finance.batchChain', { ref: v.chain.proforma?.ref ?? '—' })}{' '}
          <Link href={`/admin/muhasebe/cam/proforma?musteri=${v.chain.customerId}#partiler`}>{t('finance.batchOpen')}</Link>
        </div>
      )}

      {st && (
        <div className="table-wrap">
          <table className="kv" data-finance-summary>
            <tbody>
              <tr><td>{t('finance.orderTotal')}</td><td data-fin="total">{total ? fmtMoney(total.amount, total.currency) : '—'}</td></tr>
              <tr><td>{t('finance.proforma')}</td><td data-fin="proforma">{v.chain.proforma ? <><span className="mono">{v.chain.proforma.ref}</span>{proformaTotal != null && <> · {fmtMoney(proformaTotal, 'RON')}</>}</> : '—'}</td></tr>
              <tr><td>{t('finance.fgoPaid')}</td><td data-fin="fgoPaid"><Badge tone="info">{m.badge.FGO}</Badge> {fmtMoney(st.fgoPaid, 'RON')}</td></tr>
              <tr><td>{t('finance.manual')}</td><td data-fin="manual"><Badge tone="purple">{m.badge.MANUAL}</Badge> {fmtMoney(st.manualRon, 'RON')}</td></tr>
              <tr><td>{t('finance.advanced')}</td><td data-fin="advanced">{fmtMoney(st.advanced, 'RON')}</td></tr>
              <tr>
                <td>{t('finance.required')}</td>
                <td data-fin="required">{st.advanceRequired > 0 ? <Badge tone="warn">{fmtMoney(st.advanceRequired, 'RON')}</Badge> : fmtMoney(0, 'RON')}{st.advanceRequired > 0 && <> · <Badge tone={BASIS_TONE[st.advanceBasis as keyof typeof BASIS_TONE] ?? 'muted'}>{m.badge[st.advanceBasis as keyof typeof m.badge] ?? st.advanceBasis}</Badge></>}</td>
              </tr>
              <tr><td>{t('finance.remaining')}</td><td data-fin="remaining">{remaining != null ? fmtMoney(remaining, 'RON') : '—'}</td></tr>
              <tr><td>{t('finance.matchTitle')}</td><td data-fin="match" data-match={st.match}><Badge tone={MATCH_TONE[st.match as keyof typeof MATCH_TONE] ?? 'muted'}>{t(`finance.match.${st.match}` as MsgKey)}</Badge></td></tr>
            </tbody>
          </table>
        </div>
      )}
      {st?.review.map((code: string) => (
        <div key={code} className="alert alert-warn" data-finance-review={code}>
          {t(`finance.review.${code === 'OVERPAID' ? 'OVERPAID' : 'MISMATCH'}` as MsgKey, { fgo: fmtMoney(st.fgoPaid, 'RON'), manual: fmtMoney(st.manualRon, 'RON') })}
        </div>
      ))}

      {/* Elle kaydedilen ödemeler — silinmez; geçersiz kılınan gerekçesiyle görünür kalır */}
      <div className="fx-block">
        <h3>{t('finance.payments.title')} <Badge tone="purple">{m.badge.MANUAL}</Badge></h3>
        {v.payments.length === 0 ? <p className="empty">{t('finance.payments.none')}</p> : (
          <div className="table-wrap">
            <table data-payments>
              <thead>
                <tr>
                  <th>{t('finance.payments.col.date')}</th><th className="num">{t('finance.payments.col.amount')}</th><th className="num">{t('finance.payments.col.ron')}</th>
                  <th>{t('finance.payments.col.method')}</th><th>{t('finance.payments.col.reference')}</th><th>{t('finance.payments.col.by')}</th>
                  <th>{t('finance.payments.col.status')}</th><th />
                </tr>
              </thead>
              <tbody>
                {v.payments.map((p) => (
                  <tr key={p.id} data-payment-row={p.id} data-voided={p.voidedAt ? '1' : undefined} className={p.voidedAt ? 'muted' : undefined}>
                    <td>{fmtDate(p.paidOn)}</td>
                    <td className="num">{fmtMoney(p.amount, p.currency)}</td>
                    <td className="num">{fmtMoney(p.ron, 'RON')}{p.rate != null && <div className="muted small">{t('finance.payments.rate', { rate: rateText(String(p.rate)) ?? '' })}</div>}</td>
                    <td>{t(`finance.methods.${p.method}` as MsgKey)}</td>
                    <td>{p.reference ?? '—'}{p.note && <div className="muted small">{p.note}</div>}</td>
                    <td className="small">{p.createdBy ?? '—'}<div className="muted">{fmtDate(p.createdAt)}</div></td>
                    <td className="small">
                      {p.voidedAt ? <Badge tone="muted">{t('finance.payments.void', { reason: p.voidReason ?? '—' })}</Badge>
                        : p.outside ? <Badge tone="muted">{t('finance.payments.outside')}</Badge>
                          : p.linked ? <Badge tone="ok">{t('finance.payments.linked', { ref: p.advanceRef ?? '—' })}</Badge>
                            : <Badge tone="warn">{t('finance.payments.open')}</Badge>}
                    </td>
                    <td className="actions">
                      {!p.voidedAt && !p.linked && (
                        <details>
                          <summary className="small" style={{ cursor: 'pointer' }}>{t('finance.payments.voidButton')}</summary>
                          <form action={voidPaymentAction} className="row" style={{ marginTop: 6 }}>
                            {hiddenOrder}
                            <input type="hidden" name="paymentId" value={p.id} />
                            <input name="reason" required maxLength={300} placeholder={t('finance.payments.voidReason')} aria-label={t('finance.payments.voidReason')} style={{ minWidth: 180 }} />
                            <ConfirmButton danger outline message={t('finance.payments.voidConfirm')}>{t('finance.payments.voidButton')}</ConfirmButton>
                          </form>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Avans faturaları (dayanağıyla: FGO tahsilatı / elle kayıt) */}
      <div className="fx-block">
        <h3>{t('finance.advance.list')}</h3>
        {v.advances.length === 0 ? <p className="empty">{t('finance.advance.none')}</p> : (
          <ul className="plain-list" data-advances>
            {v.advances.map((a) => (
              <li key={a.id} data-advance={a.ref ?? a.id}>
                <span className="mono">{a.ref ?? '—'}</span> · {fmtDate(a.at)} · <b>{fmtMoney(a.amount, 'RON')}</b>{' '}
                <Badge tone={BASIS_TONE[a.basis as keyof typeof BASIS_TONE] ?? 'muted'}>{m.badge[a.basis as keyof typeof m.badge] ?? a.basis}</Badge>
              </li>
            ))}
          </ul>
        )}
        {v.advancePending && <p className="small" data-advance-pending><Badge tone="warn">{t('finance.advance.pending')}</Badge></p>}
      </div>

      {/* Profil siparişinin FGO belgeleri ve avans faturası (karar 207 — cam avansıyla aynı kurallar; teslim faturasını bekletmez) */}
      {profile && v.chain.kind === 'ORDER' && (
        <div className="fx-block" data-profile-docs>
          <h3>{t('finance.docs.title')}</h3>
          {v.docs.length === 0 ? <p className="empty">{t('finance.docs.none')}</p> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('accounting.receivables.col.kind')}</th><th>{t('accounting.receivables.col.doc')}</th><th>{t('accounting.receivables.col.date')}</th>
                    <th className="num">{t('accounting.receivables.col.total')}</th><th className="num">{t('accounting.receivables.col.paid')}</th>
                  </tr>
                </thead>
                <tbody>
                  {v.docs.map((d) => (
                    <tr key={d.id}>
                      <td>{t(`accounting.receivables.kind.${d.kind}` as MsgKey)}</td>
                      <td className="mono"><FgoDocLink link={d.link}>{d.ref}</FgoDocLink></td>
                      <td>{fmtDate(d.issuedAt)}</td>
                      <td className="num">{d.total != null ? fmtMoney(d.total, 'RON') : '—'}</td>
                      <td className="num">{d.paid != null ? fmtMoney(d.paid, 'RON') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">{t('finance.advance.profileNote')}</p>
          {v.canProfileAdvance && st && (
            <form action={profileAdvanceAction} data-profile-advance>
              {hiddenOrder}
              <DuplicateAck lines={matchLines(t, v.risk.matches as MatchView[])} ackKey={v.risk.ackKey} texts={dupTexts(t)} id="pa-ack" />
              <ConfirmButton primary message={t('finance.advance.confirm', { amount: fmtMoney(st.advanceRequired, 'RON'), basis: m.badge[st.advanceBasis as keyof typeof m.badge] ?? st.advanceBasis })}>
                {t('finance.advance.button', { amount: fmtMoney(st.advanceRequired, 'RON') })}
              </ConfirmButton>
            </form>
          )}
        </div>
      )}

      {v.chain.proforma && !cancelled
        ? <ManualPaymentForm orderId={orderId} requestKey={randomUUID()} today={today} currencies={currencies} rate={rate} m={m} />
        : !cancelled && <p className="hint" data-payment-noproforma>{t('finance.form.noProforma')}</p>}

      <UncertainReview jobs={v.parked} t={t} action={resolveUncertainAction} hidden={hiddenOrder} sp={sp} />
    </div>
  );
}
