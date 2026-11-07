// Profil fiyatları (Aşama 6): katalogdaki liste fiyatı (EUR, TVA hariç) ya da müşterinin bağlı olduğu profil fiyat tablosu.
// Yönetici teklifte her fiyatı değiştirebilir. Müşteriye gönderilen teklif, fiyatların o anki kopyasıdır (değişmez).
import { createHash } from 'node:crypto';
import { writeAudit } from '../orders/journal.js';
import { can } from '../auth/permissions.js';
import { parsePrice } from './rules.js';

export const PROFILE_CURRENCY = 'EUR';

/**
 * Firmanın profil fiyat katalogları (4.2.17, karar 312): varsayılan (`Customer.profilePriceTableId`) önce, sonra ek kataloglar
 * (`profilePriceTables`, ada göre). Yalnızca ETKİN tablolar; her tablo bir kez. Başka firmanın kataloğu hiç dönmez.
 * @returns {Promise<{ id: string, name: string, isDefault: boolean, items: { productId: string, unitPrice: unknown }[] }[]>}
 */
export async function profileCatalogsFor(db, customerId) {
  const sel = { id: true, name: true, isActive: true, items: { select: { productId: true, unitPrice: true } } };
  const firm = await db.customer.findUnique({
    where: { id: customerId },
    select: { profilePriceTable: { select: sel }, profilePriceTables: { select: sel, orderBy: { name: 'asc' } } },
  });
  if (!firm) return [];
  const out = [];
  const seen = new Set();
  const push = (t, isDefault) => { if (t?.isActive && !seen.has(t.id)) { seen.add(t.id); out.push({ id: t.id, name: t.name, isDefault, items: t.items }); } };
  push(firm.profilePriceTable, true);
  for (const t of firm.profilePriceTables ?? []) push(t, false);
  // Varsayılan pasif / yoksa ilk ek katalog varsayılan sayılır (müşteri seçim yapmazsa o kullanılır)
  if (out.length && !out[0].isDefault) out[0].isDefault = true;
  return out;
}

/**
 * Firmanın profil fiyatları: ürün id → fiyat ve fiyatın kaynağı.
 * direct (Paket B — karar 229): firmaya bağlı ETKİN bir fiyat tablosu var → müşteri fiyatları görür ve doğrudan sipariş verir
 * (pasif / bağlı olmayan tablo → olağan teklif akışı). Fiyat kuralı aynıdır: tablo fiyatı, yoksa katalog liste fiyatı.
 * tableId (4.2.17): müşterinin seçtiği katalog — firmanın kataloglarından biri değilse / verilmediyse varsayılan kullanılır
 * (seçimin yetkisi `createProfileOrder`'da ayrıca denetlenir: BAD_PRICE_TABLE).
 * @param {{ tableId?: string | null }} [opts]
 * @returns {Promise<{ tableId: string | null, tableName: string | null, direct: boolean, tables: { id: string, name: string, isDefault: boolean }[],
 *   price: (product: { id: string, listPrice: unknown }) => number | null }>}
 */
export async function profilePricesFor(db, customerId, opts = {}) {
  const tableId = opts?.tableId ?? null;
  const tables = await profileCatalogsFor(db, customerId);
  const table = (tableId && tables.find((t) => t.id === tableId)) || tables[0] || null;
  const custom = new Map((table?.items ?? []).map((i) => [i.productId, Number(i.unitPrice)]));
  return {
    tableId: table?.id ?? null,
    tableName: table?.name ?? null,
    direct: !!table,
    tables: tables.map((t) => ({ id: t.id, name: t.name, isDefault: t.isDefault })),
    price: (p) => custom.get(p.id) ?? (p.listPrice == null ? null : Number(p.listPrice)),
  };
}

/**
 * Fiyat parmak izi (4.2.17): formda gösterilen fiyatların özeti — katalog id + ürün id → fiyat (sıralı). Sipariş gönderilirken
 * sunucu güncel fiyatlardan aynı özeti üretir; farklıysa sipariş AÇILMAZ (`PRICES_CHANGED`), form güncel fiyatlarla yenilenir.
 * @param {string | null} tableId
 * @param {{ id: string, listPrice: unknown }[]} products  gösterilen ürünler
 * @param {(p: { id: string, listPrice: unknown }) => number | null} price
 */
export function priceFingerprint(tableId, products, price) {
  const rows = products.map((p) => `${p.id}=${price(p) == null ? '' : Number(price(p)).toFixed(2)}`).sort();
  return createHash('sha256').update(`${tableId ?? ''}|${rows.join(';')}`).digest('hex').slice(0, 32);
}

/**
 * Katalog bağlantısı (yönetici — Profil Fiyatları sayfası; 4.2.17):
 *  - `assign`: tablo firmanın VARSAYILAN kataloğu olur; önceki varsayılan EK katalog olarak kalır (bağlantı kaybolmaz)
 *  - `extra`: tablo firmanın ek kataloğu olur (firmanın varsayılanı yoksa varsayılan olur)
 *  - `unassign`: bağlantı kaldırılır; varsayılan kaldırılıyorsa ilk ek katalog (ada göre) varsayılan olur
 * Fiyatlar ve diğer firmaların bağlantıları değişmez. Denetim kaydı: PROFILE_PRICE_TABLE_ASSIGN (before / after / extras).
 * @returns {Promise<{ ok: true, before: string | null, after: string | null, extras: string[] } | { ok: false, code: 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_INTENT' }>}
 */
export async function assignProfileTable(db, { customerId, tableId, intent, actor }) {
  if (!actor || !can(actor.role, 'PRICE_TABLE_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  if (!['assign', 'extra', 'unassign'].includes(intent)) return { ok: false, code: 'BAD_INTENT' };
  return db.$transaction(async (tx) => {
    const firm = await tx.customer.findFirst({ where: { id: customerId, type: 'CUSTOMER' }, select: { id: true, profilePriceTableId: true, profilePriceTables: { select: { id: true, name: true }, orderBy: { name: 'asc' } } } });
    const table = await tx.profilePriceTable.findUnique({ where: { id: tableId }, select: { id: true } });
    if (!firm || !table) return { ok: false, code: 'NOT_FOUND' };
    const before = firm.profilePriceTableId;
    let after = before;
    let extras = firm.profilePriceTables.map((t) => t.id).filter((id) => id !== before);
    if (intent === 'assign') {
      after = tableId;
      if (before && before !== tableId && !extras.includes(before)) extras.push(before);
      extras = extras.filter((id) => id !== tableId);
    } else if (intent === 'extra') {
      if (!before) after = tableId;
      else if (before !== tableId && !extras.includes(tableId)) extras.push(tableId);
    } else {
      if (before === tableId) { after = extras[0] ?? null; extras = extras.slice(1); }
      else extras = extras.filter((id) => id !== tableId);
    }
    await tx.customer.update({ where: { id: firm.id }, data: { profilePriceTableId: after, profilePriceTables: { set: extras.map((id) => ({ id })) } } });
    await writeAudit(tx, { action: 'PROFILE_PRICE_TABLE_ASSIGN', entityType: 'Customer', entityId: firm.id, userId: actor.id, details: { intent, tableId, before, after, extras } }, actor);
    return { ok: true, before, after, extras };
  });
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
 * @returns {Promise<{ ok: true, changed: number } | { ok: false, code: 'NOT_FOUND' | 'BAD_PRICE' | 'FORBIDDEN', productId?: string }>}
 */
export async function saveTablePrices(db, tableId, changes, actor) {
  // Servis içi yetki (karar 288 — D20): eylemdeki requirePermission'a ek
  if (!actor || !can(actor.role, 'PRICE_TABLE_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
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
