import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { getEnv } from '@/lib/env';
import { FxInfo, FxUnavailableNote, fxPolicyLabel } from '@/components/FxInfo';
import { FX_MARKUP_MAX, previewExchangeRate, trimPercent } from '@/server/fx/resolve.js';
import { bnrRate } from '@/server/fx/bnr.js';
import { localDay } from '@/server/profile/dates.js';
import { deleteCustomerAction, updateFirmAction } from '../actions';
import { userCan } from '@/lib/permissions';
import { actorOf } from '@/lib/actor';
import { customerDeletionPreview } from '@/server/customers/deletion.js';
import { FxPolicyFields } from '../FxPolicyFields';

export default async function EditFirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requirePermission('CUSTOMER_MANAGE');
  const { t, m } = await getT();
  const { id } = await params;
  const sp = await searchParams;
  const f = await db.customer.findUnique({ where: { id } });
  if (!f) notFound();
  // Firma silme (karar 221): yalnızca müşteri firması ve CUSTOMER_DELETE; önizleme ?sil=1 ile açılır (yalnızca okur)
  const canDelete = f.type === 'CUSTOMER' && userCan(user, 'CUSTOMER_DELETE');
  const del = canDelete && sp.sil === '1' ? await customerDeletionPreview(db, { customerId: f.id, actor: await actorOf(user) }) : null;
  const preview = del && del.ok ? del : null;
  const DEL_ERR = ['CONFIRM_REQUIRED', 'STALE', 'BLOCKED', 'NOT_FOUND', 'FORBIDDEN'];
  const delError = sp.delError && DEL_ERR.includes(sp.delError) ? sp.delError : null;
  // Bugünün kuru (kayıtlı politikayla): BNR 30 dakika saklanır; alınamazsa "alınamadı" gösterilir, başka kur gösterilmez.
  const fxToday = f.type === 'CUSTOMER'
    ? await previewExchangeRate(db, { customer: f, currency: 'EUR', day: localDay(new Date(), getEnv().APP_TIMEZONE), bnrImpl: (o) => bnrRate({ ...o, timeoutMs: 6000 }) })
    : null;

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
          {/* Mali belge e-postası (karar 115): proforma / fatura e-postaları önce buraya; boşsa firmanın e-postasına */}
          <div>
            <label htmlFor="billingEmail">{t('admin.firmForm.billingEmail')}</label>
            <input id="billingEmail" name="billingEmail" type="email" maxLength={200} defaultValue={f.billingEmail ?? ''} autoComplete="off" />
            <p className="hint">{t('admin.firmForm.billingEmailHint')}{f.email ? ` ${t('admin.firmForm.billingEmailFallback', { email: f.email })}` : ''}</p>
          </div>
        </div>
        {/* Kur politikası (Aşama 7D-1): cam FGO belgelerinin kuru; seçilmediyse eski kural */}
        {f.type === 'CUSTOMER' && (
          <div id="kur">
            <h2 style={{ marginTop: 18 }}>{t('fx.title')}</h2>
            <p className="muted small">{t('fx.intro')}</p>
            <FxPolicyFields policy={f.fxPolicy} percent={f.fxMarkupPercent != null ? trimPercent(f.fxMarkupPercent.toString()).replace('.', ',') : ''} max={FX_MARKUP_MAX} m={m.fx} />
          </div>
        )}
        {sp.error && <div className="alert alert-error" style={{ marginTop: 14 }}>{sp.error}</div>}
        <div className="row end" style={{ marginTop: 14 }}>
          <Link href="/admin/firms" className="btn">{t('common.cancel')}</Link>
          <button type="submit" className="btn btn-primary">{t('common.save')}</button>
        </div>
      </form>
      {canDelete && !preview && (
        <div className="card" id="firma-sil-baslat">
          <h2>{t('admin.firmDelete.title')}</h2>
          <p className="muted small">{t('admin.firmDelete.hint')}</p>
          <Link href={`/admin/firms/${f.id}?sil=1#firma-sil`} className="btn btn-danger" data-action="delete-firm">{t('admin.firmDelete.start')}</Link>
        </div>
      )}
      {preview && (
        <form action={deleteCustomerAction} className="card" id="firma-sil" data-firm-delete={f.id}>
          <h2>{t('admin.firmDelete.title')}</h2>
          {delError && <div className="alert alert-error">{t(`admin.firmDelete.errors.${delError}` as MsgKey)}</div>}
          {preview.blockers.length > 0 ? (
            <div className="alert alert-error" data-delete-blocked>
              <b>{t('admin.firmDelete.blockedTitle')}</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {preview.blockers.map((b) => <li key={b.code} data-blocker={b.code}>{t(`admin.firmDelete.blockers.${b.code}` as MsgKey, { n: b.n })}</li>)}
              </ul>
            </div>
          ) : (
            <>
              <div className="alert alert-error">{t('admin.firmDelete.intro')}</div>
              <p className="small" data-delete-counts>{t('admin.firmDelete.counts', preview.counts)}</p>
              {preview.orderNos.length > 0 && <p className="small muted" data-delete-orders>{t('admin.firmDelete.orders', { list: preview.orderNos.join(', ') })}</p>}
              <p className="small">{t('admin.firmDelete.kept')}</p>
              <input type="hidden" name="id" value={f.id} />
              <input type="hidden" name="fp" value={preview.fingerprint} />
              <label htmlFor="firma-onay">{t('admin.firmDelete.confirmLabel', { name: f.name })}</label>
              <input id="firma-onay" name="confirm" required autoComplete="off" />
            </>
          )}
          <div className="row end" style={{ marginTop: 12 }}>
            <Link href={`/admin/firms/${f.id}`} className="btn">{t('common.cancel')}</Link>
            {preview.blockers.length === 0 && <button type="submit" className="btn btn-danger-solid">{t('admin.firmDelete.submit')}</button>}
          </div>
        </form>
      )}
      {fxToday && (
        <div className="card" id="kur-bugun">
          <h2>{t('fx.todayTitle')}</h2>
          {fxToday.ok ? (
            <>
              <FxInfo fx={fxToday.fx} t={t} />
              {f.fxPolicy === 'BT_UNIT_SELL' && <p className="muted small">{t('fx.btAutoNote')}</p>}
            </>
          ) : (
            <>
              <p><b>{t('fx.policyLabel')}:</b> {fxPolicyLabel(t, f.fxPolicy, f.fxMarkupPercent?.toString())}</p>
              <FxUnavailableNote code={fxToday.code} error={fxToday.error} t={t} />
              {fxToday.code === 'BT_MANUAL_REQUIRED' && <p className="small"><Link href="/admin/entegrasyonlar">{t('fx.integrationsLink')}</Link></p>}
            </>
          )}
        </div>
      )}
    </>
  );
}
