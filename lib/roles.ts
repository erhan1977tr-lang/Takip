import type { AppRole } from '@prisma/client';

export const ROLE_LABEL: Record<AppRole, string> = {
  ADMIN: 'Sistem Yöneticisi',
  SATIS: 'Satış',
  CIZIM: 'Çizim Ekibi',
  MUSTERI: 'Müşteri',
};

export type NavItem = { href: string; label: string } | { section: string };

export const NAV: Record<AppRole, NavItem[]> = {
  ADMIN: [
    { section: 'Operasyon' },
    { href: '/siparisler', label: 'Siparişler' },
    { section: 'Kişiler' },
    { href: '/admin/users', label: 'Kullanıcılar' },
    { href: '/admin/firms', label: 'Müşteriler' },
    { section: 'Tanımlar' },
    { href: '/admin/katalog', label: 'Cam Kataloğu' },
  ],
  SATIS: [{ section: 'Operasyon' }, { href: '/siparisler', label: 'Siparişler' }],
  CIZIM: [{ section: 'Operasyon' }, { href: '/siparisler', label: 'Siparişler' }],
  MUSTERI: [{ section: 'Müşteri portalı' }, { href: '/siparisler', label: 'Siparişlerim' }],
};

export function homeFor(role: AppRole): string {
  return '/siparisler';
}
