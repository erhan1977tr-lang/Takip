/**
 * İki kademeli fiyattan önce (3.10 öncesi) müşteriye gönderilmiş teklifler: o dönemde yönetici satış satırlarının
 * üzerine yazdığı için satırdaki fiyat zaten müşteri fiyatıdır. Müşteri fiyatı alanlarına kopyalanır (karar 4).
 * Tekrar çalıştırılabilir: yalnızca offerAmount'u boş gönderilmiş tekliflere dokunur.
 */
export const offerPricesStep = {
  name: 'gönderilmiş teklifler (müşteri fiyatı alanları)',
  available: (db) => typeof db.offer?.findMany === 'function' && 'offerAmount' in (db.offer.fields ?? { offerAmount: 1 }),
  async run(db) {
    const old = await db.offer.findMany({ where: { status: 'GONDERILDI', offerAmount: null }, include: { lines: true } });
    for (const o of old) {
      await db.$transaction([
        ...o.lines.map((l) => db.offerLine.update({ where: { id: l.id }, data: { offerPrice: l.unitPrice } })),
        db.offer.update({ where: { id: o.id }, data: { offerAmount: o.amount } }),
      ]);
    }
    return `${old.length} teklif`;
  },
};
