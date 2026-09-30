// Profil stok takibi (Aşama 6). Stok = ürünün hareketlerinin toplamı; hareketler yalnızca eklenir (StockMovement).
//   GIRIS: mal girişi (+) · CIKIS: depoya giden sipariş (−, kendiliğinden) · SAYIM: sayım düzeltmesi (±) · IADE: iptal (+)
// Stok yetmese de sipariş depoya gönderilir (ürün sahibinin kararı): yöneticiye uyarı gösterilir, işlem engellenmez.
import { writeAudit } from '../orders/journal.js';
import { clean } from '../catalog/glass.js';

export const MAX_STOCK_QTY = 1_000_000;
export const STOCK_HEADERS = ['Kod', 'Ürün', 'Birim', 'Stok', 'Adet'];

/**
 * Ürünlerin stoğu (ürün id → adet). Hareketi olmayan ürün 0.
 * @param {string[] | null} productIds  null → tüm ürünler
 */
export async function stockLevels(db, productIds = null) {
  const rows = await db.stockMovement.groupBy({
    by: ['productId'],
    where: productIds ? { productId: { in: productIds } } : {},
    _sum: { qty: true },
  });
  return new Map(rows.map((r) => [r.productId, r._sum.qty ?? 0]));
}

/**
 * Siparişin stok durumu: satır başına istenen, stok ve eksik.
 * @param {{ productId: string | null, qty: number }[]} items
 * @param {Map<string, number>} levels
 */
export function shortages(items, levels) {
  return items.flatMap((i) => {
    if (!i.productId) return [];
    const stock = levels.get(i.productId) ?? 0;
    return stock < i.qty ? [{ productId: i.productId, qty: i.qty, stock, missing: i.qty - stock }] : [];
  });
}

/**
 * Elle stok hareketi (yönetici): giriş ya da sayım düzeltmesi.
 * @param {{ productId: string, kind: 'GIRIS' | 'SAYIM', qty: number, note?: string | null }} m  SAYIM'da qty sayılan adettir (fark hareket olarak yazılır)
 * @returns {Promise<{ ok: true, delta: number } | { ok: false, code: 'NOT_FOUND' | 'BAD_QTY' | 'NO_CHANGE' }>}
 */
export async function addStockMovement(db, m, actor) {
  if (!Number.isInteger(m.qty) || Math.abs(m.qty) > MAX_STOCK_QTY || (m.kind === 'GIRIS' && m.qty === 0) || (m.kind === 'SAYIM' && m.qty < 0)) {
    return { ok: false, code: 'BAD_QTY' };
  }
  return db.$transaction(async (tx) => {
    // Aynı ürüne aynı anda iki sayım yazılmasın
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock:${m.productId}`}, 0))`;
    const product = await tx.profileProduct.findUnique({ where: { id: m.productId }, select: { id: true, code: true } });
    if (!product) return { ok: false, code: 'NOT_FOUND' };
    const current = (await stockLevels(tx, [product.id])).get(product.id) ?? 0;
    const delta = m.kind === 'SAYIM' ? m.qty - current : m.qty;
    if (delta === 0) return { ok: false, code: 'NO_CHANGE' };
    const note = clean(m.note).slice(0, 300) || null;
    await tx.stockMovement.create({ data: { productId: product.id, qty: delta, kind: m.kind, note, createdById: actor.id } });
    await writeAudit(tx, {
      action: 'STOCK_MOVEMENT', entityType: 'ProfileProduct', entityId: product.id, userId: actor.id,
      details: { code: product.code, kind: m.kind, delta, before: current, after: current + delta, note },
    }, actor);
    return { ok: true, delta };
  });
}

/**
 * Siparişin kalemlerini stoktan düşer (depoya gönderilirken, iş akışı işleminin içinde). Bir kez yapılır.
 * @param {any} tx
 * @param {{ orderId: string, orderNo: string, items: { productId: string | null, qty: number }[], actorId: string | null }} p
 */
export async function deductOrderStock(tx, { orderId, orderNo, items, actorId }) {
  const data = items.filter((i) => i.productId).map((i) => ({ productId: i.productId, qty: -i.qty, kind: 'CIKIS', orderId, note: orderNo, createdById: actorId }));
  if (data.length) await tx.stockMovement.createMany({ data });
  return data.length;
}

/** İptal edilen (depoya gitmiş) siparişin çıkışlarını geri alır. */
export async function returnOrderStock(tx, { orderId, orderNo, actorId }) {
  const out = await tx.stockMovement.findMany({ where: { orderId, kind: 'CIKIS' } });
  const data = out.map((m) => ({ productId: m.productId, qty: -m.qty, kind: 'IADE', orderId, note: orderNo, createdById: actorId }));
  if (data.length) await tx.stockMovement.createMany({ data });
  return data.length;
}

// ---------- Excel ----------
const headerKey = (s) => clean(s).toLocaleUpperCase('tr-TR').replace(/\s/g, '');

/**
 * Stok Excel'i: "Kod" ve "Adet" sütunları (dışa aktarılan dosyanın düzeni). Boş adet atlanır.
 * @param {(string | number | boolean | null)[][]} rows
 * @returns {{ ok: false, error: 'HEADERS' | 'EMPTY' } | { ok: true, items: { row: number, code: string, qty: number }[], errors: { row: number, code: string, problem: string }[] }}
 */
export function parseStockSheet(rows) {
  const h = rows.findIndex((r) => (r ?? []).some((c) => headerKey(c) === 'KOD'));
  if (h < 0) return { ok: false, error: 'HEADERS' };
  const cCode = rows[h].findIndex((c) => headerKey(c) === 'KOD');
  const cQty = rows[h].findIndex((c) => headerKey(c) === 'ADET');
  if (cQty < 0) return { ok: false, error: 'HEADERS' };
  const items = [];
  const errors = [];
  const seen = new Set();
  rows.slice(h + 1).forEach((r, i) => {
    const row = h + 2 + i;
    const code = clean(r?.[cCode]);
    const raw = clean(r?.[cQty]);
    if (!code || raw === '') return;
    const qty = Number(raw.replace(',', '.'));
    if (!Number.isInteger(qty) || Math.abs(qty) > MAX_STOCK_QTY) { errors.push({ row, code, problem: 'QTY' }); return; }
    if (seen.has(code)) { errors.push({ row, code, problem: 'DUPLICATE' }); return; }
    seen.add(code);
    items.push({ row, code, qty });
  });
  if (items.length === 0 && errors.length === 0) return { ok: false, error: 'EMPTY' };
  return { ok: true, items, errors };
}

/**
 * Excel'deki adetleri uygular. mode GIRIS: adetler stoğa eklenir · SAYIM: stok bu adede eşitlenir.
 * @returns {Promise<{ applied: number, unknown: string[] }>}
 */
export async function applyStockImport(db, items, mode, actor) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'stock:import'}, 0))`;
    const products = await tx.profileProduct.findMany({ where: { code: { in: items.map((i) => i.code) } }, select: { id: true, code: true } });
    const byCode = new Map(products.map((p) => [p.code, p.id]));
    const levels = await stockLevels(tx, products.map((p) => p.id));
    const data = [];
    const unknown = [];
    for (const i of items) {
      const pid = byCode.get(i.code);
      if (!pid) { unknown.push(i.code); continue; }
      if (mode === 'GIRIS' ? i.qty <= 0 : i.qty < 0) continue;
      const delta = mode === 'SAYIM' ? i.qty - (levels.get(pid) ?? 0) : i.qty;
      if (delta !== 0) data.push({ productId: pid, qty: delta, kind: mode, note: 'Excel', createdById: actor.id });
    }
    if (data.length) await tx.stockMovement.createMany({ data });
    await writeAudit(tx, { action: 'STOCK_IMPORT', entityType: 'StockMovement', userId: actor.id, details: { mode, applied: data.length, unknown } }, actor);
    return { applied: data.length, unknown };
  });
}
