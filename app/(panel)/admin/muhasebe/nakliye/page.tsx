import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { getEnv } from '@/lib/env';
import { fmtDate, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { listTransports, transportReceiptOptions } from '@/server/suppliers/costs.js';
import { TRANSPORT_CURRENCIES } from '@/server/suppliers/stock-cost.js';
import { localDay } from '@/server/profile/dates.js';
import { addTransportAction, paidTransportAction, voidTransportAction } from './actions';

export const dynamic = 'force-dynamic';

const OK: Record<string, MsgKey> = {
  added: 'supplier.transport.ok.added', duplicate: 'supplier.transport.ok.duplicate', voided: 'supplier.transport.ok.voided', paid: 'supplier.transport.ok.paid',
};

/**
 * Nakliye giderleri (DÜZELTME 10 M6): taşıyıcı faturası → bağlı mal kabullerinin ürünlerine birim başına eşit pay (gerçek
 * miktar). Taşıyıcının borcu ürün tedarikçisinin borcundan AYRI izlenir; ürünün gerçekleşen stok maliyetine girer. RON tutar
 * fatura tarihindeki kayıtlı kurla EUR'ya çevrilir (kur kayıtta sabit). Yalnızca SUPPLIER_MANAGE.
 */
export default async function TransportCostsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const { t, m } = await getT();
  const sp = await searchParams;
  const actor = await actorOf(admin);
  const [list, opts] = await Promise.all([listTransports(db, actor), transportReceiptOptions(db, actor, { timeZone: getEnv().APP_TIMEZONE })]);
  if (!list.ok || !opts.ok) return <div className="alert alert-error">{t('supplier.errors.FORBIDDEN')}</div>;
  const today = localDay(new Date(), getEnv().APP_TIMEZONE);
  const okText = sp.ok && Object.hasOwn(OK, sp.ok) ? t(OK[sp.ok]) : null;
  const errText = sp.error ? t(Object.hasOwn(m.supplier.errors, sp.error) ? (`supplier.errors.${sp.error}` as MsgKey) : 'supplier.errors.OTHER', { row: '—', name: '' }) : null;
  return (
    <>
      <div className="page-head">
        <p><Link href="/admin/muhasebe/tedarikciler">{t('supplier.accounts.back')}</Link></p>
        <h1>{t('supplier.transport.title')}</h1>
        <p className="muted">{t('supplier.transport.intro')}</p>
      </div>
      {okText && <div className="alert alert-ok">{okText}</div>}
      {errText && <div className="alert alert-error" role="alert" data-error={sp.error}>{errText}</div>}

      <div className="card" id="tasiyicilar">
        <h2>{t('supplier.transport.carriers')}</h2>
        {list.carriers.length === 0 ? <div className="empty">{t('supplier.transport.none')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('supplier.transport.col.carrier')}</th><th>{t('supplier.accounts.col.currency')}</th><th className="num">{t('supplier.transport.col.total')}</th><th className="num">{t('supplier.transport.col.paid')}</th><th className="num">{t('supplier.transport.col.open')}</th></tr></thead>
              <tbody>
                {list.carriers.map((c) => (
                  <tr key={`${c.carrier}|${c.currency}`} data-carrier={c.carrier}>
                    <td><b>{c.carrier}</b> <span className="muted small">({c.count})</span></td><td>{c.currency}</td>
                    <td className="num">{fmtNum(c.total)}</td><td className="num">{fmtNum(c.paid)}</td><td className="num"><b>{fmtNum(c.open)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <form action={addTransportAction} className="card" id="yeni">
        <h2>{t('supplier.transport.add')}</h2>
        <input type="hidden" name="requestKey" value={randomUUID()} />
        <div className="grid-3">
          <div><label htmlFor="tr-carrier">{t('supplier.transport.col.carrier')}</label><input id="tr-carrier" name="carrierName" required maxLength={120} /></div>
          <div><label htmlFor="tr-no">{t('supplier.transport.col.invoiceNo')}</label><input id="tr-no" name="invoiceNo" maxLength={60} /></div>
          <div><label htmlFor="tr-date">{t('supplier.transport.col.invoiceDate')}</label><input id="tr-date" name="invoiceDate" type="date" required max={today} defaultValue={today} /></div>
          <div><label htmlFor="tr-amount">{t('supplier.transport.col.amount')}</label><input id="tr-amount" name="amount" required inputMode="decimal" maxLength={16} /></div>
          <div>
            <label htmlFor="tr-cur">{t('supplier.accounts.col.currency')}</label>
            <select id="tr-cur" name="currency" defaultValue="EUR">{TRANSPORT_CURRENCIES.map((c: string) => <option key={c} value={c}>{c}</option>)}</select>
          </div>
          <div>
            <label htmlFor="tr-fx">{t('supplier.transport.col.fx')}</label>
            <input id="tr-fx" name="fxRate" inputMode="decimal" maxLength={12} />
            <div className="hint">{t('supplier.transport.fxHint')}</div>
          </div>
        </div>
        <label htmlFor="tr-note">{t('supplier.accounts.pay.note')}</label>
        <input id="tr-note" name="note" maxLength={500} />
        <fieldset className="fieldset-plain" style={{ marginTop: 10 }}>
          <legend className="label">{t('supplier.transport.receipts')}</legend>
          {opts.receipts.length === 0 ? <div className="empty">{t('supplier.transport.noReceipts')}</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th /><th>{t('supplier.transport.col.receivedOn')}</th><th>{t('supplier.accounts.orders.col.no')}</th><th>{t('supplier.accounts.col.supplier')}</th><th className="num">{t('supplier.transport.col.qty')}</th><th>{t('supplier.transport.col.linked')}</th></tr></thead>
                <tbody>
                  {opts.receipts.map((r) => (
                    <tr key={r.id} data-receipt-option={`${r.orderNo}-${r.seq}`}>
                      <td><input type="checkbox" name="receiptId" value={r.id} aria-label={`${r.orderNo} #${r.seq}`} /></td>
                      <td>{r.receivedOn}</td><td className="mono">{r.orderNo} · #{r.seq}</td><td>{r.supplier}</td>
                      <td className="num">{r.qty}</td>
                      <td>{r.transports > 0 ? <Badge tone="info">{t('supplier.transport.linkedN', { n: r.transports })}</Badge> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </fieldset>
        <div className="hint">{t('supplier.transport.hint')}</div>
        <div className="row" style={{ marginTop: 10 }}><ConfirmButton primary message={t('supplier.transport.confirm')}>{t('supplier.transport.submit')}</ConfirmButton></div>
      </form>

      <div className="card card-flush" id="kayitlar">
        <div className="card-head"><h2>{t('supplier.transport.list')} <span className="badge">{list.rows.length}</span></h2></div>
        {list.rows.length === 0 ? <div className="empty">{t('supplier.transport.none')}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('supplier.transport.col.invoiceDate')}</th><th>{t('supplier.transport.col.carrier')}</th><th>{t('supplier.transport.col.invoiceNo')}</th>
                  <th className="num">{t('supplier.transport.col.amount')}</th><th className="num">{t('supplier.transport.col.eur')}</th><th>{t('supplier.transport.receipts')}</th>
                  <th>{t('supplier.accounts.payments.col.status')}</th><th />
                </tr>
              </thead>
              <tbody>
                {list.rows.map((x) => (
                  <tr key={x.id} data-transport={x.invoiceNo ?? x.id} style={x.voidedAt ? { opacity: 0.6 } : undefined}>
                    <td>{fmtDate(x.invoiceDate)}</td><td>{x.carrierName}</td><td className="mono">{x.invoiceNo ?? '—'}</td>
                    <td className="num nowrap">{fmtNum(x.amount.toString())} {x.currency}{x.fxRate && <div className="muted small">{t('supplier.transport.rate', { rate: x.fxRate.toString(), day: x.fxDate ? fmtDate(x.fxDate) : '—' })}</div>}</td>
                    <td className="num nowrap" data-eur>{fmtNum(x.amountEur.toString())} EUR</td>
                    <td className="small">{x.receipts.map((r) => <div key={r.receipt.id}><Link href={`/siparisler/tedarik/${r.receipt.order.id}`}>{r.receipt.order.orderNo}</Link> · #{r.receipt.seq}</div>)}<span className="muted">{t('supplier.transport.lines', { n: x._count.allocations })}</span></td>
                    <td>
                      {x.voidedAt ? <span className="small">{t('supplier.accounts.payments.voided', { reason: x.voidReason ?? '' })}</span>
                        : x.paidOn ? <Badge tone="ok">{t('supplier.transport.paidOn', { day: fmtDate(x.paidOn) })}</Badge> : <Badge tone="warn">{t('supplier.transport.unpaid')}</Badge>}
                    </td>
                    <td className="actions">
                      {!x.voidedAt && !x.paidOn && (
                        <form action={paidTransportAction} className="row">
                          <input type="hidden" name="transportId" value={x.id} />
                          <input type="date" name="paidOn" required max={today} defaultValue={today} aria-label={t('supplier.transport.markPaid')} />
                          <button className="btn">{t('supplier.transport.markPaid')}</button>
                        </form>
                      )}
                      {!x.voidedAt && (
                        <form action={voidTransportAction} className="row">
                          <input type="hidden" name="transportId" value={x.id} />
                          <input name="reason" required maxLength={500} placeholder={t('supplier.accounts.void.reason')} aria-label={t('supplier.accounts.void.reason')} />
                          <ConfirmButton danger message={t('supplier.transport.voidConfirm')}>{t('supplier.accounts.void.button')}</ConfirmButton>
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
