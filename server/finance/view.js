// Sipariş finans görünümü (Paket 10, karar 210) — yalnızca yönetici ekranı için veri; hesaplar mevcut tek kaynaklardan
// (orderPaymentState / chainState / advanceRisk), burada yeni kural yazılmaz. Para birimleri toplanmaz: sipariş toplamı
// teklifin para biriminde, FGO belgeleri ve ödemelerin karşılığı RON.
import { chainPayments, loadChain, orderPaymentState, advanceRisk, PROFILE_ADVANCE } from './service.js';
import { parkedJobs } from './uncertain.js';
import { toCents, centsNum } from './payments.js';

/**
 * @param {any} db  @param {string} orderId  @param {{ now?: Date }} [o]
 */
export async function orderFinanceView(db, orderId, { now = new Date() } = {}) {
  const chain = await loadChain(db, orderId);
  if (!chain) return null;
  const payments = await db.manualPayment.findMany({
    where: { orderId },
    orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }],
    include: { createdBy: { select: { name: true } }, voidedBy: { select: { name: true } }, advanceDoc: { select: { series: true, number: true } }, advanceBatch: { select: { document: { select: { series: true, number: true } } } } },
  });
  const chainList = await chainPayments(db, chain);
  let state;
  let advances;
  let batchIds = [];
  let advancePending = false;
  if (chain.kind === 'BATCH') {
    const { chainState } = await import('../glass/invoice-batch.js');
    const cs = await chainState(db, chain.batch.id);
    state = cs?.payments ?? null;
    advancePending = !!cs?.advancePending;
    advances = (cs?.batch.children ?? []).filter((c) => c.kind === 'ADVANCE').map((c) => ({
      id: c.id, ref: c.document ? `${c.document.series}${c.document.number}` : null, at: c.issuedAt ?? c.createdAt, amount: centsNum(c.lines.reduce((s, l) => s + toCents(l.ronGross), 0n)), basis: c.basis ?? 'FGO', status: c.status,
    }));
    batchIds = [chain.batch.id, ...(cs?.batch.children ?? []).map((c) => c.id)];
  } else {
    state = orderPaymentState(chain, chainList);
    advances = chain.docs.filter((d) => d.kind === 'ADVANCE').map((d) => ({ id: d.id, ref: `${d.series}${d.number}`, at: d.issuedAt, amount: Number(d.advanced ?? d.total ?? 0), basis: d.basis ?? 'FGO', status: 'ISSUED' }));
    advancePending = (await db.notificationOutbox.count({ where: { orderId, status: 'PENDING', OR: [{ type: 'FGO_GLASS', payload: { path: ['kind'], equals: 'ADVANCE' } }, { type: PROFILE_ADVANCE }] } })) > 0;
  }
  const parked = await parkedJobs(db, { orderId, batchIds: chain.kind === 'BATCH' ? batchIds : [] });
  const profile = chain.order.orderTypeCode === 'PROFILE_ORDER';
  const invoiced = chain.docs.some((d) => d.kind === 'INVOICE');
  // Profil avans faturası (karar 207): proforma var, fatura yok, kuyrukta FGO işi yok, avansı kesilecek tutar var
  const profileBusy = profile ? await db.notificationOutbox.count({ where: { orderId, status: 'PENDING', type: { in: ['FGO_PROFORMA', 'FGO_INVOICE', PROFILE_ADVANCE] } } }) : 0;
  const canProfileAdvance = profile && chain.kind === 'ORDER' && !!chain.proforma && !invoiced && !profileBusy && chain.order.status !== 'IPTAL' && (state?.advanceRequired ?? 0) > 0;
  const risk = state && state.advanceRequired > 0 && !advancePending
    ? await advanceRisk(db, { customerId: chain.order.customerId, ron: state.advanceRequired, chainKey: chain.key, now })
    : { matches: [], ackKey: '' };
  return {
    chain: { kind: chain.kind, key: chain.key, currency: chain.currency, rate: chain.rate, proforma: chain.proforma ? { ref: `${chain.proforma.series}${chain.proforma.number}`, total: chain.proforma.total == null ? null : Number(chain.proforma.total), paid: chain.proforma.paid == null ? null : Number(chain.proforma.paid) } : null, batchId: chain.batch?.id ?? null, customerId: chain.order.customerId },
    payments: payments.map((p) => ({
      id: p.id, paidOn: p.paidOn, amount: Number(p.amount), currency: p.currency, ron: Number(p.ron), rate: p.rate == null ? null : Number(p.rate), method: p.method, reference: p.reference, note: p.note,
      proformaRef: p.proformaRef, createdBy: p.createdBy?.name ?? null, createdAt: p.createdAt, voidedAt: p.voidedAt, voidedBy: p.voidedBy?.name ?? null, voidReason: p.voidReason,
      // Zincir dışı kayıt: kaydedildikten sonra sipariş başka zincire geçmiş (ör. müşteri proformasına girdi) — hesaba girmez, gösterilir
      // ya da proforma FGO'da silinip yenisi kesildi (eski proformaya kaydedilen ödeme yeni zincire tahminle taşınmaz)
      outside: chain.kind === 'BATCH' ? p.batchId !== chain.batch.id : p.batchId != null || !chain.proforma || p.proformaRef !== `${chain.proforma.series}${chain.proforma.number}`,
      advanceRef: p.advanceDoc ? `${p.advanceDoc.series}${p.advanceDoc.number}` : p.advanceBatch?.document ? `${p.advanceBatch.document.series}${p.advanceBatch.document.number}` : null,
      linked: !!(p.advanceDocId || p.advanceBatchId),
    })),
    // Siparişin kendi FGO belgeleri (sipariş başına zincir; müşteri proformasındaki belgeler proforma sayfasında)
    docs: chain.docs.map((d) => ({ id: d.id, kind: d.kind, ref: `${d.series}${d.number}`, link: d.link ?? null, issuedAt: d.issuedAt, total: d.total == null ? null : Number(d.total), paid: d.paid == null ? null : Number(d.paid), basis: d.basis ?? null })),
    state, advances, advancePending, parked, canProfileAdvance, risk, invoiced,
  };
}
