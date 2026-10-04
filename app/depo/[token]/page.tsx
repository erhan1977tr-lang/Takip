import { db } from '@/lib/db';
import { getT } from '@/lib/i18n';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { AuthCard } from '../../AuthCard';
import { ConfirmButton } from '@/components/ConfirmButton';
import { findDepotOrder } from '@/server/profile/warehouse.js';
import { unitLabel } from '@/server/profile/catalog.js';
import { depotAction } from './actions';

export const dynamic = 'force-dynamic';

// Depo bağlantısı (e-postadaki adres, giriş gerektirmez): siparişin özeti, imzalı teslim belgesi yükleme ve teslim onayı.
// Yalnızca teslim için gerekenler gösterilir (fiyat yok).
export default async function DepotPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params;
  const sp = await searchParams;
  const { t, locale } = await getT();
  const p = await findDepotOrder(db, token);
  const here = `/depo/${encodeURIComponent(token)}`;
  if (!p) {
    return (
      <AuthCard next={here}>
        <div className="alert alert-error" style={{ marginTop: 12 }}>
          <b>{sp.e === 'many' ? t('profile.depot.tooMany') : t('profile.depot.invalid')}</b>
          {sp.e !== 'many' && <div className="small">{t('profile.depot.invalidHint')}</div>}
        </div>
      </AuthCard>
    );
  }
  const o = p.order;
  const delivered = p.stage !== 'DEPODA';
  const err = sp.e === 'file' ? t('profile.errors.deliveryFile')
    : sp.e === 'type' ? t('profile.errors.deliveryFileType', { name: sp.n ?? '' })
      : sp.e === 'many' ? t('profile.depot.tooMany')
        : sp.e === 'limit' ? t('profile.depot.limit')
          : sp.e ? t('order.errors.notAllowed') : null;
  return (
    <AuthCard next={here}>
      <h1 style={{ fontSize: 20, margin: '8px 0 4px' }}>{t('profile.depot.title')}</h1>
      <p style={{ margin: 0 }}><b>{t('profile.depot.intro', { orderNo: o.orderNo, firm: o.customer.name })}</b></p>
      <p className="muted small" style={{ marginTop: 4 }}>
        {t('profile.depot.pickup', { date: fmtDate(p.pickupDate) })}{p.contactPhone ? ` · ${p.contactPhone}` : ''}{p.vehiclePlate ? ` · ${p.vehiclePlate}` : ''}
      </p>
      {sp.ok === 'done' && <div className="alert alert-ok">{t('profile.depot.done')}</div>}
      {sp.ok === 'added' && <div className="alert alert-ok">{t('profile.depot.added')}</div>}
      {err && <div className="alert alert-error">{err}</div>}

      <h2 style={{ fontSize: 15, marginTop: 14 }}>{t('profile.depot.items')}</h2>
      <table className="kv"><tbody>
        {o.profileItems.map((i) => (
          <tr key={i.id}><td><b>{i.qty}</b> {unitLabel(i.unitCode, locale)}</td><td>{locale === 'tr' ? i.nameTr : i.nameRo} <span className="muted small mono">{i.code}</span></td></tr>
        ))}
      </tbody></table>

      {delivered && p.deliveredAt && <div className="alert alert-info" style={{ marginTop: 12 }}>{t('profile.depot.already', { date: fmtDateTime(p.deliveredAt) })}</div>}

      <form action={depotAction} style={{ marginTop: 14 }}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="intent" value={delivered ? 'add' : 'confirm'} />
        <label htmlFor="dep-files">{delivered ? t('profile.depot.addMore') : t('profile.depot.upload')}</label>
        <input id="dep-files" name="files" type="file" multiple required accept=".pdf,.jpg,.jpeg,.png" />
        <div className="hint">{t('profile.depot.uploadHint')}</div>
        <div style={{ marginTop: 12 }}>
          {delivered
            ? <button className="btn">{t('profile.depot.add')}</button>
            : <ConfirmButton primary message={t('profile.depot.confirmQuestion')}>{t('profile.depot.confirm')}</ConfirmButton>}
        </div>
      </form>

      {o.files.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, marginTop: 16 }}>{t('profile.depot.files')}</h2>
          <ul className="small">{o.files.map((f) => <li key={f.id}>{f.name} · {fmtDateTime(f.createdAt)}</li>)}</ul>
        </>
      )}
    </AuthCard>
  );
}
