import { writeAudit } from '../orders/journal.js';

// Cam kataloğu (yönetici yönetir; müşteri yeni siparişte seçer).
// Her cam: ad + renk, Türkçe / Romence / (isteğe bağlı) İngilizce; ağırlık kg/m² (yüklemelerde kullanılır).
// Aynı cam Türkçe ad + Türkçe renkten tanınır (Excel'le yüklerken de). Pasif cam hiçbir seçim listesinde görünmez.
// Kullanıcı hangi dili seçtiyse camı o dilde görür (karar 20).
// Excel düzeni ürün sahibinin dosyasıyla aynıdır: başlık satırı "Cam adı (TR) | Renk (TR) | Cam adı (RO) | Renk (RO) |
// Cam adı (EN) | Renk (EN) | Ağırlık (kg/m²) | Aktif"; üstünde başlık/özet satırları olabilir.

export const CATALOG_HEADERS = ['Cam adı (TR)', 'Renk (TR)', 'Cam adı (RO)', 'Renk (RO)', 'Cam adı (EN)', 'Renk (EN)', 'Ağırlık (kg/m²)', 'Aktif'];
const FIELDS = ['nameTr', 'colorTr', 'nameRo', 'colorRo', 'nameEn', 'colorEn', 'weightKgM2', 'isActive'];
export const MAX_IMPORT_ROWS = 2000;
export const MAX_WEIGHT = 500;

/** Boşlukları sadeleştirir */
export const clean = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
/** Aynı camı tanımak için anahtar: Türkçe ad + renk, büyük/küçük harf ve boşluk farkı yok sayılır */
export const glassKey = (nameTr, colorTr) => `${clean(nameTr).toLocaleUpperCase('tr-TR')}|${clean(colorTr).toLocaleUpperCase('tr-TR')}`;

/**
 * Camın kullanıcının dilindeki adı: "10 MM TEMPER CAM — BRONZ"
 * @param {{ nameTr: string, colorTr?: string | null, nameRo: string, colorRo?: string | null }} g
 * @param {'tr' | 'ro'} locale
 */
export function glassLabel(g, locale) {
  const name = locale === 'tr' ? g.nameTr : g.nameRo || g.nameTr;
  const color = locale === 'tr' ? g.colorTr : g.colorRo || g.colorTr;
  return color ? `${name} — ${color}` : name;
}

/** "25", 25, "25,5" → sayı; boş → null; geçersiz → NaN */
export function parseNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = clean(v).replace(/\s/g, '').replace(',', '.');
  if (s === '') return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

const YES = new Set(['EVET', 'E', 'DA', 'YES', 'Y', '1', 'TRUE', 'AKTİF', 'AKTIF', 'ACTIV']);
const NO = new Set(['HAYIR', 'H', 'NU', 'NO', 'N', '0', 'FALSE', 'PASİF', 'PASIF', 'INACTIV']);
/** "Evet" / "Hayır" (Da/Nu, 1/0 da olur); boş → etkin */
export function parseActive(v) {
  if (v == null || v === '') return true;
  if (typeof v === 'boolean') return v;
  const s = clean(v).toLocaleUpperCase('tr-TR');
  if (YES.has(s)) return true;
  if (NO.has(s)) return false;
  return null;
}

/**
 * Bir cam kaydını doğrular (form ve Excel aynı kuralı kullanır).
 * @returns {{ ok: true, value: GlassInput } | { ok: false, errors: string[] }}
 *   hata kodları: NAME_TR, NAME_RO, TOO_LONG, WEIGHT, ACTIVE
 * @typedef {{ nameTr: string, colorTr: string, nameRo: string, colorRo: string, nameEn: string | null, colorEn: string | null, weightKgM2: number, isActive: boolean }} GlassInput
 */
export function validateGlass(raw) {
  const errors = [];
  const v = {
    nameTr: clean(raw.nameTr), colorTr: clean(raw.colorTr), nameRo: clean(raw.nameRo), colorRo: clean(raw.colorRo),
    nameEn: clean(raw.nameEn) || null, colorEn: clean(raw.colorEn) || null,
    weightKgM2: parseNumber(raw.weightKgM2), isActive: parseActive(raw.isActive),
  };
  if (!v.nameTr) errors.push('NAME_TR');
  if (!v.nameRo) errors.push('NAME_RO');
  if ([v.nameTr, v.nameRo, v.nameEn ?? ''].some((s) => s.length > 120) || [v.colorTr, v.colorRo, v.colorEn ?? ''].some((s) => s.length > 80)) errors.push('TOO_LONG');
  if (v.weightKgM2 == null || !Number.isFinite(v.weightKgM2) || v.weightKgM2 <= 0 || v.weightKgM2 > MAX_WEIGHT) errors.push('WEIGHT');
  else v.weightKgM2 = Math.round(v.weightKgM2 * 100) / 100;
  if (v.isActive == null) errors.push('ACTIVE');
  return errors.length ? { ok: false, errors } : { ok: true, value: /** @type {GlassInput} */ (v) };
}

const headerKey = (s) => clean(s).toLocaleUpperCase('tr-TR').replace(/\s/g, '');
const HEADER_KEYS = CATALOG_HEADERS.map(headerKey);

/**
 * Excel satırlarından camları okur.
 * @param {(string | number | boolean | null)[][]} rows  readXlsx().rows
 * @returns {{ ok: false, error: 'HEADERS' | 'TOO_MANY' | 'EMPTY' } | { ok: true, items: { row: number, value: GlassInput }[], errors: { row: number, codes: string[], label: string }[] }}
 *   row: Excel'deki satır numarası (1 tabanlı)
 */
export function parseCatalogSheet(rows) {
  const h = rows.findIndex((r) => (r ?? []).some((c) => headerKey(c) === HEADER_KEYS[0]));
  if (h < 0) return { ok: false, error: 'HEADERS' };
  const col = FIELDS.map((_, i) => rows[h].findIndex((c) => headerKey(c) === HEADER_KEYS[i]));
  // Ağırlık başlığı "Ağırlık" / "Ağırlık (kg/m2)" gibi yazılmış olabilir
  if (col[6] < 0) col[6] = rows[h].findIndex((c) => headerKey(c).startsWith('AĞIRLIK'));
  if ([0, 2, 6].some((i) => col[i] < 0)) return { ok: false, error: 'HEADERS' };
  const data = rows.slice(h + 1).map((r, i) => ({ r: r ?? [], row: h + 2 + i })).filter(({ r }) => r.some((c) => clean(c) !== ''));
  if (data.length === 0) return { ok: false, error: 'EMPTY' };
  if (data.length > MAX_IMPORT_ROWS) return { ok: false, error: 'TOO_MANY' };

  const items = [];
  const errors = [];
  const seen = new Map();
  for (const { r, row } of data) {
    const raw = Object.fromEntries(FIELDS.map((f, i) => [f, col[i] >= 0 ? r[col[i]] : null]));
    const res = validateGlass(raw);
    const label = [clean(raw.nameTr), clean(raw.colorTr)].filter(Boolean).join(' — ');
    if (!res.ok) { errors.push({ row, codes: res.errors, label }); continue; }
    const key = glassKey(res.value.nameTr, res.value.colorTr);
    if (seen.has(key)) { errors.push({ row, codes: ['DUPLICATE'], label }); continue; }
    seen.set(key, row);
    items.push({ row, value: res.value });
  }
  return { ok: true, items, errors };
}

const COMPARE = ['nameTr', 'colorTr', 'nameRo', 'colorRo', 'nameEn', 'colorEn', 'weightKgM2', 'isActive'];
const same = (a, b) => (a ?? null) === (b ?? null);
/** Veritabanı kaydını karşılaştırılabilir düz değere çevirir (Decimal → sayı) */
export const plainGlass = (g) => ({
  nameTr: g.nameTr, colorTr: g.colorTr ?? '', nameRo: g.nameRo, colorRo: g.colorRo ?? '', nameEn: g.nameEn ?? null, colorEn: g.colorEn ?? null,
  weightKgM2: g.weightKgM2 == null ? null : Number(g.weightKgM2), isActive: !!g.isActive,
});

/**
 * Yüklenecek camları mevcut katalogla karşılaştırır. Dosyada olmayan camlara dokunulmaz.
 * @param {{ id: string }[]} existing  veritabanındaki camlar
 * @param {GlassInput[]} items
 */
export function planCatalogImport(existing, items) {
  const byKey = new Map(existing.map((g) => [glassKey(g.nameTr, g.colorTr), g]));
  const create = [];
  const update = [];
  let unchanged = 0;
  const inFile = new Set();
  for (const value of items) {
    const key = glassKey(value.nameTr, value.colorTr);
    inFile.add(key);
    const cur = byKey.get(key);
    if (!cur) { create.push(value); continue; }
    const before = plainGlass(cur);
    const changes = COMPARE.filter((f) => !same(before[f], value[f]));
    if (changes.length) update.push({ id: cur.id, before, after: value, changes });
    else unchanged++;
  }
  const untouched = existing.filter((g) => !inFile.has(glassKey(g.nameTr, g.colorTr)));
  return { create, update, unchanged, untouched };
}

/**
 * Excel'den gelen camları kaydeder (tek işlem). Plan kayıt anında yeniden hesaplanır.
 * Sıralama dosyadaki sırayı izler; dosyada olmayan camlar kendi aralarındaki sırayla sona geçer.
 * @param {import('@prisma/client').PrismaClient} db
 * @param {GlassInput[]} items
 * @param {{ id: string, role: string, ip?: string | null }} actor
 */
export async function applyCatalogImport(db, items, actor) {
  return db.$transaction(async (tx) => {
    // Aynı anda iki yükleme olmasın
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('glass-catalog', 0))`;
    const existing = await tx.glassProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }, { colorTr: 'asc' }] });
    const plan = planCatalogImport(existing, items);
    const byKey = new Map(existing.map((g) => [glassKey(g.nameTr, g.colorTr), g]));
    let order = 0;
    for (const value of items) {
      order += 10;
      const cur = byKey.get(glassKey(value.nameTr, value.colorTr));
      if (cur) await tx.glassProduct.update({ where: { id: cur.id }, data: { ...value, sortOrder: order } });
      else await tx.glassProduct.create({ data: { ...value, sortOrder: order } });
    }
    for (const g of plan.untouched) {
      order += 10;
      if (g.sortOrder !== order) await tx.glassProduct.update({ where: { id: g.id }, data: { sortOrder: order } });
    }
    const summary = { created: plan.create.length, updated: plan.update.length, unchanged: plan.unchanged, untouched: plan.untouched.length };
    await writeAudit(tx, {
      action: 'GLASS_IMPORT', entityType: 'GlassProduct', entityId: 'catalog', userId: actor.id,
      details: {
        ...summary,
        created: plan.create.slice(0, 300).map((v) => glassLabel(v, 'tr')),
        changed: plan.update.slice(0, 300).map((u) => ({ glass: glassLabel(u.before, 'tr'), fields: u.changes, before: pick(u.before, u.changes), after: pick(u.after, u.changes) })),
        counts: summary,
      },
    }, actor);
    return summary;
  });
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));

/**
 * Katalog Excel'inin satırları (yüklenebilir düzen).
 * @param {object[]} glasses  sıralı
 */
export function catalogSheetRows(glasses) {
  return [
    ['CAM KATALOĞU'],
    ['Kalem', String(glasses.length)],
    [],
    CATALOG_HEADERS,
    ...glasses.map((g) => {
      const p = plainGlass(g);
      return [p.nameTr, p.colorTr, p.nameRo, p.colorRo, p.nameEn ?? '', p.colorEn ?? '', p.weightKgM2 ?? '', p.isActive ? 'Evet' : 'Hayır'];
    }),
  ];
}

/** Müşterinin yeni cam siparişinde seçebileceği cam tipi sayısı (karar 85): tam olarak bir. */
export const CUSTOMER_GLASS_TYPES = 1;

/**
 * Müşterinin YENİ cam siparişindeki cam satırını katalogdan doğrular ve siparişe yazılacak anlık kopyayı üretir
 * (cam sonradan yeniden adlandırılsa ya da ağırlığı değişse de sipariş değişmez). Yeni siparişte tam olarak bir cam
 * tipi olur: hiç seçilmediyse NO_GLASS, birden çoksa ONE_GLASS. Eski (çok camlı) siparişler ve satış / yönetici
 * teklif tablosu bu kuraldan etkilenmez — onlar bu işlevi kullanmaz.
 * Adet (karar 160): müşteri formunda cam adedi YOK — adet verilmezse (boş / null) satıra 0 = "belirtilmedi" yazılır;
 * adetleri, ölçüleri ve fiyatı satış ekibi teklif tablosunda girer (ilk teklif satırı adet 1 ile açılır — prefillLines).
 * Adet verilirse (eski taslak / eski çağıran) eskisi gibi 1…MAX_GLASS_QTY tam sayı olmalıdır.
 * @param {{ id: string, qty?: string | number | null }[]} lines
 * @param {object[]} products  seçilen id'lere ait katalog kayıtları
 * @returns {{ ok: true, items: object[] } | { ok: false, code: 'NO_GLASS' | 'ONE_GLASS' | 'GLASS_GONE' | 'BAD_QTY' }}
 */
export function glassOrderItems(lines, products) {
  const used = lines.filter((l) => clean(l.id) !== '');
  if (used.length === 0) return { ok: false, code: 'NO_GLASS' };
  if (used.length > CUSTOMER_GLASS_TYPES) return { ok: false, code: 'ONE_GLASS' };
  const byId = new Map(products.map((p) => [p.id, p]));
  const items = [];
  for (const l of used) {
    const p = byId.get(l.id);
    if (!p || !p.isActive) return { ok: false, code: 'GLASS_GONE' };
    const given = typeof l.qty === 'number' || clean(l.qty ?? '') !== '';
    const qty = !given ? 0 : typeof l.qty === 'number' ? l.qty : Number(clean(l.qty));
    if (given && (!Number.isInteger(qty) || qty < 1 || qty > MAX_GLASS_QTY)) return { ok: false, code: 'BAD_QTY' };
    items.push({
      glassProductId: p.id, glassName: glassLabel(p, 'tr'), glassNameRo: glassLabel(p, 'ro'),
      glassWeightKgM2: p.weightKgM2 == null ? null : Number(p.weightKgM2), camAdedi: qty,
    });
  }
  return { ok: true, items };
}
export const MAX_GLASS_QTY = 9999;

/** Sipariş satırındaki camın kullanıcının dilindeki adı (anlık kopyadan) */
export const itemGlassName = (it, locale) => (locale === 'ro' ? it.glassNameRo || it.glassName : it.glassName) || null;

/**
 * Tek camı ekler ya da düzenler (yönetici sayfası). Denetim kaydına önce/sonra yazılır.
 * @param {import('@prisma/client').PrismaClient} db
 * @param {string | null} id  null → yeni cam (listenin sonuna)
 * @param {GlassInput} value  validateGlass() sonucu
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: 'EXISTS' | 'NOT_FOUND' }>}
 */
export async function saveGlass(db, id, value, actor) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('glass-catalog', 0))`;
    const all = await tx.glassProduct.findMany();
    const key = glassKey(value.nameTr, value.colorTr);
    if (all.some((g) => g.id !== id && glassKey(g.nameTr, g.colorTr) === key)) return { ok: false, code: 'EXISTS' };
    if (id) {
      const cur = all.find((g) => g.id === id);
      if (!cur) return { ok: false, code: 'NOT_FOUND' };
      const before = plainGlass(cur);
      const changes = COMPARE.filter((f) => !same(before[f], value[f]));
      await tx.glassProduct.update({ where: { id }, data: value });
      await writeAudit(tx, {
        action: 'GLASS_UPDATE', entityType: 'GlassProduct', entityId: id, userId: actor.id,
        details: { glass: glassLabel(value, 'tr'), fields: changes, before: pick(before, changes), after: pick(value, changes) },
      }, actor);
      return { ok: true, id };
    }
    const max = all.reduce((m, g) => Math.max(m, g.sortOrder), 0);
    const g = await tx.glassProduct.create({ data: { ...value, sortOrder: max + 10 } });
    await writeAudit(tx, { action: 'GLASS_CREATE', entityType: 'GlassProduct', entityId: g.id, userId: actor.id, details: { after: value } }, actor);
    return { ok: true, id: g.id };
  });
}

/**
 * Etkinleştir / pasifleştir ya da sırada bir yukarı / aşağı taşı.
 * @param {'toggle' | 'up' | 'down'} intent
 * @returns {Promise<boolean>} kayıt bulunduysa true
 */
export async function changeGlass(db, id, intent, actor) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('glass-catalog', 0))`;
    const all = await tx.glassProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }, { colorTr: 'asc' }] });
    const i = all.findIndex((g) => g.id === id);
    if (i < 0) return false;
    const g = all[i];
    if (intent === 'toggle') {
      await tx.glassProduct.update({ where: { id }, data: { isActive: !g.isActive } });
      await writeAudit(tx, {
        action: 'GLASS_UPDATE', entityType: 'GlassProduct', entityId: id, userId: actor.id,
        details: { glass: glassLabel(g, 'tr'), fields: ['isActive'], before: { isActive: g.isActive }, after: { isActive: !g.isActive } },
      }, actor);
      return true;
    }
    const j = intent === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= all.length) return true;
    [all[i], all[j]] = [all[j], all[i]];
    for (const [k, x] of all.entries()) {
      if (x.sortOrder !== (k + 1) * 10) await tx.glassProduct.update({ where: { id: x.id }, data: { sortOrder: (k + 1) * 10 } });
    }
    return true;
  });
}
