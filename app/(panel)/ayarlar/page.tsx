import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { saveSettingsAction } from './actions';

export const dynamic = 'force-dynamic';

// Müşterinin kendi ayarları (sol menü → Ayarlar): sabit dil, bildirim e-postaları ve bildirim sesi. Kayıt:
// User.fixedLanguage, User.emailNotifications, User.notificationSound (ses tercihi zildeki anahtarla aynı kayıttır). Dil altyapısı (çerez, /dil) ve bildirim sistemi (server/notifications/email.js) aynıdır.
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const user = await requirePermission('ACCOUNT_SETTINGS');
  const { t, m } = await getT();
  const sp = await searchParams;
  return (
    <>
      <div className="page-head">
        <h1>{t('settings.title')}</h1>
        <p className="muted">{t('settings.intro')}</p>
      </div>
      {sp.ok && <div className="alert alert-ok">{t('settings.saved')}</div>}
      <form action={saveSettingsAction} className="card" style={{ maxWidth: 560 }}>
        <div className="field">
          <label htmlFor="fixedLanguage">{t('settings.language')}</label>
          <select id="fixedLanguage" name="fixedLanguage" defaultValue={user.fixedLanguage ?? ''}>
            <option value="">{t('settings.languageNone')}</option>
            <option value="ro" lang="ro">{m.lang.ro}</option>
            <option value="tr" lang="tr">{m.lang.tr}</option>
          </select>
          <div className="hint">{t('settings.languageHint')}</div>
        </div>
        <div className="field">
          <label className="check">
            <input type="checkbox" name="emailNotifications" defaultChecked={user.emailNotifications} /> {t('settings.email')}
          </label>
          <div className="hint">{t('settings.emailHint')}</div>
        </div>
        <div className="field">
          <label className="check">
            <input type="checkbox" name="notificationSound" defaultChecked={user.notificationSound} /> {t('settings.sound')}
          </label>
          <div className="hint">{t('settings.soundHint')}</div>
        </div>
        <div className="row end"><button className="btn btn-primary">{t('settings.save')}</button></div>
      </form>
    </>
  );
}
