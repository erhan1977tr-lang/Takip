import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/format';
import { getEnv } from '@/lib/env';
import { ANNOUNCEMENT_TZ, announcementStatus, defaultSendAt } from '@/server/push/announce.js';
import { renderAnnouncementPwa } from '@/server/mail/templates/announcement-pwa.js';
import { queueAnnouncementAction, rescheduleAnnouncementAction } from './actions';

export const dynamic = 'force-dynamic';

const ERR: Record<string, MsgKey> = {
  CONFIRM: 'admin.announce.errors.CONFIRM',
  SEND_AT: 'admin.announce.errors.SEND_AT',
  ADDRESS: 'admin.announce.errors.ADDRESS',
  ALREADY: 'admin.announce.errors.ALREADY',
  NO_RECIPIENTS: 'admin.announce.errors.NO_RECIPIENTS',
  FORBIDDEN: 'admin.announce.errors.FORBIDDEN',
  NOT_QUEUED: 'admin.announce.errors.NOT_QUEUED',
  NOTHING_PENDING: 'admin.announce.errors.NOTHING_PENDING',
};

// Müşterilere tek seferlik bilgi e-postası: önizleme + alıcı sayısı → onay → Gönder (4.2.33, karar 331).
// Sayfa hiçbir şey yazmaz; gönderim işçide, alıcı başına en çok bir ileti.
export default async function AnnouncementPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePermission('USER_MANAGE');
  const { t } = await getT();
  const sp = await searchParams;
  const st = await announcementStatus(db, await actorOf(user));
  if (!st.ok) return null;
  const appUrl = getEnv().APP_URL || '';
  const previews = (['ro'] as const).map((lang) => ({ lang, mail: renderAnnouncementPwa({ lang, name: null, appUrl }) }));
  const errKey = sp.error ? ERR[sp.error] : undefined;
  const def = defaultSendAt();
  // Gönderim zamanı her zaman Romanya saatiyle gösterilir (ayardan bağımsız)
  const roTime = (iso: string | null) => (iso ? new Intl.DateTimeFormat('tr-TR', { timeZone: ANNOUNCEMENT_TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '—');
  return (
    <>
      <h1>{t('admin.announce.title')}</h1>
      <p className="muted">{t('admin.announce.intro')}</p>
      {sp.ok && <div className="alert alert-ok">{t('admin.announce.queued', { n: sp.ok.replace(/\D/g, ''), at: roTime(st.sendAt) })}</div>}
      {sp.moved && <div className="alert alert-ok" data-announce-moved>{t('admin.announce.moved', { n: sp.moved.replace(/\D/g, ''), at: roTime(st.sendAt) })}</div>}
      {errKey && <div className="alert alert-error">{t(errKey)}</div>}
      <section className="card" data-announce-status>
        <h2>{t('admin.announce.recipientsTitle')}</h2>
        <p data-announce-count={st.recipients.total}>
          {t('admin.announce.recipients', { total: st.recipients.total })}
        </p>
        <p className="muted small">{t('admin.announce.recipientsRule')}</p>
        {st.queuedAt
          ? (
            <div className="alert alert-info" data-announce-done>
              {t('admin.announce.alreadyQueued', { at: fmtDateTime(st.queuedAt), sendAt: roTime(st.sendAt) })}{' '}
              {t('admin.announce.jobs', { sent: st.jobs.sent, pending: st.jobs.pending, failed: st.jobs.failed, skipped: st.jobs.skipped })}
            </div>
          )
          : null}
        {st.queuedAt && st.jobs.pending > 0 && (
          <form action={rescheduleAnnouncementAction} className="stack" data-announce-reschedule>
            <h3>{t('admin.announce.rescheduleTitle')}</h3>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="field">{t('admin.announce.sendAtLabel')}
                <input type="date" name="day" defaultValue={def.day} required data-announce-day />
              </label>
              <label className="field">&nbsp;
                <input type="time" name="time" defaultValue={def.time} required data-announce-time />
              </label>
            </div>
            <p className="muted small">{t('admin.announce.sendAtHint')}</p>
            <label className="check"><input type="checkbox" name="confirm" required /> {t('admin.announce.rescheduleConfirm')}</label>
            <div><button className="btn btn-primary" data-announce-reschedule-btn>{t('admin.announce.reschedule')}</button></div>
          </form>
        )}
        {st.queuedAt
          ? null
          : (
            <form action={queueAnnouncementAction} className="stack" id="duyuru-form" data-announce-form>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label className="field">{t('admin.announce.sendAtLabel')}
                  <input type="date" name="day" defaultValue={def.day} required data-announce-day />
                </label>
                <label className="field">&nbsp;
                  <input type="time" name="time" defaultValue={def.time} required data-announce-time />
                </label>
              </div>
              <p className="muted small">{t('admin.announce.sendAtHint')}</p>
              <label className="check"><input type="checkbox" name="confirm" required /> {t('admin.announce.confirm', { total: st.recipients.total })}</label>
              <div><button className="btn btn-primary" disabled={st.recipients.total === 0} data-announce-send>{t('admin.announce.send')}</button></div>
            </form>
          )}
      </section>
      <section className="card" data-announce-list>
        <p className="muted small">{t('admin.announce.addrHint')}</p>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>{t('admin.announce.colFirm')}</th><th>{t('admin.announce.colEmail')}</th><th>{t('admin.announce.colSource')}</th></tr></thead>
            <tbody>
              {st.list.map((r, i) => (
                <tr key={r.to} data-announce-to={r.to}>
                  <td>{i + 1}</td>
                  <td>{r.firms.join(', ')}</td>
                  <td className="mono">
                    {st.queuedAt
                      ? r.to
                      : (
                        <input type="email" form="duyuru-form" name={`addr_${r.customerIds[0]}`} defaultValue={r.to}
                          aria-label={t('admin.announce.colEmail')} data-announce-addr={r.customerIds[0]} />
                      )}
                  </td>
                  <td>{t(r.source === 'BILLING' ? 'admin.announce.sourceBILLING' : r.source === 'OVERRIDE' ? 'admin.announce.sourceOVERRIDE' : 'admin.announce.sourceFIRM')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {st.missing.length > 0 && (
          <div className="alert alert-warn" data-announce-missing>
            <strong>{t('admin.announce.missingTitle', { n: st.missing.length })}</strong> {st.missing.join(', ')}
            <div className="small">{t('admin.announce.missingHint')}</div>
          </div>
        )}
      </section>
      {previews.map(({ lang, mail }) => (
        <section className="card" key={lang} data-announce-preview={lang}>
          <h2>{t('admin.announce.previewRo')}</h2>
          <p><strong>{t('admin.announce.subject')}:</strong> {mail.subject}</p>
          <pre className="pre">{mail.text}</pre>
        </section>
      ))}
    </>
  );
}
