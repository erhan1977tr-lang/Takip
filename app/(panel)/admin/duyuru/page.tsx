import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/format';
import { getEnv } from '@/lib/env';
import { announcementStatus } from '@/server/push/announce.js';
import { renderAnnouncementPwa } from '@/server/mail/templates/announcement-pwa.js';
import { queueAnnouncementAction } from './actions';

export const dynamic = 'force-dynamic';

const ERR: Record<string, MsgKey> = {
  CONFIRM: 'admin.announce.errors.CONFIRM',
  ALREADY: 'admin.announce.errors.ALREADY',
  NO_RECIPIENTS: 'admin.announce.errors.NO_RECIPIENTS',
  FORBIDDEN: 'admin.announce.errors.FORBIDDEN',
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
  const previews = (['tr', 'ro'] as const).map((lang) => ({ lang, mail: renderAnnouncementPwa({ lang, name: null, appUrl }) }));
  const errKey = sp.error ? ERR[sp.error] : undefined;
  return (
    <>
      <h1>{t('admin.announce.title')}</h1>
      <p className="muted">{t('admin.announce.intro')}</p>
      {sp.ok && <div className="alert alert-ok">{t('admin.announce.queued', { n: sp.ok.replace(/\D/g, '') })}</div>}
      {errKey && <div className="alert alert-error">{t(errKey)}</div>}
      <section className="card" data-announce-status>
        <h2>{t('admin.announce.recipientsTitle')}</h2>
        <p data-announce-count={st.recipients.total}>
          {t('admin.announce.recipients', { total: st.recipients.total, tr: st.recipients.tr, ro: st.recipients.ro })}
        </p>
        <p className="muted small">{t('admin.announce.recipientsRule')}</p>
        {st.queuedAt
          ? (
            <div className="alert alert-info" data-announce-done>
              {t('admin.announce.alreadyQueued', { at: fmtDateTime(st.queuedAt) })}{' '}
              {t('admin.announce.jobs', { sent: st.jobs.sent, pending: st.jobs.pending, failed: st.jobs.failed, skipped: st.jobs.skipped })}
            </div>
          )
          : (
            <form action={queueAnnouncementAction} className="stack" data-announce-form>
              <label className="check"><input type="checkbox" name="confirm" required /> {t('admin.announce.confirm', { total: st.recipients.total })}</label>
              <div><button className="btn btn-primary" disabled={st.recipients.total === 0} data-announce-send>{t('admin.announce.send')}</button></div>
            </form>
          )}
      </section>
      {previews.map(({ lang, mail }) => (
        <section className="card" key={lang} data-announce-preview={lang}>
          <h2>{t(lang === 'tr' ? 'admin.announce.previewTr' : 'admin.announce.previewRo')}</h2>
          <p><strong>{t('admin.announce.subject')}:</strong> {mail.subject}</p>
          <pre className="pre">{mail.text}</pre>
        </section>
      ))}
    </>
  );
}
