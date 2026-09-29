// Rol → yetki matrisi: kim neyi görebilir ve yapabilir (ADR 0003). TEK kaynak budur;
// sayfalar ve server action'lar rol adına değil yetkiye bakar. Veritabanındaki Role/RolePermission
// satırları bu tablodan seed edilir (prisma/seed/data/roles.js).
//
// Kararlar: Denetimci yalnızca görüntüler (karar 8), müşteriye gönderilmiş teklifi ve iç notları görür;
// satış iptal edemez (karar 3); yönetici fiyatını yönetici, müşteri ve denetimci dışında kimse görmez (karar 4).

export const ROLES = ['ADMIN', 'SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI'];

/** Yetki → açıklama (belgeleme ve yönetici ekranı için). */
export const PERMISSIONS = {
  ORDER_VIEW: 'Siparişleri görür (kapsamı role göre)',
  ORDER_CREATE: 'Yeni sipariş verir',
  ORDER_REVIEW: 'Satış kararları: çizime gönderme, bekletme, yükleme tarihi, sandık, yüklendi, arşiv',
  ORDER_CANCEL: 'Siparişi iptal eder',
  DRAWING_WORK: 'Çizim başlatır ve çizim sürümü yükler',
  DRAWING_APPROVE: 'Çizimi onaylar ya da revizyon ister (müşteri; onay için ayrıca onay yetkisi gerekir)',
  OFFER_VIEW: 'Teklifleri görür',
  OFFER_DRAFT_VIEW: 'Müşteriye gönderilmemiş (hazırlanan) teklifleri görür',
  OFFER_PREPARE: 'Teklif hazırlar ve yöneticiye gönderir',
  OFFER_SEND: 'Fiyatı onaylar, teklifi müşteriye gönderir, gönderilmiş teklifi günceller',
  PRICE_FINAL_VIEW: 'Müşteriye giden (yönetici) fiyatı görür',
  SHIPMENT_VIEW: 'Yükleme takvimini görür',
  CRATE_EDIT: 'Yükleme sekmesinde sandık ölçü ve ağırlıklarını girer',
  FILE_UPLOAD: 'Siparişe dosya ekler',
  FILE_INTERNAL_VIEW: 'İç ekip dosyalarını görür',
  NOTE_ADD: 'Not yazar',
  NOTE_INTERNAL_VIEW: 'İç notları görür',
  CUSTOMER_NAME_VIEW: 'Müşteri firmasının tam adını ve iletişim bilgilerini görür',
  USER_MANAGE: 'Kullanıcıları yönetir',
  CUSTOMER_MANAGE: 'Firmaları yönetir',
  CATALOG_MANAGE: 'Katalogları yönetir',
  PRICE_TABLE_MANAGE: 'Fiyat tablolarını ve satışçı atamalarını yönetir',
  ALERT_VIEW: 'Önemli kararlar listesini görür ve kapatır',
  SETTINGS_MANAGE: 'Ayarlar ve entegrasyonlar',
  AUDIT_VIEW: 'Denetim kaydını görür',
};

// Yalnızca müşterinin yapabildikleri (yönetici müşteri adına işlem yapamaz; o özellik Aşama 9).
const CUSTOMER_ONLY = ['ORDER_CREATE', 'DRAWING_APPROVE'];

export const ROLE_PERMISSIONS = {
  ADMIN: Object.keys(PERMISSIONS).filter((p) => !CUSTOMER_ONLY.includes(p)),
  SATIS: [
    'ORDER_VIEW', 'ORDER_REVIEW', 'OFFER_VIEW', 'OFFER_DRAFT_VIEW', 'OFFER_PREPARE', 'SHIPMENT_VIEW', 'CRATE_EDIT',
    'FILE_UPLOAD', 'FILE_INTERNAL_VIEW', 'NOTE_ADD', 'NOTE_INTERNAL_VIEW',
  ],
  CIZIM: ['ORDER_VIEW', 'DRAWING_WORK', 'FILE_UPLOAD', 'FILE_INTERNAL_VIEW', 'NOTE_ADD', 'NOTE_INTERNAL_VIEW'],
  MUSTERI: [
    'ORDER_VIEW', 'ORDER_CREATE', 'DRAWING_APPROVE', 'OFFER_VIEW', 'PRICE_FINAL_VIEW', 'SHIPMENT_VIEW',
    'FILE_UPLOAD', 'NOTE_ADD', 'CUSTOMER_NAME_VIEW',
  ],
  DENETIMCI: [
    'ORDER_VIEW', 'OFFER_VIEW', 'PRICE_FINAL_VIEW', 'SHIPMENT_VIEW', 'FILE_INTERNAL_VIEW', 'NOTE_INTERNAL_VIEW',
    'CUSTOMER_NAME_VIEW',
  ],
};

/** Salt görüntüleme yetkileri; bunların dışındaki her yetki bir "işlem"dir. */
export const READ_ONLY = new Set([
  'ORDER_VIEW', 'OFFER_VIEW', 'OFFER_DRAFT_VIEW', 'PRICE_FINAL_VIEW', 'SHIPMENT_VIEW', 'FILE_INTERNAL_VIEW',
  'NOTE_INTERNAL_VIEW', 'CUSTOMER_NAME_VIEW', 'AUDIT_VIEW',
]);

/**
 * @param {string | null | undefined} role
 * @param {string} permission
 */
export function can(role, permission) {
  if (!(permission in PERMISSIONS)) throw new Error(`bilinmeyen yetki: ${permission}`);
  return !!role && (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

export function permissionsOf(role) {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}
