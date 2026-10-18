// Profil iadesi kartı (DÜZELTME 10 M8) — yalnızca PROFILE_RETURN_MANAGE (yönetici). Veri server/profile/returns.js →
// returnOverview'dan; hesap ve doğrulama sunucuda. Stok iade açılınca değişmez; depo teslimiyle (bağlantı ya da yönetici)
// sağlam → stok, hasarlı → bloke stok. FGO düzeltme belgesi kesilmez (muhasebe / FGO doğrulaması bekler).
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import type { CurrentUser } from '@/lib/auth/session';
import type { MsgKey, T } from '@/lib/i18n';
import { fmtDate, fmtDateTime, fmtNum } from '@/lib/format';
import { actorOf } from '@/lib/actor';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { unitLabel } from '@/server/profile/catalog.js';
import { returnOverview } from '@/server/profile/returns.js';
import { cancelReturnAction, createReturnAction, receiveReturnAction, refundDoneAction } from './return-actions';

const TONE = { ACIK: 'warn', TESLIM_ALINDI: 'ok', IPTAL: 'muted' } as const;

export async function ProfileReturns({ orderId, user, t, locale, today, sp }: {
  orderId: string; user: CurrentUser; t: T; locale: 'tr' | 'ro'; today: string; sp: Record<string, string | undefined>;
}) {
  const v = await returnOverview(db, orderId, await actorOf(user));
  if (!v.ok) return null;
  const has = v.returns.length > 0;
  if (!v.delivered && !has) return null;
  const okKey = sp.rok && ['opened', 'duplicate', 'received', 'cancelled', 'refund'].includes(sp.rok) ? (`returns.ok.${sp.rok}` as MsgKey) : null;
  const errKey = sp.rerr ? (/^[A-Z_]{2,30}$/.test(sp.rerr) ? (`returns.errors.${sp.rerr}` as MsgKey) : ('returns.errors.OTHER' as MsgKey)) : null;
  const open = v.lines.filter((l) => l.remaining > 0);
  const key = crypto.randomBytes(18).toString('base64url');
  return (
    <div className="card" id="iade" data-returns={v.returns.length}>
      <h2>{t('returns.title')}</h2>
      <p className="muted small">{t('returns.intro')}</p>
      {okKey && <div className="alert alert-ok">{t(okKey)}</div>}
      {errKey && <div className="alert alert-error" role="alert" data-return-error={sp.rerr}>{t(errKey)}</div>}

      {v.returns.length === 0 ? <p className="muted" data-no-returns>{t('returns.none')}</p> : v.returns.map((r) => (
        <div key={r.id} className="fx-block" data-return={r.seq} data-return-status={r.status}>
          <h3>#{r.seq} <Badge tone={TONE[r.status]}>{t(`returns.status.${r.status}` as MsgKey)}</Badge> <span className="muted small">{fmtDateTime(r.createdAt)}</span></h3>
          <p className="small"><b>{t('returns.reason')}:</b> {r.reason}{r.note && <span className="muted"> · {r.note}</span>}</p>
          <p className="small">
            {r.fxRate ? t('returns.amount', { amount: fmtNum(r.amount.toString()), currency: r.currency, rate: r.fxRate.toString() }) : t('returns.amountNoRate', { amount: fmtNum(r.amount.toString()), currency: r.currency })}
            {' · '}{r.invoiced ? t('returns.invoiced') : t('returns.notInvoiced')}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('returns.col.product')}</th><th className="num">{t('returns.col.qty')}</th><th>{t('returns.col.unit')}</th><th className="num">{t('returns.col.price')}</th><th className="num">{t('returns.col.total')}</th>
                  {r.status === 'TESLIM_ALINDI' && <><th className="num">{t('returns.col.good')}</th><th className="num">{t('returns.col.damaged')}</th></>}
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.id} data-return-line={l.code}>
                    <td><span className="mono">{l.code}</span> {locale === 'tr' ? l.nameTr : l.nameRo}</td>
                    <td className="num">{l.qty}</td><td>{unitLabel(l.unitCode, locale)}</td>
                    <td className="num">{fmtNum(l.unitPrice.toString())}</td><td className="num">{fmtNum(l.lineTotal.toString())}</td>
                    {r.status === 'TESLIM_ALINDI' && <><td className="num" data-good>{l.goodQty ?? 0}</td><td className="num" data-damaged>{l.damagedQty ?? 0}</td></>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted" data-fgo-pending>{t('returns.fgoPending')}</p>
          {r.financeAction === 'REFUND' && (r.refundDoneAt
            ? <p className="small" data-refund-done>{t('returns.refundDone', { date: fmtDate(r.refundDoneAt), ref: r.refundReference ?? '' })}</p>
            : <p className="small" data-refund-waiting><Badge tone="warn">{t('returns.refundWaiting')}</Badge></p>)}
          {r.financeAction === 'OFFSET' && <p className="small" data-offset-waiting><Badge tone="warn">{t('returns.offsetWaiting')}</Badge></p>}
          {r.status === 'TESLIM_ALINDI' && r.receivedAt && <p className="small muted">{fmtDateTime(r.receivedAt)} · {t(`returns.receivedVia.${r.receivedVia === 'DEPOT_LINK' ? 'DEPOT_LINK' : 'ADMIN'}` as MsgKey)}{r.receivedNote ? ` · ${r.receivedNote}` : ''}</p>}

          {r.status === 'ACIK' && (
            <details style={{ marginTop: 8 }} data-return-receive>
              <summary className="btn">{t('returns.receive')}</summary>
              <form action={receiveReturnAction} style={{ marginTop: 8 }}>
                <input type="hidden" name="id" value={orderId} />
                <input type="hidden" name="returnId" value={r.id} />
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>{t('returns.col.product')}</th><th className="num">{t('returns.col.qty')}</th><th className="num">{t('returns.col.good')}</th><th className="num">{t('returns.col.damaged')}</th></tr></thead>
                    <tbody>
                      {r.lines.map((l) => (
                        <tr key={l.id}>
                          <td className="mono">{l.code}</td><td className="num">{l.qty}</td>
                          <td className="num"><input className="qty-input" name={`g-${l.id}`} inputMode="numeric" maxLength={6} defaultValue={String(l.qty)} aria-label={`${t('returns.col.good')} ${l.code}`} /></td>
                          <td className="num"><input className="qty-input" name={`d-${l.id}`} inputMode="numeric" maxLength={6} defaultValue="0" aria-label={`${t('returns.col.damaged')} ${l.code}`} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <label htmlFor={`rn-${r.id}`} className="small">{t('returns.note')}</label>
                <input id={`rn-${r.id}`} name="note" maxLength={1000} />
                <div className="hint">{t('returns.receiveHint')}</div>
                <div className="row" style={{ marginTop: 8 }}><ConfirmButton primary message={t('returns.receiveConfirm')}>{t('returns.receive')}</ConfirmButton></div>
              </form>
              <form action={cancelReturnAction} className="row" style={{ marginTop: 8 }}>
                <input type="hidden" name="id" value={orderId} />
                <input type="hidden" name="returnId" value={r.id} />
                <input name="reason" required maxLength={500} placeholder={t('returns.cancelReason')} aria-label={t('returns.cancelReason')} />
                <ConfirmButton danger outline message={t('returns.cancelConfirm')}>{t('returns.cancel')}</ConfirmButton>
              </form>
            </details>
          )}
          {r.financeAction === 'REFUND' && !r.refundDoneAt && r.status !== 'IPTAL' && (
            <form action={refundDoneAction} className="row" style={{ marginTop: 8 }} data-refund-form>
              <input type="hidden" name="id" value={orderId} />
              <input type="hidden" name="returnId" value={r.id} />
              <input type="date" name="doneOn" required max={today} defaultValue={today} aria-label={t('returns.refundDate')} />
              <input name="reference" required maxLength={120} placeholder={t('returns.refundRef')} aria-label={t('returns.refundRef')} />
              <ConfirmButton message={t('returns.refund')}>{t('returns.refund')}</ConfirmButton>
            </form>
          )}
        </div>
      ))}

      {v.delivered && (open.length === 0 ? null : (
        <details style={{ marginTop: 12 }} data-return-new>
          <summary className="btn btn-primary">{t('returns.add')}</summary>
          <form action={createReturnAction} style={{ marginTop: 8 }}>
            <input type="hidden" name="id" value={orderId} />
            <input type="hidden" name="requestKey" value={key} />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>{t('returns.col.product')}</th><th className="num">{t('returns.col.delivered')}</th><th className="num">{t('returns.col.returned')}</th><th className="num">{t('returns.col.remaining')}</th><th className="num">{t('returns.col.qty')}</th></tr>
                </thead>
                <tbody>
                  {open.map((l) => (
                    <tr key={l.offerLineId} data-returnable={l.product?.code}>
                      <td><span className="mono">{l.product?.code}</span> {locale === 'tr' ? l.product?.nameTr : l.product?.nameRo} <span className="muted small">({unitLabel(l.product?.unitCode ?? '', locale)})</span></td>
                      <td className="num">{l.delivered}</td><td className="num">{l.returned}</td><td className="num">{l.remaining}</td>
                      <td className="num"><input className="qty-input" name={`q-${l.offerLineId}`} inputMode="numeric" maxLength={6} defaultValue="" aria-label={`${t('returns.col.qty')} ${l.product?.code}`} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label htmlFor="ret-reason">{t('returns.reason')}</label>
            <textarea id="ret-reason" name="reason" required rows={2} maxLength={500} />
            <label htmlFor="ret-note">{t('returns.note')}</label>
            <input id="ret-note" name="note" maxLength={1000} />
            {v.paid && (
              <fieldset className="fieldset-plain" style={{ marginTop: 8 }} data-return-finance>
                <legend className="label">{t('returns.finance')}</legend>
                <label className="check"><input type="radio" name="financeAction" value="REFUND" required /> {t('returns.financeAction.REFUND')}</label>
                <label className="check"><input type="radio" name="financeAction" value="OFFSET" /> {t('returns.financeAction.OFFSET')}</label>
                <div className="hint">{t('returns.financeHint')}</div>
              </fieldset>
            )}
            <label htmlFor="ret-photos" style={{ marginTop: 8 }}>{t('returns.photos')}</label>
            <input id="ret-photos" type="file" name="photos" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" />
            <div className="row" style={{ marginTop: 10 }}><ConfirmButton primary message={t('returns.confirm')}>{t('returns.submit')}</ConfirmButton></div>
          </form>
        </details>
      ))}
    </div>
  );
}
