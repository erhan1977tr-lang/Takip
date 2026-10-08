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
import { SUPPLIER_CURRENCIES } from '@/server/suppliers/rules.js';
import { localDay } from '@/server/profile/dates.js';
import { SupplierStatusBadge } from '@/components/SupplierStatus';
import { addSupplierPaymentAction, voidSupplierPaymentAction } from './actions';

export const dynamic = 'force-dynamic';

type Balance = { debt: string; paid: string; balance: string; orders: number; missingPrice: number };
const OK: Record<string, MsgKey> = { paid: 'supplier.accounts.ok.paid', duplicate: 'supplier.accounts.ok.duplicate', voided: 'supplier.accounts.ok.voided' };

/**
 * Tedarikçi Hesapları (Paket 6, karar 182): para birimi başına borç (onaylanmış, iptal edilmemiş siparişler), ödeme ve
 * kalan. Para birimleri toplanmaz; fiyatı eksik sipariş ayrıca gösterilir (tutar uydurulmaz). Cam fabrikası hesabından
 * (Muhasebe → Tedarikçi Hesap Durumu) ayrıdır. Yalnızca SUPPLIER_MANAGE (yönetici).
 */
export default async function SupplierAccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('SUPPLIER_MANAGE');
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
            <b>{c}</b> · {t('supplier.accounts.col.debt')} {fmtNum(balances[c].debt)} · {t('supplier.accounts.col.paid')} {fmtNum(balances[c].paid)} · {t('supplier.accounts.col.balance')} <b>{signed(balances[c].balance)}</b>
          </div>
        ))}
      </>
    );
  };

  // ---------- tek tedarikçinin hesabı ----------
  if (sp.t) {
    const acc = await supplierAccount(db, sp.t);
    if (!acc) return <div className="alert alert-error">{t('supplier.errors.NOT_FOUND')}</div>;
    const { supplier, orders, payments, balances } = acc;
    const users = await db.user.findMany({ where: { id: { in: [...new Set(payments.flatMap((p) => (p.createdById ? [p.createdById] : [])))] } }, select: { id: true, name: true, email: true } });
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
                  <th>{t('supplier.accounts.col.currency')}</th><th className="num">{t('supplier.accounts.col.debt')}</th><th className="num">{t('supplier.accounts.col.paid')}</th>
                  <th className="num">{t('supplier.accounts.col.balance')}</th><th className="num">{t('supplier.accounts.col.orders')}</th><th className="num">{t('supplier.accounts.col.missing')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(balances).length === 0 && <tr><td colSpan={6} className="empty">{t('supplier.accounts.none')}</td></tr>}
                {Object.entries(balances as Record<string, Balance>).map(([c, b]) => (
                  <tr key={c} data-balance={c}>
                    <td><b>{c}</b></td><td className="num">{fmtNum(b.debt)}</td><td className="num">{fmtNum(b.paid)}</td>
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
                      <td><SupplierStatusBadge status={o.status} />{!o.counts && <span className="muted small"> · {t('supplier.accounts.orders.notCounted')}</span>}</td>
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
    </>
  );
}
