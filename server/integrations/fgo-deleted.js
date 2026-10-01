// FGO'da silinmiş belge (ör. deneme faturası): FGO "belge yok" dediğinde sistemdeki kaydı kaldırılır ve sipariş belgeden
// önceki hâline döner (karar 64/65). Böylece silinen belgenin siparişinde düğme yeniden çıkar ve numarası yeniden kullanılır.
//   Cam: kayıt silinir; proforma silindiyse kur ve elle girilen ödeme de sıfırlanır (yeni proforma günün kuruyla kesilir).
//   Profil: fatura silindiyse FATURALANDI → TESLIM_EDILDI ("FGO'da yeniden dene" ile yeni fatura); proforma silindiyse
//   PROFORMA → ONAYLANDI (kur sıfırlanır; "FGO'da yeniden dene" ile yeni proforma). Profil işlemi runProfileAction'dan
//   geçer (geçmiş + denetim + iyimser kilit).
// Silinmeyi bildiren e-posta işi kuyruktaysa atlanır. Geçmişe "FGO'da silindi" satırı ve denetim kaydı yazılır.
import { writeAudit, writeHistory } from '../orders/journal.js';
import { DOC_EMAIL } from '../glass/billing.js';
import { fgoActor, runProfileAction } from '../profile/transitions.js';

/**
 * @param {{ id: string, orderId: string, kind: string, series: string, number: string }} row  FgoDocument
 * @param {string} [reason]  FGO'nun yanıtı
 */
export async function removeDeletedDocument(db, row, reason = '') {
  const order = await db.order.findUnique({ where: { id: row.orderId }, select: { id: true, status: true, orderTypeCode: true } });
  const details = { kind: row.kind, series: row.series, number: row.number, reason: String(reason).slice(0, 200) };
  const skipEmails = (tx) => tx.notificationOutbox.updateMany({
    where: { type: DOC_EMAIL, status: 'PENDING', payload: { path: ['docId'], equals: row.id } },
    data: { status: 'SKIPPED', lastError: "belge FGO'da silindi" },
  });
  if (order?.orderTypeCode === 'PROFILE_ORDER') {
    await runProfileAction(db, { orderId: order.id, action: 'fgo_doc_deleted', actor: fgoActor(), payload: { docId: row.id, ...details } });
    await skipEmails(db);
    return;
  }
  await db.$transaction(async (tx) => {
    await tx.fgoDocument.delete({ where: { id: row.id } });
    await skipEmails(tx);
    if (order && row.kind === 'PROFORMA' && (await tx.fgoDocument.count({ where: { orderId: order.id } })) === 0) {
      // Proforma yoksa kur ve ödeme de yok: yeni proforma günün kuruyla, ödeme yeniden girilir
      await tx.glassBilling.updateMany({ where: { orderId: order.id }, data: { fxRate: null, fxDate: null, fxSource: null, paidAt: null, paidAmount: null, paidById: null } });
    }
    if (order) await writeHistory(tx, { orderId: order.id, event: 'FGO_DOC_DELETED', from: order.status, to: order.status, actorId: null, note: `${row.series}${row.number}` });
    await writeAudit(tx, { action: 'FGO_DOC_REMOVED', entityType: 'Order', entityId: row.orderId, userId: null, details }, { role: 'SYSTEM' });
  });
}
