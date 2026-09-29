// transitionOrder — sipariş durumunu değiştiren TEK yol (ADR 0002).
//   1. siparişi yükle  2. eylem bu durum/tip/rol için geçerli mi  3. veriyi doğrula
//   4–8. tek veritabanı işleminde: durumu güncelle, geçmiş, denetim, outbox
//   9. role göre temizlenmiş sonucu döndür
// Kalıcılık adımları dışarıdan verilir (deps); böylece servis veritabanı olmadan test edilir.
import { WorkflowError } from './workflow.js';
import { auditEntry } from './audit.js';
import { outboxEvent } from './outbox.js';

/**
 * @param {object} p
 * @param {{ $transaction: (fn: (tx: any) => Promise<any>) => Promise<any> }} p.db
 * @param {ReturnType<import('./workflow.js').defineWorkflow>} p.workflow
 * @param {string} p.orderId
 * @param {string} p.action
 * @param {{ id: string, role: string }} p.actor
 * @param {object} [p.payload]
 * @param {object} p.deps
 *   loadOrder(tx, id) → { id, status, orderType, version } | null
 *   validate?(order, payload, actor) → hata kodu | null
 *   apply(tx, order, { to, payload, actor }) → güncel sipariş (sürüm kontrolüyle; çakışmada null)
 *   history(tx, { orderId, from, to, action, actorId, note })
 *   audit(tx, auditEntry)
 *   outbox: { enqueue(tx, event) }
 *   events?(order, to, payload) → outboxEvent[]
 *   sanitize(order, actor) → istemciye gidecek temsil
 */
export async function transitionOrder({ db, workflow, orderId, action, actor, payload = {}, deps }) {
  return db.$transaction(async (tx) => {
    const order = await deps.loadOrder(tx, orderId);
    if (!order) throw new WorkflowError('NOT_FOUND');

    const verdict = workflow.check({ state: order.status, orderType: order.orderType, action, actor, ctx: { order, payload } });
    if (!verdict.ok) throw new WorkflowError(verdict.code, { state: order.status, action });

    const invalid = deps.validate ? await deps.validate(order, payload, actor) : null;
    if (invalid) throw new WorkflowError(invalid);

    const to = verdict.to ?? order.status;
    const updated = await deps.apply(tx, order, { to, payload, actor });
    if (!updated) throw new WorkflowError('CONFLICT'); // başka biri aynı anda değiştirdi (sürüm uyuşmadı)

    await deps.history(tx, { orderId: order.id, from: order.status, to, action, actorId: actor.id, note: payload.note ?? null });
    await deps.audit(tx, auditEntry({
      action: 'ORDER_TRANSITION', entityType: 'Order', entityId: order.id, actor,
      details: { action, from: order.status, to },
    }));
    const events = deps.events ? deps.events(updated, to, payload) : [outboxEvent(`ORDER_${action}`, { orderId: order.id })];
    for (const e of events) await deps.outbox.enqueue(tx, e);

    return deps.sanitize(updated, actor);
  });
}
