// Eksik fabrika maliyetinin girilmesi (karar 93) — yalnızca yönetici (ACCOUNTING_MANAGE).
//
// Müşteriye gönderilmiş teklifte, müşterinin ödediği ama satış fiyatı (fabrika maliyeti) kayıtlı olmayan satırın
// (ör. 3.33 öncesinde yöneticinin eklediği satır, fabrika fiyat tablosunda fiyatı olmayan kalem) birim maliyeti girilir.
// Bu bir MALİYET DÜZELTMESİDİR, müşteri fiyatı düzenlemesi değildir:
//   - yalnızca OfferLine.unitPrice yazılır; müşteri fiyatı (offerPrice), müşteri tutarı ve Price değişmez;
//   - yalnızca maliyeti EKSİK satıra yazılır — kayıtlı (sıfırdan büyük) bir maliyetin üzerine yazılamaz;
//   - eski ve yeni değer, kullanıcı ve zaman denetim kaydına yazılır;
//   - sipariş onaylı bir yüklemeye girdiyse düzeltme reddedilir: onay kopyası sessizce yeniden yazılmaz (onaylı
//     yüklemenin maliyet düzeltmesi ayrı, denetimli bir muhasebe düzeltmesi olarak eklenecek).
import { can } from '../auth/permissions.js';
import { offerTotals } from '../orders/rules.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { missingCost } from './supplier.js';

/**
 * @param {any} db
 * @param {{ lineId: string, cost: number, actor: { id: string, role: string, ip?: string | null } }} p  cost: birim maliyet (> 0)
 * @returns {Promise<{ ok: true, orderId: string } | { ok: false, code: 'FORBIDDEN' | 'BAD_COST' | 'NOT_FOUND' | 'NOT_CURRENT' | 'COST_EXISTS' | 'NOT_MISSING' | 'CONFIRMED' }>}
 */
export async function correctMissingCost(db, { lineId, cost, actor }) {
  if (!can(actor?.role, 'ACCOUNTING_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  if (!(typeof cost === 'number' && cost > 0 && cost <= 1_000_000)) return { ok: false, code: 'BAD_COST' };
  return db.$transaction(async (tx) => {
    // Yükleme onayıyla aynı kilit: onay sırasında maliyet değişmez, onaydan hemen sonra da düzeltme sızmaz
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('loading-confirmation', 0))`;
    const line = await tx.offerLine.findUnique({
      where: { id: String(lineId ?? '') },
      include: { offer: { include: { order: { select: { id: true, orderNo: true, status: true, orderTypeCode: true } } } } },
    });
    if (!line || line.offer.order.orderTypeCode !== 'GLASS_ORDER') return { ok: false, code: 'NOT_FOUND' };
    const { offer } = line;
    const { order } = offer;
    // Yalnızca müşteriye gönderilmiş, geçerli (son) teklif sürümü: eski sürümler ve taslaklar bu yoldan değişmez
    const latestSent = await tx.offer.findFirst({ where: { orderId: order.id, status: 'GONDERILDI' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (offer.status !== 'GONDERILDI' || latestSent?.id !== offer.id) return { ok: false, code: 'NOT_CURRENT' };
    if (Number(line.unitPrice) > 0) return { ok: false, code: 'COST_EXISTS' };
    if (!missingCost(line)) return { ok: false, code: 'NOT_MISSING' };
    if (await tx.loadingConfirmationItem.count({ where: { orderId: order.id } })) return { ok: false, code: 'CONFIRMED' };

    // Yalnızca hâlâ 0 olan maliyet yazılır (aynı anda gelen ikinci istek hiçbir satıra uymaz)
    const done = await tx.offerLine.updateMany({ where: { id: line.id, unitPrice: 0 }, data: { unitPrice: cost.toFixed(2) } });
    if (done.count !== 1) return { ok: false, code: 'COST_EXISTS' };
    // Satış tutarı (Offer.amount) satış fiyatlarının saklı toplamıdır: yeniden hesaplanır. Müşteri tutarına dokunulmaz.
    const lines = await tx.offerLine.findMany({ where: { offerId: offer.id }, orderBy: { sortOrder: 'asc' } });
    const amount = offerTotals(lines.map((l) => ({ ...l, unitPrice: String(l.unitPrice ?? 0) }))).amount.toFixed(2);
    await tx.offer.update({ where: { id: offer.id }, data: { amount } });
    // Geçmişte tutar yazılmaz (geçmişi satış da görür); tutarlar denetim kaydında
    await writeHistory(tx, { orderId: order.id, event: 'COST_CORRECTED', from: order.status, to: order.status, actorId: actor.id, note: String(line.description).slice(0, 80) });
    await writeAudit(tx, {
      action: 'OFFER_COST_CORRECTION', entityType: 'OfferLine', entityId: line.id, userId: actor.id,
      details: {
        orderId: order.id, orderNo: order.orderNo, offerId: offer.id, line: line.description, kind: line.kind, currency: offer.currency,
        oldUnitCost: Number(line.unitPrice), newUnitCost: cost, salesAmountBefore: Number(offer.amount), salesAmountAfter: Number(amount),
        offerPriceUnchanged: line.offerPrice == null ? null : Number(line.offerPrice), offerAmountUnchanged: offer.offerAmount == null ? null : Number(offer.offerAmount),
      },
    }, actor);
    return { ok: true, orderId: order.id };
  });
}
