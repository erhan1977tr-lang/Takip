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
    // Çizim ekibinin paneli (aynı sayfa, aynı kuyruklar; yönetici tam firma adlarını görür) — siparisler/page.tsx
    { section: 'nav.drawingTeam' },
    { href: '/siparisler?panel=cizim', key: 'nav.drawingPanel' },
    // Müşterinin DWG/DXF çizimleri için çizimci kararı (karar 167) — çizim ekibinin aynı listesi
    { href: '/siparisler?panel=cizim&view=dwg', key: 'nav.dwgDrawings' },
    { section: 'nav.accounting' },
    { href: '/admin/muhasebe/profil', key: 'nav.profileReceivables' },
    { href: '/admin/muhasebe/cam', key: 'nav.glassReceivables' },
    { href: '/admin/muhasebe/tedarikci', key: 'nav.supplier' },
    // Satın alma (Paket 6, kararlar 179–184): profil / aksesuar tedarikçi siparişleri ve hesapları — yalnızca SUPPLIER_MANAGE
    { section: 'nav.purchasing' },
    { href: '/siparisler/tedarik', key: 'nav.supplierOrders' },
    { href: '/admin/muhasebe/tedarikciler', key: 'nav.supplierAccounts' },
    { section: 'nav.people' },
    { href: '/admin/users', key: 'nav.users' },
    { href: '/admin/firms', key: 'nav.firms' },
    { section: 'nav.definitions' },
    { href: '/admin/katalog', key: 'nav.catalog' },
    { href: '/admin/fiyatlar', key: 'nav.prices' },
    { href: '/admin/musteri-fiyatlari', key: 'nav.customerPrices' },
    { href: '/admin/profil-katalogu', key: 'nav.profileCatalog' },
    // Profil hesaplayıcısının sistemleri, kalemleri ve cam kalınlıkları (Paket 5, karar 175)
    { href: '/admin/profil-katalogu/hesaplama', key: 'nav.profileCalc' },
    { href: '/admin/profil-fiyatlari', key: 'nav.profilePrices' },
    { href: '/admin/stok', key: 'nav.stock' },
    // "Ayarlar" (eski adı "Entegrasyonlar"): Entegrasyonlar ve Tedarikçiler sekmeleri — karar 179
    { href: '/admin/entegrasyonlar', key: 'nav.adminSettings' },
  ],
  SATIS: [
    { section: 'nav.operations' },
    { href: '/siparisler', key: 'nav.orders' },
    { href: '/teklifler', key: 'nav.offers' },
    { href: '/yuklemeler', key: 'nav.loadings' },
  ],
  CIZIM: [
    { section: 'nav.operations' },
    { href: '/siparisler', key: 'nav.orders' },
    // Müşterinin DWG/DXF olarak gönderdiği çizimler: üç karar (Üretime Hazır / Çizim Hatalı / Çizimi Güncelle) — karar 167
    { href: '/siparisler?view=dwg', key: 'nav.dwgDrawings' },
  ],
  // Denetimci yalnızca görüntüler (karar 8); profil stoğunu salt okunur görür (karar 177 — STOCK_VIEW)
  DENETIMCI: [
    { section: 'nav.operations' },
    { href: '/siparisler', key: 'nav.orders' },
    { href: '/teklifler', key: 'nav.offers' },
    { href: '/yuklemeler', key: 'nav.loadings' },
    { href: '/admin/stok', key: 'nav.stock' },
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
