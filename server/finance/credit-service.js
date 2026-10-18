// Müşteri fazla ödemesi ve TAKİP içi mahsup — veritabanı tarafı (DÜZELTME 10 Aşama 2C, karar 295). Kurallar: credit.js (saf).
//
// Yetki: ACCOUNTING_MANAGE (yönetici, yönetici yardımcısı) — dışa açık her işlevin İLK satırı. Hiçbir işlev FGO / ANAF'a
// istek atmaz, belge / tahsilat / iade oluşturmaz, kuyruğa iş (outbox) yazmaz, e-posta göndermez; mevcut ödeme, avans ve
// fatura kayıtlarını değiştirmez. Yazan işlemler müşteri finans kilidini (financeLock — elle ödeme ve avans istekleriyle aynı)
// alır, defteri kilit altında yeniden hesaplar; tek seferlik form anahtarı (requestKey) çift gönderimi tek kayda indirir.
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { chainPayments, financeLock, loadChain, orderPaymentState } from './service.js';
import { centsText, toCents, validRequestKey } from './payments.js';
import { creditLedger, offsetCheck, parseClose, parseOffset } from './credit.js';

const PERMISSION = 'ACCOUNTING_MANAGE';
const FORBIDDEN = /** @type {const} */ ({ ok: false, code: 'FORBIDDEN' });
const allowed = (actor) => !!actor && can(actor.role, PERMISSION);
/** Bir müşteride hesaplanacak en çok zincir (fazlası: eksik toplam yerine TOO_LARGE) */
export const MAX_CHAINS = 500;

const refOf = (d) => (d ? `${d.series}${d.number}` : null);

/**
 * Müşterinin ödeme zincirleri: FGO proforması kesilmiş siparişler (sipariş başına zincir) ve etkin müşteri proforması partileri.
 * Her zincir bir kez (anahtar); durum mevcut tek kaynaklardan (orderPaymentState / chainState → paymentState).
 * @param {any} db  @param {string} customerId
 * @returns {Promise<{ ok: true, chains: import('./credit.js').ChainIn[] } | { ok: false, code: 'TOO_LARGE' }>}
 */
async function customerChains(db, customerId) {
  const orders = await db.order.findMany({
    where: {
      customerId,
      OR: [
        { fgoDocuments: { some: { kind: 'PROFORMA' } } },
        { billingBatchOrders: { some: { activeKey: { not: null }, batch: { kind: 'PROFORMA', status: { not: 'VOID' } } } } },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_CHAINS + 1,
  });
  if (orders.length > MAX_CHAINS) return { ok: false, code: 'TOO_LARGE' };
  const { chainState } = await import('../glass/invoice-batch.js');
  /** @type {Map<string, import('./credit.js').ChainIn>} */
  const byKey = new Map();
  for (const { id } of orders) {
    const chain = await loadChain(db, id);
    if (!chain || !chain.proforma) continue;
    const known = byKey.get(chain.key);
    const cancelled = !!chain.order.removedAt || chain.order.status === 'IPTAL';
    if (known) {
      known.orderIds.push(chain.order.id);
      known.orderNos.push(chain.order.orderNo);
      continue;
    }
    let st;
    if (chain.kind === 'BATCH') {
      const cs = await chainState(db, chain.batch.id);
      if (!cs) continue;
      st = cs.payments;
    } else {
      st = orderPaymentState(chain, await chainPayments(db, chain));
    }
    byKey.set(chain.key, {
      key: chain.key, ref: refOf(chain.proforma), orderIds: [chain.order.id], orderNos: [chain.order.orderNo],
      // Parti zinciri iptal sayılmaz (siparişlerinin bir kısmı iptal olsa da proforma geçerli); sipariş zinciri: siparişin durumu
      cancelled: chain.kind === 'ORDER' ? cancelled : false,
      total: chain.proforma.total == null ? null : chain.proforma.total.toString(),
      fgoPaid: st.fgoPaid, manualRon: st.manualRon, basis: st.basis, advanced: st.advanced, overpaid: st.overpaid ?? 0,
    });
  }
  return { ok: true, chains: [...byKey.values()] };
}

const offsetSelect = /** @type {const} */ ({
  id: true, sourceChain: true, sourceOrderId: true, sourceRef: true, targetChain: true, targetOrderId: true, targetRef: true, amountRon: true, note: true, status: true,
  createdAt: true, closedAt: true, closeReason: true, fgoRef: true,
  createdBy: { select: { name: true } }, closedBy: { select: { name: true } },
  sourceOrder: { select: { orderNo: true } }, targetOrder: { select: { orderNo: true } },
});
/** @typedef {import('@prisma/client').Prisma.CreditOffsetGetPayload<{ select: typeof offsetSelect }>} OffsetRow */

/**
 * Müşteri bakiyesi ekranı: zincirler, mahsup kayıtları (hepsi, geri alınanlar dahil — geçmiş), toplamlar, inceleme kodları.
 * @param {any} db  @param {string} customerId  @param {any} actor
 */
export async function customerCredit(db, customerId, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const customer = await db.customer.findUnique({ where: { id: String(customerId ?? '') }, select: { id: true, name: true, prefix: true, type: true } });
  if (!customer || customer.type !== 'CUSTOMER') return { ok: false, code: 'NOT_FOUND' };
  const ch = await customerChains(db, customer.id);
  if (!ch.ok) return ch;
  const offsets = /** @type {OffsetRow[]} */ (await db.creditOffset.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'desc' }, select: offsetSelect }));
  const ledger = creditLedger(ch.chains, offsets);
  return { ok: /** @type {const} */ (true), customer, ...ledger, offsets };
}

/**
 * Fazla ödemesi ya da mahsup kaydı olan müşteriler (liste). Aday: FGO proformasında tahsilat, geçerli elle kayıt ya da mahsup.
 * @param {any} db  @param {any} actor  @param {{ limit?: number }} [o]
 */
export async function creditCustomers(db, actor, { limit = 200 } = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const [docs, pays, offs] = await Promise.all([
    db.fgoDocument.findMany({ where: { kind: 'PROFORMA', paid: { gt: 0 } }, select: { order: { select: { customerId: true } }, batch: { select: { customerId: true } } } }),
    db.manualPayment.findMany({ where: { voidedAt: null }, select: { customerId: true }, distinct: ['customerId'] }),
    db.creditOffset.findMany({ select: { customerId: true }, distinct: ['customerId'] }),
  ]);
  const ids = new Set([...docs.map((d) => d.order?.customerId ?? d.batch?.customerId).filter(Boolean), ...pays.map((p) => p.customerId), ...offs.map((o) => o.customerId)]);
  const customers = await db.customer.findMany({ where: { id: { in: [...ids] }, type: 'CUSTOMER' }, select: { id: true, name: true, prefix: true }, orderBy: { name: 'asc' }, take: limit });
  const rows = [];
  for (const c of customers) {
    const ch = await customerChains(db, c.id);
    if (!ch.ok) { rows.push({ customer: c, tooLarge: true }); continue; }
    const offsets = await db.creditOffset.findMany({ where: { customerId: c.id }, select: { id: true, sourceChain: true, targetChain: true, amountRon: true, status: true } });
    const l = creditLedger(ch.chains, offsets);
    if (l.totals.overpaid > 0 || l.totals.offset > 0 || l.review.length || offsets.length) rows.push({ customer: c, totals: l.totals, review: l.review.length, offsets: offsets.length });
  }
  return { ok: /** @type {const} */ (true), rows };
}

/**
 * Mahsup kaydı (kural 5): kaynak zincirin kalan fazla ödemesinden, aynı müşterinin FGO proforması kesilmiş başka bir zincirine.
 * Açık onay zorunlu. FGO'ya hiçbir şey yazmaz; avans dayanağını değiştirmez.
 * @param {any} db
 * @param {{ customerId: string, sourceChain: string, targetOrderId: string, amount: unknown, note: unknown, confirm: unknown, requestKey: unknown }} v
 * @param {any} actor
 */
export async function createOffset(db, v, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  if (!validRequestKey(v.requestKey)) return { ok: false, code: 'KEY' };
  const parsed = parseOffset(v);
  if (!parsed.ok) return parsed;
  const { cents, note } = parsed.value;
  const customerId = String(v.customerId ?? '');
  const sourceChain = String(v.sourceChain ?? '');
  if (!/^(order|batch):[A-Za-z0-9_-]{8,64}$/.test(sourceChain)) return { ok: false, code: 'SOURCE_GONE' };
  return db.$transaction(async (tx) => {
    await financeLock(tx, customerId);
    const same = await tx.creditOffset.findUnique({ where: { requestKey: String(v.requestKey) }, select: { id: true, customerId: true } });
    if (same) return same.customerId === customerId ? { ok: true, id: same.id, duplicate: true } : { ok: false, code: 'KEY' };
    const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true, type: true } });
    if (!customer || customer.type !== 'CUSTOMER') return { ok: false, code: 'NOT_FOUND' };
    const target = await loadChain(tx, String(v.targetOrderId ?? ''));
    if (!target || target.order.customerId !== customerId) return { ok: false, code: 'TARGET_GONE' };
    if (target.order.removedAt || target.order.status === 'IPTAL') return { ok: false, code: 'TARGET_CANCELLED' };
    if (!target.proforma) return { ok: false, code: 'TARGET_NO_PROFORMA' };
    const ch = await customerChains(tx, customerId);
    if (!ch.ok) return ch;
    const offsets = await tx.creditOffset.findMany({ where: { customerId }, select: { id: true, sourceChain: true, targetChain: true, amountRon: true, status: true } });
    const ledger = creditLedger(ch.chains, offsets);
    const check = offsetCheck(ledger, { sourceChain, targetChain: target.key, cents });
    if (!check.ok) return check;
    const src = /** @type {any} */ (ledger.rows.find((r) => r.key === sourceChain));
    const dst = /** @type {any} */ (ledger.rows.find((r) => r.key === target.key));
    const amountRon = centsText(cents);
    const row = await tx.creditOffset.create({
      data: {
        customerId, sourceChain, sourceOrderId: src.orderIds[0], sourceRef: src.ref ?? '', targetChain: target.key, targetOrderId: target.order.id,
        targetRef: dst.ref ?? '', amountRon, note, requestKey: String(v.requestKey), createdById: actor.id,
      },
    });
    await writeAudit(tx, {
      action: 'CREDIT_OFFSET_CREATED', entityType: 'CreditOffset', entityId: row.id, userId: actor.id,
      details: {
        customerId, amountRon, note, source: { chain: sourceChain, ref: src.ref, orders: src.orderNos, overpaid: src.overpaid, remainingBefore: src.remaining },
        target: { chain: target.key, ref: dst.ref, orders: dst.orderNos, openBefore: dst.open }, fgo: false,
      },
    }, actor);
    return { ok: true, id: row.id, duplicate: false };
  });
}

/**
 * Mahsubu kapatır (kural 6): REVERSED = TAKİP'te geri alındı · FGO_RECORDED = muhasebeci FGO'ya işledi (bundan sonra FGO
 * rakamlarında; mahsup olarak sayılmaz, TAKİP'te geri alınamaz). Yalnızca ACTIVE kayıt; bir kez; gerekçe + açık onay.
 * @param {any} db  @param {{ offsetId: string, mode: 'REVERSED' | 'FGO_RECORDED', reason: unknown, confirm: unknown, fgoRef?: unknown }} v  @param {any} actor
 */
export async function closeOffset(db, v, actor, { now = new Date() } = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  if (v.mode !== 'REVERSED' && v.mode !== 'FGO_RECORDED') return { ok: false, code: 'MODE' };
  const parsed = parseClose(v, v.mode);
  if (!parsed.ok) return parsed;
  const head = await db.creditOffset.findUnique({ where: { id: String(v.offsetId ?? '') }, select: { customerId: true } });
  if (!head) return { ok: false, code: 'NOT_FOUND' };
  return db.$transaction(async (tx) => {
    await financeLock(tx, head.customerId);
    const x = await tx.creditOffset.findUnique({ where: { id: String(v.offsetId) } });
    if (!x) return { ok: false, code: 'NOT_FOUND' };
    const r = await tx.creditOffset.updateMany({ where: { id: x.id, status: 'ACTIVE' }, data: { status: v.mode, closedAt: now, closedById: actor.id, closeReason: parsed.value.reason, fgoRef: parsed.value.fgoRef } });
    if (r.count !== 1) return { ok: false, code: x.status === 'FGO_RECORDED' ? 'ALREADY_FGO' : 'ALREADY_CLOSED' };
    await writeAudit(tx, {
      action: v.mode === 'REVERSED' ? 'CREDIT_OFFSET_REVERSED' : 'CREDIT_OFFSET_FGO_RECORDED', entityType: 'CreditOffset', entityId: x.id, userId: actor.id,
      details: { customerId: x.customerId, amountRon: x.amountRon.toString(), sourceChain: x.sourceChain, sourceRef: x.sourceRef, targetChain: x.targetChain, targetRef: x.targetRef, reason: parsed.value.reason, fgoRef: parsed.value.fgoRef, declaredOnly: v.mode === 'FGO_RECORDED', fgo: false },
    }, actor);
    return { ok: true };
  });
}

/**
 * Bir siparişin zincirine bağlı mahsup kayıtları (sipariş finans kartı; yalnızca okuma). Zincir yoksa boş.
 * @param {any} db  @param {string} orderId  @param {any} actor
 */
export async function orderOffsets(db, orderId, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const chain = await loadChain(db, orderId);
  if (!chain) return { ok: /** @type {const} */ (true), key: null, customerId: null, out: [], in: [] };
  const rows = /** @type {OffsetRow[]} */ (await db.creditOffset.findMany({ where: { OR: [{ sourceChain: chain.key }, { targetChain: chain.key }] }, orderBy: { createdAt: 'desc' }, select: offsetSelect }));
  return { ok: /** @type {const} */ (true), key: chain.key, customerId: chain.order.customerId, out: rows.filter((r) => r.sourceChain === chain.key), in: rows.filter((r) => r.targetChain === chain.key) };
}

/** Test / yapı: kuruş toplamı (ekran ile aynı yuvarlama) */
export const sumRon = (rows) => Number(centsText(rows.reduce((s, r) => s + toCents(r.amountRon), 0n)));
