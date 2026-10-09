// Rol ve yetki satırları. Matrisin kendisi server/auth/permissions.js içinde (tek kaynak);
// buradaki veri veritabanındaki Role/RolePermission tablolarını ona eşitler.
import { PERMISSIONS as PERMISSION_DOCS, ROLE_PERMISSIONS } from '../../../server/auth/permissions.js';

export const PERMISSIONS = Object.keys(PERMISSION_DOCS);

const DESCRIPTIONS = {
  ADMIN: 'Sistem yöneticisi — tam yetki, son fiyat ve müşteriye gönderim',
  YONETICI_YARDIMCISI: 'Yönetici yardımcısı — yöneticinin operasyonel yetkileri; kullanıcı / rol, güvenlik ve kritik ayar yönetimi ve giriş logları yok',
  SATIS: 'Satış — cam siparişini inceler, teklif hazırlar; müşteriye gönderemez, iptal edemez',
  CIZIM: 'Çizim ekibi — çizim sürümleri ve revizyonlar; fiyat görmez',
  MUSTERI: 'Müşteri — yalnızca kendi firmasının siparişleri',
  DENETIMCI: 'Denetimci — yalnızca görüntüler; müşteriye gönderilmiş teklifleri ve iç notları görür',
};

export const ROLES = Object.entries(ROLE_PERMISSIONS).map(([code, permissions]) => ({
  code, description: DESCRIPTIONS[code], permissions: [...permissions],
}));
