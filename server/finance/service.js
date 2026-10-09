// Müşteri ödemeleri — veritabanı tarafı (Paket 10, kararlar 206–208). Saf kurallar: server/finance/payments.js.
//   - Elle ödeme kaydı (recordManualPayment) ve geçersiz kılma (voidManualPayment): yalnızca yönetici (ACCOUNTING_MANAGE —
//     servis de ilk iş denetler). Kayıt tek başına hiçbir FGO belgesi kesmez, kuyruğa iş yazmaz.
//   - Zincir: sipariş başına belge zinciri (siparişin FGO proforması) ya da siparişin girdiği müşteri proforması (parti).
//     Kayıt için zincirin FGO proforması kesilmiş olmalıdır (ödemenin dayanağı ve kuru — NO_PROFORMA).
//   - Aynı müşteride aynı tutar (karar 208): eşleşme varsa kayıt / avans DURUR; yönetici gördüğü eşleşmeleri açıkça
//     onaylamadan (ackKey) yazılmaz. Onaylanan risk "Önemli kararlar"a yazılır.
//   - Kilit sırası: finance:<müşteri> → (glass-billing:<sipariş> | billing-batch:<müşteri>). Elle kayıt, geçersiz kılma ve avans
//     istekleri aynı müşteri kilidiyle sıralanır: istekte dondurulan avans tutarı bu arada değişen kayıtla bozulmaz.
import { can } from '../auth/permissions.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { getEnv } from '../env.js';
import { localDay } from '../profile/dates.js';
import {
  DUPLICATE_WINDOW_DAYS, UNVERIFIED_DAYS, VOID_REASON_MAX, ackKeyOf, centsText, coveredPaymentIds, duplicateMatches, ofProforma, parsePayment, paymentRonCents, paymentState, toCents, validRequestKey,
} from './payments.js';

export const FINANCE_PERMISSION = 'ACCOUNTING_MANAGE';
const FORBIDDEN = { ok: false, code: 'FORBIDDEN' };
const allowed = (actor) => !!actor && can(actor.role, FINANCE_PERMISSION);
/** Profil avans faturası işi (cam avansı mevcut FGO_GLASS kuyruğunda, tür ADVANCE) */
export const PROFILE_ADVANCE = 'FGO_PROFILE_ADVANCE';
/** "Önemli kararlar" türleri (server/pricing/alerts.js ALERT_TYPES'a eklenir) */
export const FINANCE_REVIEW = 'FINANCE_REVIEW';
export const DUPLICATE_RISK = 'DUPLICATE_RISK';

/** Müşteri düzeyinde finans kilidi (işlem içinde) */
export const financeLock = (tx, customerId) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finance:${customerId}`}, 0))`;

/**
 * Siparişin ödeme zinciri.
 * @returns {Promise<null | { order: any, kind: 'ORDER' | 'BATCH', key: string, batch: any | null, proforma: any | null,
 *   currency: string | null, rate: string | null, docs: any[] }>}
 */
export async function loadChain(db, orderId) {
  const order = await db.order.findUnique({
    where: { id: String(orderId ?? '') },
    select: {
      id: true, orderNo: true, orderTypeCode: true, status: true, removedAt: true, customerId: true,
      glassBilling: { select: { fxRate: true, fxSource: true } }, profile: { select: { fxRate: true, stage: true } },
      fgoDocuments: { orderBy: [{ issuedAt: 'asc' }, { seq: 'asc' }] },
      offers: { where: { status: 'GONDERILDI' }, orderBy: { createdAt: 'desc' }, take: 1, select: { currency: true } },
      billingBatchOrders: {
        where: { activeKey: { not: null }, batch: { kind: 'PROFORMA', status: { not: 'VOID' } } },
        select: { batch: { include: { document: true } } },
      },
    },
  });
  if (!order) return null;
  const batch = order.billingBatchOrders[0]?.batch ?? null;
  if (batch) {
    const currency = batch.currency;
    return { order, kind: 'BATCH', key: `batch:${batch.id}`, batch, proforma: batch.document ?? null, currency, rate: currency === 'EUR' ? batch.fxRate.toString() : null, docs: [] };
  }
  const glass = order.orderTypeCode === 'GLASS_ORDER';
  const currency = glass ? order.offers[0]?.currency ?? null : 'EUR';
  const stored = glass ? order.glassBilling?.fxRate : order.profile?.fxRate;
  const rate = currency === 'EUR' && stored != null ? stored.toString() : null;
  const proforma = order.fgoDocuments.find((d) => d.kind === 'PROFORMA') ?? null;
  return { order, kind: 'ORDER', key: `order:${order.id}`, batch: null, proforma, currency, rate, docs: order.fgoDocuments };
}

/** Zincirin elle kayıtları (geçersizler dahil — ekranda görünür, hesaba girmez) */
export function chainPayments(db, chain) {
  const where = chain.kind === 'BATCH' ? { batchId: chain.batch.id } : { orderId: chain.order.id, batchId: null };
  return db.manualPayment.findMany({ where, orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
}

/** Siparişin geçerli FGO proformasının numarası (sipariş başına zincir; avans kesilince karşılanan kayıtları bağlamak için) */
export async function orderProformaRef(tx, orderId) {
  const p = await tx.fgoDocument.findFirst({ where: { orderId, kind: 'PROFORMA' }, select: { series: true, number: true } });
  return p ? `${p.series}${p.number}` : null;
}

/** Sipariş zincirinde avansı kesilen toplam (kesilmiş avans faturaları; eski kayıtta belge toplamı) */
export const orderAdvanced = (docs) => docs.filter((d) => d.kind === 'ADVANCE').reduce((s, d) => s + toCents(d.advanced ?? d.total ?? 0), 0n);

/**
 * Müşterinin aynı tutar karşılaştırması için adaylar (son 180 gün): elle kayıtlar, sipariş başına avans faturaları,
 * avans partileri ve kuyruktaki avans istekleri. key: türü + kimliği (ör. "P:<id>").
 */
export async function customerCandidates(db, customerId, { now }) {
  const since = new Date(now.getTime() - DUPLICATE_WINDOW_DAYS * 86_400_000);
  const [payments, docs, batches, jobs] = await Promise.all([
    db.manualPayment.findMany({ where: { customerId, voidedAt: null, paidOn: { gte: since } }, include: { order: { select: { orderNo: true } } } }),
    db.fgoDocument.findMany({ where: { kind: 'ADVANCE', orderId: { not: null }, order: { customerId }, issuedAt: { gte: since } }, include: { order: { select: { orderNo: true } } } }),
    db.billingBatch.findMany({ where: { customerId, kind: 'ADVANCE', status: { not: 'VOID' }, createdAt: { gte: since } }, include: { document: true, lines: { select: { ronGross: true } } } }),
    db.notificationOutbox.findMany({
      where: { status: 'PENDING', createdAt: { gte: since }, order: { customerId }, OR: [{ type: 'FGO_GLASS', payload: { path: ['kind'], equals: 'ADVANCE' } }, { type: PROFILE_ADVANCE }] },
      include: { order: { select: { orderNo: true } } },
    }),
  ]);
  return [
    ...payments.map((p) => ({ key: `P:${p.id}`, kind: 'PAYMENT', ron: p.ron.toString(), amount: p.amount.toString(), currency: p.currency, at: p.paidOn, ref: p.reference, orderNo: p.order.orderNo, chain: p.batchId ? `batch:${p.batchId}` : `order:${p.orderId}` })),
    ...docs.map((d) => ({ key: `D:${d.id}`, kind: 'ADVANCE', ron: (d.advanced ?? d.total ?? 0).toString(), at: d.issuedAt, ref: `${d.series}${d.number}`, orderNo: d.order?.orderNo ?? null, chain: `order:${d.orderId}` })),
    ...batches.map((b) => ({ key: `B:${b.id}`, kind: b.status === 'ISSUED' ? 'ADVANCE' : 'ADVANCE_PENDING', ron: centsText(b.lines.reduce((s, l) => s + toCents(l.ronGross), 0n)), at: b.createdAt, ref: b.document ? `${b.document.series}${b.document.number}` : null, orderNo: null, chain: `batch:${b.parentId}` })),
    ...jobs.map((j) => ({ key: `J:${j.id}`, kind: 'ADVANCE_PENDING', ron: String(j.payload?.amount ?? 0), at: j.createdAt, ref: null, orderNo: j.order?.orderNo ?? null, chain: `order:${j.orderId}` })),
  ];
}

/**
 * Avans kesilince karşıladığı elle kayıtları bağlar (izlenebilirlik, karar 207): tarih sırasıyla biriken RON toplamı avansı
 * kesilen toplamı aşmayan ve henüz bağlanmamış geçerli kayıtlar. İşlem (tx) içinde çağrılır.
 * @param {any} tx  @param {{ where: object, link: { advanceDocId: string } | { advanceBatchId: string }, advancedTotal: string }} p
 * @returns {Promise<string[]>} bağlanan kayıtlar
 */
export async function linkCoveredPayments(tx, { where, link, advancedTotal }) {
  const list = await tx.manualPayment.findMany({ where, select: { id: true, ron: true, paidOn: true, createdAt: true, voidedAt: true, advanceDocId: true, advanceBatchId: true } });
  const ids = coveredPaymentIds(list.map((x) => ({ ...x, linked: !!(x.advanceDocId || x.advanceBatchId) })), advancedTotal);
  if (ids.length) await tx.manualPayment.updateMany({ where: { id: { in: ids }, advanceDocId: null, advanceBatchId: null }, data: link });
  return ids;
}

/** Ekrana / sonuca giden eşleşme (iç kimlik yok, yalnızca gösterilecek alanlar) */
const matchView = (m) => ({ key: m.key, kind: m.kind, ron: Number(m.ron), amount: m.amount == null ? null : Number(m.amount), currency: m.currency ?? 'RON', at: new Date(m.at).toISOString().slice(0, 10), ref: m.ref ?? null, orderNo: m.orderNo ?? null });

/**
 * Avans isteği için aynı tutar riski: aynı müşterinin avansları (her zincir) + BAŞKA zincirlerin elle kayıtları (bu zincirin
 * kayıtları avansın dayanağıdır, eşleşme sayılmaz).
 * @returns {Promise<{ matches: ReturnType<typeof matchView>[], ackKey: string }>}
 */
export async function advanceRisk(db, { customerId, ron, chainKey, now = new Date() }) {
  const all = await customerCandidates(db, customerId, { now });
  const list = all.filter((c) => !(c.kind === 'PAYMENT' && c.chain === chainKey));
  const matches = duplicateMatches({ ron }, list, { now });
  return { matches: matches.map(matchView), ackKey: ackKeyOf(matches) };
}

/** Onaylanan aynı tutar riski: "Önemli kararlar"a bir kayıt (iş başına tekil) */
export async function recordDuplicateAck(tx, { orderId = null, customerId = null, subject, matches, amountRon, actor, key }) {
  await tx.adminAlert.createMany({
    data: [{ type: DUPLICATE_RISK, orderId, createdById: actor.id ?? null, dedupeKey: `dup:${key}`, details: { subject, amountRon, matches, ...(customerId ? { customerId } : {}) } }],
    skipDuplicates: true,
  });
}

/**
 * Elle ödeme kaydı (yönetici). Belge kesmez. Aynı müşteride aynı tutar → DUPLICATE_RISK (eşleşmeler + onay anahtarı);
 * yönetici onaylarsa (ack = ackKey) yazılır ve risk "Önemli kararlar"a düşer.
 * @param {any} db
 * @param {{ orderId: string, input: Record<string, unknown>, requestKey: unknown, ack?: string | null, actor: any, now?: Date }} p
 * @returns {Promise<{ ok: true, id: string, duplicate: boolean } | { ok: false, code: string, matches?: any[], ackKey?: string }>}
 */
export async function recordManualPayment(db, { orderId, input, requestKey, ack = null, actor, now = new Date() }) {
  if (!allowed(actor)) return FORBIDDEN;
  if (!validRequestKey(requestKey)) return { ok: false, code: 'REQUEST_KEY' };
  const parsed = parsePayment(input, { today: localDay(now, getEnv().APP_TIMEZONE) });
  if (!parsed.ok) return { ok: false, code: parsed.code };
  const v = parsed.value;
  const head = await db.order.findUnique({ where: { id: String(orderId ?? '') }, select: { customerId: true } });
  if (!head) return { ok: false, code: 'NOT_FOUND' };
  return db.$transaction(async (tx) => {
    await financeLock(tx, head.customerId);
    const same = await tx.manualPayment.findUnique({ where: { requestKey } });
    if (same) return same.orderId === orderId ? { ok: true, id: same.id, duplicate: true } : { ok: false, code: 'REQUEST_KEY' };
    const chain = await loadChain(tx, orderId);
    if (!chain || chain.order.removedAt) return { ok: false, code: 'NOT_FOUND' };
    if (!['GLASS_ORDER', 'PROFILE_ORDER'].includes(chain.order.orderTypeCode)) return { ok: false, code: 'NOT_FOUND' };
    if (chain.order.status === 'IPTAL') return { ok: false, code: 'ORDER_STATE' };
    if (!chain.proforma) return { ok: false, code: 'NO_PROFORMA' };
    const ron = paymentRonCents(v, { rate: chain.rate });
    if (ron == null) return { ok: false, code: 'CURRENCY' };
    const candidates = await customerCandidates(tx, chain.order.customerId, { now });
    const matches = duplicateMatches({ ron: centsText(ron), amount: v.amount, currency: v.currency }, candidates, { now });
    const ackKey = ackKeyOf(matches);
    if (matches.length && ack !== ackKey) return { ok: false, code: 'DUPLICATE_RISK', matches: matches.map(matchView), ackKey };
    const rate = v.currency === 'EUR' ? chain.rate : null;
    const p = await tx.manualPayment.create({
      data: {
        orderId: chain.order.id, customerId: chain.order.customerId, batchId: chain.kind === 'BATCH' ? chain.batch.id : null,
        proformaRef: `${chain.proforma.series}${chain.proforma.number}`, paidOn: new Date(`${v.paidOn}T00:00:00Z`), amount: v.amount, currency: v.currency,
        method: v.method, reference: v.reference, note: v.note, ron: centsText(ron), rate, requestKey, createdById: actor.id, createdAt: now,
      },
    });
    await writeHistory(tx, { orderId: chain.order.id, event: 'PAYMENT_RECORDED', from: chain.order.status, to: chain.order.status, actorId: actor.id, note: null });
    await writeAudit(tx, {
      action: 'MANUAL_PAYMENT_RECORDED', entityType: 'ManualPayment', entityId: p.id, userId: actor.id,
      details: {
        orderId: chain.order.id, orderNo: chain.order.orderNo, chain: chain.key, proforma: p.proformaRef, before: null,
        after: { paidOn: v.paidOn, amount: v.amount, currency: v.currency, method: v.method, ron: centsText(ron), rate, reference: v.reference },
        ...(matches.length ? { duplicateAck: matches.map((m) => m.key) } : {}),
      },
    }, actor);
    if (matches.length) {
      await recordDuplicateAck(tx, { orderId: chain.order.id, subject: 'PAYMENT', matches: matches.map(matchView), amountRon: Number(centsText(ron)), actor, key: `payment:${p.id}` });
    }
    return { ok: true, id: p.id, duplicate: false };
  });
}

/**
 * Elle kaydı geçersiz kılar (silmez). Avans faturasına girmiş (bağlı) kayıt kılınamaz (INVOICED); zincirde kuyrukta avans
 * isteği varsa da kılınamaz (BUSY — istekte dondurulan tutar bu kayda dayanıyor olabilir).
 * @param {any} db
 * @param {{ paymentId: string, reason: unknown, actor: any, now?: Date }} p
 * @returns {Promise<{ ok: true } | { ok: false, code: string }>}
 */
export async function voidManualPayment(db, { paymentId, reason, actor, now = new Date() }) {
  if (!allowed(actor)) return FORBIDDEN;
  const why = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (!why) return { ok: false, code: 'REASON' };
  if (why.length > VOID_REASON_MAX) return { ok: false, code: 'REASON' };
  const head = await db.manualPayment.findUnique({ where: { id: String(paymentId ?? '') }, select: { customerId: true } });
  if (!head) return { ok: false, code: 'NOT_FOUND' };
  return db.$transaction(async (tx) => {
    await financeLock(tx, head.customerId);
    const p = await tx.manualPayment.findUnique({ where: { id: paymentId }, include: { order: { select: { id: true, orderNo: true, status: true } } } });
    if (!p) return { ok: false, code: 'NOT_FOUND' };
    if (p.voidedAt) return { ok: false, code: 'ALREADY_VOID' };
    if (p.advanceDocId || p.advanceBatchId) return { ok: false, code: 'INVOICED' };
    const pending = p.batchId
      ? await tx.billingBatch.count({ where: { parentId: p.batchId, kind: 'ADVANCE', status: { in: ['PENDING', 'FAILED'] } } })
      : await tx.notificationOutbox.count({ where: { orderId: p.orderId, status: 'PENDING', OR: [{ type: 'FGO_GLASS', payload: { path: ['kind'], equals: 'ADVANCE' } }, { type: PROFILE_ADVANCE }] } });
    if (pending) return { ok: false, code: 'BUSY' };
    await tx.manualPayment.update({ where: { id: p.id }, data: { voidedAt: now, voidedById: actor.id, voidReason: why } });
    await writeHistory(tx, { orderId: p.orderId, event: 'PAYMENT_VOIDED', from: p.order.status, to: p.order.status, actorId: actor.id, note: null });
    await writeAudit(tx, {
      action: 'MANUAL_PAYMENT_VOIDED', entityType: 'ManualPayment', entityId: p.id, userId: actor.id,
      details: { orderId: p.orderId, orderNo: p.order.orderNo, proforma: p.proformaRef, before: { voided: false, amount: p.amount.toString(), currency: p.currency }, after: { voided: true }, reason: why },
    }, actor);
    return { ok: true };
  });
}

/**
 * Sipariş zincirinin (sipariş başına) ödeme / avans durumu: FGO tahsilatı (proforma), elle kayıtlar, avansı kesilenler.
 * @param {{ proforma: any, docs: any[] }} chain  @param {any[]} payments
 */
export function orderPaymentState(chain, payments) {
  // Sipariş başına zincir: yalnızca geçerli proformaya kaydedilenler (ofProforma); parti zinciri chainState'te
  const own = chain.kind === 'ORDER' ? ofProforma(payments, chain.proforma) : payments;
  return paymentState({ fgoPaid: chain.proforma?.paid ?? 0, proformaTotal: chain.proforma?.total ?? null, payments: own, advanced: centsText(orderAdvanced(chain.docs)) });
}

/**
 * Profil siparişi avans faturası isteği (yönetici; karar 207 — camdaki avansla aynı kurallar, nihai faturayı BEKLETMEZ).
 * Tutar: max(FGO tahsilatı, elle kayıtlar) − avansı kesilen; istek anında, kilit altında dondurulur. Aynı müşteride aynı
 * tutar → DUPLICATE_RISK (yönetici onaylamadan kuyruğa yazılmaz).
 * @param {any} db
 * @param {{ orderId: string, ack?: string | null, actor: any, now?: Date }} p
 * @returns {Promise<{ ok: true, amount: number } | { ok: false, code: string, matches?: any[], ackKey?: string }>}
 */
export async function requestProfileAdvance(db, { orderId, ack = null, actor, now = new Date() }) {
  if (!allowed(actor)) return FORBIDDEN;
  const { getFgoSettings, fgoReady, dailyLimitReached } = await import('../integrations/fgo.js');
  const { localDayStart } = await import('../profile/dates.js');
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  if (await dailyLimitReached(db, settings, localDayStart(now, getEnv().APP_TIMEZONE))) return { ok: false, code: 'FGO_DAILY_LIMIT' };
  const head = await db.order.findUnique({ where: { id: String(orderId ?? '') }, select: { customerId: true, orderTypeCode: true } });
  if (!head || head.orderTypeCode !== 'PROFILE_ORDER') return { ok: false, code: 'NOT_FOUND' };
  return db.$transaction(async (tx) => {
    await financeLock(tx, head.customerId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${orderId}`}, 0))`;
    const chain = await loadChain(tx, orderId);
    if (!chain || chain.order.removedAt || chain.order.status === 'IPTAL') return { ok: false, code: 'NOT_ALLOWED' };
    if (!chain.proforma) return { ok: false, code: 'NO_PROFORMA' };
    if (chain.docs.some((d) => d.kind === 'INVOICE') || chain.order.profile?.stage === 'FATURALANDI') return { ok: false, code: 'NOT_ALLOWED' };
    const busy = await tx.notificationOutbox.count({ where: { orderId, status: 'PENDING', type: { in: ['FGO_PROFORMA', 'FGO_INVOICE', PROFILE_ADVANCE] } } });
    if (busy) return { ok: false, code: 'PENDING' };
    const payments = await chainPayments(tx, chain);
    const st = orderPaymentState(chain, payments);
    if (!(st.advanceRequired > 0)) return { ok: false, code: 'NOTHING_TO_ADVANCE' };
    const risk = await advanceRisk(tx, { customerId: chain.order.customerId, ron: st.advanceRequired, chainKey: chain.key, now });
    if (risk.matches.length && ack !== risk.ackKey) return { ok: false, code: 'DUPLICATE_RISK', matches: risk.matches, ackKey: risk.ackKey };
    const seq = chain.docs.filter((d) => d.kind === 'ADVANCE').reduce((m, d) => Math.max(m, d.seq ?? 1), 0) + 1;
    const job = await tx.notificationOutbox.create({
      data: { type: PROFILE_ADVANCE, orderId, payload: { kind: 'ADVANCE', orderNo: chain.order.orderNo, seq, amount: st.advanceRequired, basis: st.advanceBasis, fgoPaid: st.fgoPaid, manualRon: st.manualRon, advancedBefore: st.advanced } },
    });
    await writeHistory(tx, { orderId, event: 'FGO_DOC_REQUESTED', from: chain.order.status, to: chain.order.status, actorId: actor.id, note: 'ADVANCE' });
    await writeAudit(tx, {
      action: 'FGO_DOC_REQUEST', entityType: 'Order', entityId: orderId, userId: actor.id,
      details: { kind: 'ADVANCE', seq, basis: st.advanceBasis, fgoPaid: st.fgoPaid, manualRon: st.manualRon, advancedBefore: st.advanced, amountRon: st.advanceRequired, ...(risk.matches.length ? { duplicateAck: risk.matches.map((m) => m.key) } : {}) },
    }, actor);
    if (risk.matches.length) await recordDuplicateAck(tx, { orderId, subject: 'ADVANCE', matches: risk.matches, amountRon: st.advanceRequired, actor, key: `job:${job.id}` });
    return { ok: true, amount: st.advanceRequired };
  });
}

/**
 * Kontrol turu (işçi, saatte bir; karar 208): elle kaydı olan zincirlerde FGO ile elle kayıt uyuşmazlığı / fazla ödeme /
 * FGO'nun doğrulamadığı elle avans ve iptal edilmiş siparişin proformasına gelen FGO tahsilatı → "Önemli kararlar"
 * (FINANCE_REVIEW). Aynı durum için ikinci kayıt açılmaz (dedupeKey = zincir + tür + tutarlar). Hiçbir belge kesmez.
 * @returns {Promise<{ chains: number, created: number }>}
 */
export async function financeReviewTick(db, { now = new Date() } = {}) {
  const live = await db.manualPayment.findMany({ where: { voidedAt: null }, select: { orderId: true, batchId: true }, distinct: ['orderId', 'batchId'], take: 2000 });
  const rows = [];
  const seen = new Set();
  for (const x of live) {
    const chain = await loadChain(db, x.orderId);
    if (!chain || seen.has(chain.key)) continue;
    seen.add(chain.key);
    if ((chain.kind === 'BATCH') !== !!x.batchId) continue; // kayıt başka zincire ait (ör. sipariş sonradan partiye girdi): ekranda gösterilir
    const payments = await chainPayments(db, chain);
    let st;
    let manualAdvance = null;
    if (chain.kind === 'BATCH') {
      const { chainState } = await import('../glass/invoice-batch.js');
      const cs = await chainState(db, chain.batch.id);
      if (!cs) continue;
      st = cs.payments;
      manualAdvance = cs.batch.children.find((c) => c.kind === 'ADVANCE' && c.status === 'ISSUED' && c.basis === 'MANUAL') ?? null;
    } else {
      st = orderPaymentState(chain, payments);
      manualAdvance = chain.docs.find((d) => d.kind === 'ADVANCE' && d.basis === 'MANUAL') ?? null;
    }
    const codes = [...st.review];
    const issuedAt = manualAdvance ? new Date(manualAdvance.issuedAt ?? manualAdvance.createdAt) : null;
    if (manualAdvance && st.fgoPaid < st.manualRon && now.getTime() - issuedAt.getTime() >= UNVERIFIED_DAYS * 86_400_000) codes.push('MANUAL_UNVERIFIED');
    for (const code of codes) {
      rows.push({
        type: FINANCE_REVIEW, orderId: chain.kind === 'ORDER' ? chain.order.id : null,
        dedupeKey: `fin:${chain.key}:${code}:${toCents(st.fgoPaid)}:${toCents(st.manualRon)}`,
        details: { code, chain: chain.key, orderNo: chain.order.orderNo, proforma: chain.proforma ? `${chain.proforma.series}${chain.proforma.number}` : null, fgoPaid: st.fgoPaid, manualRon: st.manualRon, advanced: st.advanced, ...(chain.kind === 'BATCH' ? { batchId: chain.batch.id, customerId: chain.order.customerId } : {}) },
      });
    }
  }
  // İptal edilmiş / kaldırılmış siparişin proformasına FGO'da tahsilat (eşleşecek sipariş yok)
  const cancelled = await db.fgoDocument.findMany({ where: { kind: 'PROFORMA', orderId: { not: null }, paid: { gt: 0 }, order: { OR: [{ status: 'IPTAL' }, { removedAt: { not: null } }] } }, include: { order: { select: { id: true, orderNo: true } } }, take: 500 });
  for (const d of cancelled) {
    rows.push({ type: FINANCE_REVIEW, orderId: d.orderId, dedupeKey: `fin:doc:${d.id}:FGO_PAID_CANCELLED:${toCents(d.paid)}`, details: { code: 'FGO_PAID_CANCELLED', orderNo: d.order?.orderNo ?? null, proforma: `${d.series}${d.number}`, fgoPaid: Number(d.paid) } });
  }
  if (!rows.length) return { chains: seen.size, created: 0 };
  const r = await db.adminAlert.createMany({ data: rows, skipDuplicates: true });
  return { chains: seen.size, created: r.count };
}
