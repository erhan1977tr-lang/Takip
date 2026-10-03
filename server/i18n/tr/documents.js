// Müşteri: "Mali belgeler" (server/documents/customer.js, app/(panel)/belgeler). Yalnızca FGO'da başarıyla kesilmiş
// belgeler; muhasebe ve iç veri yok.
export default {
  title: 'Mali belgeler',
  intro: 'Siparişleriniz için kesilen proforma ve faturalar. Ödeme durumu fatura sistemindeki kayıttır.',
  empty: 'Henüz kesilmiş belge yok.',
  cols: {
    kind: 'Belge tipi',
    number: 'Belge numarası',
    date: 'Kesim tarihi',
    orders: 'Sipariş / Siparişler',
    total: 'Toplam',
    currency: 'Para birimi',
    payment: 'Ödeme durumu',
  },
  kind: {
    PROFORMA: 'Proforma',
    ADVANCE: 'Avans faturası',
    INVOICE: 'Fatura',
  },
  payment: {
    UNPAID: 'Ödenmedi',
    PARTIAL: 'Kısmi ödendi',
    PAID: 'Ödendi',
    UNKNOWN: 'Kontrol ediliyor',
    REPLACED: 'Faturalandı',
  },
  viewPdf: "PDF'i aç",
  totalNote: 'Toplamlara TVA dahildir.',
  pdf: {
    notFound: 'Belge bulunamadı.',
    unavailable: 'Belge şu anda açılamıyor. Lütfen daha sonra yeniden deneyin.',
  },
};
