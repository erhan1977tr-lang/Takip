// Yükleme onayı (karar 92): camın FİİLEN yüklendiğinin kalıcı kaydı. Planlanan yükleme günü kanıt değildir.
//
//   - Yükleme günü başına tek onay (LoadingConfirmation.shipDay benzersiz + işlem kilidi).
//   - Onay, o günün uygun siparişlerinin müşteriye GÖNDERİLMİŞ teklif satırlarını kopyalar (LoadingConfirmationItem):
//     müşteri, sipariş, kaynak satır, cam, fiilen onaylanan adet / m², birim maliyet (OfferLine.unitPrice), müşteri
//     birim fiyatı (OfferLine.offerPrice), tutarlar, para birimi, durum. Kopya sonradan değişmez: fiyat tablosu,
//     teklif, müşteri fiyatı ya da katalog değişse de onaylı yükleme aynı kalır.
//   - Kopya teklif satırı biçimindedir; kârlılık (ve Aşama 7D'de fatura) aynı hesap kuralıyla (glassTotals) kopyadan
//     türetilir — ayrı bir fiyat formülü yoktur.
//   - Bu aşamada tek işlem "Eksiksiz Yüklendi": önizlemedeki bütün kalemler tam adetle LOADED kaydedilir. Model kısmi
//     yüklemeyi taşır (satır başına LOADED + NOT_LOADED kaydı, fiilî adetle); kırık / eksik cam akışı sonraki aşama.
//   - Yalnızca yönetici (LOADING_CONFIRM); kontrol burada, sunucuda yapılır.
//   - Onaylı yükleme düzenlenmez / silinmez; sipariş tarihi ya da teklif sonradan değişse de yeniden üretilmez.
import crypto from 'node:crypto';
import { can } from '../auth/permissions.js';
import { offerLineTotals, parseDateOnly } from '../orders/rules.js';
import { dayKey } from '../orders/loading.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { glassTotals } from '../glass/billing.js';

/**
 * @typedef {{ orderId: string, orderNo: string, title: string | null, customerId: string, customerName: string, currency: string, offerId?: string, items: any[] }} ConfirmOrder
 * @typedef {{ orderId: string, orderNo: string, customerId: string, customerName: string, reason: 'NO_SENT_OFFER' | 'ALREADY_CONFIRMED', day?: string }} SkippedOrder
 * @typedef {Record<string, { sale: number, cost: number }>} MoneyByCur
 * @typedef {{ name: string, adet: number, m2: number, sale: number, cost: number }} GlassRow
 * @typedef {{ orderId: string, orderNo: string, title: string | null, currency: string, glass: GlassRow[], adet: number, m2: number, sale: number, cost: number, noCost: number }} OrderSummary
 * @typedef {{ customerId: string, name: string, orders: OrderSummary[], adet: number, m2: number, byCur: MoneyByCur }} CustomerSummary
 * @typedef {{ customers: CustomerSummary[], totals: { orders: number, adet: number, m2: number, items: number, byCur: MoneyByCur, noCost: number } }} LoadingSummary
 */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const int = (v) => Math.max(0, Math.trunc(Number(v) || 0));

export const isGlassLine = (l) => (l.kind ?? 'CAM') === 'CAM' && (l.unit ?? 'm2') === 'm2';
const sentOffer = (o) => o.offers.find((x) => x.status === 'GONDERILDI') ?? null;

/** "YYYY-MM-DD" → @db.Date değeri (UTC gece yarısı) */
export const shipDayDate = (day) => new Date(`${day}T00:00:00.000Z`);

/**
 * Teklif satırının onay kopyası. quantity: FİİLEN onaylanan adet (verilmezse satırın tamamı).
 * Tutarlar yuvarlanmadan (4 hane) saklanır; toplamlar mevcut kuralla grup düzeyinde yuvarlanır.
 *   maliyet = miktar × OfferLine.unitPrice (müşteriye bedelsiz satırda da sayılır — karar 89)
 *   satış   = miktar × OfferLine.offerPrice (bedelsiz satırda 0)
 * Eski tekliflerde (müşteri fiyatı sütunu yok) müşteriye giden fiyat satırdaki tek fiyattır.
 */
export function snapshotLine(order, offer, l, { quantity = l.adet, status = 'LOADED', reason = null } = {}) {
  const qty = int(quantity);
  const glass = isGlassLine(l);
  const m2 = glass ? offerLineTotals({ ...l, adet: qty, unit: 'm2', unitPrice: 0 }).metraj : 0;
  const base = glass ? m2 : qty;
  const legacy = offer.offerAmount == null;
  const unitCost = Number(l.unitPrice ?? 0);
  const unitSale = legacy ? unitCost : l.offerPrice == null ? null : Number(l.offerPrice);
  return {
    orderId: order.id, customerId: order.customerId, offerLineId: l.id ?? null, sortOrder: l.sortOrder ?? 0,
    kind: l.kind ?? 'CAM', unit: l.unit ?? 'm2', description: l.description ?? '', descriptionRo: l.descriptionRo ?? null,
    glassProductId: l.glassProductId ?? null, enMm: l.enMm ?? null, boyMm: l.boyMm ?? null,
    weightKgM2: l.weightKgM2 == null ? null : Number(l.weightKgM2), free: !!l.free,
    quantity: qty, m2, currency: offer.currency,
    unitCost, unitSale,
    costAmount: round4(base * unitCost),
    saleAmount: l.free || unitSale == null ? 0 : round4(base * unitSale),
    status, notLoadedReason: status === 'NOT_LOADED' ? reason : null,
  };
}

/** Onay kalemi → hesap kurallarının beklediği teklif satırı biçimi (glassTotals, orderLoad) */
export const itemAsLine = (it) => ({
  id: it.offerLineId ?? it.id, description: it.description, descriptionRo: it.descriptionRo, enMm: it.enMm, boyMm: it.boyMm,
  adet: it.quantity, unit: it.unit, kind: it.kind, free: it.free, sortOrder: it.sortOrder,
  unitPrice: Number(it.unitCost), offerPrice: it.unitSale == null ? null : Number(it.unitSale),
  weightKgM2: it.weightKgM2 == null ? null : Number(it.weightKgM2),
});

const sumTotals = (rows) => round2(rows.reduce((s, r) => s + r.total, 0));

/**
 * Bir siparişin (onay kalemlerinin ya da teklif satırlarının) cam, m², satış ve maliyet toplamı — fatura / yükleme dökümü
 * kuralıyla (glassTotals). noCost: müşterinin ödediği ama maliyeti kayıtlı olmayan satır sayısı.
 * @param {any[]} lines  teklif satırı biçiminde: description, descriptionRo, enMm, boyMm, adet, unit, kind, free, unitPrice, offerPrice
 * @param {(l: any) => string} [nameOf]
 * @returns {{ glass: GlassRow[], adet: number, m2: number, cost: number, sale: number, noCost: number }}
 */
export function lineTotals(lines, nameOf = (l) => l.description) {
  const offer = { lines };
  const cost = glassTotals(offer, { nameOf, priceOf: (l) => l.unitPrice, includeFree: true });
  const sale = new Map(glassTotals(offer, { nameOf, priceOf: (l) => l.offerPrice }).map((g) => [g.name, g.total]));
  const glass = cost.map((g) => ({ name: g.name, adet: g.adet, m2: g.qty, cost: g.total, sale: sale.get(g.name) ?? 0 }));
  return {
    glass,
    adet: glass.reduce((s, g) => s + g.adet, 0),
    m2: round2(glass.reduce((s, g) => s + g.m2, 0)),
    cost: sumTotals(cost),
    sale: round2(glass.reduce((s, g) => s + g.sale, 0)),
    noCost: lines.filter((l) => !l.free && Number(l.offerPrice ?? 0) > 0 && !(Number(l.unitPrice ?? 0) > 0)).length,
  };
}

/**
 * O günün onay planı (önizleme ve onay aynı fonksiyonu kullanır).
 *   orders: onaylanacak siparişler ve kalemleri · skipped: o güne planlı ama onaya girmeyen siparişler ve nedeni
 *     NO_SENT_OFFER — müşteriye gönderilmiş teklifi yok (fiyatı belli değil)
 *     ALREADY_CONFIRMED — başka bir onaylı yüklemede yüklenmiş (aynı cam iki kez sayılmaz)
 * @param {{ id: string, orderNo: string, title?: string | null, customerId: string, customer: { id: string, name: string }, offers: object[] }[]} orders  o günün siparişleri
 * @param {Map<string, string>} loadedElsewhere  sipariş → onaylandığı gün ("YYYY-MM-DD")
 * @returns {{ orders: ConfirmOrder[], skipped: SkippedOrder[], items: any[] }}
 */
export function planItems(orders, loadedElsewhere = new Map()) {
  const plan = [];
  const skipped = [];
  for (const o of orders) {
    const ref = { orderId: o.id, orderNo: o.orderNo, customerId: o.customerId, customerName: o.customer?.name ?? '' };
    if (loadedElsewhere.has(o.id)) {
      skipped.push({ ...ref, reason: 'ALREADY_CONFIRMED', day: loadedElsewhere.get(o.id) });
      continue;
    }
    const offer = sentOffer(o);
    if (!offer) {
      skipped.push({ ...ref, reason: 'NO_SENT_OFFER' });
      continue;
    }
    const items = offer.lines.map((l) => snapshotLine(o, offer, l));
    if (items.length === 0) {
      skipped.push({ ...ref, reason: 'NO_SENT_OFFER' });
      continue;
    }
    plan.push({ ...ref, title: o.title ?? null, offerId: offer.id, currency: offer.currency, items });
  }
  return { orders: plan, skipped, items: plan.flatMap((p) => p.items) };
}

/**
 * Önizlemenin parmak izi: yönetici neyi gördüyse o onaylanır. Arada sipariş / teklif / tarih değiştiyse parmak izi
 * tutmaz ve onay reddedilir (STALE_PREVIEW) — yönetici güncel içeriği yeniden kontrol eder.
 */
export function planKey(day, items) {
  const rows = items.map((i) => [i.orderId, i.offerLineId, i.quantity, i.m2, i.unitCost, i.unitSale, i.free, i.currency]);
  return crypto.createHash('sha256').update(JSON.stringify([day, rows])).digest('hex').slice(0, 32);
}

/**
 * Kalemleri müşteri → sipariş → cam olarak özetler (önizleme ve onaylı görünüm aynı özeti kullanır).
 * @param {ConfirmOrder[]} orders
 * @param {(l: any) => string} [nameOf]
 * @returns {LoadingSummary}
 */
export function summarize(orders, nameOf) {
  const customers = new Map();
  const totals = { orders: 0, adet: 0, m2: 0, items: 0, byCur: {}, noCost: 0 };
  for (const o of orders) {
    const loaded = o.items.filter((i) => i.status === 'LOADED');
    const t = lineTotals(loaded.map(itemAsLine), nameOf);
    const c = customers.get(o.customerId) ?? { customerId: o.customerId, name: o.customerName, orders: [], adet: 0, m2: 0, byCur: {} };
    c.orders.push({ orderId: o.orderId, orderNo: o.orderNo, title: o.title ?? null, currency: o.currency, ...t });
    for (const x of [c, totals]) {
      x.adet += t.adet;
      x.m2 = round2(x.m2 + t.m2);
      const cur = (x.byCur[o.currency] ??= { sale: 0, cost: 0 });
      cur.sale = round2(cur.sale + t.sale);
      cur.cost = round2(cur.cost + t.cost);
    }
    totals.orders++;
    totals.items += o.items.length;
    totals.noCost += t.noCost;
    customers.set(o.customerId, c);
  }
  return { customers: [...customers.values()].sort((a, b) => b.m2 - a.m2), totals };
}

const ORDER_INCLUDE = {
  customer: { select: { id: true, name: true } },
  offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
};

/** O güne planlı cam siparişleri (Yüklemeler sayfasıyla aynı kural: gerçek, yoksa tahmini yükleme günü; bekleyen ve iptal hariç) */
async function ordersOfDay(db, day) {
  const d = shipDayDate(day);
  const rows = await db.order.findMany({
    where: {
      orderTypeCode: 'GLASS_ORDER', onHold: false, status: { not: 'IPTAL' },
      OR: [
        { actualShipDate: { gte: new Date(d.getTime() - 86_400_000), lt: new Date(d.getTime() + 2 * 86_400_000) } },
        { actualShipDate: null, estimatedShipDate: { gte: new Date(d.getTime() - 86_400_000), lt: new Date(d.getTime() + 2 * 86_400_000) } },
      ],
    },
    include: ORDER_INCLUDE,
    orderBy: [{ customerId: 'asc' }, { customerOrderNo: 'asc' }],
  });
  return rows.filter((o) => dayKey(o.actualShipDate ?? o.estimatedShipDate) === day);
}

/**
 * Siparişler → fiilen yüklendikleri gün (herhangi bir onayda LOADED kalemi olanlar)
 * @param {any} db
 * @param {string[]} orderIds
 * @returns {Promise<Map<string, string>>}
 */
export async function loadedDays(db, orderIds) {
  if (orderIds.length === 0) return new Map();
  const rows = await db.loadingConfirmationItem.findMany({
    where: { orderId: { in: orderIds }, status: 'LOADED' },
    select: { orderId: true, confirmation: { select: { shipDay: true } } },
    distinct: ['orderId'],
  });
  return new Map(rows.map((r) => [r.orderId, r.confirmation.shipDay.toISOString().slice(0, 10)]));
}

/**
 * Önizleme: o gün onaylanırsa neyin kaydedileceği (+ parmak izi). Hiçbir şey yazmaz.
 * @param {any} db
 * @param {string} day
 * @returns {Promise<{ orders: ConfirmOrder[], skipped: SkippedOrder[], items: any[], key: string }>}
 */
export async function previewLoading(db, day) {
  const orders = await ordersOfDay(db, day);
  const plan = planItems(orders, await loadedDays(db, orders.map((o) => o.id)));
  return { ...plan, key: planKey(day, plan.items) };
}

/**
 * Onaylı yükleme (yoksa null): kalemler sipariş başına gruplanmış, önizlemeyle aynı biçimde
 * @param {any} db
 * @param {string} day
 * @returns {Promise<null | { id: string, day: string, confirmedAt: Date, confirmedBy: string, note: string | null, orders: ConfirmOrder[] }>}
 */
export async function loadConfirmation(db, day) {
  const c = await db.loadingConfirmation.findUnique({
    where: { shipDay: shipDayDate(day) },
    include: {
      confirmedBy: { select: { name: true } },
      items: { orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }], include: { order: { select: { orderNo: true, title: true } }, customer: { select: { name: true } } } },
    },
  });
  if (!c) return null;
  const byOrder = new Map();
  for (const it of c.items) {
    const o = byOrder.get(it.orderId) ?? { orderId: it.orderId, orderNo: it.order.orderNo, title: it.order.title ?? null, customerId: it.customerId, customerName: it.customer.name, currency: it.currency, items: [] };
    o.items.push(it);
    byOrder.set(it.orderId, o);
  }
  return { id: c.id, day, confirmedAt: c.confirmedAt, confirmedBy: c.confirmedBy?.name ?? '—', note: c.note, orders: [...byOrder.values()] };
}

/**
 * "Eksiksiz Yüklendi": o günün önizlemedeki bütün kalemlerini tam adetle LOADED olarak kaydeder.
 * Aynı gün ikinci kez onaylanamaz: işlem kilidi + benzersiz yükleme günü (aynı anda gelen iki istekten biri reddedilir).
 * @param {any} db
 * @param {{ day: string, key: string, note?: string | null, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, id: string, orders: number, items: number } | { ok: false, code: 'FORBIDDEN' | 'BAD_DAY' | 'FUTURE_DAY' | 'ALREADY_CONFIRMED' | 'NOTHING_TO_CONFIRM' | 'STALE_PREVIEW' }>}
 */
export async function confirmLoading(db, { day, key, note = null, actor, now = new Date() }) {
  if (!can(actor?.role, 'LOADING_CONFIRM')) return { ok: false, code: 'FORBIDDEN' };
  if (!parseDateOnly(day)) return { ok: false, code: 'BAD_DAY' };
  // Yükleme fiilen yapıldıktan sonra onaylanır: gelecekteki bir gün onaylanamaz (onay geri alınamaz)
  if (day > dayKey(now)) return { ok: false, code: 'FUTURE_DAY' };
  const shipDay = shipDayDate(day);
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('loading-confirmation', 0))`;
      if (await tx.loadingConfirmation.findUnique({ where: { shipDay }, select: { id: true } })) return { ok: false, code: 'ALREADY_CONFIRMED' };
      const plan = await previewLoading(tx, day);
      if (plan.items.length === 0) return { ok: false, code: 'NOTHING_TO_CONFIRM' };
      if (plan.key !== key) return { ok: false, code: 'STALE_PREVIEW' };
      const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
      const c = await tx.loadingConfirmation.create({ data: { shipDay, confirmedById: actor.id, confirmedAt: now, note: text } });
      await tx.loadingConfirmationItem.createMany({
        data: plan.items.map((i) => ({
          ...i, confirmationId: c.id, m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2),
          costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4),
        })),
      });
      const statuses = new Map((await tx.order.findMany({ where: { id: { in: plan.orders.map((o) => o.orderId) } }, select: { id: true, status: true } })).map((o) => [o.id, o.status]));
      const dateText = day.split('-').reverse().join('.');
      for (const o of plan.orders) {
        const st = statuses.get(o.orderId) ?? null;
        await writeHistory(tx, { orderId: o.orderId, event: 'LOADING_CONFIRMED', from: st, to: st, actorId: actor.id, note: dateText });
      }
      const { totals } = summarize(plan.orders);
      await writeAudit(tx, {
        action: 'LOADING_CONFIRMED', entityType: 'LoadingConfirmation', entityId: c.id, userId: actor.id,
        details: {
          shipDay: day, confirmedAt: now.toISOString(), note: text,
          customers: [...new Map(plan.orders.map((o) => [o.customerId, o.customerName])).entries()].map(([id, name]) => ({ id, name })),
          orders: plan.orders.map((o) => ({ id: o.orderId, orderNo: o.orderNo, offerId: o.offerId, items: o.items.length })),
          skipped: plan.skipped.map((s) => ({ orderNo: s.orderNo, reason: s.reason })),
          items: plan.items.length, pieces: totals.adet, m2: totals.m2, totals: totals.byCur, noCostLines: totals.noCost,
        },
      }, actor);
      return { ok: true, id: c.id, orders: plan.orders.length, items: plan.items.length };
    }, { timeout: 30_000 });
  } catch (e) {
    // Kilit dışında aynı gün için ikinci kayıt denenirse veritabanı reddeder (benzersiz yükleme günü)
    if (e?.code === 'P2002') return { ok: false, code: 'ALREADY_CONFIRMED' };
    throw e;
  }
}
