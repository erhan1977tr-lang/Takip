import Link from 'next/link';
import { getT } from '@/lib/i18n';
import { userCan } from '@/lib/permissions';
import type { CurrentUser } from '@/lib/auth/session';

/**
 * Yöneticinin "Ayarlar" sayfasının sekmeleri (Paket 6, karar 179; Paket 8, karar 192): Entegrasyonlar (SETTINGS_MANAGE),
 * Tedarikçiler (SUPPLIER_MANAGE) ve Çalışma Takvimleri (SETTINGS_MANAGE). Sekme yalnızca görünüm kolaylığıdır — her sayfa
 * kendi yetkisini ayrıca denetler.
 */
export async function SettingsTabs({ user, active }: { user: CurrentUser; active: 'integrations' | 'suppliers' | 'calendars' }) {
  const { t } = await getT();
  const tabs = [
    { key: 'integrations', href: '/admin/entegrasyonlar', label: t('supplier.settingsTabs.integrations'), show: userCan(user, 'SETTINGS_MANAGE') },
    { key: 'suppliers', href: '/admin/entegrasyonlar/tedarikciler', label: t('supplier.settingsTabs.suppliers'), show: userCan(user, 'SUPPLIER_MANAGE') },
    { key: 'calendars', href: '/admin/entegrasyonlar/takvimler', label: t('calendar.title'), show: userCan(user, 'SETTINGS_MANAGE') },
  ].filter((x) => x.show);
  return (
    <div className="tabs" data-settings-tabs>
      {tabs.map((x) => (
        <Link key={x.key} href={x.href} className={x.key === active ? 'active' : undefined} aria-current={x.key === active ? 'page' : undefined}>{x.label}</Link>
      ))}
    </div>
  );
}
