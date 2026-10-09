import { requireUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT } from '@/lib/i18n';
import { saveSettingsAction } from './actions';

export const dynamic = 'force-dynamic';

// Kullanıcının kendi ayarları (Paket 9, karar 198 — bütün roller; müşteride sol menü → Ayarlar, iç ekipte → Hesap ayarları):
// dil (Otomatik / Türkçe / Română), bildirim sesi; müşteride ayrıca bildirim e-postaları. Kayıt: User.fixedLanguage
// (boş = Otomatik), User.notificationSound (zildeki anahtarla aynı kayıt), User.emailNotifications (yalnızca müşteri).
// Dil altyapısı (çerez, /dil, giriş dili) ve bildirim sistemi aynıdır; yalnızca oturumdaki kullanıcının kendi kaydı değişir.
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const { t, m } = await getT();
  const sp = await searchParams;
  // Bildirim e-postası tercihi müşteri hesabına aittir (iç ekibin iş e-postaları bu ayara bağlı değildir)
  const customerAccount = userCan(user, 'ACCOUNT_SETTINGS');
  return (
    <>
      <div className="page-head">
        <h1>{t(customerAccount ? 'settings.title' : 'settings.titleStaff')}</h1>
        <p className="muted">{t('settings.intro')}</p>
      </div>
      {sp.ok && <div className="alert alert-ok" role="status">{t('settings.saved')}</div>}
      <form action={saveSettingsAction} className="card" style={{ maxWidth: 560 }}>
        <div className="field">
          <label htmlFor="fixedLanguage">{t('settings.language')}</label>
          <select id="fixedLanguage" name="fixedLanguage" defaultValue={user.fixedLanguage ?? ''}>
            <option value="">{t('settings.languageNone')}</option>
            <option value="tr" lang="tr">{m.lang.tr}</option>
            <option value="ro" lang="ro">{m.lang.ro}</option>
          </select>
          <div className="hint">{t('settings.languageHint')}</div>
        </div>
        {customerAccount && (
          <div className="field">
            <label className="check">
              <input type="checkbox" name="emailNotifications" defaultChecked={user.emailNotifications} /> {t('settings.email')}
            </label>
            <div className="hint">{t('settings.emailHint')}</div>
          </div>
        )}
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
