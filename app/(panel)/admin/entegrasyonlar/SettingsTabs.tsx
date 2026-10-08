import Link from 'next/link';
import { getT } from '@/lib/i18n';
import { userCan } from '@/lib/permissions';
import type { CurrentUser } from '@/lib/auth/session';

/**
 * Yöneticinin "Ayarlar" sayfasının sekmeleri (Paket 6, karar 179): Entegrasyonlar (SETTINGS_MANAGE) ve Tedarikçiler
 * (SUPPLIER_MANAGE). Sekme yalnızca görünüm kolaylığıdır — her sayfa kendi yetkisini ayrıca denetler.
 */
export async function SettingsTabs({ user, active }: { user: CurrentUser; active: 'integrations' | 'suppliers' }) {
  const { t } = await getT();
  const tabs = [
    { key: 'integrations', href: '/admin/entegrasyonlar', label: t('supplier.settingsTabs.integrations'), show: userCan(user, 'SETTINGS_MANAGE') },
    { key: 'suppliers', href: '/admin/entegrasyonlar/tedarikciler', label: t('supplier.settingsTabs.suppliers'), show: userCan(user, 'SUPPLIER_MANAGE') },
  ].filter((x) => x.show);
  return (
    <div className="tabs" data-settings-tabs>
      {tabs.map((x) => (
        <Link key={x.key} href={x.href} className={x.key === active ? 'active' : undefined} aria-current={x.key === active ? 'page' : undefined}>{x.label}</Link>
      ))}
    </div>
  );
}
