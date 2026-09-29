import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { updateFirmAction } from '../actions';

export default async function EditFirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireUser(['ADMIN']);
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
          <div><label htmlFor="prefix">{t('admin.firmForm.prefix')}</label><input id="prefix" name="prefix" type="text" maxLength={5} defaultValue={f.prefix ?? ''} style={{ textTransform: 'uppercase' }} /></div>
          <div><label htmlFor="groupName">{t('admin.firmForm.group')}</label><input id="groupName" name="groupName" type="text" defaultValue={f.groupName ?? ''} /></div>
          <div><label htmlFor="camEtiket">{t('admin.firmForm.camEtiket')}</label><input id="camEtiket" name="camEtiket" type="text" defaultValue={f.camEtiket ?? ''} /></div>
          <div><label htmlFor="sandikEtiket">{t('admin.firmForm.sandikEtiket')}</label><input id="sandikEtiket" name="sandikEtiket" type="text" defaultValue={f.sandikEtiket ?? ''} /></div>
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
