// Sandıklar (yükleme sekmesi): satış ya da yönetici, bir yükleme günü + müşteri için sandıkları girer:
// sandık no, uzunluk / genişlik / yükseklik (mm), net ve brüt ağırlık (kg), not ve sandıktaki siparişler.
// Sandık no o gün içinde tektir (müşteriler arasında da). Girilen sandıklar o müşterinin o günkü tahminin önüne geçer.
//
// Fiziksel yerleşim ≠ ticari sahiplik (Aşama 7E, karar 103): bir sipariş, AYNI yükleme gününde başka bir müşterinin
// sandığında gidebilir. Bu yalnızca CrateOrder satırıdır: siparişin müşterisi, teklifi, proforması, faturası, kuru ve
// sandık parası DEĞİŞMEZ; sandığın sahibi (ev sahibi müşteri) siparişe, sipariş sahibi de ev sahibinin ticari verisine
// erişim kazanmaz.
//
// "Özel durum" iki adımdır (karar 124):
//   1. YÖNETİCİ ev sahibi FİRMAYI seçer (setGuestHost → Order.guestHostId). Sipariş / sandık seçmez; o firmanın sandığı
//      henüz girilmemiş olabilir. Yalnızca siparişin yüklendiği günde yüklemesi olan başka bir müşteri firması seçilebilir.
//   2. SATIŞ (ya da yönetici) o firmanın, o günün sandıklarından birini seçer (assignGuestCrate — CRATE_EDIT). Firmayı
//      seçemez / değiştiremez: sandık yalnızca yöneticinin seçtiği firmanınsa kabul edilir. Sandık seçilene kadar
//      yerleşim "sandık seçimi bekliyor" durumundadır; hiçbir sandık kendiliğinden atanmaz.
//   Sandık seçilince / değişince / kalkınca her iki firmanın müşteri kullanıcılarına bildirim olayı yazılır
//   (GUEST_CRATE_ASSIGNED / GUEST_CRATE_REMOVED → server/notifications/inapp.js).
import { can } from '../auth/permissions.js';
import { enqueueOutbox, writeAudit, writeHistory } from '../orders/journal.js';
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
  const select = { id: true, orderNo: true, status: true, actualShipDate: true, estimatedShipDate: true, guestHostId: true };
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
 * Firmanın o günkü MİSAFİR siparişleri — başka firmanın sandığıyla gidenler (Paket 7, karar 188; ekrandaki kuralla aynı:
 * server/loading/day-firms.js). Misafir sipariş bu firmanın sandığına konamaz:
 *   - o gün başka firmanın sandığına konmuş (CrateOrder), ya da
 *   - yönetici ev sahibi firmayı seçmiş (Order.guestHostId): kendi gününde her zaman; yalnızca yüklenmeyen kalanı o güne
 *     aktarılmış siparişte ev sahibinin o gün yüklemesi (siparişi ya da sandığı) varsa — yoksa kalan kendi firmasıyla gider.
 * @param {any} tx  @param {string} customerId  @param {string} day
 * @param {{ id: string, guestHostId?: string | null, actualShipDate?: Date | null, estimatedShipDate?: Date | null }[]} orders  dayOrders sonucu
 * @returns {Promise<Set<string>>}
 */
export async function guestOrdersOn(tx, customerId, day, orders) {
  if (orders.length === 0) return new Set();
  const linked = await tx.crateOrder.findMany({
    where: { orderId: { in: orders.map((o) => o.id) }, crate: { shipDay: dayDate(day), customerId: { not: null }, NOT: { customerId } } },
    select: { orderId: true },
  });
  const out = new Set(linked.map((l) => l.orderId));
  const onOwnDay = (o) => {
    const d = o.actualShipDate ?? o.estimatedShipDate;
    return !!d && dayKey(d) === day;
  };
  const carried = orders.filter((o) => o.guestHostId && !out.has(o.id) && !onOwnDay(o));
  let present = new Set();
  if (carried.length) {
    const [firms, crates] = await Promise.all([
      firmsLoadingOn(tx, [day], customerId),
      tx.crate.findMany({ where: { shipDay: dayDate(day), customerId: { not: null } }, select: { customerId: true } }),
    ]);
    present = new Set([...firms.map((f) => f.id), ...crates.map((c) => c.customerId)]);
  }
  for (const o of orders) if (o.guestHostId && !out.has(o.id) && (onOwnDay(o) || present.has(o.guestHostId))) out.add(o.id);
  return out;
}

/**
 * Bir müşterinin bir günlük sandıklarını kaydeder (hepsi birden; eksik satır silinir).
 * Sandık numarası o gün başka müşteride kullanılıyorsa kaydedilmez. Siparişler o müşterinin o günkü siparişleri olmalı.
 * Denetim kaydına önce/sonra, ilgili siparişlerin geçmişine "sandıklar güncellendi" yazılır.
 * @param {CrateInput[]} rows  validateCrates() sonucu
 * Sandıkta başka müşterinin siparişi varsa (fiziksel yerleşim) o bağ korunur; böyle bir sandık silinemez / numarası
 * değiştirilemez (HAS_GUESTS — önce yönetici yerleşimi kaldırır).
 * Misafir sipariş (Paket 7 — başka firmanın sandığıyla giden; guestOrdersOn) bu firmanın sandığına konamaz (GUEST_ORDER);
 * firmanın o gün misafir olmayan siparişi yoksa yeni sandık açılamaz (GUEST_ONLY) — var olan sandıklar düzeltilebilir / silinebilir.
 * Kural ekranda da uygulanır ("+ Sandık ekle" kapalı) ama esas olan bu denetimdir.
 * @returns {Promise<{ ok: true, count: number } | { ok: false, code: 'NO_ORDERS' | 'NUMBER_TAKEN' | 'BAD_ORDER' | 'HAS_GUESTS' | 'GUEST_ORDER' | 'GUEST_ONLY', numbers?: number[] }>}
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
    // Misafir sipariş ev sahibinin sandığıyla gider: kendi firmasının sandığına konamaz; yalnızca misafir siparişi olan firmaya
    // yeni sandık açılamaz (önceden girilmiş sandık numaraları düzeltilebilir ya da silinebilir)
    const guestIds = await guestOrdersOn(tx, customerId, day, orders);
    if (rows.some((r) => r.orderIds.some((id) => guestIds.has(id)))) return { ok: false, code: 'GUEST_ORDER' };
    const ownOrders = orders.filter((o) => !guestIds.has(o.id));
    if (orders.length > 0 && ownOrders.length === 0 && rows.some((r) => !before.some((b) => b.crateNo === r.crateNo))) return { ok: false, code: 'GUEST_ONLY' };
    const kept = new Set(rows.map((r) => r.crateNo));
    const orphaned = [...guests.keys()].filter((no) => !kept.has(no));
    if (orphaned.length) return { ok: false, code: 'HAS_GUESTS', numbers: orphaned };
    const others = await tx.crate.findMany({ where: { shipDay: dayDate(day), NOT: { customerId } }, select: { crateNo: true } });
    const taken = new Set(others.map((c) => c.crateNo));
    const clash = rows.map((r) => r.crateNo).filter((n) => taken.has(n));
    if (clash.length) return { ok: false, code: 'NUMBER_TAKEN', numbers: clash };

    await tx.crate.deleteMany({ where: { shipDay: dayDate(day), customerId } });
    for (const r of rows) {
      // Tek siparişli günde sandık o siparişindir (sipariş misafir değilse)
      const orderIds = r.orderIds.length ? r.orderIds : orders.length === 1 && ownOrders.length === 1 ? [ownOrders[0].id] : [];
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
  // Özel durum (karar 124): ev sahibi firmanın yeni günde yüklemesi yoksa ilişki geçersizdir → kaldırılır (denetim kaydıyla).
  // Yüklemesi varsa ilişki durur; eski günün sandık seçimi aşağıda kalkar ve yeni günde yeniden "sandık seçimi bekliyor" olur.
  const guest = await tx.order.findUnique({ where: { id: orderId }, select: { guestHostId: true, orderNo: true, status: true } });
  if (guest?.guestHostId) {
    const days = await loadingDays(tx, orderId, toDay);
    if (!(await firmsLoadingOn(tx, days, customerId)).some((f) => f.id === guest.guestHostId)) {
      await tx.order.update({ where: { id: orderId }, data: { guestHostId: null } });
      await writeHistory(tx, { orderId, event: 'GUEST_HOST_REMOVED', from: guest.status, to: guest.status, actorId: actor.id, note: dmy(toDay) });
      await writeAudit(tx, {
        action: 'CROSS_CUSTOMER_HOST_REMOVED', entityType: 'Order', entityId: orderId, userId: actor.id,
        details: { reason: 'SHIP_DAY_CHANGED', orderNo: guest.orderNo, ownerCustomerId: customerId, previousHostCustomerId: guest.guestHostId, day: fromDay, toDay },
      }, actor);
    }
  }
  if (crates.length === 0 && hosted.length === 0) return none;
  for (const d of [fromDay, toDay].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crates:${d}`}, 0))`;
  for (const h of hosted) {
    await tx.crateOrder.delete({ where: { crateId_orderId: { crateId: h.crateId, orderId } } });
    // Sandık seçimi iptal oldu: iki firmaya da bildirilir (yeni günde sandık yeniden seçilir)
    await enqueueOutbox(tx, { type: GUEST_REMOVED, orderId, payload: { hostId: h.crate.customerId, crateNo: h.crate.crateNo, day: fromDay, actorId: actor.id } });
  }
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
  const own = order.actualShipDate ?? order.estimatedShipDate;
  if (own && dayKey(own) === day) return true;
  return (await tx.loadingReplan.count({ where: { orderId: order.id, shipDay: dayDate(day), status: { not: 'CANCELLED' } } })) > 0;
}

export const GUEST_ASSIGNED = 'GUEST_CRATE_ASSIGNED';
export const GUEST_REMOVED = 'GUEST_CRATE_REMOVED';
const dmy = (day) => day.split('-').reverse().join('.');
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Siparişin yüklendiği günler: kendi yükleme günü + yüklenmeyen kalanının aktarıldığı (vazgeçilmemiş) günler.
 * @param {any} tx  @param {string} orderId  @param {string | null} ownDay  siparişin kendi günü ("YYYY-AA-GG")
 * @returns {Promise<string[]>}
 */
async function loadingDays(tx, orderId, ownDay) {
  const replans = await tx.loadingReplan.findMany({ where: { orderId, status: { not: 'CANCELLED' } }, select: { shipDay: true } });
  return [...new Set([ownDay, ...replans.map((r) => isoDay(r.shipDay))].filter(Boolean))].sort();
}

/**
 * Verilen günlerde yüklemesi olan MÜŞTERİ firmaları (cam siparişi; iptal / silinmiş / beklemedeki hariç): o güne planlı ya
 * da yüklenmeyen kalanı o güne aktarılmış siparişi olan firmalar. Her firma bir kez; ada göre sıralı.
 * @param {any} tx  @param {string[]} days  @param {string} exceptCustomerId  siparişin kendi firması listede olmaz
 * @returns {Promise<{ id: string, name: string }[]>}
 */
export async function firmsLoadingOn(tx, days, exceptCustomerId) {
  const out = new Map();
  for (const day of days) {
    const d = dayDate(day);
    const window = { gte: new Date(d.getTime() - 86_400_000), lt: new Date(d.getTime() + 2 * 86_400_000) };
    const active = { shipDay: d, status: { not: 'CANCELLED' } };
    const rows = await tx.order.findMany({
      where: {
        orderTypeCode: 'GLASS_ORDER', status: { not: 'IPTAL' }, onHold: false, customerId: { not: exceptCustomerId }, customer: { type: 'CUSTOMER' },
        OR: [{ actualShipDate: window }, { actualShipDate: null, estimatedShipDate: window }, { replans: { some: active } }],
      },
      select: { actualShipDate: true, estimatedShipDate: true, customer: { select: { id: true, name: true } }, replans: { where: active, select: { id: true } } },
    });
    for (const o of rows) {
      const own = o.actualShipDate ?? o.estimatedShipDate;
      if ((own && dayKey(own) === day) || o.replans.length) out.set(o.customer.id, o.customer);
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Sipariş sayfasındaki "Özel durum" seçimi (yönetici): siparişin yüklendiği gün(ler) ve o gün(ler)de yüklemesi olan
 * BAŞKA firmalar. Sipariş / sandık listesi dönmez — yönetici yalnızca firma seçer.
 * @param {any} db
 * @param {{ id: string, customerId: string, actualShipDate?: Date | null, estimatedShipDate?: Date | null }} order
 * @returns {Promise<{ days: string[], hosts: { id: string, name: string }[] }>}
 */
export async function guestHostOptions(db, order) {
  const own = order.actualShipDate ?? order.estimatedShipDate;
  const days = await loadingDays(db, order.id, own ? dayKey(own) : null);
  return { days, hosts: await firmsLoadingOn(db, days, order.customerId) };
}

/** Siparişin başka firmaların sandıklarındaki bütün yerleşimlerini kaldırır (geçmiş, denetim ve bildirim olayıyla). İşlem içinde. */
async function dropGuestLinks(tx, order, actor, reason) {
  const links = await tx.crateOrder.findMany({
    where: { orderId: order.id, crate: { customerId: { not: null }, NOT: { customerId: order.customerId } } },
    include: { crate: { select: { id: true, crateNo: true, customerId: true, shipDay: true } } },
  });
  for (const l of links) {
    const day = l.crate.shipDay ? isoDay(l.crate.shipDay) : null;
    await tx.crateOrder.delete({ where: { crateId_orderId: { crateId: l.crateId, orderId: order.id } } });
    await writeHistory(tx, { orderId: order.id, event: 'GUEST_CRATE_REMOVED', from: order.status, to: order.status, actorId: actor.id, note: `#${l.crate.crateNo}` });
    await writeAudit(tx, {
      action: 'CROSS_CUSTOMER_CRATE_REMOVED', entityType: 'Order', entityId: order.id, userId: actor.id,
      details: { reason, orderNo: order.orderNo, ownerCustomerId: order.customerId, crateId: l.crate.id, crateNo: l.crate.crateNo, hostCustomerId: l.crate.customerId, day },
    }, actor);
    if (day) await enqueueOutbox(tx, { type: GUEST_REMOVED, orderId: order.id, payload: { hostId: l.crate.customerId, crateNo: l.crate.crateNo, day, actorId: actor.id } });
  }
  return links.map((l) => l.crate.crateNo);
}

/**
 * Özel durum — ev sahibi firmayı seçer / değiştirir / kaldırır (YALNIZCA yönetici — LOADING_CONFIRM). Sandık gerekmez.
 *   hostId boş → ilişki kaldırılır. Firma değişince / kalkınca siparişin başka firma sandığındaki yerleşimi de kalkar.
 *   NO_LOADING_DAY   — siparişin yükleme günü yok
 *   OWN_FIRM         — seçilen firma siparişin kendi firması
 *   NOT_SAME_LOADING — seçilen firmanın, siparişin yüklendiği günde yüklemesi yok (ya da müşteri firması değil)
 * Ticari hiçbir şey değişmez: yalnızca Order.guestHostId (ve varsa CrateOrder) yazılır.
 * @param {any} db
 * @param {{ orderId: string, hostId: string | null, actor: { id: string, role: string, ip?: string | null } }} p
 * @returns {Promise<{ ok: true, changed: boolean, hostId: string | null } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'ORDER_CANCELLED' | 'NO_LOADING_DAY' | 'OWN_FIRM' | 'NOT_SAME_LOADING' }>}
 */
export async function setGuestHost(db, { orderId, hostId, actor }) {
  if (!can(actor?.role, 'LOADING_CONFIRM')) return { ok: false, code: 'FORBIDDEN' };
  const host = hostId ? String(hostId) : null;
  return db.$transaction(async (tx) => {
    const select = { id: true, orderNo: true, customerId: true, status: true, orderTypeCode: true, removedAt: true, guestHostId: true, actualShipDate: true, estimatedShipDate: true };
    const found = await tx.order.findUnique({ where: { id: String(orderId ?? '') }, select });
    if (!found || found.orderTypeCode !== 'GLASS_ORDER' || found.removedAt) return { ok: false, code: 'NOT_FOUND' };
    const own = found.actualShipDate ?? found.estimatedShipDate;
    const days = await loadingDays(tx, found.id, own ? dayKey(own) : null);
    // Sandık seçimiyle aynı kilit: firma değişirken o günün sandığı seçilemez
    for (const d of days) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crates:${d}`}, 0))`;
    const order = await tx.order.findUnique({ where: { id: found.id }, select });
    if (order.status === 'IPTAL') return { ok: false, code: 'ORDER_CANCELLED' };
    if (host) {
      if (days.length === 0) return { ok: false, code: 'NO_LOADING_DAY' };
      if (host === order.customerId) return { ok: false, code: 'OWN_FIRM' };
      if (!(await firmsLoadingOn(tx, days, order.customerId)).some((f) => f.id === host)) return { ok: false, code: 'NOT_SAME_LOADING' };
    }
    if ((order.guestHostId ?? null) === host) return { ok: true, changed: false, hostId: host };
    const removedCrates = await dropGuestLinks(tx, order, actor, host ? 'HOST_CHANGED' : 'HOST_REMOVED');
    // Misafir sipariş kendi firmasının sandığında duramaz (Paket 7, karar 188): ev sahibi seçilince siparişin kendi firmasının o
    // gün(ler)deki sandıklarıyla bağı kaldırılır (sandığın kendisi ve diğer siparişleri durur). Aksi hâlde cam iki firmanın
    // sandık ağırlığında sayılabilirdi.
    let ownCratesUnlinked = [];
    if (host && days.length) {
      const own = await tx.crateOrder.findMany({
        where: { orderId: order.id, crate: { customerId: order.customerId, shipDay: { in: days.map(dayDate) } } },
        include: { crate: { select: { crateNo: true, shipDay: true } } },
      });
      for (const l of own) await tx.crateOrder.delete({ where: { crateId_orderId: { crateId: l.crateId, orderId: order.id } } });
      ownCratesUnlinked = own.map((l) => ({ crateNo: l.crate.crateNo, day: l.crate.shipDay ? isoDay(l.crate.shipDay) : null }));
    }
    await tx.order.update({ where: { id: order.id }, data: { guestHostId: host } });
    await writeHistory(tx, { orderId: order.id, event: host ? 'GUEST_HOST' : 'GUEST_HOST_REMOVED', from: order.status, to: order.status, actorId: actor.id, note: days.map(dmy).join(', ') || null });
    await writeAudit(tx, {
      action: host ? 'CROSS_CUSTOMER_HOST_SET' : 'CROSS_CUSTOMER_HOST_REMOVED', entityType: 'Order', entityId: order.id, userId: actor.id,
      details: { orderNo: order.orderNo, ownerCustomerId: order.customerId, hostCustomerId: host, previousHostCustomerId: order.guestHostId ?? null, days, removedCrates, ...(ownCratesUnlinked.length ? { ownCratesUnlinked } : {}) },
    }, actor);
    return { ok: true, changed: true, hostId: host };
  });
}

/**
 * Fiziksel yerleşim — SANDIK seçimi: siparişi, yöneticinin seçtiği ev sahibi firmanın AYNI yükleme günündeki bir sandığına
 * koyar (satış ya da yönetici — CRATE_EDIT). Firma burada seçilmez / değişmez: sandık yalnızca Order.guestHostId'nin
 * sandığıysa kabul edilir. Sipariş o gün en çok bir misafir sandıkta durur: başka sandık seçilirse öncekinin yerini alır.
 * Yalnızca CrateOrder satırı yazılır; siparişin müşterisi, teklifi, belgeleri ve sandık parası değişmez.
 *   NOT_SAME_LOADING — sandık o günün sandığı değil ya da siparişin o gün yüklemesi yok (geçmiş / gelecek sandık seçilemez)
 *   OWN_CRATE        — sandık siparişin kendi müşterisinin (o, sandık formundan seçilir)
 *   NO_HOST          — yönetici bu sipariş için ev sahibi firma seçmemiş
 *   NOT_HOST_CRATE   — sandık, yöneticinin seçtiği firmanın sandığı değil
 * @param {any} db
 * @param {{ day: string, orderId: string, crateId: string, actor: { id: string, role: string, ip?: string | null } }} p
 * @returns {Promise<{ ok: true, crateNo: number } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'ORDER_CANCELLED' | 'NOT_SAME_LOADING' | 'OWN_CRATE' | 'NO_HOST' | 'NOT_HOST_CRATE' | 'ALREADY_ASSIGNED' }>}
 */
export async function assignGuestCrate(db, { day, orderId, crateId, actor }) {
  if (!can(actor?.role, 'CRATE_EDIT')) return { ok: false, code: 'FORBIDDEN' };
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crates:${day}`}, 0))`;
      const [order, crate] = await Promise.all([
        tx.order.findUnique({ where: { id: String(orderId ?? '') }, select: { id: true, orderNo: true, customerId: true, status: true, orderTypeCode: true, guestHostId: true, actualShipDate: true, estimatedShipDate: true } }),
        tx.crate.findUnique({ where: { id: String(crateId ?? '') }, select: { id: true, crateNo: true, customerId: true, shipDay: true } }),
      ]);
      if (!order || order.orderTypeCode !== 'GLASS_ORDER' || !crate || !crate.customerId || !crate.shipDay) return { ok: false, code: 'NOT_FOUND' };
      if (order.status === 'IPTAL') return { ok: false, code: 'ORDER_CANCELLED' };
      // Aynı yükleme: sandık o günün sandığı VE siparişin o gün yüklemesi var
      if (isoDay(crate.shipDay) !== day || !(await orderLoadsOn(tx, order, day))) return { ok: false, code: 'NOT_SAME_LOADING' };
      if (crate.customerId === order.customerId) return { ok: false, code: 'OWN_CRATE' };
      // Firma kararı yöneticinindir: seçilmemişse ya da sandık başka firmanınsa kabul edilmez (sahte istek dahil)
      if (!order.guestHostId) return { ok: false, code: 'NO_HOST' };
      if (crate.customerId !== order.guestHostId) return { ok: false, code: 'NOT_HOST_CRATE' };
      const previous = await tx.crateOrder.findMany({
        where: { orderId: order.id, crate: { shipDay: dayDate(day), NOT: { customerId: order.customerId } } }, include: { crate: { select: { crateNo: true } } },
      });
      if (previous.some((x) => x.crateId === crate.id)) return { ok: false, code: 'ALREADY_ASSIGNED' };
      for (const x of previous) await tx.crateOrder.delete({ where: { crateId_orderId: { crateId: x.crateId, orderId: order.id } } });
      await tx.crateOrder.create({ data: { crateId: crate.id, orderId: order.id } });
      const replaced = previous.map((x) => x.crate.crateNo);
      await writeHistory(tx, { orderId: order.id, event: 'GUEST_CRATE', from: order.status, to: order.status, actorId: actor.id, note: `#${crate.crateNo} · ${dmy(day)}` });
      await writeAudit(tx, {
        action: 'CROSS_CUSTOMER_CRATE_ASSIGNED', entityType: 'Order', entityId: order.id, userId: actor.id,
        details: { orderNo: order.orderNo, ownerCustomerId: order.customerId, crateId: crate.id, crateNo: crate.crateNo, hostCustomerId: crate.customerId, day, ...(replaced.length ? { replaced } : {}) },
      }, actor);
      // İki firmaya bildirim (sandık değiştiyse tek bildirim: yeni sandık)
      await enqueueOutbox(tx, { type: GUEST_ASSIGNED, orderId: order.id, payload: { hostId: crate.customerId, crateNo: crate.crateNo, day, previous: replaced[0] ?? null, actorId: actor.id } });
      return { ok: true, crateNo: crate.crateNo };
    });
  } catch (e) {
    if (e?.code === 'P2002') return { ok: false, code: 'ALREADY_ASSIGNED' };
    throw e;
  }
}

/**
 * Sandık seçimini kaldırır: sipariş başka müşterinin sandığından çıkarılır (yeniden "sandık seçimi bekliyor"). Ticari
 * hiçbir şey değişmez; ev sahibi firma kararı durur (onu yalnızca yönetici kaldırır — setGuestHost).
 * Satış yalnızca yöneticinin seçtiği firmanın sandığındaki yerleşimi kaldırabilir; diğerlerini (eski kayıt) yalnızca yönetici.
 * @param {any} db
 * @param {{ orderId: string, crateId: string, actor: { id: string, role: string, ip?: string | null } }} p
 * @returns {Promise<{ ok: true } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' }>}
 */
export async function removeGuestCrate(db, { orderId, crateId, actor }) {
  const admin = can(actor?.role, 'LOADING_CONFIRM');
  if (!admin && !can(actor?.role, 'CRATE_EDIT')) return { ok: false, code: 'FORBIDDEN' };
  return db.$transaction(async (tx) => {
    const link = await tx.crateOrder.findUnique({
      where: { crateId_orderId: { crateId: String(crateId ?? ''), orderId: String(orderId ?? '') } },
      include: { crate: { select: { crateNo: true, customerId: true, shipDay: true } }, order: { select: { orderNo: true, customerId: true, status: true, guestHostId: true } } },
    });
    // Yalnızca başka müşterinin sandığındaki yerleşim (kendi sandığı sandık formundan yönetilir)
    if (!link || link.crate.customerId === link.order.customerId) return { ok: false, code: 'NOT_FOUND' };
    if (!admin && link.order.guestHostId !== link.crate.customerId) return { ok: false, code: 'FORBIDDEN' };
    const day = link.crate.shipDay ? isoDay(link.crate.shipDay) : null;
    await tx.crateOrder.delete({ where: { crateId_orderId: { crateId: link.crateId, orderId: link.orderId } } });
    await writeHistory(tx, { orderId: link.orderId, event: 'GUEST_CRATE_REMOVED', from: link.order.status, to: link.order.status, actorId: actor.id, note: `#${link.crate.crateNo}` });
    await writeAudit(tx, {
      action: 'CROSS_CUSTOMER_CRATE_REMOVED', entityType: 'Order', entityId: link.orderId, userId: actor.id,
      details: { orderNo: link.order.orderNo, ownerCustomerId: link.order.customerId, crateId: link.crateId, crateNo: link.crate.crateNo, hostCustomerId: link.crate.customerId, day },
    }, actor);
    if (day && link.crate.customerId) await enqueueOutbox(tx, { type: GUEST_REMOVED, orderId: link.orderId, payload: { hostId: link.crate.customerId, crateNo: link.crate.crateNo, day, actorId: actor.id } });
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
