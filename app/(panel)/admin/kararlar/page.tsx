import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDateTime, fmtNum } from '@/lib/format';
import { resolveAlertAction } from './actions';

type Diff = { line: number; kind: string; description: string; listPrice: number; unitPrice: number; free: boolean };
type Details = { orderNo?: string; currency?: string; lines?: Diff[]; error?: string };

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
        <div className="card-head"><h2 style={{ margin: 0 }}>{t('pricing.alerts.title')} <span className={`badge ${open.length ? 'badge-danger' : ''}`}>{open.length}</span></h2></div>
        {open.length === 0 ? <div className="empty">{t('pricing.alerts.empty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('pricing.alerts.colOrder')}</th><th>{t('pricing.alerts.colWhat')}</th><th>{t('pricing.alerts.colWho')}</th><th>{t('pricing.alerts.colWhen')}</th><th /></tr></thead>
              <tbody>
                {open.map((a) => (
                  <tr key={a.id}>
                    <td>{a.order ? <Link href={`/siparisler/${a.order.id}#teklif`}>{a.order.orderNo}</Link> : ((a.details ?? {}) as Details).orderNo ?? '—'}</td>
                    <td>{what(a)}</td>
                    <td>{a.createdBy?.name ?? '—'}</td>
                    <td className="nowrap">{fmtDateTime(a.createdAt)}</td>
                    <td className="actions">
                      <form action={resolveAlertAction}>
                        <input type="hidden" name="alertId" value={a.id} />
                        <button className="btn">{t('pricing.alerts.resolve')}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card card-flush">
        <div className="card-head"><h2 style={{ margin: 0 }}>{t('pricing.alerts.historyTitle')}</h2></div>
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
