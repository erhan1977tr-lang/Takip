// Telafi teklifinin yolu — saf, bağımlılıksız kural (telafi formu tarayıcıda da kullanır). Sunucunun izlediği yol
// (server/orders/compensation.js → priceDecision().direct, createCompensation) ile aynı olmalı: test/compensation.test.js
// iki kuralı bütün kombinasyonlarda karşılaştırır.

/**
 * Telafi teklifinin yolu (ekranın gösterdiği) — createCompensation'ın izlediği yolla AYNI kural (priceDecision().direct):
 * fiyat kesin = bedelsiz ya da kaynağın kayıtlı müşteri fiyatıyla "aynı fiyat". Kaynak satırın müşteri fiyatı boşsa
 * "aynı fiyat" da kesin değildir. Satışa tutar gitmez; yalnızca "kaynakta müşteri fiyatı var mı" bilgisi (sourcePriced).
 *   draft         — hedefin henüz gönderilmemiş teklifine eklenir (olağan akış)
 *   direct        — doğrudan müşteriye (yeni telafi siparişi gönderilmiş açılır / müşterideki teklifin yeni sürümü)
 *   pricing       — yeni telafi siparişi yöneticinin fiyat onayı sırasına düşer
 *   pending       — müşterideki hedef + satış: yöneticinin onayını bekler (PENDING)
 *   adminSent     — müşterideki hedef + yönetici "farklı fiyat": girilen fiyatla yeni sürüm
 *   priceRequired — müşterideki hedef + yönetici + fiyatsız "aynı fiyat": sunucu PRICE_REQUIRED ile reddeder
 * @param {{ mode: string, admin: boolean, destType: 'NEW' | 'EXISTING' | string, via?: 'DRAFT' | 'SENT' | null, sourceFree?: boolean, sourcePriced: boolean }} p
 */
export function compensationFlow({ mode, admin, destType, via = null, sourceFree = false, sourcePriced }) {
  const direct = mode === 'FREE' || (mode === 'NORMAL' && (sourceFree || sourcePriced));
  if (destType === 'EXISTING' && via === 'DRAFT') return 'draft';
  if (direct) return 'direct';
  if (destType === 'EXISTING' && via === 'SENT') return !admin ? 'pending' : mode === 'CUSTOM' ? 'adminSent' : 'priceRequired';
  return 'pricing';
}
