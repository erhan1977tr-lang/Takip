// Müşteri düzeyinde yükleme öncesi proforma (Aşama 7D-2, karar 100): yönetici bir müşteri ve gelecekteki bir ya da
// birkaç yükleme gününü seçer; o günlere planlı, ticari olarak hazır cam siparişleri TEK FGO proformasında toplanır.
//
//   - Önizleme ile kesilen belge AYNI hesaptan gelir (previewBatch): parti oluşturulurken önizlemenin parmak izi
//     yeniden hesaplanır; içerik ya da kur değiştiyse parti oluşturulmaz (STALE_PREVIEW).
//   - Satırlar sipariş başına proformaLines (server/glass/billing.js — sipariş proformasıyla aynı kural); satırlar
//     siparişler arasında BİRLEŞTİRİLMEZ, her satırın açıklaması kaynak sipariş numarasıyla başlar.
//   - Parti (BillingBatch + BillingBatchOrder + BillingBatchLine) yöneticinin onayladığı içeriğin değişmez kopyasıdır:
//     FGO belgesi yalnızca bu kayıttan kesilir; sonradan yükleme günü, teklif, fiyat tablosu, kur ya da müşterinin kur
//     politikası değişse de değişmez.
//   - Kur: resolveExchangeRate (müşterinin kur politikası ya da yöneticinin elle girdiği kur) parti oluşturulurken bir
//     kez çözülür ve partiye yazılır; işçi yeniden çözmez.
//   - Çift faturalama engeli tek yerde (coverageOf): sipariş başına belgesi / bekleyen belge isteği olan ya da etkin bir
//     partide yer alan sipariş yeni partiye girmez; etkin partideki sipariş için sipariş başına belge de istenemez
//     (billingState → 'batch'). Veritabanında BillingBatchOrder.activeKey benzersizdir; FGO'da IdExtern + VerificareDuplicat.
//   - Sipariş seçimi (karar 125): yönetici, uygun siparişlerden yalnızca seçtiklerini partiye alabilir (orderIds).
//     Seçim yalnızca UYGUN siparişleri daraltır — uygunluğu (planOrder / coverageOf) sunucu belirler; uygun olmayan ya da
//     başka belgeyle karşılanan sipariş seçilirse parti oluşturulmaz (NOT_ELIGIBLE). Seçilmeyen sipariş olduğu gibi kalır
//     ve sonraki belgeye girebilir. Hesap, kur ve parmak izi seçilen siparişler üzerinden aynı kuraldır.
//   - Belgeyi işçi keser (FGO isteği veritabanı işleminin dışında): kuyruk olayı FGO_BATCH.
//   - Yalnızca yönetici (ACCOUNTING_MANAGE); kontrol burada, sunucuda da yapılır.
import crypto from 'node:crypto';
import { can } from '../auth/permissions.js';
import { getEnv } from '../env.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { dayKey } from '../orders/loading.js';
import { parseDateOnly } from '../orders/rules.js';
import { loadedDays } from '../loading/confirmation.js';
import { bnrRate } from '../fx/bnr.js';
import { FxUnavailable, fxSnapshot, resolveExchangeRate } from '../fx/resolve.js';
import {
  FgoError, afterInvoiceIssued, dailyLimitReached, emitereForm, fgoEmit, fgoKey, fgoReady, fgoStatus, getFgoSettings, grossOf, missingBilling, orderDetail, reserveInvoiceNumber, ronPrice, uncertainEmit,
} from '../integrations/fgo.js';
import { claimFgoJob } from '../integrations/fgo-claim.js';
import { dayDate, localDay, localDayStart } from '../profile/dates.js';
import { GLASS_FGO, glassDocText, proformaLines, sentOffer } from './billing.js';
import { queueDocEmail } from '../documents/delivery.js';
import { centsText, toCents } from '../finance/payments.js';
import { linkCoveredPayments } from '../finance/service.js';
import { expectedGross, parkUncertain } from '../finance/uncertain.js';

export const BATCH_FGO = 'FGO_BATCH';
export const BATCH_KIND = 'PROFORMA';
/** Siparişleri tutan parti durumları (VOID dışındakiler) */
export const ACTIVE_STATUSES = ['PENDING', 'ISSUED', 'FAILED'];
export const MAX_ATTEMPTS = 8;
const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120, 240, 480][Math.min(attempt, 7)];
class Permanent extends Error {}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const ddmmyyyy = (day) => day.split('-').reverse().join('.');
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
export const activeKeyOf = (orderId, kind = BATCH_KIND) => `${kind}:${orderId}`;

/** Siparişin planlanan yükleme günü ("YYYY-AA-GG", uygulamanın saat diliminde); tarihi yoksa null */
export const loadingDayOf = (order) => {
  const d = order.actualShipDate ?? order.estimatedShipDate;
  return d ? dayKey(d) : null;
};

/**
 * @typedef {'CANCELLED' | 'ON_HOLD' | 'ALREADY_LOADED' | 'NO_SENT_OFFER' | 'NO_PRICES' | 'CURRENCY' | 'ORDER_DOCUMENT' | 'ORDER_PENDING' | 'IN_BATCH'} ExcludeReason
 * @typedef {{ name: string, unit: string, qty: number, price: number, amount: number }} BatchLine
 * @typedef {{ orderId: string, orderNo: string, title: string | null, day: string, offerId: string | null, currency: string | null, reason: ExcludeReason | null,
 *   ref: string | null, lines: BatchLine[], subtotal: number }} BatchOrder
 * @typedef {import('../fx/resolve.js').FxResult} FxResult
 * @typedef {{ ok: true, customer: any, today: string, days: string[], byDay: { day: string, orders: BatchOrder[] }[], included: BatchOrder[], excluded: BatchOrder[], unselected: BatchOrder[],
 *   currency: string | null, currencies: (string | null)[], sourceTotal: number, fx: FxResult | null, fxError: { code: string, error: string } | null,
 *   ronNet: number | null, ronGross: number | null, missingBilling: string[], problems: string[], key: string }} BatchPreview
 */

/**
 * Çift faturalama denetimi — TEK yer. Sipariş ticari olarak başka bir belgeyle karşılanıyor mu?
 *   ORDER_DOCUMENT: siparişin kendi FGO belgesi var (proforma / avans / fatura)
 *   ORDER_PENDING : sipariş başına belge isteği kuyrukta
 *   IN_BATCH      : etkin bir müşteri partisinde (kuyrukta, kesilmiş ya da başarısız — yönetici vazgeçene kadar)
 * @param {{ fgoDocuments?: { kind: string, series: string, number: string }[], billingBatchOrders?: { activeKey: string | null, batch?: { document?: { series: string, number: string } | null } | null }[] }} order
 * @param {boolean} pendingOrderJob
 * @returns {{ reason: 'ORDER_DOCUMENT' | 'ORDER_PENDING' | 'IN_BATCH', ref: string | null } | null}
 */
export function coverageOf(order, pendingOrderJob = false) {
  const doc = order.fgoDocuments?.[0];
  if (doc) return { reason: 'ORDER_DOCUMENT', ref: `${doc.series}${doc.number}` };
  if (pendingOrderJob) return { reason: 'ORDER_PENDING', ref: null };
  const b = order.billingBatchOrders?.find((x) => x.activeKey != null);
  if (b) return { reason: 'IN_BATCH', ref: b.batch?.document ? `${b.batch.document.series}${b.batch.document.number}` : null };
  return null;
}

/**
 * Bir siparişin partiye girip giremeyeceği ve gireceği satırlar. Satırlar sipariş proformasıyla aynı kuraldan
 * (proformaLines); açıklamanın başına kaynak sipariş numarası yazılır.
 * @returns {BatchOrder}
 */
export function planOrder(order, { day, loaded = false, pendingOrderJob = false }) {
  const offer = sentOffer(order);
  /** @type {BatchOrder} */
  const out = { orderId: order.id, orderNo: order.orderNo, title: order.title ?? null, day, offerId: offer?.id ?? null, currency: offer?.currency ?? null, reason: null, ref: null, lines: [], subtotal: 0 };
  const no = (reason, ref = null) => ({ ...out, reason, ref });
  if (order.status === 'IPTAL') return no('CANCELLED');
  if (order.onHold) return no('ON_HOLD');
  if (loaded) return no('ALREADY_LOADED');
  const cov = coverageOf(order, pendingOrderJob);
  if (cov) return no(cov.reason, cov.ref);
  if (!offer) return no('NO_SENT_OFFER');
  if (offer.currency !== 'EUR' && offer.currency !== 'RON') return no('CURRENCY');
  // Müşteri fiyatı: bedelsiz olmayan her satırda olmalı (eksik fiyatlı teklif belgeye yarım girmez)
  if (offer.lines.some((l) => !l.free && l.offerPrice == null)) return no('NO_PRICES');
  const lines = proformaLines(offer).map((l) => ({
    name: `Comanda ${order.orderNo} — ${l.name}`.slice(0, 250), unit: l.unit, qty: l.qty, price: l.eur, amount: round2(l.qty * l.eur),
  }));
  if (lines.length === 0) return no('NO_PRICES');
  return { ...out, lines, subtotal: round2(lines.reduce((s, l) => s + l.amount, 0)) };
}

const ORDER_INCLUDE = {
  offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
  fgoDocuments: { select: { kind: true, series: true, number: true }, orderBy: { issuedAt: 'asc' } },
  billingBatchOrders: { where: { activeKey: { not: null } }, select: { activeKey: true, batch: { select: { id: true, status: true, document: { select: { series: true, number: true } } } } } },
};

/** Müşterinin bugünden (dahil) sonraki yükleme günlerine planlı cam siparişleri, planlanmış hâlleriyle */
async function plannedOrders(db, { customerId, today }) {
  const from = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86_400_000);
  const rows = await db.order.findMany({
    where: {
      customerId, orderTypeCode: 'GLASS_ORDER', removedAt: null, // silinmiş sipariş önizlemede "hariç" olarak da görünmez (karar 110)
      OR: [{ actualShipDate: { gte: from } }, { actualShipDate: null, estimatedShipDate: { gte: from } }],
    },
    include: ORDER_INCLUDE,
    orderBy: [{ customerOrderNo: 'asc' }],
  });
  const future = rows.map((o) => ({ o, day: loadingDayOf(o) })).filter((x) => x.day != null && x.day >= today);
  const ids = future.map((x) => x.o.id);
  const [loaded, jobs] = await Promise.all([
    loadedDays(db, ids),
    ids.length ? db.notificationOutbox.findMany({ where: { orderId: { in: ids }, type: GLASS_FGO, status: 'PENDING' }, select: { orderId: true } }) : [],
  ]);
  const pending = new Set(jobs.map((j) => j.orderId));
  return future.map(({ o, day }) => planOrder(o, { day, loaded: loaded.has(o.id), pendingOrderJob: pending.has(o.id) }));
}

/**
 * Müşteri seçimi: gelecekteki yükleme günlerinde uygun cam siparişi olan müşteriler.
 * @returns {Promise<{ id: string, name: string, days: number, orders: number }[]>}
 */
export async function batchCustomers(db, { now = new Date() } = {}) {
  const today = dayKey(now);
  const from = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86_400_000);
  const rows = await db.order.findMany({
    where: {
      orderTypeCode: 'GLASS_ORDER', onHold: false, status: { not: 'IPTAL' }, customer: { type: 'CUSTOMER' },
      offers: { some: { status: 'GONDERILDI' } },
      OR: [{ actualShipDate: { gte: from } }, { actualShipDate: null, estimatedShipDate: { gte: from } }],
    },
    select: { customerId: true, actualShipDate: true, estimatedShipDate: true, customer: { select: { name: true } } },
  });
  const by = new Map();
  for (const o of rows) {
    const day = loadingDayOf(o);
    if (day == null || day < today) continue;
    const c = by.get(o.customerId) ?? { id: o.customerId, name: o.customer.name, daySet: new Set(), orders: 0 };
    c.daySet.add(day);
    c.orders += 1;
    by.set(o.customerId, c);
  }
  return [...by.values()].map((c) => ({ id: c.id, name: c.name, days: c.daySet.size, orders: c.orders })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Müşterinin gelecekteki yükleme günleri: gün başına uygun / uygun olmayan sipariş sayısı.
 * @returns {Promise<{ day: string, eligible: number, excluded: number }[]>}
 */
export async function customerLoadingDays(db, { customerId, now = new Date() }) {
  const orders = await plannedOrders(db, { customerId, today: dayKey(now) });
  const by = new Map();
  for (const o of orders) {
    const d = by.get(o.day) ?? { day: o.day, eligible: 0, excluded: 0 };
    if (o.reason) d.excluded += 1; else d.eligible += 1;
    by.set(o.day, d);
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Seçilen günler: geçerli, yinelenmeyen, sıralı "YYYY-AA-GG" listesi
 * @param {unknown} days  @returns {string[]}
 */
export const cleanDays = (days) => [...new Set((Array.isArray(days) ? days : [days]).map((d) => String(d ?? '')).filter((d) => parseDateOnly(d)))].sort();

/** İçeriğin parmak izi: müşteri, günler, siparişler (teklif sürümü + satırlar), para birimi ve uygulanan kur */
function batchKey({ customerId, days, orders, currency, fx }) {
  const body = JSON.stringify({
    customerId, days, currency, fx: fx ? [fx.policy, fx.finalRate, fx.source, fx.sourceDate, fx.manual] : null,
    orders: orders.map((o) => [o.orderId, o.offerId, o.day, o.lines.map((l) => [l.name, l.unit, l.qty, l.price])]),
  });
  return crypto.createHash('sha256').update(body).digest('hex');
}

/**
 * Önizleme = kesilecek belgenin hesabı. Hiçbir şey yazmaz.
 *   problems: partinin oluşturulmasını engelleyen nedenler (NO_DAYS, PAST_DAY, NOTHING_ELIGIBLE, NOT_ELIGIBLE,
 *   NOTHING_SELECTED, MIXED_CURRENCY, BILLING_MISSING, FX_UNAVAILABLE). fx verilirse (parti oluşturulurken, işlem içinde)
 *   kur yeniden çözülmez.
 *   orderIds: yöneticinin seçtiği siparişler (null = uygun siparişlerin hepsi). included = seçilen uygun siparişler,
 *   unselected = uygun ama seçilmeyenler (belgeye girmez, olduğu gibi kalır). Seçimde uygun olmayan sipariş varsa NOT_ELIGIBLE.
 * @param {any} db
 * @param {{ customerId: string, days: string[], orderIds?: string[] | null, now?: Date, manualRate?: string | number | null, bnrImpl?: typeof bnrRate, fx?: FxResult | null, vatRate?: number }} o
 * @returns {Promise<BatchPreview | { ok: false, code: string }>}
 */
export async function previewBatch(db, { customerId, days, orderIds = null, now = new Date(), manualRate = null, bnrImpl = bnrRate, fx = undefined, vatRate = undefined }) {
  const today = dayKey(now);
  const selected = cleanDays(days);
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer || customer.type !== 'CUSTOMER') return { ok: false, code: 'NOT_FOUND' };
  const all = await plannedOrders(db, { customerId, today });
  const orders = all.filter((o) => selected.includes(o.day));
  const eligible = orders.filter((o) => !o.reason);
  const excluded = orders.filter((o) => o.reason);
  // Sipariş seçimi: yalnızca uygun siparişler daraltılır; uygunluk kararı yukarıdaki sunucu hesabındadır
  const picked = orderIds == null ? null : new Set((Array.isArray(orderIds) ? orderIds : [orderIds]).map(String));
  const included = picked ? eligible.filter((o) => picked.has(o.orderId)) : eligible;
  const unselected = picked ? eligible.filter((o) => !picked.has(o.orderId)) : [];
  const currencies = [...new Set(included.map((o) => o.currency))];
  const currency = currencies.length === 1 ? currencies[0] : null;
  /** @type {string[]} */
  const problems = [];
  if (selected.length === 0) problems.push('NO_DAYS');
  else if (selected.some((d) => d < today)) problems.push('PAST_DAY');
  // Seçilen sipariş uygun değil (başka belgeyle karşılanıyor, yüklenmiş, fiyatsız, seçilen günlerde değil …): parti oluşturulmaz
  if (picked && [...picked].some((id) => !eligible.some((o) => o.orderId === id))) problems.push('NOT_ELIGIBLE');
  if (selected.length > 0 && eligible.length === 0) problems.push('NOTHING_ELIGIBLE');
  else if (selected.length > 0 && included.length === 0) problems.push('NOTHING_SELECTED');
  // Para birimleri birbirine eklenmez: karışık seçimde parti oluşturulmaz (yönetici günleri ayırır)
  if (currencies.length > 1) problems.push('MIXED_CURRENCY');
  const missing = missingBilling(customer);
  if (missing.length) problems.push('BILLING_MISSING');

  // Kur: tek çözücü. RON tekliflerde çevrim yok (kur 1).
  let fxError = null;
  if (fx === undefined) {
    fx = null;
    if (currency === 'RON') {
      const at = now.toISOString();
      fx = { policy: customer.fxPolicy, currency: 'RON', baseRate: '1.0000', markupPercent: null, finalRate: '1.0000', rate: 1, source: 'RON', sourceDate: today, resolvedAt: at, manual: false };
    } else if (currency) {
      try {
        fx = await resolveExchangeRate(db, { customer, currency, day: today, now, manualRate, bnrImpl });
      } catch (e) {
        fxError = { code: e instanceof FxUnavailable ? e.code : 'ERROR', error: String(e?.message ?? e).slice(0, 300) };
      }
    }
  }
  if (currency && !fx) problems.push('FX_UNAVAILABLE');

  const sourceTotal = round2(included.reduce((s, o) => s + o.subtotal, 0));
  // RON tutarlar FGO'ya gidecek satırlarla aynı hesap: adet × round2(fiyat × kur); TVA satır başına
  let ronNet = null, ronGross = null;
  if (fx && currencies.length === 1) {
    vatRate ??= (await getFgoSettings(db)).vatRate;
    ronNet = 0; ronGross = 0;
    for (const l of included.flatMap((o) => o.lines)) {
      const n = round2(l.qty * ronPrice(l.price, fx.rate));
      ronNet = round2(ronNet + n);
      ronGross = round2(ronGross + grossOf(n, vatRate));
    }
  }
  const byDay = selected.map((day) => ({ day, orders: orders.filter((o) => o.day === day) }));
  return {
    ok: true, customer, today, days: selected, byDay, included, excluded, unselected, currency, currencies, sourceTotal, fx, fxError, ronNet, ronGross,
    missingBilling: missing, problems, key: batchKey({ customerId, days: selected, orders: included, currency, fx }),
  };
}

const isUnique = (e) => e?.code === 'P2002';

/**
 * Partiyi oluşturur ve FGO proformasını kuyruğa alır (yönetici).
 * @param {any} db
 * orderIds: yöneticinin seçtiği siparişler (null = uygun siparişlerin hepsi); seçim sunucuda yeniden doğrulanır.
 * @param {{ customerId: string, days: string[], orderIds?: string[] | null, key: string, manualRate?: string | number | null, actor: any, now?: Date, bnrImpl?: typeof bnrRate }} o
 * @returns {Promise<{ ok: true, batchId: string, orders: number } | { ok: false, code: string }>}
 */
export async function createBatch(db, { customerId, days, orderIds = null, key, manualRate = null, actor, now = new Date(), bnrImpl = bnrRate }) {
  if (!can(actor?.role, 'ACCOUNTING_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  const tz = getEnv().APP_TIMEZONE;
  if (await dailyLimitReached(db, settings, localDayStart(now, tz))) return { ok: false, code: 'FGO_DAILY_LIMIT' };
  // Kur işlemin dışında çözülür (BNR ağ isteği veritabanı işlemini bekletmesin); işlem içinde aynı kurla yeniden hesaplanır
  const first = await previewBatch(db, { customerId, days, orderIds, now, manualRate, bnrImpl, vatRate: settings.vatRate });
  if (!first.ok) return first;
  if (first.problems.length) return { ok: false, code: first.problems[0] };
  if (first.key !== key) return { ok: false, code: 'STALE_PREVIEW' };
  try {
    return await db.$transaction(async (tx) => {
      // Müşteri kilidi + sipariş kilitleri (sipariş başına belge isteğiyle aynı kilit: ikisi aynı anda yürümez)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-batch:${customerId}`}, 0))`;
      for (const id of first.included.map((o) => o.orderId).sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${id}`}, 0))`;
      }
      const p = await previewBatch(tx, { customerId, days, orderIds, now, fx: first.fx, vatRate: settings.vatRate });
      if (!p.ok) return p;
      if (p.problems.length) return { ok: false, code: p.problems[0] };
      if (p.key !== key) return { ok: false, code: 'STALE_PREVIEW' };
      const docDay = dayDate(localDay(now, tz));
      // Belgenin günleri: sipariş seçildiyse yalnızca seçilen siparişlerin yükleme günleri (belge metni de bunları yazar)
      const batchDays = p.unselected.length ? [...new Set(p.included.map((o) => o.day))].sort() : p.days;
      const batch = await tx.billingBatch.create({
        data: {
          customerId, kind: BATCH_KIND, status: 'PENDING', currency: p.currency, loadingDays: batchDays.map((d) => new Date(`${d}T00:00:00Z`)),
          selectionKey: p.key, sourceTotal: p.sourceTotal.toFixed(2), ronNet: p.ronNet.toFixed(2), createdById: actor.id, createdAt: now,
          ...fxSnapshot(p.fx, docDay),
          orders: {
            create: p.included.map((o) => ({
              orderId: o.orderId, orderNo: o.orderNo, offerId: o.offerId, loadingDay: new Date(`${o.day}T00:00:00Z`), sourceAmount: o.subtotal.toFixed(2),
              activeKey: activeKeyOf(o.orderId),
            })),
          },
          lines: {
            create: p.included.flatMap((o) => o.lines.map((l) => ({ orderId: o.orderId, name: l.name, unit: l.unit, quantity: String(l.qty), unitPrice: l.price.toFixed(2), amount: l.amount.toFixed(2) })))
              .map((l, i) => ({ ...l, sortOrder: i })),
          },
        },
      });
      await tx.notificationOutbox.create({ data: { type: BATCH_FGO, payload: { batchId: batch.id } } });
      const statuses = new Map((await tx.order.findMany({ where: { id: { in: p.included.map((o) => o.orderId) } }, select: { id: true, status: true } })).map((o) => [o.id, o.status]));
      const dayText = batchDays.map(ddmmyyyy).join(', ');
      for (const o of p.included) {
        await writeHistory(tx, { orderId: o.orderId, event: 'FGO_DOC_REQUESTED', from: statuses.get(o.orderId), to: statuses.get(o.orderId), actorId: actor.id, note: `PROFORMA · ${dayText}` });
      }
      await writeAudit(tx, {
        action: 'BILLING_BATCH_CREATED', entityType: 'BillingBatch', entityId: batch.id, userId: actor.id,
        details: {
          customerId, kind: BATCH_KIND, days: batchDays, orders: p.included.map((o) => o.orderNo), currency: p.currency, sourceTotal: p.sourceTotal, ronNet: p.ronNet,
          ...(p.unselected.length ? { notSelected: p.unselected.map((o) => o.orderNo) } : {}),
          fxPolicy: p.fx.policy, fxRate: p.fx.finalRate, fxBaseRate: p.fx.baseRate, fxMarkupPercent: p.fx.markupPercent, fxSource: p.fx.source, fxSourceDate: p.fx.sourceDate, fxManual: p.fx.manual,
        },
      }, actor);
      return { ok: true, batchId: batch.id, orders: p.included.length };
    }, { timeout: 30_000 });
  } catch (e) {
    // Aynı sipariş başka bir etkin partiye girdi (aynı anda iki istek): veritabanı engeller
    if (isUnique(e)) return { ok: false, code: 'ALREADY_COVERED' };
    throw e;
  }
}

/** Partiyi geçersiz kılar: siparişler / fatura kapsamı yeniden uygun olur (tekrar anahtarları boşalır). İşlem (tx) içinde çağrılır. */
export async function voidBatchRows(tx, batchId, reason, now = new Date()) {
  await tx.billingBatch.update({ where: { id: batchId }, data: { status: 'VOID', uniqueKey: null, voidedAt: now, voidReason: String(reason).slice(0, 200) } });
  await tx.billingBatchOrder.updateMany({ where: { batchId }, data: { activeKey: null } });
}

/**
 * Yönetici: kesilemeyen (FAILED) partiyi yeniden dener ya da ondan vazgeçer. Kuyrukta / kesilmiş partiye dokunulmaz.
 * @param {any} db
 * @param {{ batchId: string, action: 'retry' | 'void', actor: any, now?: Date }} o
 * @returns {Promise<{ ok: true } | { ok: false, code: string }>}
 */
export async function reviewFailedBatch(db, { batchId, action, actor, now = new Date() }) {
  if (!can(actor?.role, 'ACCOUNTING_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  return db.$transaction(async (tx) => {
    const b = await tx.billingBatch.findUnique({ where: { id: batchId }, include: { document: true, orders: { select: { orderId: true } } } });
    if (!b) return { ok: false, code: 'NOT_FOUND' };
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-batch:${b.customerId}`}, 0))`;
    const cur = await tx.billingBatch.findUnique({ where: { id: batchId }, select: { status: true } });
    if (cur?.status !== 'FAILED' || b.document) return { ok: false, code: 'NOT_ALLOWED' };
    if (action === 'retry') {
      await tx.billingBatch.update({ where: { id: batchId }, data: { status: 'PENDING', lastError: null } });
      await tx.notificationOutbox.create({ data: { type: BATCH_FGO, payload: { batchId } } });
    } else {
      await voidBatchRows(tx, batchId, 'ADMIN', now);
    }
    await writeAudit(tx, { action: action === 'retry' ? 'BILLING_BATCH_RETRY' : 'BILLING_BATCH_VOID', entityType: 'BillingBatch', entityId: batchId, userId: actor.id, details: { customerId: b.customerId } }, actor);
    return { ok: true };
  });
}

/**
 * Partinin kayıtlı satırları → FGO satırları. Hiçbir şey yeniden hesaplanmaz:
 *   proforma satırı   — kaynak para biriminde birim fiyat (RON'a kayıtlı kurla çevrilir)
 *   fatura cam satırı — kayıtlı TVA hariç / dahil toplam (FGO'ya PretTotal; karar 63)
 *   avans, avans düşümü — kayıtlı RON birim fiyat (düşümde miktar −1)
 * Kalemin FGO açıklaması (Continut[Descriere], karar 111): satırın KENDİ kaynak siparişi ("Comanda UMI7") — partinin
 * kayıtlı sipariş listesinden; bütün siparişler her kaleme yazılmaz. Tek siparişe ait olmayan satırda (müşteri
 * proformasının avansı, avans düşümü) açıklama yoktur.
 */
export const batchFgoLines = (batch) => batch.lines.map((l) => {
  const orderNo = l.orderId ? batch.orders.find((o) => o.orderId === l.orderId)?.orderNo ?? null : null;
  const base = { code: '', name: l.name, unit: l.unit, qty: Number(l.quantity), ...(orderNo ? { detail: orderDetail(orderNo) } : {}) };
  if (l.ronUnit != null) return { ...base, ron: Number(l.ronUnit) };
  if (l.ronGross != null) return { ...base, net: Number(l.ronNet), gross: Number(l.ronGross) };
  return { ...base, eur: Number(l.unitPrice) };
});

/**
 * Belgenin açıklaması: kaynak siparişler ve — proformada seçilen yükleme günleri, faturada onaylı yükleme günü,
 * avansta kaynak proforma. Cam belgelerinde kur cümlesi yoktur (karar 99).
 */
export function batchText(batch) {
  const nos = batch.orders.map((o) => o.orderNo);
  const orders = `${nos.length === 1 ? 'Comanda' : 'Comenzi'}: ${nos.join(', ')}.`;
  if (batch.kind === 'INVOICE') return `${orders} Încărcare confirmată: ${batch.confirmation ? ddmmyyyy(dayOf(batch.confirmation.shipDay)) : '—'}.`;
  if (batch.kind === 'ADVANCE') return orders;
  const days = batch.loadingDays.map((d) => ddmmyyyy(dayOf(d)));
  return `${orders} ${days.length === 1 ? 'Încărcare planificată' : 'Încărcări planificate'}: ${days.join(', ')}.`;
}

/**
 * Kuyruktaki parti belgelerini keser (işçi; düğmeye basılınca o parti hemen denenir). Kur ve satırlar partiden okunur;
 * hiçbir şey yeniden hesaplanmaz / çözülmez.
 * @param {any} db
 * @param {{ now?: Date, fetchImpl?: typeof fetch, secret?: string, appUrl?: string, timeZone?: string, onlyBatchId?: string | null, sleep?: (ms: number) => Promise<unknown>, log?: Function }} [ctx]
 */
export async function dispatchBatchJobs(db, { now = new Date(), fetchImpl = fetch, secret, appUrl, timeZone, onlyBatchId = null, sleep = undefined, log = () => {} } = {}) {
  const env = getEnv();
  secret ??= env.AUTH_SECRET;
  appUrl ??= env.APP_URL ?? '';
  timeZone ??= env.APP_TIMEZONE ?? 'Europe/Bucharest';
  const rows = await db.notificationOutbox.findMany({
    where: { type: BATCH_FGO, status: 'PENDING', availableAt: { lte: now }, ...(onlyBatchId ? { payload: { path: ['batchId'], equals: onlyBatchId } } : {}) },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  if (rows.length === 0) return { done: 0, failed: 0 };
  const settings = await getFgoSettings(db);
  let done = 0, failed = 0;
  for (const row of rows) {
    // Atomik sahiplenme + işlem kirası: FGO'ya yalnızca sahiplenen işçi gider (server/integrations/fgo-claim.js)
    if (!(await claimFgoJob(db, row, { now }))) continue;
    const attempt = row.attempts + 1;
    const batchId = String(row.payload?.batchId ?? '');
    const skip = (why) => db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: why } });
    let prepared = null;
    let form = null;
    let fgoLines = [];
    let batchRow = null;
    try {
      const batch = await db.billingBatch.findUnique({
        where: { id: batchId },
        include: { customer: true, document: true, confirmation: { select: { shipDay: true } }, orders: { orderBy: { orderNo: 'asc' } }, lines: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!batch || batch.status === 'VOID') { await skip('parti yok ya da geçersiz'); continue; }
      batchRow = batch;
      if (batch.document) { await skip('belge zaten var'); continue; }
      if (!fgoReady(settings)) throw new Permanent('FGO kapalı');
      const missing = missingBilling(batch.customer);
      if (missing.length) throw new Permanent(`Müşterinin fatura bilgisi eksik: ${missing.join(', ')}`);
      const key = fgoKey(settings, secret);
      if (!key) throw new Permanent('FGO anahtarı açılamadı; Entegrasyonlar ekranında yeniden girin');
      if (await dailyLimitReached(db, settings, localDayStart(now, timeZone))) throw new Error(`Günlük FGO belge sınırı (${settings.dailyLimit}) doldu`);
      const lines = batchFgoLines(batch);
      if (lines.length === 0) throw new Permanent('Partide satır yok');
      fgoLines = lines;
      const rate = Number(batch.fxRate);
      const proforma = batch.kind === 'PROFORMA';
      // Avans ve fatura: numarayı FGO verir (karar 87); yalnızca yönetici elle numara girdiyse o numara gönderilir
      const sentNo = proforma ? null : await reserveInvoiceNumber(db, settings, { key, appUrl, fetchImpl, sleep });
      form = emitereForm({
        settings, key, kind: proforma ? 'proforma' : 'invoice', orderNo: batch.orders.map((o) => o.orderNo).join(', '), appUrl, customer: batch.customer, lines, rate,
        // Aynı parti iki kez kesilmesin: FGO da aynı IdExtern'i reddeder (VerificareDuplicat)
        extern: `LOT-${batch.id}`, text: [batchText(batch), glassDocText(batch.currency, batch)].filter(Boolean).join(' '), rateNote: false, number: sentNo,
      });
      prepared = { kind: batch.kind };
      const doc = await fgoEmit(settings, form, fetchImpl);
      // Elle numara FGO'da kullanıldı: alan belge kaydından ÖNCE boşaltılır (kayıt yazılamasa bile numara yinelenmez)
      if (!proforma) await afterInvoiceIssued(db, { sent: sentNo, issued: doc.number, orderId: null }).catch((e) => log('fatura numarası ayarı güncellenemedi', e?.message));
      const created = await recordBatchIssued(db, { batchId: batch.id, rowId: row.id, doc, now });
      done++;
      try {
        const st = await fgoStatus(settings, key, { series: doc.series, number: doc.number, appUrl }, fetchImpl);
        await db.fgoDocument.update({ where: { id: created.id }, data: { total: st.total == null ? null : st.total.toFixed(2), paid: st.paid == null ? null : st.paid.toFixed(2), checkedAt: new Date() } });
      } catch {
        // Muhasebe ekranından yeniden okunur
      }
    } catch (e) {
      failed++;
      const msg = String(e?.message ?? e).slice(0, 500);
      // Belge FGO'da kesilmiş olabilir (karar 209): yeniden denenmez — parti kuyrukta (PENDING) tutulur, yönetici FGO'ya bakıp karar verir
      if (uncertainEmit(e) && prepared && form && batchRow) {
        await parkUncertain(db, row, {
          target: 'BATCH', kind: batchRow.kind, orderIds: [], batchId, customerId: batchRow.customerId, prepared,
          expected: expectedGross(fgoLines, { rate: Number(batchRow.fxRate), vatRate: settings.vatRate }), series: form.Serie, idExtern: form.IdExtern, error: msg, now,
        });
        await db.billingBatch.updateMany({ where: { id: batchId, status: 'PENDING' }, data: { lastError: `[BELIRSIZ] ${msg}`.slice(0, 500) } });
        log('müşteri belgesi: sonuç belirsiz — yönetici incelemesine gönderildi', batchId);
        continue;
      }
      const final = e instanceof Permanent || (e instanceof FgoError && !e.retry) || attempt >= MAX_ATTEMPTS;
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { lastError: msg, ...(final ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) },
      });
      // Parti kesilemedi: siparişleri tutmaya devam eder; yönetici yeniden dener ya da vazgeçer (Muhasebe → müşteri proforması)
      await db.billingBatch.updateMany({ where: { id: batchId, status: 'PENDING' }, data: { lastError: msg, ...(final ? { status: 'FAILED' } : {}) } });
      if (final && batchId) await db.adminAlert.create({ data: { type: 'FGO_FAILED', details: { code: 'BATCH', batchId, error: msg.slice(0, 300), attempts: attempt } } }).catch(() => {});
      if (final && batchId) {
        // Aynı olay uygulama içi bildirim olarak muhasebe yetkisine (işin kimliğiyle: yeniden denemede ikinci kez yazılmaz)
        const b = await db.billingBatch.findUnique({ where: { id: batchId }, select: { customerId: true, customer: { select: { name: true } } } }).catch(() => null);
        const { notifyFgoFailed } = await import('../notifications/inapp.js');
        await notifyFgoFailed(db, { key: `fgo-failed:${row.id}`, firmName: b?.customer?.name ?? null, customerId: b?.customerId ?? null, error: msg });
      }
      log('müşteri belgesi kesilemedi', batchId, msg);
    }
  }
  return { done, failed };
}

/**
 * Kesilen parti belgesini kaydeder — işçinin başarı yolu; sonucu belirsiz kalan ve yöneticinin FGO'dan doğruladığı belge de
 * bununla yazılır (server/finance/uncertain.js, karar 209). İş satırı yalnızca hâlâ bekliyorsa SENT olur. Avans partisinde
 * karşıladığı elle ödeme kayıtları bu partiye bağlanır (karar 207).
 * @param {any} db  @param {{ batchId: string, rowId: string, doc: { series: string, number: string, link?: string | null }, now?: Date }} p
 */
export async function recordBatchIssued(db, { batchId, rowId, doc, now = new Date() }) {
  return db.$transaction(async (tx) => {
    const batch = await tx.billingBatch.findUnique({ where: { id: batchId }, include: { orders: { orderBy: { orderNo: 'asc' } }, document: true } });
    if (!batch || batch.document || batch.status === 'VOID') throw new Error('JOB_STATE');
    const job = await tx.notificationOutbox.updateMany({ where: { id: rowId, status: 'PENDING' }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
    if (job.count !== 1) throw new Error('JOB_STATE');
    const d = await tx.fgoDocument.create({ data: { batchId: batch.id, kind: batch.kind, series: doc.series, number: doc.number, issuedAt: now, link: doc.link ?? null, ...(batch.kind === 'ADVANCE' ? { basis: batch.basis ?? 'FGO' } : {}) } });
    await tx.billingBatch.update({ where: { id: batch.id }, data: { status: 'ISSUED', issuedAt: now, lastError: null } });
    let linked = [];
    if (batch.kind === 'ADVANCE' && batch.parentId) {
      // Zincirde avansı kesilen toplam: proformanın geçersiz olmayan avans partileri (bu dahil)
      const advances = await tx.billingBatch.findMany({ where: { parentId: batch.parentId, kind: 'ADVANCE', status: { not: 'VOID' } }, select: { lines: { select: { ronGross: true } } } });
      const total = advances.flatMap((a) => a.lines).reduce((s, l) => s + toCents(l.ronGross), 0n);
      linked = await linkCoveredPayments(tx, { where: { batchId: batch.parentId }, link: { advanceBatchId: batch.id }, advancedTotal: centsText(total) });
    }
    // Müşteri e-postası: belge kaydıyla aynı işlemde, belge başına bir kez (server/documents/delivery.js)
    await queueDocEmail(tx, { docId: d.id });
    const statuses = new Map((await tx.order.findMany({ where: { id: { in: batch.orders.map((o) => o.orderId) } }, select: { id: true, status: true } })).map((o) => [o.id, o.status]));
    for (const o of batch.orders) {
      await writeHistory(tx, { orderId: o.orderId, event: 'FGO_DOC_ISSUED', from: statuses.get(o.orderId), to: statuses.get(o.orderId), actorId: null, note: `${batch.kind}:${doc.series}${doc.number}` });
    }
    await writeAudit(tx, {
      action: 'FGO_DOC_ISSUED', entityType: 'BillingBatch', entityId: batch.id, userId: null,
      details: {
        kind: batch.kind, series: doc.series, number: doc.number, orders: batch.orders.map((o) => o.orderNo), fxRate: Number(batch.fxRate), fxSource: batch.fxSource, amountRonNet: Number(batch.ronNet),
        ...(batch.kind === 'ADVANCE' ? { basis: batch.basis ?? 'FGO', payments: linked } : {}),
      },
    }, { role: 'SYSTEM' });
    return d;
  });
}

/**
 * Müşterinin partileri (en yeniler önce), ekran için.
 * @param {any} db  @param {{ customerId?: string | null, take?: number }} [o]
 * @returns {Promise<any[]>}
 */
export function listBatches(db, { customerId = null, take = 30 } = {}) {
  return db.billingBatch.findMany({
    where: { kind: BATCH_KIND, ...(customerId ? { customerId } : {}) },
    orderBy: { createdAt: 'desc' },
    take,
    include: { customer: { select: { name: true } }, document: true, orders: { select: { orderId: true, orderNo: true, loadingDay: true }, orderBy: { orderNo: 'asc' } }, createdBy: { select: { name: true } } },
  });
}
