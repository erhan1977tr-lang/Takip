import type { AppRole } from '@prisma/client';
import type { MsgKey } from './i18n';

// Rol adları sözlükte: roles.<ROL> (lib/labels.ts → roleText)

/** Menü tanımı (metinler sözlük anahtarı; panel düzeni çevirir). */
export type NavDef = { href: string; key: MsgKey } | { section: MsgKey };
/** Çevrilmiş menü öğesi (NavLinks bileşenine giden) */
export type NavItem = { href: string; label: string } | { section: string };

export const NAV: Record<AppRole, NavDef[]> = {
  ADMIN: [
    { section: 'nav.operations' },
    { href: '/siparisler', key: 'nav.orders' },
    { href: '/teklifler', key: 'nav.offers' },
    { href: '/admin/kararlar', key: 'nav.alerts' },
    { href: '/yuklemeler', key: 'nav.loadings' },
    { section: 'nav.accounting' },
    { href: '/admin/muhasebe/profil', key: 'nav.profileReceivables' },
    { href: '/admin/muhasebe/cam', key: 'nav.glassReceivables' },
    { href: '/admin/muhasebe/tedarikci', key: 'nav.supplier' },
    { section: 'nav.people' },
    { href: '/admin/users', key: 'nav.users' },
    { href: '/admin/firms', key: 'nav.firms' },
    { section: 'nav.definitions' },
    { href: '/admin/katalog', key: 'nav.catalog' },
    { href: '/admin/fiyatlar', key: 'nav.prices' },
    { href: '/admin/musteri-fiyatlari', key: 'nav.customerPrices' },
    { href: '/admin/profil-katalogu', key: 'nav.profileCatalog' },
    { href: '/admin/profil-fiyatlari', key: 'nav.profilePrices' },
    { href: '/admin/stok', key: 'nav.stock' },
    { href: '/admin/entegrasyonlar', key: 'nav.integrations' },
  ],
  SATIS: [
    { section: 'nav.operations' },
    { href: '/siparisler', key: 'nav.orders' },
    { href: '/teklifler', key: 'nav.offers' },
    { href: '/yuklemeler', key: 'nav.loadings' },
  ],
  CIZIM: [{ section: 'nav.operations' }, { href: '/siparisler', key: 'nav.orders' }],
  // Denetimci yalnızca görüntüler (karar 8)
  DENETIMCI: [
    { section: 'nav.operations' },
    { href: '/siparisler', key: 'nav.orders' },
    { href: '/teklifler', key: 'nav.offers' },
    { href: '/yuklemeler', key: 'nav.loadings' },
  ],
  MUSTERI: [
    { section: 'nav.customerPortal' },
    { href: '/siparisler', key: 'nav.myOrders' },
    { href: '/siparisler/yeni', key: 'nav.newOrder' },
    { href: '/teklifler', key: 'nav.myOffers' },
    { href: '/yuklemeler', key: 'nav.myLoadings' },
    { href: '/belgeler', key: 'nav.financeDocs' },
    { href: '/ayarlar', key: 'nav.settings' },
  ],
};

// Tüm roller ortak adresle başlar (karar 6); sayfa role göre içerik gösterir.
export function homeFor(_role: AppRole): string {
  return '/siparisler';
}
