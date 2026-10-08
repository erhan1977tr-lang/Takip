// Profil stok takibi (Aşama 6; Paket 5 — karar 177). Stok = ürünün hareketlerinin toplamı; hareketler yalnızca eklenir
// (StockMovement — silinmez, düzeltilmez).
//   GIRIS: mal girişi (+) · CIKIS: depoya giden sipariş (−, kendiliğinden) · SAYIM: sayım düzeltmesi (±) · IADE: iptal (+)
// Stok yetmese de sipariş depoya gönderilir (ürün sahibinin kararı): yöneticiye uyarı gösterilir, işlem engellenmez; stok
// eksiye düşebilir (politika değişmedi).
//
// Eşzamanlılık (karar 177): stoğa yazan HER işlem — elle giriş / sayım, Excel'den stok, depo çıkışı, iptal iadesi, kritik
// eşik — o ürünlerin `stock:<ürün id>` danışma kilitlerini SIRALI alır (stockLockKeys; tek sıra → kilitlenme yok). Sayım
// "şu anki stok"u kilit altında okur: aynı anda yazılan bir depo çıkışı ya sayımdan önce tamamlanır (sayım onu görür) ya da
// sayımın bitmesini bekler — sayımın kaydettiği "önce / sonra" her zaman gerçek stoğa eşittir.
// Rezerve (onaylı, depoya gitmemiş siparişlerin adedi) bir hareket DEĞİLDİR: ayrı hesaplanır, stoğu değiştirmez.
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { clean } from '../catalog/glass.js';
import { BEFORE_WAREHOUSE } from './rules.js';

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

// ---------- kilitler ----------

/** Ürünlerin stok kilit anahtarları: tekrarsız, SIRALI (her yazan aynı sırayla alır — kilitlenme olmaz) */
export const stockLockKeys = (productIds) => [...new Set(productIds.filter(Boolean).map(String))].sort().map((id) => `stock:${id}`);

/**
 * Ürünlerin stok kilitlerini işlemin sonuna kadar alır. Aynı işlemde yeniden almak serbesttir (PostgreSQL danışma kilidi
 * aynı oturumda tekrar verilir) — iş akışı işlemi kilitleri sürüm artışından önce alır, stok işlevi yine de kendi alır.
 * @param {any} tx  @param {(string | null | undefined)[]} productIds
 */
export async function lockStock(tx, productIds) {
  for (const key of stockLockKeys(productIds)) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

// ---------- rezerve ----------

/**
 * Rezerve (karar 177): onaylanmış ama henüz depoya gitmemiş (stoktan düşülmemiş) profil siparişlerindeki adetler. Bir stok
 * hareketi değildir; stoğu değiştirmez, yalnızca yöneticinin (ve denetimcinin) stok ekranında ayrı sütundur.
 * @param {string[] | null} productIds  null → tüm ürünler
 */
export async function reservedLevels(db, productIds = null) {
  const rows = await db.profileOrderItem.groupBy({
    by: ['productId'],
    where: {
      productId: productIds ? { in: productIds } : { not: null },
      order: { status: { not: 'IPTAL' }, removedAt: null, profile: { stage: { in: BEFORE_WAREHOUSE }, stockDeducted: false } },
    },
    _sum: { qty: true },
  });
  return new Map(rows.map((r) => [String(r.productId), r._sum.qty ?? 0]));
}

/**
 * Stok ekranındaki satırın durumu (saf): kritik (stok ≤ eşik), eksi stok, onaylı siparişler için eksik (rezerve − stok).
 * @param {{ stock: number, reserved: number, threshold: number | null }} p
 */
export function stockRowStatus({ stock, reserved, threshold }) {
  return {
    critical: threshold != null && stock <= threshold,
    negative: stock < 0,
    shortForOrders: Math.max(0, reserved - stock),
  };
}

// ---------- sipariş anındaki yetersizlik (karar 165) ----------

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

/** "Önemli kararlar" türü: müşterinin profil siparişinde stok yetmedi (karar 165) */
export const STOCK_SHORTAGE_ALERT = 'STOCK_SHORTAGE';

/**
 * Stok yetersizliği uyarısının satırları (karar 165): mevcut kural (shortages) + ürünün sipariş anındaki adı, kodu ve
 * birimi. Gereken = siparişteki adet, mevcut = stok (hareketlerin toplamı; eksiye düşmüş olabilir), eksik = gereken − mevcut.
 * Yeni bir stok hesabı DEĞİLDİR: yalnızca stockLevels'ın sonucu siparişin kalemleriyle eşleştirilir.
 * @param {{ productId: string | null, code: string, nameTr: string, nameRo: string, unitCode: string, qty: number }[]} items
 * @param {Map<string, number>} levels
 * @returns {{ productId: string, code: string, nameTr: string, nameRo: string, unitCode: string, qty: number, stock: number, missing: number }[]}
 */
export function stockShortageLines(items, levels) {
  return shortages(items, levels).map((s) => {
    const it = items.find((i) => i.productId === s.productId);
    return { productId: s.productId, code: it?.code ?? '', nameTr: it?.nameTr ?? '', nameRo: it?.nameRo ?? '', unitCode: it?.unitCode ?? '', qty: s.qty, stock: s.stock, missing: s.missing };
  });
}

/**
 * Müşterinin profil siparişi gönderildiğinde stok denetimi (karar 165) — sipariş ENGELLENMEZ. Stok yetmeyen kalem varsa
 * yöneticinin "Önemli kararlar" listesine tek bir kayıt düşer (sipariş anındaki gereken / mevcut / eksik) ve siparişin
 * "Stok yetersiz" işareti bu açık kayıttır; yönetici mevcut ve beklenen stoğu değerlendirip kararını verince "Gördüm" ile
 * kapanır. Siparişi oluşturan veritabanı işleminin İÇİNDE çağrılır (aynı anlık görüntü; sipariş varsa kayıt da vardır).
 * @param {any} tx
 * @param {{ orderId: string, orderNo: string, items: object[], actor: { id: string, role?: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ lines: ReturnType<typeof stockShortageLines>, alertId: string | null }>}
 */
export async function recordStockShortage(tx, { orderId, orderNo, items, actor, now = new Date() }) {
  const ids = [...new Set(items.map((i) => i.productId).filter(Boolean))];
  if (ids.length === 0) return { lines: [], alertId: null };
  const lines = stockShortageLines(items, await stockLevels(tx, ids));
  if (lines.length === 0) return { lines, alertId: null };
  const alert = await tx.adminAlert.create({
    data: { type: STOCK_SHORTAGE_ALERT, orderId, createdById: actor.id, createdAt: now, details: { orderNo, stock: lines } },
  });
  await writeAudit(tx, {
    action: 'STOCK_SHORTAGE', entityType: 'Order', entityId: orderId, userId: actor.id,
    details: { orderNo, alertId: alert.id, lines: lines.map((l) => ({ code: l.code, qty: l.qty, stock: l.stock, missing: l.missing })) },
  }, actor);
  return { lines, alertId: alert.id };
}

// ---------- müşterinin gördüğü stok bilgisi (karar 177) ----------

/**
 * Müşteriye giden satır: gereken, mevcut, eksik. "Mevcut" eksiye düşmez (0): iç bakiye (eksi stok) müşteriye gitmez.
 * @param {number} needed  @param {number} stock
 */
export function customerStockLine(needed, stock) {
  const available = Math.max(0, Math.trunc(Number(stock) || 0));
  return { needed, available, missing: Math.max(0, needed - available) };
}

/**
 * Gönderimden önce müşterinin formundaki ürünler için stok uyarısı (karar 177) — ENGELLEMEZ, kayıt yazmaz. Yalnızca
 * formdaki (adedi > 0), etkin ürünler ve yalnızca stoğu yetmeyenler döner: genel stok listesi değildir.
 * @param {{ productId: string, qty: number }[]} lines  readQuantities sonucu
 */
export async function customerShortages(db, lines) {
  const ids = [...new Set(lines.map((l) => l.productId))];
  if (!ids.length) return [];
  const products = await db.profileProduct.findMany({
    where: { id: { in: ids }, isActive: true, category: { isActive: true } },
    select: { id: true, code: true, nameTr: true, nameRo: true, unitCode: true },
  });
  const byId = new Map(products.map((p) => [p.id, p]));
  const levels = await stockLevels(db, products.map((p) => p.id));
  return lines.flatMap((l) => {
    const p = byId.get(l.productId);
    if (!p) return [];
    const s = customerStockLine(l.qty, levels.get(p.id) ?? 0);
    return s.missing > 0 ? [{ productId: p.id, code: p.code, nameTr: p.nameTr, nameRo: p.nameRo, unitCode: p.unitCode, ...s }] : [];
  });
}

/**
 * Sipariş sayfasında müşterinin gördüğü yetersizlik (karar 177): "Önemli kararlar" kaydındaki sipariş anı değerleri,
 * yalnızca kendi siparişindeki eksik ürünler; mevcut eksiye düşmez.
 * @param {{ code?: string, nameTr?: string, nameRo?: string, unitCode?: string, qty?: number, stock?: number }[]} alertLines
 */
export function customerShortageView(alertLines) {
  return alertLines.map((l) => ({
    code: l.code ?? '', nameTr: l.nameTr ?? '', nameRo: l.nameRo ?? '', unitCode: l.unitCode ?? '',
    ...customerStockLine(Number(l.qty) || 0, Number(l.stock) || 0),
  }));
}

// ---------- kritik eşik (karar 177) ----------

/** "Önemli kararlar" türü: ürün kritik stok eşiğine indi (ürün başına TEK açık kayıt) */
export const STOCK_CRITICAL_ALERT = 'STOCK_CRITICAL';

/**
 * Yeni bir kritik dönem mi (saf): eşik var, stok eşiğe eşit ya da altında ve DEĞİŞİKLİKTEN ÖNCE eşiğin üstündeydi.
 * Zaten kritikken süren düşüşler yeni uyarı açmaz (açık uyarı kapandıysa da); stok eşiğin üstüne çıkıp yeniden inerse açar.
 * @param {{ threshold: number | null, before: number, after: number }} p
 */
export function crossesCritical({ threshold, before, after }) {
  if (threshold == null) return false;
  return after <= threshold && before > threshold;
}

/**
 * Eşik metni: boş → eşik yok (null); 0 … MAX_STOCK_QTY tam sayı
 * @returns {{ ok: true, value: number | null } | { ok: false }}
 */
export function parseThreshold(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, value: null };
  if (!/^\d{1,7}$/.test(s)) return { ok: false };
  const n = Number(s);
  return n <= MAX_STOCK_QTY ? { ok: true, value: n } : { ok: false };
}

async function openCriticalAlert(tx, productId) {
  return tx.adminAlert.findFirst({ where: { type: STOCK_CRITICAL_ALERT, resolvedAt: null, details: { path: ['productId'], equals: productId } }, select: { id: true } });
}

async function createCriticalAlert(tx, { product, stock, actor, source, orderNo = null, now = new Date() }) {
  if (await openCriticalAlert(tx, product.id)) return null; // ürün başına tek açık kayıt
  const alert = await tx.adminAlert.create({
    data: {
      type: STOCK_CRITICAL_ALERT, createdById: actor?.id ?? null, createdAt: now,
      // level: o anki stok, cause: neden (GIRIS / SAYIM / CIKIS / THRESHOLD) — "stock" ve "source" anahtarları öbür kayıt
      // türlerinde başka anlamdadır (yetersizlik satırları, telafinin kaynağı); karıştırılmaz
      details: { productId: product.id, code: product.code, nameTr: product.nameTr, nameRo: product.nameRo, unitCode: product.unitCode, level: stock, threshold: product.criticalStock, cause: source, orderNo },
    },
  });
  await writeAudit(tx, {
    action: 'STOCK_CRITICAL', entityType: 'ProfileProduct', entityId: product.id, userId: actor?.id ?? null,
    details: { code: product.code, level: stock, threshold: product.criticalStock, cause: source, orderNo, alertId: alert.id },
  }, actor ?? {});
  return alert.id;
}

/**
 * Stok değişikliğinden sonra, AYNI işlemde ve ürün kilitleri tutulurken: eşiğin altına inen her ürün için tek açık
 * "Kritik stok" kaydı (crossesCritical + açık kayıt yoksa).
 * @param {any} tx
 * @param {{ productIds: string[], before: Map<string, number>, actor?: { id?: string | null, role?: string, ip?: string | null } | null,
 *   source: string, orderNo?: string | null, now?: Date }} p
 * @returns {Promise<string[]>} açılan kayıtlar
 */
export async function recordCriticalStock(tx, { productIds, before, actor = null, source, orderNo = null, now = new Date() }) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return [];
  const products = await tx.profileProduct.findMany({
    where: { id: { in: ids }, criticalStock: { not: null } },
    select: { id: true, code: true, nameTr: true, nameRo: true, unitCode: true, criticalStock: true },
  });
  if (!products.length) return [];
  const after = await stockLevels(tx, products.map((p) => p.id));
  const created = [];
  for (const p of products) {
    const stock = after.get(p.id) ?? 0;
    if (!crossesCritical({ threshold: p.criticalStock, before: before.get(p.id) ?? 0, after: stock })) continue;
    const id = await createCriticalAlert(tx, { product: p, stock, actor, source, orderNo, now });
    if (id) created.push(id);
  }
  return created;
}

/**
 * Kritik eşik (yönetici, STOCK_MANAGE — işlemde ve burada). Eşik değişikliği ürünü kritik hâle getirirse (önceki eşikte
 * kritik değildi) tek açık "Kritik stok" kaydı açılır. Eşik kaldırılırsa açık kayıt "Gördüm" ile kapanana kadar durur.
 * @param {{ productId: string, threshold: unknown }} p
 * @returns {Promise<{ ok: true, alertId: string | null } | { ok: false, code: 'FORBIDDEN' | 'BAD_THRESHOLD' | 'NOT_FOUND' | 'NO_CHANGE' }>}
 */
export async function setCriticalStock(db, { productId, threshold }, actor) {
  if (!can(actor?.role, 'STOCK_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  const t = parseThreshold(threshold);
  if (!t.ok) return { ok: false, code: 'BAD_THRESHOLD' };
  return db.$transaction(async (tx) => {
    await lockStock(tx, [productId]);
    const p = await tx.profileProduct.findUnique({ where: { id: String(productId ?? '') }, select: { id: true, code: true, nameTr: true, nameRo: true, unitCode: true, criticalStock: true } });
    if (!p) return { ok: false, code: 'NOT_FOUND' };
    if (p.criticalStock === t.value) return { ok: false, code: 'NO_CHANGE' };
    await tx.profileProduct.update({ where: { id: p.id }, data: { criticalStock: t.value } });
    const stock = (await stockLevels(tx, [p.id])).get(p.id) ?? 0;
    await writeAudit(tx, { action: 'STOCK_THRESHOLD', entityType: 'ProfileProduct', entityId: p.id, userId: actor.id, details: { code: p.code, before: p.criticalStock, after: t.value, stock } }, actor);
    const nowCritical = t.value != null && stock <= t.value;
    const wasCritical = p.criticalStock != null && stock <= p.criticalStock;
    const alertId = nowCritical && !wasCritical
      ? await createCriticalAlert(tx, { product: { ...p, criticalStock: t.value }, stock, actor, source: 'THRESHOLD' })
      : null;
    return { ok: true, alertId };
  });
}

// ---------- hareketler ----------

/**
 * Elle stok hareketi (yönetici — STOCK_MANAGE işlemde ve burada): giriş ya da sayım düzeltmesi. Ürün kilidi altında.
 * @param {{ productId: string, kind: 'GIRIS' | 'SAYIM', qty: number, note?: string | null }} m  SAYIM'da qty sayılan adettir (fark hareket olarak yazılır)
 * @returns {Promise<{ ok: true, delta: number } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_QTY' | 'NO_CHANGE' }>}
 */
export async function addStockMovement(db, m, actor) {
  if (!can(actor?.role, 'STOCK_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  if (!Number.isInteger(m.qty) || Math.abs(m.qty) > MAX_STOCK_QTY || (m.kind === 'GIRIS' && m.qty === 0) || (m.kind === 'SAYIM' && m.qty < 0)) {
    return { ok: false, code: 'BAD_QTY' };
  }
  return db.$transaction(async (tx) => {
    // Aynı ürüne aynı anda iki sayım, ya da sayımla bir depo çıkışı / iade yazılmasın (karar 177)
    await lockStock(tx, [m.productId]);
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
    await recordCriticalStock(tx, { productIds: [product.id], before: new Map([[product.id, current]]), actor, source: m.kind });
    return { ok: true, delta };
  });
}

/**
 * Siparişin kalemlerini stoktan düşer (depoya gönderilirken, iş akışı işleminin içinde). Bir kez yapılır (çağıran
 * stockDeducted'a bakar). Ürün kilitleri altında; eşiğin altına inen ürün için "Kritik stok" kaydı.
 * @param {any} tx
 * @param {{ orderId: string, orderNo: string, items: { productId: string | null, qty: number }[], actorId: string | null,
 *   actor?: { id?: string | null, role?: string, ip?: string | null } | null }} p
 */
export async function deductOrderStock(tx, { orderId, orderNo, items, actorId, actor = null }) {
  const rows = items.filter((i) => i.productId);
  if (!rows.length) return 0;
  const ids = rows.map((i) => /** @type {string} */ (i.productId));
  await lockStock(tx, ids);
  const before = await stockLevels(tx, ids);
  const data = rows.map((i) => ({ productId: i.productId, qty: -i.qty, kind: 'CIKIS', orderId, note: orderNo, createdById: actorId }));
  await tx.stockMovement.createMany({ data });
  await recordCriticalStock(tx, { productIds: ids, before, actor, source: 'CIKIS', orderNo });
  return data.length;
}

/** İptal edilen (depoya gitmiş) siparişin çıkışlarını geri alır (ürün kilitleri altında). */
export async function returnOrderStock(tx, { orderId, orderNo, actorId }) {
  const out = await tx.stockMovement.findMany({ where: { orderId, kind: 'CIKIS' } });
  if (!out.length) return 0;
  await lockStock(tx, out.map((m) => m.productId));
  const data = out.map((m) => ({ productId: m.productId, qty: -m.qty, kind: 'IADE', orderId, note: orderNo, createdById: actorId }));
  await tx.stockMovement.createMany({ data });
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
 * Excel'deki adetleri uygular (yönetici — STOCK_MANAGE işlemde ve burada). mode GIRIS: adetler stoğa eklenir · SAYIM: stok
 * bu adede eşitlenir. Dosyadaki ürünlerin kilitleri sıralı alınır (elle sayım ve depo çıkışıyla aynı kilitler).
 * @returns {Promise<{ ok: true, applied: number, unknown: string[] } | { ok: false, code: 'FORBIDDEN' }>}
 */
export async function applyStockImport(db, items, mode, actor) {
  if (!can(actor?.role, 'STOCK_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  return db.$transaction(async (tx) => {
    const products = await tx.profileProduct.findMany({ where: { code: { in: items.map((i) => i.code) } }, select: { id: true, code: true } });
    await lockStock(tx, products.map((p) => p.id));
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
    await recordCriticalStock(tx, { productIds: data.map((d) => d.productId), before: levels, actor, source: mode });
    return { ok: true, applied: data.length, unknown };
  });
}
