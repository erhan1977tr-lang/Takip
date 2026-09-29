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
    { href: '/yuklemeler', key: 'nav.loadings' },
    { section: 'nav.people' },
    { href: '/admin/users', key: 'nav.users' },
    { href: '/admin/firms', key: 'nav.firms' },
    { section: 'nav.definitions' },
    { href: '/admin/katalog', key: 'nav.catalog' },
  ],
  SATIS: [
    { section: 'nav.operations' },
    { href: '/siparisler', key: 'nav.orders' },
    { href: '/teklifler', key: 'nav.offers' },
    { href: '/yuklemeler', key: 'nav.loadings' },
  ],
  CIZIM: [{ section: 'nav.operations' }, { href: '/siparisler', key: 'nav.orders' }],
  MUSTERI: [
    { section: 'nav.customerPortal' },
    { href: '/siparisler', key: 'nav.myOrders' },
    { href: '/siparisler/yeni', key: 'nav.newOrder' },
    { href: '/teklifler', key: 'nav.myOffers' },
    { href: '/yuklemeler', key: 'nav.myLoadings' },
  ],
};

// Tüm roller ortak adresle başlar (karar 6); sayfa role göre içerik gösterir.
export function homeFor(_role: AppRole): string {
  return '/siparisler';
}
