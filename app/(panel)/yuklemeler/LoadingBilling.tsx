import Link from 'next/link';
import { db } from '@/lib/db';
import type { CurrentUser } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { userCan } from '@/lib/permissions';
import { fmtDate, fmtMoney, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { FxInfo, FxUnavailableNote } from '@/components/FxInfo';
import { bnrRate } from '@/server/fx/bnr.js';
import { paymentStatus, remaining } from '@/server/accounting/receivables.js';
import { loadingBilling } from '@/server/glass/invoice-batch.js';
import { createAdvanceAction, createInvoiceAction, reviewInvoiceBatchAction } from './billing-actions';
import { ImpactNote, type Impact } from './ImpactNote';

const STATUS_TONE: Record<string, string> = { PENDING: 'info', ISSUED: 'ok', FAILED: 'danger', VOID: 'muted' };
const PAY_TONE = { UNKNOWN: 'muted', UNPAID: 'danger', PARTIAL: 'warn', PAID: 'ok' } as const;
const ERRORS = [
  'FORBIDDEN', 'NOT_FOUND', 'NOT_ALLOWED', 'NOT_CONFIRMED', 'BAD_DAY', 'FGO_DISABLED', 'FGO_DAILY_LIMIT', 'STALE_PREVIEW', 'ALREADY_INVOICED', 'NOTHING_TO_INVOICE',
  'NOTHING_TO_ADVANCE', 'ADVANCE_PENDING',
];
const PROBLEMS = ['BILLING_MISSING', 'FX_UNAVAILABLE', 'ADVANCE_REQUIRED'];
const ron = (n: number | null | undefined) => (n == null ? '—' : fmtMoney(n, 'RON'));

/**
 * Onaylı yükleme gününün Faturalama bölümü (Aşama 7D-3; yalnızca yönetici — ACCOUNTING_MANAGE). Müşteri başına:
 * yüklenen kalemlerin fatura önizlemesi (kesilecek belgeyle aynı sunucu hesabı: loadingBilling), belge zinciri (müşteri
 * proforması, tahsilat, avans), "Avans faturası kes" / "Fatura oluştur" ve kesilen faturaların durumu.
 * Önizleme onayın GEÇERLİ (düzeltilmiş) yüklenen kalemlerindendir. Kesilmiş fatura bir yükleme düzeltmesinden sonra fiili
 * yüklemeyle uyuşmuyorsa "MUHASEBE İŞLEMİ GEREKLİ" gösterilir; hiçbir belge otomatik kesilmez (karar 105).
 * Onaylanmamış günde ve yetkisiz kullanıcıda hiçbir şey çizilmez.
 */
export async function LoadingBilling({ user, day, sp }: { user: CurrentUser; day: string; sp: Record<string, string | undefined> }) {
  if (!userCan(user, 'ACCOUNTING_MANAGE')) return null;
  const { t } = await getT();
  const manual = sp.fk && sp.fkur ? { key: sp.fk, rate: sp.fkur } : null;
  const r = await loadingBilling(db, { day, manual, bnrImpl: (o) => bnrRate({ ...o, timeoutMs: 6000 }) });
  if (!r.ok) return null;
  const errorKey = sp.faturaHata
    ? (PROBLEMS.includes(sp.faturaHata) ? `accounting.invoice.problems.${sp.faturaHata}` : `accounting.invoice.errors.${ERRORS.includes(sp.faturaHata) ? sp.faturaHata : 'NOT_ALLOWED'}`)
    : null;
  const hasAny = r.customers.some((c) => c.groups.length || c.issued.length || c.excluded.length);

  return (
    <div className="card" id="faturalama">
      <h2>{t('accounting.invoice.title')} — {fmtDate(`${day}T12:00:00Z`)}</h2>
      <p className="muted small">{t('accounting.invoice.intro')}</p>
      {sp.fatura && <div className="alert alert-ok">{t(`accounting.invoice.ok.${['created', 'advance', 'retry', 'void'].includes(sp.fatura) ? sp.fatura : 'created'}` as MsgKey)}</div>}
      {errorKey && <div className="alert alert-error">{t(errorKey as MsgKey, { list: '', amount: '' })}</div>}
      {!hasAny && <p className="muted">{t('accounting.invoice.none')}</p>}

      {r.customers.map((c) => (
        <section key={c.customerId} className="fx-block bill-customer" data-customer={c.customerId}>
          <h3>{c.name}</h3>

          {/* Bu onaydan kesilmiş / kuyruktaki / kesilemeyen faturalar */}
          {c.issued.map((b) => {
            const pay = paymentStatus(b.total, b.paid);
            return (
              <div key={b.batchId} className="bill-issued">
                <p>
                  <b>{t('accounting.invoice.issued')}:</b>{' '}
                  {b.ref ? (b.link ? <a className="mono" href={b.link} target="_blank" rel="noopener noreferrer">{b.ref}</a> : <span className="mono">{b.ref}</span>) : '—'}{' '}
                  <Badge tone={STATUS_TONE[b.status]}>{t(`accounting.batch.status.${b.status}` as MsgKey)}</Badge>{' '}
                  {b.status === 'ISSUED' && <Badge tone={PAY_TONE[pay]}>{t(`accounting.receivables.status.${pay}` as MsgKey)}</Badge>}
                  <span className="muted small"> · {t('accounting.invoice.orders', { list: b.orders.join(', ') })}</span>
                </p>
                {b.total != null && <p className="small muted">{t('accounting.invoice.amounts', { total: ron(b.total), paid: ron(b.paid ?? 0), rest: ron(remaining(b.total, b.paid)) })}</p>}
                {/* Yükleme düzeltmesi kesilmiş faturanın kapsamını değiştirdi: yalnızca bildirilir, belge kesilmez / değişmez */}
                {(b.impacts as Impact[]).map((x) => <ImpactNote key={x.orderId} x={x} t={t} money />)}
                {b.lastError && b.status !== 'ISSUED' && <div className="alert alert-error">{t('accounting.batch.lastError', { error: b.lastError.slice(0, 300) })}</div>}
                {b.status === 'FAILED' && (
                  <form action={reviewInvoiceBatchAction} className="row">
                    <input type="hidden" name="day" value={day} />
                    <input type="hidden" name="batchId" value={b.batchId} />
                    <button className="btn" name="do" value="retry">{t('accounting.batch.retry')}</button>
                    <ConfirmButton danger name="do" value="void" message={t('accounting.batch.voidConfirm')}>{t('accounting.batch.void')}</ConfirmButton>
                  </form>
                )}
              </div>
            );
          })}

          {/* Henüz faturası olmayan kapsam: önizleme = kesilecek fatura */}
          {c.groups.map((g) => (
            <div key={g.key} className="bill-group" data-group={g.key}>
              <p className="small">
                {g.chain
                  ? t('accounting.invoice.chain', { ref: g.chain.ref ?? '—', total: ron(g.chain.total), paid: ron(g.chain.paid), advanced: ron(g.chain.advanced) })
                  : t('accounting.invoice.direct')}
              </p>
              <div className="table-wrap load-wrap">
                <table className="load-table confirm-table">
                  <thead>
                    <tr>
                      <th>{t('accounting.invoice.col.line')}</th>
                      <th className="num">{t('accounting.invoice.col.pieces')}</th>
                      <th className="num">{t('accounting.invoice.col.m2')}</th>
                      <th className="num">{t('accounting.invoice.col.amount', { cur: g.currency })}</th>
                      <th className="num">{t('accounting.invoice.col.ronNet')}</th>
                      <th className="num">{t('accounting.invoice.col.ronGross')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.orders.flatMap((o) => [
                      <tr className="sub" key={o.orderId}>
                        <td colSpan={3}>
                          <Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link>
                          {o.title && <span className="muted small"> · {o.title}</span>}
                        </td>
                        <td className="num">{fmtNum(o.sourceTotal)}</td>
                        <td className="num">{g.fx ? fmtNum(o.ronNet) : '—'}</td>
                        <td className="num">{g.fx ? fmtNum(o.ronGross) : '—'}</td>
                      </tr>,
                      ...o.lines.map((l, i) => (
                        <tr className="sub glass-row" key={`${o.orderId}-${i}`}>
                          <td>{l.name}</td>
                          <td className="num">{l.pieces}</td>
                          <td className="num">{fmtNum(l.m2)}</td>
                          <td className="num">{fmtNum(l.amount)}</td>
                          <td className="num">{g.fx ? fmtNum(l.net) : '—'}</td>
                          <td className="num">{g.fx ? fmtNum(l.gross) : '—'}</td>
                        </tr>
                      )),
                    ])}
                    {g.storno.map((s) => (
                      <tr className="sub glass-row bill-storno" key={s.advanceBatchId}>
                        <td colSpan={4}>Stornare avans conform factură {s.ref}</td>
                        <td className="num">−{fmtNum(s.net)}</td>
                        <td className="num">−{fmtNum(s.gross)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="stats stats-money" style={{ marginTop: 12 }}>
                <div className="stat"><div className="k">{t('accounting.batch.totals.source', { cur: g.currency })}</div><div className="v">{fmtNum(g.sourceTotal)}</div></div>
                <div className="stat"><div className="k">{t('accounting.invoice.totals.goods')}</div><div className="v">{g.ronGross != null ? fmtNum(g.ronGross) : '—'}</div></div>
                <div className="stat stat-muted"><div className="k">{t('accounting.invoice.totals.storno')}</div><div className="v">{fmtNum(g.storno.reduce((s, x) => s + x.gross, 0))}</div></div>
                <div className="stat stat-ok"><div className="k">{t('accounting.invoice.totals.payable')}</div><div className="v">{g.payable != null ? fmtNum(g.payable) : '—'}</div></div>
              </div>

              {/* Kur: zincirde proformanın kuru; doğrudan faturada müşterinin kur politikası ya da elle kur */}
              {g.currency !== 'RON' && (
                <div className="fx-block">
                  {g.fx ? <FxInfo fx={g.fx} t={t} /> : g.fxError && <FxUnavailableNote code={g.fxError.code} error={g.fxError.error} t={t} />}
                  {!g.chain && (
                    <form method="get" action="/yuklemeler" className="row">
                      <input type="hidden" name="gun" value={day} />
                      <input type="hidden" name="fk" value={g.key} />
                      <label htmlFor={`fkur-${c.customerId}`} style={{ margin: 0 }}>{t('fx.manualLabel')}</label>
                      <input id={`fkur-${c.customerId}`} name="fkur" inputMode="decimal" maxLength={10} style={{ width: 110 }} defaultValue={manual?.key === g.key ? manual.rate : ''} title={t('fx.manualHint')} />
                      <button className="btn">{t('accounting.batch.manualApply')}</button>
                    </form>
                  )}
                </div>
              )}

              {g.problems.map((code) => (
                <div key={code} className="alert alert-warn">
                  {t(`accounting.invoice.problems.${code}` as MsgKey, { list: c.missingBilling.join(', '), amount: ron(g.chain?.advanceRequired) })}
                  {code === 'ADVANCE_PENDING' && <> <Link href={`/admin/muhasebe/cam/proforma?musteri=${c.customerId}#partiler`}>{t('accounting.batch.open')}</Link></>}
                </div>
              ))}
              <div className="row end" style={{ marginTop: 12 }}>
                {/* Proformada avansı kesilmemiş tahsilat: avans faturası yüklemeden sonra da kesilebilir; kesilince fatura açılır */}
                {g.chain && g.chain.advanceRequired > 0 && !g.chain.advancePending && (
                  <form action={createAdvanceAction}>
                    <input type="hidden" name="day" value={day} />
                    <input type="hidden" name="proformaBatchId" value={g.chain.proformaBatchId} />
                    <ConfirmButton primary message={t('accounting.invoice.advanceConfirm', { ref: g.chain.ref ?? '', amount: ron(g.chain.advanceRequired) })}>
                      {t('accounting.invoice.advanceCreate', { amount: ron(g.chain.advanceRequired) })}
                    </ConfirmButton>
                  </form>
                )}
                {g.problems.length === 0 && (
                  <form action={createInvoiceAction}>
                    <input type="hidden" name="day" value={day} />
                    <input type="hidden" name="groupKey" value={g.key} />
                    <input type="hidden" name="previewKey" value={g.previewKey} />
                    <input type="hidden" name="fxRate" value={manual?.key === g.key ? manual.rate : ''} />
                    <ConfirmButton success message={t('accounting.invoice.confirm', { n: g.orders.length })}>{t('accounting.invoice.create')}</ConfirmButton>
                  </form>
                )}
              </div>
            </div>
          ))}

          {c.excluded.length > 0 && (
            <div className="small">
              <b>{t('accounting.invoice.excludedTitle')}:</b>
              <ul>
                {c.excluded.map((o) => (
                  <li key={o.orderId}>
                    <Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link> — {t(`accounting.invoice.reason.${o.reason}` as MsgKey)}{o.ref ? ` (${o.ref})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
