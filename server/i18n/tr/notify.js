// Bildirim e-postaları (server/notifications/email.js). İşlemin adı events.<OLAY> metinlerinden gelir.
export default {
  orderNo: 'Sipariş no',
  customer: 'Firma',
  action: 'İşlem',
  date: 'Tarih',
  // Müşteri üretim onayı (4.2.11): satışa giden e-postanın tarih satırı = onayın anı
  approvedAt: 'Onay tarihi ve saati',
  shipDate: 'Tahmini yükleme tarihi',
  deliveryDay: 'Tahmini teslim (alış) günü',
  deliveryNote: 'Bu tarih tahminidir: depo çalışma günlerine ve 12:00 kuralına göre hesaplanır, stok durumu hesaba katılmaz.',
  revisionNote: 'Revizyon notu',
  drawingVersion: 'Çizim sürümü',
  offerVersion: 'Teklif sürümü',
  changeNote: 'Müşterinin notu',
  changeTranslation: 'Türkçe çeviri (otomatik)',
  newOrder: 'Yeni sipariş',
  open: 'Siparişi aç',
  footer: 'Bu e-posta Takip portalı (GKH Trading Invest SRL) tarafından otomatik gönderildi. Bağlantıyı açmak için giriş yapmanız gerekir.',
  // Yöneticinin e-postaları (Yönetici Paneli Paketi 1, karar 218): olayın açıklaması — tutar yazılmaz
  description: 'Açıklama',
  // Müşteri üretim onayı (4.2.1): teklif gönderildi / güncellendi e-postası (müşterinin dilinde)
  approval: {
    deadline: 'Son onay tarihi',
    roTime: 'Romanya saati',
    noDeadline: 'Belirlenemedi — lütfen GKH ile iletişime geçin',
    text: 'Lütfen teklifteki cam türlerini, ölçüleri, adetleri ve fiyatları kontrol edin. Siparişinizin üretime alınması için onayınız zorunludur. Onay süresi bu bildirimin size iletilmesinden itibaren 2 Romanya iş günüdür (yukarıdaki son onay tarihi). Onayın gecikmesi planlanan yükleme tarihini etkileyebilir. Onaylamak ya da ölçülerde değişiklik bildirmek için siparişi açın.',
  },
  admin: {
    priceOverride: 'Satış fabrika fiyatını değiştirdi',
    // {n}: fabrika fiyat tablosundaki fiyattan farklı satır sayısı
    priceOverrideDetail: 'Satış, teklifi {n} satırda fabrika fiyat tablosundaki fiyattan farklı fiyatla yöneticiye gönderdi. Ayrıntı "Önemli kararlar"da.',
    withdrawnDetail: 'Teklif yeniden satışta; fiyat onayı bekleyenlerden çıktı. Satış yeniden gönderince yeniden gelir.',
    compensation: {
      free: 'Telafi camı bedelsiz açıldı',
      custom: 'Telafi camı için farklı fiyat seçildi',
    },
    // {qty}: telafi adedi · {source}: kaynak sipariş no
    compensationDetail: '{qty} adet telafi camı · kaynak sipariş {source}.',
    compensationPending: 'Müşteri fiyatı yöneticinin onayını bekliyor.',
  },
};
