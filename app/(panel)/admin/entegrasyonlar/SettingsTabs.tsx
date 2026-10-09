import Link from 'next/link';
import { getT } from '@/lib/i18n';
import { userCan } from '@/lib/permissions';
import type { CurrentUser } from '@/lib/auth/session';

/**
 * Yöneticinin "Ayarlar" sayfasının sekmeleri (Paket 6, karar 179; Paket 8, karar 192; Paket A, karar 219, 223):
 * Entegrasyonlar (SETTINGS_MANAGE ya da OPS_SETTINGS_MANAGE — Yönetici Yardımcısı yalnızca operasyonel bölümleri görür),
 * Tedarikçiler (SUPPLIER_MANAGE), Çalışma Takvimleri (OPS_SETTINGS_MANAGE) ve Giriş Logları (AUDIT_VIEW — yalnızca yönetici).
 * Sekme yalnızca görünüm kolaylığıdır — her sayfa kendi yetkisini ayrıca denetler.
 */
export async function SettingsTabs({ user, active }: { user: CurrentUser; active: 'integrations' | 'suppliers' | 'calendars' | 'logins' }) {
  const { t } = await getT();
  const tabs = [
    { key: 'integrations', href: '/admin/entegrasyonlar', label: t('supplier.settingsTabs.integrations'), show: userCan(user, 'SETTINGS_MANAGE') || userCan(user, 'OPS_SETTINGS_MANAGE') },
    { key: 'suppliers', href: '/admin/entegrasyonlar/tedarikciler', label: t('supplier.settingsTabs.suppliers'), show: userCan(user, 'SUPPLIER_MANAGE') },
    { key: 'calendars', href: '/admin/entegrasyonlar/takvimler', label: t('calendar.title'), show: userCan(user, 'OPS_SETTINGS_MANAGE') },
    { key: 'logins', href: '/admin/entegrasyonlar/giris-loglari', label: t('loginLog.title'), show: userCan(user, 'AUDIT_VIEW') },
  ].filter((x) => x.show);
  return (
    <div className="tabs" data-settings-tabs>
      {tabs.map((x) => (
        <Link key={x.key} href={x.href} className={x.key === active ? 'active' : undefined} aria-current={x.key === active ? 'page' : undefined}>{x.label}</Link>
      ))}
    </div>
  );
}
