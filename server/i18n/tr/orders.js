// Sipariş listesi (/siparisler): müşteri ve iç ekip görünümleri. Yükleme takvimi de units'i kullanır.
export default {
  // Sayılan birimler. Romencede sayıya göre çekimlenir (one: 1 · few: 0 ve 2–19 · other: 20+ → "de" ile);
  // Türkçede üçü aynıdır. Seçim: Intl.PluralRules.
  units: {
    order: { one: 'sipariş', few: 'sipariş', other: 'sipariş' },
    drawing: { one: 'çizim', few: 'çizim', other: 'çizim' },
    round: { one: 'tur', few: 'tur', other: 'tur' },
    customer: { one: 'müşteri', few: 'müşteri', other: 'müşteri' },
    crate: { one: 'sandık', few: 'sandık', other: 'sandık' },
  },
  cols: {
    order: 'Sipariş',
    customer: 'Müşteri',
    status: 'Durum',
    drawing: 'Çizim',
    offer: 'Teklif',
    revision: 'Revizyon',
    sla: 'SLA',
    ship: 'Tahmini yükleme',
    next: 'Sıradaki adım',
  },
  tabs: {
    active: 'Aktif',
    work: 'Sıra bende',
    all: 'Tüm aktif siparişler',
    archive: 'Yüklenen ve arşiv',
  },
  customer: {
    title: '{name} — Siparişlerim',
    intro: 'Sipariş bilgisini ve teknik dosyanızı yükleyin; sürecin tamamını buradan izleyin.',
    newOrder: '+ Yeni Sipariş',
    totalActive: 'Toplam aktif',
    searchPlaceholder: 'Sipariş ara — ad, sipariş no ya da kendi numaranız',
    noDate: 'Tarih belirlenmedi',
    empty: {
      search: 'Aramaya uyan sipariş yok.',
      archive: 'Arşivde sipariş yok.',
      none: 'Henüz aktif siparişiniz yok. {link}',
      firstOrder: 'İlk siparişinizi oluşturun →',
    },
  },
  internal: {
    infectedBanner: 'Karantinada {n} virüslü dosya var; bu dosyalar indirilemez.',
    infectedLink: 'Entegrasyonlar →',
    titles: {
      drawing: 'Çizim Paneli',
      admin: 'Siparişler',
      sales: 'Satış Paneli',
      inspector: 'Tüm siparişler (denetim)',
    },
    searchPlaceholder: 'Sipariş no / başlık ara',
    shipGroup: 'Yükleme: {date}',
    // "v2 · 1 tur": çizim sürümü · revizyon turu sayısı
    revisions: 'v{v} · {rounds}',
    sections: {
      newOrders: { title: 'Yeni siparişler — karar bekliyor', empty: 'Karar bekleyen sipariş yok.' },
      offersToPrepare: { title: 'Teklif hazırlanacaklar', empty: 'Hazırlanacak teklif yok.' },
      priceApproval: { title: 'Fiyat onayı bekleyen teklifler', empty: 'Onay bekleyen teklif yok.' },
      offerCheck: { title: 'Teklif kontrolü — gönderimden sonra revize çizim geldi', empty: 'Kontrol bekleyen teklif yok.' },
      drawingJobs: { title: 'Çizim işleri', empty: 'Bekleyen çizim işi yok.' },
      atCustomer: { title: 'Müşteri onayında', empty: 'Müşteri onayında çizim yok.' },
      sla: { title: 'SLA riski / gecikenler', empty: 'Geciken sipariş yok.' },
      active: 'Aktif siparişler',
      archive: 'Yüklenen ve arşiv',
      none: 'Sipariş yok.',
    },
  },
};
