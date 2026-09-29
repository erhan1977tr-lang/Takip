import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/format';
import { AV_STATUS_KEY, avHealth, getAvSettings } from '@/server/files/antivirus.js';
import { saveAntivirusAction, scanNowAction, testAntivirusAction } from './actions';

export const dynamic = 'force-dynamic';

const OK: Record<string, MsgKey> = {
  saved: 'admin.integrations.av.ok.saved',
  testOk: 'admin.integrations.av.ok.testOk',
  scanned: 'admin.integrations.av.ok.scanned',
};
const ERR: Record<string, MsgKey> = {
  testFailed: 'admin.integrations.av.errors.testFailed',
  testNotDetected: 'admin.integrations.av.errors.testNotDetected',
  scanStopped: 'admin.integrations.av.errors.scanStopped',
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requirePermission('SETTINGS_MANAGE');
  const { t } = await getT();
  const sp = await searchParams;
  const s = await getAvSettings(db);
  const [health, pendingFiles, pendingDrawings, infectedFiles, infectedDrawings, statusRow, blocked] = await Promise.all([
    s.enabled ? avHealth(s) : Promise.resolve(null),
    db.orderFile.count({ where: { scanStatus: 'PENDING' } }),
    db.drawing.count({ where: { scanStatus: 'PENDING' } }),
    db.orderFile.findMany({ where: { scanStatus: 'INFECTED' }, orderBy: { scannedAt: 'desc' }, take: 20, include: { order: { select: { id: true, orderNo: true } } } }),
    db.drawing.findMany({ where: { scanStatus: 'INFECTED' }, orderBy: { scannedAt: 'desc' }, take: 20, include: { order: { select: { id: true, orderNo: true } } } }),
    db.integrationSetting.findUnique({ where: { key: AV_STATUS_KEY } }),
    db.auditLog.findMany({
      where: { action: 'FILE_INFECTED', entityType: 'Upload' }, orderBy: { createdAt: 'desc' }, take: 10,
      include: { user: { select: { name: true, email: true } } },
    }),
  ]);
  const quarantine = [
    ...infectedFiles.map((f) => ({ id: f.id, name: f.name, order: f.order, signature: f.scanSignature, at: f.scannedAt })),
    ...infectedDrawings.map((d) => ({ id: d.id, name: d.fileName ?? `v${d.version}`, order: d.order, signature: d.scanSignature, at: d.scannedAt })),
  ].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const worker = (statusRow?.value ?? null) as { lastRun?: string } | null;

  const okMsg = sp.ok && OK[sp.ok] ? t(OK[sp.ok], { signature: sp.signature ?? '', scanned: sp.scanned ?? '0', clean: sp.clean ?? '0', infected: sp.infected ?? '0' }) : null;
  const errMsg = sp.error && ERR[sp.error] ? t(ERR[sp.error], { error: sp.detail ?? '' }) : null;
  const status = !s.enabled
    ? { cls: 'alert-warn', text: t('admin.integrations.av.statusOff') }
    : health?.reachable
      ? { cls: 'alert-ok', text: t('admin.integrations.av.statusOk', { engine: health.engine ?? 'ClamAV', date: health.signaturesDate ?? '—' }) }
      : { cls: 'alert-error', text: t('admin.integrations.av.statusDown', { host: s.host, port: s.port }) };

  return (
    <>
      <div className="page-head">
        <h1>{t('admin.integrations.title')}</h1>
        <p className="muted">{t('admin.integrations.intro')}</p>
      </div>
      {okMsg && <div className="alert alert-ok">{okMsg}</div>}
      {errMsg && <div className="alert alert-error">{errMsg}</div>}

      <div className="card" id="antivirus">
        <h2>{t('admin.integrations.av.title')}</h2>
        <p className="muted small">{t('admin.integrations.av.intro')}</p>
        <div className={`alert ${status.cls}`} style={{ marginTop: 8 }}>{status.text}</div>
        <p className="small">
          {t('admin.integrations.av.pending', { n: pendingFiles + pendingDrawings })} ·{' '}
          {t('admin.integrations.av.infected', { n: quarantine.length })} ·{' '}
          {worker?.lastRun ? t('admin.integrations.av.lastRun', { when: fmtDateTime(worker.lastRun) }) : t('admin.integrations.av.lastRunNever')}
        </p>

        <form action={saveAntivirusAction} style={{ marginTop: 12 }}>
          <label className="check"><input type="checkbox" name="enabled" defaultChecked={s.enabled} /> {t('admin.integrations.av.enabled')}</label>
          <div className="grid-2" style={{ marginTop: 10 }}>
            <div><label htmlFor="av-host">{t('admin.integrations.av.host')}</label><input id="av-host" name="host" type="text" defaultValue={s.host} maxLength={200} /></div>
            <div><label htmlFor="av-port">{t('admin.integrations.av.port')}</label><input id="av-port" name="port" type="number" min={1} max={65535} defaultValue={s.port} /></div>
          </div>
          <fieldset style={{ marginTop: 10, border: 0, padding: 0 }}>
            <legend className="small"><b>{t('admin.integrations.av.onUnavailable')}</b></legend>
            <label className="check"><input type="radio" name="onUnavailable" value="accept" defaultChecked={s.onUnavailable === 'accept'} /> {t('admin.integrations.av.accept')}</label>
            <label className="check"><input type="radio" name="onUnavailable" value="reject" defaultChecked={s.onUnavailable === 'reject'} /> {t('admin.integrations.av.reject')}</label>
          </fieldset>
          <div className="row" style={{ marginTop: 12 }}><button className="btn btn-primary">{t('admin.integrations.av.save')}</button></div>
        </form>
        <div className="row" style={{ marginTop: 12 }}>
          <form action={testAntivirusAction}><button className="btn">{t('admin.integrations.av.test')}</button></form>
          <form action={scanNowAction}><button className="btn">{t('admin.integrations.av.scanNow')}</button></form>
        </div>
      </div>

      <div className="card card-flush">
        <div className="card-head"><h2 style={{ margin: 0 }}>{t('admin.integrations.av.quarantineTitle')}</h2></div>
        {quarantine.length === 0 ? <div className="empty">{t('admin.integrations.av.quarantineEmpty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('admin.integrations.av.cols.file')}</th><th>{t('admin.integrations.av.cols.order')}</th><th>{t('admin.integrations.av.cols.signature')}</th><th>{t('admin.integrations.av.cols.date')}</th></tr></thead>
              <tbody>
                {quarantine.map((q) => (
                  <tr key={q.id}>
                    <td>{q.name}</td>
                    <td><Link className="order-no" href={`/siparisler/${q.order.id}`}>{q.order.orderNo}</Link></td>
                    <td className="mono small">{q.signature}</td>
                    <td>{fmtDateTime(q.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card card-flush">
        <div className="card-head"><h2 style={{ margin: 0 }}>{t('admin.integrations.av.blockedTitle')}</h2></div>
        {blocked.length === 0 ? <div className="empty">{t('admin.integrations.av.blockedEmpty')}</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('admin.integrations.av.cols.file')}</th><th>{t('admin.integrations.av.cols.user')}</th><th>{t('admin.integrations.av.cols.signature')}</th><th>{t('admin.integrations.av.cols.date')}</th></tr></thead>
              <tbody>
                {blocked.map((b) => {
                  const d = (b.details ?? {}) as { name?: string; signature?: string };
                  return (
                    <tr key={b.id}>
                      <td>{d.name ?? '—'}</td>
                      <td>{b.user?.name || b.user?.email || '—'}</td>
                      <td className="mono small">{d.signature ?? '—'}</td>
                      <td>{fmtDateTime(b.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
