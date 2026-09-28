import Link from 'next/link';
import type { OfferStatus, OrderStatus, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireUser, type CurrentUser } from '@/lib/auth/session';
import { customerLabel, orderScope } from '@/lib/orders';
import { fmtDate, fmtMoney } from '@/lib/format';
import { CustomerBadge, OfferBadge, OrderBadge } from '@/components/StatusBadge';
import { CLOSED } from '@/server/orders/rules.js';

const include = {
  customer: { select: { name: true } },
  price: true,
  offers: { orderBy: { createdAt: 'desc' }, include: { _count: { select: { lines: true } } } },
} satisfies Prisma.OrderInclude;
type Row = Prisma.OrderGetPayload<{ include: typeof include }>;

export default async function OffersPage() {
  const user = await requireUser(['MUSTERI', 'SATIS', 'ADMIN']);
  return user.appRole === 'MUSTERI' ? <CustomerOffers user={user} /> : <InternalOffers user={user} />;
}

async function CustomerOffers({ user }: { user: CurrentUser }) {
  const orders = await db.order.findMany({
    where: { ...orderScope(user), offers: { some: { status: 'GONDERILDI' } } },
    include,
    orderBy: { updatedAt: 'desc' },
  });
  return (
    <>
      <div className="page-head">
        <h1>Tekliflerim</h1>
        <p className="muted">Siparişleriniz için hazırlanan teklifler. Ayrıntıları görmek için siparişi açın.</p>
      </div>
      <div className="card card-flush">
        {orders.length === 0 ? (
          <div className="empty">Henüz size gönderilmiş bir teklif yok.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Sipariş</th><th>Sipariş durumu</th><th>Teklif tarihi</th><th className="num">Tutar</th><th /></tr></thead>
              <tbody>
                {orders.map((o) => {
                  const sent = o.offers.find((x) => x.status === 'GONDERILDI')!;
                  return (
                    <tr key={o.id}>
                      <td><Link className="order-no" href={`/siparisler/${o.id}#teklif`}>{o.orderNo}</Link><div className="muted small">{o.title}</div></td>
                      <td><CustomerBadge status={o.status} drawing={o.drawingTrack} offer="GONDERILDI" /></td>
                      <td>{fmtDate(sent.sentAt)}</td>
                      <td className="num"><b>{fmtMoney((o.price?.amount ?? sent.amount).toString(), sent.currency)}</b></td>
                      <td className="actions"><Link href={`/siparisler/${o.id}#teklif`} className="btn">Teklifi gör</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="muted small">Fiyatlar KDV hariçtir.</p>
    </>
  );
}

const GROUPS: { status: OfferStatus; title: string; empty: string }[] = [
  { status: 'HAZIRLANIYOR', title: 'Satışta hazırlananlar', empty: 'Hazırlanan teklif yok.' },
  { status: 'YONETIMDE', title: 'Yönetici onayında', empty: 'Onay bekleyen teklif yok.' },
  { status: 'GONDERILDI', title: 'Müşteride', empty: 'Müşteriye gönderilmiş aktif teklif yok.' },
];

async function InternalOffers({ user }: { user: CurrentUser }) {
  const orders = await db.order.findMany({
    where: { ...orderScope(user), status: { notIn: CLOSED as OrderStatus[] }, offers: { some: {} } },
    include,
    orderBy: [{ estimatedShipDate: 'asc' }, { createdAt: 'asc' }],
    take: 500,
  });
  const latest = (o: Row) => o.offers[0];
  return (
    <>
      <div className="page-head">
        <h1>Teklifler</h1>
        <p className="muted">Hazırlanan, yönetimde bekleyen ve müşteriye gönderilmiş teklifler.</p>
      </div>
      {GROUPS.map((g) => {
        const rows = orders.filter((o) => latest(o)?.status === g.status);
        return (
          <div key={g.status} className="card card-flush">
            <div className="card-head"><h2 style={{ margin: 0 }}>{g.title} <span className="badge">{rows.length}</span></h2></div>
            {rows.length === 0 ? <div className="empty">{g.empty}</div> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Teklif</th><th>Müşteri</th><th>Sipariş</th><th>Teklif</th><th className="num">Satır</th><th>Teslim</th><th className="num">Tutar</th><th /></tr></thead>
                  <tbody>
                    {rows.map((o) => {
                      const of = latest(o)!;
                      return (
                        <tr key={o.id}>
                          <td><Link className="order-no" href={`/siparisler/${o.id}`}>{o.orderNo}</Link><div className="muted small">{o.title}</div></td>
                          <td className="mono">{customerLabel(user, o.customer.name)}</td>
                          <td><OrderBadge status={o.status} onHold={o.onHold} /></td>
                          <td><OfferBadge status={of.status} /></td>
                          <td className="num">{of._count.lines}</td>
                          <td>{fmtDate(o.estimatedShipDate)}</td>
                          <td className="num">{fmtMoney(of.amount.toString(), of.currency)}</td>
                          <td className="actions"><Link href={`/siparisler/${o.id}#teklif`} className="btn">Aç</Link></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
