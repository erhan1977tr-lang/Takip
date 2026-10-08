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
};
