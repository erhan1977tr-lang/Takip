import { requireUser } from '@/lib/auth/session';

export default async function OrdersPage() {
  const user = await requireUser();
  return (
    <>
      <div className="page-head">
        <h1>{user.appRole === 'MUSTERI' ? 'Siparişlerim' : 'Siparişler'}</h1>
        <p className="muted">Sipariş ekranları bir sonraki adımda bu sürüme taşınacak.</p>
      </div>
      <div className="card empty">Henüz sipariş yok.</div>
    </>
  );
}
