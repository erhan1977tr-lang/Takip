// Tedarikçi siparişi mal kabulü — veritabanı tarafı (3.87.0, karar 282). Saf kurallar server/suppliers/receipt-rules.js.
//
// Yetki: SUPPLIER_MANAGE VE STOCK_MANAGE (yönetici, yönetici yardımcısı — mevcut izinler; yeni izin yok). Her dışa açık
// işlevin ilk satırı yetki denetimidir (sayfa / işlemden AYRI olarak, veritabanına dokunmadan önce).
//
// Mal kabulü TEK veritabanı işlemidir: kabul + satırları (kopya) + stok GIRIS hareketleri (server/profile/stock.js →
// receiveSupplierStock) + sipariş durumu (tamamlandıysa TESLIM_ALINDI) + depo e-postası işi (kuyruk) + denetim kaydı. Herhangi
// bir adım hata verirse hiçbiri yazılmaz. Sipariş oluşturmak / onaylamak / göndermek stoğu DEĞİŞTİRMEZ; stok yalnızca burada,
// fiilen teslim alınan miktar kadar artar.
//
// Eşzamanlılık ve tekrar: `supplier-order:<id>` danışma kilidi (sipariş ekranındaki öbür işlemlerle aynı) alınır, sonra
// tek kullanımlık form anahtarına (requestKey) bakılır — çift tıklama / yeniden gönderilen form / eşzamanlı aynı istek ilk
// kabulü döndürür, ikinci kabul ve ikinci stok girişi oluşmaz (veritabanında requestKey benzersiz: son güvence). Farklı iki
// kabul aynı anda gelirse ikincisi kilidi bekler ve kalan miktarı ilkinden SONRAKİ hâliyle okur (READ COMMITTED) — toplam
// hiçbir zaman sipariş edileni geçemez. Kilit sırası: sipariş → ürün stok kilitleri (başka hiçbir akış bu ikisini ters sırada
// almaz).
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { localDay } from '../profile/dates.js';
import { receiveSupplierStock } from '../profile/stock.js';
import { RECEIPT_EMAIL, RECEIVABLE_STATUSES, fullyReceived, parseReceipt, profileLength, receiptBalance, unitCompatible } from './receipt-rules.js';

const FORBIDDEN = /** @type {const} */ ({ ok: false, code: 'FORBIDDEN' });
const allowed = (actor) => can(actor?.role, 'SUPPLIER_MANAGE') && can(actor?.role, 'STOCK_MANAGE');
const lockKey = (tx, key) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

/** Kabulün depo e-postası işleri (yük alanındaki kabul kimliğiyle) */
export const receiptJobsWhere = (receiptId) => ({ type: RECEIPT_EMAIL, payload: { path: ['receiptId'], equals: receiptId } });

/**
 * Satır başına teslim alınan toplam (sipariş satırı id → adet)
 * @param {any} tx  @param {string} orderId
 * @returns {Promise<Map<string, number>>}
 */
export async function receivedByLine(tx, orderId) {
  const rows = await tx.supplierReceiptLine.groupBy({ by: ['orderLineId'], where: { receipt: { orderId } }, _sum: { qty: true } });
  return new Map(rows.map((r) => [r.orderLineId, r._sum.qty ?? 0]));
}

/**
 * Mal kabulü (tam ya da kısmi teslimat).
 * @param {any} db
 * @param {{ orderId: string, receivedOn: unknown, reference?: unknown, note?: unknown, requestKey: unknown, quantities: Record<string, unknown> }} v
 *   quantities: kesin revizyonun satır id'si → bu teslimatta gelen adet (stok biriminde)
 * @param {{ id: string, role: string, ip?: string | null }} actor
 * @param {{ now?: Date, timeZone?: string }} [opts]
 * @returns {Promise<{ ok: true, receiptId: string, seq: number, complete: boolean, duplicate?: true }
 *   | { ok: false, code: string, line?: string, remaining?: number, status?: string }>}
 */
export async function receiveGoods(db, v, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  const today = localDay(now, opts.timeZone ?? 'Europe/Bucharest');
  const p = parseReceipt(v, { today });
  if (!p.ok) return p;
  const orderId = String(v.orderId ?? '');
  const run = () => db.$transaction(async (tx) => {
    await lockKey(tx, `supplier-order:${orderId}`);
    const dup = await tx.supplierReceipt.findUnique({ where: { requestKey: p.requestKey }, select: { id: true, orderId: true, seq: true, complete: true } });
    if (dup) return dup.orderId === orderId ? { ok: true, duplicate: true, receiptId: dup.id, seq: dup.seq, complete: dup.complete } : { ok: false, code: 'CONFLICT' };
    const order = await tx.supplierOrder.findUnique({
      where: { id: orderId },
      include: {
        supplier: { select: { name: true } },
        revisions: {
          orderBy: { revision: 'desc' },
          include: {
            lines: {
              orderBy: { sortOrder: 'asc' },
              include: { product: { select: { id: true, code: true, nameRo: true, unitCode: true, packContent: true, packMeasure: true, category: { select: { code: true } } } } },
            },
          },
        },
      },
    });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    if (!RECEIVABLE_STATUSES.includes(order.status)) return { ok: false, code: 'NOT_ALLOWED', status: order.status };
    if (order.revisions.some((r) => !r.finalizedAt)) return { ok: false, code: 'HAS_DRAFT' };
    const final = order.revisions.find((r) => r.finalizedAt);
    if (!final) return { ok: false, code: 'NOT_ALLOWED', status: order.status };
    const byId = new Map(final.lines.map((l) => [l.id, l]));
    const balance = receiptBalance(final.lines, await receivedByLine(tx, order.id));
    const picked = [];
    for (const [lineId, qty] of p.quantities) {
      const line = byId.get(lineId);
      if (!line) return { ok: false, code: 'BAD_LINE' };
      if (!unitCompatible(line, line.product)) return { ok: false, code: 'UNIT_MISMATCH', line: line.code };
      const b = /** @type {{ remaining: number }} */ (balance.get(lineId));
      if (qty > b.remaining) return { ok: false, code: 'OVER_REMAINING', line: line.code, remaining: b.remaining };
      picked.push({ line, qty });
    }
    picked.sort((a, b) => a.line.sortOrder - b.line.sortOrder);
    const last = await tx.supplierReceipt.findFirst({ where: { orderId: order.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
    const seq = (last?.seq ?? 0) + 1;
    for (const { line, qty } of picked) {
      const b = /** @type {{ received: number, remaining: number }} */ (balance.get(line.id));
      balance.set(line.id, { ordered: line.qty, received: b.received + qty, remaining: b.remaining - qty });
    }
    const complete = fullyReceived(balance);
    const receipt = await tx.supplierReceipt.create({
      data: {
        orderId: order.id, revisionId: final.id, seq, receivedOn: new Date(`${p.receivedOn}T00:00:00.000Z`), reference: p.reference, note: p.note,
        requestKey: p.requestKey, complete, createdById: actor.id, createdAt: now,
        lines: {
          create: picked.map(({ line, qty }, i) => ({
            orderLineId: line.id, productId: line.productId, code: line.code, nameRo: line.product.nameRo || line.description, description: line.description,
            color: line.color, categoryCode: line.product.category?.code ?? null, lengthM: profileLength(line.product), qty, unitCode: line.unitCode, sortOrder: i,
          })),
        },
      },
    });
    const moves = await receiveSupplierStock(tx, {
      receiptId: receipt.id, note: `${order.orderNo} — mal kabul #${seq}`, actorId: actor.id, actor, at: now,
      lines: picked.map(({ line, qty }) => ({ productId: line.productId, qty })),
    });
    await tx.supplierOrder.update({
      where: { id: order.id },
      data: { version: { increment: 1 }, ...(complete ? { status: 'TESLIM_ALINDI', receivedAt: now } : {}) },
    });
    // Depo e-postası: kabulle AYNI işlemde tek iş (gönderim işçide; e-posta hatası stoğu geri almaz)
    await tx.notificationOutbox.create({ data: { type: RECEIPT_EMAIL, payload: { receiptId: receipt.id, supplierOrderId: order.id, seq, sentTo: [], unknown: [] } } });
    await writeAudit(tx, {
      action: 'SUPPLIER_GOODS_RECEIVED', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id,
      details: {
        orderNo: order.orderNo, seq, receiptId: receipt.id, receivedOn: p.receivedOn, reference: p.reference, complete, stockMoves: moves,
        lines: picked.map(({ line, qty }) => ({ code: line.code, qty, unitCode: line.unitCode })),
      },
    }, actor);
    return { ok: true, receiptId: receipt.id, seq, complete };
  });
  try {
    return await run();
  } catch (e) {
    // Aynı anahtar başka bir istekle aynı anda yazıldıysa (benzersizlik son güvence): ilk kabul döner, ikinci yazılmaz
    if (/** @type {any} */ (e)?.code === 'P2002') {
      const dup = await db.supplierReceipt.findUnique({ where: { requestKey: p.requestKey }, select: { id: true, orderId: true, seq: true, complete: true } });
      if (dup) return dup.orderId === orderId ? { ok: true, duplicate: true, receiptId: dup.id, seq: dup.seq, complete: dup.complete } : { ok: false, code: 'CONFLICT' };
    }
    throw e;
  }
}

// ---------- okuma ----------

/**
 * Sipariş ekranının mal kabulü bölümü: kesin revizyonun satırları (sipariş edilen / teslim alınan / kalan, birim uyumu) ve
 * kabuller (satırlar, kaydeden, depo e-postası durumu). Fiyat / maliyet döndürmez.
 * @typedef {{ id: string, code: string, description: string, color: string | null, qty: number, unitCode: string, sortOrder: number,
 *   length: string | null, compatible: boolean, ordered: number, received: number, remaining: number }} ReceiptLineView
 * @typedef {{ id: string, seq: number, receivedOn: Date, reference: string | null, note: string | null, complete: boolean, createdAt: Date,
 *   lines: { id: string, code: string, description: string, qty: number, unitCode: string }[], _count: { stockMoves: number },
 *   by: string | null, mail: { status: string, sentTo: number, lastError: string | null } | null }} ReceiptView
 * @param {any} db  @param {string} orderId
 * @returns {Promise<{ lines: ReceiptLineView[], receipts: ReceiptView[] } | null>}
 */
export async function loadReceipts(db, orderId) {
  const order = await db.supplierOrder.findUnique({
    where: { id: String(orderId ?? '') },
    select: {
      id: true,
      revisions: {
        where: { finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, take: 1,
        select: { lines: { orderBy: { sortOrder: 'asc' }, select: { id: true, code: true, description: true, color: true, qty: true, unitCode: true, sortOrder: true, product: { select: { unitCode: true, packContent: true, packMeasure: true } } } } },
      },
    },
  });
  if (!order) return null;
  const lines = order.revisions[0]?.lines ?? [];
  const balance = receiptBalance(lines, await receivedByLine(db, order.id));
  const receipts = await db.supplierReceipt.findMany({
    where: { orderId: order.id }, orderBy: { seq: 'desc' },
    include: { lines: { orderBy: { sortOrder: 'asc' } }, _count: { select: { stockMoves: true } } },
  });
  const users = await db.user.findMany({ where: { id: { in: [...new Set(receipts.map((r) => r.createdById).filter(Boolean))] } }, select: { id: true, name: true, email: true } });
  const jobs = receipts.length ? await db.notificationOutbox.findMany({ where: { type: RECEIPT_EMAIL, payload: { path: ['supplierOrderId'], equals: order.id } }, orderBy: { createdAt: 'desc' } }) : [];
  return {
    lines: lines.map((l) => ({ ...l, length: profileLength(l.product), compatible: unitCompatible(l, l.product), ...balance.get(l.id) })),
    receipts: receipts.map((r) => {
      const job = jobs.find((j) => j.payload?.receiptId === r.id) ?? null;
      const u = users.find((x) => x.id === r.createdById);
      return { ...r, by: u ? u.name || u.email : null, mail: job ? { status: job.status, sentTo: Array.isArray(job.payload?.sentTo) ? job.payload.sentTo.length : 0, lastError: job.lastError } : null };
    }),
  };
}
