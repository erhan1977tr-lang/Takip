import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { getEnv } from '@/lib/env';
import { fmtDate, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { listSupplierOrders } from '@/server/suppliers/service.js';
import { OPEN_STATUSES, etaReminderDue } from '@/server/suppliers/rules.js';
import { dayKeyOf, localDay } from '@/server/profile/dates.js';
import { SupplierStatusBadge } from '@/components/SupplierStatus';

export const dynamic = 'force-dynamic';

const TABS: { key: string; label: MsgKey; statuses: string[] | null }[] = [
  { key: 'acik', label: 'supplier.orders.tabs.open', statuses: ['TASLAK', ...OPEN_STATUSES] },
  { key: 'teslim', label: 'supplier.orders.tabs.received', statuses: ['TESLIM_ALINDI'] },
  { key: 'iptal', label: 'supplier.orders.tabs.cancelled', statuses: ['IPTAL'] },
  { key: 'tumu', label: 'supplier.orders.tabs.all', statuses: null },
];

/**
 * Tedarikçi Siparişleri (Paket 6, karar 181): profil / conta / plastik / aksesuar satın alma siparişleri. Yalnızca yönetici
 * (SUPPLIER_MANAGE). Cam siparişlerinden ve müşteri ekranlarından tamamen ayrıdır; stok değiştirmez.
 */
export default async function SupplierOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('SUPPLIER_MANAGE');
  const { t } = await getT();
  const sp = await searchParams;
  const tab = TABS.find((x) => x.key === sp.durum) ?? TABS[0];
  const orders = await listSupplierOrders(db, { statuses: tab.statuses });
  const today = localDay(new Date(), getEnv().APP_TIMEZONE);

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>{t('supplier.orders.title')}</h1>
          <p className="muted">{t('supplier.orders.intro')}</p>
        </div>
        <div className="row">
          <Link className="btn" href="/siparisler/tedarik/yeni?kritik=1">{t('supplier.orders.critical')}</Link>
          <Link className="btn btn-primary" href="/siparisler/tedarik/yeni">{t('supplier.orders.new')}</Link>
        </div>
      </div>
      {sp.ok === 'deleted' && <div className="alert alert-ok">{t('supplier.order.ok.deleted')}</div>}
      <div className="tabs">
        {TABS.map((x) => (
          <Link key={x.key} href={x.key === 'acik' ? '/siparisler/tedarik' : `/siparisler/tedarik?durum=${x.key}`} className={x.key === tab.key ? 'active' : undefined}>{t(x.label)}</Link>
        ))}
      </div>
      <div className="card card-flush">
        <div className="card-head"><h2>{t(tab.label)} <span className="badge">{orders.length}</span></h2></div>
        {orders.length === 0 ? <div className="empty">{t('supplier.orders.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('supplier.orders.col.no')}</th><th>{t('supplier.orders.col.supplier')}</th><th>{t('supplier.orders.col.date')}</th>
                  <th>{t('supplier.orders.col.status')}</th><th className="num">{t('supplier.orders.col.revision')}</th>
                  <th className="num">{t('supplier.orders.col.lines')}</th><th className="num">{t('supplier.orders.col.total')}</th>
                  <th>{t('supplier.orders.col.eta')}</th><th>{t('supplier.orders.col.sent')}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const final = o.revisions.find((r) => r.finalizedAt) ?? null;
                  const draft = o.revisions.find((r) => !r.finalizedAt) ?? null;
                  const shown = final ?? draft;
                  const open = OPEN_STATUSES.includes(o.status);
                  const etaDay = o.etaDate ? dayKeyOf(o.etaDate) : null;
                  const soon = open && etaReminderDue({ etaDay, today });
                  const past = open && !!etaDay && etaDay < today;
                  return (
                    <tr key={o.id} data-supplier-order={o.orderNo} className={o.status === 'GONDERIM_HATASI' ? 'row-alert' : undefined}>
                      <td className="mono"><Link href={`/siparisler/tedarik/${o.id}`}>{o.orderNo}</Link></td>
                      <td>{o.supplier.name}</td>
                      <td className="nowrap">{shown ? fmtDate(shown.orderDate) : '—'}</td>
                      <td>
                        <SupplierStatusBadge status={o.status} />
                        {final && draft && <div className="small muted">{t('supplier.orders.draftRevision', { n: draft.revision })}</div>}
                      </td>
                      <td className="num">{shown?.revision ?? '—'}</td>
                      <td className="num">{shown?._count.lines ?? 0}</td>
                      <td className="num nowrap">
                        {final?.total != null ? <>{fmtNum(final.total.toString())} {o.currency}</> : '—'}
                        {final?.missingPrice && <div><Badge tone="warn">{t('supplier.orders.missingPrice')}</Badge></div>}
                      </td>
                      <td className="nowrap" data-eta>
                        {etaDay ? fmtDate(`${etaDay}T12:00:00Z`) : '—'}
                        {soon && <> <Badge tone="warn">{t('supplier.orders.etaSoon')}</Badge></>}
                        {past && <> <Badge tone="danger">{t('supplier.orders.etaPast')}</Badge></>}
                      </td>
                      <td className="nowrap small">{o.sentAt ? fmtDate(o.sentAt) : '—'}</td>
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
