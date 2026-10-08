// Siparişi silme / geri yükleme (Aşama 9, karar 110; iki aşamalı onay ve mali kilit — fonksiyonel paket 4) — yalnızca
// yönetici (ORDER_CANCEL; yetki burada, sunucuda denetlenir).
//
//   "Sil" veritabanından SİLMEZ: sipariş kaydı ve ona bağlı her şey (teklif sürümleri, çizim sürümleri, dosyalar, notlar,
//   denetim kaydı, bildirimler) yerinde durur. Sipariş yalnızca olağan kullanımdan kalkar:
//     - removedAt dolar → sipariş kapsamı (server/orders/scope.js) onu hiçbir role göstermez: listeler, arama, sipariş
//       sayfası, teklifler, dosya indirme, iş akışı işlemleri;
//     - durum IPTAL olur → iptal edilmiş siparişi dışlayan her yer (yükleme planı ve onayı, aktarım, sandık, müşteri
//       proforması / faturası, sipariş başına belge, kârlılık planı, kuyruklar) onu da dışlar. Önceki durum
//       removedStatus'ta saklanır.
//   İki aşama (Paket 4): 1) önizleme — sipariş numarası, sonucu ve engeller (removalPreview, yalnızca okur); 2) ayrı son
//   onay — yönetici sipariş numarasını yazar (removeOrder; sunucu numarayı ve önizlemedeki sürümü denetler).
//   Mali / operasyonel geçmişi olan sipariş SİLİNMEZ (LOCKED + nedenler — server/orders/financial-lock.js): silinen sipariş
//   faturalamadan, yükleme planından ve depodan düştüğü için açık süreç (fatura, avans, teslim) tamamlanamaz kalırdı.
//   Kuyrukta bekleyen bir belge / depo e-postası varken de silinmez (BUSY). Silme hiçbir FGO işlemi yapmaz.
//
//   "Geri yükle": sipariş önceki durumuna döner, removedAt boşalır. Hiçbir kayıt yeniden üretilmez (silinirken hiçbir şey
//   silinmediği için çoğalacak bir şey yoktur). İki işlem de geçmişe (REMOVED / RESTORED) ve denetim kaydına yazılır;
//   engellenen silme denemesi ORDER_REMOVE_BLOCKED olarak denetime yazılır.
import { can } from '../auth/permissions.js';
import { writeAudit, writeHistory } from './journal.js';
import { refreshSla } from './transitions.js';
import { busyOf, loadLockFacts, lockReasons } from './financial-lock.js';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
/** Sipariş numarası karşılaştırması (ikinci adımın onayı): boşluk ve büyük-küçük harf farkı sayılmaz */
const sameNo = (a, b) => String(a ?? '').trim().toLocaleUpperCase('tr-TR') === String(b ?? '').trim().toLocaleUpperCase('tr-TR') && String(b ?? '').trim() !== '';

/**
 * Silme önizlemesi (1. adım — yalnızca okur): silinecek sipariş, sonucu ve silmeyi engelleyen nedenler. Son karar
 * removeOrder'da AYNI kuralla (server/orders/financial-lock.js → lockReasons 'remove'), kilit altında yeniden verilir.
 *   busy: kuyrukta bekleyen belge isteği / depo e-postası / sonuçlanmamış müşteri belgesi (önce iş bitmeli)
 *   reasons: mali / operasyonel geçmiş (FGO belgesi, müşteri belgesi kapsamı, onaylı yükleme, yüklenmiş sipariş, profilde
 *            proforma / ödeme / depo / teslim / fatura) — varsa silinmez
 * @param {any} db  @param {string} orderId
 * @returns {Promise<null | { orderNo: string, title: string | null, version: number, busy: boolean, reasons: import('./financial-lock.js').LockReason[],
 *   kept: { offers: number, drawings: number, files: number, notes: number } }>}
 */
export async function removalPreview(db, orderId) {
  const id = String(orderId ?? '');
  const order = await db.order.findUnique({
    where: { id },
    select: { orderNo: true, title: true, version: true, removedAt: true, _count: { select: { offers: true, drawings: true, files: true, notes: true } } },
  });
  if (!order || order.removedAt) return null;
  const facts = await loadLockFacts(db, id);
  if (!facts) return null;
  return {
    orderNo: order.orderNo, title: order.title ?? null, version: order.version, busy: busyOf(facts), reasons: lockReasons(facts, 'remove'),
    kept: { offers: order._count.offers, drawings: order._count.drawings, files: order._count.files, notes: order._count.notes },
  };
}

/**
 * Siparişi siler (yumuşak) — iki aşamalı onayın ikinci adımı (Paket 4). confirmNo: yöneticinin elle yazdığı sipariş
 * numarası (siparişinkiyle aynı olmalı); expectedVersion: önizlemedeki sipariş sürümü (bu arada değiştiyse STALE).
 * Engeller (kilit altında): kuyrukta iş → BUSY · mali / operasyonel geçmiş → LOCKED + nedenler (denetim kaydına da yazılır:
 * ORDER_REMOVE_BLOCKED). Hiçbir kayıt fiziksel olarak silinmez.
 * Kilit sırası belge isteği, yükleme onayı ve fiyat güncellemesiyle aynı: yükleme onayı → sipariş belgesi → sipariş satırı.
 * @param {any} db
 * @param {{ orderId: string, confirmNo: string | null | undefined, expectedVersion?: number | null, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, orderNo: string } | { ok: false, code: 'FORBIDDEN' | 'CONFIRM_REQUIRED' | 'NOT_FOUND' | 'ALREADY_REMOVED' | 'STALE' | 'BUSY' | 'LOCKED', reasons?: object[] }>}
 */
export async function removeOrder(db, { orderId, confirmNo, expectedVersion = null, actor, now = new Date() }) {
  if (!can(actor?.role, 'ORDER_CANCEL')) return fail('FORBIDDEN');
  if (!String(confirmNo ?? '').trim()) return fail('CONFIRM_REQUIRED');
  return db.$transaction(async (tx) => {
    const id = String(orderId ?? '');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('loading-confirmation', 0))`;
    // Sipariş başına belge isteğiyle aynı kilit: silme ile belge isteği birbirinin arasına giremez
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${id}`}, 0))`;
    // Sipariş satırı kilitlenir: aynı anda çalışan iş akışı işlemi (depo, teslim, ödeme …) bitene kadar beklenir, sonra
    // güncel kayıtlarla karar verilir
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id },
      select: {
        id: true, orderNo: true, status: true, version: true, removedAt: true, customerId: true, orderTypeCode: true,
        _count: { select: { offers: true, drawings: true, files: true, notes: true, compensationsFrom: true, compensationsTo: true, crateLinks: true } },
      },
    });
    if (!order) return fail('NOT_FOUND');
    if (order.removedAt) return fail('ALREADY_REMOVED');
    if (!sameNo(confirmNo, order.orderNo)) return fail('CONFIRM_REQUIRED');
    if (expectedVersion != null && Number(expectedVersion) !== order.version) return fail('STALE');
    const facts = await loadLockFacts(tx, order.id);
    if (!facts || busyOf(facts)) return fail('BUSY');
    const reasons = lockReasons(facts, 'remove');
    if (reasons.length) {
      // Engellenen deneme de denetime yazılır (yalnızca neden kodları ve belge no / gün — tutar yok)
      await writeAudit(tx, {
        action: 'ORDER_REMOVE_BLOCKED', entityType: 'Order', entityId: order.id, userId: actor.id,
        details: { orderNo: order.orderNo, status: order.status, reasons },
      }, actor);
      return fail('LOCKED', { reasons });
    }
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
        kept: {
          offers: order._count.offers, drawings: order._count.drawings, files: order._count.files, notes: order._count.notes,
          crateLinks: order._count.crateLinks, compensations: order._count.compensationsFrom + order._count.compensationsTo,
        },
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
