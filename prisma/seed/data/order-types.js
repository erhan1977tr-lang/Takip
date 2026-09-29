// Sipariş tipleri (CLAUDE.md "Order types"). Tablo Aşama 2'de eklenir; yeni tip buraya bir satır olarak girer.
// numberFormat: {CODE} firma kodu, {SEQ} firma içi sıra. Profil biçimi tanımın önerisi; ayardan değişebilir olacak.
export const ORDER_TYPES = [
  {
    code: 'GLASS_ORDER', sortOrder: 1, active: true, numberFormat: '{CODE}{SEQ}',
    name: { ro: 'Comandă sticlă', tr: 'Cam siparişi' },
    usesSales: true, usesDrawing: true,
  },
  {
    code: 'PROFILE_ORDER', sortOrder: 2, active: false, numberFormat: '{CODE}P{SEQ}',
    name: { ro: 'Comandă profile', tr: 'Profil siparişi' },
    usesSales: false, usesDrawing: false, // satış ve çizim kuyruklarına hiç girmez
  },
];
