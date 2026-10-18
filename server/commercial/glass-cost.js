// Ticari teklif cam maliyeti önerisi (DÜZELTME 10 M7, 3.96.0) — yalnızca OKUR. Çağıran: server/commercial/service.js
// (yetki denetimi orada; bu modül tek başına bir sayfa / eylemden çağrılmaz — test denetler).
import { GLASS_COST_TABLE_NAME, tableNameKey } from './rules.js';

/**
 * Fabrika alış listesi (GLASS_COST_TABLE_NAME — DÜZELTME 10 M7): adı eşleşen TEK etkin, EUR, SALES fiyat tablosu.
 * Yalnızca okunur. Tablo yok / belirsiz → { table: null }. Fiyatlar metin (4 ondalık biçim değil, Decimal'in kendi yazımı).
 * @param {any} tx  @param {string[] | null} productIds  null = bütün kalemler
 */
export async function glassCostTable(tx, productIds = null) {
  const tables = await tx.priceTable.findMany({ where: { kind: 'SALES' }, select: { id: true, name: true, isActive: true, currency: true } });
  const named = tables.filter((x) => tableNameKey(x.name) === tableNameKey(GLASS_COST_TABLE_NAME));
  if (named.length !== 1) return { table: null, reason: named.length ? 'AMBIGUOUS' : 'MISSING', prices: new Map() };
  const t = named[0];
  if (!t.isActive) return { table: null, reason: 'INACTIVE', prices: new Map() };
  if (t.currency !== 'EUR') return { table: null, reason: 'CURRENCY', prices: new Map() };
  const items = await tx.priceTableItem.findMany({
    where: { tableId: t.id, ...(productIds ? { glassProductId: { in: productIds } } : {}) },
    select: { glassProductId: true, unitPrice: true },
  });
  const prices = new Map(items.filter((i) => i.unitPrice != null && Number(i.unitPrice) > 0).map((i) => [i.glassProductId, i.unitPrice.toString()]));
  return { table: { id: t.id, name: t.name }, reason: null, prices };
}
