import Link from 'next/link';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/format';
import { AV_STATUS_KEY, avHealth, getAvSettings } from '@/server/files/antivirus.js';
import { saveAntivirusAction, saveDailyRateAction, saveFgoAction, saveWarehouseAction, scanNowAction, testAntivirusAction, testFgoAction, testFxAction } from './actions';
import { getFgoSettings } from '@/server/integrations/fgo.js';
import { getDailyRate } from '@/server/fx/bt.js';
import { localDay } from '@/server/profile/dates.js';
import { getEnv } from '@/lib/env';
import { getWarehouseSettings } from '@/server/profile/warehouse.js';

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
  const [health, pendingFiles, pendingDrawings, infectedFiles, infectedDrawings, statusRow, blocked, pendingDrawingFiles, infectedDrawingFiles] = await Promise.all([
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
    db.drawingFile.count({ where: { scanStatus: 'PENDING' } }),
    db.drawingFile.findMany({ where: { scanStatus: 'INFECTED' }, orderBy: { scannedAt: 'desc' }, take: 20, include: { drawing: { select: { version: true, order: { select: { id: true, orderNo: true } } } } } }),
  ]);
  const quarantine = [
    ...infectedFiles.map((f) => ({ id: f.id, name: f.name, order: f.order, signature: f.scanSignature, at: f.scannedAt })),
    ...infectedDrawings.map((d) => ({ id: d.id, name: d.fileName ?? `v${d.version}`, order: d.order, signature: d.scanSignature, at: d.scannedAt })),
    ...infectedDrawingFiles.map((f) => ({ id: f.id, name: `v${f.drawing.version} · ${f.name}`, order: f.drawing.order, signature: f.scanSignature, at: f.scannedAt })),
  ].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const worker = (statusRow?.value ?? null) as { lastRun?: string } | null;
  const fxToday = localDay(new Date(), getEnv().APP_TIMEZONE);
  const [fgo, fgoPending, fgoFailed, daily] = await Promise.all([
    getFgoSettings(db),
    db.notificationOutbox.count({ where: { type: { in: ['FGO_PROFORMA', 'FGO_INVOICE'] }, status: 'PENDING' } }),
    db.notificationOutbox.count({ where: { type: { in: ['FGO_PROFORMA', 'FGO_INVOICE'] }, status: 'FAILED' } }),
    getDailyRate(db),
  ]);
  const [wh, whPending, whFailed] = await Promise.all([
    getWarehouseSettings(db),
    db.notificationOutbox.count({ where: { type: 'WAREHOUSE_EMAIL', status: 'PENDING' } }),
    db.notificationOutbox.count({ where: { type: 'WAREHOUSE_EMAIL', status: 'FAILED' } }),
  ]);

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
      {sp.ok === 'warehouse' && <div className="alert alert-ok">{t('profile.settings.saved')}</div>}
      {sp.error === 'warehouse' && <div className="alert alert-error">{t('profile.settings.bad', { list: sp.detail ?? '' })}</div>}

      {/* FGO (fatura sistemi; Aşama 6b) */}
      {sp.ok === 'fgo' && <div className="alert alert-ok">{t('admin.integrations.fgo.saved')}</div>}
      {sp.error === 'fgo' && <div className="alert alert-error">{t('admin.integrations.fgo.bad', { what: sp.detail ?? '' })}</div>}
      {sp.ok === 'fgoTest' && <div className="alert alert-ok">{t('admin.integrations.fgo.testOk', { message: sp.detail ?? '' })}{sp.types ? <> · {t('admin.integrations.fgo.types', { list: sp.types })}</> : null}</div>}
      {sp.error === 'fgoTest' && <div className="alert alert-error">{t('admin.integrations.fgo.testFailed', { message: sp.detail ?? '' })}{sp.types ? <> · {t('admin.integrations.fgo.types', { list: sp.types })}</> : null}</div>}
      {sp.ok === 'fx' && <div className="alert alert-ok">{t('admin.integrations.fgo.fxOk', { rate: sp.rate ?? '' })}</div>}
      {sp.error === 'fx' && <div className="alert alert-error">{t('admin.integrations.fgo.fxFailed', { error: sp.detail ?? '' })}</div>}
      <form action={saveFgoAction} className="card" id="fgo">
        <h2>{t('admin.integrations.fgo.title')}</h2>
        <p className="muted small">{t('admin.integrations.fgo.intro')}</p>
        <label className="check"><input type="checkbox" name="enabled" defaultChecked={fgo.enabled} /> {t('admin.integrations.fgo.enabled')}</label>
        <div className="grid" style={{ marginTop: 10 }}>
          <div>
            <label htmlFor="fgo-env">{t('admin.integrations.fgo.env')}</label>
            <select id="fgo-env" name="env" defaultValue={fgo.env}>
              <option value="test">{t('admin.integrations.fgo.envTest')}</option>
              <option value="prod">{t('admin.integrations.fgo.envProd')}</option>
            </select>
          </div>
          <div><label htmlFor="fgo-cui">{t('admin.integrations.fgo.cui')}</label><input id="fgo-cui" name="cui" defaultValue={fgo.cui} maxLength={12} /></div>
          <div>
            <label htmlFor="fgo-key">{t('admin.integrations.fgo.key')}</label>
            <input id="fgo-key" name="privateKey" type="password" autoComplete="new-password" placeholder={fgo.hasKey ? t('admin.integrations.fgo.keySaved') : ''} />
            <div className="hint">{fgo.hasKey ? t('admin.integrations.fgo.keyHintSaved') : t('admin.integrations.fgo.keyHint')}</div>
            {fgo.hasKey && <label className="check small"><input type="checkbox" name="clearKey" /> {t('admin.integrations.fgo.clearKey')}</label>}
          </div>
          <div><label htmlFor="fgo-ps">{t('admin.integrations.fgo.proformaSeries')}</label><input id="fgo-ps" name="proformaSeries" defaultValue={fgo.proformaSeries} maxLength={10} style={{ textTransform: 'uppercase' }} /></div>
          <div><label htmlFor="fgo-is">{t('admin.integrations.fgo.invoiceSeries')}</label><input id="fgo-is" name="invoiceSeries" defaultValue={fgo.invoiceSeries} maxLength={10} style={{ textTransform: 'uppercase' }} /></div>
          <div><label htmlFor="fgo-vat">{t('admin.integrations.fgo.vat')}</label><input id="fgo-vat" name="vatRate" inputMode="decimal" defaultValue={String(fgo.vatRate)} maxLength={5} /></div>
          <div><label htmlFor="fgo-pt">{t('admin.integrations.fgo.proformaType')}</label><input id="fgo-pt" name="proformaType" defaultValue={fgo.proformaType} maxLength={50} /><div className="hint">{t('admin.integrations.fgo.typeHint')}</div></div>
          <div><label htmlFor="fgo-it">{t('admin.integrations.fgo.invoiceType')}</label><input id="fgo-it" name="invoiceType" defaultValue={fgo.invoiceType} maxLength={50} /></div>
          <div><label htmlFor="fgo-fx">{t('admin.integrations.fgo.fxUrl')}</label><input id="fgo-fx" name="fxUrl" type="url" defaultValue={fgo.fxUrl} maxLength={300} /><div className="hint">{t('admin.integrations.fgo.fxHint')}</div></div>
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
          <span className={`small ${fgoFailed ? 'danger' : 'muted'}`}>{t('admin.integrations.fgo.queue', { pending: fgoPending, failed: fgoFailed })}</span>
          <button className="btn btn-primary">{t('admin.integrations.fgo.save')}</button>
        </div>
      </form>
      <div className="row" style={{ marginTop: -8, marginBottom: 16 }}>
        <form action={testFgoAction}><button className="btn">{t('admin.integrations.fgo.test')}</button></form>
        <form action={testFxAction}><button className="btn">{t('admin.integrations.fgo.testFx')}</button></form>
      </div>
      {sp.ok === 'fxDaily' && <div className="alert alert-ok">{t('admin.integrations.fgo.dailySaved', { rate: sp.rate ?? '' })}</div>}
      {sp.error === 'fxDaily' && <div className="alert alert-error">{t('admin.integrations.fgo.dailyBad')}</div>}
      <form action={saveDailyRateAction} className="card">
        <h2>{t('admin.integrations.fgo.dailyTitle')}</h2>
        <p className="muted small">{t('admin.integrations.fgo.dailyIntro')}</p>
        <div className="row">
          <label htmlFor="fx-daily" style={{ margin: 0 }}>{t('admin.integrations.fgo.dailyRate')}</label>
          <input id="fx-daily" name="rate" inputMode="decimal" maxLength={10} style={{ width: 120 }} defaultValue={daily?.day === fxToday ? daily.rate.toFixed(4) : ''} />
          <button className="btn btn-primary">{t('admin.integrations.fgo.dailySave')}</button>
          <span className="muted small">
            {daily?.day === fxToday ? t('admin.integrations.fgo.dailyToday', { rate: daily.rate.toFixed(4) })
              : daily ? t('admin.integrations.fgo.dailyOld', { rate: daily.rate.toFixed(4), day: daily.day.split('-').reverse().join('.') }) : t('admin.integrations.fgo.dailyNone')}
          </span>
        </div>
      </form>

      <form action={saveWarehouseAction} className="card" id="depo">
        <h2>{t('profile.settings.title')}</h2>
        <p className="muted small">{t('profile.settings.intro')}</p>
        <label htmlFor="wh-rcpt">{t('profile.settings.recipients')}</label>
        <input id="wh-rcpt" name="recipients" required defaultValue={wh.recipients.join(', ')} />
        <div className="hint">{t('profile.settings.recipientsHint')}</div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <span className={`small ${whFailed ? 'danger' : 'muted'}`}>{t('profile.settings.queue', { pending: whPending, failed: whFailed })}</span>
          <button className="btn btn-primary">{t('profile.settings.save')}</button>
        </div>
      </form>

      <div className="card" id="antivirus">
        <h2>{t('admin.integrations.av.title')}</h2>
        <p className="muted small">{t('admin.integrations.av.intro')}</p>
        <div className={`alert ${status.cls}`} style={{ marginTop: 8 }}>{status.text}</div>
        <p className="small">
          {t('admin.integrations.av.pending', { n: pendingFiles + pendingDrawings + pendingDrawingFiles })} ·{' '}
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
