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
import { salesOfferGroups } from '@/server/orders/queues.js';

const include = {
  customer: { select: { name: true } },
  price: true,
  offers: { orderBy: { createdAt: 'desc' }, include: { _count: { select: { lines: true } } } },
  profile: { select: { stage: true } },
} satisfies Prisma.OrderInclude;
type Row = Prisma.OrderGetPayload<{ include: typeof include }>;
/** Satış (Paket 4): yöneticinin sandık bedeli satırı satışa gitmez — satır sayısında da yoktur */
const salesInclude = {
  ...include,
  offers: { orderBy: { createdAt: 'desc' }, include: { _count: { select: { lines: { where: { crateFee: false } } } } } },
} satisfies Prisma.OrderInclude;

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
  // Yönetici satış tutarı ile müşteri tutarını yan yana görür (karar 4); satış yalnızca kendi tutarını
  const admin = userCan(user, 'OFFER_SEND');
  const query = {
    where: admin
      // Karar geri alınıp yeniden incelemeye dönen siparişin (YENI) taslağı burada gösterilmez.
      ? { ...orderScope(user), status: { notIn: [...CLOSED, 'YENI'] as OrderStatus[] }, offers: { some: {} } }
      // Satış (karar 155): teklif tablosu henüz açılmamış siparişler de listelenir (karar bekleyen ve teklifsiz siparişler)
      : { ...orderScope(user), status: { notIn: CLOSED as OrderStatus[] } },
    orderBy: [{ estimatedShipDate: 'asc' }, { createdAt: 'asc' }],
    take: 500,
  } satisfies Prisma.OrderFindManyArgs;
  const rows: Row[] = admin ? await db.order.findMany({ ...query, include }) : await db.order.findMany({ ...query, include: salesInclude });
  const orders = sanitizeRows(user, rows);
  const latest = (o: Row) => o.offers[0] as Row['offers'][number] | undefined;
  // Yönetici: son teklifin durumuna göre üç grup. Satış (karar 155): yalnızca "Fiyatımı bekleyenler" ve "Teklif tablosu
  // açılmamış siparişler" — yönetici onayındaki ve müşterideki teklifler satışın bu sayfasında listelenmez.
  const groups: { key: string; title: MsgKey; empty: MsgKey; rows: Row[] }[] = admin
    ? GROUPS.map((g) => ({ key: g.status, title: g.title, empty: g.empty, rows: orders.filter((o) => latest(o)?.status === g.status) }))
    : salesOfferGroups(orders).map((g) => ({ key: g.key, title: `offers.groups.${g.key}.title` as MsgKey, empty: `offers.groups.${g.key}.empty` as MsgKey, rows: g.rows }));
  return (
    <>
      <div className="page-head">
        <h1>{t('offers.internal.title')}</h1>
        <p className="muted">{t(admin ? 'offers.internal.intro' : 'offers.internal.introSales')}</p>
      </div>
      {groups.map((g) => {
        const rows = g.rows;
        return (
          <div key={g.key} className="card card-flush" data-group={g.key}>
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
                      const of = latest(o);
                      return (
                        <tr key={o.id}>
                          <td><Link className="order-no" href={`/siparisler/${o.id}`}>{o.orderNo}</Link><div className="muted small">{o.title}</div></td>
                          <td className="mono">{customerLabel(user, o.customer.name)}</td>
                          <td>{o.profile && o.status !== 'IPTAL' ? <><Badge tone="purple">{t('profile.type')}</Badge> {profileStageText(t, o.profile.stage)}</> : <OrderBadge status={o.status} onHold={o.onHold} />}</td>
                          <td>{of ? <OfferBadge status={of.status} /> : <span className="muted">—</span>}</td>
                          <td className="num">{of ? of._count.lines : <span className="muted">—</span>}</td>
                          <td>{fmtDate(o.estimatedShipDate)}</td>
                          <td className="num">{of ? fmtMoney(of.amount.toString(), of.currency) : <span className="muted">—</span>}</td>
                          {admin && <td className="num">{of?.offerAmount != null ? <b>{fmtMoney(of.offerAmount.toString(), of.currency)}</b> : <span className="muted">—</span>}</td>}
                          <td className="actions"><Link href={`/siparisler/${o.id}${of ? '#teklif' : ''}`} className="btn">{t('common.open')}</Link></td>
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
