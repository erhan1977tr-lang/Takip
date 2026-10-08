// Profil ürün kataloğu (Aşama 6): yönetici yönetir; müşteri profil siparişinde görsel, ad/kod, birim ve adetle seçer.
// Ürün kodu kalıcıdır (sonradan değişmez). Pasif ürün / kategori müşteri formunda görünmez.
// Excel düzeni: "Kategori | Kod | Ad (RO) | Ad (TR) | Birim | Liste fiyatı (EUR) | Aktif"; ürün Koddan tanınır.
import { writeAudit } from '../orders/journal.js';
import { can } from '../auth/permissions.js';
import { clean, parseActive } from '../catalog/glass.js';
import { parsePrice } from './rules.js';
import { UNITS } from '../../prisma/seed/data/units.js';

export const UNIT_CODES = UNITS.map((u) => u.code);
export const PRODUCT_HEADERS = ['Kategori', 'Kod', 'Ad (RO)', 'Ad (TR)', 'Birim', 'Liste fiyatı (EUR)', 'Aktif'];
const FIELDS = ['categoryCode', 'code', 'nameRo', 'nameTr', 'unitCode', 'listPrice', 'isActive'];
export const MAX_PRODUCTS_IMPORT = 1000;

/** Birimin kullanıcının dilindeki adı */
export function unitLabel(code, locale) {
  const u = UNITS.find((x) => x.code === code);
  return u ? u.name[locale] ?? u.name.ro : code;
}
/** Ürünün / kategorinin kullanıcının dilindeki adı (Romence boşsa Türkçe) */
export const localName = (x, locale) => (locale === 'tr' ? x.nameTr || x.nameRo : x.nameRo || x.nameTr);

/** Kod: büyük harf, rakam, tire, alt çizgi, nokta; 1–40 karakter */
export function cleanCode(v) {
  const s = clean(v).toUpperCase().replace(/\s+/g, '-');
  return /^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(s) ? s : null;
}

/**
 * @typedef {{ code: string, categoryCode: string, nameRo: string, nameTr: string, unitCode: string, listPrice: number | null, isActive: boolean }} ProductInput
 * @returns {{ ok: true, value: ProductInput } | { ok: false, errors: string[] }}  hata kodları: CODE, CATEGORY, NAME_RO, NAME_TR, TOO_LONG, UNIT, PRICE, ACTIVE
 */
export function validateProduct(raw) {
  const errors = [];
  const unit = clean(raw.unitCode).toUpperCase();
  const v = {
    code: cleanCode(raw.code), categoryCode: clean(raw.categoryCode).toUpperCase().replace(/\s+/g, '_'),
    nameRo: clean(raw.nameRo), nameTr: clean(raw.nameTr),
    unitCode: UNIT_CODES.includes(unit) ? unit : UNITS.find((u) => [u.name.ro, u.name.tr].some((n) => n.toUpperCase() === unit))?.code ?? null,
    listPrice: parsePrice(raw.listPrice), isActive: parseActive(raw.isActive),
  };
  if (!v.code) errors.push('CODE');
  if (!v.categoryCode) errors.push('CATEGORY');
  if (!v.nameRo) errors.push('NAME_RO');
  if (!v.nameTr) v.nameTr = v.nameRo;
  if (v.nameRo.length > 160 || v.nameTr.length > 160) errors.push('TOO_LONG');
  if (!v.unitCode) errors.push('UNIT');
  if (Number.isNaN(v.listPrice)) errors.push('PRICE');
  if (v.isActive == null) errors.push('ACTIVE');
  return errors.length ? { ok: false, errors } : { ok: true, value: /** @type {ProductInput} */ (v) };
}

/** @returns {{ ok: true, value: { code: string, nameRo: string, nameTr: string, isActive: boolean } } | { ok: false, errors: string[] }} */
export function validateCategory(raw) {
  const errors = [];
  const v = {
    code: clean(raw.code).toUpperCase().replace(/\s+/g, '_'), nameRo: clean(raw.nameRo), nameTr: clean(raw.nameTr),
    isActive: raw.isActive !== false,
  };
  if (!/^[A-Z0-9_]{1,40}$/.test(v.code)) errors.push('CODE');
  if (!v.nameRo) errors.push('NAME_RO');
  if (!v.nameTr) v.nameTr = v.nameRo;
  if (v.nameRo.length > 80 || v.nameTr.length > 80) errors.push('TOO_LONG');
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}

const plain = (p) => ({
  code: p.code, categoryCode: p.category?.code ?? p.categoryCode, nameRo: p.nameRo, nameTr: p.nameTr, unitCode: p.unitCode,
  listPrice: p.listPrice == null ? null : Number(p.listPrice), isActive: !!p.isActive,
});
const COMPARE = ['categoryCode', 'nameRo', 'nameTr', 'unitCode', 'listPrice', 'isActive'];
const PACK_FIELDS = ['packContent', 'packMeasure'];
/** Paket içeriği karşılaştırma için düz değer ("137", "M"; boş → null) */
const packOf = (p) => ({ packContent: p.packContent == null ? null : String(Number(p.packContent.toString())), packMeasure: p.packMeasure ?? null });
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
// Alış bilgisi (Paket 6, karar 180): tedarikçi, alış fiyatı, alış para birimi, sipariş birimi — yalnızca SUPPLIER_MANAGE
const PURCHASE_FIELDS = ['supplierId', 'purchasePrice', 'purchaseCurrency', 'purchaseUnit'];
/** Alış bilgisi karşılaştırma için düz değer ("12.5"; boş → null) */
const purchaseOf = (p) => ({
  supplierId: p.supplierId ?? null, purchasePrice: p.purchasePrice == null ? null : String(Number(p.purchasePrice.toString())),
  purchaseCurrency: p.purchaseCurrency ?? null, purchaseUnit: p.purchaseUnit ?? null,
});
const lock = (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('profile-catalog', 0))`;

/**
 * Ürün ekler ya da düzenler. Düzenlemede kod değişmez.
 * pack (yalnızca katalog formu — Excel bu alanlara dokunmaz): paket içeriği ve ölçüsü (hesaplayıcı — karar 175;
 * server/profile/calculator.js → parsePack). Verilmezse bu alanlar değişmez.
 * @param {string | null} id
 * @param {ProductInput} value
 * @param {any} actor
 * purchase (yalnızca katalog formu ve yalnızca SUPPLIER_MANAGE — Paket 6, karar 180): tedarikçi, alış fiyatı, alış para
 * birimi, sipariş birimi (server/suppliers/rules.js → parsePurchase). Verilmezse bu alanlar değişmez; müşterinin liste
 * fiyatından tamamen ayrıdır. Yeni seçilen tedarikçi etkin olmalı (mevcut pasif tedarikçi korunabilir).
 * @param {{ packContent: string | null, packMeasure: 'M' | 'BUC' | null }} [pack]
 * @param {{ supplierId: string | null, purchasePrice: string | null, purchaseCurrency: string | null, purchaseUnit: string | null }} [purchase]
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: 'EXISTS' | 'NOT_FOUND' | 'CATEGORY' | 'FORBIDDEN' | 'SUPPLIER' }>}
 */
export async function saveProduct(db, id, value, actor, pack = undefined, purchase = undefined) {
  if (purchase && !can(actor?.role, 'SUPPLIER_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  return db.$transaction(async (tx) => {
    await lock(tx);
    const category = await tx.profileCategory.findUnique({ where: { code: value.categoryCode } });
    if (!category) return { ok: false, code: 'CATEGORY' };
    const data = {
      categoryId: category.id, nameRo: value.nameRo, nameTr: value.nameTr, unitCode: value.unitCode,
      listPrice: value.listPrice == null ? null : value.listPrice.toFixed(2), isActive: value.isActive,
      ...(pack ? { packContent: pack.packContent, packMeasure: pack.packMeasure } : {}),
      ...(purchase ? { supplierId: purchase.supplierId, purchasePrice: purchase.purchasePrice, purchaseCurrency: purchase.purchaseCurrency, purchaseUnit: purchase.purchaseUnit } : {}),
    };
    const cur = id ? await tx.profileProduct.findUnique({ where: { id }, include: { category: true } }) : null;
    if (purchase?.supplierId && purchase.supplierId !== cur?.supplierId) {
      const sup = await tx.supplier.findUnique({ where: { id: purchase.supplierId }, select: { isActive: true } });
      if (!sup?.isActive) return { ok: false, code: 'SUPPLIER' };
    }
    if (id) {
      if (!cur) return { ok: false, code: 'NOT_FOUND' };
      const before = { ...plain(cur), ...(pack ? packOf(cur) : {}), ...(purchase ? purchaseOf(cur) : {}) };
      const after = { ...value, code: cur.code, ...(pack ? packOf(pack) : {}), ...(purchase ? purchaseOf(purchase) : {}) };
      const changes = [...COMPARE, ...(pack ? PACK_FIELDS : []), ...(purchase ? PURCHASE_FIELDS : [])].filter((f) => before[f] !== after[f]);
      const moved = cur.categoryId !== category.id;
      const sortOrder = moved ? await nextSort(tx, category.id) : cur.sortOrder;
      await tx.profileProduct.update({ where: { id }, data: { ...data, sortOrder } });
      if (changes.length) {
        await writeAudit(tx, {
          action: 'PROFILE_PRODUCT_UPDATE', entityType: 'ProfileProduct', entityId: id, userId: actor.id,
          details: { code: cur.code, fields: changes, before: pick(before, changes), after: pick(after, changes) },
        }, actor);
      }
      return { ok: true, id };
    }
    if (await tx.profileProduct.findUnique({ where: { code: value.code } })) return { ok: false, code: 'EXISTS' };
    const p = await tx.profileProduct.create({ data: { ...data, code: value.code, sortOrder: await nextSort(tx, category.id) } });
    await writeAudit(tx, { action: 'PROFILE_PRODUCT_CREATE', entityType: 'ProfileProduct', entityId: p.id, userId: actor.id, details: { after: { ...value, ...(pack ? packOf(pack) : {}), ...(purchase ? purchaseOf(purchase) : {}) } } }, actor);
    return { ok: true, id: p.id };
  });
}

async function nextSort(tx, categoryId) {
  const last = await tx.profileProduct.aggregate({ where: { categoryId }, _max: { sortOrder: true } });
  return (last._max.sortOrder ?? 0) + 10;
}

/**
 * Pasif/aktif ya da kategori içinde bir yukarı/aşağı.
 * @param {'toggle' | 'up' | 'down'} intent
 */
export async function changeProduct(db, id, intent, actor) {
  return db.$transaction(async (tx) => {
    await lock(tx);
    const p = await tx.profileProduct.findUnique({ where: { id } });
    if (!p) return false;
    if (intent === 'toggle') {
      await tx.profileProduct.update({ where: { id }, data: { isActive: !p.isActive } });
      await writeAudit(tx, {
        action: 'PROFILE_PRODUCT_UPDATE', entityType: 'ProfileProduct', entityId: id, userId: actor.id,
        details: { code: p.code, fields: ['isActive'], before: { isActive: p.isActive }, after: { isActive: !p.isActive } },
      }, actor);
      return true;
    }
    const all = await tx.profileProduct.findMany({ where: { categoryId: p.categoryId }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
    const i = all.findIndex((x) => x.id === id);
    const j = intent === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= all.length) return true;
    [all[i], all[j]] = [all[j], all[i]];
    for (const [k, x] of all.entries()) {
      if (x.sortOrder !== (k + 1) * 10) await tx.profileProduct.update({ where: { id: x.id }, data: { sortOrder: (k + 1) * 10 } });
    }
    return true;
  });
}

/**
 * Kategori ekler ya da düzenler (kod değişmez).
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: 'EXISTS' | 'NOT_FOUND' }>}
 */
export async function saveCategory(db, id, value, actor) {
  return db.$transaction(async (tx) => {
    await lock(tx);
    if (id) {
      const cur = await tx.profileCategory.findUnique({ where: { id } });
      if (!cur) return { ok: false, code: 'NOT_FOUND' };
      await tx.profileCategory.update({ where: { id }, data: { nameRo: value.nameRo, nameTr: value.nameTr, isActive: value.isActive } });
      await writeAudit(tx, {
        action: 'PROFILE_CATEGORY_UPDATE', entityType: 'ProfileCategory', entityId: id, userId: actor.id,
        details: { code: cur.code, before: pick(cur, ['nameRo', 'nameTr', 'isActive']), after: pick(value, ['nameRo', 'nameTr', 'isActive']) },
      }, actor);
      return { ok: true, id };
    }
    if (await tx.profileCategory.findUnique({ where: { code: value.code } })) return { ok: false, code: 'EXISTS' };
    const last = await tx.profileCategory.aggregate({ _max: { sortOrder: true } });
    const c = await tx.profileCategory.create({ data: { ...value, sortOrder: (last._max.sortOrder ?? 0) + 1 } });
    await writeAudit(tx, { action: 'PROFILE_CATEGORY_CREATE', entityType: 'ProfileCategory', entityId: c.id, userId: actor.id, details: { after: value } }, actor);
    return { ok: true, id: c.id };
  });
}

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Ürün görselini değiştirir: yeni görsel yeni kayıttır (eskisi, onu gösteren siparişler için kalır). null → görsel kaldırılır.
 * @param {{ data: Buffer, mime: string, size: number, checksum: string, name?: string | null } | null} image  içeriği doğrulanmış görsel
 * @returns {Promise<{ ok: true, imageId: string | null } | { ok: false, code: 'NOT_FOUND' }>}
 */
export async function setProductImage(db, id, image, actor) {
  return db.$transaction(async (tx) => {
    const p = await tx.profileProduct.findUnique({ where: { id } });
    if (!p) return { ok: false, code: 'NOT_FOUND' };
    let imageId = null;
    if (image) {
      const img = await tx.profileImage.create({
        data: { data: image.data, mime: image.mime, size: image.size, checksum: image.checksum, name: image.name ?? null, createdById: actor.id },
      });
      imageId = img.id;
    }
    await tx.profileProduct.update({ where: { id }, data: { imageId } });
    await writeAudit(tx, {
      action: 'PROFILE_PRODUCT_IMAGE', entityType: 'ProfileProduct', entityId: id, userId: actor.id,
      details: { code: p.code, name: image?.name ?? null, checksum: image?.checksum ?? null, before: p.imageId, after: imageId },
    }, actor);
    return { ok: true, imageId };
  });
}

// ---------- Excel ----------
const headerKey = (s) => clean(s).toLocaleUpperCase('tr-TR').replace(/\s/g, '');
const HEADER_KEYS = PRODUCT_HEADERS.map(headerKey);

/**
 * @param {(string | number | boolean | null)[][]} rows
 * @returns {{ ok: false, error: 'HEADERS' | 'EMPTY' | 'TOO_MANY' } | { ok: true, items: { row: number, value: ProductInput }[], errors: { row: number, codes: string[], label: string }[] }}
 */
export function parseProductSheet(rows) {
  const h = rows.findIndex((r) => (r ?? []).some((c) => headerKey(c) === HEADER_KEYS[1]));
  if (h < 0) return { ok: false, error: 'HEADERS' };
  const col = FIELDS.map((_, i) => rows[h].findIndex((c) => headerKey(c) === HEADER_KEYS[i]));
  if (col[5] < 0) col[5] = rows[h].findIndex((c) => headerKey(c).startsWith('LİSTEFİYATI') || headerKey(c).startsWith('LISTEFIYATI'));
  if ([0, 1, 2, 4].some((i) => col[i] < 0)) return { ok: false, error: 'HEADERS' };
  const data = rows.slice(h + 1).map((r, i) => ({ r: r ?? [], row: h + 2 + i })).filter(({ r }) => r.some((c) => clean(c) !== ''));
  if (data.length === 0) return { ok: false, error: 'EMPTY' };
  if (data.length > MAX_PRODUCTS_IMPORT) return { ok: false, error: 'TOO_MANY' };
  const items = [];
  const errors = [];
  const seen = new Set();
  for (const { r, row } of data) {
    const raw = Object.fromEntries(FIELDS.map((f, i) => [f, col[i] >= 0 ? r[col[i]] : null]));
    const res = validateProduct(raw);
    const label = [clean(raw.code), clean(raw.nameRo)].filter(Boolean).join(' — ');
    if (!res.ok) { errors.push({ row, codes: res.errors, label }); continue; }
    if (seen.has(res.value.code)) { errors.push({ row, codes: ['DUPLICATE'], label }); continue; }
    seen.add(res.value.code);
    items.push({ row, value: res.value });
  }
  return { ok: true, items, errors };
}

/**
 * Excel'deki ürünleri mevcut katalogla karşılaştırır.
 * @param {object[]} existing  kategorisiyle birlikte ürünler
 * @param {string[]} categoryCodes  mevcut kategori kodları
 * @param {ProductInput[]} items
 */
export function planProductImport(existing, categoryCodes, items) {
  const byCode = new Map(existing.map((p) => [p.code, p]));
  const cats = new Set(categoryCodes);
  const create = [], update = [], badCategory = [];
  let unchanged = 0;
  for (const v of items) {
    if (!cats.has(v.categoryCode)) { badCategory.push(v); continue; }
    const cur = byCode.get(v.code);
    if (!cur) { create.push(v); continue; }
    const before = plain(cur);
    const changes = COMPARE.filter((f) => before[f] !== v[f]);
    if (changes.length) update.push({ id: cur.id, before, after: v, changes });
    else unchanged++;
  }
  return { create, update, unchanged, badCategory };
}

/** Önizlenen ürünleri kaydeder (plan kayıt anında yeniden hesaplanır). Dosyadaki sıra, kategori içindeki sıra olur. */
export async function applyProductImport(db, items, actor) {
  return db.$transaction(async (tx) => {
    await lock(tx);
    const existing = await tx.profileProduct.findMany({ include: { category: true } });
    const categories = await tx.profileCategory.findMany();
    const catId = new Map(categories.map((c) => [c.code, c.id]));
    const plan = planProductImport(existing, [...catId.keys()], items);
    const byCode = new Map(existing.map((p) => [p.code, p]));
    const order = new Map();
    for (const v of items) {
      const cid = catId.get(v.categoryCode);
      if (!cid) continue;
      const n = (order.get(cid) ?? 0) + 10;
      order.set(cid, n);
      const data = {
        categoryId: cid, nameRo: v.nameRo, nameTr: v.nameTr, unitCode: v.unitCode,
        listPrice: v.listPrice == null ? null : v.listPrice.toFixed(2), isActive: v.isActive, sortOrder: n,
      };
      const cur = byCode.get(v.code);
      if (cur) await tx.profileProduct.update({ where: { id: cur.id }, data });
      else await tx.profileProduct.create({ data: { ...data, code: v.code } });
    }
    const summary = { created: plan.create.length, updated: plan.update.length, unchanged: plan.unchanged, skipped: plan.badCategory.length };
    await writeAudit(tx, {
      action: 'PROFILE_CATALOG_IMPORT', entityType: 'ProfileProduct', entityId: 'catalog', userId: actor.id,
      details: {
        ...summary,
        createdCodes: plan.create.slice(0, 300).map((v) => v.code),
        changed: plan.update.slice(0, 300).map((u) => ({ code: u.after.code, fields: u.changes, before: pick(u.before, u.changes), after: pick(u.after, u.changes) })),
      },
    }, actor);
    return summary;
  });
}

/** Katalog Excel'inin satırları (aynı düzende geri yüklenebilir). */
export function productSheetRows(products) {
  return [
    ['PROFİL KATALOĞU'],
    ['Ürün', String(products.length)],
    [],
    PRODUCT_HEADERS,
    ...products.map((p) => {
      const v = plain(p);
      return [v.categoryCode, v.code, v.nameRo, v.nameTr, v.unitCode, v.listPrice ?? '', v.isActive ? 'Evet' : 'Hayır'];
    }),
  ];
}
