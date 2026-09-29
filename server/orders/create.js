// Yeni cam siparişi ve sipariş numarası (karar 5): sipariş no = firma kodu + müşterinin sipariş numarası (GLA69).
// Firma kodları benzersiz olduğu için numaralar firmalar arasında çakışmaz; firma içinde veritabanı tekilliği korur.
// Formda bir sonraki numara hazır gelir (suggestNextNo); müşteri değiştirebilir.
//   - Müşteri önerilen numarayı değiştirmediyse ve o numarayı bu arada başka bir sipariş aldıysa
//     (aynı firmadan eşzamanlı iki sipariş) bir sonraki boş numara otomatik verilir.
//   - Müşteri başka bir numara yazdıysa ve o numara kullanılıyorsa sipariş kaydedilmez (DUPLICATE_NUMBER).
// Aynı firmanın siparişleri firma bazlı bir kilitle sırayla oluşturulur (pg_advisory_xact_lock).
import { WorkflowError } from '../domain/workflow.js';
import { outboxEvent } from '../domain/outbox.js';
import { nextShipDate, slaDeadline } from './rules.js';
import { enqueueOutbox, writeAudit, writeHistory } from './journal.js';

export const MAX_ORDER_NO = 9_999_999;

/** Firmanın bir sonraki sipariş numarası (en büyük + 1). */
export async function suggestNextNo(db, customerId) {
  const last = await db.order.aggregate({ where: { customerId }, _max: { customerOrderNo: true } });
  return (last._max.customerOrderNo ?? 0) + 1;
}

/** Sipariş numarası metni: firma kodu + numara */
export const formatOrderNo = (code, no) => `${code}${no}`;

/**
 * @param {import('@prisma/client').PrismaClient} db
 * @param {object} p
 * @param {{ id: string, role: string, ip?: string | null }} p.actor
 * @param {{ id: string, prefix: string, camEtiket?: string | null, sandikEtiket?: string | null }} p.firm
 * @param {string} p.title
 * @param {number} p.requestedNo      formdaki numara
 * @param {number | null} p.suggestedNo  formun açıldığında önerdiği numara (değiştirilmediyse otomatik mod)
 * @param {{ glassName: string, camAdedi: number }[]} p.items
 * @param {object[]} p.files          kaydedilmiş dosyalar (server/files/store.js → storeUpload)
 * @returns {Promise<{ id: string, orderNo: string, customerOrderNo: number, bumped: boolean }>}
 */
export async function createGlassOrder(db, { actor, firm, title, requestedNo, suggestedNo = null, items, files = [] }) {
  if (!firm?.prefix) throw new WorkflowError('NO_FIRM');
  if (!Number.isInteger(requestedNo) || requestedNo <= 0 || requestedNo > MAX_ORDER_NO) throw new WorkflowError('BAD_NUMBER');
  const auto = suggestedNo != null && requestedNo === suggestedNo;

  return db.$transaction(async (tx) => {
    // Aynı firmanın sipariş oluşturmaları sıraya girer (işlem bitince kilit kendiliğinden kalkar)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-no:${firm.id}`}, 0))`;

    let no = requestedNo;
    const taken = await tx.order.findFirst({ where: { customerId: firm.id, customerOrderNo: no }, select: { id: true } });
    if (taken) {
      if (!auto) throw new WorkflowError('DUPLICATE_NUMBER', { orderNo: formatOrderNo(firm.prefix, no) });
      no = await suggestNextNo(tx, firm.id);
    }
    const orderNo = formatOrderNo(firm.prefix, no);
    const now = new Date();
    const order = await tx.order.create({
      data: {
        orderNo, customerOrderNo: no, orderTypeCode: 'GLASS_ORDER', title, customerId: firm.id, createdById: actor.id,
        status: 'YENI', slaDeadline: slaDeadline({ status: 'YENI', createdAt: now }), estimatedShipDate: nextShipDate(now),
        camEtiket: firm.camEtiket ?? null, sandikEtiket: firm.sandikEtiket ?? null,
        items: { create: items },
        files: {
          create: files.map((f) => ({
            name: f.name, storageKey: f.storageKey, size: f.size, mime: f.mime ?? null, checksum: f.checksum ?? null,
            scanStatus: f.scanStatus ?? 'SKIPPED', scanSignature: f.scanSignature ?? null, scannedAt: f.scannedAt ?? null,
            kind: 'CUSTOMER', uploadedById: actor.id,
          })),
        },
      },
    });
    await writeHistory(tx, { orderId: order.id, event: 'CREATED', from: null, to: 'YENI', actorId: actor.id });
    await writeAudit(tx, {
      action: 'ORDER_CREATE', entityType: 'Order', entityId: order.id, userId: actor.id,
      details: { orderNo, files: files.length, ...(no !== requestedNo ? { requestedNo, assignedNo: no } : {}) },
    }, actor);
    await enqueueOutbox(tx, outboxEvent('ORDER_CREATED', { orderId: order.id, payload: { orderNo } }));
    return { id: order.id, orderNo, customerOrderNo: no, bumped: no !== requestedNo };
  });
}
