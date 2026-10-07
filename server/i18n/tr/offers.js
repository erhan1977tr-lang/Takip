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
  // Denetimci: yalnızca müşteriye gönderilmiş teklifler
  inspector: {
    title: 'Müşteriye gönderilmiş teklifler',
    intro: 'Müşterilere gönderilmiş teklifler, müşterinin gördüğü tutarla. Hazırlanan teklifler burada görünmez.',
    empty: 'Müşteriye gönderilmiş teklif yok.',
    customer: 'Müşteri',
  },
  internal: {
    title: 'Teklifler',
    intro: 'Hazırlanan, yönetimde bekleyen ve müşteriye gönderilmiş teklifler.',
    introSales: 'Fiyatınızı bekleyen teklifler ve teklif tablosu henüz açılmamış siparişler.',
    cols: {
      offer: 'Teklif',
      customer: 'Müşteri',
      orderStatus: 'Sipariş',
      offerStatus: 'Teklif',
      lines: 'Satır',
      ship: 'Teslim',
      amount: 'Satış tutarı',
      offerAmount: 'Müşteri tutarı',
    },
  },
  // Son teklifin durumuna göre gruplar (HAZIRLANIYOR · YONETIMDE · GONDERILDI)
  groups: {
    sales: { title: 'Satışta hazırlananlar', empty: 'Hazırlanan teklif yok.' },
    admin: { title: 'Yönetici onayında', empty: 'Onay bekleyen teklif yok.' },
    customer: { title: 'Müşteride', empty: 'Müşteriye gönderilmiş aktif teklif yok.' },
    // Satışın sayfası (karar 155): yalnızca bu iki liste
    awaitingPrice: { title: 'Fiyatımı bekleyenler', empty: 'Fiyatınızı bekleyen teklif yok.' },
    notOpened: { title: 'Teklif tablosu açılmamış siparişler', empty: 'Teklif tablosu açılmamış sipariş yok.' },
  },
};
