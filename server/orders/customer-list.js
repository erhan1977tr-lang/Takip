// Müşterinin sipariş listesi — "Active" / "Încărcate și arhivă" ayrımı ve sırası (P5 — karar 243).
//
//   Arşiv (Încărcate și arhivă):
//     - durumu kapanmış sipariş: ARSIVLENDI (arşivlendi; profil siparişinde faturalandı) ya da IPTAL (iptal) — eskisi gibi;
//     - cam siparişi: onaylı yükleme(ler) siparişin camını EKSİKSİZ kapsıyorsa (fullyLoaded — otomatik arşivin kanıt kuralı
//       loadingProof'un "CONFIRMED" yolu: yüklenen cam var, yüklenmeyen hiçbir adet açıkta / ileri güne aktarılmış beklemiyor,
//       müşterideki teklifin her camı onaylarda). Durum YUKLENDI olsa da onaylı yükleme yoksa sipariş Active'de kalır
//       (planlanan tarih ve "Yüklendi" düğmesi tek başına kanıt değildir — karar 92, 158).
//   Active: geri kalan her şey — yüklenmemiş, tarihi geçmiş (gecikmiş) sipariş ve kısmen yüklenmiş (kalanı olan) sipariş dahil.
//   Sıra: Active tahmini yükleme gününe göre ARTAN (profil siparişinde teslim günü; tarihsiz sipariş sonda), aynı günde yeni
//   olan önce; arşiv tersine (en yeni üstte).
// Görünürlük değişmez: liste sorgusu yine orderScope ile (müşteri yalnızca kendi firmasının siparişlerini görür).
import { loadingEvidence, loadingProof } from './auto-archive.js';

/** Durumuyla kapanmış sipariş (her tür) */
export const CUSTOMER_CLOSED = ['ARSIVLENDI', 'IPTAL'];
/** Onaylı yüklemesi olabilecek açık cam siparişi durumları */
const LOADABLE = ['URETIMDE', 'YUKLENDI'];

/**
 * Cam siparişi onaylı yüklemeyle eksiksiz yüklendi mi (saf). Durum yerine kayıtlar karar verir: YUKLENDI de URETIMDE de aynı
 * kanıtla değerlendirilir (loadingProof'un onay yolu).
 * @param {{ orderTypeCode: string, status: string, onHold: boolean, removedAt?: Date | null }} order
 * @param {import('./auto-archive.js').Evidence | undefined} ev
 */
export function fullyLoaded(order, ev) {
  if (order.orderTypeCode !== 'GLASS_ORDER' || !LOADABLE.includes(order.status) || !ev) return false;
  const proof = loadingProof({ ...order, status: 'URETIMDE' }, ev);
  return proof.ok && proof.via === 'CONFIRMED';
}

/**
 * Siparişin müşteri listesindeki bölümü (saf).
 * @param {{ orderTypeCode: string, status: string, onHold: boolean, removedAt?: Date | null }} order
 * @param {import('./auto-archive.js').Evidence | undefined} ev
 * @returns {'active' | 'archive'}
 */
export function customerBucket(order, ev) {
  if (CUSTOMER_CLOSED.includes(order.status)) return 'archive';
  return fullyLoaded(order, ev) ? 'archive' : 'active';
}

/** Siparişin listede sıralandığı gün: profil siparişinde teslim (alım) günü, camda tahmini yükleme günü */
export const listDay = (o) => o.profile?.pickupDate ?? o.estimatedShipDate ?? null;

/**
 * Sıralama (saf): Active → gün ARTAN, tarihsiz sonda; arşiv → gün AZALAN. Aynı günde yeni sipariş önce; son çare sipariş no.
 * @param {'active' | 'archive'} bucket
 */
export function customerOrderCompare(bucket) {
  const t = (d) => (d ? new Date(d).getTime() : null);
  return (a, b) => {
    const da = t(listDay(a)), db = t(listDay(b));
    if (da !== db) {
      if (da == null) return 1;
      if (db == null) return -1;
      return bucket === 'active' ? da - db : db - da;
    }
    const ca = t(a.createdAt) ?? 0, cb = t(b.createdAt) ?? 0;
    if (ca !== cb) return cb - ca;
    return String(a.orderNo ?? '').localeCompare(String(b.orderNo ?? ''), 'tr', { numeric: true });
  };
}

/**
 * Veritabanı sorgusunun durum koşulu: Active sekmesi kapanmamış siparişleri, arşiv sekmesi kapanmış siparişler ile onaylı
 * yükleme kaydı olan açık cam siparişlerini getirir. Son ayrım partitionCustomerOrders'tadır (kayıtlara bakar).
 * @param {'active' | 'archive'} bucket
 */
export function customerStatusWhere(bucket) {
  if (bucket === 'active') return { status: { notIn: CUSTOMER_CLOSED } };
  return {
    OR: [
      { status: { in: CUSTOMER_CLOSED } },
      { orderTypeCode: 'GLASS_ORDER', status: { in: LOADABLE }, loadedItems: { some: {} } },
    ],
  };
}

/**
 * Sorgunun getirdiği siparişlerden istenen bölümdekileri, istenen sırayla döndürür. Onaylı yükleme kaydı olan açık cam
 * siparişleri için kanıt kayıtları tek sorgu grubunda okunur (loadingEvidence — otomatik arşivle aynı okuyucu).
 * @template {{ id: string, orderTypeCode: string, status: string, onHold: boolean, removedAt?: Date | null }} T
 * @param {any} db  @param {T[]} orders  @param {'active' | 'archive'} bucket
 * @returns {Promise<T[]>}
 */
export async function partitionCustomerOrders(db, orders, bucket) {
  const candidates = orders.filter((o) => o.orderTypeCode === 'GLASS_ORDER' && LOADABLE.includes(o.status)).map((o) => o.id);
  const withItems = candidates.length
    ? new Set((await db.loadingConfirmationItem.findMany({ where: { orderId: { in: candidates } }, select: { orderId: true }, distinct: ['orderId'] })).map((r) => r.orderId))
    : new Set();
  const evidence = await loadingEvidence(db, [...withItems]);
  return orders.filter((o) => customerBucket(o, evidence.get(o.id)) === bucket).sort(customerOrderCompare(bucket));
}
