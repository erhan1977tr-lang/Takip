// Telafi teklifinin yolu — saf, bağımlılıksız kural (telafi formu tarayıcıda da kullanır). Sunucunun izlediği yol
// (server/orders/compensation.js → priceDecision().direct, createCompensation) ile aynı olmalı: test/compensation.test.js
// iki kuralı bütün kombinasyonlarda karşılaştırır.

/**
 * Telafi teklifinin yolu (ekranın gösterdiği) — createCompensation'ın izlediği yolla AYNI kural (priceDecision().direct).
 * Müşteri fiyatı kesinse teklif yöneticiye uğramaz (karar 251):
 *   bedelsiz · kaynağın kayıtlı müşteri fiyatıyla "aynı fiyat" · satışın "farklı fiyat"ı (satış fiyatı değişir, müşteri
 *   fiyatı kaynağınki kalır) · yöneticinin "farklı fiyat"ı (girdiği müşteri fiyatı).
 * Kaynak satırın müşteri fiyatı boşsa (eski kayıt) satışın "aynı / farklı fiyat"ı kesin değildir. Satışa tutar gitmez;
 * yalnızca "kaynakta müşteri fiyatı var mı" bilgisi (sourcePriced).
 *   draft         — hedefin henüz gönderilmemiş teklifine eklenir (olağan akış)
 *   direct        — doğrudan müşteriye (yeni telafi siparişi gönderilmiş açılır / müşterideki teklifin yeni sürümü)
 *   pricing       — yeni telafi siparişi yöneticinin fiyat onayı sırasına düşer (kaynakta müşteri fiyatı yok)
 *   pending       — müşterideki hedef + satış + kaynakta müşteri fiyatı yok: yöneticinin onayını bekler (PENDING)
 *   priceRequired — müşterideki hedef + yönetici + fiyatsız "aynı fiyat": sunucu PRICE_REQUIRED ile reddeder
 * @param {{ mode: string, admin: boolean, destType: 'NEW' | 'EXISTING' | string, via?: 'DRAFT' | 'SENT' | null, sourceFree?: boolean, sourcePriced: boolean }} p
 */
export function compensationFlow({ mode, admin, destType, via = null, sourceFree = false, sourcePriced }) {
  const known = sourceFree || sourcePriced;
  const direct = mode === 'FREE' || (mode === 'CUSTOM' && admin) || ((mode === 'NORMAL' || mode === 'CUSTOM') && known);
  if (destType === 'EXISTING' && via === 'DRAFT') return 'draft';
  if (direct) return 'direct';
  if (destType === 'EXISTING' && via === 'SENT') return admin ? 'priceRequired' : 'pending';
  return 'pricing';
}
