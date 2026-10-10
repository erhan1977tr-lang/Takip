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
  // Müşteri ana sayfası → "Tekliflerim" (karar 164): tarih aralığı, liste ve PDF dökümü
  report: {
    title: 'Tekliflerim',
    intro: 'Tarih aralığını seçin: “Göster” bu aralıktaki YÜKLEME günlerine göre firmanızın cam tekliflerini (her siparişin son teklifi) listeler; “PDF indir” aynı listeyi her siparişi ayrıntılı gösteren döküm olarak indirir.',
    from: 'Başlangıç tarihi',
    to: 'Bitiş tarihi',
    show: 'Göster',
    pdf: 'PDF indir',
    empty: 'Bu tarih aralığında teklif yok.',
    cols: { order: 'Sipariş', date: 'Teklif tarihi', m2: 'm²', pieces: 'Cam adedi', amount: 'Teklif tutarı' },
    total: 'Toplam',
    count: '{n} sipariş',
    pieces: '{n} adet',
    more: 'Listede ilk {n} teklif gösteriliyor; PDF hepsini içerir.',
    pdfTitle: 'TEKLİFLERİM',
    generated: 'Oluşturulma: {date}',
    version: 'sürüm {n}',
    subtotal: 'Teklif toplamı',
    // Yükleme gününe göre gruplar (Paket B — karar 226)
    loadingDate: 'Yükleme',
    noDate: 'Yükleme tarihi henüz belli değil',
    partial: 'Kısmi yükleme — siparişin bu yüklemedeki bölümü',
    partialBadge: 'Kısmi',
    continued: 'devam',
    groupTotal: 'Yükleme toplamı',
    groupShow: 'Göster',
    groupHide: 'Gizle',
    um: 'Birim',
    grandTotal: 'Genel toplam',
    // PDF dosya adının kökü (seçili panel dili): tekliflerim-2026-10-01_2026-10-31.pdf
    errors: {
      BAD_DATE: 'Geçerli bir başlangıç ve bitiş tarihi seçin.',
      ORDER: 'Başlangıç tarihi bitiş tarihinden sonra olamaz.',
      TOO_LONG: 'Tarih aralığı en fazla 400 gün olabilir.',
      TOO_MANY: 'Bu aralıkta çok fazla teklif var; lütfen aralığı daraltın.',
    },
  },
};
