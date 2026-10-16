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
import { lockStock, receiveSupplierStock, reverseSupplierStock, stockLevels } from '../profile/stock.js';
import {
  RECEIPT_EMAIL, RECEIVABLE_STATUSES, correctionBalance, fullyReceived, netReceived, parseCorrection, parseReceipt, profileLength, receiptBalance, reopenStatus,
  unitCompatible,
} from './receipt-rules.js';

const FORBIDDEN = /** @type {const} */ ({ ok: false, code: 'FORBIDDEN' });
const allowed = (actor) => can(actor?.role, 'SUPPLIER_MANAGE') && can(actor?.role, 'STOCK_MANAGE');
const lockKey = (tx, key) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

/** Kabulün depo e-postası işleri (yük alanındaki kabul kimliğiyle) */
export const receiptJobsWhere = (receiptId) => ({ type: RECEIPT_EMAIL, payload: { path: ['receiptId'], equals: receiptId } });

/**
 * Satır başına NET teslim alınan (sipariş satırı id → adet) = kabullerin toplamı − kabul düzeltmelerinin toplamı (karar 286).
 * Kalan miktar, beklenen tedarik ve raporlar bu net miktarı kullanır.
 * @param {any} tx  @param {string} orderId
 * @returns {Promise<Map<string, number>>}
 */
export async function receivedByLine(tx, orderId) {
  const [rows, fixes] = await Promise.all([
    tx.supplierReceiptLine.groupBy({ by: ['orderLineId'], where: { receipt: { orderId } }, _sum: { qty: true } }),
    tx.supplierReceiptCorrectionLine.groupBy({ by: ['orderLineId'], where: { correction: { orderId } }, _sum: { qty: true } }),
  ]);
  return netReceived(rows, fixes);
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

/**
 * Hatalı mal kabulünün düzeltmesi (3.91.0, karar 286): kabulün satırlarından seçilenler için düzeltilen adet stoktan düşülür
 * (KABUL_DUZELTME, −); orijinal kabul, satırları, INTRAREA MARFĂ belgesi ve gönderilmiş e-postalar DEĞİŞMEZ. Düzeltme ayrı
 * kayıttır (gerekçe, kullanıcı, zaman, ürün, adet, önceki / yeni stok); net teslim alınan ve kalan miktar bundan hesaplanır.
 * Aynı işlemde: düzeltme + stok hareketi + (otomatik kapanmış ve artık eksik olan sipariş) yeniden açılma + depo e-postası
 * işi (tek iş; işçi gönderir) + denetim kaydı. Herhangi bir adım reddedilirse hiçbiri yazılmaz.
 *
 * Reddedilir: yetki (FORBIDDEN), form (KEY / REASON / VERSION / QTY / EMPTY), kabul bu siparişin değil (NOT_FOUND), eski
 * ekran (STALE — siparişin sürümü ekrandakinden farklı), satır kabulde yok (BAD_LINE), düzeltilebilir miktar aşıldı
 * (OVER_CORRECTABLE), stok yetmiyor — stok eksiye düşmez (INSUFFICIENT_STOCK), aynı form başka sipariş için (CONFLICT).
 * Tekrar: aynı form anahtarı ilk düzeltmeyi döndürür (duplicate), ikinci düzeltme / ikinci stok hareketi yazılmaz.
 * Kilit sırası (mal kabulüyle aynı): supplier-order:<id> → ürün stok kilitleri.
 * @param {any} db
 * @param {{ orderId: string, receiptId: string, reason: unknown, requestKey: unknown, expectedVersion: unknown, quantities: Record<string, unknown> }} v
 *   quantities: kabul satırı id → düzeltilecek adet
 * @param {{ id: string, role: string, ip?: string | null }} actor
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<{ ok: true, correctionId: string, seq: number, reopened: boolean, duplicate?: true }
 *   | { ok: false, code: string, line?: string, correctable?: number, stock?: number }>}
 */
export async function correctReceipt(db, v, actor, opts = {}) {
  if (!allowed(actor)) return FORBIDDEN;
  const now = opts.now ?? new Date();
  const p = parseCorrection(v);
  if (!p.ok) return p;
  const orderId = String(v.orderId ?? '');
  const receiptId = String(v.receiptId ?? '');
  const dupOf = (d) => (d.orderId === orderId && d.receiptId === receiptId ? { ok: true, duplicate: true, correctionId: d.id, seq: d.seq, reopened: d.reopened } : { ok: false, code: 'CONFLICT' });
  const run = () => db.$transaction(async (tx) => {
    await lockKey(tx, `supplier-order:${orderId}`);
    const dup = await tx.supplierReceiptCorrection.findUnique({ where: { requestKey: p.requestKey }, select: { id: true, orderId: true, receiptId: true, seq: true, reopened: true } });
    if (dup) return dupOf(dup);
    const order = await tx.supplierOrder.findUnique({ where: { id: orderId }, select: { id: true, orderNo: true, status: true, version: true, receivedAt: true, sentAt: true, sendError: true } });
    if (!order) return { ok: false, code: 'NOT_FOUND' };
    const receipt = await tx.supplierReceipt.findUnique({ where: { id: receiptId }, include: { lines: { orderBy: { sortOrder: 'asc' } } } });
    if (!receipt || receipt.orderId !== order.id) return { ok: false, code: 'NOT_FOUND' };
    if (order.version !== p.expectedVersion) return { ok: false, code: 'STALE' };
    const prev = await tx.supplierReceiptCorrectionLine.groupBy({ by: ['receiptLineId'], where: { correction: { receiptId: receipt.id } }, _sum: { qty: true } });
    const balance = correctionBalance(receipt.lines, new Map(prev.map((r) => [r.receiptLineId, r._sum.qty ?? 0])));
    const byId = new Map(receipt.lines.map((l) => [l.id, l]));
    const picked = [];
    for (const [lineId, qty] of p.quantities) {
      const line = byId.get(lineId);
      if (!line) return { ok: false, code: 'BAD_LINE' };
      const b = /** @type {{ correctable: number }} */ (balance.get(lineId));
      if (qty > b.correctable) return { ok: false, code: 'OVER_CORRECTABLE', line: line.code, correctable: b.correctable };
      picked.push({ line, qty });
    }
    picked.sort((a, b) => a.line.sortOrder - b.line.sortOrder);
    // Stok: ürün kilitleri altında (mal kabulü ve depo çıkışıyla aynı sıra); stok eksiye düşmez
    const ids = picked.map((x) => x.line.productId);
    await lockStock(tx, ids);
    const levels = await stockLevels(tx, ids);
    const need = new Map();
    for (const { line, qty } of picked) need.set(line.productId, (need.get(line.productId) ?? 0) + qty);
    for (const { line } of picked) {
      const have = levels.get(line.productId) ?? 0;
      if (have < (need.get(line.productId) ?? 0)) return { ok: false, code: 'INSUFFICIENT_STOCK', line: line.code, stock: Math.max(0, have) };
    }
    // Önceki / yeni bakiye satır sırasıyla (aynı ürün iki satırdaysa ikinci satır birincinin sonrasından başlar)
    const running = new Map(levels);
    const rows = picked.map(({ line, qty }) => {
      const before = running.get(line.productId) ?? 0;
      running.set(line.productId, before - qty);
      return { line, qty, before, after: before - qty };
    });
    const last = await tx.supplierReceiptCorrection.findFirst({ where: { orderId: order.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
    const seq = (last?.seq ?? 0) + 1;
    // Düzeltmeden sonra siparişin bakiyesi: otomatik kapanmış ve artık eksik sipariş yeniden açılır
    const final = await tx.supplierOrderRevision.findFirst({ where: { orderId: order.id, finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, select: { lines: { select: { id: true, qty: true } } } });
    const net = await receivedByLine(tx, order.id);
    for (const { line, qty } of picked) net.set(line.orderLineId, Math.max(0, (net.get(line.orderLineId) ?? 0) - qty));
    const stillComplete = fullyReceived(receiptBalance(final?.lines ?? [], net));
    const receipts = await tx.supplierReceipt.findMany({ where: { orderId: order.id }, select: { complete: true, createdAt: true } });
    const reopen = reopenStatus(order, receipts, stillComplete);
    const correction = await tx.supplierReceiptCorrection.create({
      data: {
        orderId: order.id, receiptId: receipt.id, seq, reason: p.reason, requestKey: p.requestKey, reopened: !!reopen, createdById: actor.id, createdAt: now,
        lines: {
          create: rows.map(({ line, qty, before, after }, i) => ({
            receiptLineId: line.id, orderLineId: line.orderLineId, productId: line.productId, code: line.code, nameRo: line.nameRo, description: line.description,
            color: line.color, categoryCode: line.categoryCode, lengthM: line.lengthM, qty, unitCode: line.unitCode, stockBefore: before, stockAfter: after, sortOrder: i,
          })),
        },
      },
    });
    const moves = await reverseSupplierStock(tx, {
      correctionId: correction.id, note: `${order.orderNo} — mal kabul #${receipt.seq} düzeltme #${seq}`, actorId: actor.id, actor, at: now,
      lines: picked.map(({ line, qty }) => ({ productId: line.productId, qty })),
    });
    await tx.supplierOrder.update({
      where: { id: order.id },
      data: { version: { increment: 1 }, ...(reopen ? { status: reopen, receivedAt: null } : {}) },
    });
    // Depo e-postası: düzeltmeyle AYNI işlemde tek iş (orijinal kabulün e-postası yeniden gönderilmez)
    await tx.notificationOutbox.create({ data: { type: RECEIPT_EMAIL, payload: { correctionId: correction.id, correctionOf: receipt.id, supplierOrderId: order.id, seq, receiptSeq: receipt.seq, sentTo: [], unknown: [] } } });
    await writeAudit(tx, {
      action: 'SUPPLIER_RECEIPT_CORRECTED', entityType: 'SupplierOrder', entityId: order.id, userId: actor.id,
      details: {
        orderNo: order.orderNo, seq, correctionId: correction.id, receiptId: receipt.id, receiptSeq: receipt.seq, reason: p.reason,
        reopened: reopen ? { from: order.status, to: reopen } : null, stockMoves: moves,
        lines: rows.map(({ line, qty, before, after }) => ({ code: line.code, productId: line.productId, qty, unitCode: line.unitCode, stockBefore: before, stockAfter: after })),
      },
    }, actor);
    return { ok: true, correctionId: correction.id, seq, reopened: !!reopen };
  });
  try {
    return await run();
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'P2002') {
      const dup = await db.supplierReceiptCorrection.findUnique({ where: { requestKey: p.requestKey }, select: { id: true, orderId: true, receiptId: true, seq: true, reopened: true } });
      if (dup) return dupOf(dup);
    }
    if (/** @type {any} */ (e)?.code === 'INSUFFICIENT_STOCK') return { ok: false, code: 'INSUFFICIENT_STOCK' };
    throw e;
  }
}

// ---------- okuma ----------

/**
 * Sipariş ekranının mal kabulü bölümü: kesin revizyonun satırları (sipariş edilen / teslim alınan / kalan, birim uyumu) ve
 * kabuller (satırlar, kaydeden, depo e-postası durumu). Fiyat / maliyet döndürmez.
 * @typedef {{ id: string, code: string, description: string, color: string | null, qty: number, unitCode: string, sortOrder: number,
 *   length: string | null, compatible: boolean, ordered: number, received: number, remaining: number }} ReceiptLineView
 * @typedef {{ status: string, sentTo: number, lastError: string | null }} MailView
 * @typedef {{ id: string, seq: number, reason: string, reopened: boolean, createdAt: Date, by: string | null, mail: MailView | null,
 *   lines: { id: string, receiptLineId: string, code: string, description: string, qty: number, unitCode: string, stockBefore: number, stockAfter: number }[] }} CorrectionView
 * @typedef {{ id: string, seq: number, receivedOn: Date, reference: string | null, note: string | null, complete: boolean, createdAt: Date,
 *   lines: { id: string, code: string, description: string, qty: number, unitCode: string, corrected: number, net: number, correctable: number }[],
 *   _count: { stockMoves: number }, by: string | null, mail: MailView | null, corrections: CorrectionView[] }} ReceiptView
 * Kabul satırında: qty = orijinal kabul (değişmez), corrected = düzeltmelerin toplamı, net = qty − corrected, correctable = net.
 * @param {any} db  @param {string} orderId
 * @returns {Promise<{ lines: ReceiptLineView[], receipts: ReceiptView[], version: number } | null>}
 */
export async function loadReceipts(db, orderId) {
  const order = await db.supplierOrder.findUnique({
    where: { id: String(orderId ?? '') },
    select: {
      id: true, version: true,
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
    include: {
      lines: { orderBy: { sortOrder: 'asc' } }, _count: { select: { stockMoves: true } },
      corrections: { orderBy: { seq: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
    },
  });
  const people = receipts.flatMap((r) => [r.createdById, ...r.corrections.map((c) => c.createdById)]);
  const users = await db.user.findMany({ where: { id: { in: [...new Set(people.filter(Boolean))] } }, select: { id: true, name: true, email: true } });
  const jobs = receipts.length ? await db.notificationOutbox.findMany({ where: { type: RECEIPT_EMAIL, payload: { path: ['supplierOrderId'], equals: order.id } }, orderBy: { createdAt: 'desc' } }) : [];
  const who = (id) => { const u = users.find((x) => x.id === id); return u ? u.name || u.email : null; };
  const mailOf = (job) => (job ? { status: job.status, sentTo: Array.isArray(job.payload?.sentTo) ? job.payload.sentTo.length : 0, lastError: job.lastError } : null);
  return {
    version: order.version,
    lines: lines.map((l) => ({ ...l, length: profileLength(l.product), compatible: unitCompatible(l, l.product), ...balance.get(l.id) })),
    receipts: receipts.map((r) => {
      const fixed = new Map();
      for (const c of r.corrections) for (const l of c.lines) fixed.set(l.receiptLineId, (fixed.get(l.receiptLineId) ?? 0) + l.qty);
      const bal = correctionBalance(r.lines, fixed);
      return {
        ...r,
        lines: r.lines.map((l) => { const b = bal.get(l.id); return { ...l, corrected: b.corrected, net: b.correctable, correctable: b.correctable }; }),
        by: who(r.createdById),
        // Kabulün kendi işi: yükünde receiptId olan (düzeltme işlerinde correctionId vardır, receiptId yoktur)
        mail: mailOf(jobs.find((j) => j.payload?.receiptId === r.id && !j.payload?.correctionId) ?? null),
        corrections: r.corrections.map((c) => ({
          id: c.id, seq: c.seq, reason: c.reason, reopened: c.reopened, createdAt: c.createdAt, by: who(c.createdById),
          mail: mailOf(jobs.find((j) => j.payload?.correctionId === c.id) ?? null),
          lines: c.lines.map((l) => ({ id: l.id, receiptLineId: l.receiptLineId, code: l.code, description: l.description, qty: l.qty, unitCode: l.unitCode, stockBefore: l.stockBefore, stockAfter: l.stockAfter })),
        })),
      };
    }),
  };
}
