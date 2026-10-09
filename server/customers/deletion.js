// Müşteri firmasını silme (Paket A, karar 221) — Yönetici ve Yönetici Yardımcısı (CUSTOMER_DELETE; yetki burada, sunucuda).
//
// Amaç: canlıya geçmeden önce açılmış TEST müşterilerini, yalnızca kendilerine ait kayıtlarla birlikte kaldırmak. Toplu
// silme YOKTUR: her firma ayrı ayrı, önizleme + elle yazılan firma adıyla son onay. Hiçbir migration bir şey silmez.
//
// Silinen (yalnızca bu firmanın): siparişleri (telafi siparişleri dahil) ve onlara bağlı teklif sürümleri, teklif satırları,
// fiyat kaydı, istenen camlar, çizim sürümleri, çizim dosyaları ve revizyon notları, sipariş dosyaları, notlar, okunma
// işaretleri, geçmiş, telafi kayıtları, sandıkları ve sandık bağları, profil sipariş kalemleri, siparişlerin bildirimleri
// (zil), kuyruktaki bildirim olayları ve "Önemli kararlar" uyarıları, taslak siparişler ve taslak dosyaları. Firmanın
// kullanıcıları ANONİMLEŞTİRİLİR (server/users/lifecycle.js → anonymizeUser; denetim kaydı değiştirilemediği için satır
// kalır). Diskteki dosyalar işlem başarıyla bittikten SONRA silinir — yalnızca artık hiçbir kaydın göstermediği dosyalar.
// Denetim kaydı (AuditLog) hiçbir zaman silinmez; silme işleminin kendisi de denetime yazılır (CUSTOMER_DELETED).
//
// Engeller (biri varsa HİÇBİR ŞEY silinmez — nedenler gösterilir):
//   - fabrika firması (iç ekip; yönetici hesapları buradadır);
//   - resmî belge izi: FGO belgesi (sipariş ya da müşteri belgesi), müşteri belge partisi (her durumda), herhangi bir FGO
//     kuyruk işi, cam belge kaydı (GlassBilling — belge istenmiş), profil siparişinde proforma / fatura / kur;
//     "gerçek FGO / ANAF sistemine gönderilmiş belge" normal test verisi sayılmaz (ürün sahibinin kuralı);
//   - değiştirilemez kayıtlar: elle ödeme kaydı, onaylı yükleme satırı, aktarım (replan), teslim fotoğrafı / raporu,
//     stok hareketi (depoya gitmiş profil siparişi);
//   - başka müşteriye bağ: başka firmanın siparişi bu firmayı yük ev sahibi seçmiş (guestHostId) ya da bu firmanın
//     sandığında başka firmanın siparişi var (ortak yükleme / paylaşılan sandık).
// Kilit sırası (mevcut yazıcılarla aynı yön): yükleme onayı → finans → müşteri belge partisi → sipariş numarası → sipariş
// belgeleri (sıralı) → firma satırı.
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { anonymizeUser } from '../users/lifecycle.js';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const allowed = (actor) => !!actor?.id && can(actor.role, 'CUSTOMER_DELETE');
/** Firma adı karşılaştırması (son onay): boşluk ve büyük-küçük harf farkı sayılmaz */
const sameName = (a, b) => String(a ?? '').trim().toLocaleUpperCase('tr-TR') === String(b ?? '').trim().toLocaleUpperCase('tr-TR') && String(b ?? '').trim() !== '';

/**
 * Silmeyi engelleyen nedenler (saf). @param {ReturnType<typeof emptyFacts>} f
 * @returns {{ code: string, n: number }[]}
 */
export function deletionBlockers(f) {
  const out = [];
  const add = (code, n) => { if (n > 0) out.push({ code, n }); };
  if (f.factory) out.push({ code: 'FACTORY', n: 1 });
  add('FGO_DOCUMENT', f.fgoDocuments);
  add('BILLING_BATCH', f.billingBatches);
  add('FGO_JOB', f.fgoJobs);
  add('GLASS_BILLING', f.glassBillings);
  add('PROFILE_DOCUMENT', f.profileDocuments);
  add('MANUAL_PAYMENT', f.manualPayments);
  add('LOADING_CONFIRMED', f.loadingItems);
  add('LOADING_REPLAN', f.replans);
  add('DELIVERY_RECORD', f.deliveryRecords);
  add('STOCK_MOVEMENT', f.stockMovements);
  add('HOSTS_OTHER_CUSTOMER', f.hostedOrders);
  add('SHARED_CRATE', f.sharedCrates);
  return out;
}

export function emptyFacts() {
  return {
    factory: false, fgoDocuments: 0, billingBatches: 0, fgoJobs: 0, glassBillings: 0, profileDocuments: 0, manualPayments: 0,
    loadingItems: 0, replans: 0, deliveryRecords: 0, stockMovements: 0, hostedOrders: 0, sharedCrates: 0,
  };
}

/**
 * Firmanın silme bilgileri: engeller ve silinecek kayıtların sayısı. db ya da işlem (tx) verilebilir.
 * @param {any} db @param {string} customerId
 */
export async function deletionFacts(db, customerId) {
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true, prefix: true, type: true } });
  if (!customer) return null;
  const orders = await db.order.findMany({ where: { customerId }, select: { id: true, orderNo: true } });
  const ids = orders.map((o) => o.id);
  const inOrders = { orderId: { in: ids } };
  const crates = await db.crate.findMany({ where: { OR: [{ customerId }, { orderId: { in: ids } }] }, select: { id: true } });
  const crateIds = crates.map((c) => c.id);
  const [
    fgoDocuments, billingBatches, fgoJobs, glassBillings, profileDocuments, manualPayments, loadingItems, replans, photos, reports,
    stockMovements, hostedOrders, sharedCrates,
    offers, drawings, files, notes, events, compensations, drafts, users, notifications, outbox, alerts,
  ] = await Promise.all([
    db.fgoDocument.count({ where: { OR: [inOrders, { batch: { customerId } }] } }),
    db.billingBatch.count({ where: { customerId } }),
    db.notificationOutbox.count({ where: { type: { startsWith: 'FGO' }, ...inOrders } }), // müşteri partisinin işleri: parti zaten engel
    db.glassBilling.count({ where: inOrders }),
    db.profileOrder.count({ where: { ...inOrders, OR: [{ proformaNo: { not: null } }, { invoiceNo: { not: null } }, { fxRate: { not: null } }, { stockDeducted: true }] } }),
    db.manualPayment.count({ where: { OR: [{ customerId }, inOrders] } }),
    db.loadingConfirmationItem.count({ where: { OR: [{ customerId }, inOrders] } }),
    db.loadingReplan.count({ where: { OR: [{ customerId }, inOrders] } }),
    db.deliveryPhoto.count({ where: inOrders }),
    db.deliveryReport.count({ where: inOrders }),
    db.stockMovement.count({ where: inOrders }),
    db.order.count({ where: { guestHostId: customerId, customerId: { not: customerId } } }),
    db.crateOrder.count({ where: { crateId: { in: crateIds }, order: { customerId: { not: customerId } } } }),
    db.offer.count({ where: inOrders }),
    db.drawing.count({ where: inOrders }),
    db.orderFile.count({ where: inOrders }),
    db.orderNote.count({ where: inOrders }),
    db.orderEvent.count({ where: inOrders }),
    db.compensation.count({ where: { OR: [{ customerId }, { sourceOrderId: { in: ids } }, { destOrderId: { in: ids } }] } }),
    db.orderDraft.count({ where: { customerId } }),
    db.user.count({ where: { customerId, deletedAt: null } }),
    db.notification.count({ where: inOrders }),
    db.notificationOutbox.count({ where: inOrders }),
    db.adminAlert.count({ where: inOrders }),
  ]);
  const facts = {
    ...emptyFacts(),
    factory: customer.type === 'FACTORY',
    fgoDocuments, billingBatches, fgoJobs, glassBillings, profileDocuments, manualPayments, loadingItems, replans,
    deliveryRecords: photos + reports, stockMovements, hostedOrders, sharedCrates,
  };
  const counts = { orders: ids.length, offers, drawings, files, notes, events, compensations, crates: crateIds.length, drafts, users, notifications, outbox, alerts };
  return { customer, orders, crateIds, facts, counts, blockers: deletionBlockers(facts) };
}

/** Önizleme parmak izi: sayılar + sipariş kimlikleri (önizleme ile son onay arasında değiştiyse STALE) */
export function deletionFingerprint(info) {
  return JSON.stringify({ c: info.counts, o: info.orders.map((o) => o.id).sort() });
}

/**
 * Silme önizlemesi (1. adım — yalnızca okur).
 * @param {any} db @param {{ customerId: string, actor: { id: string, role: string } }} p
 * @returns {Promise<{ ok: true, customer: { id: string, name: string, prefix: string | null, type: string }, counts: Record<string, number>,
 *   blockers: { code: string, n: number }[], orderNos: string[], fingerprint: string } | { ok: false, code: string }>}
 */
export async function customerDeletionPreview(db, { customerId, actor }) {
  if (!allowed(actor)) return fail('FORBIDDEN');
  const info = await deletionFacts(db, String(customerId ?? ''));
  if (!info) return fail('NOT_FOUND');
  return {
    ok: true, customer: info.customer, counts: info.counts, blockers: info.blockers,
    orderNos: info.orders.map((o) => o.orderNo).sort().slice(0, 50), fingerprint: deletionFingerprint(info),
  };
}

/**
 * Firmayı siler (2. adım). confirmName: yöneticinin elle yazdığı firma adı; fingerprint: önizlemedeki parmak izi.
 * Diskteki dosyalar bu işlevin DIŞINDA silinir: dönen `storageKeys` çağıranın removeFiles'ına verilir (yalnızca artık
 * hiçbir kaydın göstermediği anahtarlar — bkz. removeOrphanFiles).
 * @param {any} db
 * @param {{ customerId: string, confirmName: unknown, fingerprint: unknown, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, name: string, counts: Record<string, number>, storageKeys: string[] } | { ok: false, code: string, blockers?: { code: string, n: number }[] }>}
 */
export async function deleteCustomer(db, { customerId, confirmName, fingerprint, actor, now = new Date() }) {
  if (!allowed(actor)) return fail('FORBIDDEN');
  if (!String(confirmName ?? '').trim()) return fail('CONFIRM_REQUIRED');
  const id = String(customerId ?? '');
  return db.$transaction(async (tx) => {
    const lock = (key) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    await lock('loading-confirmation');
    await lock(`finance:${id}`);
    await lock(`billing-batch:${id}`);
    await lock(`order-no:${id}`);
    const pre = await tx.order.findMany({ where: { customerId: id }, select: { id: true }, orderBy: { id: 'asc' } });
    for (const o of pre) await lock(`glass-billing:${o.id}`);
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${id} FOR UPDATE`;
    const info = await deletionFacts(tx, id);
    if (!info) return fail('NOT_FOUND');
    if (!sameName(info.customer.name, confirmName)) return fail('CONFIRM_REQUIRED');
    if (info.blockers.length) {
      await writeAudit(tx, { action: 'CUSTOMER_DELETE_BLOCKED', entityType: 'Customer', entityId: id, userId: actor.id, details: { blockers: info.blockers } }, { role: actor.role, ip: actor.ip ?? null });
      return fail('BLOCKED', { blockers: info.blockers });
    }
    if (String(fingerprint ?? '') !== deletionFingerprint(info)) return fail('STALE');
    const ids = info.orders.map((o) => o.id);
    const inOrders = { orderId: { in: ids } };
    // Disk dosyalarının anahtarları (kayıtlar silinmeden önce)
    const [orderFiles, drawingFiles, drawings, draftFiles] = await Promise.all([
      tx.orderFile.findMany({ where: inOrders, select: { storageKey: true } }),
      tx.drawingFile.findMany({ where: { drawing: inOrders }, select: { storageKey: true } }),
      tx.drawing.findMany({ where: { ...inOrders, fileUrl: { not: null } }, select: { fileUrl: true } }),
      tx.orderDraftFile.findMany({ where: { draft: { customerId: id } }, select: { storageKey: true } }),
    ]);
    const storageKeys = [...new Set([
      ...orderFiles.map((f) => f.storageKey), ...drawingFiles.map((f) => f.storageKey),
      ...drawings.map((d) => d.fileUrl), ...draftFiles.map((f) => f.storageKey),
    ].filter((k) => typeof k === 'string' && k))];
    const offerIds = (await tx.offer.findMany({ where: inOrders, select: { id: true } })).map((o) => o.id);

    await tx.compensation.deleteMany({ where: { OR: [{ customerId: id }, { sourceOrderId: { in: ids } }, { destOrderId: { in: ids } }] } });
    await tx.order.updateMany({ where: { id: { in: ids } }, data: { compOfId: null } });
    await tx.crateOrder.deleteMany({ where: { OR: [inOrders, { crateId: { in: info.crateIds } }] } });
    await tx.crate.deleteMany({ where: { id: { in: info.crateIds } } });
    await tx.drawingFile.deleteMany({ where: { drawing: inOrders } });
    await tx.drawing.deleteMany({ where: inOrders });
    await tx.adminAlert.deleteMany({ where: { OR: [inOrders, { offerId: { in: offerIds } }] } });
    await tx.price.deleteMany({ where: inOrders });
    await tx.orderItem.deleteMany({ where: inOrders });
    await tx.offer.deleteMany({ where: inOrders });
    await tx.notification.deleteMany({ where: inOrders });
    await tx.notificationOutbox.deleteMany({ where: inOrders });
    await tx.order.deleteMany({ where: { id: { in: ids } } });
    await tx.orderDraft.deleteMany({ where: { customerId: id } });
    const users = await tx.user.findMany({ where: { customerId: id }, select: { id: true, deletedAt: true } });
    for (const u of users) if (!u.deletedAt) await anonymizeUser(tx, u.id, now);
    await tx.user.updateMany({ where: { customerId: id }, data: { customerId: null } });
    await tx.customer.delete({ where: { id } });
    await writeAudit(tx, {
      action: 'CUSTOMER_DELETED', entityType: 'Customer', entityId: id, userId: actor.id,
      details: { name: info.customer.name, prefix: info.customer.prefix, counts: info.counts, orderNos: info.orders.map((o) => o.orderNo).sort().slice(0, 200), files: storageKeys.length },
    }, { role: actor.role, ip: actor.ip ?? null });
    return { ok: true, name: info.customer.name, counts: info.counts, storageKeys };
  });
}

/**
 * Silinen kayıtların disk dosyalarını kaldırır — yalnızca artık HİÇBİR kaydın göstermediği anahtarlar (paylaşılan dosya
 * silinmez). Hata fırlatmaz; kaldırılamayan dosya sayılır (dosya adı / yol günlüğe yazılmaz).
 * @param {any} db @param {string[]} keys @param {(key: string) => Promise<void>} remove
 * @returns {Promise<{ removed: number, kept: number, failed: number }>}
 */
export async function removeOrphanFiles(db, keys, remove) {
  const out = { removed: 0, kept: 0, failed: 0 };
  for (const key of keys) {
    try {
      const [a, b, c, d, e] = await Promise.all([
        db.orderFile.count({ where: { storageKey: key } }),
        db.drawingFile.count({ where: { storageKey: key } }),
        db.drawing.count({ where: { fileUrl: key } }),
        db.orderDraftFile.count({ where: { storageKey: key } }),
        db.supplierOrderFile.count({ where: { storageKey: key } }),
      ]);
      if (a + b + c + d + e > 0) { out.kept++; continue; }
      await remove(key);
      out.removed++;
    } catch {
      out.failed++;
    }
  }
  return out;
}
