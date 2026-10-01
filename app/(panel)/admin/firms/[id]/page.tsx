import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { updateFirmAction } from '../actions';

export default async function EditFirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePermission('CUSTOMER_MANAGE');
  const { t } = await getT();
  const { id } = await params;
  const sp = await searchParams;
  const f = await db.customer.findUnique({ where: { id } });
  if (!f) notFound();

  return (
    <>
      <div className="page-head">
        <p className="small"><Link href="/admin/firms">{t('admin.firms.back')}</Link></p>
        <h1>{f.name}</h1>
      </div>
      <form action={updateFirmAction} className="card">
        <input type="hidden" name="id" value={f.id} />
        <div className="grid">
          <div><label htmlFor="name">{t('admin.firmForm.name')}</label><input id="name" name="name" type="text" required defaultValue={f.name} /></div>
          <div>
            <label htmlFor="type">{t('admin.firmForm.type')}</label>
            <select id="type" name="type" defaultValue={f.type}>
              <option value="CUSTOMER">{t('admin.firmForm.typeCustomer')}</option>
              <option value="FACTORY">{t('admin.firmForm.typeFactory')}</option>
            </select>
          </div>
          <div><label htmlFor="prefix">{t('admin.firmForm.prefix')}</label><input id="prefix" name="prefix" type="text" maxLength={3} pattern="[A-Za-z]{3}" defaultValue={f.prefix ?? ''} style={{ textTransform: 'uppercase' }} /></div>
          <div><label htmlFor="groupName">{t('admin.firmForm.group')}</label><input id="groupName" name="groupName" type="text" defaultValue={f.groupName ?? ''} /></div>
          <div><label htmlFor="camEtiket">{t('admin.firmForm.camEtiket')}</label><input id="camEtiket" name="camEtiket" type="text" defaultValue={f.camEtiket ?? ''} /></div>
          <div><label htmlFor="sandikEtiket">{t('admin.firmForm.sandikEtiket')}</label><input id="sandikEtiket" name="sandikEtiket" type="text" defaultValue={f.sandikEtiket ?? ''} /></div>
        </div>
        {/* Fatura bilgileri (FGO proforma / fatura; Aşama 6b) */}
        <h2 style={{ marginTop: 18 }}>{t('admin.firmForm.billingTitle')}</h2>
        <p className="muted small">{t('admin.firmForm.billingHint')}</p>
        <div className="grid">
          <div><label htmlFor="taxId">{t('admin.firmForm.taxId')}</label><input id="taxId" name="taxId" type="text" maxLength={20} defaultValue={f.taxId ?? ''} /></div>
          <div><label htmlFor="regCom">{t('admin.firmForm.regCom')}</label><input id="regCom" name="regCom" type="text" maxLength={40} defaultValue={f.regCom ?? ''} placeholder="J40/1234/2020" /></div>
          <div><label htmlFor="country">{t('admin.firmForm.country')}</label><input id="country" name="country" type="text" maxLength={2} defaultValue={f.country ?? 'RO'} style={{ textTransform: 'uppercase' }} /></div>
          <div><label htmlFor="county">{t('admin.firmForm.county')}</label><input id="county" name="county" type="text" maxLength={60} defaultValue={f.county ?? ''} /></div>
          <div><label htmlFor="city">{t('admin.firmForm.city')}</label><input id="city" name="city" type="text" maxLength={80} defaultValue={f.city ?? ''} /></div>
          <div><label htmlFor="address">{t('admin.firmForm.address')}</label><input id="address" name="address" type="text" maxLength={250} defaultValue={f.address ?? ''} /></div>
        </div>
        {sp.error && <div className="alert alert-error" style={{ marginTop: 14 }}>{sp.error}</div>}
        <div className="row end" style={{ marginTop: 14 }}>
          <Link href="/admin/firms" className="btn">{t('common.cancel')}</Link>
          <button type="submit" className="btn btn-primary">{t('common.save')}</button>
        </div>
      </form>
    </>
  );
}
