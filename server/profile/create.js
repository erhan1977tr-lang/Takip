// Yeni profil siparişi (Aşama 6). Numara: firma kodu + P + müşterinin numarası (GLAP12); cam siparişlerinden ayrı sıra.
// Sipariş doğrudan yöneticinin fiyat kuyruğuna düşer (satış ve çizim yok): teklif taslağı katalog / müşteri fiyatlarıyla
// dolu açılır (YONETIMDE); müşteri teklifi ancak yönetici "Müşteriye gönder" deyince görür.
// Paket B (karar 229): firmaya bağlı etkin fiyat listesi varsa ve her ürünün fiyatı belliyse sipariş DOĞRUDAN ONAYLANDI
// adımında açılır (yönetici teklifi ve müşteri onayı yok; fiyatların kopyası gönderilmiş teklif; FGO açıksa proforma).
import { WorkflowError } from '../domain/workflow.js';
import { outboxEvent } from '../domain/outbox.js';
import { enqueueOutbox, writeAudit, writeHistory } from '../orders/journal.js';
import { MAX_ORDER_NO, formatTypedNo, pickNumber } from '../orders/create.js';
import { slaDeadline } from '../orders/rules.js';
import { PROFILE_TYPE, cleanPhone, cleanPlate, missingPrices, optionalField, orderStatusFor, profileTotals } from './rules.js';
import { PROFILE_CURRENCY, profilePricesFor } from './pricing.js';
import { recordStockShortage } from './stock.js';
import { DEPOT_CALENDAR, dayDate, dayKeyOf, pickupProblem } from './dates.js';
import { calendarOverrides } from '../calendar/service.js';
import { fgoReady, getFgoSettings } from '../integrations/fgo.js';

/** FGO proforma kuyruk olayı (server/profile/transitions.js → FGO_PROFORMA ile aynı ad) */
const FGO_PROFORMA = 'FGO_PROFORMA';

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

/** Formun tek seferlik anahtarı (16–64 güvenli karakter); geçersiz → null (anahtarsız istek eskisi gibi çalışır) */
export const profileRequestKey = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : null);

/**
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ actor: { id: string, role: string, ip?: string | null }, firm: { id: string, prefix: string }, title: string | null,
 *   requestedNo: number, suggestedNo: number | null, items: object[], note?: string | null, draftId?: string | null,
 *   pickup?: { pickupDate?: unknown, phone?: unknown, plate?: unknown } | null, requestKey?: string | null, now?: Date }} p
 *   items: profileOrderItems() sonucu
 *   pickup / requestKey: Paket B (karar 229) — fiyat listesiyle doğrudan siparişte alış günü (zorunlu), telefon ve plaka
 *   (isteğe bağlı); formun tek seferlik anahtarı (aynı anahtar ikinci sipariş açmaz, ilk siparişi döndürür)
 */
export async function createProfileOrder(db, { actor, firm, title, requestedNo, suggestedNo = null, items, note = null, draftId = null, pickup = null, requestKey = null, now: at = null }) {
  if (!firm?.prefix) throw new WorkflowError('NO_FIRM');
  if (!Number.isInteger(requestedNo) || requestedNo <= 0 || requestedNo > MAX_ORDER_NO) throw new WorkflowError('BAD_NUMBER');
  if (!items.length) throw new WorkflowError('NO_ITEMS');
  const key = profileRequestKey(requestKey);
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-no:${firm.id}`}, 0))`;
      // Aynı form ikinci kez geldi (çift tıklama / yeniden deneme): ilk sipariş döner — ikinci sipariş, proforma, bildirim yok
      if (key) {
        const prev = await tx.profileOrder.findUnique({ where: { requestKey: key }, select: { order: { select: { id: true, orderNo: true, customerOrderNo: true, customerId: true } }, direct: true } });
        if (prev && prev.order.customerId === firm.id) return { id: prev.order.id, orderNo: prev.order.orderNo, customerOrderNo: prev.order.customerOrderNo, bumped: false, shortage: 0, direct: prev.direct, duplicate: true };
        if (prev) throw new WorkflowError('NOT_ALLOWED');
      }
      const type = await tx.orderType.findUnique({ where: { code: PROFILE_TYPE } });
      if (!type?.active) throw new WorkflowError('TYPE_INACTIVE');
      const no = await pickNumber(tx, { customerId: firm.id, orderTypeCode: PROFILE_TYPE, requestedNo, suggestedNo, format: type.numberFormat, code: firm.prefix });
      const orderNo = formatTypedNo(type.numberFormat, firm.prefix, no);
      if (draftId) {
        const draft = await tx.orderDraft.findFirst({ where: { id: draftId, customerId: firm.id, orderTypeCode: PROFILE_TYPE } });
        if (!draft) throw new WorkflowError('DRAFT_GONE');
        await tx.orderDraft.delete({ where: { id: draft.id } });
      }
      const now = at ?? new Date();
      const products = await tx.profileProduct.findMany({ where: { id: { in: items.map((i) => i.productId).filter(Boolean) } } });
      const pricing = await profilePricesFor(tx, firm.id);
      const lines = profileOfferLines(items, pricing.price, new Map(products.map((p) => [p.id, p])));
      // Doğrudan sipariş (karar 229): bağlı etkin fiyat listesi + her satırın fiyatı belli. Değilse olağan akış.
      const direct = pricing.direct && missingPrices(lines).length === 0;
      let info = null;
      if (direct) {
        const day = pickup?.pickupDate;
        if (!(day instanceof Date) || Number.isNaN(day.getTime())) throw new WorkflowError('PICKUP_MISSING');
        const overrides = await calendarOverrides(tx, DEPOT_CALENDAR, { now });
        const problem = pickupProblem(day, { now, overrides, staff: false });
        if (problem) throw new WorkflowError(problem);
        const phone = optionalField(pickup?.phone, cleanPhone);
        if (phone === undefined) throw new WorkflowError('BAD_PHONE');
        const plate = optionalField(pickup?.plate, cleanPlate);
        if (plate === undefined) throw new WorkflowError('BAD_PLATE');
        info = { pickupDate: dayDate(dayKeyOf(day)), contactPhone: phone, vehiclePlate: plate };
      }
      const amount = profileTotals(lines).amount.toFixed(2);
      const stage = direct ? 'ONAYLANDI' : 'FIYAT_BEKLIYOR';
      const status = orderStatusFor(stage);
      const order = await tx.order.create({
        data: {
          orderNo, customerOrderNo: no, orderTypeCode: PROFILE_TYPE, title, customerId: firm.id, createdById: actor.id,
          status, slaDeadline: direct ? null : slaDeadline({ status: 'YENI', createdAt: now }), estimatedShipDate: null,
          profile: {
            create: {
              stage, stageSince: now, direct, requestKey: key,
              ...(direct ? { ...info, approvedAt: now, approvedById: actor.id } : {}),
            },
          },
          profileItems: { create: items },
          offers: {
            create: {
              // Doğrudan siparişte fiyatların kopyası gönderilmiş teklif olarak saklanır (sonraki fiyat değişikliği etkilemez)
              status: direct ? 'GONDERILDI' : 'YONETIMDE', statusSince: now, ...(direct ? { sentAt: now } : {}),
              currency: PROFILE_CURRENCY, createdById: actor.id, amount: 0, offerAmount: amount,
              lines: { create: lines },
            },
          },
          ...(direct ? { price: { create: { amount, setById: actor.id } } } : {}),
          ...(note ? { notes: { create: { userId: actor.id, text: note, internal: false } } } : {}),
        },
        include: { offers: { select: { id: true } } },
      });
      await writeHistory(tx, { orderId: order.id, event: 'CREATED', from: null, to: status, actorId: actor.id });
      let fgo = false;
      if (direct) {
        await tx.profileOrder.update({ where: { orderId: order.id }, data: { approvedOfferId: order.offers[0].id } });
        await writeHistory(tx, { orderId: order.id, event: 'PROFILE_DIRECT', from: status, to: status, actorId: actor.id, note: dayKeyOf(info.pickupDate).split('-').reverse().join('.') });
        // FGO açıksa proforma kendiliğinden kesilir (işçi; onaylanan teklifle aynı yol — tek iş, sipariş başına)
        if (fgoReady(await getFgoSettings(tx))) {
          await enqueueOutbox(tx, outboxEvent(FGO_PROFORMA, { orderId: order.id, payload: { orderNo } }));
          fgo = true;
        }
      }
      await writeAudit(tx, {
        action: 'ORDER_CREATE', entityType: 'Order', entityId: order.id, userId: actor.id,
        details: {
          orderNo, type: PROFILE_TYPE, items: items.length, priceTable: pricing.tableName,
          ...(direct ? { direct: true, offerAmount: amount, pickupDate: dayKeyOf(info.pickupDate), fgo } : {}),
          ...(draftId ? { fromDraft: true } : {}), ...(no !== requestedNo ? { requestedNo, assignedNo: no } : {}),
        },
      }, actor);
      await enqueueOutbox(tx, outboxEvent('ORDER_CREATED', { orderId: order.id, payload: { orderNo, type: PROFILE_TYPE, ...(direct ? { direct: true } : {}) } }));
      // Stok yetersizliği (karar 165): sipariş ENGELLENMEZ; yetmeyen kalem varsa yöneticinin "Önemli kararlar" listesine
      // tek kayıt (gereken / mevcut / eksik) düşer — siparişin "Stok yetersiz" işareti bu açık kayıttır. Ayrı bildirim
      // yazılmaz (yeni profil siparişi yöneticiye zaten bildirilir — ORDER_CREATED). Doğrudan sipariş ONAYLANDI adımında
      // açıldığı için stok rezervesine de hemen girer (reservedLevels — karar 177).
      const stock = await recordStockShortage(tx, { orderId: order.id, orderNo, items, actor, now });
      return { id: order.id, orderNo, customerOrderNo: no, bumped: no !== requestedNo, shortage: stock.lines.length, direct, duplicate: false };
    });
  } catch (e) {
    // Eşzamanlı iki gönderim aynı anahtarla: biri yazar, öteki benzersizlikte durur → ilk sipariş döner
    if (key && e?.code === 'P2002') {
      const prev = await db.profileOrder.findUnique({ where: { requestKey: key }, select: { order: { select: { id: true, orderNo: true, customerOrderNo: true, customerId: true } }, direct: true } });
      if (prev && prev.order.customerId === firm.id) return { id: prev.order.id, orderNo: prev.order.orderNo, customerOrderNo: prev.order.customerOrderNo, bumped: false, shortage: 0, direct: prev.direct, duplicate: true };
    }
    throw e;
  }
}
