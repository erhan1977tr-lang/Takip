// Bildirim e-postaları (server/notifications/email.js). İşlemin adı events.<OLAY> metinlerinden gelir.
export default {
  orderNo: 'Sipariş no',
  customer: 'Firma',
  action: 'İşlem',
  date: 'Tarih',
  shipDate: 'Tahmini yükleme tarihi',
  deliveryDay: 'Tahmini teslim (alış) günü',
  deliveryNote: 'Bu tarih tahminidir: depo çalışma günlerine ve 12:00 kuralına göre hesaplanır, stok durumu hesaba katılmaz.',
  revisionNote: 'Revizyon notu',
  drawingVersion: 'Çizim sürümü',
  newOrder: 'Yeni sipariş',
  open: 'Siparişi aç',
  footer: 'Bu e-posta Takip portalı (GKH Trading Invest SRL) tarafından otomatik gönderildi. Bağlantıyı açmak için giriş yapmanız gerekir.',
  // Yöneticinin e-postaları (Yönetici Paneli Paketi 1, karar 218): olayın açıklaması — tutar yazılmaz
  description: 'Açıklama',
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
