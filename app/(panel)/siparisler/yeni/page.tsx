import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { suggestNextNo } from '@/lib/orders';
import { fmtDate } from '@/lib/format';
import { nextShipDate } from '@/server/orders/rules.js';
import { NewOrderForm } from './NewOrderForm';

// Yeni sipariş: önce sipariş tipi seçilir (tipler veritabanından; yalnızca etkin olanlar).
// Tek tip etkinken seçim ekranı atlanır. Profil siparişi Aşama 6'da etkinleşir.
export default async function NewOrderPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('ORDER_CREATE');
  const { t, m, locale } = await getT();
  const sp = await searchParams;
  const firm = user.customer;
  if (!firm || firm.type !== 'CUSTOMER' || !firm.prefix) {
    return <div className="alert alert-warn">{t('newOrder.errors.noFirm')}</div>;
  }
  const types = await db.orderType.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  const chosen = types.find((x) => x.code === sp.tip) ?? (types.length === 1 ? types[0] : undefined);

  if (!chosen) {
    return (
      <>
        <div className="page-head">
          <p className="small"><Link href="/siparisler">{t('newOrder.back')}</Link></p>
          <h1>{t('newOrder.selector.title')}</h1>
          <p className="muted">{t('newOrder.selector.intro')}</p>
        </div>
        <div className="type-cards">
          {types.map((x) => (
            <Link key={x.code} href={`/siparisler/yeni?tip=${x.code}`} className="card type-card">
              <h2>{locale === 'tr' ? x.nameTr : x.nameRo}</h2>
              <p className="muted">{m.newOrder.selector.desc[x.code as keyof typeof m.newOrder.selector.desc] ?? ''}</p>
              <span className="btn btn-primary">{t('newOrder.selector.choose')}</span>
            </Link>
          ))}
        </div>
      </>
    );
  }

  const [catalog, suggestedNo] = await Promise.all([
    db.glassProduct.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true } }),
    suggestNextNo(db, firm.id),
  ]);
  return (
    <>
      <div className="page-head">
        <p className="small"><Link href="/siparisler">{t('newOrder.back')}</Link></p>
        <h1>{t('newOrder.title')}</h1>
      </div>
      <NewOrderForm catalog={catalog} suggestedNo={suggestedNo} prefix={firm.prefix} shipDate={fmtDate(nextShipDate())} m={m.newOrder.form} />
    </>
  );
}
