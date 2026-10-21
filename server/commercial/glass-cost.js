// Ticari teklif cam maliyeti önerisi (DÜZELTME 10 M7; 3.97.5 — tablo seçimi mevcut atama sistemiyle) — yalnızca OKUR.
// Çağıran: server/commercial/service.js (yetki denetimi orada; bu modül tek başına bir sayfa / eylemden çağrılmaz — test denetler).
import { resolveTable } from '../pricing/tables.js';

/**
 * Cam maliyeti fiyat tablosu = teklifi hazırlayan kullanıcının Tanımlar → Fiyat Tabloları'ndaki tablosu: kendisine atanmış etkin
 * SALES tablosu, yoksa etkin varsayılan tablo (`resolveTable` — satışçının teklif satırlarını dolduran kuralın aynısı; adla arama
 * YOK). Tablo EUR değilse öneri yok. Yalnızca okunur. Fiyatlar metin (Decimal'in kendi yazımı); 0 fiyat = fiyat yok.
 * `ops`: tablonun CNC ve delik adet fiyatı (cam işlemlerinin maliyet önerisi, 4.0.0); yoksa null.
 * @param {any} tx  @param {string | null | undefined} userId  @param {string[] | null} productIds  null = bütün kalemler
 */
export async function glassCostTable(tx, userId, productIds = null) {
  const [user, tables] = await Promise.all([
    userId ? tx.user.findUnique({ where: { id: userId }, select: { priceTableId: true } }) : null,
    tx.priceTable.findMany({ where: { kind: 'SALES', isActive: true }, select: { id: true, name: true, isActive: true, isDefault: true, currency: true, cncPrice: true, holePrice: true } }),
  ]);
  const t = resolveTable(user ?? { priceTableId: null }, tables);
  if (!t) return { table: null, reason: 'MISSING', prices: new Map(), ops: NO_OPS };
  if (t.currency !== 'EUR') return { table: null, reason: 'CURRENCY', prices: new Map(), ops: NO_OPS };
  const items = await tx.priceTableItem.findMany({
    where: { tableId: t.id, ...(productIds ? { glassProductId: { in: productIds } } : {}) },
    select: { glassProductId: true, unitPrice: true },
  });
  const prices = new Map(items.filter((i) => i.unitPrice != null && Number(i.unitPrice) > 0).map((i) => [i.glassProductId, i.unitPrice.toString()]));
  // CNC / delik adet fiyatı (aynı tablonun sabit fiyatları — satış ekibinin teklif tablosundaki öneriyle aynı kaynak)
  return { table: { id: t.id, name: t.name }, reason: null, prices, ops: { CNC: positive(t.cncPrice), DELIK: positive(t.holePrice) } };
}
const NO_OPS = Object.freeze({ CNC: null, DELIK: null });
const positive = (v) => (v != null && Number(v) > 0 ? v.toString() : null);
