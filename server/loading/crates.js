// Sandıklar (yükleme sekmesi): satış ya da yönetici, bir yükleme günü + müşteri için sandıkları girer:
// sandık no, uzunluk / genişlik / yükseklik (mm), net ve brüt ağırlık (kg), not ve sandıktaki siparişler.
// Sandık no o gün içinde tektir (müşteriler arasında da). Girilen sandıklar o müşterinin o günkü tahminin önüne geçer.
//
// Fiziksel yerleşim ≠ ticari sahiplik (Aşama 7E, karar 103): bir sipariş, AYNI yükleme gününde başka bir müşterinin
// sandığında gidebilir (assignGuestCrate — yalnızca yönetici). Bu yalnızca CrateOrder satırıdır: siparişin müşterisi,
// teklifi, proforması, faturası, kuru ve sandık parası DEĞİŞMEZ; sandığın sahibi (ev sahibi müşteri) siparişe, sipariş
// sahibi de ev sahibinin ticari verisine erişim kazanmaz.
import { can } from '../auth/permissions.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { CRATE_MAX_KG, CRATE_TARE_KG, dayKey } from '../orders/loading.js';

export const MAX_CRATES = 60;
export const MAX_CRATE_NO = 999;
export const MAX_DIM_MM = 10_000;
export const MAX_KG = 20_000;

const clean = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => {
  const s = clean(v).replace(/\s/g, '').replace(',', '.');
  if (s === '') return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
};

/**
 * Formdan gelen sandık satırlarını doğrular. Tamamen boş satır atlanır.
 * @param {{ crateNo?: unknown, lengthMm?: unknown, widthMm?: unknown, heightMm?: unknown, netKg?: unknown, grossKg?: unknown, note?: unknown, orderIds?: unknown[] }[]} raw
 * @returns {{ ok: true, rows: CrateInput[] } | { ok: false, errors: { row: number, code: string }[] }}
 *   hata kodları: NO (sandık no 1–999 tam sayı), DUPLICATE_NO, DIM, WEIGHT, GROSS_LT_NET, NOTE, TOO_MANY
 * @typedef {{ crateNo: number, lengthMm: number | null, widthMm: number | null, heightMm: number | null, netKg: number | null, grossKg: number | null, note: string | null, orderIds: string[] }} CrateInput
 */
export function validateCrates(raw) {
  const rows = [];
  const errors = [];
  const seen = new Set();
  raw.forEach((r, i) => {
    const row = i + 1;
    const vals = ['crateNo', 'lengthMm', 'widthMm', 'heightMm', 'netKg', 'grossKg', 'note'].map((k) => clean(r[k]));
    if (vals.every((v) => v === '')) return;
    const no = num(r.crateNo);
    if (!Number.isInteger(no) || no < 1 || no > MAX_CRATE_NO) errors.push({ row, code: 'NO' });
    else if (seen.has(no)) errors.push({ row, code: 'DUPLICATE_NO' });
    else seen.add(no);
    const dims = [r.lengthMm, r.widthMm, r.heightMm].map(num);
    if (dims.some((d) => d != null && (!Number.isInteger(d) || d < 1 || d > MAX_DIM_MM))) errors.push({ row, code: 'DIM' });
    const net = num(r.netKg);
    const gross = num(r.grossKg);
    if ([net, gross].some((w) => w != null && (Number.isNaN(w) || w > MAX_KG))) errors.push({ row, code: 'WEIGHT' });
    else if (net != null && gross != null && gross < net) errors.push({ row, code: 'GROSS_LT_NET' });
    const note = clean(r.note);
    if (note.length > 200) errors.push({ row, code: 'NOTE' });
    rows.push({
      crateNo: no, lengthMm: dims[0], widthMm: dims[1], heightMm: dims[2],
      netKg: net == null ? null : Math.round(net * 100) / 100, grossKg: gross == null ? null : Math.round(gross * 100) / 100,
      note: note || null, orderIds: [...new Set((r.orderIds ?? []).map(clean).filter(Boolean))],
    });
  });
  if (rows.length > MAX_CRATES) errors.push({ row: MAX_CRATES + 1, code: 'TOO_MANY' });
  return errors.length ? { ok: false, errors } : { ok: true, rows };
}

/**
 * Bir müşterinin bir günlük yükü: siparişlerin yükleri + girilmiş sandıklar.
 * Sandık girildiyse net/brüt/sandık sayısı sandıklardan (net boşsa camın tahmini ağırlığı sandıklara eşit bölünür,
 * brüt boşsa net + dara); girilmediyse tahmin (cam ağırlığı CRATE_MAX_KG'ye bölünüp yukarı yuvarlanır).
 * @param {{ metraj: number, camAdet: number, cnc?: number, delik?: number, netKg: number }[]} loads  siparişlerin tahmini yükleri
 * @param {{ netAgirlik?: unknown, brutAgirlik?: unknown, daraKg?: unknown }[]} crates
 * @param {{ guestKg?: number }} [o]  guestKg: bu müşterinin sandıklarında giden BAŞKA müşteri camının ağırlığı (fiziksel yerleşim).
 *   Cam, sahibinin metrajında / adedinde sayılır; ağırlığı taşındığı sandığın müşterisine yazılır (sahibinin yük satırı netKg 0 ile gelir).
 */
export function groupLoad(loads, crates = [], { guestKg = 0 } = {}) {
  let metraj = 0, camAdet = 0, cnc = 0, delik = 0, glassKg = guestKg;
  for (const l of loads) {
    metraj = Math.round((metraj + l.metraj) * 100) / 100;
    camAdet += l.camAdet;
    cnc += l.cnc ?? 0;
    delik += l.delik ?? 0;
    glassKg += l.netKg;
  }
  const base = { orders: loads.length, metraj, camAdet, cnc, delik };
  if (crates.length > 0) {
    const share = glassKg / crates.length;
    const kg = (v) => (v == null || v === '' ? null : Number(v));
    let netKg = 0, grossKg = 0;
    for (const c of crates) {
      const net = kg(c.netAgirlik) ?? share;
      netKg += net;
      grossKg += kg(c.brutAgirlik) ?? net + (kg(c.daraKg) ?? CRATE_TARE_KG);
    }
    return { ...base, netKg: Math.round(netKg), grossKg: Math.round(grossKg), crates: crates.length, realCrates: true, estimatedCrates: 0, estimatedNetKg: 0 };
  }
  const n = glassKg > 0 ? Math.ceil(glassKg / CRATE_MAX_KG) : 0;
  return { ...base, netKg: glassKg, grossKg: glassKg + n * CRATE_TARE_KG, crates: n, realCrates: false, estimatedCrates: n, estimatedNetKg: glassKg };
}

/** "YYYY-MM-DD" → o günün veritabanı tarihi (@db.Date) */
export const dayDate = (day) => new Date(`${day}T00:00:00Z`);

/**
 * Müşterinin o gün yüklenecek siparişleri (iptal hariç): o güne planlı siparişler + yüklenmeyen kalanı o güne aktarılmış
 * siparişler (LoadingReplan — vazgeçilenler hariç).
 */
export async function dayOrders(tx, customerId, day) {
  const d = dayDate(day);
  const select = { id: true, orderNo: true, status: true, actualShipDate: true, estimatedShipDate: true };
  const [list, replanned] = await Promise.all([
    tx.order.findMany({
      where: {
        customerId, status: { not: 'IPTAL' },
        OR: [
          { actualShipDate: { gte: new Date(d.getTime() - 86_400_000), lt: new Date(d.getTime() + 2 * 86_400_000) } },
          { actualShipDate: null, estimatedShipDate: { gte: new Date(d.getTime() - 86_400_000), lt: new Date(d.getTime() + 2 * 86_400_000) } },
        ],
      },
      select,
    }),
    tx.order.findMany({ where: { customerId, status: { not: 'IPTAL' }, replans: { some: { shipDay: d, status: { not: 'CANCELLED' } } } }, select }),
  ]);
  const own = list.filter((o) => dayKey(o.actualShipDate ?? o.estimatedShipDate) === day);
  return [...own, ...replanned.filter((o) => !own.some((x) => x.id === o.id))];
}

/**
 * Bir müşterinin bir günlük sandıklarını kaydeder (hepsi birden; eksik satır silinir).
 * Sandık numarası o gün başka müşteride kullanılıyorsa kaydedilmez. Siparişler o müşterinin o günkü siparişleri olmalı.
 * Denetim kaydına önce/sonra, ilgili siparişlerin geçmişine "sandıklar güncellendi" yazılır.
 * @param {CrateInput[]} rows  validateCrates() sonucu
 * Sandıkta başka müşterinin siparişi varsa (fiziksel yerleşim) o bağ korunur; böyle bir sandık silinemez / numarası
 * değiştirilemez (HAS_GUESTS — önce yönetici yerleşimi kaldırır).
 * @returns {Promise<{ ok: true, count: number } | { ok: false, code: 'NO_ORDERS' | 'NUMBER_TAKEN' | 'BAD_ORDER' | 'HAS_GUESTS', numbers?: number[] }>}
 */
export async function saveDayCrates(db, { day, customerId, rows, actor }) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crates:${day}`}, 0))`;
    const orders = await dayOrders(tx, customerId, day);
    const stored = await tx.crate.findMany({
      where: { shipDay: dayDate(day), customerId }, include: { orders: { include: { order: { select: { customerId: true } } } } }, orderBy: { crateNo: 'asc' },
    });
    // Başka müşterinin siparişi (fiziksel yerleşim) bu formun konusu değildir: ayrı tutulur ve korunur
    const guests = new Map(stored.map((c) => [c.crateNo, c.orders.filter((x) => x.order.customerId !== customerId).map((x) => x.orderId)]).filter(([, ids]) => ids.length));
    const before = stored.map((c) => ({ ...c, orders: c.orders.filter((x) => x.order.customerId === customerId) }));
    if (orders.length === 0 && before.length === 0) return { ok: false, code: 'NO_ORDERS' };
    const valid = new Set(orders.map((o) => o.id));
    if (rows.some((r) => r.orderIds.some((id) => !valid.has(id)))) return { ok: false, code: 'BAD_ORDER' };
    const kept = new Set(rows.map((r) => r.crateNo));
    const orphaned = [...guests.keys()].filter((no) => !kept.has(no));
    if (orphaned.length) return { ok: false, code: 'HAS_GUESTS', numbers: orphaned };
    const others = await tx.crate.findMany({ where: { shipDay: dayDate(day), NOT: { customerId } }, select: { crateNo: true } });
    const taken = new Set(others.map((c) => c.crateNo));
    const clash = rows.map((r) => r.crateNo).filter((n) => taken.has(n));
    if (clash.length) return { ok: false, code: 'NUMBER_TAKEN', numbers: clash };

    await tx.crate.deleteMany({ where: { shipDay: dayDate(day), customerId } });
    for (const r of rows) {
      // Tek siparişli günde sandık o siparişindir
      const orderIds = r.orderIds.length ? r.orderIds : orders.length === 1 ? [orders[0].id] : [];
      await tx.crate.create({
        data: {
          shipDay: dayDate(day), customerId, crateNo: r.crateNo, lengthMm: r.lengthMm, widthMm: r.widthMm, heightMm: r.heightMm,
          netAgirlik: r.netKg, brutAgirlik: r.grossKg, note: r.note, updatedById: actor.id,
          orders: { create: [...orderIds, ...(guests.get(r.crateNo) ?? [])].map((orderId) => ({ orderId })) },
        },
      });
    }
    const brief = (c) => ({
      no: c.crateNo, l: c.lengthMm ?? null, w: c.widthMm ?? null, h: c.heightMm ?? null,
      net: c.netAgirlik != null ? Number(c.netAgirlik) : c.netKg ?? null, gross: c.brutAgirlik != null ? Number(c.brutAgirlik) : c.grossKg ?? null,
      orders: c.orders ? c.orders.map((o) => o.orderId) : c.orderIds,
    });
    await writeAudit(tx, {
      action: 'CRATES_SAVE', entityType: 'Customer', entityId: customerId, userId: actor.id,
      details: { day, before: before.map(brief), after: rows.map(brief) },
    }, actor);
    for (const o of orders) {
      await writeHistory(tx, { orderId: o.id, event: 'CRATES', from: o.status, to: o.status, actorId: actor.id, note: String(rows.length) });
    }
    return { ok: true, count: rows.length };
  });
}

/**
 * Siparişin yükleme günü değişince (tahmini tarih güncellendi ya da "yüklendi" işaretlendi) sandıkları da yeni güne taşınır:
 *  - yalnızca bu siparişi taşıyan sandık siparişle birlikte taşınır;
 *  - siparişi belirtilmemiş sandık, müşterinin eski günde başka siparişi kalmadıysa taşınır;
 *  - başka siparişleri de taşıyan sandık eski günde kalır, bu siparişle bağı kaldırılır.
 * Yeni günde numara doluysa ilk boş numaraya kayar. İş akışı işleminin içinde (aynı tx) çağrılır; sipariş zaten güncellenmiştir.
 *  - sipariş eski günde başka müşterinin sandığındaysa (fiziksel yerleşim) o bağ kaldırılır: sandık ev sahibiyle kalır.
 * @returns {Promise<{ moved: { from: number, to: number }[], unlinked: number[], guestUnlinked?: number[] }>}
 */
export async function moveOrderCrates(tx, { orderId, customerId, fromDay, toDay, actor }) {
  const none = { moved: [], unlinked: [] };
  if (!fromDay || !toDay || fromDay === toDay) return none;
  const hosted = await tx.crateOrder.findMany({ where: { orderId, crate: { shipDay: dayDate(fromDay), NOT: { customerId } } }, include: { crate: { select: { id: true, crateNo: true, customerId: true } } } });
  const crates = await tx.crate.findMany({ where: { shipDay: dayDate(fromDay), customerId }, include: { orders: true }, orderBy: { crateNo: 'asc' } });
  if (crates.length === 0 && hosted.length === 0) return none;
  for (const d of [fromDay, toDay].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crates:${d}`}, 0))`;
  for (const h of hosted) await tx.crateOrder.delete({ where: { crateId_orderId: { crateId: h.crateId, orderId } } });
  if (hosted.length) {
    await writeAudit(tx, {
      action: 'CROSS_CUSTOMER_CRATE_REMOVED', entityType: 'Order', entityId: orderId, userId: actor.id,
      details: { reason: 'SHIP_DAY_CHANGED', day: fromDay, toDay, ownerCustomerId: customerId, crates: hosted.map((h) => ({ crateId: h.crate.id, crateNo: h.crate.crateNo, hostCustomerId: h.crate.customerId })) },
    }, actor);
  }
  if (crates.length === 0) return { ...none, guestUnlinked: hosted.map((h) => h.crate.crateNo) };
  const remaining = (await dayOrders(tx, customerId, fromDay)).filter((o) => o.id !== orderId);
  const toMove = [];
  const unlink = [];
  for (const c of crates) {
    const ids = c.orders.map((x) => x.orderId);
    if (ids.includes(orderId)) (ids.every((id) => id === orderId) ? toMove : unlink).push(c);
    else if (ids.length === 0 && remaining.length === 0) toMove.push(c);
  }
  const used = new Set((await tx.crate.findMany({ where: { shipDay: dayDate(toDay) }, select: { crateNo: true } })).map((c) => c.crateNo));
  const moved = [];
  for (const c of toMove) {
    let no = c.crateNo;
    while (used.has(no)) no++;
    used.add(no);
    await tx.crate.update({ where: { id: c.id }, data: { shipDay: dayDate(toDay), crateNo: no, updatedById: actor.id } });
    moved.push({ from: c.crateNo, to: no });
  }
  for (const c of unlink) await tx.crateOrder.delete({ where: { crateId_orderId: { crateId: c.id, orderId } } });
  const result = { moved, unlinked: unlink.map((c) => c.crateNo), ...(hosted.length ? { guestUnlinked: hosted.map((h) => h.crate.crateNo) } : {}) };
  if (moved.length || unlink.length) {
    await writeAudit(tx, {
      action: 'CRATES_MOVE', entityType: 'Order', entityId: orderId, userId: actor.id,
      details: { from: fromDay, to: toDay, ...result },
    }, actor);
  }
  return result;
}

/** Siparişin o günkü yüklemesi var mı: sipariş o güne planlı ya da yüklenmeyen kalanı o güne aktarılmış */
async function orderLoadsOn(tx, order, day) {
  if (dayKey(order.actualShipDate ?? order.estimatedShipDate) === day) return true;
  return (await tx.loadingReplan.count({ where: { orderId: order.id, shipDay: dayDate(day), status: { not: 'CANCELLED' } } })) > 0;
}

/**
 * Fiziksel yerleşim: siparişi AYNI yükleme gününde başka bir müşterinin sandığına koyar (yalnızca yönetici).
 * Yalnızca CrateOrder satırı yazılır; siparişin müşterisi, teklifi, belgeleri ve sandık parası değişmez.
 *   NOT_SAME_LOADING — sandık o günün sandığı değil ya da siparişin o gün yüklemesi yok (geçmiş / gelecek sandık seçilemez)
 *   OWN_CRATE        — sandık siparişin kendi müşterisinin (o, sandık formundan seçilir)
 * @param {any} db
 * @param {{ day: string, orderId: string, crateId: string, actor: { id: string, role: string, ip?: string | null } }} p
 * @returns {Promise<{ ok: true, crateNo: number } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'ORDER_CANCELLED' | 'NOT_SAME_LOADING' | 'OWN_CRATE' | 'ALREADY_ASSIGNED' }>}
 */
export async function assignGuestCrate(db, { day, orderId, crateId, actor }) {
  if (!can(actor?.role, 'LOADING_CONFIRM')) return { ok: false, code: 'FORBIDDEN' };
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crates:${day}`}, 0))`;
      const [order, crate] = await Promise.all([
        tx.order.findUnique({ where: { id: String(orderId ?? '') }, select: { id: true, orderNo: true, customerId: true, status: true, orderTypeCode: true, actualShipDate: true, estimatedShipDate: true } }),
        tx.crate.findUnique({ where: { id: String(crateId ?? '') }, select: { id: true, crateNo: true, customerId: true, shipDay: true } }),
      ]);
      if (!order || order.orderTypeCode !== 'GLASS_ORDER' || !crate || !crate.customerId || !crate.shipDay) return { ok: false, code: 'NOT_FOUND' };
      if (order.status === 'IPTAL') return { ok: false, code: 'ORDER_CANCELLED' };
      // Aynı yükleme: sandık o günün sandığı VE siparişin o gün yüklemesi var
      if (crate.shipDay.toISOString().slice(0, 10) !== day || !(await orderLoadsOn(tx, order, day))) return { ok: false, code: 'NOT_SAME_LOADING' };
      if (crate.customerId === order.customerId) return { ok: false, code: 'OWN_CRATE' };
      if (await tx.crateOrder.findUnique({ where: { crateId_orderId: { crateId: crate.id, orderId: order.id } } })) return { ok: false, code: 'ALREADY_ASSIGNED' };
      await tx.crateOrder.create({ data: { crateId: crate.id, orderId: order.id } });
      await writeHistory(tx, { orderId: order.id, event: 'GUEST_CRATE', from: order.status, to: order.status, actorId: actor.id, note: `#${crate.crateNo} · ${day.split('-').reverse().join('.')}` });
      await writeAudit(tx, {
        action: 'CROSS_CUSTOMER_CRATE_ASSIGNED', entityType: 'Order', entityId: order.id, userId: actor.id,
        details: { orderNo: order.orderNo, ownerCustomerId: order.customerId, crateId: crate.id, crateNo: crate.crateNo, hostCustomerId: crate.customerId, day },
      }, actor);
      return { ok: true, crateNo: crate.crateNo };
    });
  } catch (e) {
    if (e?.code === 'P2002') return { ok: false, code: 'ALREADY_ASSIGNED' };
    throw e;
  }
}

/**
 * Fiziksel yerleşimi kaldırır (yalnızca yönetici): sipariş başka müşterinin sandığından çıkarılır. Ticari hiçbir şey değişmez.
 * @param {any} db
 * @param {{ orderId: string, crateId: string, actor: { id: string, role: string, ip?: string | null } }} p
 * @returns {Promise<{ ok: true } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' }>}
 */
export async function removeGuestCrate(db, { orderId, crateId, actor }) {
  if (!can(actor?.role, 'LOADING_CONFIRM')) return { ok: false, code: 'FORBIDDEN' };
  return db.$transaction(async (tx) => {
    const link = await tx.crateOrder.findUnique({
      where: { crateId_orderId: { crateId: String(crateId ?? ''), orderId: String(orderId ?? '') } },
      include: { crate: { select: { crateNo: true, customerId: true, shipDay: true } }, order: { select: { orderNo: true, customerId: true, status: true } } },
    });
    // Yalnızca başka müşterinin sandığındaki yerleşim (kendi sandığı sandık formundan yönetilir)
    if (!link || link.crate.customerId === link.order.customerId) return { ok: false, code: 'NOT_FOUND' };
    const day = link.crate.shipDay ? link.crate.shipDay.toISOString().slice(0, 10) : null;
    await tx.crateOrder.delete({ where: { crateId_orderId: { crateId: link.crateId, orderId: link.orderId } } });
    await writeHistory(tx, { orderId: link.orderId, event: 'GUEST_CRATE_REMOVED', from: link.order.status, to: link.order.status, actorId: actor.id, note: `#${link.crate.crateNo}` });
    await writeAudit(tx, {
      action: 'CROSS_CUSTOMER_CRATE_REMOVED', entityType: 'Order', entityId: link.orderId, userId: actor.id,
      details: { orderNo: link.order.orderNo, ownerCustomerId: link.order.customerId, crateId: link.crateId, crateNo: link.crate.crateNo, hostCustomerId: link.crate.customerId, day },
    }, actor);
    return { ok: true };
  });
}

/**
 * Sandığın taşıdığı siparişlerin, GÖRENE göre süzgeci (güvenlik denetimi SEC-17, karar 120). Sandık fiziksel olarak başka
 * müşterinin siparişini de taşıyabilir (karar 103); müşteri kendi sandığının satırında yalnızca KENDİ siparişlerini
 * görür — misafir siparişin kimliği müşteriye giden veride hiç bulunmaz. İç ekip bütün siparişleri görür (boş süzgeç).
 * Kullanım: `include: { orders: { where: crateOrdersWhere(user), select: { orderId: true } } }`.
 * @param {{ appRole: string, customerId?: string | null }} viewer
 * @returns {{ order?: { customerId: string } }}
 */
export function crateOrdersWhere(viewer) {
  return viewer.appRole === 'MUSTERI' ? { order: { customerId: viewer.customerId ?? '__none__' } } : {};
}
