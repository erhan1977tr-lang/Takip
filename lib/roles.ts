import type { AppRole } from '@prisma/client';
import type { MsgKey } from './i18n';

// Rol adları sözlükte: roles.<ROL> (lib/labels.ts → roleText)

/** Sunucuda sayılan menü sayaçları (panel düzeni hesaplar): profileNew — yöneticinin fiyatını bekleyen yeni profil siparişi */
export type NavCount = 'profileNew';
/**
 * Menü tanımı (metinler sözlük anahtarı; panel düzeni çevirir). Bölüm sayacı (count) yan menüde bölüm adının yanında; telefonda
 * bölüm adı çizilmediği için aynı sayaç bölümün bağlantısında (mobileCount) görünür.
 */
export type NavDef = { href: string; key: MsgKey; mobileCount?: NavCount } | { section: MsgKey; count?: NavCount };
/** Çevrilmiş menü öğesi (NavLinks bileşenine giden) */
export type NavItem =
  | { href: string; label: string; count?: number; countLabel?: string; mobileCount?: number }
  | { section: string; count?: number; countLabel?: string };

export const NAV: Record<AppRole, NavDef[]> = {
  ADMIN: [
    { section: 'nav.operations' },
    { href: '/siparisler', key: 'nav.orders' },
    { href: '/teklifler', key: 'nav.offers' },
    { href: '/admin/kararlar', key: 'nav.alerts' },
    { href: '/yuklemeler', key: 'nav.loadings' },
    // Profil siparişleri (Yönetici Paneli Paketi 1, karar 216): profil tabloları ve profil tanımları tek bölümde. Bölüm adının
    // yanında yeni profil siparişi sayacı (fiyat bekleyen — server/orders/queues.js → newProfileCount; telefonda bağlantıda)
    { section: 'nav.profileOrders', count: 'profileNew' },
    { href: '/siparisler?view=profil', key: 'nav.profileOrderList', mobileCount: 'profileNew' },
    { href: '/admin/profil-katalogu', key: 'nav.profileCatalog' },
    // Profil hesaplayıcısının sistemleri, kalemleri ve cam kalınlıkları (Paket 5, karar 175)
    { href: '/admin/profil-katalogu/hesaplama', key: 'nav.profileCalc' },
    { href: '/admin/profil-fiyatlari', key: 'nav.profilePrices' },
    { href: '/admin/stok', key: 'nav.stock' },
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
    // "Ayarlar" (eski adı "Entegrasyonlar"): Entegrasyonlar ve Tedarikçiler sekmeleri — karar 179
    { href: '/admin/entegrasyonlar', key: 'nav.adminSettings' },
    // Kendi hesap ayarları (dil, ses — Paket 9, karar 198); bütün iç roller
    { section: 'nav.account' },
    { href: '/ayarlar', key: 'nav.mySettings' },
  ],
  SATIS: [
    { section: 'nav.operations' },
    { href: '/siparisler', key: 'nav.orders' },
    { href: '/teklifler', key: 'nav.offers' },
    { href: '/yuklemeler', key: 'nav.loadings' },
    { section: 'nav.account' },
    { href: '/ayarlar', key: 'nav.mySettings' },
  ],
  CIZIM: [
    { section: 'nav.operations' },
    { href: '/siparisler', key: 'nav.orders' },
    // Müşterinin DWG/DXF olarak gönderdiği çizimler: üç karar (Üretime Hazır / Çizim Hatalı / Çizimi Güncelle) — karar 167
    { href: '/siparisler?view=dwg', key: 'nav.dwgDrawings' },
    { section: 'nav.account' },
    { href: '/ayarlar', key: 'nav.mySettings' },
  ],
  // Denetimci yalnızca görüntüler (karar 8); profil stoğunu salt okunur görür (karar 177 — STOCK_VIEW)
  DENETIMCI: [
    { section: 'nav.operations' },
    { href: '/siparisler', key: 'nav.orders' },
    { href: '/teklifler', key: 'nav.offers' },
    { href: '/yuklemeler', key: 'nav.loadings' },
    { href: '/admin/stok', key: 'nav.stock' },
    { section: 'nav.account' },
    { href: '/ayarlar', key: 'nav.mySettings' },
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
