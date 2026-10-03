// Siparişi silme / geri yükleme (Aşama 9, karar 110) — yalnızca yönetici (ORDER_CANCEL; yetki burada, sunucuda denetlenir).
//
//   "Sil" veritabanından SİLMEZ: sipariş kaydı ve ona bağlı her şey (FGO belgeleri, proforma / avans / fatura, değişmez
//   yükleme onayları ve düzeltmeleri, denetim kaydı, çizim sürümleri, muhasebe kayıtları, bildirimler) yerinde durur.
//   Sipariş yalnızca olağan kullanımdan kalkar:
//     - removedAt dolar → sipariş kapsamı (server/orders/scope.js) onu hiçbir role göstermez: listeler, arama, sipariş
//       sayfası, teklifler, dosya indirme, iş akışı işlemleri;
//     - durum IPTAL olur → iptal edilmiş siparişi dışlayan her yer (yükleme planı ve onayı, aktarım, sandık, müşteri
//       proforması / faturası, sipariş başına belge, kârlılık planı, kuyruklar) onu da dışlar. Önceki durum
//       removedStatus'ta saklanır.
//   Silme hiçbir FGO işlemi yapmaz (storno / düzeltme / silme yok — 7F-2 ertelendi); kesilmiş belgeler Muhasebe'de görünmeye
//   devam eder. Kuyrukta bekleyen bir belge / depo e-postası varken silinmez (BUSY): önce o iş bitmeli ya da vazgeçilmeli.
//
//   "Geri yükle": sipariş önceki durumuna döner, removedAt boşalır. Hiçbir kayıt yeniden üretilmez (silinirken hiçbir şey
//   silinmediği için çoğalacak bir şey yoktur). İki işlem de geçmişe (REMOVED / RESTORED) ve denetim kaydına yazılır.
import { can } from '../auth/permissions.js';
import { writeAudit, writeHistory } from './journal.js';
import { refreshSla } from './transitions.js';

const fail = (code) => ({ ok: false, code });
/** Kuyrukta beklerken siparişin silinmesini engelleyen işler (belge kesimi, depo e-postası) */
const BUSY_JOBS = ['FGO_GLASS', 'FGO_PROFORMA', 'FGO_INVOICE', 'WAREHOUSE_EMAIL'];

/**
 * Siparişi siler (yumuşak). confirm: ikinci adımın açık onayı ("Bu siparişin sistemden kaldırılacağını onaylıyorum").
 * @param {any} db
 * @param {{ orderId: string, confirm: boolean, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, orderNo: string } | { ok: false, code: 'FORBIDDEN' | 'CONFIRM_REQUIRED' | 'NOT_FOUND' | 'ALREADY_REMOVED' | 'BUSY' }>}
 */
export async function removeOrder(db, { orderId, confirm, actor, now = new Date() }) {
  if (!can(actor?.role, 'ORDER_CANCEL')) return fail('FORBIDDEN');
  if (!confirm) return fail('CONFIRM_REQUIRED');
  return db.$transaction(async (tx) => {
    const id = String(orderId ?? '');
    // Sipariş başına belge isteğiyle aynı kilit: silme ile belge isteği birbirinin arasına giremez
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${id}`}, 0))`;
    const order = await tx.order.findUnique({
      where: { id },
      select: {
        id: true, orderNo: true, status: true, version: true, removedAt: true, customerId: true, orderTypeCode: true,
        _count: { select: { fgoDocuments: true, loadedItems: true, drawings: true, compensationsFrom: true, compensationsTo: true } },
        billingBatchOrders: { where: { activeKey: { not: null } }, select: { batch: { select: { status: true } } } },
      },
    });
    if (!order) return fail('NOT_FOUND');
    if (order.removedAt) return fail('ALREADY_REMOVED');
    const queued = await tx.notificationOutbox.count({ where: { orderId: order.id, type: { in: BUSY_JOBS }, status: 'PENDING' } });
    if (queued > 0 || order.billingBatchOrders.some((b) => b.batch?.status === 'PENDING')) return fail('BUSY');
    await tx.order.update({
      where: { id: order.id },
      data: { removedAt: now, removedById: actor.id, removedStatus: order.status, status: 'IPTAL', slaDeadline: null, version: { increment: 1 } },
    });
    await writeHistory(tx, { orderId: order.id, event: 'REMOVED', from: order.status, to: 'IPTAL', actorId: actor.id });
    await writeAudit(tx, {
      action: 'ORDER_REMOVED', entityType: 'Order', entityId: order.id, userId: actor.id,
      details: {
        orderNo: order.orderNo, customerId: order.customerId, orderType: order.orderTypeCode, statusBefore: order.status,
        // Korunan kayıtların sayısı (hiçbiri silinmedi / değişmedi)
        kept: { fgoDocuments: order._count.fgoDocuments, loadingItems: order._count.loadedItems, drawings: order._count.drawings, billingBatches: order.billingBatchOrders.length, compensations: order._count.compensationsFrom + order._count.compensationsTo },
      },
    }, actor);
    return { ok: true, orderNo: order.orderNo };
  });
}

/**
 * Silinmiş siparişi geri yükler: önceki durumuna döner. Hiçbir kayıt yeniden üretilmez.
 * @param {any} db
 * @param {{ orderId: string, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, orderNo: string, status: string } | { ok: false, code: 'FORBIDDEN' | 'NOT_FOUND' | 'NOT_REMOVED' }>}
 */
export async function restoreOrder(db, { orderId, actor }) {
  if (!can(actor?.role, 'ORDER_CANCEL')) return fail('FORBIDDEN');
  return db.$transaction(async (tx) => {
    const id = String(orderId ?? '');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${id}`}, 0))`;
    const order = await tx.order.findUnique({ where: { id }, select: { id: true, orderNo: true, status: true, removedAt: true, removedStatus: true, orderTypeCode: true } });
    if (!order) return fail('NOT_FOUND');
    if (!order.removedAt) return fail('NOT_REMOVED');
    const status = order.removedStatus ?? order.status;
    await tx.order.update({
      where: { id: order.id },
      data: { removedAt: null, removedById: null, removedStatus: null, status, version: { increment: 1 } },
    });
    // Cam siparişinde SLA son tarihi güncel duruma göre yeniden hesaplanır (profil siparişinin SLA'sı kendi akışındadır)
    if (order.orderTypeCode === 'GLASS_ORDER') await refreshSla(tx, order.id);
    await writeHistory(tx, { orderId: order.id, event: 'RESTORED', from: 'IPTAL', to: status, actorId: actor.id });
    await writeAudit(tx, { action: 'ORDER_RESTORED', entityType: 'Order', entityId: order.id, userId: actor.id, details: { orderNo: order.orderNo, status } }, actor);
    return { ok: true, orderNo: order.orderNo, status };
  });
}

/** Silinmiş siparişler (yönetici ekranı: geri yükleme). En yeniler önce. */
export function removedOrders(db, { take = 50 } = {}) {
  return db.order.findMany({
    where: { removedAt: { not: null } },
    orderBy: { removedAt: 'desc' },
    take,
    select: {
      id: true, orderNo: true, title: true, orderTypeCode: true, removedAt: true, removedStatus: true,
      customer: { select: { name: true } }, removedBy: { select: { name: true } },
      _count: { select: { fgoDocuments: true } },
    },
  });
}
