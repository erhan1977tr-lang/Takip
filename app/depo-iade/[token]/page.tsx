import { db } from '@/lib/db';
import { getT, type MsgKey } from '@/lib/i18n';
import { AuthCard } from '../../AuthCard';
import { ConfirmButton } from '@/components/ConfirmButton';
import { unitLabel } from '@/server/profile/catalog.js';
import { findDepotReturn } from '@/server/profile/returns.js';
import { depotReturnAction } from './actions';

export const dynamic = 'force-dynamic';

// Profil iadesinin depo teslimi (DÜZELTME 10 M8): e-postadaki tek kullanımlık bağlantı. Yalnızca iadenin ürünleri ve gerekçesi
// gösterilir — fiyat, tutar, müşteri ödemesi ya da mali karşılık YOK. Bağlantı teslim onaylanınca kapanır.
export default async function DepotReturnPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params;
  const sp = await searchParams;
  const { t, locale } = await getT();
  const here = `/depo-iade/${encodeURIComponent(token)}`;
  if (sp.ok === 'done') return <AuthCard next={here}><div className="alert alert-ok" style={{ marginTop: 12 }} data-return-done>{t('returns.depot.done')}</div></AuthCard>;
  const r = await findDepotReturn(db, token);
  if (!r) {
    return (
      <AuthCard next={here}>
        <div className="alert alert-error" style={{ marginTop: 12 }}><b>{sp.e === 'many' ? t('returns.depot.many') : t('returns.depot.invalid')}</b></div>
      </AuthCard>
    );
  }
  const err = sp.e && /^[A-Z_]{2,30}$/.test(sp.e) ? t(`returns.errors.${sp.e}` as MsgKey) : null;
  return (
    <AuthCard next={here}>
      <h1 style={{ fontSize: 20, margin: '8px 0 4px' }}>{t('returns.depot.title')}</h1>
      <p style={{ margin: 0 }}><b>{t('returns.depot.order')}: {r.order.orderNo}</b> · {r.order.customer.name} · #{r.seq}</p>
      <p className="muted small">{t('returns.depot.reason')}: {r.reason}</p>
      <p className="small">{t('returns.depot.intro')}</p>
      {err && <div className="alert alert-error" data-return-error={sp.e}>{err}</div>}
      <form action={depotReturnAction}>
        <input type="hidden" name="token" value={token} />
        <table className="kv"><tbody>
          {r.lines.map((l) => (
            <tr key={l.id} data-depot-return-line={l.code}>
              <td><b>{l.qty}</b> {unitLabel(l.unitCode, locale)}<div className="small">{locale === 'tr' ? l.nameTr : l.nameRo} <span className="muted mono">{l.code}</span></div></td>
              <td>
                <label className="small">{t('returns.col.good')} <input className="qty-input" name={`g-${l.id}`} inputMode="numeric" maxLength={6} defaultValue={String(l.qty)} /></label>
                <label className="small">{t('returns.col.damaged')} <input className="qty-input" name={`d-${l.id}`} inputMode="numeric" maxLength={6} defaultValue="0" /></label>
              </td>
            </tr>
          ))}
        </tbody></table>
        <label htmlFor="dr-note">{t('returns.depot.note')}</label>
        <input id="dr-note" name="note" maxLength={1000} />
        <div className="hint">{t('returns.receiveHint')}</div>
        <div style={{ marginTop: 12 }}><ConfirmButton primary message={t('returns.receiveConfirm')}>{t('returns.depot.submit')}</ConfirmButton></div>
      </form>
    </AuthCard>
  );
}
