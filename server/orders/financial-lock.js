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
//   PROFILE_WAREHOUSE  (silme) profil: depoya gönderildi, stoktan düşüldü ya da teslim edildi
// Kural saf işlevdir (lockReasons); veriler loadLockFacts ile tek sorgu grubundan gelir. İşlemler kilidi kendi
// veritabanı işleminde, belge isteği / yükleme onayıyla aynı danışma kilitleri altında yeniden denetler.

/** Silmeyi geçici olarak engelleyen kuyruk işleri (önce iş bitmeli ya da vazgeçilmeli — BUSY) */
export const BUSY_JOBS = Object.freeze(['FGO_GLASS', 'FGO_PROFORMA', 'FGO_INVOICE', 'WAREHOUSE_EMAIL']);
/** Fiyatı kilitleyen belge işleri (depo e-postası fiyatı etkilemez) */
const DOCUMENT_JOBS = Object.freeze(['FGO_GLASS', 'FGO_PROFORMA', 'FGO_INVOICE']);
/** Yüklendi / arşivlendi: fiziksel olarak gitmiş sipariş */
const SHIPPED_STATUSES = Object.freeze(['YUKLENDI', 'ARSIVLENDI']);

export const LOCK_CODES = Object.freeze(['FGO_DOCUMENT', 'BILLING_BATCH', 'PENDING_DOCUMENT', 'CONFIRMED_LOADING', 'SHIPPED', 'PROFILE_FINANCE', 'PROFILE_WAREHOUSE']);

const DOC_KINDS = Object.freeze(['PROFORMA', 'ADVANCE', 'INVOICE']);
const docKind = (k) => (DOC_KINDS.includes(k) ? k : 'PROFORMA');
const docRef = (d) => (d && typeof d.series === 'string' && typeof d.number === 'string' ? `${d.series}${d.number}` : null);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);

/**
 * @typedef {{ code: string, ref?: string | null, kind?: string | null }} LockReason
 * @typedef {{
 *   status: string, orderTypeCode: string,
 *   documents: { kind: string, series: string, number: string }[],
 *   batches: { kind: string, status: string, document: { series: string, number: string } | null }[],
 *   jobs: string[],
 *   loadingDays: (Date | string)[],
 *   profile: { proformaNo?: string | null, proformaAt?: Date | null, paidAt?: Date | null, warehouseSentAt?: Date | null,
 *     stockDeducted?: boolean | null, deliveredAt?: Date | null, invoiceNo?: string | null, invoicedAt?: Date | null } | null,
 * }} LockFacts
 */

/**
 * Kilit nedenleri (boş dizi = kilit yok). Aynı nedenin tekrarları tek satırda toplanmaz: her belge / gün ayrı görünür
 * (en çok 8 satır — ekranda uzun liste olmasın).
 * @param {LockFacts} f
 * @param {'price' | 'remove'} purpose
 * @returns {LockReason[]}
 */
export function lockReasons(f, purpose) {
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
    if (p && (p.warehouseSentAt || p.stockDeducted || p.deliveredAt)) out.push({ code: 'PROFILE_WAREHOUSE', ref: null });
  }
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
      fgoDocuments: { select: { kind: true, series: true, number: true }, orderBy: { issuedAt: 'asc' } },
      billingBatchOrders: { where: { activeKey: { not: null } }, select: { batch: { select: { kind: true, status: true, document: { select: { series: true, number: true } } } } } },
      profile: { select: { proformaNo: true, proformaAt: true, paidAt: true, warehouseSentAt: true, stockDeducted: true, deliveredAt: true, invoiceNo: true, invoicedAt: true } },
    },
  });
  if (!order) return null;
  const [jobs, items] = await Promise.all([
    db.notificationOutbox.findMany({ where: { orderId: id, type: { in: [...BUSY_JOBS] }, status: 'PENDING' }, select: { type: true } }),
    db.loadingConfirmationItem.findMany({ where: { orderId: id }, select: { confirmation: { select: { shipDay: true } } }, distinct: ['confirmationId'] }),
  ]);
  return {
    status: order.status,
    orderTypeCode: order.orderTypeCode,
    documents: order.fgoDocuments,
    batches: order.billingBatchOrders.map((b) => b.batch).filter(Boolean).map((b) => ({ kind: b.kind, status: b.status, document: b.document ?? null })),
    jobs: jobs.map((j) => j.type),
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
