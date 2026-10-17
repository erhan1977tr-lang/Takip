// Tedarik ve satın alma — veritabanı tarafı (Paket 6, kararlar 179–184). Kurallar server/suppliers/rules.js'te (saf).
//
// Yetki: her işlem SUPPLIER_MANAGE ister (yalnızca yönetici) — sayfa ve server action'dan AYRI olarak burada da, veritabanına
// dokunmadan önce (FORBIDDEN). Denetimci, satış, çizim ve müşteri hiçbir tedarikçi verisine erişemez / yazamaz.
//
// Sipariş: TASLAK revizyon düzenlenir; "Siparişi onayla / gönder" (approveAndSend) TEK koşullu güncellemeyle revizyonu
// kesinleştirir ve AYNI işlemde bir e-posta işi kuyruğa yazar — çift tıklama, eşzamanlı istek ya da yenileme ikinci işi
// üretemez (ikinci istek taslak bulamaz). Taslağı kaydetmek, ürün / tarih değiştirmek, ek eklemek, tahmini yükleme tarihi
// girmek e-posta GÖNDERMEZ. Kesin revizyon değişmez (veritabanı tetikleyicisi); değişiklik yeni revizyonla yapılır.
// Hiçbir işlem stok hareketi yazmaz (stok yalnızca server/profile/stock.js'teki yetkili girişle değişir — karar 184).
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { parseDateOnly } from '../orders/rules.js';
import { dayKeyOf, localDay } from '../profile/dates.js';
import { notifyStaff } from '../notifications/inapp.js';
import { parseAmount, CURRENCIES } from '../accounting/supplier.js';
import { netReceived } from './receipt-rules.js';
import {
  DEBT_STATUSES, FILE_LIMITS, LIMITS, OPEN_STATUSES, addDays, catalogPrice, cleanOrderNo, etaReminderDue, etaReminderKey,
  expectedSupply, nameKey, orderTotals, orderUnitOf, parseLines, parseSupplier, receivedValue, suggestOrderNo, supplierBalances, supplierEmail,
  activeRecipients, missingSupplierCodes, parseEmailList, parseOpening,
} from './rules.js';

export const SUPPLIER_EMAIL = 'SUPPLIER_ORDER_EMAIL';
const FORBIDDEN = /** @type {const} */ ({ ok: false, code: 'FORBIDDEN' });
const allowed = (actor) => can(actor?.role, 'SUPPLIER_MANAGE');
const lockKey = (tx, key) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
const lockOrder = (tx, id) => lockKey(tx, `supplier-order:${id}`);
const one = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max + 1);
const multi = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
const tzOf = (o) => o?.timeZone ?? 'Europe/Bucharest';
/** Kesin revizyonun dosyaları gönderilebilir mi: temiz ya da (antivirüs kapalıyken) taranmamış; bekleyen / virüslü olamaz */
const fileOk = (f) => f.scanStatus === 'CLEAN' || f.scanStatus === 'SKIPPED';
/** Sipariş için kuyruktaki e-posta işleri (yük alanındaki sipariş kimliğiyle) */
export const jobsWhere = (orderId) => ({ type: SUPPLIER_EMAIL, payload: { path: ['supplierOrderId'], equals: orderId } });
/**
 * Henüz GÖNDERİLMEYEN (kapatılabilir) sipariş e-postası işleri (3.93.0, karar 288 — D4): hiç denenmemiş (attempts 0, hata yok)
 * ya da SMTP bağlantı hatası yüzünden yeniden denemeyi bekleyen (hata yazılı — işçi sahiplenince hatayı temizler). Şu an
 * gönderilmekte olan iş (kirada: hata boş, deneme > 0) kapatılmaz; işçi gönderimden önce siparişin durumuna bakar.
 */
export const WAITING_ORDER_MAIL = { status: 'PENDING', OR: [{ attempts: 0, lastError: null }, { lastError: { not: null } }] };

// =====================================================================================================================
// Tedarikçiler (Ayarlar → Tedarikçiler — karar 179)
// =====================================================================================================================

/**
 * Ayarlar ekranı: bütün tedarikçiler (sipariş, ödeme ve ürün sayılarıyla)
 * @param {import('@prisma/client').PrismaClient} db
 */
export async function listSuppliers(db) {
  return db.supplier.findMany({
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { orders: true, payments: true, products: true } }, emails: { orderBy: { sortOrder: 'asc' } } },
  });
}

/**
 * Tedarikçi ekler ya da düzenler. Ad (büyük / küçük harf fark etmeden) tekildir. Her değişiklik denetim kaydında.
 * E-posta adresleri (DÜZELTME 10 M9): emails listesi (en çok 10; parseEmailList). Eski çağrı biçimi (tek email) de kabul edilir.
 * Supplier.email, birincil adresin kopyası olarak eşitlenir (eski sürümle uyum).
 * @param {{ id?: string | null, name?: unknown, contactName?: unknown, email?: unknown, emails?: unknown, phone?: unknown, address?: unknown, currency?: unknown, isActive?: boolean }} v
 * @returns {Promise<{ ok: true, id: string } | { ok: false, code: string, errors?: string[], index?: number }>}
 */
export async function saveSupplier(db, v, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  if (v.emails !== undefined && !Array.isArray(v.emails)) return { ok: false, code: 'EMAIL' };
  const emailRows = Array.isArray(v.emails) ? v.emails : v.email != null && String(v.email).trim() ? [{ email: v.email, isActive: true, isPrimary: true }] : v.emails === undefined && v.email === undefined ? null : [];
  const list = emailRows == null ? null : parseEmailList(emailRows);
  if (list && !list.ok) return { ok: false, code: list.code, ...(list.index != null ? { index: list.index } : {}) };
  const primary = list?.ok ? list.value.find((e) => e.isPrimary)?.email ?? null : undefined;
  const parsed = parseSupplier({ ...v, email: primary === undefined ? v.email : primary ?? '' });
  if (!parsed.ok) return { ok: false, code: parsed.errors[0], errors: parsed.errors };
  const value = parsed.value;
  return db.$transaction(async (tx) => {
    await lockKey(tx, 'suppliers');
    const all = await tx.supplier.findMany({ select: { id: true, name: true } });
    if (all.some((s) => s.id !== v.id && nameKey(s.name) === nameKey(value.name))) return { ok: false, code: 'EXISTS' };
    let id;
    if (v.id) {
      const cur = await tx.supplier.findUnique({ where: { id: String(v.id) } });
      if (!cur) return { ok: false, code: 'NOT_FOUND' };
      // Para birimi, siparişi olan tedarikçide değişmez (borç o birimde doğdu)
      if (cur.currency !== value.currency && (await tx.supplierOrder.count({ where: { supplierId: cur.id } })) > 0) return { ok: false, code: 'CURRENCY_LOCKED' };
      const keys = /** @type {const} */ (['name', 'contactName', 'email', 'phone', 'address', 'currency', 'isActive']);
      const changed = keys.filter((k) => (cur[k] ?? null) !== (value[k] ?? null));
      if (changed.length) {
        await tx.supplier.update({ where: { id: cur.id }, data: value });
        await writeAudit(tx, {
          action: 'SUPPLIER_UPDATED', entityType: 'Supplier', entityId: cur.id, userId: actor.id,
          details: { fields: changed, before: Object.fromEntries(changed.map((k) => [k, cur[k] ?? null])), after: Object.fromEntries(changed.map((k) => [k, value[k] ?? null])) },
        }, actor);
      }
      id = cur.id;
    } else {
      const s = await tx.supplier.create({ data: value });
      await writeAudit(tx, { action: 'SUPPLIER_CREATED', entityType: 'Supplier', entityId: s.id, userId: actor.id, details: { after: value } }, actor);
      id = s.id;
    }
    if (list?.ok) await syncEmails(tx, id, list.value, actor);
    return { ok: true, id };
  });
}

/**
 * Tedarikçinin adres listesini verilen listeye eşitler (adres anahtarına göre: kalan güncellenir, çıkan silinir, yeni
 * eklenir — adres değiştirmek = eskisini silip yenisini eklemek). Değişiklik varsa tek denetim kaydı (önce / sonra).
 * @param {any} tx  @param {string} supplierId  @param {{ email: string, emailKey: string, isActive: boolean, isPrimary: boolean, sortOrder: number }[]} next
 */
async function syncEmails(tx, supplierId, next, actor) {
  const cur = await tx.supplierEmail.findMany({ where: { supplierId }, orderBy: { sortOrder: 'asc' } });
  const view = (rows) => rows.map((e) => ({ email: e.email, active: e.isActive, primary: e.isPrimary }));
  const nextKeys = new Set(next.map((e) => e.emailKey));
  const gone = cur.filter((e) => !nextKeys.has(e.emailKey));
  if (gone.length) await tx.supplierEmail.deleteMany({ where: { id: { in: gone.map((e) => e.id) } } });
  for (const e of next) {
    const old = cur.find((c) => c.emailKey === e.emailKey);
    if (!old) await tx.supplierEmail.create({ data: { supplierId, ...e } });
    else if (old.email !== e.email || old.isActive !== e.isActive || old.isPrimary !== e.isPrimary || old.sortOrder !== e.sortOrder) {
      await tx.supplierEmail.update({ where: { id: old.id }, data: { email: e.email, isActive: e.isActive, isPrimary: e.isPrimary, sortOrder: e.sortOrder } });
    }
  }
  const before = view(cur);
  const after = view(next);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await writeAudit(tx, { action: 'SUPPLIER_EMAILS_CHANGED', entityType: 'Supplier', entityId: supplierId, userId: actor.id, details: { before, after } }, actor);
  }
}

/** Tedarikçinin sipariş e-postası alıcıları (etkin adresler; en çok 10) — onay ve işçi aynı kuralı kullanır */
export async function recipientsOf(db, supplierId) {
  const rows = await db.supplierEmail.findMany({ where: { supplierId }, select: { email: true, isActive: true, isPrimary: true, sortOrder: true } });
  return activeRecipients(rows);
}

/** Etkin / pasif (tedarikçi silinmez — geçmişi korunur). Pasif tedarikçiye yeni sipariş açılmaz, onaylanmaz. */
export async function setSupplierActive(db, { id, active }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lockKey(tx, 'suppliers');
    const s = await tx.supplier.findUnique({ where: { id: String(id ?? '') } });
    if (!s) return { ok: false, code: 'NOT_FOUND' };
    if (s.isActive === !!active) return { ok: true, id: s.id };
    await tx.supplier.update({ where: { id: s.id }, data: { isActive: !!active } });
    await writeAudit(tx, { action: active ? 'SUPPLIER_ACTIVATED' : 'SUPPLIER_DEACTIVATED', entityType: 'Supplier', entityId: s.id, userId: actor.id, details: { name: s.name } }, actor);
    return { ok: true, id: s.id };
  });
}

// =====================================================================================================================
// Tedarikçi siparişleri (karar 181)
// =====================================================================================================================

const PRODUCT_SELECT = {
  id: true, code: true, nameTr: true, nameRo: true, unitCode: true, isActive: true, category: { select: { isActive: true } },
  supplierId: true, purchasePrice: true, purchaseCurrency: true, purchaseUnit: true, supplierCode: true,
};

/**
 * Yeni taslak sipariş (Tedarikçi Siparişleri → Yeni, Profil Stoğu satırından ya da kritik stok listesinden). Numara
 * önerilir (TS-<yıl>-<sıra>); ürünler verilirse satır olarak eklenir — miktarı yönetici girer (önerilmez), alış fiyatı
 * yalnızca ürünün kayıtlı fiyatı bu tedarikçi ve para birimi içinse gelir (catalogPrice; uydurulmaz). E-posta yok, borç yok.
 * @param {{ supplierId: string, items?: { productId: unknown, qty?: unknown, color?: unknown }[] }} v
 * @returns {Promise<{ ok: true, id: string, orderNo: string } | { ok: false, code: string, index?: number }>}
 */
export async function createDraftOrder(db, v, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  const today = localDay(now, tzOf(opts));
  const items = Array.isArray(v.items) ? v.items : [];
  if (items.length > LIMITS.lines) return { ok: false, code: 'LINES' };
  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({ where: { id: String(v.supplierId ?? '') } });
    if (!supplier) return { ok: false, code: 'SUPPLIER' };
    if (!supplier.isActive) return { ok: false, code: 'SUPPLIER_INACTIVE' };
    let lines = [];
    if (items.length) {
      const ids = [...new Set(items.map((i) => String(i?.productId ?? '')))].filter(Boolean);
      const products = await tx.profileProduct.findMany({ where: { id: { in: ids } }, select: PRODUCT_SELECT });
      const byId = new Map(products.map((p) => [p.id, p]));
      const target = { supplierId: supplier.id, currency: supplier.currency };
      const rows = items.map((i) => {
        const p = byId.get(String(i?.productId ?? ''));
        return { productId: i?.productId, qty: i?.qty, color: i?.color, unitPrice: p ? catalogPrice(p, target) ?? '' : '' };
      });
      const parsed = parseLines(rows, { products, order: target });
      if (!parsed.ok) return { ok: false, code: parsed.code, index: parsed.index };
      lines = parsed.lines;
    }
    await lockKey(tx, 'supplier-order-no');
    const year = Number(today.slice(0, 4));
    const existing = await tx.supplierOrder.findMany({ where: { orderNo: { startsWith: `TS-${year}-` } }, select: { orderNo: true } });
    const orderNo = suggestOrderNo(existing.map((o) => o.orderNo), year);
    const order = await tx.supplierOrder.create({ data: { orderNo, supplierId: supplier.id, currency: supplier.currency, createdById: actor.id } });
    const rev = await tx.supplierOrderRevision.create({ data: { orderId: order.id, revision: 1, orderDate: new Date(`${today}T12:00:00.000Z`), createdById: actor.id } });
    if (lines.length) await tx.supplierOrderLine.createMany({ data: lines.map((l) => ({ ...l, revisionId: rev.id })) });
    await writeAudit(tx, {
      action: 'SUPPLIER_ORDER_CREATED', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id,
      details: { orderNo, supplier: supplier.name, currency: supplier.currency, lines: lines.length },
    }, actor);
    return { ok: true, id: order.id, orderNo };
  });
}

/**
 * Taslağı kaydeder (yalnızca taslak revizyon; e-posta GÖNDERMEZ). Sürüm denetimi: ekran açıldıktan sonra başka biri
 * değiştirdiyse CONFLICT (üzerine yazılmaz). Numara yalnızca hiç gönderilmemiş siparişte değişir.
 * @param {{ orderId: string, version: unknown, orderNo?: unknown, orderDate?: unknown, note?: unknown, lines: unknown }} v
 */
export async function saveDraft(db, v, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  const today = localDay(now, tzOf(opts));
  const date = parseDateOnly(String(v.orderDate ?? ''));
  if (!date || dayKeyOf(date) < addDays(today, -366) || dayKeyOf(date) > addDays(today, 366)) return { ok: false, code: 'DATE' };
  const note = multi(v.note);
  if (note.length > LIMITS.note) return { ok: false, code: 'NOTE' };
  if (!Array.isArray(v.lines)) return { ok: false, code: 'LINES' };
  return db.$transaction(async (tx) => {
    await lockOrder(tx, v.orderId);
    const order = await tx.supplierOrder.findUnique({ where: { id: String(v.orderId ?? '') }, include: { revisions: { where: { finalizedAt: null } } } });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    const draft = order.revisions[0];
    if (!draft || !(order.status === 'TASLAK' || OPEN_STATUSES.includes(order.status))) return { ok: false, code: 'NOT_DRAFT' };
    if (Number(v.version) !== order.version) return { ok: false, code: 'CONFLICT' };
    const ids = [...new Set(/** @type {any[]} */ (v.lines).map((l) => String(l?.productId ?? '')))].filter(Boolean);
    const products = await tx.profileProduct.findMany({ where: { id: { in: ids } }, select: PRODUCT_SELECT });
    const parsed = parseLines(v.lines, { products, order: { supplierId: order.supplierId, currency: order.currency } });
    if (!parsed.ok) return { ok: false, code: parsed.code, index: parsed.index };
    let orderNo = order.orderNo;
    if (order.status === 'TASLAK' && v.orderNo != null) {
      const wanted = cleanOrderNo(v.orderNo);
      if (!wanted) return { ok: false, code: 'ORDER_NO' };
      if (wanted !== order.orderNo) {
        await lockKey(tx, 'supplier-order-no');
        if (await tx.supplierOrder.findUnique({ where: { orderNo: wanted }, select: { id: true } })) return { ok: false, code: 'ORDER_NO_TAKEN' };
        orderNo = wanted;
      }
    }
    await tx.supplierOrderLine.deleteMany({ where: { revisionId: draft.id } });
    if (parsed.lines.length) await tx.supplierOrderLine.createMany({ data: parsed.lines.map((l) => ({ ...l, revisionId: draft.id })) });
    await tx.supplierOrderRevision.update({ where: { id: draft.id }, data: { orderDate: date, note: note || null } });
    await tx.supplierOrder.update({ where: { id: order.id }, data: { orderNo, version: { increment: 1 } } });
    const totals = orderTotals(parsed.lines);
    await writeAudit(tx, {
      action: 'SUPPLIER_ORDER_DRAFT_SAVED', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id,
      details: { orderNo, revision: draft.revision, lines: parsed.lines.length, total: totals.total, missingPrice: totals.missingPrice, currency: order.currency, ...(orderNo !== order.orderNo ? { orderNoBefore: order.orderNo } : {}) },
    }, actor);
    return { ok: true, version: order.version + 1, totals };
  });
}

/**
 * Teknik ek eklemeden ÖNCE sınır denetimi (dosyalar diske yazılmadan): taslak var mı, sayı ve boyut sınırları.
 * @param {{ orderId: string, files: { name: string, size: number }[] }} v
 * @returns {Promise<{ ok: true } | { ok: false, code: string }>}
 */
export async function fileQuota(db, { orderId, files }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const order = await db.supplierOrder.findUnique({ where: { id: String(orderId ?? '') }, include: { revisions: { where: { finalizedAt: null }, include: { files: { select: { size: true } } } } } });
  if (!order) return { ok: false, code: 'NOT_FOUND' };
  const draft = order.revisions[0];
  if (!draft) return { ok: false, code: 'NOT_DRAFT' };
  return quotaVerdict(draft.files, files);
}
function quotaVerdict(existing, incoming) {
  if (!incoming.length) return { ok: false, code: 'NO_FILE' };
  if (existing.length + incoming.length > FILE_LIMITS.files) return { ok: false, code: 'FILE_COUNT' };
  if (incoming.some((f) => f.size > FILE_LIMITS.fileBytes)) return { ok: false, code: 'FILE_SIZE' };
  const total = [...existing, ...incoming].reduce((n, f) => n + Number(f.size), 0);
  if (total > FILE_LIMITS.totalBytes) return { ok: false, code: 'FILE_TOTAL' };
  return { ok: true };
}

/**
 * Saklanmış yüklemeleri taslak revizyona bağlar (server/files/store.js'ten geçmiş dosyalar). Sınır işlem içinde yeniden
 * denetlenir; aşılırsa hiçbir kayıt yazılmaz (çağıran dosyaları siler).
 * @param {{ orderId: string, stored: { storageKey: string, name: string, size: number, mime: string, checksum: string, scanStatus: string, scannedAt?: Date | null }[] }} v
 */
export async function attachFiles(db, { orderId, stored }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.supplierOrder.findUnique({ where: { id: String(orderId ?? '') }, include: { revisions: { where: { finalizedAt: null }, include: { files: { select: { size: true } } } } } });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    const draft = order.revisions[0];
    if (!draft) return { ok: false, code: 'NOT_DRAFT' };
    const q = quotaVerdict(draft.files, stored);
    if (!q.ok) return q;
    await tx.supplierOrderFile.createMany({
      data: stored.map((f) => ({
        revisionId: draft.id, name: f.name, storageKey: f.storageKey, size: f.size, mime: f.mime, checksum: f.checksum,
        scanStatus: /** @type {any} */ (f.scanStatus), scannedAt: f.scannedAt ?? null, uploadedById: actor.id,
      })),
    });
    await tx.supplierOrder.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
    await writeAudit(tx, {
      action: 'SUPPLIER_ORDER_FILE_ADDED', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id,
      details: { orderNo: order.orderNo, revision: draft.revision, files: stored.map((f) => ({ name: f.name, size: f.size })) },
    }, actor);
    return { ok: true };
  });
}

/** Taslak revizyondan ek çıkarır (kayıt silinir; diskteki dosya otomatik silinmez — karar 119) */
export async function removeFile(db, { orderId, fileId }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const f = await tx.supplierOrderFile.findFirst({ where: { id: String(fileId ?? ''), revision: { orderId: String(orderId ?? ''), finalizedAt: null } }, include: { revision: { include: { order: true } } } });
    if (!f) return { ok: false, code: 'NOT_FOUND' };
    await tx.supplierOrderFile.delete({ where: { id: f.id } });
    await tx.supplierOrder.update({ where: { id: f.revision.orderId }, data: { version: { increment: 1 } } });
    await writeAudit(tx, {
      action: 'SUPPLIER_ORDER_FILE_REMOVED', entityType: 'SupplierOrder', entityId: f.revision.orderId, userId: actor.id,
      details: { orderNo: f.revision.order.orderNo, revision: f.revision.revision, name: f.name },
    }, actor);
    return { ok: true };
  });
}

/**
 * "Siparişi onayla / gönder" (karar 181) — tedarikçiye gidişin TEK yolu, yalnızca yöneticinin açık işlemi:
 *   1) geçerlilik (en az bir satır, etkin tedarikçi, temiz ekler), 2) tedarikçinin e-postası (Ayarlar'daki adres),
 *   3) içerik kesinleşir (toplam sunucuda hesaplanır; revizyon bundan sonra değişmez), 4) gönderim e-posta kuyruğuna
 *   yazılır (aynı işlemde, tek iş), 5) durum "Gönderim bekliyor" + denetim kaydı. E-posta işçide gider; "Gönderildi"
 *   yalnızca gerçekten gönderilince yazılır (server/suppliers/dispatch.js).
 * Koşullu güncelleme (finalizedAt boşken) + sipariş kilidi + sürüm: ikinci istek taslak bulamaz → ikinci iş yazılmaz.
 * @param {{ orderId: string, version: unknown }} v
 * @returns {Promise<{ ok: true, revision: number, jobId: string } | { ok: false, code: string, detail?: string }>}
 */
export async function approveAndSend(db, v, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  return db.$transaction(async (tx) => {
    await lockOrder(tx, v.orderId);
    const order = await tx.supplierOrder.findUnique({
      where: { id: String(v.orderId ?? '') },
      include: { supplier: true, revisions: { where: { finalizedAt: null }, include: { lines: { orderBy: { sortOrder: 'asc' } }, files: true } } },
    });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    const draft = order.revisions[0];
    if (!draft || !(order.status === 'TASLAK' || OPEN_STATUSES.includes(order.status))) return { ok: false, code: 'NOT_DRAFT' };
    if (Number(v.version) !== order.version) return { ok: false, code: 'CONFLICT' };
    if (draft.lines.length === 0) return { ok: false, code: 'NO_LINES' };
    if (!order.supplier.isActive) return { ok: false, code: 'SUPPLIER_INACTIVE' };
    const to = await recipientsOf(tx, order.supplierId);
    if (!to.length) return { ok: false, code: 'NO_EMAIL' };
    const bad = draft.files.find((f) => !fileOk(f));
    if (bad) return { ok: false, code: bad.scanStatus === 'INFECTED' ? 'FILE_INFECTED' : 'FILE_NOT_CLEAN', detail: bad.name };
    // Tedarikçi ürün kodu (DÜZELTME 10 M5): onay anında üründen kopyalanır; eksikse onay yok (yanlış kodla sessiz gönderim yok)
    const prods = await tx.profileProduct.findMany({ where: { id: { in: [...new Set(draft.lines.map((l) => l.productId))] } }, select: { id: true, supplierCode: true } });
    const codeOf = new Map(prods.map((p) => [p.id, String(p.supplierCode ?? '').trim() || null]));
    const missing = missingSupplierCodes(draft.lines.map((l) => ({ code: l.code, supplierCode: codeOf.get(l.productId) })));
    if (missing.length) return { ok: false, code: 'NO_SUPPLIER_CODE', detail: [...new Set(missing)].slice(0, 20).join(' ') };
    for (const l of draft.lines) {
      if ((l.supplierCode ?? null) !== codeOf.get(l.productId)) await tx.supplierOrderLine.update({ where: { id: l.id }, data: { supplierCode: codeOf.get(l.productId) } });
    }
    const totals = orderTotals(draft.lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice == null ? null : l.unitPrice.toString() })));
    const fin = await tx.supplierOrderRevision.updateMany({
      where: { id: draft.id, finalizedAt: null },
      data: { finalizedAt: now, finalizedById: actor.id, total: totals.total, missingPrice: totals.missingPrice },
    });
    if (fin.count !== 1) return { ok: false, code: 'NOT_DRAFT' };
    const bumped = await tx.supplierOrder.updateMany({
      where: { id: order.id, version: order.version },
      data: { status: 'GONDERIM_BEKLIYOR', sendError: null, version: { increment: 1 } },
    });
    // Sürüm yarışı: işlem geri alınır (revizyon kesinleşmemiş sayılır), iş yazılmaz
    if (bumped.count !== 1) throw new Error('supplier order version changed');
    const job = await tx.notificationOutbox.create({
      data: { type: SUPPLIER_EMAIL, orderId: null, payload: { supplierOrderId: order.id, revisionId: draft.id, revision: draft.revision, attempt: 1 } },
    });
    await writeAudit(tx, {
      action: 'SUPPLIER_ORDER_APPROVED', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id,
      details: {
        orderNo: order.orderNo, supplier: order.supplier.name, revision: draft.revision, lines: draft.lines.length, files: draft.files.length,
        total: totals.total, missingPrice: totals.missingPrice, currency: order.currency, to, jobId: job.id,
      },
    }, actor);
    return { ok: true, revision: draft.revision, jobId: job.id };
  });
}

/**
 * Siparişin kuyrukta bekleyen, henüz alınmamış (deneme yok, hata yok) e-posta işlerini "teslim alındı" gerekçesiyle kapatır —
 * sipariş TESLIM_ALINDI iken işçinin (dispatch.js) yapacağının aynısı. Mal kabulü düzeltmesi (karar 286) otomatik kapanmış
 * siparişi yeniden açarken çağırır: düzeltme tedarikçiye e-posta göndermez. Gönderilmekte olan (kiralanmış) iş değişmez.
 * @param {any} tx  @param {string} orderId
 * @returns {Promise<number>}
 */
export async function skipQueuedOrderMail(tx, orderId) {
  const r = await tx.notificationOutbox.updateMany({ where: { AND: [jobsWhere(orderId), WAITING_ORDER_MAIL] }, data: { status: 'SKIPPED', lastError: 'TESLIM_ALINDI' } });
  return r.count;
}

/**
 * "Tekrar gönder" — yalnızca gönderilemeyen (ya da sonucu belirsiz) son kesin revizyon için, yöneticinin AÇIK kararıyla.
 * Kuyrukta bekleyen iş varsa reddedilir (BUSY). İçerik aynıdır (kesin revizyon); alıcı güncel Ayarlar adresidir.
 */
export async function resendOrder(db, { orderId }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.supplierOrder.findUnique({
      where: { id: String(orderId ?? '') },
      include: { supplier: true, revisions: { where: { finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, take: 1, include: { files: true } } },
    });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    const final = order.revisions[0];
    if (order.status !== 'GONDERIM_HATASI' || !final) return { ok: false, code: 'NOT_ALLOWED' };
    if (await tx.notificationOutbox.count({ where: { ...jobsWhere(order.id), status: 'PENDING' } })) return { ok: false, code: 'BUSY' };
    const to = await recipientsOf(tx, order.supplierId);
    if (!to.length) return { ok: false, code: 'NO_EMAIL' };
    const finalLines = await tx.supplierOrderLine.findMany({ where: { revisionId: final.id }, select: { code: true, supplierCode: true } });
    const missing = missingSupplierCodes(finalLines);
    if (missing.length) return { ok: false, code: 'NO_SUPPLIER_CODE', detail: [...new Set(missing)].slice(0, 20).join(' ') };
    const bad = final.files.find((f) => !fileOk(f));
    if (bad) return { ok: false, code: bad.scanStatus === 'INFECTED' ? 'FILE_INFECTED' : 'FILE_NOT_CLEAN', detail: bad.name };
    const prev = await tx.notificationOutbox.findMany({ where: { AND: [jobsWhere(order.id), { payload: { path: ['revisionId'], equals: final.id } }] }, select: { payload: true } });
    const attempt = prev.length + 1;
    // Bu revizyonun e-postasını zaten ALMIŞ adresler yeniden gönderimde atlanır (aynı alıcıya ikinci ileti yok — M9)
    const already = [...new Set(prev.flatMap((j) => (Array.isArray(/** @type {any} */ (j.payload)?.sentTo) ? /** @type {any} */ (j.payload).sentTo : [])).map((x) => String(x).toLowerCase()))];
    if (to.every((a) => already.includes(a.toLowerCase()))) return { ok: false, code: 'ALREADY_SENT' };
    const job = await tx.notificationOutbox.create({
      data: { type: SUPPLIER_EMAIL, orderId: null, payload: { supplierOrderId: order.id, revisionId: final.id, revision: final.revision, attempt, manual: true, skip: already } },
    });
    await tx.supplierOrder.update({ where: { id: order.id }, data: { status: 'GONDERIM_BEKLIYOR', sendError: null, version: { increment: 1 } } });
    await writeAudit(tx, {
      action: 'SUPPLIER_ORDER_RESEND', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id,
      details: { orderNo: order.orderNo, revision: final.revision, attempt, to, jobId: job.id },
    }, actor);
    return { ok: true, attempt };
  });
}

/**
 * Gönderilmiş siparişte değişiklik = yeni revizyon (açık revizyon mekanizması — karar 181): son kesin revizyonun satırları
 * ve ekleri yeni bir TASLAK revizyona kopyalanır; kesin revizyon olduğu gibi kalır. Yeni revizyon ayrıca onaylanıp gönderilir.
 */
export async function startRevision(db, { orderId, version }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.supplierOrder.findUnique({
      where: { id: String(orderId ?? '') },
      include: { revisions: { orderBy: { revision: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } }, files: true } } },
    });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    if (!OPEN_STATUSES.includes(order.status)) return { ok: false, code: 'NOT_ALLOWED' };
    if (Number(version) !== order.version) return { ok: false, code: 'CONFLICT' };
    if (order.revisions.some((r) => !r.finalizedAt)) return { ok: false, code: 'HAS_DRAFT' };
    // Mal kabulünden sonra yeni revizyon açılmaz (karar 282): kabul satırları kesin revizyonun satırlarına bağlıdır
    if (await tx.supplierReceipt.count({ where: { orderId: order.id } })) return { ok: false, code: 'HAS_RECEIPTS' };
    const final = order.revisions[0];
    const rev = await tx.supplierOrderRevision.create({ data: { orderId: order.id, revision: final.revision + 1, orderDate: final.orderDate, note: final.note, createdById: actor.id } });
    if (final.lines.length) {
      await tx.supplierOrderLine.createMany({
        data: final.lines.map((l) => ({
          revisionId: rev.id, productId: l.productId, code: l.code, supplierCode: l.supplierCode, description: l.description, color: l.color, qty: l.qty, unitCode: l.unitCode,
          unitPrice: l.unitPrice, priceSource: l.priceSource, lineTotal: l.lineTotal, sortOrder: l.sortOrder,
        })),
      });
    }
    if (final.files.length) {
      await tx.supplierOrderFile.createMany({
        data: final.files.map((f) => ({
          revisionId: rev.id, name: f.name, storageKey: f.storageKey, size: f.size, mime: f.mime, checksum: f.checksum,
          scanStatus: f.scanStatus, scanSignature: f.scanSignature, scannedAt: f.scannedAt, uploadedById: f.uploadedById,
        })),
      });
    }
    await tx.supplierOrder.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
    await writeAudit(tx, { action: 'SUPPLIER_ORDER_REVISION_STARTED', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id, details: { orderNo: order.orderNo, revision: rev.revision, from: final.revision } }, actor);
    return { ok: true, revision: rev.revision };
  });
}

/** Gönderilmiş siparişin henüz onaylanmamış revizyon taslağını bırakır (kesin revizyona dokunulmaz) */
export async function discardRevision(db, { orderId }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.supplierOrder.findUnique({ where: { id: String(orderId ?? '') }, include: { revisions: { where: { finalizedAt: null } } } });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    const draft = order.revisions[0];
    if (!draft || order.status === 'TASLAK') return { ok: false, code: 'NOT_ALLOWED' };
    await tx.supplierOrderRevision.delete({ where: { id: draft.id } });
    await tx.supplierOrder.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
    await writeAudit(tx, { action: 'SUPPLIER_ORDER_REVISION_DISCARDED', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id, details: { orderNo: order.orderNo, revision: draft.revision } }, actor);
    return { ok: true };
  });
}

/** Hiç gönderilmemiş taslağı siler (borç ve e-posta yoktur). Kesinleşmiş sipariş silinmez. */
export async function deleteDraftOrder(db, { orderId }, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  return db.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.supplierOrder.findUnique({ where: { id: String(orderId ?? '') }, include: { revisions: true } });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    if (order.status !== 'TASLAK' || order.revisions.some((r) => r.finalizedAt)) return { ok: false, code: 'NOT_ALLOWED' };
    await tx.supplierOrderRevision.deleteMany({ where: { orderId: order.id } });
    await tx.supplierOrder.delete({ where: { id: order.id } });
    await writeAudit(tx, { action: 'SUPPLIER_ORDER_DELETED', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id, details: { orderNo: order.orderNo } }, actor);
    return { ok: true };
  });
}

/**
 * Tahmini yükleme tarihi (karar 183): yalnızca yönetici elle girer (tedarikçinin bildirdiği tarih); sistem tahmin etmez.
 * Sonradan değiştirilebilir ya da silinebilir. Cam siparişlerinin yükleme tarihiyle hiçbir bağı yoktur; müşteriye gitmez.
 * Kaydedince, hatırlatma günü gelmişse hatırlatma hemen yazılır (aynı sipariş + tarih için bir kez).
 * @param {{ orderId: string, eta: unknown }} v  eta: "YYYY-MM-DD" ya da boş (sil)
 */
export async function setEta(db, v, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  const today = localDay(now, tzOf(opts));
  const text = String(v.eta ?? '').trim();
  const date = text ? parseDateOnly(text) : null;
  if (text && (!date || dayKeyOf(date) < addDays(today, -366) || dayKeyOf(date) > addDays(today, 730))) return { ok: false, code: 'DATE' };
  const res = await db.$transaction(async (tx) => {
    await lockOrder(tx, v.orderId);
    const order = await tx.supplierOrder.findUnique({ where: { id: String(v.orderId ?? '') } });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    if (!OPEN_STATUSES.includes(order.status)) return { ok: false, code: 'NOT_ALLOWED' };
    const before = order.etaDate ? dayKeyOf(order.etaDate) : null;
    const after = date ? dayKeyOf(date) : null;
    if (before === after) return { ok: true, eta: after, changed: false };
    await tx.supplierOrder.update({ where: { id: order.id }, data: { etaDate: date, version: { increment: 1 } } });
    await writeAudit(tx, { action: 'SUPPLIER_ORDER_ETA', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id, details: { orderNo: order.orderNo, before, after } }, actor);
    return { ok: true, eta: after, changed: true };
  });
  if (res.ok && res.eta) await remindSupplierEta(db, { now, timeZone: tzOf(opts), orderId: String(v.orderId) }).catch(() => 0);
  return res;
}

/** Mal geldi: sipariş kapanır, beklenen tedarikten düşer. STOK DEĞİŞMEZ — giriş Profil Stoğu'ndan yapılır (karar 184). */
export async function markReceived(db, { orderId }, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  return db.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.supplierOrder.findUnique({ where: { id: String(orderId ?? '') }, include: { revisions: { where: { finalizedAt: null }, select: { id: true } } } });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    if (!OPEN_STATUSES.includes(order.status)) return { ok: false, code: 'NOT_ALLOWED' };
    if (order.revisions.length) return { ok: false, code: 'HAS_DRAFT' };
    await tx.supplierOrder.update({ where: { id: order.id }, data: { status: 'TESLIM_ALINDI', receivedAt: now, version: { increment: 1 } } });
    await writeAudit(tx, { action: 'SUPPLIER_ORDER_RECEIVED', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id, details: { orderNo: order.orderNo, from: order.status } }, actor);
    return { ok: true };
  });
}

/**
 * Gerekçeli iptal (kesinleşmiş, açık sipariş): borçtan düşer, beklenen tedarikten çıkar. Kuyrukta bekleyen e-posta
 * gönderilmez. Tedarikçiye otomatik iptal e-postası GİTMEZ (yönetici ayrıca bildirir). Taslak varsa bırakılır.
 */
export async function cancelOrder(db, { orderId, reason }, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  const why = one(reason, LIMITS.reason);
  if (!why) return { ok: false, code: 'REASON' };
  if (why.length > LIMITS.reason) return { ok: false, code: 'TOO_LONG' };
  return db.$transaction(async (tx) => {
    await lockOrder(tx, orderId);
    const order = await tx.supplierOrder.findUnique({ where: { id: String(orderId ?? '') }, include: { revisions: { where: { finalizedAt: null }, select: { id: true } } } });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    if (!OPEN_STATUSES.includes(order.status)) return { ok: false, code: 'NOT_ALLOWED' };
    if (order.revisions.length) await tx.supplierOrderRevision.deleteMany({ where: { id: { in: order.revisions.map((r) => r.id) } } });
    // Henüz gönderilmeyen işler (yeniden denemeyi bekleyen dahil — D4) kapanır; gönderilmekte olan iş varsa işçi iptali görüp yazmaz
    await tx.notificationOutbox.updateMany({ where: { AND: [jobsWhere(order.id), WAITING_ORDER_MAIL] }, data: { status: 'SKIPPED', lastError: 'CANCELLED' } });
    // Kısmen teslim alınmış sipariş (3.93.0, karar 288 — O6): yalnızca KALAN iptal olur. Kabuller, stok hareketleri, kabul
    // belgeleri ve teslim alınan malın borcu aynen kalır (borç = net teslim alınan × birim fiyat — supplierBalances); iptal
    // kabul / stok / e-posta yazmaz.
    const final = await tx.supplierOrderRevision.findFirst({ where: { orderId: order.id, finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, select: { lines: { select: { id: true, code: true, qty: true, unitPrice: true } } } });
    const [got, fixed] = await Promise.all([
      tx.supplierReceiptLine.groupBy({ by: ['orderLineId'], where: { receipt: { orderId: order.id } }, _sum: { qty: true } }),
      tx.supplierReceiptCorrectionLine.groupBy({ by: ['orderLineId'], where: { correction: { orderId: order.id } }, _sum: { qty: true } }),
    ]);
    const net = netReceived(got, fixed);
    const kept = receivedValue(final?.lines ?? [], net);
    await tx.supplierOrder.update({ where: { id: order.id }, data: { status: 'IPTAL', cancelledAt: now, cancelReason: why, version: { increment: 1 } } });
    await writeAudit(tx, {
      action: 'SUPPLIER_ORDER_CANCELLED', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id,
      details: {
        orderNo: order.orderNo, from: order.status, reason: why,
        ...(kept.qty ? { partial: true, receivedTotal: kept.total, missingPrice: kept.missingPrice, lines: (final?.lines ?? []).map((l) => ({ code: l.code, ordered: l.qty, received: net.get(l.id) ?? 0, cancelled: Math.max(0, l.qty - (net.get(l.id) ?? 0)) })) } : {}),
      },
    }, actor);
    return { ok: true, partial: kept.qty > 0 };
  });
}

// ---------- okuma ----------

/**
 * Liste: siparişler (revizyonların toplamlarıyla; en yeni önce). statuses: yalnızca bu durumlar (boş = hepsi).
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ statuses?: string[] | null, supplierId?: string | null }} [o]
 */
export async function listSupplierOrders(db, { statuses = null, supplierId = null } = {}) {
  return db.supplierOrder.findMany({
    where: { ...(statuses?.length ? { status: { in: /** @type {any} */ (statuses) } } : {}), ...(supplierId ? { supplierId } : {}) },
    orderBy: [{ createdAt: 'desc' }],
    take: 500,
    include: {
      supplier: { select: { id: true, name: true } },
      revisions: { orderBy: { revision: 'desc' }, select: { id: true, revision: true, orderDate: true, finalizedAt: true, total: true, missingPrice: true, _count: { select: { lines: true } } } },
    },
  });
}

/**
 * Sipariş ekranı: başlık, tedarikçi, revizyonlar (satır + ek), e-posta işleri ve geçmiş (denetim kaydı)
 * @param {import('@prisma/client').PrismaClient} db
 * @param {string} id
 */
export async function loadSupplierOrder(db, id) {
  const order = await db.supplierOrder.findUnique({
    where: { id: String(id ?? '') },
    include: {
      supplier: { include: { emails: { orderBy: { sortOrder: 'asc' } } } },
      revisions: { orderBy: { revision: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } }, files: { orderBy: { createdAt: 'asc' } } } },
    },
  });
  if (!order) return null;
  const [jobs, history] = await Promise.all([
    db.notificationOutbox.findMany({ where: jobsWhere(order.id), orderBy: { createdAt: 'desc' }, take: 50 }),
    db.auditLog.findMany({ where: { entityType: 'SupplierOrder', entityId: order.id }, orderBy: { createdAt: 'desc' }, take: 100, include: { user: { select: { name: true, email: true } } } }),
  ]);
  const draft = order.revisions.find((r) => !r.finalizedAt) ?? null;
  const final = order.revisions.find((r) => r.finalizedAt) ?? null;
  return { order, draft, final, jobs, history };
}

/**
 * Seçilebilecek ürünler (etkin, kategorisi etkin), katalog sırasıyla
 * @param {import('@prisma/client').PrismaClient} db
 */
export async function orderableProducts(db) {
  return db.profileProduct.findMany({
    where: { isActive: true, category: { isActive: true } },
    orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { code: 'asc' }],
    select: { ...PRODUCT_SELECT, packContent: true, packMeasure: true, supplier: { select: { name: true } } },
  });
}

// =====================================================================================================================
// Beklenen tedarik ve hatırlatma (karar 183–184)
// =====================================================================================================================

/**
 * Açık siparişlerin son kesin revizyonları (satırlarıyla). Mal kabulünden sonra (karar 282) satırın beklenen miktarı KALAN
 * miktardır (sipariş edilen − teslim alınan): teslim alınan kısım artık stokta, beklenen tedarikte ikinci kez sayılmaz.
 */
async function openFinalRevisions(db) {
  const orders = await db.supplierOrder.findMany({
    where: { status: { in: OPEN_STATUSES } },
    select: {
      id: true, status: true,
      revisions: { where: { finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, take: 1, select: { lines: { select: { id: true, productId: true, qty: true, unitCode: true } } } },
    },
  });
  const ids = orders.flatMap((o) => (o.revisions[0]?.lines ?? []).map((l) => l.id));
  // Net teslim alınan = kabuller − kabul düzeltmeleri (karar 286): düzeltilen miktar yeniden beklenir
  const [got, fixed] = ids.length ? await Promise.all([
    db.supplierReceiptLine.groupBy({ by: ['orderLineId'], where: { orderLineId: { in: ids } }, _sum: { qty: true } }),
    db.supplierReceiptCorrectionLine.groupBy({ by: ['orderLineId'], where: { orderLineId: { in: ids } }, _sum: { qty: true } }),
  ]) : [[], []];
  const received = netReceived(got, fixed);
  return orders.map((o) => ({
    status: o.status,
    lines: (o.revisions[0]?.lines ?? [])
      .map((l) => ({ productId: l.productId, unitCode: l.unitCode, qty: Math.max(0, l.qty - (received.get(l.id) ?? 0)) }))
      .filter((l) => l.qty > 0),
  }));
}

/**
 * Beklenen tedarik: ürün → { qty (stok biriminde), other (başka birimdeki satırlar), orders } — yalnızca yönetici ekranı
 * @param {import('@prisma/client').PrismaClient} db
 */
export async function expectedSupplyMap(db) {
  const [orders, products] = await Promise.all([openFinalRevisions(db), db.profileProduct.findMany({ select: { id: true, unitCode: true } })]);
  return expectedSupply(orders, new Map(products.map((p) => [p.id, p.unitCode])));
}

/**
 * Tahmini yükleme tarihi hatırlatması (karar 183): açık siparişte tarihten 2 TAKVİM günü önce (ve tarih geçene kadar)
 * yöneticiye uygulama içi bildirim. Anahtar sipariş + tarih: aynı tarih için tek bildirim (işçinin her saatlik turu ve
 * tarihin kaydı aynı anahtarı yazar); tarih değişirse yeni tarihe göre yenisi yazılır. Yalnızca veritabanı (dış istek yok).
 * @param {{ now?: Date, timeZone?: string, orderId?: string | null, log?: Function }} [o]
 * @returns {Promise<{ due: number, created: number }>}
 */
export async function remindSupplierEta(db, { now = new Date(), timeZone = 'Europe/Bucharest', orderId = null, log = () => {} } = {}) {
  const today = localDay(now, timeZone);
  const orders = await db.supplierOrder.findMany({
    where: {
      ...(orderId ? { id: orderId } : {}), status: { in: OPEN_STATUSES },
      etaDate: { gte: new Date(`${today}T00:00:00.000Z`), lte: new Date(`${addDays(today, 2 + 1)}T00:00:00.000Z`) },
    },
    select: { id: true, orderNo: true, etaDate: true, supplier: { select: { name: true } } },
  });
  let due = 0, created = 0;
  for (const o of orders) {
    const etaDay = o.etaDate ? dayKeyOf(o.etaDate) : null;
    if (!etaReminderDue({ etaDay, today })) continue;
    due++;
    try {
      created += await notifyStaff(db, {
        audience: 'supplier', key: etaReminderKey(o.id, /** @type {string} */ (etaDay)), type: 'SUPPLIER_ETA',
        params: { ref: o.orderNo, day: etaDay, supplier: o.supplier.name }, link: `/siparisler/tedarik/${o.id}`,
      });
    } catch (e) {
      log('tedarikçi hatırlatması yazılamadı', o.orderNo, String(/** @type {any} */ (e)?.message ?? e).slice(0, 200));
    }
  }
  return { due, created };
}

// =====================================================================================================================
// Ödemeler ve hesaplar (karar 182)
// =====================================================================================================================

/**
 * Tedarikçiye ödeme (yönetici elle girer). Tek seferlik form anahtarı (requestKey): aynı form iki kez gönderilse de
 * (çift tıklama, yenileme) ödeme bir kez yazılır — ikinci istek ilk kaydı döndürür. Denetim kaydı yazılır.
 * @param {{ supplierId: string, paidOn: unknown, amount: unknown, currency: unknown, note?: unknown, requestKey: unknown }} v
 */
export async function addPayment(db, v, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  const today = localDay(now, tzOf(opts));
  const key = String(v.requestKey ?? '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return { ok: false, code: 'KEY' };
  const date = parseDateOnly(String(v.paidOn ?? ''));
  if (!date || dayKeyOf(date) > today || dayKeyOf(date) < addDays(today, -3660)) return { ok: false, code: 'DATE' };
  const amount = parseAmount(v.amount);
  if (amount == null) return { ok: false, code: 'AMOUNT' };
  const currency = String(v.currency ?? '').trim().toUpperCase();
  if (!CURRENCIES.includes(currency)) return { ok: false, code: 'CURRENCY' };
  const note = one(v.note, LIMITS.paymentNote) || null;
  if ((note?.length ?? 0) > LIMITS.paymentNote) return { ok: false, code: 'TOO_LONG' };
  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({ where: { id: String(v.supplierId ?? '') }, select: { id: true, name: true } });
    if (!supplier) return { ok: false, code: 'NOT_FOUND' };
    await lockKey(tx, `supplier-payment:${key}`);
    const same = await tx.supplierPayment.findUnique({ where: { requestKey: key } });
    if (same) return same.supplierId === supplier.id ? { ok: true, id: same.id, duplicate: true } : { ok: false, code: 'KEY' };
    const p = await tx.supplierPayment.create({
      data: { supplierId: supplier.id, paidOn: date, amount: amount.toFixed(2), currency, note, requestKey: key, createdById: actor.id },
    });
    await writeAudit(tx, {
      action: 'SUPPLIER_PAYMENT_ADDED', entityType: 'SupplierPayment', entityId: p.id, userId: actor.id,
      details: { supplierId: supplier.id, supplier: supplier.name, paidOn: dayKeyOf(date), amount: amount.toFixed(2), currency, note },
    }, actor);
    return { ok: true, id: p.id, duplicate: false };
  });
}

/** Ödemeyi gerekçeyle iptal eder (silinmez; hesapta "iptal" görünür, bakiyeye girmez). */
export async function voidPayment(db, { paymentId, reason }, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  const why = one(reason, LIMITS.reason);
  if (!why) return { ok: false, code: 'REASON' };
  if (why.length > LIMITS.reason) return { ok: false, code: 'TOO_LONG' };
  return db.$transaction(async (tx) => {
    const p = await tx.supplierPayment.findUnique({ where: { id: String(paymentId ?? '') } });
    if (!p) return { ok: false, code: 'NOT_FOUND' };
    const r = await tx.supplierPayment.updateMany({ where: { id: p.id, voidedAt: null }, data: { voidedAt: now, voidedById: actor.id, voidReason: why } });
    if (r.count !== 1) return { ok: false, code: 'ALREADY_VOID' };
    await writeAudit(tx, {
      action: 'SUPPLIER_PAYMENT_VOIDED', entityType: 'SupplierPayment', entityId: p.id, userId: actor.id,
      details: { supplierId: p.supplierId, paidOn: dayKeyOf(p.paidOn), amount: p.amount.toString(), currency: p.currency, reason: why },
    }, actor);
    return { ok: true };
  });
}

/**
 * Açılış bakiyesi (DÜZELTME 10 M2): geçmiş dönemden devreden borç (DEBT, +) ya da alacak (CREDIT, −). Sipariş borcu ve
 * ödemelerden ayrı kayıt; tek seferlik form anahtarı (çift gönderim tek kayıt); denetim kaydı. Düzeltme: iptal (gerekçeli)
 * ya da karşı kayıt (correctsId — aynı tedarikçi ve para birimindeki iptal edilmemiş açılış kaydı).
 * @param {{ supplierId: string, asOf: unknown, amount: unknown, currency: unknown, direction: unknown, note?: unknown, correctsId?: unknown, requestKey: unknown }} v
 */
export async function addOpening(db, v, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  const today = localDay(now, tzOf(opts));
  const key = String(v.requestKey ?? '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return { ok: false, code: 'KEY' };
  const date = parseDateOnly(String(v.asOf ?? ''));
  if (!date || dayKeyOf(date) > today || dayKeyOf(date) < addDays(today, -3660)) return { ok: false, code: 'DATE' };
  const parsed = parseOpening({ amount: v.amount, currency: v.currency, direction: v.direction, note: v.note });
  if (!parsed.ok) return parsed;
  const correctsId = String(v.correctsId ?? '').trim() || null;
  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({ where: { id: String(v.supplierId ?? '') }, select: { id: true, name: true } });
    if (!supplier) return { ok: false, code: 'NOT_FOUND' };
    await lockKey(tx, `supplier-opening:${key}`);
    const same = await tx.supplierOpeningBalance.findUnique({ where: { requestKey: key } });
    if (same) return same.supplierId === supplier.id ? { ok: true, id: same.id, duplicate: true } : { ok: false, code: 'KEY' };
    if (correctsId) {
      const target = await tx.supplierOpeningBalance.findFirst({ where: { id: correctsId, supplierId: supplier.id, voidedAt: null } });
      if (!target) return { ok: false, code: 'CORRECTS' };
      if (target.currency !== parsed.value.currency) return { ok: false, code: 'CURRENCY' };
    }
    const row = await tx.supplierOpeningBalance.create({
      data: { supplierId: supplier.id, asOf: date, amount: parsed.value.amount, currency: parsed.value.currency, note: parsed.value.note, correctsId, requestKey: key, createdById: actor.id },
    });
    await writeAudit(tx, {
      action: 'SUPPLIER_OPENING_ADDED', entityType: 'SupplierOpeningBalance', entityId: row.id, userId: actor.id,
      details: { supplierId: supplier.id, supplier: supplier.name, asOf: dayKeyOf(date), amount: parsed.value.amount, currency: parsed.value.currency, note: parsed.value.note, correctsId },
    }, actor);
    return { ok: true, id: row.id, duplicate: false };
  });
}

/** Açılış kaydını gerekçeyle iptal eder (silinmez; hesapta "iptal" görünür, bakiyeye girmez) */
export async function voidOpening(db, { openingId, reason }, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  const why = one(reason, LIMITS.reason);
  if (!why) return { ok: false, code: 'REASON' };
  if (why.length > LIMITS.reason) return { ok: false, code: 'TOO_LONG' };
  return db.$transaction(async (tx) => {
    const x = await tx.supplierOpeningBalance.findUnique({ where: { id: String(openingId ?? '') } });
    if (!x) return { ok: false, code: 'NOT_FOUND' };
    const r = await tx.supplierOpeningBalance.updateMany({ where: { id: x.id, voidedAt: null }, data: { voidedAt: now, voidedById: actor.id, voidReason: why } });
    if (r.count !== 1) return { ok: false, code: 'ALREADY_VOID' };
    await writeAudit(tx, {
      action: 'SUPPLIER_OPENING_VOIDED', entityType: 'SupplierOpeningBalance', entityId: x.id, userId: actor.id,
      details: { supplierId: x.supplierId, asOf: dayKeyOf(x.asOf), amount: x.amount.toString(), currency: x.currency, reason: why },
    }, actor);
    return { ok: true };
  });
}

/** Siparişin hesaba giren tutarı: son kesin revizyonun toplamı (taslak borç doğurmaz) */
const finalOf = (o) => o.revisions.find((r) => r.finalizedAt) ?? null;

/**
 * İptal edilmiş siparişlerin teslim alınan malının değeri (karar 288 — O6): sipariş → receivedValue. Net teslim alınan =
 * kabuller − kabul düzeltmeleri (karar 286).
 * @param {any} db  @param {{ id: string, status: string, revisions: { lines?: { id: string, unitPrice: unknown }[] }[] }[]} orders
 */
async function cancelledReceived(db, orders) {
  const cancelled = orders.filter((o) => o.status === 'IPTAL');
  const ids = cancelled.flatMap((o) => (o.revisions[0]?.lines ?? []).map((l) => l.id));
  if (!ids.length) return new Map();
  const [got, fixed] = await Promise.all([
    db.supplierReceiptLine.groupBy({ by: ['orderLineId'], where: { orderLineId: { in: ids } }, _sum: { qty: true } }),
    db.supplierReceiptCorrectionLine.groupBy({ by: ['orderLineId'], where: { orderLineId: { in: ids } }, _sum: { qty: true } }),
  ]);
  const net = netReceived(got, fixed);
  return new Map(cancelled.map((o) => [o.id, receivedValue(o.revisions[0]?.lines ?? [], net)]));
}
/** Hesap satırı: açık / teslim alınmış sipariş → son kesin revizyonun toplamı; iptal → teslim alınanın değeri */
const debtRow = (o, received) => {
  if (o.status === 'IPTAL') {
    const r = received.get(o.id);
    return { currency: o.currency, status: o.status, total: r?.total ?? '0', missingPrice: r?.missingPrice ?? false, received: (r?.qty ?? 0) > 0 };
  }
  return { currency: o.currency, status: o.status, total: o.revisions[0]?.total?.toString() ?? '0', missingPrice: o.revisions[0]?.missingPrice ?? false };
};

/**
 * Hesaplar özeti: her tedarikçi için para birimi başına borç / ödeme / kalan (karar 182). Para birimleri toplanmaz.
 * @param {import('@prisma/client').PrismaClient} db
 * @returns {Promise<{ supplier: { id: string, name: string, currency: string, isActive: boolean }, balances: ReturnType<typeof supplierBalances> }[]>}
 */
export async function supplierAccounts(db) {
  const [suppliers, orders, payments, openings] = await Promise.all([
    db.supplier.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }], select: { id: true, name: true, currency: true, isActive: true } }),
    db.supplierOrder.findMany({
      // İptal edilmiş ama teslim alınmış malı olan siparişler de (karar 288 — O6): borç = teslim alınanın değeri
      where: { OR: [{ status: { in: DEBT_STATUSES } }, { status: 'IPTAL', receipts: { some: {} } }] },
      select: { id: true, supplierId: true, currency: true, status: true, revisions: { where: { finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, take: 1, select: { total: true, missingPrice: true, finalizedAt: true, lines: { select: { id: true, unitPrice: true } } } } },
    }),
    db.supplierPayment.findMany({ where: { voidedAt: null }, select: { supplierId: true, currency: true, amount: true, voidedAt: true } }),
    db.supplierOpeningBalance.findMany({ where: { voidedAt: null }, select: { supplierId: true, currency: true, amount: true, voidedAt: true } }),
  ]);
  const received = await cancelledReceived(db, orders);
  const openingsOf = (id) => openings.filter((x) => x.supplierId === id).map((x) => ({ currency: x.currency, amount: x.amount.toString(), voidedAt: x.voidedAt }));
  return suppliers.map((s) => ({
    supplier: s,
    balances: supplierBalances(
      orders.filter((o) => o.supplierId === s.id).map((o) => debtRow(o, received)),
      payments.filter((p) => p.supplierId === s.id).map((p) => ({ currency: p.currency, amount: p.amount.toString(), voidedAt: p.voidedAt })),
      openingsOf(s.id),
    ),
  }));
}

/**
 * Tek tedarikçinin hesabı: siparişler (kesinleşmiş; iptaller ayrı işaretli), ödemeler (iptaller dahil) ve bakiyeler
 * @param {import('@prisma/client').PrismaClient} db
 * @param {string} supplierId
 */
export async function supplierAccount(db, supplierId) {
  const supplier = await db.supplier.findUnique({ where: { id: String(supplierId ?? '') } });
  if (!supplier) return null;
  const [orders, payments, openings] = await Promise.all([
    db.supplierOrder.findMany({
      where: { supplierId: supplier.id, status: { not: 'TASLAK' } },
      orderBy: { createdAt: 'desc' },
      include: { revisions: { where: { finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, take: 1, include: { lines: { select: { id: true, unitPrice: true } } } } },
    }),
    db.supplierPayment.findMany({ where: { supplierId: supplier.id }, orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }] }),
    db.supplierOpeningBalance.findMany({ where: { supplierId: supplier.id }, orderBy: [{ asOf: 'desc' }, { createdAt: 'desc' }] }),
  ]);
  const received = await cancelledReceived(db, orders);
  const rows = orders.map((o) => {
    const f = finalOf(o);
    const r = o.status === 'IPTAL' ? received.get(o.id) : null;
    // İptal + teslim alınan mal (karar 288 — O6): yalnızca teslim alınanın değeri sayılır (kalan iptal)
    if (r && r.qty > 0) {
      return {
        id: o.id, orderNo: o.orderNo, status: o.status, currency: o.currency, orderDate: f?.orderDate ?? null, revision: f?.revision ?? null,
        total: r.total, missingPrice: r.missingPrice, counts: true, partialCancel: true, orderedTotal: f?.total?.toString() ?? null,
      };
    }
    return {
      id: o.id, orderNo: o.orderNo, status: o.status, currency: o.currency, orderDate: f?.orderDate ?? null, revision: f?.revision ?? null,
      total: f?.total?.toString() ?? null, missingPrice: f?.missingPrice ?? false, counts: DEBT_STATUSES.includes(o.status), partialCancel: false, orderedTotal: null,
    };
  });
  const balances = supplierBalances(
    rows.map((r) => ({ currency: r.currency, status: r.status, total: r.total ?? '0', missingPrice: r.missingPrice, received: r.partialCancel })),
    payments.map((p) => ({ currency: p.currency, amount: p.amount.toString(), voidedAt: p.voidedAt })),
    openings.map((x) => ({ currency: x.currency, amount: x.amount.toString(), voidedAt: x.voidedAt })),
  );
  return { supplier, orders: rows, payments, openings, balances };
}

export { orderUnitOf, catalogPrice };
