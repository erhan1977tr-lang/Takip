import Link from 'next/link';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { CreateFirmForm } from './FirmForm';

export default async function FirmsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireUser(['ADMIN']);
  const sp = await searchParams;
  const firms = await db.customer.findMany({
    orderBy: [{ type: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { users: true, orders: true } } },
  });
  const groups = [...new Set(firms.map((f) => f.groupName).filter((g): g is string => !!g))].sort();

  return (
    <>
      <div className="page-head">
        <h1>Müşteriler</h1>
        <p className="muted">Önce firmayı burada oluşturun; ardından <Link href="/admin/users">Kullanıcılar</Link> sekmesinden bu firmaya kullanıcı atayın.</p>
      </div>
      {sp.saved && <div className="alert alert-ok">“{sp.saved}” kaydedildi.</div>}
      <CreateFirmForm groups={groups} />

      <div className="card card-flush">
        <div className="card-head"><h2 style={{ margin: 0 }}>Firmalar ({firms.length})</h2></div>
        {firms.length === 0 ? (
          <div className="empty">Henüz firma yok.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Firma</th><th>Ön ek</th><th>Cam / sandık etiketi</th><th>Tip</th><th>Grup</th><th>Kullanıcı</th><th>Sipariş</th><th /></tr>
              </thead>
              <tbody>
                {firms.map((f) => (
                  <tr key={f.id}>
                    <td><b>{f.name}</b></td>
                    <td className="mono">{f.prefix ?? '—'}</td>
                    <td>{f.camEtiket || f.sandikEtiket ? <>{f.camEtiket ?? '—'} / {f.sandikEtiket ?? '—'}</> : '—'}</td>
                    <td><span className={`badge ${f.type === 'FACTORY' ? 'badge-info' : ''}`}>{f.type === 'FACTORY' ? 'Fabrika' : 'Müşteri'}</span></td>
                    <td>{f.groupName ?? <span className="muted">Grupsuz</span>}</td>
                    <td>{f._count.users}</td>
                    <td>{f._count.orders}</td>
                    <td className="actions"><Link href={`/admin/firms/${f.id}`} className="btn btn-link">Düzenle</Link></td>
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
