// Teklif listesi (/teklifler): müşteri ve iç ekip görünümleri.
export default {
  customer: {
    title: 'Tekliflerim',
    intro: 'Siparişleriniz için hazırlanan teklifler. Ayrıntıları görmek için siparişi açın.',
    empty: 'Henüz size gönderilmiş bir teklif yok.',
    cols: {
      order: 'Sipariş',
      status: 'Sipariş durumu',
      date: 'Teklif tarihi',
      amount: 'Tutar',
    },
    view: 'Teklifi gör',
  },
  internal: {
    title: 'Teklifler',
    intro: 'Hazırlanan, yönetimde bekleyen ve müşteriye gönderilmiş teklifler.',
    cols: {
      offer: 'Teklif',
      customer: 'Müşteri',
      orderStatus: 'Sipariş',
      offerStatus: 'Teklif',
      lines: 'Satır',
      ship: 'Teslim',
      amount: 'Tutar',
    },
  },
  // Son teklifin durumuna göre gruplar (HAZIRLANIYOR · YONETIMDE · GONDERILDI)
  groups: {
    sales: { title: 'Satışta hazırlananlar', empty: 'Hazırlanan teklif yok.' },
    admin: { title: 'Yönetici onayında', empty: 'Onay bekleyen teklif yok.' },
    customer: { title: 'Müşteride', empty: 'Müşteriye gönderilmiş aktif teklif yok.' },
  },
};
