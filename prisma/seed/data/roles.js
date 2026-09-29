// Rol ve yetki matrisi (ADR 0003). Uygulama bugün rolü User.appRole ile belirler; bu tablo Aşama 1'de
// sunucu tarafı yetki kontrolünün kaynağı olur. Yetkiler açıkça yazılır, bir rolden türetilmez.
// Denetimci ilk sürümde yalnızca okur (karar 8).

export const PERMISSIONS = [
  'ORDER_VIEW', 'ORDER_EDIT', 'ORDER_APPROVE', 'OFFER_CREATE', 'PRICE_SET', 'DRAWING_UPLOAD',
  'DRAWING_APPROVE', 'SHIPMENT_MANAGE', 'USER_MANAGE', 'CUSTOMER_MANAGE', 'SETTINGS_MANAGE', 'AUDIT_VIEW',
];

export const ROLES = [
  { code: 'ADMIN', description: 'Sistem yöneticisi — tam yetki, son fiyat ve müşteriye gönderim', permissions: [...PERMISSIONS] },
  { code: 'SATIS', description: 'Satış — cam siparişini inceler, teklif hazırlar; müşteriye gönderemez', permissions: ['ORDER_VIEW', 'ORDER_EDIT', 'OFFER_CREATE', 'SHIPMENT_MANAGE'] },
  { code: 'CIZIM', description: 'Çizim ekibi — çizim sürümleri ve revizyonlar; fiyat görmez', permissions: ['ORDER_VIEW', 'DRAWING_UPLOAD'] },
  { code: 'MUSTERI', description: 'Müşteri — yalnızca kendi firmasının siparişleri', permissions: ['ORDER_VIEW', 'ORDER_EDIT', 'DRAWING_APPROVE'] },
  { code: 'DENETIMCI', description: 'Denetimci — yalnızca görüntüler (ilk sürüm)', permissions: ['ORDER_VIEW'] },
];
