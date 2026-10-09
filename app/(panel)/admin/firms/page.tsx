import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { rich } from '@/lib/rich';
import { CreateFirmForm } from './FirmForm';
import { userCan } from '@/lib/permissions';

export default async function FirmsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const me = await requirePermission('CUSTOMER_MANAGE');
  // Kullanıcılar sayfası yalnızca USER_MANAGE (gerçek yönetici — karar 219): Yönetici Yardımcısına bağlantı gösterilmez
  const canUsers = userCan(me, 'USER_MANAGE');
  const { t, m } = await getT();
  const sp = await searchParams;
  const firms = await db.customer.findMany({
    orderBy: [{ type: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { users: true, orders: true } } },
  });
  const groups = [...new Set(firms.map((f) => f.groupName).filter((g): g is string => !!g))].sort();

  return (
    <>
      <div className="page-head">
        <h1>{t('admin.firms.title')}</h1>
        <p className="muted">{rich(t('admin.firms.intro'), { users: canUsers ? <Link href="/admin/users">{t('admin.firms.usersTab')}</Link> : <b>{t('admin.firms.usersTab')}</b> })}</p>
      </div>
      {sp.saved && <div className="alert alert-ok">{t('admin.firms.saved', { name: sp.saved })}</div>}
      {sp.deleted && <div className="alert alert-ok" data-firm-deleted>{t('admin.firmDelete.done', { name: sp.deleted })}</div>}
      <CreateFirmForm groups={groups} m={m.admin.firmForm} canUsers={canUsers} />

      <div className="card card-flush">
        <div className="card-head"><h2>{t('admin.firms.listTitle', { n: firms.length })}</h2></div>
        {firms.length === 0 ? (
          <div className="empty">{t('admin.firms.empty')}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>{t('admin.firms.col.firm')}</th><th>{t('admin.firms.col.prefix')}</th><th>{t('admin.firms.col.labels')}</th><th>{t('admin.firms.col.type')}</th><th>{t('admin.firms.col.group')}</th><th>{t('admin.firms.col.users')}</th><th>{t('admin.firms.col.orders')}</th><th /></tr>
              </thead>
              <tbody>
                {firms.map((f) => (
                  <tr key={f.id}>
                    <td><b>{f.name}</b></td>
                    <td className="mono">{f.prefix ?? '—'}</td>
                    <td>{f.camEtiket || f.sandikEtiket ? <>{f.camEtiket ?? '—'} / {f.sandikEtiket ?? '—'}</> : '—'}</td>
                    <td><span className={`badge ${f.type === 'FACTORY' ? 'badge-info' : ''}`}>{f.type === 'FACTORY' ? t('admin.firms.typeFactory') : t('admin.firms.typeCustomer')}</span></td>
                    <td>{f.groupName ?? <span className="muted">{t('admin.firms.noGroup')}</span>}</td>
                    <td>{f._count.users}</td>
                    <td>{f._count.orders}</td>
                    <td className="actions"><Link href={`/admin/firms/${f.id}`} className="btn btn-link">{t('admin.firms.edit')}</Link></td>
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
