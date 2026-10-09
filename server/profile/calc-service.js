// Profil hesaplayıcısının veritabanı tarafı (Paket 5, karar 175–176): yöneticinin ayarları (cam kalınlıkları, sistemler,
// kalem satırları) ve müşterinin hesabı. Kural server/profile/calculator.js'te (saf, birim testli); burada yükleme,
// yetki (sayfa ve işlemden AYRI olarak burada da), kilit ve denetim kaydı.
//
// Ayarlar yalnızca yönetici (CATALOG_MANAGE): her değişiklik tek işlemde, 'profile-calc' danışma kilidi altında (aynı
// kalemde çakışan iki satır aynı anda eklenemez) ve denetim kaydıyla. Sipariş bu kayıtlara bağlanmaz: hesap sonucu
// müşterinin formundaki adetlere aktarılır; ayar sonradan değişse de verilmiş sipariş değişmez.
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { cleanCode } from './catalog.js';
import { PROFILE_COLORS, SYSTEM_KINDS, calculate, calculateRailing, cleanSlot, overlaps, parsePerMeter, parseThickness, slotKey, systemProblems } from './calculator.js';
import { railingDefaultsStatus } from './calc-defaults.js';
import { stockLevels } from './stock.js';

const lock = (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('profile-calc', 0))`;
const allowed = (actor) => can(actor?.role, 'CATALOG_MANAGE');
const FORBIDDEN = /** @type {const} */ ({ ok: false, code: 'FORBIDDEN' });
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Sistemin satırları, ürünleri (kategorinin etkinliğiyle) ve kalınlıklarıyla */
export const CALC_INCLUDE = {
  items: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { product: { include: { category: { select: { isActive: true } } } }, thickness: true },
  },
};

// ---------- cam kalınlıkları ----------

/** Cam kalınlığının müşteriye görünen adı (ör. "6+6"): en çok 20 karakter; boş = null ("12,76 mm" gösterilir) */
export const cleanThicknessLabel = (v) => clean(v, 21) || null;

/**
 * @param {any} db
 * @param {{ mm: unknown, label?: unknown }} v  label: müşteriye görünen ad (karar 203; isteğe bağlı)
 * @param {any} actor
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: 'FORBIDDEN' | 'BAD_MM' | 'EXISTS' | 'LABEL' }>}
 */
export async function addThickness(db, v, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const { mm, label = null } = v ?? {};
  const parsed = parseThickness(mm);
  if (!parsed.ok) return { ok: false, code: 'BAD_MM' };
  const name = cleanThicknessLabel(label);
  if (name && name.length > 20) return { ok: false, code: 'LABEL' };
  return db.$transaction(async (tx) => {
    await lock(tx);
    if (await tx.profileGlassThickness.findUnique({ where: { mm: parsed.value } })) return { ok: false, code: 'EXISTS' };
    const t = await tx.profileGlassThickness.create({ data: { mm: parsed.value, label: name } });
    await writeAudit(tx, { action: 'PROFILE_CALC_THICKNESS', entityType: 'ProfileGlassThickness', entityId: t.id, userId: actor.id, details: { mm: parsed.value, label: name, created: true } }, actor);
    return { ok: true, id: t.id };
  });
}

/** Kalınlık silinmez; pasif yapılır (müşteri seçemez, eksikler listesi saymaz). */
export async function setThicknessActive(db, { id, active }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lock(tx);
    const t = await tx.profileGlassThickness.findUnique({ where: { id: String(id ?? '') } });
    if (!t) return { ok: false, code: 'NOT_FOUND' };
    if (t.isActive === !!active) return { ok: true, id: t.id };
    await tx.profileGlassThickness.update({ where: { id: t.id }, data: { isActive: !!active } });
    await writeAudit(tx, { action: 'PROFILE_CALC_THICKNESS', entityType: 'ProfileGlassThickness', entityId: t.id, userId: actor.id, details: { mm: t.mm.toString(), isActive: !!active } }, actor);
    return { ok: true, id: t.id };
  });
}

// ---------- sistemler ----------

/**
 * Sistem ekler ya da düzenler (kod kalıcıdır; sistem silinmez, pasif yapılır).
 * kind (karar 203): müşteri hesaplayıcısındaki yeri — PROFILE (korkuluk profili) / HANDRAIL (küpeşte) / boş (görünmez).
 * Düzenlemede kind verilmezse (undefined) değişmez.
 * @param {{ id?: string | null, code?: unknown, nameRo?: unknown, nameTr?: unknown, isActive?: boolean, kind?: unknown }} v
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: 'FORBIDDEN' | 'CODE' | 'NAME' | 'EXISTS' | 'NOT_FOUND' | 'KIND' }>}
 */
export async function saveSystem(db, v, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const nameRo = clean(v.nameRo, 81);
  const nameTr = clean(v.nameTr, 81) || nameRo;
  if (!nameRo || nameRo.length > 80 || nameTr.length > 80) return { ok: false, code: 'NAME' };
  const isActive = v.isActive !== false;
  const kindGiven = v.kind !== undefined;
  const kind = v.kind ? String(v.kind) : null;
  if (kind && !SYSTEM_KINDS.includes(kind)) return { ok: false, code: 'KIND' };
  return db.$transaction(async (tx) => {
    await lock(tx);
    if (v.id) {
      const cur = await tx.profileSystem.findUnique({ where: { id: v.id } });
      if (!cur) return { ok: false, code: 'NOT_FOUND' };
      const nextKind = kindGiven ? kind : cur.kind;
      await tx.profileSystem.update({ where: { id: cur.id }, data: { nameRo, nameTr, isActive, kind: /** @type {any} */ (nextKind) } });
      await writeAudit(tx, {
        action: 'PROFILE_CALC_SYSTEM', entityType: 'ProfileSystem', entityId: cur.id, userId: actor.id,
        details: { code: cur.code, before: { nameRo: cur.nameRo, nameTr: cur.nameTr, isActive: cur.isActive, kind: cur.kind }, after: { nameRo, nameTr, isActive, kind: nextKind } },
      }, actor);
      return { ok: true, id: cur.id };
    }
    const code = cleanCode(v.code);
    if (!code) return { ok: false, code: 'CODE' };
    if (await tx.profileSystem.findUnique({ where: { code } })) return { ok: false, code: 'EXISTS' };
    const last = await tx.profileSystem.aggregate({ _max: { sortOrder: true } });
    const s = await tx.profileSystem.create({ data: { code, nameRo, nameTr, isActive, kind: /** @type {any} */ (kind), sortOrder: (last._max.sortOrder ?? 0) + 10 } });
    await writeAudit(tx, { action: 'PROFILE_CALC_SYSTEM', entityType: 'ProfileSystem', entityId: s.id, userId: actor.id, details: { code, created: true, after: { nameRo, nameTr, isActive, kind } } }, actor);
    return { ok: true, id: s.id };
  });
}

// ---------- kalem satırları ----------

/**
 * Sisteme satır ekler. Aynı kalemde koşulları çakışan iki satır olamaz (OVERLAP): her seçimde bir kalemin en çok bir
 * satırı geçerlidir. productId boş = "bu koşulda gerekmez" (tüketim yok sayılır).
 * @param {{ systemId: string, slot: unknown, productId?: string | null, color?: string | null, thicknessId?: string | null, perMeter?: unknown }} v
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: 'FORBIDDEN' | 'SLOT' | 'COLOR' | 'PER_METER' | 'NOT_FOUND' | 'PRODUCT' | 'THICKNESS' | 'OVERLAP' }>}
 */
export async function addCalcItem(db, v, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const slot = cleanSlot(v.slot);
  if (!slot) return { ok: false, code: 'SLOT' };
  const color = v.color ? String(v.color) : null;
  if (color && !PROFILE_COLORS.includes(color)) return { ok: false, code: 'COLOR' };
  const productId = v.productId ? String(v.productId) : null;
  const per = productId ? parsePerMeter(v.perMeter) : { ok: true, value: null };
  if (!per.ok) return { ok: false, code: 'PER_METER' };
  const thicknessId = v.thicknessId ? String(v.thicknessId) : null;
  return db.$transaction(async (tx) => {
    await lock(tx);
    const system = await tx.profileSystem.findUnique({ where: { id: String(v.systemId ?? '') }, include: { items: true } });
    if (!system) return { ok: false, code: 'NOT_FOUND' };
    const product = productId ? await tx.profileProduct.findUnique({ where: { id: productId }, select: { id: true, code: true } }) : null;
    if (productId && !product) return { ok: false, code: 'PRODUCT' };
    const thickness = thicknessId ? await tx.profileGlassThickness.findUnique({ where: { id: thicknessId } }) : null;
    if (thicknessId && (!thickness || !thickness.isActive)) return { ok: false, code: 'THICKNESS' };
    const same = system.items.filter((i) => slotKey(i.slot) === slotKey(slot));
    if (same.some((i) => overlaps(i, { color, thicknessId }))) return { ok: false, code: 'OVERLAP' };
    const label = same[0]?.slot ?? slot; // kalemin adı ilk satırındaki yazımıyla kalır
    const sortOrder = Math.max(0, ...system.items.map((i) => i.sortOrder)) + 10;
    const item = await tx.profileCalcItem.create({ data: { systemId: system.id, slot: label, productId, color, thicknessId, perMeter: per.value, sortOrder } });
    await writeAudit(tx, {
      action: 'PROFILE_CALC_ITEM', entityType: 'ProfileSystem', entityId: system.id, userId: actor.id,
      details: { system: system.code, op: 'create', itemId: item.id, slot: label, product: product?.code ?? null, color, thicknessMm: thickness?.mm.toString() ?? null, perMeter: per.value },
    }, actor);
    return { ok: true, id: item.id };
  });
}

/**
 * Satırın tüketim katsayısını değiştirir (koşul ve ürün değişmez: yanlış satır silinip yenisi eklenir).
 * @returns {Promise<{ ok: true } | { ok: false, code: 'FORBIDDEN' | 'PER_METER' | 'NOT_FOUND' | 'NO_PRODUCT' }>}
 */
export async function updateCalcItem(db, { id, perMeter }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const per = parsePerMeter(perMeter);
  if (!per.ok) return { ok: false, code: 'PER_METER' };
  return db.$transaction(async (tx) => {
    await lock(tx);
    const item = await tx.profileCalcItem.findUnique({ where: { id: String(id ?? '') }, include: { system: true, product: { select: { code: true } } } });
    if (!item) return { ok: false, code: 'NOT_FOUND' };
    if (!item.productId) return { ok: false, code: 'NO_PRODUCT' };
    const before = item.perMeter == null ? null : item.perMeter.toString();
    if (before === per.value || (before != null && per.value != null && Number(before) === Number(per.value))) return { ok: true };
    await tx.profileCalcItem.update({ where: { id: item.id }, data: { perMeter: per.value } });
    await writeAudit(tx, {
      action: 'PROFILE_CALC_ITEM', entityType: 'ProfileSystem', entityId: item.systemId, userId: actor.id,
      details: { system: item.system.code, op: 'update', itemId: item.id, slot: item.slot, product: item.product?.code ?? null, before: { perMeter: before }, after: { perMeter: per.value } },
    }, actor);
    return { ok: true };
  });
}

/** @returns {Promise<{ ok: true } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' }>} */
export async function removeCalcItem(db, { id }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lock(tx);
    const item = await tx.profileCalcItem.findUnique({ where: { id: String(id ?? '') }, include: { system: true, product: { select: { code: true } }, thickness: true } });
    if (!item) return { ok: false, code: 'NOT_FOUND' };
    await tx.profileCalcItem.delete({ where: { id: item.id } });
    await writeAudit(tx, {
      action: 'PROFILE_CALC_ITEM', entityType: 'ProfileSystem', entityId: item.systemId, userId: actor.id,
      details: {
        system: item.system.code, op: 'delete', itemId: item.id, slot: item.slot, product: item.product?.code ?? null, color: item.color,
        thicknessMm: item.thickness?.mm.toString() ?? null, perMeter: item.perMeter == null ? null : item.perMeter.toString(),
      },
    }, actor);
    return { ok: true };
  });
}

// ---------- okuma ----------

/**
 * @typedef {{ toString(): string }} DecimalLike
 * @typedef {{ id: string, code: string, nameTr: string, nameRo: string, unitCode: string, isActive: boolean,
 *   packContent: DecimalLike | null, packMeasure: string | null, category: { isActive: boolean } }} AdminCalcProduct
 * @typedef {{ id: string, mm: DecimalLike, label: string | null, isActive: boolean }} AdminCalcThickness
 * @typedef {{ id: string, systemId: string, slot: string, sortOrder: number, productId: string | null, product: AdminCalcProduct | null,
 *   color: string | null, thicknessId: string | null, thickness: AdminCalcThickness | null, perMeter: DecimalLike | null }} AdminCalcItem
 * @typedef {{ id: string, code: string, nameTr: string, nameRo: string, isActive: boolean, sortOrder: number, kind: string | null, items: AdminCalcItem[],
 *   problems: import('./calculator.js').CalcError[] }} AdminCalcSystem
 */

/**
 * Yöneticinin ayar ekranı: sistemler (satırlarıyla), kalınlıklar ve her sistemin eksikleri
 * @param {import('@prisma/client').PrismaClient} db
 * @returns {Promise<{ systems: AdminCalcSystem[], thicknesses: AdminCalcThickness[],
 *   defaults: { applied: boolean, missing: string[], wrongUnit: { code: string, unit: string, expected: string }[] } }>}
 */
export async function loadCalcAdmin(db) {
  const [systems, thicknesses, defaults] = await Promise.all([
    db.profileSystem.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], include: CALC_INCLUDE }),
    db.profileGlassThickness.findMany({ orderBy: { mm: 'asc' } }),
    railingDefaultsStatus(db),
  ]);
  return { systems: systems.map((s) => ({ ...s, problems: systemProblems(s, thicknesses) })), thicknesses, defaults };
}

/**
 * Müşterinin hesaplayıcısındaki seçenekler (karar 203): korkuluk profilleri (tür PROFILE) ve küpeşteler (tür HANDRAIL) —
 * etkin ve satırı olan sistemler —, etkin cam kalınlıkları (müşteriye görünen adıyla). Korkuluk profili yoksa hesaplayıcı
 * gösterilmez. Türü seçilmemiş sistem müşteride görünmez.
 * @param {import('@prisma/client').PrismaClient} db
 * @returns {Promise<{ profiles: { id: string, code: string, nameTr: string, nameRo: string }[],
 *   handrails: { id: string, code: string, nameTr: string, nameRo: string }[], thicknesses: { id: string, mm: string, label: string | null }[] }>}
 */
export async function loadCalcOptions(db) {
  const [systems, thicknesses] = await Promise.all([
    db.profileSystem.findMany({ where: { isActive: true, kind: { not: null }, items: { some: {} } }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
    db.profileGlassThickness.findMany({ where: { isActive: true }, orderBy: { mm: 'asc' } }),
  ]);
  const view = (s) => ({ id: s.id, code: s.code, nameTr: s.nameTr, nameRo: s.nameRo });
  return {
    profiles: systems.filter((s) => s.kind === 'PROFILE').map(view),
    handrails: systems.filter((s) => s.kind === 'HANDRAIL').map(view),
    thicknesses: thicknesses.map((t) => ({ id: t.id, mm: t.mm.toString(), label: t.label ?? null })),
  };
}

/**
 * Müşterinin korkuluk hesabı (karar 203): profil (zorunlu) + küpeşte (boş = yok) + renk + cam + metre → `calculateRailing`.
 * Başarılıysa yalnızca stoğu yetmeyen ürünler için gereken / mevcut / eksik (runCalc ile aynı kural). Yalnızca okur: kayıt,
 * stok hareketi, bildirim yazmaz.
 * @param {{ profileId: unknown, handrailId?: unknown, color?: unknown, thicknessId?: unknown, meters: unknown }} input
 */
export async function runRailingCalc(db, input) {
  const handrailId = String(input.handrailId ?? '');
  const [profile, handrail, thicknesses] = await Promise.all([
    db.profileSystem.findFirst({ where: { id: String(input.profileId ?? ''), isActive: true }, include: CALC_INCLUDE }),
    handrailId ? db.profileSystem.findFirst({ where: { id: handrailId, isActive: true }, include: CALC_INCLUDE }) : null,
    db.profileGlassThickness.findMany(),
  ]);
  const systems = [profile, handrail].filter(Boolean).map((s) => ({ code: s.code, nameTr: s.nameTr, nameRo: s.nameRo }));
  const res = calculateRailing({ profile, handrail, handrailWanted: !!handrailId }, input, thicknesses);
  if (!res.ok) return { ...res, systems };
  const levels = await stockLevels(db, res.lines.map((l) => l.productId));
  return {
    ...res,
    systems,
    lines: res.lines.map((l) => {
      const available = Math.max(0, levels.get(l.productId) ?? 0);
      return { ...l, stock: available < l.qty ? { available, missing: l.qty - available } : null };
    }),
  };
}

/**
 * Müşterinin hesabı (karar 175–177): kural `calculate`; başarılıysa sonuçtaki ürünlerin stoğu — YALNIZCA stoğu yetmeyen
 * ürün için gereken / mevcut / eksik döner (müşterinin kendi siparişindeki eksik ürünler; genel stok listesi değil). Müşteriye
 * giden "mevcut" eksiye düşmez (0).
 * @param {{ systemId: unknown, color?: unknown, thicknessId?: unknown, meters: unknown }} input
 */
export async function runCalc(db, input) {
  const [system, thicknesses] = await Promise.all([
    db.profileSystem.findFirst({ where: { id: String(input.systemId ?? ''), isActive: true }, include: CALC_INCLUDE }),
    db.profileGlassThickness.findMany(),
  ]);
  const res = calculate(system, input, thicknesses);
  if (!res.ok) return { ...res, system: system ? { code: system.code, nameTr: system.nameTr, nameRo: system.nameRo } : null };
  const levels = await stockLevels(db, res.lines.map((l) => l.productId));
  return {
    ...res,
    system: { code: system?.code ?? '', nameTr: system?.nameTr ?? '', nameRo: system?.nameRo ?? '' },
    lines: res.lines.map((l) => {
      const available = Math.max(0, levels.get(l.productId) ?? 0);
      return { ...l, stock: available < l.qty ? { available, missing: l.qty - available } : null };
    }),
  };
}
