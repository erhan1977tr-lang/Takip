// Profil fiyatları (Aşama 6): katalogdaki liste fiyatı (EUR, TVA hariç) ya da müşterinin bağlı olduğu profil fiyat tablosu.
// Yönetici teklifte her fiyatı değiştirebilir. Müşteriye gönderilen teklif, fiyatların o anki kopyasıdır (değişmez).
import { writeAudit } from '../orders/journal.js';
import { parsePrice } from './rules.js';

export const PROFILE_CURRENCY = 'EUR';

/**
 * Firmanın profil fiyatları: ürün id → fiyat ve fiyatın kaynağı.
 * @returns {Promise<{ tableName: string | null, price: (product: { id: string, listPrice: unknown }) => number | null }>}
 */
export async function profilePricesFor(db, customerId) {
  const firm = await db.customer.findUnique({
    where: { id: customerId },
    select: { profilePriceTable: { select: { name: true, isActive: true, items: { select: { productId: true, unitPrice: true } } } } },
  });
  const table = firm?.profilePriceTable?.isActive ? firm.profilePriceTable : null;
  const custom = new Map((table?.items ?? []).map((i) => [i.productId, Number(i.unitPrice)]));
  return {
    tableName: table?.name ?? null,
    price: (p) => custom.get(p.id) ?? (p.listPrice == null ? null : Number(p.listPrice)),
  };
}

/**
 * Tablo adı doğrulaması
 * @returns {{ ok: true, name: string } | { ok: false, code: 'NAME' | 'TOO_LONG' }}
 */
export function validateTableName(v) {
  const name = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, code: 'NAME' };
  if (name.length > 120) return { ok: false, code: 'TOO_LONG' };
  return { ok: true, name };
}

/**
 * Tablonun fiyatlarını kaydeder: yalnızca değişenler gelir (ürün id → fiyat; boş → fiyat kaldırılır, liste fiyatı geçerli olur).
 * @returns {Promise<{ ok: true, changed: number } | { ok: false, code: 'NOT_FOUND' | 'BAD_PRICE', productId?: string }>}
 */
export async function saveTablePrices(db, tableId, changes, actor) {
  const parsed = {};
  for (const [pid, v] of Object.entries(changes)) {
    const p = parsePrice(v);
    if (Number.isNaN(p)) return { ok: false, code: 'BAD_PRICE', productId: pid };
    parsed[pid] = p;
  }
  return db.$transaction(async (tx) => {
    const table = await tx.profilePriceTable.findUnique({ where: { id: tableId }, include: { items: true } });
    if (!table) return { ok: false, code: 'NOT_FOUND' };
    const products = new Set((await tx.profileProduct.findMany({ where: { id: { in: Object.keys(parsed) } }, select: { id: true } })).map((p) => p.id));
    const cur = new Map(table.items.map((i) => [i.productId, Number(i.unitPrice)]));
    const diff = [];
    for (const [pid, price] of Object.entries(parsed)) {
      if (!products.has(pid)) continue;
      const before = cur.get(pid) ?? null;
      if (before === price) continue;
      if (price == null) await tx.profilePriceItem.delete({ where: { tableId_productId: { tableId, productId: pid } } });
      else await tx.profilePriceItem.upsert({
        where: { tableId_productId: { tableId, productId: pid } },
        create: { tableId, productId: pid, unitPrice: price.toFixed(2) },
        update: { unitPrice: price.toFixed(2) },
      });
      diff.push({ productId: pid, before, after: price });
    }
    if (diff.length) {
      await writeAudit(tx, { action: 'PROFILE_PRICES_UPDATE', entityType: 'ProfilePriceTable', entityId: tableId, userId: actor.id, details: { changes: diff } }, actor);
    }
    return { ok: true, changed: diff.length };
  });
}
