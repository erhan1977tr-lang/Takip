import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDate, fmtMoney, fmtNum, isoDay } from '@/lib/format';
import { getEnv } from '@/lib/env';
import { ConfirmButton } from '@/components/ConfirmButton';
import { CURRENCIES, supplierData } from '@/server/accounting/supplier.js';
import { localDay } from '@/server/profile/dates.js';
import { addPaymentAction, addTransportAction, deletePaymentAction, deleteTransportAction } from '../actions';

export const dynamic = 'force-dynamic';

const OK: Record<string, MsgKey> = { transport: 'accounting.supplier.ok.transport', payment: 'accounting.supplier.ok.payment', deleted: 'accounting.supplier.ok.deleted' };
const ERR: Record<string, MsgKey> = { transport: 'accounting.supplier.errors.transport', payment: 'accounting.supplier.errors.payment' };

/** Tedarikçi hesap durumu: yükleme kârlılığı (otomatik) ve fabrika cari hesabı (ödemeler yüklemelerden bağımsız). */
export default async function SupplierPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('ACCOUNTING_MANAGE');
  const { t } = await getT();
  const sp = await searchParams;
  const today = localDay(new Date(), getEnv().APP_TIMEZONE);
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const { days, costs, payments, summary } = await supplierData(db, end);
  const curs = Object.keys(summary).sort();
  const money = (v: number, cur: string) => <span className={v < 0 ? 'danger' : undefined}>{fmtMoney(v, cur)}</span>;
  const costsOf = (day: string) => costs.filter((c) => c.shipDay.toISOString().slice(0, 10) === day);
  const CurSelect = ({ id }: { id: string }) => (
    <select id={id} name="currency" defaultValue="EUR" style={{ width: 'auto' }}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
  );

  return (
    <>
      <div className="page-head">
        <h1>{t('accounting.supplier.title')}</h1>
        <p className="muted">{t('accounting.supplier.intro')}</p>
      </div>
      {sp.ok && OK[sp.ok] && <div className="alert alert-ok">{t(OK[sp.ok])}</div>}
      {sp.error && ERR[sp.error] && <div className="alert alert-error">{t(ERR[sp.error])}</div>}

      {/* Üst özet: her para birimi ayrı */}
      <div className="card card-flush">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('accounting.supplier.sum.currency')}</th>
                <th className="num">{t('accounting.supplier.sum.sale')}</th>
                <th className="num">{t('accounting.supplier.sum.cost')}</th>
                <th className="num">{t('accounting.supplier.sum.paid')}</th>
                <th className="num">{t('accounting.supplier.sum.balance')}</th>
                <th className="num">{t('accounting.supplier.sum.transport')}</th>
                <th className="num">{t('accounting.supplier.sum.profit')}</th>
              </tr>
            </thead>
            <tbody>
              {curs.length === 0 ? <tr><td colSpan={7} className="muted">{t('accounting.supplier.emptySummary')}</td></tr> : curs.map((c) => {
                const s = summary[c];
                return (
                  <tr key={c}>
                    <td><b>{c}</b></td>
                    <td className="num">{fmtMoney(s.sale, c)}</td>
                    <td className="num">{fmtMoney(s.cost, c)}</td>
                    <td className="num">{fmtMoney(s.paid, c)}</td>
                    <td className="num"><b>{money(s.balance, c)}</b></td>
                    <td className="num">{fmtMoney(s.transport, c)}</td>
                    <td className="num"><b>{money(s.profit, c)}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* A) Yükleme kârlılıkları */}
      <div className="card card-flush" id="yuklemeler">
        <div className="card-head"><h2 style={{ margin: 0 }}>{t('accounting.supplier.loadings.title')}</h2></div>
        <p className="muted small" style={{ padding: '0 16px' }}>{t('accounting.supplier.loadings.intro')}</p>
        {days.length === 0 ? <div className="empty">{t('accounting.supplier.loadings.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('accounting.supplier.loadings.col.day')}</th>
                  <th className="num">{t('accounting.supplier.loadings.col.m2')}</th>
                  <th>{t('accounting.supplier.sum.currency')}</th>
                  <th className="num">{t('accounting.supplier.sum.sale')}</th>
                  <th className="num">{t('accounting.supplier.sum.cost')}</th>
                  <th className="num">{t('accounting.supplier.sum.transport')}</th>
                  <th className="num">{t('accounting.supplier.loadings.col.profit')}</th>
                  <th>{t('accounting.supplier.loadings.col.transportEntries')}</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const entries = Object.entries(d.byCur);
                  const list = costsOf(d.day);
                  return entries.map(([c, v], i) => (
                    <tr key={`${d.day}-${c}`}>
                      {i === 0 && (
                        <td rowSpan={entries.length}>
                          <b>{fmtDate(d.day)}</b>
                          <div className="muted small">{t('accounting.supplier.loadings.orders', { n: d.orders })}</div>
                        </td>
                      )}
                      {i === 0 && <td className="num" rowSpan={entries.length}>{fmtNum(d.m2)} m²</td>}
                      <td>{c}</td>
                      <td className="num">{fmtMoney(v.sale, c)}</td>
                      <td className="num">{fmtMoney(v.cost, c)}</td>
                      <td className="num">{fmtMoney(v.transport, c)}</td>
                      <td className="num"><b>{money(v.profit, c)}</b></td>
                      {i === 0 && (
                        <td rowSpan={entries.length} className="small">
                          {list.map((x) => (
                            <form key={x.id} action={deleteTransportAction} className="row" style={{ gap: 6 }}>
                              <input type="hidden" name="id" value={x.id} />
                              <span>{fmtMoney(x.amount.toString(), x.currency)}{x.note ? ` · ${x.note}` : ''}</span>
                              <ConfirmButton danger message={t('accounting.supplier.deleteConfirm')}>×</ConfirmButton>
                            </form>
                          ))}
                          <details>
                            <summary style={{ cursor: 'pointer' }}>{t('accounting.supplier.loadings.addTransport')}</summary>
                            <form action={addTransportAction} className="row" style={{ marginTop: 6 }}>
                              <input type="hidden" name="shipDay" value={d.day} />
                              <input name="amount" inputMode="decimal" required placeholder={t('accounting.supplier.amount')} aria-label={t('accounting.supplier.amount')} style={{ width: 110 }} />
                              <CurSelect id={`tc-${d.day}`} />
                              <input name="note" maxLength={300} placeholder={t('accounting.supplier.note')} aria-label={t('accounting.supplier.note')} style={{ width: 160 }} />
                              <button className="btn">{t('accounting.supplier.add')}</button>
                            </form>
                          </details>
                        </td>
                      )}
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* B) Fabrika cari hesabı: ödemeler yüklemelere bağlı değil */}
      <div className="card" id="cari">
        <h2>{t('accounting.supplier.factory.title')}</h2>
        <p className="muted small">{t('accounting.supplier.factory.intro')}</p>
        <form action={addPaymentAction} className="row" style={{ marginBottom: 14 }}>
          <label htmlFor="fp-day" style={{ margin: 0 }}>{t('accounting.supplier.date')}</label>
          <input id="fp-day" name="paidOn" type="date" required defaultValue={isoDay(new Date(`${today}T12:00:00Z`))} style={{ width: 'auto' }} />
          <input name="amount" inputMode="decimal" required placeholder={t('accounting.supplier.amount')} aria-label={t('accounting.supplier.amount')} style={{ width: 130 }} />
          <CurSelect id="fp-cur" />
          <input name="note" maxLength={300} placeholder={t('accounting.supplier.note')} aria-label={t('accounting.supplier.note')} style={{ flex: 1, minWidth: 160 }} />
          <button className="btn btn-primary">{t('accounting.supplier.factory.add')}</button>
        </form>
        {payments.length === 0 ? <div className="empty">{t('accounting.supplier.factory.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('accounting.supplier.date')}</th><th className="num">{t('accounting.supplier.amount')}</th><th>{t('accounting.supplier.note')}</th><th /></tr></thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.paidOn)}</td>
                    <td className="num">{fmtMoney(p.amount.toString(), p.currency)}</td>
                    <td>{p.note ?? ''}</td>
                    <td className="actions">
                      <form action={deletePaymentAction}>
                        <input type="hidden" name="id" value={p.id} />
                        <ConfirmButton danger message={t('accounting.supplier.deleteConfirm')}>{t('accounting.supplier.delete')}</ConfirmButton>
                      </form>
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
