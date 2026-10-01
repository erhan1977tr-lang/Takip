import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { backfillDocuments, listDocuments, paymentStatus, remaining } from '@/server/accounting/receivables.js';
import { refreshFgoAction } from './actions';

type Doc = Prisma.FgoDocumentGetPayload<{ include: { order: { select: { id: true; orderNo: true; status: true; customer: { select: { name: true } } } } } }>;

const TONE = { UNKNOWN: 'muted', UNPAID: 'danger', PARTIAL: 'warn', PAID: 'ok' } as const;

/** Profil ve Cam Tahsilat ortak ekranı: FGO belgeleri ve FGO'dan okunan ödeme durumu (yalnızca yönetici). */
export async function ReceivablesView({ type, sp }: { type: 'PROFILE_ORDER' | 'GLASS_ORDER'; sp: Record<string, string | undefined> }) {
  const { t } = await getT();
  if (type === 'PROFILE_ORDER') await backfillDocuments(db);
  const docs: Doc[] = await listDocuments(db, type);
  const key = type === 'PROFILE_ORDER' ? 'profile' : 'glass';
  // Para birimi başına özet (para birimleri toplanmaz)
  const sums: Record<string, { total: number; paid: number; rest: number }> = {};
  for (const d of docs) {
    if (d.total == null) continue;
    const s = (sums[d.currency] ??= { total: 0, paid: 0, rest: 0 });
    s.total += Number(d.total);
    s.paid += Number(d.paid ?? 0);
    s.rest += remaining(d.total, d.paid) ?? 0;
  }
  return (
    <>
      <div className="page-head row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>{t(`accounting.${key}.title` as MsgKey)}</h1>
          <p className="muted">{t(`accounting.${key}.intro` as MsgKey)}</p>
        </div>
        <form action={refreshFgoAction}>
          <input type="hidden" name="type" value={type} />
          <button className="btn btn-primary" disabled={docs.length === 0}>{t('accounting.receivables.refresh')}</button>
        </form>
      </div>
      {sp.ok === 'refreshed' && <div className="alert alert-ok">{t('accounting.receivables.refreshed', { n: sp.n ?? '0', f: sp.f ?? '0' })}</div>}
      {sp.error && <div className="alert alert-error">{t(`accounting.receivables.errors.${sp.error === 'NO_KEY' ? 'NO_KEY' : 'FGO_DISABLED'}` as MsgKey)}</div>}
      {Object.keys(sums).length > 0 && (
        <div className="stats">
          {Object.entries(sums).map(([cur, s]) => (
            <div className="stat" key={cur}>
              <div className="k">{t('accounting.receivables.restTotal', { cur })}</div>
              <div className="v">{fmtMoney(s.rest, cur)}</div>
              <div className="muted small">{t('accounting.receivables.sumLine', { total: fmtMoney(s.total, cur), paid: fmtMoney(s.paid, cur) })}</div>
            </div>
          ))}
        </div>
      )}
      <div className="card card-flush">
        {docs.length === 0 ? <div className="empty">{t(`accounting.${key}.empty` as MsgKey)}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('accounting.receivables.col.order')}</th>
                  <th>{t('accounting.receivables.col.customer')}</th>
                  <th>{t('accounting.receivables.col.doc')}</th>
                  <th>{t('accounting.receivables.col.kind')}</th>
                  <th>{t('accounting.receivables.col.date')}</th>
                  <th className="num">{t('accounting.receivables.col.total')}</th>
                  <th className="num">{t('accounting.receivables.col.paid')}</th>
                  <th className="num">{t('accounting.receivables.col.rest')}</th>
                  <th>{t('accounting.receivables.col.status')}</th>
                  <th>{t('accounting.receivables.col.checked')}</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => {
                  const st = paymentStatus(d.total, d.paid);
                  const rest = remaining(d.total, d.paid);
                  return (
                    <tr key={d.id}>
                      <td><Link className="order-no" href={`/siparisler/${d.order.id}`}>{d.order.orderNo}</Link></td>
                      <td>{d.order.customer.name}</td>
                      <td className="mono">{d.link ? <a href={d.link} target="_blank" rel="noopener noreferrer">{d.series}{d.number}</a> : `${d.series}${d.number}`}</td>
                      <td>{t(`accounting.receivables.kind.${['INVOICE', 'ADVANCE'].includes(d.kind) ? d.kind : 'PROFORMA'}` as MsgKey)}</td>
                      <td>{fmtDate(d.issuedAt)}</td>
                      <td className="num">{d.total != null ? fmtMoney(d.total.toString(), d.currency) : '—'}</td>
                      <td className="num">{d.paid != null ? fmtMoney(d.paid.toString(), d.currency) : '—'}</td>
                      <td className="num"><b>{rest != null ? fmtMoney(rest, d.currency) : '—'}</b></td>
                      <td><Badge tone={TONE[st]}>{t(`accounting.receivables.status.${st}` as MsgKey)}</Badge></td>
                      <td className="small">
                        {d.checkedAt ? fmtDateTime(d.checkedAt) : '—'}
                        {d.checkError && <div className="danger" title={d.checkError}>{t('accounting.receivables.checkError')}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
