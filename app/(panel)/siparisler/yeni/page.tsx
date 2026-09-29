import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { suggestCustomerOrderNo } from '@/lib/orders';
import { fmtDate } from '@/lib/format';
import { nextShipDate } from '@/server/orders/rules.js';
import { NewOrderForm } from './NewOrderForm';

export default async function NewOrderPage() {
  const user = await requirePermission('ORDER_CREATE');
  const { t, m } = await getT();
  const firm = user.customer;
  if (!firm || firm.type !== 'CUSTOMER' || !firm.prefix) {
    return <div className="alert alert-warn">{t('newOrder.errors.noFirm')}</div>;
  }
  const [catalog, suggestedNo] = await Promise.all([
    db.glassProduct.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true } }),
    suggestCustomerOrderNo(firm.id),
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
