// Profil iadesi (DÜZELTME 10 M8, 3.99.0) — veritabanı tarafı. Kurallar returns-rules.js'te (saf).
//
// Yetki: iade açma, yönetici olarak depo teslimini onaylama, iptal ve gerçek iadeyi işaretleme yalnızca PROFILE_RETURN_MANAGE
// (yalnızca yönetici) — her dışa açık işlevin ilk satırında. Depo personelinin tek yetkisi e-postadaki tek kullanımlık
// bağlantıyla o iadenin fiziksel teslimini onaylamaktır (confirmReturnByToken).
//
// İade kaydı stoğu DEĞİŞTİRMEZ; depo teslimi onaylanınca sağlam → kullanılabilir stok (IADE), hasarlı → bloke stok
// (server/profile/stock.js → receiveReturnStock, ürün kilitleri altında, bir kez). Mali karşılık yalnızca niyet kaydıdır;
// FGO düzeltme belgesi (storno / düzeltme faturası, proforma güncelleme) bu sürümde KESİLMEZ — muhasebe ve FGO doğrulaması
// bekler. E-posta ve bildirim kuyruktan (aynı işlemde yazılır; gönderim işçide).
import { can } from '../auth/permissions.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { parseDateOnly } from '../orders/rules.js';
import { dayKeyOf, localDay } from './dates.js';
import { hashToken } from './warehouse.js';
import { receiveReturnStock } from './stock.js';
import { RETURNABLE_STAGES, RETURN_LIMITS, countedReturns, customerPaid, parseReturnReceipt, parseReturnRequest, returnableLines } from './returns-rules.js';

export const RETURN_EMAIL = 'PROFILE_RETURN_EMAIL';
export const RETURN_LINK_DAYS = 30;
const FORBIDDEN = /** @type {const} */ ({ ok: false, code: 'FORBIDDEN' });
const allowed = (actor) => can(actor?.role, 'PROFILE_RETURN_MANAGE');
const lockKey = (tx, key) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
const lockOrder = (tx, orderId) => lockKey(tx, `profile-return:${orderId}`);
const one = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max + 1);
/** @typedef {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} Db */
const tzOf = (o) => o?.timeZone ?? 'Europe/Bucharest';

/**
 * Siparişin iade bağlamı: onaylı teklif satırları, önceki iadeler, ödeme / fatura durumu
 * @param {Db} tx  @param {unknown} orderId
 */
async function context(tx, orderId) {
  const order = await tx.order.findUnique({
    where: { id: String(orderId ?? '') },
    select: {
      id: true, orderNo: true, status: true, removedAt: true, orderTypeCode: true, customerId: true,
      profile: { select: { stage: true, approvedOfferId: true, paidAt: true, fxRate: true } },
      profileReturns: { orderBy: { seq: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
      fgoDocuments: { select: { kind: true, paid: true } },
    },
  });
  if (!order || order.orderTypeCode !== 'PROFILE_ORDER' || !order.profile) return null;
  const offer = order.profile.approvedOfferId
    ? await tx.offer.findUnique({ where: { id: order.profile.approvedOfferId }, select: { currency: true, lines: { orderBy: { sortOrder: 'asc' }, select: { id: true, kind: true, profileProductId: true, adet: true, offerPrice: true, unitCode: true, description: true } } } })
    : null;
  const manual = await tx.manualPayment.count({ where: { orderId: order.id, voidedAt: null } });
  const prior = countedReturns(order.profileReturns);
  const lines = returnableLines(offer?.lines ?? [], prior);
  const ids = lines.map((l) => l.productId);
  const products = ids.length ? await tx.profileProduct.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, nameRo: true, nameTr: true, unitCode: true } }) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  return {
    order, offer, currency: offer?.currency ?? 'EUR',
    lines: lines.map((l) => ({ ...l, product: byId.get(l.productId) ?? null })).filter((l) => l.product),
    delivered: RETURNABLE_STAGES.includes(order.profile.stage) && !order.removedAt && order.status !== 'IPTAL',
    invoiced: order.profile.stage === 'FATURALANDI' || order.fgoDocuments.some((d) => d.kind === 'INVOICE'),
    paid: customerPaid({ paidAt: order.profile.paidAt, fgoPaid: order.fgoDocuments.reduce((s, d) => s + Number(d.paid ?? 0), 0), manualPayments: manual }),
  };
}

/**
 * Yönetici ekranı: iade edilebilir satırlar ve siparişin iadeleri
 * @param {Db} db  @param {string} orderId  @param {any} actor
 */
export async function returnOverview(db, orderId, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const c = await context(db, orderId);
  if (!c) return /** @type {const} */ ({ ok: false, code: 'NOT_FOUND' });
  return { ok: /** @type {const} */ (true), delivered: c.delivered, invoiced: c.invoiced, paid: c.paid, currency: c.currency, lines: c.lines, returns: c.order.profileReturns };
}

/**
 * İade açar (kısmi ya da tam). Teslimden sonra; aynı mal iki kez iade edilmez (sipariş kilidi altında yeniden hesaplanır).
 * Tek seferlik form anahtarı: aynı form ikinci kez gelirse ilk iade döner. Stok DEĞİŞMEZ. İlk depo bildirimi kuyruğa yazılır.
 * photos: isteğe bağlı fotoğraflar — server/files/store.js'ten geçmiş (içerik denetimi + antivirüs) saklanmış dosyalar; iadeyle
 *   AYNI işlemde siparişin iç dosyası (kaynak RETURN_PHOTO) olarak kaydedilir. İade yazılmazsa çağıran dosyaları siler.
 * @param {{ orderId: string, reason: unknown, note?: unknown, quantities: Record<string, unknown>, financeAction?: unknown, requestKey: unknown,
 *   photos?: { storageKey: string, name: string, size: number, mime: string, checksum: string, scanStatus: string, scannedAt?: Date | null }[] }} v
 */
export async function createReturn(db, v, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const key = String(v.requestKey ?? '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return { ok: false, code: 'KEY' };
  const photos = Array.isArray(v.photos) ? v.photos : [];
  if (photos.length > RETURN_LIMITS.photos) return { ok: false, code: 'PHOTOS' };
  return db.$transaction(async (tx) => {
    await lockOrder(tx, String(v.orderId ?? ''));
    const same = await tx.profileReturn.findUnique({ where: { requestKey: key } });
    // Aynı form ikinci kez: ilk iade döner (bu isteğin fotoğrafları kaydedilmez — çağıran siler)
    if (same) return same.orderId === v.orderId ? { ok: true, id: same.id, seq: same.seq, duplicate: true } : { ok: false, code: 'KEY' };
    const c = await context(tx, v.orderId);
    if (!c) return { ok: false, code: 'NOT_FOUND' };
    if (!c.delivered) return { ok: false, code: 'NOT_DELIVERED' };
    const parsed = parseReturnRequest({ reason: v.reason, note: v.note, quantities: v.quantities, financeAction: v.financeAction }, c.lines, { paid: c.paid });
    if (!parsed.ok) return parsed;
    const seq = (c.order.profileReturns.at(-1)?.seq ?? 0) + 1;
    const files = [];
    for (const f of photos) {
      files.push(await tx.orderFile.create({
        data: { orderId: c.order.id, kind: 'INTERNAL', source: 'RETURN_PHOTO', name: f.name, storageKey: f.storageKey, size: f.size, mime: f.mime, checksum: f.checksum, scanStatus: /** @type {any} */ (f.scanStatus), scannedAt: f.scannedAt ?? null, uploadedById: actor.id },
        select: { id: true },
      }));
    }
    const r = await tx.profileReturn.create({
      data: {
        orderId: c.order.id, seq, reason: parsed.value.reason, note: parsed.value.note, currency: c.currency, fxRate: c.order.profile?.fxRate ?? null,
        amount: parsed.value.amount, invoiced: c.invoiced, paid: c.paid, financeAction: parsed.value.financeAction, photoFileIds: files.length ? files.map((f) => f.id) : undefined,
        requestKey: key, createdById: actor.id,
        lines: {
          create: parsed.value.lines.map((l, i) => {
            const p = /** @type {any} */ (l).product;
            return { offerLineId: l.offerLineId, productId: l.productId, code: p.code, nameRo: p.nameRo, nameTr: p.nameTr, unitCode: p.unitCode, qty: l.qty, unitPrice: /** @type {string} */ (l.unitPrice), lineTotal: l.lineTotal, sortOrder: i };
          }),
        },
      },
    });
    await writeHistory(tx, { orderId: c.order.id, event: 'PROFILE_RETURN_OPENED', note: `#${seq}`, actorId: actor.id, from: c.order.status, to: c.order.status });
    await tx.notificationOutbox.create({ data: { type: RETURN_EMAIL, orderId: c.order.id, payload: { returnId: r.id, notice: 'OPENED' } } });
    await writeAudit(tx, {
      action: 'PROFILE_RETURN_OPENED', entityType: 'Order', entityId: c.order.id, userId: actor.id,
      details: { orderNo: c.order.orderNo, returnId: r.id, seq, reason: parsed.value.reason, amount: parsed.value.amount, currency: c.currency, invoiced: c.invoiced, paid: c.paid, financeAction: parsed.value.financeAction, lines: parsed.value.lines.map((l) => ({ code: /** @type {any} */ (l).product.code, qty: l.qty })) },
    }, actor);
    return { ok: true, id: r.id, seq, duplicate: false };
  });
}

/**
 * Depo teslimi — tek yol: iade ACIK iken bir kez (koşullu güncelleme). Sağlam → stok, hasarlı → bloke stok; ikinci depo
 * bildirimi kuyruğa yazılır; depo bağlantısı kapanır.
 * @param {any} tx  @param {any} r  iade (satırlarıyla)  @param {{ quantities: any, note?: unknown, via: 'ADMIN' | 'DEPOT_LINK', actorId: string | null, ip?: string | null }} o
 */
async function receive(tx, r, { quantities, note, via, actorId, ip = null }, actor) {
  if (r.status !== 'ACIK') return { ok: false, code: 'NOT_OPEN' };
  const parsed = parseReturnReceipt(r.lines, quantities);
  if (!parsed.ok) return parsed;
  const n = one(note, RETURN_LIMITS.note);
  if (n.length > RETURN_LIMITS.note) return { ok: false, code: 'TOO_LONG' };
  const done = await tx.profileReturn.updateMany({
    where: { id: r.id, status: 'ACIK' },
    data: { status: 'TESLIM_ALINDI', receivedAt: new Date(), receivedVia: via, receivedById: actorId, receivedNote: n || null, depotTokenHash: null, depotTokenExpiresAt: null },
  });
  if (done.count !== 1) return { ok: false, code: 'NOT_OPEN' };
  for (const l of parsed.lines) await tx.profileReturnLine.update({ where: { id: l.id }, data: { goodQty: l.good, damagedQty: l.damaged } });
  const order = await tx.order.findUniqueOrThrow({ where: { id: r.orderId }, select: { id: true, orderNo: true, status: true } });
  const stock = await receiveReturnStock(tx, {
    returnId: r.id, orderId: order.id, note: `${order.orderNo} iade #${r.seq}`,
    lines: r.lines.map((l) => { const x = parsed.lines.find((y) => y.id === l.id); return { productId: l.productId, good: x?.good ?? 0, damaged: x?.damaged ?? 0 }; }),
    actorId,
  });
  await writeHistory(tx, { orderId: order.id, event: 'PROFILE_RETURN_RECEIVED', note: `#${r.seq}`, actorId, from: order.status, to: order.status });
  await tx.notificationOutbox.create({ data: { type: RETURN_EMAIL, orderId: order.id, payload: { returnId: r.id, notice: 'RECEIVED' } } });
  await writeAudit(tx, {
    action: 'PROFILE_RETURN_RECEIVED', entityType: 'Order', entityId: order.id, userId: actorId,
    details: { orderNo: order.orderNo, returnId: r.id, seq: r.seq, via, lines: parsed.lines, moves: stock },
  }, actor ?? { role: via === 'DEPOT_LINK' ? 'DEPOT' : 'SYSTEM', ip });
  return { ok: true, seq: r.seq };
}

/** Yönetici panelden depo teslimini onaylar (depo bağlantısıyla aynı kural) */
export async function confirmReturnReceipt(db, { returnId, quantities, note }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    const head = await tx.profileReturn.findUnique({ where: { id: String(returnId ?? '') }, select: { orderId: true } });
    if (!head) return { ok: false, code: 'NOT_FOUND' };
    await lockOrder(tx, head.orderId);
    const r = await tx.profileReturn.findUniqueOrThrow({ where: { id: String(returnId) }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
    return receive(tx, r, { quantities, note, via: 'ADMIN', actorId: actor.id }, actor);
  });
}

/**
 * Depo bağlantısının iadesi (geçerli, süresi dolmamış, iade açık); geçersizse null
 * @param {Db} db  @param {string | null | undefined} token  @param {Date} [now]
 */
export async function findDepotReturn(db, token, now = new Date()) {
  if (!token || String(token).length < 20) return null;
  const r = await db.profileReturn.findUnique({
    where: { depotTokenHash: hashToken(token) },
    include: { lines: { orderBy: { sortOrder: 'asc' } }, order: { select: { orderNo: true, customer: { select: { name: true } } } } },
  });
  if (!r || r.status !== 'ACIK' || !r.depotTokenExpiresAt || r.depotTokenExpiresAt <= now) return null;
  return r;
}

/**
 * Depo personeli bağlantıyla fiziksel teslimi onaylar (giriş yok; yetki = bağlantı)
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ token: string, quantities: any, note?: unknown, ip?: string | null }} v
 */
export async function confirmReturnByToken(db, { token, quantities, note, ip = null }) {
  return db.$transaction(async (tx) => {
    const found = await findDepotReturn(tx, token);
    if (!found) return { ok: false, code: 'INVALID' };
    await lockOrder(tx, found.orderId);
    const r = await tx.profileReturn.findUniqueOrThrow({ where: { id: found.id }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
    return receive(tx, r, { quantities, note, via: 'DEPOT_LINK', actorId: null, ip }, null);
  });
}

/** Teslimden önce gerekçeyle iptal (stok hiç değişmemişti); bağlantı kapanır */
export async function cancelReturn(db, { returnId, reason }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const why = one(reason, RETURN_LIMITS.reason);
  if (!why) return { ok: false, code: 'REASON' };
  if (why.length > RETURN_LIMITS.reason) return { ok: false, code: 'TOO_LONG' };
  return db.$transaction(async (tx) => {
    const r = await tx.profileReturn.findUnique({ where: { id: String(returnId ?? '') }, include: { order: { select: { id: true, orderNo: true, status: true } } } });
    if (!r) return { ok: false, code: 'NOT_FOUND' };
    await lockOrder(tx, r.orderId);
    const done = await tx.profileReturn.updateMany({ where: { id: r.id, status: 'ACIK' }, data: { status: 'IPTAL', cancelledAt: new Date(), cancelReason: why, depotTokenHash: null, depotTokenExpiresAt: null } });
    if (done.count !== 1) return { ok: false, code: 'NOT_OPEN' };
    await writeHistory(tx, { orderId: r.orderId, event: 'PROFILE_RETURN_CANCELLED', note: `#${r.seq}`, actorId: actor.id, from: r.order.status, to: r.order.status });
    await writeAudit(tx, { action: 'PROFILE_RETURN_CANCELLED', entityType: 'Order', entityId: r.orderId, userId: actor.id, details: { orderNo: r.order.orderNo, returnId: r.id, seq: r.seq, reason: why } }, actor);
    return { ok: true };
  });
}

/**
 * Gerçek para iadesinin yapıldığını işaretler (tarih + referans; bir kez). TAKİP'teki "para iadesi" seçimi tek başına iade
 * sayılmaz — bu ayrı, bilinçli kayıttır. FGO'ya hiçbir şey gönderilmez.
 */
export async function markRefundDone(db, { returnId, doneOn, reference }, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const today = localDay(opts.now ?? new Date(), tzOf(opts));
  const date = parseDateOnly(String(doneOn ?? ''));
  if (!date || dayKeyOf(date) > today) return { ok: false, code: 'DATE' };
  const ref = one(reference, RETURN_LIMITS.reference);
  if (!ref) return { ok: false, code: 'REFERENCE' };
  if (ref.length > RETURN_LIMITS.reference) return { ok: false, code: 'TOO_LONG' };
  return db.$transaction(async (tx) => {
    const r = await tx.profileReturn.findUnique({ where: { id: String(returnId ?? '') }, include: { order: { select: { orderNo: true } } } });
    if (!r) return { ok: false, code: 'NOT_FOUND' };
    if (r.status === 'IPTAL' || r.financeAction !== 'REFUND') return { ok: false, code: 'NOT_ALLOWED' };
    const done = await tx.profileReturn.updateMany({ where: { id: r.id, refundDoneAt: null }, data: { refundDoneAt: date, refundReference: ref, refundById: actor.id } });
    if (done.count !== 1) return { ok: false, code: 'ALREADY_DONE' };
    await writeAudit(tx, { action: 'PROFILE_RETURN_REFUND_DONE', entityType: 'Order', entityId: r.orderId, userId: actor.id, details: { orderNo: r.order.orderNo, returnId: r.id, seq: r.seq, doneOn: dayKeyOf(date), reference: ref, amount: r.amount.toString(), currency: r.currency } }, actor);
    return { ok: true };
  });
}
