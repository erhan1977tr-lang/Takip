// Müşterinin mali belgeleri ("Documente financiare" — karar 111): müşteriye açık, salt okunur bir BELGE DOLABI.
// Ayrı bir muhasebe değildir: kaynak, muhasebenin kullandığı aynı kayıttır (FgoDocument — FGO'da başarıyla kesilmiş
// belgeler); ödeme durumu mevcut FGO eşitlemesinin yazdığı değerlerden okunur (paymentStatus / receivables). Burada
// hesap yapılmaz, bakiye tutulmaz, FGO'ya istek gönderilmez.
//
// Gizlilik: belge yalnızca SAHİBİ firmaya görünür. Sahiplik sunucuda, sorgu koşulu olarak denetlenir:
//   sipariş belgesi → siparişin müşterisi · müşteri partisi belgesi → partinin müşterisi (partideki bütün siparişler
//   aynı gerçek müşterinindir — karar 100). Belge kimliği, sipariş / parti kimliği ya da adres değiştirilerek başka
//   firmanın belgesine ulaşılamaz. Kesilemeyen / bekleyen / vazgeçilen işlerin FgoDocument kaydı olmadığından müşteri
//   onları (ve FGO hatalarını) hiç görmez.
import { paymentStatus, receivables } from '../accounting/receivables.js';

/** Belge bu firmanın mı (sorgu koşulu) */
export const ownedBy = (customerId) => ({ OR: [{ order: { customerId } }, { batch: { customerId } }] });

const INCLUDE = {
  order: { select: { id: true, orderNo: true, removedAt: true } },
  batch: {
    select: {
      id: true, parentId: true, chainOrderId: true,
      orders: { select: { orderId: true, orderNo: true, order: { select: { removedAt: true } } }, orderBy: { orderNo: 'asc' } },
      lines: { select: { ronGross: true, refBatchId: true, refDocId: true } },
    },
  },
};

/**
 * Firmanın belgeleri (en yeniler önce): proforma, avans faturası, fatura — cam ve profil birlikte.
 *   payment: FGO'dan okunan ödeme durumu — UNPAID | PARTIAL | PAID | UNKNOWN (henüz okunmadı);
 *            REPLACED: yerine fatura kesilmiş proforma (muhasebedeki "faturaya döndü" ile aynı kural).
 *   orders[].id: sipariş sayfasının bağlantısı için; sipariş silinmişse (karar 110) boş — numara yine yazılır.
 * @param {any} db  @param {string | null | undefined} customerId
 * @returns {Promise<{ id: string, kind: string, ref: string, issuedAt: Date, orders: { id: string | null, orderNo: string }[],
 *   total: number | null, currency: string, payment: 'UNPAID' | 'PARTIAL' | 'PAID' | 'UNKNOWN' | 'REPLACED' }[]>}
 */
export async function customerDocuments(db, customerId) {
  if (!customerId) return [];
  const docs = await db.fgoDocument.findMany({
    where: ownedBy(customerId), orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }], include: INCLUDE, take: 500,
  });
  const { shares } = receivables(docs);
  return docs.map((d) => ({
    id: d.id,
    kind: ['ADVANCE', 'INVOICE'].includes(d.kind) ? d.kind : 'PROFORMA',
    ref: `${d.series}${d.number}`,
    issuedAt: d.issuedAt,
    orders: d.order
      ? [{ id: d.order.removedAt ? null : d.order.id, orderNo: d.order.orderNo }]
      : (d.batch?.orders ?? []).map((o) => ({ id: o.order?.removedAt ? null : o.orderId, orderNo: o.orderNo })),
    total: d.total == null ? null : Number(d.total),
    currency: d.currency,
    payment: shares.get(d.id)?.replaced ? 'REPLACED' : paymentStatus(d.total, d.paid),
  }));
}

/**
 * Tek belge — yalnızca sahibi firmaya (PDF isteği). Başka firmanın belgesi "yok" gibi davranır.
 * @returns {Promise<{ id: string, series: string, number: string, link: string | null, kind: string } | null>}
 */
export async function customerDocument(db, { docId, customerId }) {
  if (!customerId || !docId) return null;
  return db.fgoDocument.findFirst({ where: { id: String(docId), ...ownedBy(customerId) }, select: { id: true, series: true, number: true, link: true, kind: true } });
}
