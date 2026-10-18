import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { creditCustomers, customerCredit } from '@/server/finance/credit-service.js';
import { closeOffsetAction, createOffsetAction } from './actions';

export const dynamic = 'force-dynamic';

const RON = (n: number | null | undefined) => (n == null ? '—' : fmtMoney(n, 'RON'));
const OK = ['created', 'duplicate', 'REVERSED', 'FGO_RECORDED'];
const TONE: Record<string, 'ok' | 'muted' | 'info'> = { ACTIVE: 'info', REVERSED: 'muted', FGO_RECORDED: 'ok' };

/**
 * Müşteri Bakiyeleri (DÜZELTME 10 Aşama 2C, karar 295): müşterinin bütün ödeme zincirlerindeki fazla ödeme, TAKİP içi mahsup
 * kayıtları (geçmiş dahil) ve kullanılabilir bakiye. Hesap tek yerde (creditLedger); mahsup FGO'ya hiçbir şey yazmaz.
 * Yalnızca ACCOUNTING_MANAGE (sayfa, işlem ve serviste ayrı ayrı).
 */
export default async function CustomerCreditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requirePermission('ACCOUNTING_MANAGE');
  const { t, m } = await getT();
  const sp = await searchParams;
  const actor = await actorOf(admin);
  const okText = sp.ok && OK.includes(sp.ok) ? t(`finance.credit.ok.${sp.ok}` as MsgKey) : null;
  const errText = sp.error ? t(Object.hasOwn(m.finance.credit.errors, sp.error) ? (`finance.credit.errors.${sp.error}` as MsgKey) : 'finance.credit.errors.OTHER') : null;

  if (!sp.c) {
    const list = await creditCustomers(db, actor);
    if (!list.ok) return <div className="alert alert-error">{t('finance.credit.errors.FORBIDDEN')}</div>;
    return (
      <>
        <div className="page-head">
          <h1>{t('finance.credit.title')}</h1>
          <p className="muted">{t('finance.credit.intro')}</p>
        </div>
        <div className="alert alert-info" data-credit-not-fgo>{t('finance.credit.notFgo')}</div>
        <div className="card card-flush">
          {list.rows.length === 0 ? <div className="empty">{t('finance.credit.empty')}</div> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('finance.credit.col.customer')}</th><th className="num">{t('finance.credit.totals.paid')}</th><th className="num">{t('finance.credit.totals.overpaid')}</th>
                    <th className="num">{t('finance.credit.totals.offset')}</th><th className="num">{t('finance.credit.totals.available')}</th><th>{t('finance.credit.col.review')}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.customer.id} data-credit-customer={r.customer.prefix ?? r.customer.name}>
                      <td><b>{r.customer.name}</b> <span className="muted small">{r.customer.prefix}</span></td>
                      {'tooLarge' in r ? <td colSpan={5} className="muted">{t('finance.credit.tooLarge')}</td> : (
                        <>
                          <td className="num">{RON(r.totals.paid)}</td><td className="num">{RON(r.totals.overpaid)}</td><td className="num">{RON(r.totals.offset)}</td>
                          <td className="num" data-available><b>{RON(r.totals.available)}</b></td>
                          <td>{r.review > 0 ? <Badge tone="warn">{r.review}</Badge> : '—'}</td>
                        </>
                      )}
                      <td className="actions"><Link className="btn" href={`/admin/muhasebe/bakiye?c=${r.customer.id}`}>{t('finance.credit.open')}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </>
    );
  }

  const v = await customerCredit(db, sp.c, actor);
  if (!v.ok) {
    return (
      <>
        <p><Link href="/admin/muhasebe/bakiye">{t('finance.credit.back')}</Link></p>
        <div className="alert alert-error">{t(Object.hasOwn(m.finance.credit.errors, v.code) ? (`finance.credit.errors.${v.code}` as MsgKey) : 'finance.credit.errors.OTHER')}</div>
      </>
    );
  }
  const sources = v.rows.filter((r) => r.canSource);
  const targets = v.rows.filter((r) => r.canTarget);
  const label = (r: (typeof v.rows)[number]) => `${r.ref ?? '—'} · ${r.orderNos.join(', ')}`;
  return (
    <>
      <div className="page-head">
        <p><Link href="/admin/muhasebe/bakiye">{t('finance.credit.back')}</Link></p>
        <h1>{v.customer.name} <span className="muted small">{v.customer.prefix}</span></h1>
        <p className="muted">{t('finance.credit.intro')}</p>
      </div>
      {okText && <div className="alert alert-ok">{okText}</div>}
      {errText && <div className="alert alert-error" role="alert" data-error={sp.error}>{errText}</div>}
      <div className="alert alert-info" data-credit-not-fgo>{t('finance.credit.notFgo')}</div>

      <div className="card" id="bakiye">
        <table className="kv">
          <tbody>
            <tr><td>{t('finance.credit.totals.paid')}</td><td data-total="paid">{RON(v.totals.paid)}</td></tr>
            <tr><td>{t('finance.credit.totals.overpaid')}</td><td data-total="overpaid">{RON(v.totals.overpaid)}</td></tr>
            <tr><td>{t('finance.credit.totals.offset')}</td><td data-total="offset">{RON(v.totals.offset)}</td></tr>
            <tr><td>{t('finance.credit.totals.available')}</td><td data-total="available"><b>{RON(v.totals.available)}</b></td></tr>
            {v.totals.cancelledPaid > 0 && <tr><td>{t('finance.credit.totals.cancelledPaid')}</td><td data-total="cancelledPaid">{RON(v.totals.cancelledPaid)}</td></tr>}
          </tbody>
        </table>
      </div>

      {v.review.map((r, i) => {
        const chain = 'chain' in r ? v.rows.find((x) => x.key === r.chain) : null;
        return <div key={i} className="alert alert-warn" data-credit-review={r.code}>{t(`finance.credit.review.${r.code}` as MsgKey, { chain: chain ? label(chain) : '' })}</div>;
      })}

      <div className="card card-flush" id="zincirler">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('finance.credit.col.chain')}</th><th>{t('finance.credit.col.orders')}</th><th className="num">{t('finance.credit.col.total')}</th>
                <th className="num">{t('finance.credit.col.fgo')}</th><th className="num">{t('finance.credit.col.manual')}</th><th className="num">{t('finance.credit.col.advanced')}</th>
                <th className="num">{t('finance.credit.col.overpaid')}</th><th className="num">{t('finance.credit.col.out')}</th><th className="num">{t('finance.credit.col.remaining')}</th>
                <th className="num">{t('finance.credit.col.in')}</th><th className="num">{t('finance.credit.col.open')}</th>
              </tr>
            </thead>
            <tbody>
              {v.rows.map((r) => (
                <tr key={r.key} data-chain={r.ref ?? r.key} data-overpaid={r.overpaid} data-remaining={r.remaining} style={r.cancelled ? { opacity: 0.6 } : undefined}>
                  <td className="mono">{r.ref ?? '—'}{r.cancelled && <div className="muted small">{t('finance.credit.cancelled')}</div>}</td>
                  <td className="small">{r.orderIds.map((id, i) => <div key={id}><Link href={`/siparisler/${id}#odemeler`}>{r.orderNos[i]}</Link></div>)}</td>
                  <td className="num">{RON(r.total)}</td><td className="num">{RON(r.fgoPaid)}</td><td className="num">{RON(r.manualRon)}</td><td className="num">{RON(r.advanced)}</td>
                  <td className="num">{r.overpaid > 0 ? <b>{RON(r.overpaid)}</b> : RON(0)}</td><td className="num">{RON(r.offsetOut)}</td>
                  <td className="num" data-remaining-cell>{RON(r.remaining)}</td><td className="num">{RON(r.offsetIn)}</td><td className="num">{RON(r.open)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <form action={createOffsetAction} className="card" id="mahsup-formu">
        <h2>{t('finance.credit.form.title')}</h2>
        <p className="muted small">{t('finance.credit.form.hint')}</p>
        {sources.length === 0 || targets.length === 0 ? <div className="empty">{t('finance.credit.form.none')}</div> : (
          <>
            <input type="hidden" name="customerId" value={v.customer.id} />
            <input type="hidden" name="requestKey" value={randomUUID()} />
            <div className="grid-3">
              <div>
                <label htmlFor="of-source">{t('finance.credit.form.source')}</label>
                <select id="of-source" name="sourceChain" required>
                  {sources.map((r) => <option key={r.key} value={r.key}>{label(r)} — {RON(r.remaining)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="of-target">{t('finance.credit.form.target')}</label>
                <select id="of-target" name="targetOrderId" required>
                  {targets.map((r) => <option key={r.key} value={r.orderIds[0]}>{label(r)} — {RON(r.open)}</option>)}
                </select>
              </div>
              <div><label htmlFor="of-amount">{t('finance.credit.form.amount')}</label><input id="of-amount" name="amount" required inputMode="decimal" maxLength={14} /></div>
            </div>
            <label htmlFor="of-note">{t('finance.credit.form.note')}</label>
            <input id="of-note" name="note" required maxLength={500} />
            <label className="check" style={{ marginTop: 8 }}><input type="checkbox" name="confirm" required /> {t('finance.credit.form.confirm')}</label>
            <div className="row" style={{ marginTop: 10 }}><ConfirmButton primary message={t('finance.credit.form.confirmDialog')}>{t('finance.credit.form.submit')}</ConfirmButton></div>
          </>
        )}
      </form>

      <div className="card card-flush" id="mahsuplar">
        <div className="card-head"><h2>{t('finance.credit.offsets.title')} <span className="badge">{v.offsets.length}</span></h2></div>
        {v.offsets.length === 0 ? <div className="empty">{t('finance.credit.offsets.none')}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('finance.credit.col.when')}</th><th>{t('finance.credit.col.source')}</th><th>{t('finance.credit.col.target')}</th><th className="num">{t('finance.credit.col.amount')}</th>
                  <th>{t('finance.credit.col.note')}</th><th>{t('finance.credit.col.status')}</th><th />
                </tr>
              </thead>
              <tbody>
                {v.offsets.map((o) => (
                  <tr key={o.id} data-offset={o.id} data-offset-status={o.status}>
                    <td className="small">{fmtDateTime(o.createdAt)}<div className="muted">{o.createdBy?.name ?? ''}</div></td>
                    <td className="small"><span className="mono">{o.sourceRef}</span> · {o.sourceOrder.orderNo}</td>
                    <td className="small"><span className="mono">{o.targetRef}</span> · {o.targetOrder.orderNo}</td>
                    <td className="num nowrap">{RON(Number(o.amountRon))}</td>
                    <td className="small">{o.note}</td>
                    <td>
                      <Badge tone={TONE[o.status] ?? 'muted'}>{t(`finance.credit.status.${o.status}` as MsgKey)}</Badge>
                      {o.status !== 'ACTIVE' && <div className="muted small">{t('finance.credit.offsets.closed', { status: t(`finance.credit.status.${o.status}` as MsgKey), reason: o.closeReason ?? '', who: o.closedBy?.name ?? '', when: o.closedAt ? fmtDateTime(o.closedAt) : '' })}</div>}
                    </td>
                    <td className="actions">
                      {o.status === 'ACTIVE' && (
                        <form action={closeOffsetAction} className="stack">
                          <input type="hidden" name="customerId" value={v.customer.id} />
                          <input type="hidden" name="offsetId" value={o.id} />
                          <input name="reason" required maxLength={500} placeholder={t('finance.credit.close.reason')} aria-label={t('finance.credit.close.reason')} />
                          <label className="check small"><input type="checkbox" name="confirm" required /> {t('finance.credit.close.confirm')}</label>
                          <div className="row">
                            <ConfirmButton outline name="mode" value="FGO_RECORDED" message={t('finance.credit.close.fgoDialog')}>{t('finance.credit.close.fgo')}</ConfirmButton>
                            <ConfirmButton danger outline name="mode" value="REVERSED" message={t('finance.credit.close.reverseDialog')}>{t('finance.credit.close.reverse')}</ConfirmButton>
                          </div>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
