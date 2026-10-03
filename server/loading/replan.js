// Yüklenmeyen camın ileri bir yüklemeye aktarılması (Aşama 7E, karar 102; kısmi aktarım: Aşama 7F-1, karar 106).
//
//   Onaylı yüklemede NOT_LOADED kaydedilen cam (kırık, eksik, hazır değil…) kaybolmaz ve siparişi kopyalanmaz: yönetici
//   kalan adedi ileri bir yükleme gününe aktarır (LoadingReplan). Aktarım yalnızca LOJİSTİK bir plandır:
//     - kaynağı yüklenmeyen onay kalemidir (sipariş, gerçek müşteri, teklif satırı ve ticari değerler oradan gelir);
//     - eski yükleme onayı ve kalemleri DEĞİŞMEZ (16.10 kaydı sonsuza dek "8 yüklendi, 2 yüklenmedi" der);
//     - KISMİ aktarım: kalanın tamamı ya da bir kısmı aktarılabilir (0 < adet ≤ serbest kalan). Bir kapsamın
//       (onay + teklif satırı / aktarım) birden çok güne aktarımı olabilir; vazgeçilmemiş aktarımların toplamı kapsamın
//       GEÇERLİ yüklenmeyen adedini (effectiveItems — düzeltmeler dahil) aşamaz. Denetim yükleme onayıyla aynı kilit
//       altında, sunucuda yapılır; aynı kapsamdan aynı güne ikinci aktarım olmaz (activeKey benzersiz — çift tıklama);
//     - başka güne almak eskisini kapatıp yenisini açar, vazgeçmek kaydı kapatır — kayıt silinmez;
//     - aktarılan adet yeni günün yükleme önizlemesine / onayına yalnızca kendi adediyle girer
//       (server/loading/confirmation.js → planItems); o gün de yüklenmezse yeni NOT_LOADED kalemi yeniden aktarılır.
//       Zincir: kalem → aktarım(lar) → kalem (replanId) → aktarım → …
//   Fatura, proforma zinciri ve kârlılık yalnızca fiilen LOADED kalemlere bakar; aktarım hiçbirini değiştirmez.
//   Yalnızca yönetici (LOADING_CONFIRM); kontrol burada, sunucuda yapılır.
import { can } from '../auth/permissions.js';
import { parseDateOnly } from '../orders/rules.js';
import { dayKey } from '../orders/loading.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { NOT_LOADED_REASONS, effectiveItems, itemKey, shipDayDate, snapshotOfItem } from './confirmation.js';

export { NOT_LOADED_REASONS };
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const dmy = (day) => day.split('-').reverse().join('.');
const LOCK = 'loading-confirmation'; // yükleme onayıyla aynı kilit: onay ve aktarım birbirinin arasına giremez

/**
 * @typedef {{ id: string, day: string, status: 'ACTIVE' | 'CONFIRMED', quantity: number, loaded: number, notLoaded: number }} ReplanInfo
 * @typedef {{
 *   itemId: string, key: string, orderId: string, orderNo: string, title: string | null, customerId: string, customerName: string,
 *   glass: string, glassRo: string | null, enMm: number | null, boyMm: number | null,
 *   planned: number, loaded: number, remaining: number, free: number, m2: number, reason: string | null, note: string | null,
 *   origin: string | null, blocked: 'ORDER_CANCELLED' | 'ORDER_ON_HOLD' | null, replans: ReplanInfo[],
 * }} NotLoadedRow
 */

const qty = (rows, status) => rows.filter((x) => x.status === status).reduce((s, x) => s + x.quantity, 0);

/** Bir onayın vazgeçilmemiş aktarımları, kaynak kapsamına (itemKey) göre gruplanmış; her aktarımın onaylandığı kalemlerin geçerli hâliyle */
async function replansByScope(db, confirmationId) {
  const rows = await db.loadingReplan.findMany({
    where: { sourceItem: { confirmationId }, status: { not: 'CANCELLED' } },
    include: {
      sourceItem: { select: { offerLineId: true, replanId: true } },
      items: { select: { confirmationId: true, offerLineId: true, replanId: true, revision: true, status: true, quantity: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const out = new Map();
  for (const r of rows) out.set(itemKey(r.sourceItem), [...(out.get(itemKey(r.sourceItem)) ?? []), r]);
  return out;
}

/**
 * Onaylı günün yüklenmeyen kapsamları — GEÇERLİ durumla (düzeltmeler uygulanmış): sipariş, gerçek müşteri, cam, o onayda
 * planlanan / yüklenen / kalan adet, neden, aktarımları (gün, adet; onaylandıysa kaçının yüklendiği) ve henüz
 * aktarılmamış serbest kalan (free). origin: kalem zaten aktarılmış bir kalansa geldiği yükleme günü.
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
        include: { order: { select: { orderNo: true, title: true, status: true, onHold: true } }, customer: { select: { name: true } }, replan: { select: { fromDay: true } } },
      },
    },
  });
  if (!conf) return [];
  const eff = effectiveItems(conf.items);
  const replans = await replansByScope(db, conf.id);
  return eff.filter((i) => i.status === 'NOT_LOADED' && i.quantity > 0).map((i) => {
    const key = itemKey(i);
    // Aynı kapsamın yüklenen kısmı (satır LOADED + NOT_LOADED olarak bölünmüştür)
    const loaded = qty(eff.filter((x) => itemKey(x) === key), 'LOADED');
    const list = (replans.get(key) ?? []).map((r) => {
      const done = effectiveItems(r.items);
      return { id: r.id, day: dayOf(r.shipDay), status: r.status, quantity: r.quantity, loaded: qty(done, 'LOADED'), notLoaded: qty(done, 'NOT_LOADED') };
    });
    return {
      itemId: i.id, key, orderId: i.orderId, orderNo: i.order.orderNo, title: i.order.title ?? null, customerId: i.customerId, customerName: i.customer.name,
      glass: i.description, glassRo: i.descriptionRo ?? null, enMm: i.enMm ?? null, boyMm: i.boyMm ?? null,
      planned: loaded + i.quantity, loaded, remaining: i.quantity, free: Math.max(0, i.quantity - list.reduce((s, r) => s + r.quantity, 0)),
      m2: Number(i.m2), reason: i.notLoadedReason ?? null, note: i.notLoadedNote ?? null,
      origin: i.replan ? dayOf(i.replan.fromDay) : null,
      blocked: i.order.status === 'IPTAL' ? 'ORDER_CANCELLED' : i.order.onHold ? 'ORDER_ON_HOLD' : null,
      replans: list,
    };
  });
}

/**
 * Yüklenmeyen camı ileri bir yükleme gününe aktarır (yönetici) — tamamını ya da bir kısmını (kısmi aktarım, karar 106).
 *   quantity  : aktarılacak adet; 0 < adet ≤ serbest kalan (kapsamın geçerli yüklenmeyen adedi − vazgeçilmemiş
 *               aktarımlar). Verilmezse serbest kalanın tamamı (başka güne almada: alınan aktarımın adedi).
 *   replaceId : var olan etkin bir aktarımı BAŞKA GÜNE alır — eski kayıt kapanır (CANCELLED, MOVED), adedi serbest kalır
 *               ve yeni kayıt açılır; hiçbir kayıt silinmez.
 * Kapasite, yükleme onayı / düzeltmesiyle aynı kilit altında hesaplanır: eşzamanlı iki aktarımın toplamı kalanı aşamaz.
 * @param {any} db
 * @param {{ itemId: string, day: string, quantity?: number | string | null, replaceId?: string | null, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, replanId: string, quantity: number, free: number, moved: boolean } | { ok: false, code: 'FORBIDDEN' | 'BAD_DAY' | 'NOT_FUTURE' | 'NOT_FOUND' | 'NOT_ALLOWED' | 'BAD_QUANTITY' | 'NO_REMAINDER' | 'ORDER_CANCELLED' | 'ORDER_ON_HOLD' | 'DAY_CONFIRMED' | 'ALREADY_LOADED' | 'ALREADY_PLANNED' }>}
 */
export async function replanNotLoaded(db, { itemId, day, quantity = null, replaceId = null, actor, now = new Date() }) {
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
      // Yalnızca yüklenmeyen kalan aktarılır; yüklenen (LOADED) adet hiçbir zaman yeniden planlanmaz. Kalem, kapsamının
      // GEÇERLİ yüklenmeyen kalemi olmalı (düzeltmeyle yerini yenisi almış eski satırdan aktarım yapılmaz).
      if (item.status !== 'NOT_LOADED') return { ok: false, code: 'NOT_ALLOWED' };
      const key = itemKey(item);
      const scope = effectiveItems((await tx.loadingConfirmationItem.findMany({ where: { confirmationId: item.confirmationId, orderId: item.orderId } })).filter((x) => itemKey(x) === key));
      if (!scope.some((x) => x.id === item.id)) return { ok: false, code: 'NOT_ALLOWED' };
      const notLoaded = qty(scope, 'NOT_LOADED');
      if (item.order.status === 'IPTAL') return { ok: false, code: 'ORDER_CANCELLED' };
      if (item.order.onHold) return { ok: false, code: 'ORDER_ON_HOLD' };
      const shipDay = shipDayDate(day);
      if (await tx.loadingConfirmation.findUnique({ where: { shipDay }, select: { id: true } })) return { ok: false, code: 'DAY_CONFIRMED' };
      const replans = (await replansByScope(tx, item.confirmationId)).get(key) ?? [];
      const current = replaceId ? replans.find((r) => r.id === String(replaceId)) ?? null : null;
      if (replaceId && !current) return { ok: false, code: 'NOT_FOUND' };
      if (current?.status === 'CONFIRMED') return { ok: false, code: 'ALREADY_LOADED' };
      const others = replans.filter((r) => r.id !== current?.id);
      if (others.some((r) => dayOf(r.shipDay) === day) || (current && dayOf(current.shipDay) === day)) return { ok: false, code: 'ALREADY_PLANNED' };
      // Kapasite: geçerli yüklenmeyen adet − vazgeçilmemiş (etkin + onaylanmış) aktarımlar
      const free = notLoaded - others.reduce((n, r) => n + r.quantity, 0);
      if (!(free > 0)) return { ok: false, code: 'NO_REMAINDER' };
      const wanted = quantity == null || quantity === '' ? (current ? current.quantity : free) : Number(String(quantity).trim());
      if (!Number.isInteger(wanted) || wanted <= 0 || wanted > free) return { ok: false, code: 'BAD_QUANTITY' };
      if (current) await tx.loadingReplan.update({ where: { id: current.id }, data: { status: 'CANCELLED', activeKey: null, closedAt: now, closedReason: 'MOVED' } });
      const fromDay = dayOf(item.confirmation.shipDay);
      // m² aktarılan adetten, kalemin ölçüsüyle (onaydaki hesapla aynı)
      const m2 = snapshotOfItem(item, { quantity: wanted }).m2;
      const replan = await tx.loadingReplan.create({
        data: {
          sourceItemId: item.id, orderId: item.orderId, customerId: item.customerId, quantity: wanted, m2: m2.toFixed(2),
          reason: item.notLoadedReason ?? 'OTHER', fromDay: item.confirmation.shipDay, shipDay, activeKey: `${item.confirmationId}|${key}|${day}`, createdById: actor.id, createdAt: now,
        },
      });
      await writeHistory(tx, {
        orderId: item.orderId, event: 'REPLAN_NOT_LOADED', from: item.order.status, to: item.order.status, actorId: actor.id,
        note: `${wanted} · ${dmy(fromDay)} → ${dmy(day)}`,
      });
      await writeAudit(tx, {
        action: 'REPLAN_NOT_LOADED', entityType: 'Order', entityId: item.orderId, userId: actor.id,
        details: {
          orderNo: item.order.orderNo, customerId: item.customerId, replanId: replan.id, sourceConfirmationId: item.confirmation.id, sourceItemId: item.id,
          offerLineId: item.offerLineId, quantity: wanted, notLoaded, freeBefore: free, freeAfter: free - wanted, m2, reason: item.notLoadedReason, note: item.notLoadedNote,
          fromLoading: fromDay, previousLoading: current ? dayOf(current.shipDay) : null, toLoading: day, replaced: current?.id ?? null,
        },
      }, actor);
      return { ok: true, replanId: replan.id, quantity: wanted, free: free - wanted, moved: !!current };
    }, { timeout: 30_000 });
  } catch (e) {
    // Aynı kapsamdan aynı güne ikinci aktarım: veritabanı engeller (activeKey benzersiz)
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
    await tx.loadingReplan.update({ where: { id: r.id }, data: { status: 'CANCELLED', activeKey: null, closedAt: now, closedReason: 'ADMIN' } });
    await writeHistory(tx, { orderId: r.orderId, event: 'REPLAN_CANCELLED', from: r.order.status, to: r.order.status, actorId: actor.id, note: `${r.quantity} · ${dmy(dayOf(r.shipDay))}` });
    await writeAudit(tx, {
      action: 'REPLAN_CANCELLED', entityType: 'Order', entityId: r.orderId, userId: actor.id,
      details: { orderNo: r.order.orderNo, customerId: r.customerId, replanId: r.id, sourceItemId: r.sourceItemId, quantity: r.quantity, fromLoading: dayOf(r.fromDay), cancelledLoading: dayOf(r.shipDay) },
    }, actor);
    return { ok: true };
  }, { timeout: 30_000 });
}

/**
 * Bir kalanın denemeler zinciri (en eskiden yeniye), geçerli durumla: hangi yüklemede kaç adet yüklenmedi / yüklendi ve
 * hangi günlere aktarıldı. Kısmi aktarımda zincir dallanır: her onaylanmış aktarımın kapsamı ayrı bir adımdır.
 * @param {any} db  @param {string} itemId  zincirdeki herhangi bir kalem
 * @returns {Promise<{ day: string, loaded: number, notLoaded: number, reason: string | null, replannedTo: string[] }[]>}
 */
export async function replanChain(db, itemId) {
  let item = await db.loadingConfirmationItem.findUnique({ where: { id: itemId }, include: { replan: true } });
  // Köke git: aktarımın kaynağı
  for (let i = 0; item?.replan && i < 50; i++) item = await db.loadingConfirmationItem.findUnique({ where: { id: item.replan.sourceItemId }, include: { replan: true } });
  const out = [];
  const queue = item ? [item] : [];
  for (let i = 0; queue.length && i < 200; i++) {
    const it = queue.shift();
    const conf = await db.loadingConfirmation.findUnique({ where: { id: it.confirmationId }, select: { shipDay: true } });
    const key = itemKey(it);
    const scope = effectiveItems((await db.loadingConfirmationItem.findMany({ where: { confirmationId: it.confirmationId, orderId: it.orderId } })).filter((x) => itemKey(x) === key));
    const next = (await replansByScope(db, it.confirmationId)).get(key) ?? [];
    out.push({
      day: dayOf(conf.shipDay), loaded: qty(scope, 'LOADED'), notLoaded: qty(scope, 'NOT_LOADED'),
      reason: scope.find((x) => x.status === 'NOT_LOADED')?.notLoadedReason ?? null, replannedTo: next.map((r) => dayOf(r.shipDay)),
    });
    for (const r of next.filter((x) => x.status === 'CONFIRMED')) {
      const child = await db.loadingConfirmationItem.findFirst({ where: { replanId: r.id } });
      if (child) queue.push(child);
    }
  }
  return out;
}
