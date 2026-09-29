// Fiyat tabloları (Aşama 3b, karar 26).
// Yönetici fiyat tabloları tutar: cam başına m² fiyatı, delik ve CNC için adet başına sabit fiyat.
// Her satışçı bir tabloya atanır; ataması olmayan ya da tablosu pasif olan satışçı varsayılan tabloyu kullanır.
// Satışçı siparişe karar verince açılan teklifin cam satırları bu tablodaki fiyatlarla dolu gelir.
// Satışçı fiyatı değiştirebilir; liste fiyatından farklı fiyatla yöneticiye gönderirse yöneticinin
// "Önemli kararlar" listesine uyarı düşer (server/pricing/alerts.js). "Açık tekliflere uygula" yoktur:
// tablo değişince açık tekliflerin satırları değişmez (satırlar liste fiyatını teklif anındaki haliyle saklar).
// Excel düzeni ürün sahibinin dosyasıyla aynı: üstte "Para birimi" (ve isteğe bağlı "Delik fiyatı", "CNC fiyatı"),
// sonra "Cam adı | Renk | Birim fiyat" başlığı ve satırlar. Boş bırakılan fiyat değişmez.
import { writeAudit } from '../orders/journal.js';
import { clean, glassKey, glassLabel, parseNumber } from '../catalog/glass.js';

export const CURRENCIES = ['EUR', 'RON', 'TRY', 'USD'];
export const MAX_PRICE = 1_000_000;
export const MAX_PRICE_ROWS = 2000;

/** Fiyat: sayı (virgül de olur), 0 ile MAX_PRICE arası, iki haneye yuvarlanır. Boş → null, geçersiz → NaN */
export function parsePrice(v) {
  const n = parseNumber(v);
  if (n == null) return null;
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) return NaN;
  return Math.round(n * 100) / 100;
}

const num = (d) => (d == null ? null : Number(d));

/**
 * Tablo bilgileri (ad, para birimi, delik / CNC fiyatı).
 * @returns {{ ok: true, value: { name: string, currency: string, holePrice: number | null, cncPrice: number | null } } | { ok: false, errors: string[] }}
 *   hata kodları: NAME, CURRENCY, HOLE_PRICE, CNC_PRICE
 */
export function validateTable(raw) {
  const errors = [];
  const name = clean(raw.name).slice(0, 120);
  const currency = clean(raw.currency).toUpperCase();
  const holePrice = parsePrice(raw.holePrice);
  const cncPrice = parsePrice(raw.cncPrice);
  if (!name) errors.push('NAME');
  if (!CURRENCIES.includes(currency)) errors.push('CURRENCY');
  if (Number.isNaN(holePrice)) errors.push('HOLE_PRICE');
  if (Number.isNaN(cncPrice)) errors.push('CNC_PRICE');
  return errors.length ? { ok: false, errors } : { ok: true, value: { name, currency, holePrice, cncPrice } };
}

// ---------------- Excel ----------------

const up = (v) => clean(v).toLocaleUpperCase('tr-TR');
const META = { 'PARA BİRİMİ': 'currency', 'DELİK FİYATI': 'holePrice', 'CNC FİYATI': 'cncPrice' };

/**
 * Fiyat Excel'ini okur.
 * @param {(string | number | boolean | null)[][]} rows
 * @returns {{ ok: false, error: 'HEADERS' | 'EMPTY' | 'TOO_MANY' } | {
 *   ok: true, currency: string | null, holePrice: number | null | undefined, cncPrice: number | null | undefined,
 *   items: { row: number, key: string, label: string, price: number }[], blank: number,
 *   errors: { row: number, label: string, codes: string[] }[] }}
 *   holePrice / cncPrice: undefined → dosyada satırı yok (değişmez), null → boş (değişmez)
 */
export function parsePriceSheet(rows) {
  const h = rows.findIndex((r) => up((r ?? [])[0]) === 'CAM ADI' && (r ?? []).some((c) => up(c).includes('FİYAT')));
  if (h < 0) return { ok: false, error: 'HEADERS' };
  const head = rows[h].map(up);
  const colName = 0;
  const colColor = head.findIndex((c) => c === 'RENK');
  const colPrice = head.findIndex((c) => c.includes('FİYAT'));

  const meta = { currency: null, holePrice: undefined, cncPrice: undefined };
  const errors = [];
  for (const [i, r] of rows.slice(0, h).entries()) {
    const k = META[up((r ?? [])[0])];
    if (!k) continue;
    if (k === 'currency') meta.currency = up(r[1]) || null;
    else {
      const p = parsePrice(r[1]);
      if (Number.isNaN(p)) errors.push({ row: i + 1, label: clean(r[0]), codes: ['PRICE'] });
      else meta[k] = p;
    }
  }

  const data = rows.slice(h + 1).map((r, i) => ({ r: r ?? [], row: h + 2 + i })).filter(({ r }) => r.some((c) => clean(c) !== ''));
  if (data.length === 0) return { ok: false, error: 'EMPTY' };
  if (data.length > MAX_PRICE_ROWS) return { ok: false, error: 'TOO_MANY' };
  const items = [];
  const seen = new Set();
  let blank = 0;
  for (const { r, row } of data) {
    const name = clean(r[colName]);
    const color = colColor >= 0 ? clean(r[colColor]) : '';
    const label = [name, color].filter(Boolean).join(' — ');
    if (!name) { errors.push({ row, label, codes: ['NAME'] }); continue; }
    const price = parsePrice(r[colPrice]);
    if (price == null) { blank++; continue; }
    if (Number.isNaN(price)) { errors.push({ row, label, codes: ['PRICE'] }); continue; }
    const key = glassKey(name, color);
    if (seen.has(key)) { errors.push({ row, label, codes: ['DUPLICATE'] }); continue; }
    seen.add(key);
    items.push({ row, key, label, price });
  }
  return { ok: true, ...meta, items, blank, errors };
}

/**
 * Excel'deki fiyatları tablonun mevcut fiyatlarıyla karşılaştırır.
 * @param {{ currency: string, holePrice: unknown, cncPrice: unknown }} table
 * @param {{ id: string, nameTr: string, colorTr: string }[]} glasses  katalogdaki tüm camlar
 * @param {Map<string, number>} current  camId → fiyat
 * @param {ReturnType<typeof parsePriceSheet> & { ok: true }} sheet
 */
export function planPriceImport(table, glasses, current, sheet) {
  const byKey = new Map(glasses.map((g) => [glassKey(g.nameTr, g.colorTr), g]));
  const set = [];
  const unknown = [];
  let unchanged = 0;
  for (const it of sheet.items) {
    const g = byKey.get(it.key);
    if (!g) { unknown.push({ row: it.row, label: it.label }); continue; }
    const before = current.get(g.id) ?? null;
    if (before === it.price) unchanged++;
    else set.push({ glassProductId: g.id, label: glassLabel(g, 'tr'), before, after: it.price });
  }
  /** @type {{ holePrice?: { before: number | null, after: number }, cncPrice?: { before: number | null, after: number } }} */
  const extra = {};
  for (const k of /** @type {const} */ (['holePrice', 'cncPrice'])) {
    const v = sheet[k];
    if (v != null && v !== num(table[k])) extra[k] = { before: num(table[k]), after: v };
  }
  const currencyMismatch = !!sheet.currency && sheet.currency !== table.currency;
  return { set, unchanged, unknown, extra, currencyMismatch };
}

/**
 * Fiyat Excel'inin satırları (ürün sahibinin dosya düzeni; yeniden yüklenebilir).
 * @param {{ name: string, currency: string, holePrice: unknown, cncPrice: unknown }} table
 * @param {object[]} glasses  sıralı; pasif camlar dahil edilmez
 * @param {Map<string, number>} prices
 */
export function priceSheetRows(table, glasses, prices) {
  return [
    [`${table.name} (${table.currency})`],
    ['Para birimi', table.currency],
    ['Delik fiyatı', num(table.holePrice) ?? ''],
    ['CNC fiyatı', num(table.cncPrice) ?? ''],
    ['Not', 'Fiyat sütununu doldurup geri yükleyin. Boş bırakılan satır değişmez.'],
    [],
    ['Cam adı', 'Renk', 'Birim fiyat'],
    ...glasses.filter((g) => g.isActive).map((g) => [g.nameTr, g.colorTr ?? '', prices.get(g.id) ?? '']),
  ];
}

// ---------------- Tablonun seçimi ----------------

/**
 * Kullanıcının kullandığı tablo: kendi etkin tablosu, yoksa etkin varsayılan tablo, o da yoksa null.
 * @param {{ priceTableId?: string | null }} user
 * @param {{ id: string, isActive: boolean, isDefault: boolean }[]} tables
 */
export function resolveTable(user, tables) {
  const own = user.priceTableId ? tables.find((t) => t.id === user.priceTableId && t.isActive) : null;
  return own ?? tables.find((t) => t.isDefault && t.isActive) ?? null;
}

/**
 * Tablonun fiyat bilgisi (teklif satırlarını doldurmak için).
 * @returns {Promise<null | { id: string, name: string, currency: string, holePrice: number | null, cncPrice: number | null, prices: Map<string, number> }>}
 */
export async function loadPricing(db, tableId) {
  if (!tableId) return null;
  const t = await db.priceTable.findUnique({ where: { id: tableId }, include: { items: true } });
  if (!t) return null;
  return {
    id: t.id, name: t.name, currency: t.currency, holePrice: num(t.holePrice), cncPrice: num(t.cncPrice),
    prices: new Map(t.items.map((i) => [i.glassProductId, Number(i.unitPrice)])),
  };
}

/** Kullanıcının tablosunun fiyat bilgisi (ya da null). */
export async function pricingForUser(db, userId) {
  const [user, tables] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { priceTableId: true } }),
    db.priceTable.findMany({ where: { isActive: true, kind: 'SALES' }, select: { id: true, isActive: true, isDefault: true } }),
  ]);
  const t = user ? resolveTable(user, tables) : null;
  return t ? loadPricing(db, t.id) : null;
}

// ---------------- Teklif satırları ----------------

/** Liste fiyatı (varsa) */
function tablePrice(pricing, kind, glassProductId) {
  if (!pricing) return null;
  if (kind === 'DELIK') return pricing.holePrice;
  if (kind === 'CNC') return pricing.cncPrice;
  return glassProductId ? pricing.prices.get(glassProductId) ?? null : null;
}

/**
 * Siparişin cam kalemlerinden satışçının ilk teklif satırları: cam, adet, liste fiyatı.
 * @param {{ glassProductId?: string | null, glassName?: string | null, glassNameRo?: string | null, glassWeightKgM2?: unknown, camAdedi?: number }[]} items
 */
export function prefillLines(items, pricing) {
  return items.map((it, i) => {
    const listPrice = tablePrice(pricing, 'CAM', it.glassProductId);
    return {
      sortOrder: i, kind: 'CAM', unit: 'm2', adet: Math.max(1, it.camAdedi || 1),
      description: it.glassName || '', descriptionRo: it.glassNameRo || null,
      glassProductId: it.glassProductId ?? null, weightKgM2: it.glassWeightKgM2 == null ? null : Number(it.glassWeightKgM2),
      listPrice, unitPrice: (listPrice ?? 0).toFixed(2),
    };
  });
}

/**
 * Kaydedilen teklif satırlarını sunucu tarafında tamamlar (tarayıcıdan gelen değerlere güvenilmez):
 *  - cam satırının açıklaması katalogdaki bir camın (Türkçe ya da Romence) adıysa: cam, iki dildeki adı ve ağırlığı
 *    (siparişteki anlık kopya varsa o, yoksa katalogdaki);
 *  - liste fiyatı: aynı cam / aynı tür için daha önce kaydedilmiş liste fiyatı (teklif anındaki fiyat korunur),
 *    yoksa tablodaki fiyat. Delik ve CNC satırları tablonun sabit fiyatını kullanır.
 * @param {object[]} lines  { description, kind, unitPrice, free, ... }
 * @param {{ glasses: object[], items?: object[], previous?: object[], pricing: Awaited<ReturnType<typeof loadPricing>> }} ctx
 */
export function enrichLines(lines, { glasses, items = [], previous = [], pricing }) {
  const byLabel = new Map();
  for (const g of glasses) {
    for (const loc of ['tr', 'ro']) {
      const k = up(glassLabel(g, loc));
      if (!byLabel.has(k)) byLabel.set(k, g);
    }
  }
  // Siparişteki kalemlerin anlık adları da tanınır (cam katalogda yeniden adlandırılmış olabilir)
  const itemById = new Map();
  for (const it of items) {
    if (!it.glassProductId) continue;
    itemById.set(it.glassProductId, it);
    for (const n of [it.glassName, it.glassNameRo]) if (n && !byLabel.has(up(n))) byLabel.set(up(n), { id: it.glassProductId, fromItem: it });
  }
  const glassById = new Map(glasses.map((g) => [g.id, g]));
  const prevGlass = new Map();
  const prevKind = new Map();
  for (const p of previous) {
    if (p.listPrice == null) continue;
    if (p.kind === 'CAM' && p.glassProductId && !prevGlass.has(p.glassProductId)) prevGlass.set(p.glassProductId, Number(p.listPrice));
    if (p.kind !== 'CAM' && !prevKind.has(p.kind)) prevKind.set(p.kind, Number(p.listPrice));
  }

  return lines.map((l) => {
    if (l.kind !== 'CAM') {
      const listPrice = prevKind.has(l.kind) ? prevKind.get(l.kind) : tablePrice(pricing, l.kind, null);
      return { ...l, glassProductId: null, descriptionRo: null, weightKgM2: null, listPrice: listPrice ?? null };
    }
    const hit = byLabel.get(up(l.description));
    if (!hit) return { ...l, glassProductId: null, descriptionRo: null, weightKgM2: null, listPrice: null };
    const id = hit.id;
    const it = itemById.get(id);
    const g = glassById.get(id);
    const nameTr = it?.glassName || (g ? glassLabel(g, 'tr') : l.description);
    const nameRo = it?.glassNameRo || (g ? glassLabel(g, 'ro') : null);
    const w = it?.glassWeightKgM2 ?? g?.weightKgM2 ?? null;
    const listPrice = prevGlass.has(id) ? prevGlass.get(id) : tablePrice(pricing, 'CAM', id);
    return {
      ...l, description: nameTr, descriptionRo: nameRo, glassProductId: id,
      weightKgM2: w == null ? null : Number(w), listPrice: listPrice ?? null,
    };
  });
}

/**
 * Liste fiyatından farklı fiyatlı satırlar (bedelsiz yapılan satır da sayılır).
 * @param {{ kind: string, description: string, listPrice?: number | null, unitPrice: unknown, free?: boolean }[]} lines
 */
export function priceOverrides(lines) {
  const out = [];
  lines.forEach((l, i) => {
    if (l.listPrice == null) return;
    const price = l.free ? 0 : Number(l.unitPrice);
    if (Math.abs(price - Number(l.listPrice)) < 0.005) return;
    out.push({ line: i + 1, kind: l.kind, description: l.description, listPrice: Number(l.listPrice), unitPrice: price, free: !!l.free });
  });
  return out;
}

// ---------------- Yönetici işlemleri ----------------

const lockTables = (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('price-tables', 0))`;

/**
 * Tablo ekler ya da düzenler. İlk satış tablosu kendiliğinden varsayılan olur (müşteri tablolarında varsayılan yok).
 * @param {'SALES' | 'CUSTOMER'} [kind]  yeni tablonun türü
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: 'EXISTS' | 'NOT_FOUND' | 'CURRENCY_LOCKED' }>}
 */
export async function saveTable(db, id, value, actor, kind = 'SALES') {
  return db.$transaction(async (tx) => {
    await lockTables(tx);
    const clash = await tx.priceTable.findFirst({ where: { name: { equals: value.name, mode: 'insensitive' }, ...(id ? { NOT: { id } } : {}) } });
    if (clash) return { ok: false, code: 'EXISTS' };
    if (id) {
      const before = await tx.priceTable.findUnique({ where: { id } });
      if (!before) return { ok: false, code: 'NOT_FOUND' };
      // Teklifte kullanılmış tablonun para birimi değişmez (satırlar o para birimindeki fiyatları taşır)
      if (before.currency !== value.currency && (await tx.offer.count({ where: { priceTableId: id } })) > 0) return { ok: false, code: 'CURRENCY_LOCKED' };
      await tx.priceTable.update({ where: { id }, data: value });
      await writeAudit(tx, {
        action: 'PRICE_TABLE_UPDATE', entityType: 'PriceTable', entityId: id, userId: actor.id,
        details: { before: tableAudit(before), after: value },
      }, actor);
      return { ok: true, id };
    }
    const first = kind === 'SALES' && (await tx.priceTable.count({ where: { kind: 'SALES' } })) === 0;
    const t = await tx.priceTable.create({ data: { ...value, kind, isDefault: first } });
    await writeAudit(tx, { action: 'PRICE_TABLE_CREATE', entityType: 'PriceTable', entityId: t.id, userId: actor.id, details: { ...value, kind, isDefault: first } }, actor);
    return { ok: true, id: t.id };
  });
}

const tableAudit = (t) => ({ name: t.name, currency: t.currency, holePrice: num(t.holePrice), cncPrice: num(t.cncPrice), isActive: t.isActive, isDefault: t.isDefault });

/**
 * toggle (etkin/pasif) · default (varsayılan yap) · delete (yalnızca hiç teklifte kullanılmadıysa).
 * Varsayılan tablo pasife alınamaz ve silinemez (önce başka tablo varsayılan yapılır).
 * @returns {Promise<{ ok: true } | { ok: false, code: 'NOT_FOUND' | 'IS_DEFAULT' | 'INACTIVE' | 'IN_USE' }>}
 */
export async function changeTable(db, id, intent, actor) {
  return db.$transaction(async (tx) => {
    await lockTables(tx);
    const t = await tx.priceTable.findUnique({ where: { id } });
    if (!t) return { ok: false, code: 'NOT_FOUND' };
    if (intent === 'toggle') {
      if (t.isDefault && t.isActive) return { ok: false, code: 'IS_DEFAULT' };
      await tx.priceTable.update({ where: { id }, data: { isActive: !t.isActive } });
    } else if (intent === 'default') {
      if (t.kind !== 'SALES') return { ok: false, code: 'NOT_FOUND' };
      if (!t.isActive) return { ok: false, code: 'INACTIVE' };
      await tx.priceTable.updateMany({ where: { kind: 'SALES', isDefault: true, NOT: { id } }, data: { isDefault: false } });
      await tx.priceTable.update({ where: { id }, data: { isDefault: true } });
    } else if (intent === 'delete') {
      if (t.isDefault) return { ok: false, code: 'IS_DEFAULT' };
      if ((await tx.offer.count({ where: { priceTableId: id } })) > 0) return { ok: false, code: 'IN_USE' };
      await tx.priceTable.delete({ where: { id } });
    } else return { ok: false, code: 'NOT_FOUND' };
    await writeAudit(tx, { action: `PRICE_TABLE_${intent.toUpperCase()}`, entityType: 'PriceTable', entityId: id, userId: actor.id, details: tableAudit(t) }, actor);
    return { ok: true };
  });
}

/**
 * Fiyatları kaydeder: camId → fiyat (null → fiyat kaldırılır). Yalnızca değişenler yazılır; denetime önce/sonra.
 * @param {Record<string, number | null>} changes
 * @param {{ holePrice?: number | null, cncPrice?: number | null }} [extra]  undefined → değişmez
 * @returns {Promise<{ ok: true, changed: number } | { ok: false, code: 'NOT_FOUND' }>}
 */
export async function savePrices(db, tableId, changes, actor, extra = {}, source = 'form') {
  return db.$transaction(async (tx) => {
    await lockTables(tx);
    const t = await tx.priceTable.findUnique({ where: { id: tableId }, include: { items: true } });
    if (!t) return { ok: false, code: 'NOT_FOUND' };
    const cur = new Map(t.items.map((i) => [i.glassProductId, Number(i.unitPrice)]));
    const ids = Object.keys(changes);
    const glasses = await tx.glassProduct.findMany({ where: { id: { in: ids } } });
    const byId = new Map(glasses.map((g) => [g.id, g]));
    const log = [];
    for (const gid of ids) {
      const g = byId.get(gid);
      if (!g) continue;
      const after = changes[gid];
      const before = cur.get(gid) ?? null;
      if (after === before) continue;
      if (after == null) await tx.priceTableItem.delete({ where: { tableId_glassProductId: { tableId, glassProductId: gid } } });
      else {
        await tx.priceTableItem.upsert({
          where: { tableId_glassProductId: { tableId, glassProductId: gid } },
          create: { tableId, glassProductId: gid, unitPrice: after },
          update: { unitPrice: after },
        });
      }
      log.push({ glass: glassLabel(g, 'tr'), before, after });
    }
    const fixed = {};
    for (const k of ['holePrice', 'cncPrice']) {
      if (extra[k] === undefined || extra[k] === num(t[k])) continue;
      fixed[k] = { before: num(t[k]), after: extra[k] };
    }
    if (Object.keys(fixed).length) {
      await tx.priceTable.update({ where: { id: tableId }, data: Object.fromEntries(Object.entries(fixed).map(([k, v]) => [k, v.after])) });
    }
    if (log.length || Object.keys(fixed).length) {
      await tx.priceTable.update({ where: { id: tableId }, data: { updatedAt: new Date() } });
      await writeAudit(tx, {
        action: 'PRICE_UPDATE', entityType: 'PriceTable', entityId: tableId, userId: actor.id,
        details: { table: t.name, source, changed: log.length, prices: log.slice(0, 500), fixed },
      }, actor);
    }
    return { ok: true, changed: log.length + Object.keys(fixed).length };
  });
}

/**
 * Satışçıyı tabloya atar (tableId null → atama kaldırılır, varsayılan kullanılır).
 * Yalnızca teklif hazırlayabilen iç kullanıcılar atanabilir.
 * @returns {Promise<{ ok: true } | { ok: false, code: 'NOT_FOUND' }>}
 */
export async function assignTable(db, userId, tableId, actor, canPrepare) {
  return db.$transaction(async (tx) => {
    const u = await tx.user.findUnique({ where: { id: userId } });
    if (!u || u.type !== 'INTERNAL' || !canPrepare(u.appRole)) return { ok: false, code: 'NOT_FOUND' };
    if (tableId && !(await tx.priceTable.findFirst({ where: { id: tableId, kind: 'SALES' } }))) return { ok: false, code: 'NOT_FOUND' };
    await tx.user.update({ where: { id: userId }, data: { priceTableId: tableId } });
    await writeAudit(tx, {
      action: 'PRICE_TABLE_ASSIGN', entityType: 'User', entityId: userId, userId: actor.id,
      details: { user: u.email, before: u.priceTableId, after: tableId },
    }, actor);
    return { ok: true };
  });
}

// ---------------- Müşteri fiyatları (karar 4 + 32) ----------------

/** Müşteri firmasının etkin müşteri fiyat tablosu (ya da null). */
export async function pricingForCustomer(db, customerId) {
  const c = await db.customer.findUnique({ where: { id: customerId }, select: { priceTable: { select: { id: true, kind: true, isActive: true } } } });
  const t = c?.priceTable;
  return t && t.kind === 'CUSTOMER' && t.isActive ? loadPricing(db, t.id) : null;
}

/**
 * Yönetim kopyasında müşteri fiyatı boş satırları müşteri fiyat tablosundan doldurur (cam m² fiyatı; delik / CNC adet
 * fiyatı). Tabloda yoksa boş kalır, yönetici elle girer. Dolu satıra dokunulmaz.
 * @template {{ kind: string, glassProductId?: string | null, offerPrice?: unknown }} L
 * @param {L[]} lines
 * @returns {L[]}
 */
export function prefillOfferPrices(lines, pricing) {
  if (!pricing) return lines;
  return lines.map((l) => {
    if (l.offerPrice != null && l.offerPrice !== '') return l;
    const p = tablePrice(pricing, l.kind, l.glassProductId ?? null);
    return p == null ? l : { ...l, offerPrice: p };
  });
}

/**
 * Müşteri firmasını müşteri fiyat tablosuna bağlar (tableId null → bağlantı kaldırılır).
 * @returns {Promise<{ ok: true } | { ok: false, code: 'NOT_FOUND' }>}
 */
export async function assignCustomerTable(db, customerId, tableId, actor) {
  return db.$transaction(async (tx) => {
    const c = await tx.customer.findUnique({ where: { id: customerId } });
    if (!c || c.type !== 'CUSTOMER') return { ok: false, code: 'NOT_FOUND' };
    if (tableId && !(await tx.priceTable.findFirst({ where: { id: tableId, kind: 'CUSTOMER' } }))) return { ok: false, code: 'NOT_FOUND' };
    await tx.customer.update({ where: { id: customerId }, data: { priceTableId: tableId } });
    await writeAudit(tx, {
      action: 'CUSTOMER_PRICE_TABLE_ASSIGN', entityType: 'Customer', entityId: customerId, userId: actor.id,
      details: { customer: c.name, before: c.priceTableId, after: tableId },
    }, actor);
    return { ok: true };
  });
}
