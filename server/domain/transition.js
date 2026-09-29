// transitionOrder — sipariş durumunu değiştiren TEK yol (ADR 0002).
//   1. siparişi yükle  2. eylem bu durum/tip/rol için geçerli mi  3. veriyi doğrula
//   4–8. tek veritabanı işleminde: değişikliği uygula, geçmiş, denetim, bildirim kuyruğu (outbox)
//   9. role göre temizlenmiş sonucu döndür
// Kalıcılık adımları dışarıdan verilir (deps); böylece servis veritabanı olmadan test edilir.
import { WorkflowError } from './workflow.js';
import { auditEntry } from './audit.js';
import { outboxEvent } from './outbox.js';

/**
 * @param {object} p
 * @param {{ $transaction: (fn: (tx: any) => Promise<any>) => Promise<any> }} p.db
 * @param {{ check: Function }} p.workflow
 * @param {string} p.orderId
 * @param {string} p.action
 * @param {{ id: string, role: string }} p.actor
 * @param {object} [p.payload]
 * @param {object} p.deps
 *   loadOrder(tx, id) → { id, status, orderType, version, ... } | null
 *   validate?(order, payload, actor) → hata kodu | null
 *   apply(tx, order, { to, payload, actor }) →
 *     { order, entries: [{ event, from, to, note }], audit?: object, result?: any }
 *     ya da null (sürüm çakışması: başkası aynı anda değiştirdi)
 *     Eski biçim: yalnızca güncel sipariş döndürülürse tek kayıt (eylem adıyla) yazılır.
 *   history(tx, { orderId, event, from, to, action, actorId, note })
 *   audit(tx, auditEntry)
 *   outbox: { enqueue(tx, event) }
 *   events?(applied, payload) → outboxEvent[]   (verilmezse her geçmiş kaydı için bir olay)
 *   sanitize(order, actor) → istemciye gidecek temsil
 * @returns {Promise<{ order: any, result: any, entries: any[] }>}
 */
export async function transitionOrder({ db, workflow, orderId, action, actor, payload = {}, deps }) {
  return db.$transaction(async (tx) => {
    const order = await deps.loadOrder(tx, orderId);
    if (!order) throw new WorkflowError('NOT_FOUND');

    const verdict = workflow.check({ state: order.status, orderType: order.orderType, action, actor, ctx: { order, payload } });
    if (!verdict.ok) throw new WorkflowError(verdict.code, { state: order.status, action });

    const invalid = deps.validate ? await deps.validate(order, payload, actor) : null;
    if (invalid) throw new WorkflowError(invalid);

    // Akış tanımı hedef durumu biliyorsa verir; bilmiyorsa (durum işlemin kendisine bağlıysa) mevcut durum
    const to = verdict.to ?? order.status;
    const raw = await deps.apply(tx, order, { to, payload, actor });
    if (!raw) throw new WorkflowError('CONFLICT'); // başka biri aynı anda değiştirdi (sürüm uyuşmadı)
    const applied = raw.entries
      ? raw
      : { order: raw, entries: [{ event: action, from: order.status, to: raw.status ?? to, note: payload.note ?? null }] };

    for (const e of applied.entries) {
      await deps.history(tx, { orderId: order.id, event: e.event, from: e.from ?? order.status, to: e.to ?? e.from ?? order.status, action, actorId: actor.id, note: e.note ?? null });
    }
    await deps.audit(tx, auditEntry({
      action: 'ORDER_TRANSITION', entityType: 'Order', entityId: order.id, actor,
      details: {
        action,
        events: applied.entries.map((e) => e.event),
        from: order.status,
        to: applied.order?.status ?? order.status,
        ...(applied.audit ?? {}),
      },
    }));
    const events = deps.events
      ? deps.events(applied, payload)
      : applied.entries.map((e) => outboxEvent(`ORDER_${e.event}`, { orderId: order.id, payload: { from: e.from ?? null, to: e.to ?? null } }));
    for (const e of events) await deps.outbox.enqueue(tx, e);

    return { order: deps.sanitize(applied.order, actor), result: applied.result ?? null, entries: applied.entries };
  });
}
