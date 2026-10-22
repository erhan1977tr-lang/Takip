// Satışçı yönlendirmesinin "geçmiş bağlandı" işareti (karar 300) — yalnızca HİÇ cam siparişi olmayan veritabanında.
// Cam siparişi olan bir veritabanında (canlı) işaret yalnızca açık hedefli geçiş betiğiyle (scripts/sales-link.mjs)
// yazılır; bu adım orada hiçbir şey yapmaz. Yeni kurulum / test / boş demo: bağlanacak geçmiş yoktur.
const KEY = 'sales-routing';

export const salesRoutingStep = {
  id: 'sales-routing',
  name: 'satışçı yönlendirmesi (boş veritabanı)',
  available: (db) => typeof db.integrationSetting?.findUnique === 'function' && typeof db.order?.count === 'function',
  async run(db) {
    const row = await db.integrationSetting.findUnique({ where: { key: KEY } });
    if (row?.value?.linkedAt) return 'işaret var';
    const glass = await db.order.count({ where: { orderTypeCode: 'GLASS_ORDER' } });
    if (glass > 0) return `atlandı: ${glass} cam siparişi var — geçiş betiği gerekli`;
    await db.integrationSetting.create({ data: { key: KEY, value: { linkedAt: new Date().toISOString(), via: 'EMPTY_DB' } } });
    return 'boş veritabanı işaretlendi';
  },
};
