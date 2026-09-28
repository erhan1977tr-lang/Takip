import Link from 'next/link';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { suggestCustomerOrderNo } from '@/lib/orders';
import { fmtDate } from '@/lib/format';
import { nextShipDate } from '@/server/orders/rules.js';
import { NewOrderForm } from './NewOrderForm';

export default async function NewOrderPage() {
  const user = await requireUser(['MUSTERI']);
  const firm = user.customer;
  if (!firm || firm.type !== 'CUSTOMER' || !firm.prefix) {
    return <div className="alert alert-warn">Hesabınız bir müşteri firmasına bağlı değil. Yöneticinize başvurun.</div>;
  }
  const [catalog, suggestedNo] = await Promise.all([
    db.glassProduct.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true } }),
    suggestCustomerOrderNo(firm.id),
  ]);
  return (
    <>
      <div className="page-head">
        <p className="small"><Link href="/siparisler">← Siparişlerim</Link></p>
        <h1>Yeni Sipariş</h1>
      </div>
      <NewOrderForm catalog={catalog} suggestedNo={suggestedNo} prefix={firm.prefix} shipDate={fmtDate(nextShipDate())} />
    </>
  );
}
