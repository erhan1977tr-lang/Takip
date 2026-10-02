import Link from 'next/link';
import type { OfferStatus, OrderStatus, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { type CurrentUser, requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { customerLabel, orderScope, sanitizeRows } from '@/lib/orders';
import { userCan } from '@/lib/permissions';
import { fmtDate, fmtMoney } from '@/lib/format';
import { Badge, CustomerBadge, OfferBadge, OrderBadge } from '@/components/StatusBadge';
import { profileCustomerText, profileStageText } from '@/lib/labels';
import { CLOSED } from '@/server/orders/rules.js';

const include = {
  customer: { select: { name: true } },
  price: true,
  offers: { orderBy: { createdAt: 'desc' }, include: { _count: { select: { lines: true } } } },
  profile: { select: { stage: true } },
} satisfies Prisma.OrderInclude;
type Row = Prisma.OrderGetPayload<{ include: typeof include }>;

export default async function OffersPage() {
  const user = await requirePermission('OFFER_VIEW');
  // Hazırlanan teklifleri yalnızca satış ve yönetici görür; müşteri ve denetimci gönderilmiş teklifleri görür.
  return userCan(user, 'OFFER_DRAFT_VIEW') ? <InternalOffers user={user} /> : <CustomerOffers user={user} />;
}

async function CustomerOffers({ user }: { user: CurrentUser }) {
  const { t } = await getT();
  const inspector = user.appRole !== 'MUSTERI';
  const orders = sanitizeRows(user, await db.order.findMany({
    where: { ...orderScope(user), offers: { some: { status: 'GONDERILDI' } } },
    include,
    orderBy: { updatedAt: 'desc' },
  }));
  return (
    <>
      <div className="page-head">
        <h1>{inspector ? t('offers.inspector.title') : t('offers.customer.title')}</h1>
        <p className="muted">{inspector ? t('offers.inspector.intro') : t('offers.customer.intro')}</p>
      </div>
      <div className="card card-flush">
        {orders.length === 0 ? (
          <div className="empty">{inspector ? t('offers.inspector.empty') : t('offers.customer.empty')}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('offers.customer.cols.order')}</th>{inspector && <th>{t('offers.inspector.customer')}</th>}<th>{t('offers.customer.cols.status')}</th><th>{t('offers.customer.cols.date')}</th><th className="num">{t('offers.customer.cols.amount')}</th><th /></tr></thead>
              <tbody>
                {orders.map((o) => {
                  const sent = o.offers.find((x) => x.status === 'GONDERILDI')!;
                  return (
                    <tr key={o.id}>
                      <td><Link className="order-no" href={`/siparisler/${o.id}#teklif`}>{o.orderNo}</Link><div className="muted small">{o.title}</div></td>
                      {inspector && <td>{customerLabel(user, o.customer.name)}</td>}
                      <td>{o.profile ? (() => { const x = profileCustomerText(t, { status: o.status, stage: o.profile.stage }); return <Badge tone={x.tone}>{x.label}</Badge>; })() : <CustomerBadge status={o.status} drawing={o.drawingTrack} offer="GONDERILDI" />}</td>
                      <td>{fmtDate(sent.sentAt)}</td>
                      <td className="num"><b>{fmtMoney((o.price?.amount ?? sent.amount).toString(), sent.currency)}</b></td>
                      <td className="actions"><Link href={`/siparisler/${o.id}#teklif`} className="btn">{t('offers.customer.view')}</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="muted small">{t('common.pricesExclVat')}</p>
    </>
  );
}

const GROUPS: { status: OfferStatus; title: MsgKey; empty: MsgKey }[] = [
  { status: 'HAZIRLANIYOR', title: 'offers.groups.sales.title', empty: 'offers.groups.sales.empty' },
  { status: 'YONETIMDE', title: 'offers.groups.admin.title', empty: 'offers.groups.admin.empty' },
  { status: 'GONDERILDI', title: 'offers.groups.customer.title', empty: 'offers.groups.customer.empty' },
];

async function InternalOffers({ user }: { user: CurrentUser }) {
  const { t } = await getT();
  const orders = sanitizeRows(user, await db.order.findMany({
    // Karar geri alınıp yeniden incelemeye dönen siparişin (YENI) taslağı burada gösterilmez.
    where: { ...orderScope(user), status: { notIn: [...CLOSED, 'YENI'] as OrderStatus[] }, offers: { some: {} } },
    include,
    orderBy: [{ estimatedShipDate: 'asc' }, { createdAt: 'asc' }],
    take: 500,
  }));
  const latest = (o: Row) => o.offers[0];
  // Yönetici satış tutarı ile müşteri tutarını yan yana görür (karar 4); satış yalnızca kendi tutarını
  const admin = userCan(user, 'OFFER_SEND');
  return (
    <>
      <div className="page-head">
        <h1>{t('offers.internal.title')}</h1>
        <p className="muted">{t('offers.internal.intro')}</p>
      </div>
      {GROUPS.map((g) => {
        const rows = orders.filter((o) => latest(o)?.status === g.status);
        return (
          <div key={g.status} className="card card-flush">
            <div className="card-head"><h2>{t(g.title)} <span className="badge">{rows.length}</span></h2></div>
            {rows.length === 0 ? <div className="empty">{t(g.empty)}</div> : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('offers.internal.cols.offer')}</th><th>{t('offers.internal.cols.customer')}</th><th>{t('offers.internal.cols.orderStatus')}</th><th>{t('offers.internal.cols.offerStatus')}</th>
                      <th className="num">{t('offers.internal.cols.lines')}</th><th>{t('offers.internal.cols.ship')}</th><th className="num">{t('offers.internal.cols.amount')}</th>{admin && <th className="num">{t('offers.internal.cols.offerAmount')}</th>}<th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => {
                      const of = latest(o)!;
                      return (
                        <tr key={o.id}>
                          <td><Link className="order-no" href={`/siparisler/${o.id}`}>{o.orderNo}</Link><div className="muted small">{o.title}</div></td>
                          <td className="mono">{customerLabel(user, o.customer.name)}</td>
                          <td>{o.profile && o.status !== 'IPTAL' ? <><Badge tone="purple">{t('profile.type')}</Badge> {profileStageText(t, o.profile.stage)}</> : <OrderBadge status={o.status} onHold={o.onHold} />}</td>
                          <td><OfferBadge status={of.status} /></td>
                          <td className="num">{of._count.lines}</td>
                          <td>{fmtDate(o.estimatedShipDate)}</td>
                          <td className="num">{fmtMoney(of.amount.toString(), of.currency)}</td>
                          {admin && <td className="num">{of.offerAmount != null ? <b>{fmtMoney(of.offerAmount.toString(), of.currency)}</b> : <span className="muted">—</span>}</td>}
                          <td className="actions"><Link href={`/siparisler/${o.id}#teklif`} className="btn">{t('common.open')}</Link></td>
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
