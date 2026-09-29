import { ORDER_TYPES } from '../data/order-types.js';

/** Sipariş tiplerini veri dosyasına eşitler (ekleme ve güncelleme; silme yok). */
export const orderTypesStep = {
  name: 'sipariş tipleri',
  available: (db) => typeof db.orderType?.upsert === 'function',
  async run(db) {
    for (const t of ORDER_TYPES) {
      const data = {
        nameRo: t.name.ro, nameTr: t.name.tr, active: t.active, sortOrder: t.sortOrder,
        numberFormat: t.numberFormat, usesSales: t.usesSales, usesDrawing: t.usesDrawing,
      };
      await db.orderType.upsert({ where: { code: t.code }, create: { code: t.code, ...data }, update: data });
    }
    return `${ORDER_TYPES.length} tip`;
  },
};
