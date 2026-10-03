// Yüklenmeyen camın ileri bir yüklemeye aktarılması (Aşama 7E, karar 102).
//
//   Onaylı yüklemede NOT_LOADED kaydedilen cam (kırık, eksik, hazır değil…) kaybolmaz ve siparişi kopyalanmaz: yönetici
//   kalan adedi ileri bir yükleme gününe aktarır (LoadingReplan). Aktarım yalnızca LOJİSTİK bir plandır:
//     - kaynağı yüklenmeyen onay kalemidir (sipariş, gerçek müşteri, teklif satırı ve ticari değerler oradan gelir);
//     - eski yükleme onayı ve kalemleri DEĞİŞMEZ (16.10 kaydı sonsuza dek "8 yüklendi, 2 yüklenmedi" der);
//     - aktarılan miktar kaynağın kalan adedinin tamamıdır (fazlası aktarılamaz; yüklenen adet hiç aktarılmaz);
//     - kaynak başına tek etkin aktarım vardır (activeKey benzersiz + işlem kilidi); başka güne almak eskisini kapatıp
//       yenisini açar, vazgeçmek kaydı kapatır — kayıt silinmez;
//     - aktarılan kalan yeni günün yükleme önizlemesine / onayına yalnızca kendi adediyle girer
//       (server/loading/confirmation.js → planItems); o gün de yüklenmezse yeni NOT_LOADED kalemi yeniden aktarılır.
//       Zincir: kalem → aktarım → kalem (replanId) → aktarım → …
//   Fatura, proforma zinciri ve kârlılık yalnızca fiilen LOADED kalemlere bakar; aktarım hiçbirini değiştirmez.
//   Yalnızca yönetici (LOADING_CONFIRM); kontrol burada, sunucuda yapılır.
import { can } from '../auth/permissions.js';
import { parseDateOnly } from '../orders/rules.js';
import { dayKey } from '../orders/loading.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { NOT_LOADED_REASONS, shipDayDate } from './confirmation.js';

export { NOT_LOADED_REASONS };
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const dmy = (day) => day.split('-').reverse().join('.');
const LOCK = 'loading-confirmation'; // yükleme onayıyla aynı kilit: onay ve aktarım birbirinin arasına giremez

/**
 * @typedef {{
 *   itemId: string, orderId: string, orderNo: string, title: string | null, customerId: string, customerName: string,
 *   glass: string, glassRo: string | null, enMm: number | null, boyMm: number | null,
 *   planned: number, loaded: number, remaining: number, m2: number, reason: string | null, note: string | null,
 *   origin: string | null, blocked: 'ORDER_CANCELLED' | 'ORDER_ON_HOLD' | null,
 *   replan: null | { id: string, day: string, status: 'ACTIVE' | 'CONFIRMED', loaded: number, notLoaded: number },
 * }} NotLoadedRow
 */

/**
 * Onaylı günün yüklenmeyen kalemleri: sipariş, gerçek müşteri, cam, o onayda planlanan / yüklenen / kalan adet, neden
 * ve aktarım durumu (planlandığı gün; onaylandıysa kaçının yüklendiği). origin: kalem zaten aktarılmış bir kalansa
 * geldiği yükleme günü.
 * @param {any} db  @param {string} day
 * @returns {Promise<NotLoadedRow[]>}
 */
export async function notLoadedOfDay(db, day) {
  if (!parseDateOnly(day)) return [];
  const conf = await db.loadingConfirmation.findUnique({
    where: { shipDay: shipDayDate(day) },
    include: {
      items: {
        orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }],
        include: {
          order: { select: { orderNo: true, title: true, status: true, onHold: true } }, customer: { select: { name: true } },
          replan: { select: { fromDay: true } },
          replans: { where: { status: { not: 'CANCELLED' } }, include: { items: { select: { status: true, quantity: true } } } },
        },
      },
    },
  });
  if (!conf) return [];
  // Aynı onayda aynı kaynağın yüklenen kısmı (satır LOADED + NOT_LOADED olarak bölünmüştür)
  const same = (a, b) => a.orderId === b.orderId && a.offerLineId === b.offerLineId && (a.replanId ?? null) === (b.replanId ?? null) && a.sortOrder === b.sortOrder;
  return conf.items.filter((i) => i.status === 'NOT_LOADED').map((i) => {
    const loaded = conf.items.filter((x) => x.status === 'LOADED' && same(x, i)).reduce((s, x) => s + x.quantity, 0);
    const r = i.replans[0] ?? null;
    const sum = (st) => (r ? r.items.filter((x) => x.status === st).reduce((s, x) => s + x.quantity, 0) : 0);
    return {
      itemId: i.id, orderId: i.orderId, orderNo: i.order.orderNo, title: i.order.title ?? null, customerId: i.customerId, customerName: i.customer.name,
      glass: i.description, glassRo: i.descriptionRo ?? null, enMm: i.enMm ?? null, boyMm: i.boyMm ?? null,
      planned: loaded + i.quantity, loaded, remaining: i.quantity, m2: Number(i.m2), reason: i.notLoadedReason ?? null, note: i.notLoadedNote ?? null,
      origin: i.replan ? dayOf(i.replan.fromDay) : null,
      blocked: i.order.status === 'IPTAL' ? 'ORDER_CANCELLED' : i.order.onHold ? 'ORDER_ON_HOLD' : null,
      replan: r ? { id: r.id, day: dayOf(r.shipDay), status: r.status, loaded: sum('LOADED'), notLoaded: sum('NOT_LOADED') } : null,
    };
  });
}

/**
 * Yüklenmeyen kalanı ileri bir yükleme gününe aktarır (yönetici). Aynı kalan için etkin bir aktarım varsa başka güne
 * alınır: eski kayıt kapanır (CANCELLED), yenisi açılır; hiçbir kayıt silinmez.
 * quantity verilirse kalan adede eşit olmalıdır (fazlası / azı aktarılamaz — taklit istek).
 * @param {any} db
 * @param {{ itemId: string, day: string, quantity?: number | string | null, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, replanId: string, quantity: number, moved: boolean } | { ok: false, code: 'FORBIDDEN' | 'BAD_DAY' | 'NOT_FUTURE' | 'NOT_FOUND' | 'NOT_ALLOWED' | 'BAD_QUANTITY' | 'ORDER_CANCELLED' | 'ORDER_ON_HOLD' | 'DAY_CONFIRMED' | 'ALREADY_LOADED' | 'ALREADY_PLANNED' }>}
 */
export async function replanNotLoaded(db, { itemId, day, quantity = null, actor, now = new Date() }) {
  if (!can(actor?.role, 'LOADING_CONFIRM')) return { ok: false, code: 'FORBIDDEN' };
  if (!parseDateOnly(day)) return { ok: false, code: 'BAD_DAY' };
  // Yalnızca GELECEK bir yükleme günü: bugün ve geçmiş günler aktarım hedefi olamaz
  if (!(day > dayKey(now))) return { ok: false, code: 'NOT_FUTURE' };
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`;
      const item = await tx.loadingConfirmationItem.findUnique({
        where: { id: String(itemId ?? '') },
        include: { confirmation: { select: { id: true, shipDay: true } }, order: { select: { id: true, orderNo: true, status: true, onHold: true } } },
      });
      if (!item) return { ok: false, code: 'NOT_FOUND' };
      // Yalnızca yüklenmeyen kalan aktarılır; yüklenen (LOADED) adet hiçbir zaman yeniden planlanmaz
      if (item.status !== 'NOT_LOADED') return { ok: false, code: 'NOT_ALLOWED' };
      if (quantity != null && quantity !== '' && Number(quantity) !== item.quantity) return { ok: false, code: 'BAD_QUANTITY' };
      if (item.order.status === 'IPTAL') return { ok: false, code: 'ORDER_CANCELLED' };
      if (item.order.onHold) return { ok: false, code: 'ORDER_ON_HOLD' };
      const shipDay = shipDayDate(day);
      if (await tx.loadingConfirmation.findUnique({ where: { shipDay }, select: { id: true } })) return { ok: false, code: 'DAY_CONFIRMED' };
      const current = await tx.loadingReplan.findUnique({ where: { activeKey: item.id } });
      if (current?.status === 'CONFIRMED') return { ok: false, code: 'ALREADY_LOADED' };
      if (current && dayOf(current.shipDay) === day) return { ok: false, code: 'ALREADY_PLANNED' };
      if (current) await tx.loadingReplan.update({ where: { id: current.id }, data: { status: 'CANCELLED', activeKey: null, closedAt: now } });
      const fromDay = dayOf(item.confirmation.shipDay);
      const replan = await tx.loadingReplan.create({
        data: {
          sourceItemId: item.id, orderId: item.orderId, customerId: item.customerId, quantity: item.quantity, m2: item.m2,
          reason: item.notLoadedReason ?? 'OTHER', fromDay: item.confirmation.shipDay, shipDay, activeKey: item.id, createdById: actor.id, createdAt: now,
        },
      });
      await writeHistory(tx, {
        orderId: item.orderId, event: 'REPLAN_NOT_LOADED', from: item.order.status, to: item.order.status, actorId: actor.id,
        note: `${item.quantity} · ${dmy(fromDay)} → ${dmy(day)}`,
      });
      await writeAudit(tx, {
        action: 'REPLAN_NOT_LOADED', entityType: 'Order', entityId: item.orderId, userId: actor.id,
        details: {
          orderNo: item.order.orderNo, customerId: item.customerId, replanId: replan.id, sourceConfirmationId: item.confirmation.id, sourceItemId: item.id,
          offerLineId: item.offerLineId, quantity: item.quantity, m2: Number(item.m2), reason: item.notLoadedReason, note: item.notLoadedNote,
          fromLoading: fromDay, previousLoading: current ? dayOf(current.shipDay) : null, toLoading: day, replaced: current?.id ?? null,
        },
      }, actor);
      return { ok: true, replanId: replan.id, quantity: item.quantity, moved: !!current };
    }, { timeout: 30_000 });
  } catch (e) {
    // Aynı kalan için ikinci etkin aktarım: veritabanı engeller (activeKey benzersiz)
    if (e?.code === 'P2002') return { ok: false, code: 'ALREADY_PLANNED' };
    throw e;
  }
}

/**
 * Etkin aktarımdan vazgeçer (yönetici): kalan yeniden "aktarılmadı" durumuna döner. Onaylanmış aktarım değiştirilemez.
 * @param {any} db
 * @param {{ replanId: string, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'NOT_ALLOWED' }>}
 */
export async function cancelReplan(db, { replanId, actor, now = new Date() }) {
  if (!can(actor?.role, 'LOADING_CONFIRM')) return { ok: false, code: 'FORBIDDEN' };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`;
    const r = await tx.loadingReplan.findUnique({ where: { id: String(replanId ?? '') }, include: { order: { select: { orderNo: true, status: true } } } });
    if (!r) return { ok: false, code: 'NOT_FOUND' };
    if (r.status !== 'ACTIVE') return { ok: false, code: 'NOT_ALLOWED' };
    await tx.loadingReplan.update({ where: { id: r.id }, data: { status: 'CANCELLED', activeKey: null, closedAt: now } });
    await writeHistory(tx, { orderId: r.orderId, event: 'REPLAN_CANCELLED', from: r.order.status, to: r.order.status, actorId: actor.id, note: `${r.quantity} · ${dmy(dayOf(r.shipDay))}` });
    await writeAudit(tx, {
      action: 'REPLAN_CANCELLED', entityType: 'Order', entityId: r.orderId, userId: actor.id,
      details: { orderNo: r.order.orderNo, customerId: r.customerId, replanId: r.id, sourceItemId: r.sourceItemId, quantity: r.quantity, fromLoading: dayOf(r.fromDay), cancelledLoading: dayOf(r.shipDay) },
    }, actor);
    return { ok: true };
  }, { timeout: 30_000 });
}

/**
 * Bir kalanın denemeler zinciri (en eskiden yeniye): hangi yüklemede kaç adet yüklenmedi / yüklendi ve nereye aktarıldı.
 * @param {any} db  @param {string} itemId  zincirdeki herhangi bir kalem
 * @returns {Promise<{ day: string, loaded: number, notLoaded: number, reason: string | null, replannedTo: string | null }[]>}
 */
export async function replanChain(db, itemId) {
  let item = await db.loadingConfirmationItem.findUnique({ where: { id: itemId }, include: { replan: true } });
  // Köke git: aktarımın kaynağı
  for (let i = 0; item?.replan && i < 50; i++) item = await db.loadingConfirmationItem.findUnique({ where: { id: item.replan.sourceItemId }, include: { replan: true } });
  const out = [];
  for (let i = 0; item && i < 50; i++) {
    const conf = await db.loadingConfirmation.findUnique({ where: { id: item.confirmationId }, select: { shipDay: true } });
    const siblings = await db.loadingConfirmationItem.findMany({
      where: { confirmationId: item.confirmationId, orderId: item.orderId, offerLineId: item.offerLineId, replanId: item.replanId },
      include: { replans: { where: { status: { not: 'CANCELLED' } } } },
    });
    const missing = siblings.find((x) => x.status === 'NOT_LOADED') ?? null;
    const next = missing?.replans[0] ?? null;
    out.push({
      day: dayOf(conf.shipDay), loaded: siblings.filter((x) => x.status === 'LOADED').reduce((s, x) => s + x.quantity, 0),
      notLoaded: missing?.quantity ?? 0, reason: missing?.notLoadedReason ?? null, replannedTo: next ? dayOf(next.shipDay) : null,
    });
    if (!next || next.status !== 'CONFIRMED') break;
    item = await db.loadingConfirmationItem.findFirst({ where: { replanId: next.id } });
  }
  return out;
}
