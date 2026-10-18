// Bağımsız yönetici ticari teklifi — veritabanı tarafı (3.83.0, karar 277). Kurallar ve hesap: server/commercial/rules.js (saf).
//
// SINIR: bu modül yalnızca CommercialOffer / CommercialOfferVersion yazar (+ denetim kaydı). Sipariş, sipariş teklifi (Offer),
// fiyat tablosu, stok hareketi, FGO işi, bildirim / e-posta YAZMAZ; teklifin kabul edilmesi sipariş OLUŞTURMAZ (müşteri
// siparişini kendi TAKİP hesabından verir). Katalog (cam, profil ürünü, firma) yalnızca OKUNUR.
//
// Yetki: her dışa açık işlev ilk satırda COMMERCIAL_OFFER_MANAGE ister (yönetici + yönetici yardımcısı) — sayfa / action /
// rota denetiminden AYRI olarak burada da, veritabanına dokunmadan önce (FORBIDDEN).
//
// Sürümler: teklif TASLAK sürümle başlar; "Hazırla / kesinleştir" (issueOffer) sürümü kesinleştirir (issuedAt) — kesin sürüm
// bir daha değişmez (her güncelleme `issuedAt: null` koşullu). Değişiklik yeni sürümle (newRevision) yapılır; eski sürümler,
// PDF'leri ve iç Excel'leri aynen kalır. Eşzamanlı düzenleme: editVersion (iyimser kilit) → CONFLICT.
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { computeOffer, offerNoText, parseOffer, LIMITS, commercialCategoryRank } from './rules.js';
import { glassCostTable } from './glass-cost.js';

const FORBIDDEN = /** @type {const} */ ({ ok: false, code: 'FORBIDDEN' });
const allowed = (actor) => can(actor?.role, 'COMMERCIAL_OFFER_MANAGE');
const lockKey = (tx, key) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
const NO_LOCK = 'commercial-offer-no';
const lockOffer = (tx, id) => lockKey(tx, `commercial-offer:${id}`);
const idOf = (v) => String(v ?? '').trim().slice(0, 64);
const ids = (rows) => [...new Set((Array.isArray(rows) ? rows : []).map((l) => idOf(l?.productId)).filter(Boolean))].slice(0, 500);
const one = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Kesin sürümden yeni sürüm açılabilecek durumlar; kesinleştirilebilir / düzenlenebilir durum yalnızca TASLAK */
const REVISABLE = ['HAZIR', 'RED'];
const CANCELLABLE = ['TASLAK', 'HAZIR'];

export const PROFILE_SELECT = {
  id: true, code: true, nameRo: true, nameTr: true, unitCode: true, isActive: true, packMeasure: true, packContent: true,
  listPrice: true, purchasePrice: true, purchaseCurrency: true, purchaseUnit: true, sortOrder: true,
  category: { select: { code: true, nameRo: true, nameTr: true, sortOrder: true } },
};
/** Prisma Decimal → metin (saf kuralların girdisi) */
const plainProfile = (p) => ({
  ...p,
  packMeasure: p.packMeasure ?? null,
  packContent: p.packContent == null ? null : p.packContent.toString(),
  listPrice: p.listPrice == null ? null : p.listPrice.toString(),
  purchasePrice: p.purchasePrice == null ? null : p.purchasePrice.toString(),
});

/**
 * Doğrulama için katalog: yalnızca formdaki ürünler. Pasif ürün YALNIZCA bu teklifin kayıtlı taslağında zaten varsa kabul edilir
 * (eski satır bozulmasın); yeni satır pasif ürün seçemez.
 */
async function catalogFor(tx, v, keep = { glass: new Set(), profile: new Set() }) {
  const [glass, profile, customer, glassCosts] = await Promise.all([
    tx.glassProduct.findMany({ where: { id: { in: ids(v?.glass) } } }),
    tx.profileProduct.findMany({ where: { id: { in: ids(v?.profile) } }, select: PROFILE_SELECT }),
    idOf(v?.customerId) ? tx.customer.findFirst({ where: { id: idOf(v.customerId), type: 'CUSTOMER' }, select: { id: true, name: true } }) : null,
    glassCostMap(tx, ids(v?.glass)),
  ]);
  return {
    glassCosts,
    glassProducts: new Map(glass.filter((g) => g.isActive || keep.glass.has(g.id)).map((g) => [g.id, g])),
    profileProducts: new Map(profile.filter((p) => p.isActive || keep.profile.has(p.id)).map((p) => [p.id, plainProfile(p)])),
    customers: new Map(customer ? [[customer.id, customer]] : []),
  };
}

const glassCostMap = async (tx, productIds) => (productIds.length ? (await glassCostTable(tx, productIds)).prices : new Map());

/** Yöneticinin listeden farklı girdiği cam maliyetleri (denetim kaydı için; en çok 50) */
const costOverrides = (data) => (data?.glass ?? [])
  .map((l, i) => ({ row: i + 1, productId: l.productId, listCost: l.listCost, cost: l.cost, source: l.costSource }))
  .filter((x) => x.source === 'MANUAL')
  .slice(0, 50);

const keepOf = (data) => ({
  glass: new Set((data?.glass ?? []).map((l) => l.productId)),
  profile: new Set((data?.profile ?? []).map((l) => l.productId)),
});

/** Sürümde saklanan toplamlar (satış, maliyet) — hesap computeOffer'dan (tek kural) */
function sums(data) {
  const t = computeOffer(data).totals;
  return { total: t.total, cost: t.cost, missingCost: t.missingCost };
}

/** Teklif numarası: elle verilen (1 … 999999, tekil) ya da en büyük + 1 — numara kilidi altında */
async function pickNo(tx, wanted, currentId = null) {
  await lockKey(tx, NO_LOCK);
  if (wanted != null && String(wanted).trim() !== '') {
    const s = String(wanted).trim();
    if (!/^\d{1,6}$/.test(s) || Number(s) < 1 || Number(s) > LIMITS.number) return { ok: false, code: 'NUMBER' };
    const n = Number(s);
    const taken = await tx.commercialOffer.findUnique({ where: { no: n }, select: { id: true } });
    if (taken && taken.id !== currentId) return { ok: false, code: 'NUMBER_TAKEN' };
    return { ok: true, no: n };
  }
  const last = await tx.commercialOffer.findFirst({ orderBy: { no: 'desc' }, select: { no: true } });
  const n = (last?.no ?? 0) + 1;
  if (n > LIMITS.number) return { ok: false, code: 'NUMBER' };
  return { ok: true, no: n };
}

/** Sonraki önerilen teklif numarası (yalnızca gösterim; kayıtta kilit altında yeniden belirlenir) */
/** @returns {Promise<{ ok: true, no: number } | { ok: false, code: string }>} */
export async function suggestNo(db, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const last = await db.commercialOffer.findFirst({ orderBy: { no: 'desc' }, select: { no: true } });
  return { ok: true, no: (last?.no ?? 0) + 1 };
}

/**
 * Yeni teklif (TASLAK, sürüm 1). Numara verilmezse otomatik. Hiçbir sipariş / belge / bildirim yazmaz.
 * @param {any} v  teklif verisi (parseOffer girdisi) + no
 * @returns {Promise<{ ok: true, id: string, no: number } | { ok: false, code: string, section?: string, index?: number }>}
 */
export async function createOffer(db, v, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    const parsed = parseOffer(v, await catalogFor(tx, v));
    if (!parsed.ok) return parsed;
    const num = await pickNo(tx, v?.no);
    if (!num.ok) return num;
    const s = sums(parsed.data);
    const offer = await tx.commercialOffer.create({
      data: {
        no: num.no, customerId: parsed.data.customerId, firmName: parsed.data.firmName, total: s.total, createdById: actor.id,
        versions: { create: { version: 1, data: parsed.data, total: s.total, cost: s.cost, createdById: actor.id } },
      },
    });
    await writeAudit(tx, {
      action: 'COMMERCIAL_OFFER_CREATED', entityType: 'CommercialOffer', entityId: offer.id, userId: actor.id,
      details: { no: offerNoText(num.no), version: 1, firm: parsed.data.firmName, glass: parsed.data.glass.length, profile: parsed.data.profile.length, total: s.total, costOverrides: costOverrides(parsed.data) },
    }, actor);
    return { ok: true, id: offer.id, no: num.no };
  });
}

/**
 * Taslağı kaydeder: yalnızca TASLAK durumdaki teklifin KESİNLEŞMEMİŞ güncel sürümü. Ekran açıldıktan sonra başkası
 * değiştirdiyse CONFLICT. Numara yalnızca hiç kesinleşmemiş teklifte değişir.
 * @param {any} v  { offerId, editVersion, no?, ...teklif verisi }
 * @returns {Promise<{ ok: true, editVersion: number } | { ok: false, code: string, section?: string, index?: number }>}
 */
export async function saveDraft(db, v, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lockOffer(tx, idOf(v?.offerId));
    const offer = await tx.commercialOffer.findUnique({ where: { id: idOf(v?.offerId) }, include: { versions: { orderBy: { version: 'desc' } } } });
    if (!offer) return { ok: false, code: 'NOT_FOUND' };
    const draft = offer.versions.find((x) => x.version === offer.currentVersion);
    if (offer.status !== 'TASLAK' || !draft || draft.issuedAt) return { ok: false, code: 'NOT_DRAFT' };
    if (Number(v?.editVersion) !== offer.editVersion) return { ok: false, code: 'CONFLICT' };
    const parsed = parseOffer(v, await catalogFor(tx, v, keepOf(draft.data)));
    if (!parsed.ok) return parsed;
    let no = offer.no;
    const everIssued = offer.versions.some((x) => x.issuedAt);
    if (!everIssued && v?.no != null && String(v.no).trim() !== '' && Number(String(v.no).trim()) !== offer.no) {
      const num = await pickNo(tx, v.no, offer.id);
      if (!num.ok) return num;
      no = num.no;
    }
    const s = sums(parsed.data);
    // Kesin sürüm hiçbir zaman güncellenmez: koşul issuedAt = null
    const upd = await tx.commercialOfferVersion.updateMany({ where: { id: draft.id, issuedAt: null }, data: { data: parsed.data, total: s.total, cost: s.cost } });
    if (upd.count !== 1) return { ok: false, code: 'NOT_DRAFT' };
    const bump = await tx.commercialOffer.updateMany({
      where: { id: offer.id, editVersion: offer.editVersion },
      data: { no, customerId: parsed.data.customerId, firmName: parsed.data.firmName, total: s.total, editVersion: { increment: 1 } },
    });
    if (bump.count !== 1) return { ok: false, code: 'CONFLICT' };
    await writeAudit(tx, {
      action: 'COMMERCIAL_OFFER_SAVED', entityType: 'CommercialOffer', entityId: offer.id, userId: actor.id,
      details: { no: offerNoText(no), version: draft.version, firm: parsed.data.firmName, glass: parsed.data.glass.length, profile: parsed.data.profile.length, total: s.total, costOverrides: costOverrides(parsed.data), ...(no !== offer.no ? { noBefore: offerNoText(offer.no) } : {}) },
    }, actor);
    return { ok: true, editVersion: offer.editVersion + 1 };
  });
}

/**
 * Güncel taslak sürümü kesinleştirir (TASLAK → HAZIR). Kesin sürüm değişmez; müşteri PDF'i "taslak" damgası taşımaz.
 * Satır yoksa (cam ve profil boş) kesinleşmez. Hiçbir e-posta / bildirim / sipariş yok.
 */
/** @returns {Promise<{ ok: true, version: number } | { ok: false, code: string }>} */
export async function issueOffer(db, { offerId, editVersion }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lockOffer(tx, idOf(offerId));
    const offer = await tx.commercialOffer.findUnique({ where: { id: idOf(offerId) }, include: { versions: { where: { issuedAt: null } } } });
    if (!offer) return { ok: false, code: 'NOT_FOUND' };
    const draft = offer.versions.find((x) => x.version === offer.currentVersion);
    if (offer.status !== 'TASLAK' || !draft) return { ok: false, code: 'NOT_DRAFT' };
    if (Number(editVersion) !== offer.editVersion) return { ok: false, code: 'CONFLICT' };
    const data = /** @type {any} */ (draft.data);
    if (!(data?.glass?.length || data?.profile?.length)) return { ok: false, code: 'EMPTY' };
    const now = new Date();
    const upd = await tx.commercialOfferVersion.updateMany({ where: { id: draft.id, issuedAt: null }, data: { issuedAt: now, issuedById: actor.id } });
    if (upd.count !== 1) return { ok: false, code: 'NOT_DRAFT' };
    await tx.commercialOffer.update({ where: { id: offer.id }, data: { status: 'HAZIR', statusNote: null, editVersion: { increment: 1 } } });
    await writeAudit(tx, {
      action: 'COMMERCIAL_OFFER_ISSUED', entityType: 'CommercialOffer', entityId: offer.id, userId: actor.id,
      details: { no: offerNoText(offer.no), version: draft.version, total: draft.total.toString(), cost: draft.cost.toString() },
    }, actor);
    return { ok: true, version: draft.version };
  });
}

/** Kesin sürümden yeni taslak sürüm (HAZIR / RED → TASLAK). Önceki sürüm aynen kalır. */
/** @returns {Promise<{ ok: true, version: number } | { ok: false, code: string }>} */
export async function newRevision(db, { offerId, editVersion }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lockOffer(tx, idOf(offerId));
    const offer = await tx.commercialOffer.findUnique({ where: { id: idOf(offerId) }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!offer) return { ok: false, code: 'NOT_FOUND' };
    const last = offer.versions[0];
    if (!REVISABLE.includes(offer.status) || !last?.issuedAt) return { ok: false, code: 'NOT_REVISABLE' };
    if (Number(editVersion) !== offer.editVersion) return { ok: false, code: 'CONFLICT' };
    const version = last.version + 1;
    await tx.commercialOfferVersion.create({ data: { offerId: offer.id, version, data: /** @type {any} */ (last.data), total: last.total, cost: last.cost, createdById: actor.id } });
    await tx.commercialOffer.update({ where: { id: offer.id }, data: { status: 'TASLAK', statusNote: null, currentVersion: version, editVersion: { increment: 1 } } });
    await writeAudit(tx, {
      action: 'COMMERCIAL_OFFER_REVISION', entityType: 'CommercialOffer', entityId: offer.id, userId: actor.id,
      details: { no: offerNoText(offer.no), from: last.version, version, statusBefore: offer.status },
    }, actor);
    return { ok: true, version };
  });
}

/**
 * Sonuç / iptal kaydı: HAZIR → KABUL | RED; TASLAK | HAZIR → IPTAL (gerekçe zorunlu). YALNIZCA KAYIT — kabul edilen teklif
 * sipariş, fiyat, stok, belge ya da bildirim OLUŞTURMAZ (müşteri siparişini kendi hesabından verir).
 */
/** @returns {Promise<{ ok: true } | { ok: false, code: string }>} */
export async function setOfferStatus(db, { offerId, editVersion, status, note }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const target = String(status ?? '');
  if (!['KABUL', 'RED', 'IPTAL'].includes(target)) return { ok: false, code: 'STATUS' };
  const text = one(note, LIMITS.note + 1);
  if (text.length > LIMITS.note) return { ok: false, code: 'NOTE' };
  if (target === 'IPTAL' && !text) return { ok: false, code: 'REASON' };
  return db.$transaction(async (tx) => {
    await lockOffer(tx, idOf(offerId));
    const offer = await tx.commercialOffer.findUnique({ where: { id: idOf(offerId) } });
    if (!offer) return { ok: false, code: 'NOT_FOUND' };
    const from = target === 'IPTAL' ? CANCELLABLE : ['HAZIR'];
    if (!from.includes(offer.status)) return { ok: false, code: 'NOT_ALLOWED' };
    if (Number(editVersion) !== offer.editVersion) return { ok: false, code: 'CONFLICT' };
    await tx.commercialOffer.update({ where: { id: offer.id }, data: { status: /** @type {any} */ (target), statusNote: text || null, editVersion: { increment: 1 } } });
    await writeAudit(tx, {
      action: 'COMMERCIAL_OFFER_STATUS', entityType: 'CommercialOffer', entityId: offer.id, userId: actor.id,
      details: { no: offerNoText(offer.no), version: offer.currentVersion, from: offer.status, to: target, note: text || null, orderCreated: false },
    }, actor);
    return { ok: true };
  });
}

/**
 * Liste (arama: firma adı ya da numara; durum süzgeci). En çok 300.
 * @returns {Promise<{ ok: true, rows: { id: string, no: number, status: string, firmName: string, total: string, version: number, date: string | null,
 *   issued: boolean, createdBy: string, updatedAt: Date, cost: string | null, profit: string | null, margin: string | null, missingCost: number }[] }
 *   | { ok: false, code: string }>}
 */
export async function listOffers(db, { q = '', status = '' } = {}, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const text = one(q, 80);
  const num = /^\d{1,6}$/.test(text) ? Number(text) : null;
  const where = {
    ...(['TASLAK', 'HAZIR', 'KABUL', 'RED', 'IPTAL'].includes(status) ? { status: /** @type {any} */ (status) } : {}),
    ...(text ? { OR: [{ firmName: { contains: text, mode: /** @type {const} */ ('insensitive') } }, ...(num != null ? [{ no: num }] : [])] } : {}),
  };
  const rows = await db.commercialOffer.findMany({
    where, orderBy: [{ no: 'desc' }], take: 300,
    include: { createdBy: { select: { name: true } }, versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, issuedAt: true, cost: true, data: true } } },
  });
  return {
    ok: true,
    rows: rows.map((o) => {
      const v = o.versions[0];
      const t = v ? computeOffer(/** @type {any} */ (v.data)).totals : null;
      return {
        id: o.id, no: o.no, status: o.status, firmName: o.firmName, total: o.total.toString(), version: o.currentVersion,
        date: /** @type {any} */ (v?.data)?.date ?? null, issued: !!v?.issuedAt, createdBy: o.createdBy?.name ?? '',
        updatedAt: o.updatedAt, cost: t?.cost ?? null, profit: t?.profit ?? null, margin: t?.margin ?? null, missingCost: t?.missingCost ?? 0,
      };
    }),
  };
}

/**
 * Tek teklif: bütün sürümler (veriyle) + geçmiş (denetim kayıtları).
 * @param {import('@prisma/client').PrismaClient} db
 */
export async function loadOffer(db, id, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const offer = await db.commercialOffer.findUnique({
    where: { id: idOf(id) },
    include: {
      createdBy: { select: { name: true } }, customer: { select: { id: true, name: true } },
      versions: { orderBy: { version: 'desc' }, include: { createdBy: { select: { name: true } }, issuedBy: { select: { name: true } } } },
    },
  });
  if (!offer) return /** @type {const} */ ({ ok: false, code: 'NOT_FOUND' });
  const history = await db.auditLog.findMany({
    where: { entityType: 'CommercialOffer', entityId: offer.id }, orderBy: { createdAt: 'desc' }, take: 200,
    select: { id: true, action: true, details: true, createdAt: true, user: { select: { name: true } } },
  });
  return { ok: /** @type {const} */ (true), offer, history };
}

/**
 * Belge (PDF / Excel) için bir sürüm: `version` verilmezse güncel sürüm. Kesinleşmemiş sürüm `draft: true` döner (PDF'te damga).
 * @returns {Promise<{ ok: true, offerId: string, no: number, status: string, version: number, draft: boolean, data: any, issuedAt: Date | null } | { ok: false, code: string }>}
 */
export async function offerVersion(db, { id, version }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const offer = await db.commercialOffer.findUnique({ where: { id: idOf(id) }, select: { id: true, no: true, currentVersion: true, status: true } });
  if (!offer) return { ok: false, code: 'NOT_FOUND' };
  const n = version == null || version === '' ? offer.currentVersion : Number(version);
  if (!Number.isInteger(n) || n < 1) return { ok: false, code: 'NOT_FOUND' };
  const v = await db.commercialOfferVersion.findUnique({ where: { offerId_version: { offerId: offer.id, version: n } } });
  if (!v) return { ok: false, code: 'NOT_FOUND' };
  return { ok: true, offerId: offer.id, no: offer.no, status: offer.status, version: v.version, draft: !v.issuedAt, data: /** @type {any} */ (v.data), issuedAt: v.issuedAt };
}

/**
 * Düzenleyicinin seçenekleri: etkin camlar, etkin profil ürünleri (kategoriyle), müşteri firmaları (yalnızca okunur)
 * @param {import('@prisma/client').PrismaClient} db
 */
export async function editorCatalog(db, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const [glass, profile, customers, costs] = await Promise.all([
    db.glassProduct.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameTr: 'asc' }], select: { id: true, nameTr: true, colorTr: true, nameRo: true, colorRo: true } }),
    db.profileProduct.findMany({ where: { isActive: true }, orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { code: 'asc' }], select: PROFILE_SELECT }),
    db.customer.findMany({ where: { type: 'CUSTOMER' }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    glassCostTable(db),
  ]);
  // Modülün kategori sırası (M1); kararlı sıralama: aynı kategoride katalog sırası korunur
  const ordered = profile.map((p, i) => ({ p, i })).sort((a, b) => commercialCategoryRank(a.p.category) - commercialCategoryRank(b.p.category) || a.i - b.i).map((x) => x.p);
  return {
    ok: /** @type {const} */ (true),
    glass: glass.map((g) => ({ ...g, listCost: costs.prices.get(g.id) ?? null })),
    glassCostTable: costs.table ? costs.table.name : null, glassCostReason: costs.reason,
    profile: ordered.map(plainProfile), customers,
  };
}
