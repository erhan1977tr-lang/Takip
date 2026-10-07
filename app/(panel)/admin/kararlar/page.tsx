import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDate, fmtDateTime, fmtNum } from '@/lib/format';
import { resolveAlertAction } from './actions';

type Diff = { line: number; kind: string; description: string; listPrice: number; unitPrice: number; free: boolean };
/**
 * Telafi camı uyarıları (karar 108, 157): glass = adet × cam, tier = kararın fiyat kademesi, normal / price = o kademedeki
 * fiyatlar (price boş: yönetici belirleyecek), mode = karar (bedelsiz / aynı fiyat / farklı fiyat), direct = teklif
 * yöneticiye uğramadan müşteriye gitti, source = kaynak siparişin adedi (düştüyse önce → sonra; düşmediyse nedeni).
 */
type Details = {
  orderNo?: string; currency?: string; lines?: Diff[]; error?: string; compensationId?: string; glass?: string; tier?: 'CUSTOMER' | 'SALES'; mode?: string;
  normal?: number | null; price?: number | null; destOrderNo?: string; day?: string; direct?: boolean;
  source?: { reduced?: boolean; reason?: string | null; before?: number | null; after?: number | null };
};
const COMP_MODES = ['FREE', 'NORMAL', 'CUSTOM'];
const SOURCE_REASONS = ['LOADED', 'BILLING', 'CLOSED'];

// Önemli kararlar: bir insan kararı bekleyen durumlar (şimdilik: satışçı liste fiyatını değiştirdi).
export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('ALERT_VIEW');
  const { t } = await getT();
  const sp = await searchParams;
  const include = {
    order: { select: { id: true, orderNo: true } },
    createdBy: { select: { name: true } },
    resolvedBy: { select: { name: true } },
  } as const;
  const [open, closed] = await Promise.all([
    db.adminAlert.findMany({ where: { resolvedAt: null }, orderBy: { createdAt: 'desc' }, include, take: 200 }),
    db.adminAlert.findMany({ where: { resolvedAt: { not: null } }, orderBy: { resolvedAt: 'desc' }, include, take: 20 }),
  ]);

  const what = (a: (typeof open)[number]) => {
    const d = (a.details ?? {}) as Details;
    return (
      <>
        <b>{t(`pricing.alerts.type.${a.type}` as MsgKey)}</b>
        <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {(d.lines ?? []).map((l) => (
            <li key={l.line}>
              {t('pricing.alerts.line', {
                n: l.line, kind: l.kind === 'CAM' ? t('pricing.alerts.kindGlass') : t(`status.lineKind.${l.kind}` as MsgKey),
                desc: l.description, list: fmtNum(l.listPrice), price: l.free ? t('pricing.alerts.free') : fmtNum(l.unitPrice), cur: l.free ? '' : d.currency ?? '',
              })}
            </li>
          ))}
          {d.error && <li>{t('pricing.alerts.error', { error: d.error })}</li>}
          {d.compensationId && (
            <li>{t('pricing.alerts.comp', { glass: d.glass ?? '', dest: d.destOrderNo ?? '—', date: d.day ? fmtDate(`${d.day}T12:00:00Z`) : '—' })}</li>
          )}
          {/* Karar (bedelsiz / aynı fiyat / farklı fiyat) — eski kayıtlarda yoksa satır yazılmaz */}
          {d.compensationId && d.mode && COMP_MODES.includes(d.mode) && (
            <li data-comp-mode={d.mode}>
              {t('pricing.alerts.compMode', { mode: t(`pricing.alerts.compModes.${d.mode}` as MsgKey) })}{d.direct ? ` — ${t('pricing.alerts.compDirect')}` : ''}
            </li>
          )}
          {d.compensationId && (a.type === 'COMPENSATION_PRICE' || d.mode === 'CUSTOM') && (
            <li>
              {t('pricing.alerts.compPrice', {
                normal: d.normal == null ? '—' : `${fmtNum(d.normal)} ${d.currency ?? ''}/m²`,
                price: d.mode === 'FREE' || d.price === 0 ? t('pricing.alerts.compFree') : d.price == null ? (d.mode === 'CUSTOM' ? t('pricing.alerts.compToPrice') : '—') : `${fmtNum(d.price)} ${d.currency ?? ''}/m²`,
              })}{d.tier ? ` (${t(`pricing.alerts.compTier.${d.tier}` as MsgKey)})` : ''}
            </li>
          )}
          {/* Kaynak siparişin adedi (karar 157) */}
          {d.compensationId && d.source && (d.source.reduced
            ? <li data-comp-source="dustu">{t('pricing.alerts.compSource', { before: d.source.before ?? '—', after: d.source.after ?? '—' })}</li>
            : d.source.reason && SOURCE_REASONS.includes(d.source.reason)
              ? <li data-comp-source={d.source.reason}>{t('pricing.alerts.compSourceKept', { reason: t(`pricing.alerts.compSourceReason.${d.source.reason}` as MsgKey) })}</li>
              : a.type === 'COMPENSATION_PENDING' ? <li data-comp-source="PENDING">{t('pricing.alerts.compSourcePending')}</li> : null)}
        </ul>
      </>
    );
  };

  return (
    <>
      <div className="page-head">
        <h1>{t('pricing.alerts.title')}</h1>
        <p className="muted">{t('pricing.alerts.intro')}</p>
      </div>
      {sp.ok === 'resolved' && <div className="alert alert-ok">{t('pricing.alerts.resolved')}</div>}
      <div className="card card-flush">
        <div className="card-head"><h2>{t('pricing.alerts.title')} <span className={`badge ${open.length ? 'badge-danger' : ''}`}>{open.length}</span></h2></div>
        {open.length === 0 ? <div className="empty">{t('pricing.alerts.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('pricing.alerts.colOrder')}</th><th>{t('pricing.alerts.colWhat')}</th><th>{t('pricing.alerts.colWho')}</th><th>{t('pricing.alerts.colWhen')}</th><th /></tr></thead>
              <tbody>
                {open.map((a) => (
                  <tr key={a.id}>
                    <td>{a.order ? <Link href={`/siparisler/${a.order.id}#${a.type.startsWith('COMPENSATION') ? 'kararlar' : 'teklif'}`}>{a.order.orderNo}</Link> : ((a.details ?? {}) as Details).orderNo ?? '—'}</td>
                    <td>{what(a)}</td>
                    <td>{a.createdBy?.name ?? '—'}</td>
                    <td className="nowrap">{fmtDateTime(a.createdAt)}</td>
                    <td className="actions">
                      {a.type === 'COMPENSATION_PENDING' && a.order ? (
                        // Onay bekleyen telafi "Gördüm" ile kapanmaz: karar siparişin "Önemli kararlar" kartında verilir
                        <Link className="btn btn-primary" href={`/siparisler/${a.order.id}#kararlar`}>{t('pricing.alerts.compOpen')}</Link>
                      ) : (
                        <form action={resolveAlertAction}>
                          <input type="hidden" name="alertId" value={a.id} />
                          <button className="btn">{t('pricing.alerts.resolve')}</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card card-flush">
        <div className="card-head"><h2>{t('pricing.alerts.historyTitle')}</h2></div>
        {closed.length === 0 ? <div className="empty">{t('pricing.alerts.historyEmpty')}</div> : (
          <div className="table-wrap">
            <table>
              <tbody>
                {closed.map((a) => (
                  <tr key={a.id}>
                    <td>{a.order ? <Link href={`/siparisler/${a.order.id}`}>{a.order.orderNo}</Link> : '—'}</td>
                    <td>{what(a)}</td>
                    <td>{a.createdBy?.name ?? '—'}</td>
                    <td className="muted small">
                      {a.resolvedBy ? t('pricing.alerts.closedBy', { who: a.resolvedBy.name, when: fmtDateTime(a.resolvedAt) }) : t('pricing.alerts.superseded')}
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
