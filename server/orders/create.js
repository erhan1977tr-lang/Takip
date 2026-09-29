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
 * @param {object[]} p.items          glassOrderItems() sonucu (katalogdan anlık kopya)
 * @param {object[]} p.files          yeni kaydedilmiş dosyalar (server/files/store.js → storeUpload)
 * @param {string | null} [p.note]    "Ek bilgi": müşterinin görebildiği ilk not
 * @param {string | null} [p.draftId] taslaktan gönderiliyorsa: taslağın dosyaları siparişe geçer, taslak silinir
 * @param {string[]} [p.dropDraftFileIds]  taslakta olup müşterinin çıkardığı dosyalar (siparişe geçmez)
 * @returns {Promise<{ id: string, orderNo: string, customerOrderNo: number, bumped: boolean, dropped: { storageKey: string }[] }>}
 *   dropped: işlemden sonra diskten silinecek dosyalar
 */
export async function createGlassOrder(db, { actor, firm, title, requestedNo, suggestedNo = null, items, files = [], note = null, draftId = null, dropDraftFileIds = [] }) {
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
    // Taslağın dosyaları siparişe geçer (aynı dosya, aynı tarama sonucu); taslak silinir
    let draftFiles = [];
    let dropped = [];
    if (draftId) {
      const draft = await tx.orderDraft.findFirst({ where: { id: draftId, customerId: firm.id }, include: { files: { orderBy: { createdAt: 'asc' } } } });
      if (!draft) throw new WorkflowError('DRAFT_GONE');
      draftFiles = draft.files.filter((f) => !dropDraftFileIds.includes(f.id));
      dropped = draft.files.filter((f) => dropDraftFileIds.includes(f.id));
      await tx.orderDraft.delete({ where: { id: draft.id } });
    }
    const allFiles = [...draftFiles, ...files];
    if (allFiles.length === 0) throw new WorkflowError('NO_FILES');
    const order = await tx.order.create({
      data: {
        orderNo, customerOrderNo: no, orderTypeCode: 'GLASS_ORDER', title, customerId: firm.id, createdById: actor.id,
        status: 'YENI', slaDeadline: slaDeadline({ status: 'YENI', createdAt: now }), estimatedShipDate: nextShipDate(now),
        camEtiket: firm.camEtiket ?? null, sandikEtiket: firm.sandikEtiket ?? null,
        items: { create: items },
        files: {
          create: allFiles.map((f) => ({
            name: f.name, storageKey: f.storageKey, size: f.size, mime: f.mime ?? null, checksum: f.checksum ?? null,
            scanStatus: f.scanStatus ?? 'SKIPPED', scanSignature: f.scanSignature ?? null, scannedAt: f.scannedAt ?? null,
            kind: 'CUSTOMER', uploadedById: f.uploadedById ?? actor.id,
          })),
        },
        ...(note ? { notes: { create: { userId: actor.id, text: note, internal: false } } } : {}),
      },
    });
    await writeHistory(tx, { orderId: order.id, event: 'CREATED', from: null, to: 'YENI', actorId: actor.id });
    await writeAudit(tx, {
      action: 'ORDER_CREATE', entityType: 'Order', entityId: order.id, userId: actor.id,
      details: { orderNo, files: allFiles.length, ...(draftId ? { fromDraft: true } : {}), ...(no !== requestedNo ? { requestedNo, assignedNo: no } : {}) },
    }, actor);
    await enqueueOutbox(tx, outboxEvent('ORDER_CREATED', { orderId: order.id, payload: { orderNo } }));
    return { id: order.id, orderNo, customerOrderNo: no, bumped: no !== requestedNo, dropped };
  });
}
