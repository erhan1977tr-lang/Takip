// Sipariş tipleri (CLAUDE.md "Order types"): OrderType tablosu bu listeye eşitlenir (npm run db:seed).
// Yeni tip buraya bir satır olarak girer. numberFormat: {CODE} firma kodu, {SEQ} müşterinin sipariş numarası.
// Profil siparişi Aşama 6'ya kadar kapalı (active: false); biçimi tanımın önerisi.
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
