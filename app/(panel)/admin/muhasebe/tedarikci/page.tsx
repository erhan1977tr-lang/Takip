import Link from 'next/link';
import type { FactoryPayment, LoadingCost } from '@prisma/client';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDate, fmtMoney, fmtNum, isoDay } from '@/lib/format';
import { getEnv } from '@/lib/env';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { CURRENCIES, supplierData } from '@/server/accounting/supplier.js';
import { localDay } from '@/server/profile/dates.js';
import { addPaymentAction, addTransportAction, correctCostAction, deletePaymentAction, deleteTransportAction } from '../actions';

export const dynamic = 'force-dynamic';

type Amounts = { sale: number; cost: number; transport: number; profit: number };
type OrderRef = { orderId: string; orderNo: string };
// confirmed: gün "Yükleme yapıldı" (eski adı "Eksiksiz Yüklendi") olarak onaylı (tutarlar onay kopyasından) · outside: onaylı güne planlı ama onayda olmayan siparişler
// accounting: kesilmiş faturası düzeltilmiş yüklemeyle uyuşmayan siparişler (karar 105; kârlılık fiili yüklemeyi izler)
type Day = { day: string; orders: number; m2: number; byCur: Record<string, Amounts>; noCost: OrderRef[]; confirmed: boolean; outside: OrderRef[]; accounting: (OrderRef & { code: string; ref: string | null })[] };
type MissingLine = { lineId: string; description: string; kind: string; unit: string; adet: number; offerPrice: number };
type Missing = { orderId: string; orderNo: string; day: string; currency: string; lines: MissingLine[] };
type Data = { days: Day[]; costs: LoadingCost[]; payments: FactoryPayment[]; summary: Record<string, Amounts & { paid: number; balance: number }>; missing: Missing[] };

const OK: Record<string, MsgKey> = {
  transport: 'accounting.supplier.ok.transport', payment: 'accounting.supplier.ok.payment', deleted: 'accounting.supplier.ok.deleted', cost: 'accounting.supplier.cost.ok',
};
const ERR: Record<string, MsgKey> = {
  transport: 'accounting.supplier.errors.transport', payment: 'accounting.supplier.errors.payment',
  costBAD_COST: 'accounting.supplier.cost.errors.BAD_COST', costCOST_EXISTS: 'accounting.supplier.cost.errors.COST_EXISTS',
  costCONFIRMED: 'accounting.supplier.cost.errors.CONFIRMED', cost: 'accounting.supplier.cost.errors.OTHER',
};

/** Tedarikçi hesap durumu: yükleme kârlılığı (otomatik) ve fabrika cari hesabı (ödemeler yüklemelerden bağımsız). */
export default async function SupplierPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('ACCOUNTING_MANAGE');
  const { t } = await getT();
  const sp = await searchParams;
  const today = localDay(new Date(), getEnv().APP_TIMEZONE);
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const { days, costs, payments, summary, missing } = (await supplierData(db, end)) as Data;
  const curs = Object.keys(summary).sort();
  // Tablolarda para birimi kendi sütununda: tutar yalın yazılır; eksi tutar kırmızı
  const signed = (v: number) => <span className={v < 0 ? 'text-danger' : undefined}>{fmtNum(v)}</span>;
  const costsOf = (day: string) => costs.filter((c) => c.shipDay.toISOString().slice(0, 10) === day);
  const noCost = days.flatMap((d) => d.noCost);
  const CurSelect = ({ id }: { id: string }) => (
    <select id={id} name="currency" defaultValue="EUR" aria-label={t('accounting.supplier.currency')}>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
  );

  return (
    <>
      <div className="page-head">
        <h1>{t('accounting.supplier.title')}</h1>
        <p className="muted">{t('accounting.supplier.intro')}</p>
      </div>
      {sp.ok && OK[sp.ok] && <div className="alert alert-ok">{t(OK[sp.ok])}</div>}
      {sp.error && ERR[sp.error] && <div className="alert alert-error">{t(ERR[sp.error])}</div>}
      {/* Maliyeti kayıtlı olmayan satır sessizce 0 sayılmaz: sipariş burada gösterilir */}
      {noCost.length > 0 && (
        <div className="alert alert-warn" id="maliyet-eksik">
          <b>{t('accounting.supplier.noCost')}</b>{' '}
          {noCost.map((o, i) => <span key={o.orderId}>{i > 0 && ', '}<Link href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link></span>)}
          <div className="small">{t('accounting.supplier.noCostHelp')}</div>
        </div>
      )}
      {/* Eksik maliyetin girilmesi (karar 93): yalnızca maliyeti kayıtlı olmayan satır, yalnızca maliyet — müşteri fiyatı değişmez.
          Onaylı yüklemeye girmiş siparişler burada listelenmez (onay kopyası yeniden yazılmaz). */}
      {missing.length > 0 && (
        <div className="card card-flush" id="maliyet-gir">
          <div className="card-head"><h2>{t('accounting.supplier.cost.title')} <span className="badge">{missing.reduce((n, o) => n + o.lines.length, 0)}</span></h2></div>
          <p className="card-sub">{t('accounting.supplier.cost.intro')}</p>
          <div className="table-wrap">
            <table className="acc-table">
              <thead>
                <tr>
                  <th>{t('accounting.supplier.cost.col.order')}</th>
                  <th>{t('accounting.supplier.cost.col.line')}</th>
                  <th className="num">{t('accounting.supplier.cost.col.qty')}</th>
                  <th className="num">{t('accounting.supplier.cost.col.offerPrice')}</th>
                  <th>{t('accounting.supplier.cost.col.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {missing.map((o) => o.lines.map((l, i) => (
                  <tr key={l.lineId} className={i === 0 ? 'grp-first' : undefined}>
                    <td>
                      {i === 0 && <Link className="order-no" href={`/siparisler/${o.orderId}`}>{o.orderNo}</Link>}
                      {i === 0 && <span className="cell-note">{fmtDate(o.day)}</span>}
                    </td>
                    <td>{l.description || t(`accounting.supplier.cost.kind.${l.kind === 'CNC' ? 'CNC' : l.kind === 'DELIK' ? 'DELIK' : 'OTHER'}` as MsgKey)}</td>
                    <td className="num">{l.adet} {l.unit === 'm2' ? t('accounting.supplier.cost.unitGlass') : t('accounting.supplier.cost.unitPiece')}</td>
                    <td className="num">{fmtMoney(l.offerPrice, o.currency)}</td>
                    <td>
                      <form action={correctCostAction} className="acc-form">
                        <input type="hidden" name="lineId" value={l.lineId} />
                        <input className="c-amount" name="cost" inputMode="decimal" required placeholder={t('accounting.supplier.cost.placeholder', { cur: o.currency })} aria-label={t('accounting.supplier.cost.label', { order: o.orderNo, line: l.description })} />
                        <ConfirmButton primary message={t('accounting.supplier.cost.confirm')}>{t('accounting.supplier.cost.save')}</ConfirmButton>
                      </form>
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Üst özet: her para birimi ayrı satır */}
      <div className="card card-flush">
        <div className="card-head"><h2>{t('accounting.supplier.summaryTitle')}</h2></div>
        {curs.length === 0 ? <div className="empty">{t('accounting.supplier.emptySummary')}</div> : (
          <div className="table-wrap">
            <table className="acc-table">
              <thead>
                <tr>
                  <th>{t('accounting.supplier.sum.currency')}</th>
                  <th className="num">{t('accounting.supplier.sum.sale')}</th>
                  <th className="num">{t('accounting.supplier.sum.cost')}</th>
                  <th className="num">{t('accounting.supplier.sum.transport')}</th>
                  <th className="num">{t('accounting.supplier.sum.profit')}</th>
                  <th className="num">{t('accounting.supplier.sum.paid')}</th>
                  <th className="num">{t('accounting.supplier.sum.balance')}</th>
                </tr>
              </thead>
              <tbody>
                {curs.map((c) => {
                  const s = summary[c];
                  return (
                    <tr key={c}>
                      <td><b>{c}</b></td>
                      <td className="num">{fmtNum(s.sale)}</td>
                      <td className="num">{fmtNum(s.cost)}</td>
                      <td className="num">{fmtNum(s.transport)}</td>
                      <td className="num"><b>{signed(s.profit)}</b></td>
                      <td className="num">{fmtNum(s.paid)}</td>
                      <td className="num"><b>{signed(s.balance)}</b></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="card-note">{t('accounting.supplier.sourceNote')}</p>
      </div>

      {/* A) Yükleme kârlılıkları */}
      <div className="card card-flush" id="yuklemeler">
        <div className="card-head"><h2>{t('accounting.supplier.loadings.title')} <span className="badge">{days.length}</span></h2></div>
        <p className="card-sub">{t('accounting.supplier.loadings.intro')}</p>
        {days.length === 0 ? <div className="empty">{t('accounting.supplier.loadings.empty')}</div> : (
          <div className="table-wrap">
            <table className="acc-table">
              <thead>
                <tr>
                  <th>{t('accounting.supplier.loadings.col.day')}</th>
                  <th className="num">{t('accounting.supplier.loadings.col.m2')}</th>
                  <th>{t('accounting.supplier.sum.currency')}</th>
                  <th className="num">{t('accounting.supplier.loadings.col.sale')}</th>
                  <th className="num">{t('accounting.supplier.loadings.col.cost')}</th>
                  <th className="num">{t('accounting.supplier.loadings.col.transport')}</th>
                  <th className="num">{t('accounting.supplier.loadings.col.profit')}</th>
                  <th>{t('accounting.supplier.loadings.col.transportEntries')}</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const entries = Object.entries(d.byCur);
                  const list = costsOf(d.day);
                  return entries.map(([c, v], i) => (
                    <tr key={`${d.day}-${c}`} className={i === 0 ? 'grp-first' : 'grp-next'}>
                      {i === 0 && (
                        <td rowSpan={entries.length}>
                          <Link className="order-no" href={`/yuklemeler?gun=${d.day}`}>{fmtDate(d.day)}</Link>
                          <span className="cell-note">{t('accounting.supplier.loadings.orders', { n: d.orders })}</span>
                          <span className="cell-badges">
                            {d.confirmed ? <Badge tone="ok">{t('accounting.supplier.loadings.confirmed')}</Badge> : <Badge tone="muted">{t('accounting.supplier.loadings.planned')}</Badge>}
                            {d.noCost.length > 0 && <Badge tone="warn">{t('accounting.supplier.noCostBadge')}</Badge>}
                            {d.accounting.length > 0 && <Badge tone="danger">{t('accounting.impact.badge')}</Badge>}
                          </span>
                          {d.accounting.length > 0 && <span className="cell-note">{t('accounting.impact.dayNote', { list: d.accounting.map((o) => `${o.orderNo}${o.ref ? ` (${o.ref})` : ''}`).join(', ') })}</span>}
                          {d.outside.length > 0 && <span className="cell-note">{t('accounting.supplier.loadings.outside', { list: d.outside.map((o) => o.orderNo).join(', ') })}</span>}
                        </td>
                      )}
                      {i === 0 && <td className="num" rowSpan={entries.length}>{fmtNum(d.m2)} m²</td>}
                      <td>{c}</td>
                      <td className="num">{fmtNum(v.sale)}</td>
                      <td className="num">{fmtNum(v.cost)}</td>
                      <td className="num">{fmtNum(v.transport)}</td>
                      <td className="num"><b>{signed(v.profit)}</b></td>
                      {i === 0 && (
                        <td rowSpan={entries.length} className="acc-entries">
                          {list.map((x) => (
                            <form key={x.id} action={deleteTransportAction} className="acc-entry">
                              <input type="hidden" name="id" value={x.id} />
                              <span>{fmtMoney(x.amount.toString(), x.currency)}{x.note ? ` · ${x.note}` : ''}</span>
                              <ConfirmButton danger message={t('accounting.supplier.deleteConfirm')}>×</ConfirmButton>
                            </form>
                          ))}
                          <details>
                            <summary>{t('accounting.supplier.loadings.addTransport')}</summary>
                            <form action={addTransportAction} className="acc-form">
                              <input type="hidden" name="shipDay" value={d.day} />
                              <input className="c-amount" name="amount" inputMode="decimal" required placeholder={t('accounting.supplier.amount')} aria-label={t('accounting.supplier.amount')} />
                              <CurSelect id={`tc-${d.day}`} />
                              <input className="c-note" name="note" maxLength={300} placeholder={t('accounting.supplier.note')} aria-label={t('accounting.supplier.note')} />
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
      <div className="section-head" id="cari">
        <h2>{t('accounting.supplier.factory.title')}</h2>
      </div>
      <p className="muted section-sub">{t('accounting.supplier.factory.intro')}</p>
      {curs.length > 0 && (
        <div className="stats stats-money">
          {curs.map((c) => {
            const s = summary[c];
            return (
              <div className={`stat ${s.balance > 0 ? 'stat-warn' : 'stat-ok'}`} key={c}>
                <div className="k">{t('accounting.supplier.factory.balance', { cur: c })}</div>
                <div className={`v${s.balance < 0 ? ' text-danger' : ''}`}>{fmtNum(s.balance)}</div>
                <div className="muted small">{t('accounting.supplier.factory.balanceLine', { cost: fmtNum(s.cost), paid: fmtNum(s.paid) })}</div>
              </div>
            );
          })}
        </div>
      )}
      <div className="card">
        <h3 className="sub-title acc-form-title">{t('accounting.supplier.factory.addTitle')}</h3>
        <form action={addPaymentAction} className="acc-form">
          <label htmlFor="fp-day">{t('accounting.supplier.date')}</label>
          <input id="fp-day" name="paidOn" type="date" required defaultValue={isoDay(new Date(`${today}T12:00:00Z`))} />
          <input className="c-amount" name="amount" inputMode="decimal" required placeholder={t('accounting.supplier.amount')} aria-label={t('accounting.supplier.amount')} />
          <CurSelect id="fp-cur" />
          <input className="c-note" name="note" maxLength={300} placeholder={t('accounting.supplier.note')} aria-label={t('accounting.supplier.note')} />
          <button className="btn btn-primary">{t('accounting.supplier.factory.add')}</button>
        </form>
      </div>
      <div className="card card-flush">
        <div className="card-head"><h2>{t('accounting.supplier.factory.payments')} <span className="badge">{payments.length}</span></h2></div>
        {payments.length === 0 ? <div className="empty">{t('accounting.supplier.factory.empty')}</div> : (
          <div className="table-wrap">
            <table className="acc-table">
              <thead>
                <tr>
                  <th>{t('accounting.supplier.date')}</th>
                  <th className="num">{t('accounting.supplier.amount')}</th>
                  <th>{t('accounting.supplier.sum.currency')}</th>
                  <th>{t('accounting.supplier.note')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="nowrap">{fmtDate(p.paidOn)}</td>
                    <td className="num"><b>{fmtNum(p.amount.toString())}</b></td>
                    <td>{p.currency}</td>
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
