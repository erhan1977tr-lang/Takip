import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { getEnv } from '@/lib/env';
import { fmtDate, fmtDateTime, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { supplierAccount, supplierAccounts } from '@/server/suppliers/service.js';
import { listTransports } from '@/server/suppliers/costs.js';
import { actorOf } from '@/lib/actor';
import { SUPPLIER_CURRENCIES } from '@/server/suppliers/rules.js';
import { localDay } from '@/server/profile/dates.js';
import { SupplierStatusBadge } from '@/components/SupplierStatus';
import { addOpeningAction, addSupplierPaymentAction, voidOpeningAction, voidSupplierPaymentAction } from './actions';

export const dynamic = 'force-dynamic';

type Balance = { opening: string; debt: string; paid: string; balance: string; orders: number; missingPrice: number };
const OK: Record<string, MsgKey> = {
  paid: 'supplier.accounts.ok.paid', duplicate: 'supplier.accounts.ok.duplicate', voided: 'supplier.accounts.ok.voided',
  opening: 'supplier.accounts.ok.opening', openingVoided: 'supplier.accounts.ok.openingVoided',
};

/**
 * Tedarikçi Hesapları (Paket 6, karar 182): para birimi başına borç (onaylanmış, iptal edilmemiş siparişler), ödeme ve
 * kalan. Para birimleri toplanmaz; fiyatı eksik sipariş ayrıca gösterilir (tutar uydurulmaz). Cam fabrikası hesabından
 * (Muhasebe → Cam Fabrika Hesap Durumu) ayrıdır. Yalnızca SUPPLIER_MANAGE (yönetici).
 */
export default async function SupplierAccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const { t, m } = await getT();
  const sp = await searchParams;
  const okText = sp.ok && Object.hasOwn(OK, sp.ok) ? t(OK[sp.ok]) : null;
  const errText = sp.error ? t(Object.hasOwn(m.supplier.errors, sp.error) ? (`supplier.errors.${sp.error}` as MsgKey) : 'supplier.errors.OTHER', { row: '—', name: '' }) : null;
  const signed = (v: string) => <span className={v.startsWith('-') ? 'text-danger' : undefined}>{fmtNum(v)}</span>;

  const BalanceRows = ({ balances }: { balances: Record<string, Balance> }) => {
    const curs = Object.keys(balances);
    if (curs.length === 0) return <span className="muted">{t('supplier.accounts.none')}</span>;
    return (
      <>
        {curs.map((c) => (
          <div key={c} data-balance={c}>
            <b>{c}</b>{balances[c].opening !== '0.00' && <> · {t('supplier.accounts.col.opening')} {signed(balances[c].opening)}</>} · {t('supplier.accounts.col.debt')} {fmtNum(balances[c].debt)} · {t('supplier.accounts.col.paid')} {fmtNum(balances[c].paid)} · {t('supplier.accounts.col.balance')} <b>{signed(balances[c].balance)}</b>
          </div>
        ))}
      </>
    );
  };

  // ---------- tek tedarikçinin hesabı ----------
  if (sp.t) {
    const acc = await supplierAccount(db, sp.t);
    if (!acc) return <div className="alert alert-error">{t('supplier.errors.NOT_FOUND')}</div>;
    const { supplier, orders, payments, openings, balances } = acc;
    const users = await db.user.findMany({ where: { id: { in: [...new Set([...payments, ...openings].flatMap((p) => (p.createdById ? [p.createdById] : [])))] } }, select: { id: true, name: true, email: true } });
    const who = new Map<string, string>(users.map((u) => [u.id, u.name || u.email]));
    const today = localDay(new Date(), getEnv().APP_TIMEZONE);
    const missing = Object.values(balances as Record<string, Balance>).reduce((n, b) => n + b.missingPrice, 0);
    return (
      <>
        <div className="page-head">
          <p><Link href="/admin/muhasebe/tedarikciler">{t('supplier.accounts.back')}</Link></p>
          <h1>{supplier.name} {!supplier.isActive && <Badge tone="muted">{t('supplier.settings.inactive')}</Badge>}</h1>
          <p className="muted">{t('supplier.accounts.intro')}</p>
        </div>
        {okText && <div className="alert alert-ok">{okText}</div>}
        {errText && <div className="alert alert-error" role="alert">{errText}</div>}

        <div className="card" id="bakiye">
          <div className="table-wrap">
            <table className="acc-table">
              <thead>
                <tr>
                  <th>{t('supplier.accounts.col.currency')}</th><th className="num">{t('supplier.accounts.col.opening')}</th><th className="num">{t('supplier.accounts.col.debt')}</th><th className="num">{t('supplier.accounts.col.paid')}</th>
                  <th className="num">{t('supplier.accounts.col.balance')}</th><th className="num">{t('supplier.accounts.col.orders')}</th><th className="num">{t('supplier.accounts.col.missing')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(balances).length === 0 && <tr><td colSpan={7} className="empty">{t('supplier.accounts.none')}</td></tr>}
                {Object.entries(balances as Record<string, Balance>).map(([c, b]) => (
                  <tr key={c} data-balance={c}>
                    <td><b>{c}</b></td><td className="num" data-opening>{signed(b.opening)}</td><td className="num">{fmtNum(b.debt)}</td><td className="num">{fmtNum(b.paid)}</td>
                    <td className="num"><b>{signed(b.balance)}</b></td><td className="num">{b.orders}</td>
                    <td className="num">{b.missingPrice ? <Badge tone="warn">{b.missingPrice}</Badge> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {missing > 0 && <div className="alert alert-warn" style={{ marginTop: 8 }} data-missing-price>{t('supplier.accounts.missingPrice', { n: missing })}</div>}
        </div>

        <div className="card card-flush" id="siparisler">
          <div className="card-head"><h2>{t('supplier.accounts.orders.title')} <span className="badge">{orders.length}</span></h2></div>
          {orders.length === 0 ? <div className="empty">{t('supplier.accounts.orders.empty')}</div> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('supplier.accounts.orders.col.no')}</th><th>{t('supplier.accounts.orders.col.date')}</th><th>{t('supplier.accounts.orders.col.status')}</th>
                    <th className="num">{t('supplier.accounts.orders.col.revision')}</th><th className="num">{t('supplier.accounts.orders.col.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} data-account-order={o.orderNo} style={o.counts ? undefined : { opacity: 0.6 }}>
                      <td className="mono"><Link href={`/siparisler/tedarik/${o.id}`}>{o.orderNo}</Link></td>
                      <td>{o.orderDate ? fmtDate(o.orderDate) : '—'}</td>
                      <td>
                        <SupplierStatusBadge status={o.status} />{!o.counts && <span className="muted small"> · {t('supplier.accounts.orders.notCounted')}</span>}
                        {/* Kısmen teslim alınıp kalanı iptal edilen sipariş (karar 288 — O6): borç = teslim alınan mal */}
                        {o.partialCancel && <span className="muted small" data-partial-cancel> · {t('supplier.accounts.orders.partialCancel')}</span>}
                      </td>
                      <td className="num">{o.revision ?? '—'}</td>
                      <td className="num nowrap">
                        {o.total != null ? `${fmtNum(o.total)} ${o.currency}` : '—'}
                        {o.missingPrice && <div><Badge tone="warn">{t('supplier.orders.missingPrice')}</Badge></div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card" id="acilis">
          <h2>{t('supplier.accounts.opening.title')}</h2>
          <p className="muted small">{t('supplier.accounts.opening.intro')}</p>
          {openings.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('supplier.accounts.opening.col.date')}</th><th className="num">{t('supplier.accounts.opening.col.amount')}</th><th>{t('supplier.accounts.payments.col.currency')}</th>
                    <th>{t('supplier.accounts.payments.col.note')}</th><th>{t('supplier.accounts.payments.col.who')}</th><th>{t('supplier.accounts.payments.col.status')}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {openings.map((x) => (
                    <tr key={x.id} data-opening-row={x.amount.toString()} style={x.voidedAt ? { opacity: 0.6 } : undefined}>
                      <td>{fmtDate(x.asOf)}</td>
                      <td className="num">{x.voidedAt ? <s>{fmtNum(x.amount.toString())}</s> : signed(x.amount.toString())}</td>
                      <td>{x.currency}</td>
                      <td>{x.note ?? ''}{x.correctsId && <div className="muted small">{t('supplier.accounts.opening.corrects')}</div>}</td>
                      <td className="small">{x.createdById ? who.get(x.createdById) ?? '—' : '—'}<div className="muted">{fmtDateTime(x.createdAt)}</div></td>
                      <td>{x.voidedAt ? <span className="small">{t('supplier.accounts.payments.voided', { reason: x.voidReason ?? '' })}</span> : <Badge tone="ok">{t('supplier.accounts.payments.active')}</Badge>}</td>
                      <td className="actions">
                        {!x.voidedAt && (
                          <form action={voidOpeningAction} className="row">
                            <input type="hidden" name="supplierId" value={supplier.id} />
                            <input type="hidden" name="openingId" value={x.id} />
                            <input name="reason" required maxLength={500} placeholder={t('supplier.accounts.void.reason')} aria-label={t('supplier.accounts.void.reason')} />
                            <ConfirmButton danger message={t('supplier.accounts.opening.voidConfirm')}>{t('supplier.accounts.void.button')}</ConfirmButton>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form action={addOpeningAction} style={{ marginTop: 10 }}>
            <input type="hidden" name="supplierId" value={supplier.id} />
            <input type="hidden" name="requestKey" value={randomUUID()} />
            <div className="grid-3">
              <div><label htmlFor="op-date">{t('supplier.accounts.opening.date')}</label><input id="op-date" name="asOf" type="date" required max={today} defaultValue={today} /></div>
              <div>
                <label htmlFor="op-dir">{t('supplier.accounts.opening.direction')}</label>
                <select id="op-dir" name="direction" defaultValue="DEBT">
                  <option value="DEBT">{t('supplier.accounts.opening.debt')}</option>
                  <option value="CREDIT">{t('supplier.accounts.opening.credit')}</option>
                </select>
              </div>
              <div><label htmlFor="op-amount">{t('supplier.accounts.opening.amount')}</label><input id="op-amount" name="amount" required inputMode="decimal" maxLength={16} /></div>
              <div>
                <label htmlFor="op-cur">{t('supplier.accounts.pay.currency')}</label>
                <select id="op-cur" name="currency" defaultValue={supplier.currency}>{SUPPLIER_CURRENCIES.map((c: string) => <option key={c} value={c}>{c}</option>)}</select>
              </div>
              <div>
                <label htmlFor="op-corrects">{t('supplier.accounts.opening.correctsLabel')}</label>
                <select id="op-corrects" name="correctsId" defaultValue="">
                  <option value="">—</option>
                  {openings.filter((x) => !x.voidedAt).map((x) => <option key={x.id} value={x.id}>{fmtDate(x.asOf)} · {fmtNum(x.amount.toString())} {x.currency}</option>)}
                </select>
              </div>
              <div><label htmlFor="op-note">{t('supplier.accounts.pay.note')}</label><input id="op-note" name="note" maxLength={500} /></div>
            </div>
            <div className="hint">{t('supplier.accounts.opening.hint')}</div>
            <div className="row" style={{ marginTop: 10 }}><button className="btn btn-primary">{t('supplier.accounts.opening.submit')}</button></div>
          </form>
        </div>

        <form action={addSupplierPaymentAction} className="card" id="odeme">
          <h2>{t('supplier.accounts.pay.title')}</h2>
          <input type="hidden" name="supplierId" value={supplier.id} />
          {/* Tek seferlik form anahtarı: aynı form iki kez gönderilse de ödeme bir kez yazılır */}
          <input type="hidden" name="requestKey" value={randomUUID()} />
          <div className="grid-3">
            <div><label htmlFor="pay-date">{t('supplier.accounts.pay.date')}</label><input id="pay-date" name="paidOn" type="date" required max={today} defaultValue={today} /></div>
            <div><label htmlFor="pay-amount">{t('supplier.accounts.pay.amount')}</label><input id="pay-amount" name="amount" required inputMode="decimal" maxLength={16} /></div>
            <div>
              <label htmlFor="pay-cur">{t('supplier.accounts.pay.currency')}</label>
              <select id="pay-cur" name="currency" defaultValue={supplier.currency}>{SUPPLIER_CURRENCIES.map((c: string) => <option key={c} value={c}>{c}</option>)}</select>
            </div>
          </div>
          <label htmlFor="pay-note">{t('supplier.accounts.pay.note')}</label>
          <input id="pay-note" name="note" maxLength={500} />
          <div className="hint">{t('supplier.accounts.pay.hint')}</div>
          <div className="row" style={{ marginTop: 10 }}><button className="btn btn-primary">{t('supplier.accounts.pay.submit')}</button></div>
        </form>

        <div className="card card-flush" id="odemeler">
          <div className="card-head"><h2>{t('supplier.accounts.payments.title')} <span className="badge">{payments.length}</span></h2></div>
          {payments.length === 0 ? <div className="empty">{t('supplier.accounts.payments.empty')}</div> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('supplier.accounts.payments.col.date')}</th><th className="num">{t('supplier.accounts.payments.col.amount')}</th>
                    <th>{t('supplier.accounts.payments.col.currency')}</th><th>{t('supplier.accounts.payments.col.note')}</th>
                    <th>{t('supplier.accounts.payments.col.who')}</th><th>{t('supplier.accounts.payments.col.status')}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} data-payment={p.amount.toString()} style={p.voidedAt ? { opacity: 0.6 } : undefined}>
                      <td>{fmtDate(p.paidOn)}</td>
                      <td className="num">{p.voidedAt ? <s>{fmtNum(p.amount.toString())}</s> : fmtNum(p.amount.toString())}</td>
                      <td>{p.currency}</td>
                      <td>{p.note ?? ''}</td>
                      <td className="small">{p.createdById ? who.get(p.createdById) ?? '—' : '—'}<div className="muted">{fmtDateTime(p.createdAt)}</div></td>
                      <td>{p.voidedAt ? <span className="small">{t('supplier.accounts.payments.voided', { reason: p.voidReason ?? '' })}</span> : <Badge tone="ok">{t('supplier.accounts.payments.active')}</Badge>}</td>
                      <td className="actions">
                        {!p.voidedAt && (
                          <form action={voidSupplierPaymentAction} className="row">
                            <input type="hidden" name="supplierId" value={supplier.id} />
                            <input type="hidden" name="paymentId" value={p.id} />
                            <input name="reason" required maxLength={500} placeholder={t('supplier.accounts.void.reason')} aria-label={t('supplier.accounts.void.reason')} />
                            <ConfirmButton danger message={t('supplier.accounts.void.confirm')}>{t('supplier.accounts.void.button')}</ConfirmButton>
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

  // ---------- özet ----------
  const accounts = await supplierAccounts(db);
  // Taşıyıcı bakiyeleri (salt okunur): nakliye kayıtları tedarikçi siparişinin sayfasından girilir (3.97.6)
  const tr = await listTransports(db, await actorOf(admin));
  const carriers = tr.ok ? tr.carriers : [];
  return (
    <>
      <div className="page-head">
        <h1>{t('supplier.accounts.title')}</h1>
        <p className="muted">{t('supplier.accounts.intro')}</p>
      </div>
      {errText && <div className="alert alert-error" role="alert">{errText}</div>}
      <div className="card card-flush">
        {accounts.length === 0 ? <div className="empty">{t('supplier.accounts.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('supplier.accounts.col.supplier')}</th><th>{t('supplier.accounts.col.balance')}</th><th /></tr></thead>
              <tbody>
                {accounts.map(({ supplier, balances }) => (
                  <tr key={supplier.id} data-account={supplier.name} style={supplier.isActive ? undefined : { opacity: 0.6 }}>
                    <td><b>{supplier.name}</b> <span className="muted small">{supplier.currency}</span></td>
                    <td><BalanceRows balances={balances as Record<string, Balance>} /></td>
                    <td className="actions"><Link className="btn" href={`/admin/muhasebe/tedarikciler?t=${supplier.id}`}>{t('supplier.accounts.open')}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card card-flush" id="tasiyicilar">
        <div className="card-head"><h2>{t('supplier.transport.carriers')}</h2></div>
        <p className="muted small" style={{ padding: '0 16px' }}>{t('supplier.transport.carriersIntro')}</p>
        {carriers.length === 0 ? <div className="empty">{t('supplier.transport.none')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('supplier.transport.col.carrier')}</th><th>{t('supplier.accounts.col.currency')}</th><th className="num">{t('supplier.transport.col.total')}</th><th className="num">{t('supplier.transport.col.paid')}</th><th className="num">{t('supplier.transport.col.open')}</th></tr></thead>
              <tbody>
                {carriers.map((c) => (
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
    </>
  );
}
