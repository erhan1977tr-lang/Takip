import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { Badge } from '@/components/StatusBadge';
import { listSuppliers } from '@/server/suppliers/service.js';
import { SUPPLIER_CURRENCIES, supplierEmail } from '@/server/suppliers/rules.js';
import { SettingsTabs } from '../SettingsTabs';
import { saveSupplierAction, toggleSupplierAction } from './actions';

export const dynamic = 'force-dynamic';

const OK: Record<string, MsgKey> = {
  added: 'supplier.settings.ok.added', saved: 'supplier.settings.ok.saved', toggled: 'supplier.settings.ok.toggled',
};
// Formun kendi hataları (parseSupplier) önce, sonra servisin genel kodları
const ERR: Record<string, MsgKey> = {
  NAME: 'supplier.settings.errors.NAME', TOO_LONG: 'supplier.settings.errors.TOO_LONG', EMAIL: 'supplier.settings.errors.EMAIL',
  CURRENCY: 'supplier.settings.errors.CURRENCY', EXISTS: 'supplier.settings.errors.EXISTS', CURRENCY_LOCKED: 'supplier.settings.errors.CURRENCY_LOCKED',
  NOT_FOUND: 'supplier.errors.NOT_FOUND', FORBIDDEN: 'supplier.errors.FORBIDDEN',
};

/**
 * Ayarlar → Tedarikçiler (Paket 6, karar 179): profil / conta / plastik / aksesuar tedarikçileri. Sabit liste yoktur;
 * yönetici ekler, düzenler, pasif yapar (silinmez). Tedarikçi siparişinin e-postası YALNIZCA burada kayıtlı adrese gider.
 * Yalnızca SUPPLIER_MANAGE (yönetici).
 */
export default async function SuppliersSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('SUPPLIER_MANAGE');
  const { t } = await getT();
  const sp = await searchParams;
  const suppliers = await listSuppliers(db);
  const editing = sp.duzenle ? suppliers.find((s) => s.id === sp.duzenle) ?? null : null;
  const noEmail = suppliers.filter((s) => s.isActive && !supplierEmail(s.email)).length;
  const okText = sp.ok && Object.hasOwn(OK, sp.ok) ? t(OK[sp.ok]) : null;
  const errText = sp.error ? t(Object.hasOwn(ERR, sp.error) ? ERR[sp.error] : 'supplier.errors.OTHER') : null;

  return (
    <>
      <div className="page-head">
        <h1>{t('supplier.settingsTabs.title')}</h1>
        <p className="muted">{t('supplier.settings.intro')}</p>
      </div>
      <SettingsTabs user={user} active="suppliers" />
      {okText && <div className="alert alert-ok">{okText}</div>}
      {errText && <div className="alert alert-error" role="alert">{errText}</div>}
      {noEmail > 0 && <div className="alert alert-warn" id="eposta-eksik">{t('supplier.settings.noEmailWarn', { n: noEmail })}</div>}

      <form action={saveSupplierAction} className="card" id="tedarikci" key={editing?.id ?? 'new'}>
        <h2>{editing ? t('supplier.settings.edit') : t('supplier.settings.add')}</h2>
        {editing && <input type="hidden" name="supplierId" value={editing.id} />}
        <div className="grid-3">
          <div>
            <label htmlFor="sp-name">{t('supplier.settings.field.name')}</label>
            <input id="sp-name" name="name" required maxLength={120} defaultValue={editing?.name ?? ''} />
          </div>
          <div>
            <label htmlFor="sp-contact">{t('supplier.settings.field.contact')} <span className="muted small">({t('supplier.settings.field.optional')})</span></label>
            <input id="sp-contact" name="contactName" maxLength={120} defaultValue={editing?.contactName ?? ''} />
          </div>
          <div>
            <label htmlFor="sp-email">{t('supplier.settings.field.email')}</label>
            <input id="sp-email" name="email" type="email" maxLength={200} defaultValue={editing?.email ?? ''} autoComplete="off" />
            <div className="hint">{t('supplier.settings.field.emailHint')}</div>
          </div>
          <div>
            <label htmlFor="sp-phone">{t('supplier.settings.field.phone')} <span className="muted small">({t('supplier.settings.field.optional')})</span></label>
            <input id="sp-phone" name="phone" maxLength={40} defaultValue={editing?.phone ?? ''} />
          </div>
          <div>
            <label htmlFor="sp-currency">{t('supplier.settings.field.currency')}</label>
            <select id="sp-currency" name="currency" required defaultValue={editing?.currency ?? 'EUR'}>
              {SUPPLIER_CURRENCIES.map((c: string) => <option key={c} value={c}>{c}</option>)}
            </select>
            <div className="hint">{t('supplier.settings.field.currencyHint')}</div>
          </div>
          <div>
            <label htmlFor="sp-address">{t('supplier.settings.field.address')} <span className="muted small">({t('supplier.settings.field.optional')})</span></label>
            <textarea id="sp-address" name="address" rows={2} maxLength={400} defaultValue={editing?.address ?? ''} />
          </div>
        </div>
        {editing && (
          <label className="check" style={{ marginTop: 10 }}>
            <input type="checkbox" name="isActive" defaultChecked={editing.isActive} /> {t('supplier.settings.field.active')}
          </label>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary">{editing ? t('common.save') : t('supplier.settings.add')}</button>
          {editing && <Link href="/admin/entegrasyonlar/tedarikciler" className="btn btn-link">{t('common.cancel')}</Link>}
        </div>
      </form>

      <div className="card card-flush">
        <div className="card-head"><h2>{t('supplier.settings.title')} <span className="badge">{suppliers.length}</span></h2></div>
        {suppliers.length === 0 ? <div className="empty">{t('supplier.settings.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('supplier.settings.col.name')}</th><th>{t('supplier.settings.col.contact')}</th><th>{t('supplier.settings.col.email')}</th>
                  <th>{t('supplier.settings.col.phone')}</th><th>{t('supplier.settings.col.currency')}</th>
                  <th className="num">{t('supplier.settings.col.products')}</th><th className="num">{t('supplier.settings.col.orders')}</th>
                  <th>{t('supplier.settings.col.status')}</th><th />
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr key={s.id} id={`t-${s.id}`} data-supplier={s.name} style={s.isActive ? undefined : { opacity: 0.6 }}>
                    <td><b>{s.name}</b>{s.address && <div className="muted small" style={{ whiteSpace: 'pre-line' }}>{s.address}</div>}</td>
                    <td>{s.contactName ?? '—'}</td>
                    <td data-email>{supplierEmail(s.email) ? <span className="mono">{s.email}</span> : <Badge tone="warn">{t('supplier.settings.noEmail')}</Badge>}</td>
                    <td>{s.phone ?? '—'}</td>
                    <td>{s.currency}</td>
                    <td className="num">{s._count.products}</td>
                    <td className="num">{s._count.orders}</td>
                    <td>{s.isActive ? <Badge tone="ok">{t('supplier.settings.active')}</Badge> : <Badge tone="muted">{t('supplier.settings.inactive')}</Badge>}</td>
                    <td className="actions">
                      <Link className="btn btn-link" href={`/admin/entegrasyonlar/tedarikciler?duzenle=${s.id}#tedarikci`}>{t('profile.catalog.edit')}</Link>
                      <form action={toggleSupplierAction}>
                        <input type="hidden" name="supplierId" value={s.id} />
                        <input type="hidden" name="active" value={s.isActive ? '0' : '1'} />
                        <button className="btn btn-link">{s.isActive ? t('supplier.settings.deactivate') : t('supplier.settings.activate')}</button>
                      </form>
                    </td>
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
