// Siparişin mali / operasyonel kilidi (fonksiyonel paket 4) — TEK kural, iki kullanıcı:
//   - price  : yöneticinin müşteriye gönderilmiş teklifin fiyatını değiştirmesi (yeni sürüm — update_offer,
//              server/orders/transitions.js). Mali belgesi kesilmiş ya da yüklemesi onaylanmış siparişin geçmiş fiyatı
//              değişmez: belge ve onay kalemi o fiyatın değişmez kopyasıdır; düzeltme (storno / düzeltme faturası) 7F-2'dir
//              ve yoktur → işlem engellenir, yöneticiye gerekçe gösterilir.
//   - remove : siparişin silinmesi (yumuşak silme — server/orders/removal.js). Silinen sipariş faturalamadan, yükleme
//              planından ve depodan düşer; mali / operasyonel geçmişi olan siparişte bu, açık süreci (fatura, avans, teslim)
//              tamamlanamaz bırakır → silme engellenir. Hiçbir kayıt fiziksel olarak silinmez.
//
// Kilit nedenleri (ekranda sabit metin: order.lock.<KOD>):
//   FGO_DOCUMENT       siparişin kendi FGO belgesi (proforma / avans / fatura)
//   BILLING_BATCH      müşteri belgesinin (müşteri proforması / faturası) etkin kapsamı
//   PENDING_DOCUMENT   kuyrukta bekleyen belge isteği ya da sonuçlanmamış müşteri belgesi partisi
//   CONFIRMED_LOADING  onaylı yükleme kalemi (yüklendi ya da yüklenmedi — değişmez kopya)
//   SHIPPED            (silme) yüklendi / arşivlendi olarak işaretlenmiş sipariş
//   PROFILE_FINANCE    (silme) profil: proforma, ödeme ya da fatura kaydı
//   PROFILE_WAREHOUSE  (silme) profil: teslim edildi (mal depodan çıktı). Depoya gönderilmiş / stoktan düşülmüş ama teslim
//                      edilmemiş profil siparişi 3.86.0'dan beri silinebilir: düşülen stok aynı işlemde geri eklenir
//                      (server/orders/removal.js, karar 281)
//   MANUAL_PAYMENT     (silme) yöneticinin elle girdiği ödeme kaydı (iptal edilmiş olsa da mali geçmiştir); (iptal) iptal
//                      edilmemiş elle ödeme kaydı
//   PAYMENT            (profil iptali) gerçekleşmiş tahsilat: "Ödeme alındı" ya da FGO'nun belgede gösterdiği ödeme
//
//   cancel (3.93.0, karar 288): siparişin İPTALİ — silmeden ayrı kural:
//     cam    : silmeyle aynı mali / yükleme nedenleri (belge, müşteri belgesi kapsamı, bekleyen belge işi, onaylı yükleme, elle
//              ödeme). Yüklenmiş / faturalanmış / mali işlemi süren sipariş iptal edilirse yüklenen mal faturalanamaz, kuyruktaki
//              iş kalıcı hataya düşer (Y1).
//     profil : ürün sahibinin kuralı — teslimden önce iptal edilebilir; proforma TEK BAŞINA engel değildir. Teslim, gerçekleşmiş
//              tahsilat (ödeme alındı / FGO'da görünen ödeme / iptal edilmemiş elle ödeme), avans ya da fatura belgesi ve
//              bekleyen FGO işi engeller (mutabakat gerekir). Depo e-postası mali iş değildir (iptal edilen siparişinki gitmez).
//              İptal FGO belgesine dokunmaz.
// Kural saf işlevdir (lockReasons); veriler loadLockFacts ile tek sorgu grubundan gelir. İşlemler kilidi kendi
// veritabanı işleminde, belge isteği / yükleme onayıyla aynı danışma kilitleri altında yeniden denetler.

/** Silmeyi geçici olarak engelleyen kuyruk işleri (önce iş bitmeli ya da vazgeçilmeli — BUSY) */
export const BUSY_JOBS = Object.freeze(['FGO_GLASS', 'FGO_PROFORMA', 'FGO_INVOICE', 'FGO_PROFILE_ADVANCE', 'WAREHOUSE_EMAIL']);
/** Profil iptalini bekleten mali işler (proforma / fatura / avans belgesi isteği) */
const PROFILE_FINANCE_JOBS = Object.freeze(['FGO_PROFORMA', 'FGO_INVOICE', 'FGO_PROFILE_ADVANCE']);
/** Fiyatı kilitleyen belge işleri (depo e-postası fiyatı etkilemez) */
const DOCUMENT_JOBS = Object.freeze(['FGO_GLASS', 'FGO_PROFORMA', 'FGO_INVOICE']);
/** Yüklendi / arşivlendi: fiziksel olarak gitmiş sipariş */
const SHIPPED_STATUSES = Object.freeze(['YUKLENDI', 'ARSIVLENDI']);

export const LOCK_CODES = Object.freeze(['FGO_DOCUMENT', 'BILLING_BATCH', 'PENDING_DOCUMENT', 'CONFIRMED_LOADING', 'SHIPPED', 'PROFILE_FINANCE', 'PROFILE_WAREHOUSE', 'MANUAL_PAYMENT', 'PAYMENT']);

const DOC_KINDS = Object.freeze(['PROFORMA', 'ADVANCE', 'INVOICE']);
const docKind = (k) => (DOC_KINDS.includes(k) ? k : 'PROFORMA');
const docRef = (d) => (d && typeof d.series === 'string' && typeof d.number === 'string' ? `${d.series}${d.number}` : null);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);

/**
 * @typedef {{ code: string, ref?: string | null, kind?: string | null }} LockReason
 * @typedef {{
 *   status: string, orderTypeCode: string,
 *   documents: { kind: string, series: string, number: string, paid?: unknown }[],
 *   batches: { kind: string, status: string, document: { series: string, number: string } | null }[],
 *   jobs: string[],
 *   payments?: number, activePayments?: number,
 *   loadingDays: (Date | string)[],
 *   profile: { proformaNo?: string | null, proformaAt?: Date | null, paidAt?: Date | null, warehouseSentAt?: Date | null,
 *     stockDeducted?: boolean | null, deliveredAt?: Date | null, invoiceNo?: string | null, invoicedAt?: Date | null } | null,
 * }} LockFacts
 */

/**
 * Kilit nedenleri (boş dizi = kilit yok). Aynı nedenin tekrarları tek satırda toplanmaz: her belge / gün ayrı görünür
 * (en çok 8 satır — ekranda uzun liste olmasın).
 * @param {LockFacts} f
 * @param {'price' | 'remove' | 'cancel'} purpose
 * @returns {LockReason[]}
 */
export function lockReasons(f, purpose) {
  if (purpose === 'cancel') return f.orderTypeCode === 'PROFILE_ORDER' ? profileCancelReasons(f) : lockReasons(f, 'remove');
  /** @type {LockReason[]} */
  const out = [];
  for (const d of f.documents ?? []) out.push({ code: 'FGO_DOCUMENT', kind: docKind(d.kind), ref: docRef(d) });
  for (const b of f.batches ?? []) {
    if (b.status === 'PENDING') out.push({ code: 'PENDING_DOCUMENT', kind: docKind(b.kind), ref: null });
    else out.push({ code: 'BILLING_BATCH', kind: docKind(b.kind), ref: docRef(b.document) });
  }
  const jobs = (f.jobs ?? []).filter((j) => (purpose === 'remove' ? BUSY_JOBS : DOCUMENT_JOBS).includes(j));
  if (jobs.length) out.push({ code: 'PENDING_DOCUMENT', kind: null, ref: null });
  for (const d of [...new Set((f.loadingDays ?? []).map(day).filter(Boolean))].sort()) out.push({ code: 'CONFIRMED_LOADING', ref: d });
  if (purpose === 'remove') {
    if (f.orderTypeCode === 'GLASS_ORDER' && SHIPPED_STATUSES.includes(f.status)) out.push({ code: 'SHIPPED', ref: null });
    const p = f.profile;
    if (p && (p.proformaNo || p.proformaAt || p.paidAt || p.invoiceNo || p.invoicedAt)) out.push({ code: 'PROFILE_FINANCE', ref: p.invoiceNo || p.proformaNo || null });
    // Teslim edilmiş (mal depodan çıkmış) sipariş silinmez: düşülen stoğu geri eklemek gerçeğe aykırı olur
    if (p && p.deliveredAt) out.push({ code: 'PROFILE_WAREHOUSE', ref: null });
    if ((f.payments ?? 0) > 0) out.push({ code: 'MANUAL_PAYMENT', ref: null });
  }
  return out.slice(0, 8);
}

/** Profil iptalinin engelleri (karar 288 — yukarıdaki kural) */
function profileCancelReasons(f) {
  /** @type {LockReason[]} */
  const out = [];
  const p = f.profile ?? {};
  const docs = f.documents ?? [];
  if (p.deliveredAt) out.push({ code: 'PROFILE_WAREHOUSE', ref: null });
  if (p.paidAt || docs.some((d) => Number(d.paid ?? 0) > 0)) out.push({ code: 'PAYMENT', ref: null });
  if ((f.activePayments ?? 0) > 0) out.push({ code: 'MANUAL_PAYMENT', ref: null });
  for (const d of docs) if (d.kind === 'ADVANCE' || d.kind === 'INVOICE') out.push({ code: 'FGO_DOCUMENT', kind: docKind(d.kind), ref: docRef(d) });
  if ((f.jobs ?? []).some((j) => PROFILE_FINANCE_JOBS.includes(j))) out.push({ code: 'PENDING_DOCUMENT', kind: null, ref: null });
  return out.slice(0, 8);
}

/** Silmeyi şimdilik engelleyen kuyruk işi var mı (BUSY): belge isteği, depo e-postası ya da sonuçlanmamış müşteri belgesi */
export const busyOf = (f) => (f.jobs ?? []).some((j) => BUSY_JOBS.includes(j)) || (f.batches ?? []).some((b) => b.status === 'PENDING');

/**
 * Kilidin verileri (tek sipariş). db: Prisma istemcisi ya da işlem (tx) — işlem içinde çağrılırsa aynı anlık görüntüyü okur.
 * @param {any} db
 * @param {string} orderId
 * @returns {Promise<LockFacts | null>}
 */
export async function loadLockFacts(db, orderId) {
  const id = String(orderId ?? '');
  const order = await db.order.findUnique({
    where: { id },
    select: {
      id: true, status: true, orderTypeCode: true,
      fgoDocuments: { select: { kind: true, series: true, number: true, paid: true }, orderBy: { issuedAt: 'asc' } },
      billingBatchOrders: { where: { activeKey: { not: null } }, select: { batch: { select: { kind: true, status: true, document: { select: { series: true, number: true } } } } } },
      profile: { select: { proformaNo: true, proformaAt: true, paidAt: true, warehouseSentAt: true, stockDeducted: true, deliveredAt: true, invoiceNo: true, invoicedAt: true } },
    },
  });
  if (!order) return null;
  const [jobs, items, payments, activePayments] = await Promise.all([
    db.notificationOutbox.findMany({ where: { orderId: id, type: { in: [...BUSY_JOBS] }, status: 'PENDING' }, select: { type: true } }),
    db.loadingConfirmationItem.findMany({ where: { orderId: id }, select: { confirmation: { select: { shipDay: true } } }, distinct: ['confirmationId'] }),
    db.manualPayment.count({ where: { orderId: id } }),
    db.manualPayment.count({ where: { orderId: id, voidedAt: null } }),
  ]);
  return {
    status: order.status,
    orderTypeCode: order.orderTypeCode,
    documents: order.fgoDocuments.map((d) => ({ kind: d.kind, series: d.series, number: d.number, paid: d.paid == null ? null : Number(d.paid) })),
    batches: order.billingBatchOrders.map((b) => b.batch).filter(Boolean).map((b) => ({ kind: b.kind, status: b.status, document: b.document ?? null })),
    jobs: jobs.map((j) => j.type),
    payments,
    activePayments,
    loadingDays: items.map((i) => i.confirmation.shipDay),
    profile: order.profile ?? null,
  };
}

/**
 * Fiyat kilidi (yönetici, gönderilmiş teklif): nedenler (boş = fiyat değiştirilebilir).
 * @param {any} db  @param {string} orderId
 * @returns {Promise<LockReason[]>}
 */
export async function priceLock(db, orderId) {
  const f = await loadLockFacts(db, orderId);
  return f ? lockReasons(f, 'price') : [];
}

/**
 * İptal kilidi (karar 288): nedenler (boş = iptal edilebilir). Cam ve profil iptali işlemin kendisinde, belge isteği / yükleme
 * onayıyla aynı danışma kilitleri altında bununla denetlenir; sayfa aynı nedenleri gösterir.
 * @param {any} db  @param {string} orderId
 * @returns {Promise<LockReason[]>}
 */
export async function cancelLock(db, orderId) {
  const f = await loadLockFacts(db, orderId);
  return f ? lockReasons(f, 'cancel') : [];
}
