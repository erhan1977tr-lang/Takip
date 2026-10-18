// Nakliye gideri ve gerçekleşen stok maliyeti — veritabanı tarafı (DÜZELTME 10 M6, 3.97.0). Kurallar stock-cost.js'te (saf).
//
// Yetki: SUPPLIER_MANAGE (yönetici, yönetici yardımcısı) — her dışa açık yazan / okuyan işlevin ilk satırında. Nakliye kaydı
// stok hareketi YAZMAZ (miktar değişmez); yalnızca maliyete girer. Ürün tedarikçisinin borcuna eklenmez (taşıyıcı gideri ayrı).
// Kayıt ve dağıtım aynı işlemde, tek seferlik form anahtarı ve aynı fatura denetimiyle (iki kez dağıtım yok). Dağıtım ve
// kur sonradan değişmez; yanlış kayıt gerekçeyle iptal edilir (maliyetten çıkar) ve doğrusu yeniden girilir.
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { parseDateOnly } from '../orders/rules.js';
import { dayKeyOf, localDay } from '../profile/dates.js';
import { addDays } from './rules.js';
import { allocateTransport, carrierBalances, parseTransport, stockCosts } from './stock-cost.js';

/** @typedef {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} Db */
const FORBIDDEN = /** @type {const} */ ({ ok: false, code: 'FORBIDDEN' });
const allowed = (actor) => can(actor?.role, 'SUPPLIER_MANAGE');
const lockKey = (tx, key) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
const tzOf = (o) => o?.timeZone ?? 'Europe/Bucharest';
const carrierKey = (v) => String(v ?? '').normalize('NFC').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();
const one = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max + 1);

/**
 * Bir tedarikçi siparişinin nakliyeye bağlanabilecek mal kabulleri (3.97.6: nakliye yalnızca sipariş sayfasından — "Transport
 * ekle"): tarih, satır sayısı, net teslim alınan toplam miktar ve daha önce bağlandığı (iptal edilmemiş) nakliye sayısı.
 * Yalnızca okur. @param {Db} db  @param {any} actor  @param {string} orderId
 */
export async function transportReceiptOptions(db, actor, orderId) {
  if (!allowed(actor)) return FORBIDDEN;
  const rows = await db.supplierReceipt.findMany({
    where: { orderId: String(orderId ?? '') },
    orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }], take: 300,
    select: {
      id: true, seq: true, receivedOn: true, reference: true,
      order: { select: { orderNo: true, currency: true, supplier: { select: { name: true } } } },
      lines: { select: { qty: true, corrections: { select: { qty: true } } } },
      transports: { where: { transport: { voidedAt: null } }, select: { transportId: true } },
    },
  });
  return {
    ok: /** @type {const} */ (true),
    receipts: rows.map((r) => ({
      id: r.id, seq: r.seq, receivedOn: dayKeyOf(r.receivedOn), reference: r.reference, orderNo: r.order.orderNo, supplier: r.order.supplier.name,
      lines: r.lines.length, qty: r.lines.reduce((n, l) => n + Math.max(0, l.qty - l.corrections.reduce((m, c) => m + c.qty, 0)), 0), transports: r.transports.length,
    })),
  };
}

/**
 * Nakliye faturası kaydı + dağıtım (tek işlem). Aynı taşıyıcının aynı fatura numarası (iptal edilmemiş) ikinci kez
 * girilemez (DUPLICATE_INVOICE); aynı form iki kez gönderilirse ilk kayıt döner (duplicate). Seçilen kabullerin hepsi
 * `orderId` siparişine ait olmalıdır (değilse RECEIPT_GONE) — nakliye bir tedarikçi siparişinin sayfasından girilir.
 * @param {{ orderId: unknown, carrierName: unknown, invoiceNo?: unknown, invoiceDate: unknown, amount: unknown, currency: unknown, fxRate?: unknown, note?: unknown, receiptIds: unknown, requestKey: unknown }} v
 */
export async function createTransport(db, v, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const today = localDay(opts.now ?? new Date(), tzOf(opts));
  const key = String(v.requestKey ?? '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return { ok: false, code: 'KEY' };
  const date = parseDateOnly(String(v.invoiceDate ?? ''));
  if (!date || dayKeyOf(date) > today || dayKeyOf(date) < addDays(today, -3660)) return { ok: false, code: 'DATE' };
  const parsed = parseTransport(v);
  if (!parsed.ok) return parsed;
  const t = parsed.value;
  return db.$transaction(async (tx) => {
    await lockKey(tx, 'transport-cost');
    const same = await tx.transportCost.findUnique({ where: { requestKey: key } });
    if (same) return { ok: true, id: same.id, duplicate: true };
    if (t.invoiceNo) {
      const others = await tx.transportCost.findMany({ where: { voidedAt: null, invoiceNo: { equals: t.invoiceNo, mode: 'insensitive' } }, select: { carrierName: true } });
      if (others.some((o) => carrierKey(o.carrierName) === carrierKey(t.carrierName))) return { ok: false, code: 'DUPLICATE_INVOICE' };
    }
    const receipts = await tx.supplierReceipt.findMany({
      where: { id: { in: t.receiptIds }, orderId: String(v.orderId ?? '') },
      select: { id: true, lines: { orderBy: { sortOrder: 'asc' }, select: { id: true, productId: true, qty: true, corrections: { select: { qty: true } } } } },
    });
    if (receipts.length !== t.receiptIds.length) return { ok: false, code: 'RECEIPT_GONE' };
    // Gerçek (net) teslim alınan miktar = kabul − düzeltmeler; birim = ürünün stok birimi (kabul bunu zorunlu kılar)
    const lines = t.receiptIds.flatMap((id) => /** @type {any} */ (receipts.find((r) => r.id === id)).lines.map((l) => ({
      receiptLineId: l.id, productId: l.productId, qty: Math.max(0, l.qty - l.corrections.reduce((n, c) => n + c.qty, 0)),
    })));
    const alloc = allocateTransport(t.amountEur, lines);
    if (!alloc.ok) return alloc;
    const row = await tx.transportCost.create({
      data: {
        carrierName: t.carrierName, invoiceNo: t.invoiceNo, invoiceDate: date, amount: t.amount, currency: t.currency,
        fxRate: t.fxRate, fxDate: t.currency === 'RON' ? date : null, amountEur: t.amountEur, note: t.note, requestKey: key, createdById: actor.id,
        receipts: { create: t.receiptIds.map((receiptId) => ({ receiptId })) },
        allocations: { create: alloc.rows.map((a) => ({ receiptLineId: a.receiptLineId, productId: a.productId, qty: a.qty, amountEur: a.amountEur })) },
      },
    });
    await writeAudit(tx, {
      action: 'TRANSPORT_COST_ADDED', entityType: 'TransportCost', entityId: row.id, userId: actor.id,
      details: {
        carrier: t.carrierName, invoiceNo: t.invoiceNo, invoiceDate: dayKeyOf(date), amount: t.amount, currency: t.currency, fxRate: t.fxRate, amountEur: t.amountEur,
        receipts: t.receiptIds, lines: alloc.rows.length, qty: alloc.rows.reduce((n, a) => n + a.qty, 0),
      },
    }, actor);
    return { ok: true, id: row.id, duplicate: false, allocations: alloc.rows.length };
  });
}

/** Nakliyeyi gerekçeyle iptal eder: kayıt ve dağıtımı silinmez, maliyetten ve taşıyıcı borcundan çıkar */
export async function voidTransport(db, { transportId, reason }, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const why = one(reason, 500);
  if (!why) return { ok: false, code: 'REASON' };
  if (why.length > 500) return { ok: false, code: 'TOO_LONG' };
  return db.$transaction(async (tx) => {
    const x = await tx.transportCost.findUnique({ where: { id: String(transportId ?? '') } });
    if (!x) return { ok: false, code: 'NOT_FOUND' };
    const r = await tx.transportCost.updateMany({ where: { id: x.id, voidedAt: null }, data: { voidedAt: opts.now ?? new Date(), voidedById: actor.id, voidReason: why } });
    if (r.count !== 1) return { ok: false, code: 'ALREADY_VOID' };
    await writeAudit(tx, { action: 'TRANSPORT_COST_VOIDED', entityType: 'TransportCost', entityId: x.id, userId: actor.id, details: { carrier: x.carrierName, invoiceNo: x.invoiceNo, amount: x.amount.toString(), currency: x.currency, reason: why } }, actor);
    return { ok: true };
  });
}

/** Taşıyıcıya ödendi işareti (tarihle; bir kez) — taşıyıcı borcundan düşer */
export async function markTransportPaid(db, { transportId, paidOn }, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const today = localDay(opts.now ?? new Date(), tzOf(opts));
  const date = parseDateOnly(String(paidOn ?? ''));
  if (!date || dayKeyOf(date) > today || dayKeyOf(date) < addDays(today, -3660)) return { ok: false, code: 'DATE' };
  return db.$transaction(async (tx) => {
    const x = await tx.transportCost.findUnique({ where: { id: String(transportId ?? '') } });
    if (!x) return { ok: false, code: 'NOT_FOUND' };
    const r = await tx.transportCost.updateMany({ where: { id: x.id, voidedAt: null, paidOn: null }, data: { paidOn: date, paidById: actor.id } });
    if (r.count !== 1) return { ok: false, code: x.voidedAt ? 'ALREADY_VOID' : 'ALREADY_PAID' };
    await writeAudit(tx, { action: 'TRANSPORT_COST_PAID', entityType: 'TransportCost', entityId: x.id, userId: actor.id, details: { carrier: x.carrierName, invoiceNo: x.invoiceNo, amount: x.amount.toString(), currency: x.currency, paidOn: dayKeyOf(date) } }, actor);
    return { ok: true };
  });
}

/**
 * Nakliye kayıtları (son 300; `orderId` verilirse yalnızca o tedarikçi siparişinin kabullerine bağlı olanlar) + taşıyıcı
 * bakiyeleri (taşıyıcı + para birimi başına, bütün kayıtlardan; ürün tedarikçisinden ayrı)
 * @param {Db} db  @param {any} actor  @param {{ orderId?: string }} [filter]
 */
export async function listTransports(db, actor, filter = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const rows = await db.transportCost.findMany({
    where: filter.orderId ? { receipts: { some: { receipt: { orderId: filter.orderId } } } } : {},
    orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }], take: 300,
    include: { receipts: { select: { receipt: { select: { id: true, seq: true, order: { select: { id: true, orderNo: true } } } } } }, _count: { select: { allocations: true } } },
  });
  const all = await db.transportCost.findMany({ select: { carrierName: true, currency: true, amount: true, paidOn: true, voidedAt: true } });
  return { ok: /** @type {const} */ (true), rows, carriers: carrierBalances(all.map((r) => ({ ...r, amount: r.amount.toString() }))) };
}

/**
 * Ürünlerin gerçekleşen stok maliyeti (EUR / stok birimi, nakliye dahil ağırlıklı ortalama). Yalnızca okur.
 * @param {Db} db  @param {string[] | null} productIds  null = bütün ürünler
 * @returns {Promise<Map<string, { avgEur: string | null, qty: number, valueEur: string, transportEur: string, missingQty: number }>>}
 */
export async function productStockCosts(db, productIds = null) {
  const where = productIds ? { productId: { in: productIds } } : {};
  const [lines, allocs] = await Promise.all([
    db.supplierReceiptLine.findMany({
      where,
      select: { id: true, productId: true, qty: true, corrections: { select: { qty: true } }, orderLine: { select: { unitPrice: true } }, receipt: { select: { order: { select: { currency: true } } } } },
    }),
    db.transportAllocation.findMany({ where: { ...where, transport: { voidedAt: null } }, select: { receiptLineId: true, productId: true, amountEur: true } }),
  ]);
  const counted = new Set(lines.filter((l) => l.receipt.order.currency === 'EUR' && l.orderLine.unitPrice != null).map((l) => l.id));
  return stockCosts(
    lines.map((l) => ({ productId: l.productId, netQty: Math.max(0, l.qty - l.corrections.reduce((n, c) => n + c.qty, 0)), unitPrice: l.orderLine.unitPrice?.toString() ?? null, currency: l.receipt.order.currency })),
    allocs.map((a) => ({ productId: a.productId, amountEur: a.amountEur.toString(), counted: counted.has(a.receiptLineId) })),
  );
}
