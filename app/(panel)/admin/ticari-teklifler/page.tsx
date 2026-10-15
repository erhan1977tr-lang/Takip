import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDate, fmtMoney, fmtNum } from '@/lib/format';
import { Badge } from '@/components/StatusBadge';
import { listOffers } from '@/server/commercial/service.js';
import { OFFER_STATUSES, offerNoText } from '@/server/commercial/rules.js';
import { STATUS_TONE } from './labels';

export const dynamic = 'force-dynamic';

/**
 * Bağımsız ticari teklifler (3.83.0, karar 277): yalnızca yönetici ve yönetici yardımcısı (COMMERCIAL_OFFER_MANAGE). Sipariş,
 * FGO ve stokla bağı yoktur. Maliyet / kâr / marj yalnızca burada ve iç Excel'de görünür.
 */
export default async function CommercialOffersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requirePermission('COMMERCIAL_OFFER_MANAGE');
  const { t } = await getT();
  const sp = await searchParams;
  const q = String(sp.q ?? '').slice(0, 80);
  const status = OFFER_STATUSES.includes(String(sp.durum)) ? String(sp.durum) : '';
  const res = await listOffers(db, { q, status }, await actorOf(admin));
  const rows = res.ok ? res.rows : [];
  const tabs = ['', ...OFFER_STATUSES];

  return (
    <>
      <div className="page-head row">
        <div>
          <h1>{t('commercial.title.list')}</h1>
          <p className="muted">{t('commercial.intro')}</p>
        </div>
        <Link className="btn btn-primary" href="/admin/ticari-teklifler/yeni">{t('commercial.list.newButton')}</Link>
      </div>
      <div className="tabs">
        {tabs.map((s) => {
          const href = `/admin/ticari-teklifler?${new URLSearchParams({ ...(s ? { durum: s } : {}), ...(q ? { q } : {}) })}`;
          return <Link key={s || 'all'} href={href} className={s === status ? 'active' : undefined}>{s ? t(`commercial.status.${s}` as MsgKey) : t('commercial.list.all')}</Link>;
        })}
      </div>
      <form className="row" method="get" style={{ marginBottom: 12 }}>
        {status && <input type="hidden" name="durum" value={status} />}
        <input name="q" defaultValue={q} placeholder={t('commercial.list.search')} aria-label={t('commercial.list.search')} maxLength={80} />
        <button className="btn" type="submit">{t('commercial.list.searchButton')}</button>
      </form>
      <div className="card card-flush">
        <div className="card-head"><h2>{t('commercial.title.list')} <span className="badge">{rows.length}</span></h2></div>
        {rows.length === 0 ? <div className="empty">{t('commercial.list.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('commercial.list.col.no')}</th><th>{t('commercial.list.col.date')}</th><th>{t('commercial.list.col.firm')}</th>
                  <th>{t('commercial.list.col.status')}</th><th className="num">{t('commercial.list.col.version')}</th>
                  <th className="num">{t('commercial.list.col.total')}</th><th className="num">{t('commercial.list.col.cost')}</th>
                  <th className="num">{t('commercial.list.col.profit')}</th><th className="num">{t('commercial.list.col.margin')}</th>
                  <th>{t('commercial.list.col.by')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} data-commercial-offer={offerNoText(o.no)}>
                    <td className="mono"><Link href={`/admin/ticari-teklifler/${o.id}`}>{offerNoText(o.no)}</Link></td>
                    <td className="nowrap">{o.date ? fmtDate(`${o.date}T12:00:00Z`) : '—'}</td>
                    <td>{o.firmName}</td>
                    <td>
                      <Badge tone={STATUS_TONE[o.status]}>{t(`commercial.status.${o.status}` as MsgKey)}</Badge>
                      {o.status === 'TASLAK' && o.version > 1 && <div className="small muted">{t('commercial.versions.version')} {o.version}</div>}
                    </td>
                    <td className="num">{o.version}</td>
                    <td className="num nowrap">{fmtMoney(o.total)}</td>
                    <td className="num nowrap" data-cost>{o.cost != null ? fmtMoney(o.cost) : '—'}</td>
                    <td className="num nowrap">{o.profit != null ? fmtMoney(o.profit) : '—'}</td>
                    <td className="num nowrap">
                      {o.margin != null ? `%${fmtNum(o.margin)}` : '—'}
                      {o.missingCost > 0 && <div><Badge tone="warn">{t('commercial.list.missingCost')}</Badge></div>}
                    </td>
                    <td className="small">{o.createdBy}</td>
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
