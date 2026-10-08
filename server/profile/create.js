// Yeni profil siparişi (Aşama 6). Numara: firma kodu + P + müşterinin numarası (GLAP12); cam siparişlerinden ayrı sıra.
// Sipariş doğrudan yöneticinin fiyat kuyruğuna düşer (satış ve çizim yok): teklif taslağı katalog / müşteri fiyatlarıyla
// dolu açılır (YONETIMDE); müşteri teklifi ancak yönetici "Müşteriye gönder" deyince görür.
import { WorkflowError } from '../domain/workflow.js';
import { outboxEvent } from '../domain/outbox.js';
import { enqueueOutbox, writeAudit, writeHistory } from '../orders/journal.js';
import { MAX_ORDER_NO, formatTypedNo, pickNumber } from '../orders/create.js';
import { slaDeadline } from '../orders/rules.js';
import { PROFILE_TYPE, profileTotals } from './rules.js';
import { PROFILE_CURRENCY, profilePricesFor } from './pricing.js';
import { recordStockShortage } from './stock.js';

/**
 * Teklif satırları: sipariş kalemleri + fiyatları (liste ya da müşteri tablosu). listPrice = kaynağın fiyatı,
 * offerPrice = yöneticinin değiştirebileceği müşteri fiyatı (başta aynı).
 * @param {{ productId: string | null, code: string, nameRo: string, nameTr: string, unitCode: string, qty: number }[]} items
 * @param {(p: { id: string, listPrice: unknown }) => number | null} priceOf
 * @param {Map<string, { id: string, listPrice: unknown }>} products
 */
export function profileOfferLines(items, priceOf, products) {
  return items.map((it, i) => {
    const p = it.productId ? products.get(it.productId) : undefined;
    const price = p ? priceOf(p) : null;
    return {
      sortOrder: i, kind: 'PROFIL', description: it.nameTr, descriptionRo: it.nameRo, poz: it.code, adet: it.qty, unit: 'adet',
      unitCode: it.unitCode, profileProductId: it.productId, unitPrice: 0,
      listPrice: price == null ? null : price.toFixed(2), offerPrice: price == null ? null : price.toFixed(2),
    };
  });
}

/**
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ actor: { id: string, role: string, ip?: string | null }, firm: { id: string, prefix: string }, title: string | null,
 *   requestedNo: number, suggestedNo: number | null, items: object[], note?: string | null, draftId?: string | null }} p
 *   items: profileOrderItems() sonucu
 */
export async function createProfileOrder(db, { actor, firm, title, requestedNo, suggestedNo = null, items, note = null, draftId = null }) {
  if (!firm?.prefix) throw new WorkflowError('NO_FIRM');
  if (!Number.isInteger(requestedNo) || requestedNo <= 0 || requestedNo > MAX_ORDER_NO) throw new WorkflowError('BAD_NUMBER');
  if (!items.length) throw new WorkflowError('NO_ITEMS');
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-no:${firm.id}`}, 0))`;
    const type = await tx.orderType.findUnique({ where: { code: PROFILE_TYPE } });
    if (!type?.active) throw new WorkflowError('TYPE_INACTIVE');
    const no = await pickNumber(tx, { customerId: firm.id, orderTypeCode: PROFILE_TYPE, requestedNo, suggestedNo, format: type.numberFormat, code: firm.prefix });
    const orderNo = formatTypedNo(type.numberFormat, firm.prefix, no);
    if (draftId) {
      const draft = await tx.orderDraft.findFirst({ where: { id: draftId, customerId: firm.id, orderTypeCode: PROFILE_TYPE } });
      if (!draft) throw new WorkflowError('DRAFT_GONE');
      await tx.orderDraft.delete({ where: { id: draft.id } });
    }
    const now = new Date();
    const products = await tx.profileProduct.findMany({ where: { id: { in: items.map((i) => i.productId).filter(Boolean) } } });
    const pricing = await profilePricesFor(tx, firm.id);
    const lines = profileOfferLines(items, pricing.price, new Map(products.map((p) => [p.id, p])));
    const order = await tx.order.create({
      data: {
        orderNo, customerOrderNo: no, orderTypeCode: PROFILE_TYPE, title, customerId: firm.id, createdById: actor.id,
        status: 'YENI', slaDeadline: slaDeadline({ status: 'YENI', createdAt: now }), estimatedShipDate: null,
        profile: { create: { stage: 'FIYAT_BEKLIYOR', stageSince: now } },
        profileItems: { create: items },
        offers: {
          create: {
            status: 'YONETIMDE', statusSince: now, currency: PROFILE_CURRENCY, createdById: actor.id,
            amount: 0, offerAmount: profileTotals(lines).amount.toFixed(2),
            lines: { create: lines },
          },
        },
        ...(note ? { notes: { create: { userId: actor.id, text: note, internal: false } } } : {}),
      },
    });
    await writeHistory(tx, { orderId: order.id, event: 'CREATED', from: null, to: 'YENI', actorId: actor.id });
    await writeAudit(tx, {
      action: 'ORDER_CREATE', entityType: 'Order', entityId: order.id, userId: actor.id,
      details: {
        orderNo, type: PROFILE_TYPE, items: items.length, priceTable: pricing.tableName,
        ...(draftId ? { fromDraft: true } : {}), ...(no !== requestedNo ? { requestedNo, assignedNo: no } : {}),
      },
    }, actor);
    await enqueueOutbox(tx, outboxEvent('ORDER_CREATED', { orderId: order.id, payload: { orderNo, type: PROFILE_TYPE } }));
    // Stok yetersizliği (karar 165): sipariş ENGELLENMEZ; yetmeyen kalem varsa yöneticinin "Önemli kararlar" listesine
    // tek kayıt (gereken / mevcut / eksik) düşer — siparişin "Stok yetersiz" işareti bu açık kayıttır. Ayrı bildirim
    // yazılmaz (yeni profil siparişi yöneticiye zaten bildirilir — ORDER_CREATED).
    const stock = await recordStockShortage(tx, { orderId: order.id, orderNo, items, actor, now });
    return { id: order.id, orderNo, customerOrderNo: no, bumped: no !== requestedNo, shortage: stock.lines.length };
  });
}
