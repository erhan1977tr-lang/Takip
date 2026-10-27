// Müşteri üretim onayı — MEVCUT siparişlerin kapsama alınması (karar 305, ürün sahibinin 26.10.2026 kararı).
//
// Planlanan yükleme günü kesim günü (varsayılan 06.11.2026) ya da sonrası olan cam siparişleri, durumu HAZIRLANIYOR ya da
// URETIMDE olsa da müşteri onayına alınır. Ana sipariş durumu, teklif sürümleri, fiyatlar, ölçüler, çizimler, yükleme
// tarihi, sandık, proforma ve muhasebe kayıtları DEĞİŞMEZ; yalnızca:
//   - Order.productionApprovalRequired = true (kapsam bayrağı)
//   - müşteriye gönderilmiş GÜNCEL sürümde onay talebi: Offer.approvalRequestedAt = geçiş anı. Daha önceki teklif gönderimi
//     onay sayılmaz. Süre (2 Romanya iş günü) burada BAŞLAMAZ: talep müşteriye iletildiğinde başlar (4.2.5 —
//     production-approval-delivery.js); iletilmeyen talepte süre yoktur
//   - siparişin geçmişine PRODUCTION_APPROVAL_REQUESTED, denetim kaydı, müşteriye olağan bildirim (e-posta + zil). Bildirim
//     ayrı ve kontrollü başlatılabilir: --bildirimsiz ile geçiş, sonra planNotify / applyNotify (tümü ya da seçilen
//     siparişler; aynı ön izleme + onay kodu kuralı, kuyrukta bekleyen talebe ikinci bildirim yazılmaz)
//
// İki adım, HTTP yolu yok (yalnızca sunucuda betik: scripts/production-approval-enroll.mjs):
//   planEnrollment  → salt okunur ön izleme: her siparişin kategorisi ve nedeni + onay kodu (ön izlemenin parmak izi)
//   applyEnrollment → aynı plan TEK işlemde, danışma kilidi altında yeniden hesaplanır; onay kodu tutmazsa hiçbir şey
//                     yazılmaz. Her sipariş koşullu yazılır (aynı siparişe iki kez talep açılmaz; ikinci çalıştırma "zaten
//                     kapsamda" sayar). Sipariş sürümü artırılır: geçiş sırasında siparişte yapılan bir işlem çakışmayı yakalar.
// Kategoriler (yalnızca REQUEST ve FLAG_ONLY yazılır; diğerleri raporlanır ve DOKUNULMAZ):
//   REQUEST     HAZIRLANIYOR / URETIMDE, güncel sürüm müşteriye gönderilmiş, onay talebi yok → bayrak + talep
//   FLAG_ONLY   YENI / HAZIRLANIYOR, güncel teklif henüz müşteride değil (daha önce gönderilmiş bir sürümden sonra yeni
//               sürüm hazırlanıyor olsa da) → yalnızca bayrak (onay, teklif müşteriye gönderildiğinde olağan kuralla
//               istenir; e-posta yok)
//   ALREADY     zaten kapsamda (bayrak + güncel sürümde talep / onay) → atlanır
//   LOADED      yüklendi (YUKLENDI) ya da herhangi bir yükleme onayı kalemi var (kısmi / çoklu yükleme dahil) → dokunulmaz
//   FINAL_INVOICED  nihai fatura kesilmiş (siparişin FGO faturası ya da kesilmiş müşteri faturası kapsamı) → dokunulmaz
//   COMPENSATION    telafi (-T) siparişi (iç üretim kararı) → dokunulmaz
//   NO_OFFER    URETIMDE ama müşteriye gönderilmiş güncel teklif yok (beklenmeyen eski kayıt) → dokunulmaz
import crypto from 'node:crypto';
import { outboxEvent } from '../domain/outbox.js';
import { enqueueOutbox, writeAudit, writeHistory } from './journal.js';
import { dayKey } from './loading.js';
import { APPROVAL_STATUSES, inApprovalScope } from './production-approval.js';
import { APPROVAL_REQUEST_TYPES } from './production-approval-delivery.js';

export const ENROLL_EVENT = 'PRODUCTION_APPROVAL_REQUESTED';
export const ENROLL_WRITES = Object.freeze(['REQUEST', 'FLAG_ONLY']);
const LOCK = 'production-approval-enroll';
/** Geçiş işleminin süre sınırı (çok sayıda sipariş tek işlemde) */
const TX = Object.freeze({ timeout: 120_000, maxWait: 10_000 });

const OFFER_SELECT = { id: true, status: true, sentAt: true, approvalRequestedAt: true, approvedAt: true, changeRequestedAt: true };

/**
 * Bir siparişin kategorisi (saf): yükleme / fatura / telafi önce gelir (bunlar hiçbir koşulda yazılmaz).
 * @param {{ status: string, compOfId?: string | null, productionApprovalRequired?: boolean, offers: { status: string, approvalRequestedAt?: any, approvedAt?: any }[] }} o
 * @param {{ loaded: boolean, finalInvoiced: boolean }} facts
 */
export function enrollCategory(o, { loaded, finalInvoiced }) {
  if (o.status === 'YUKLENDI' || loaded) return 'LOADED';
  if (finalInvoiced) return 'FINAL_INVOICED';
  if (o.compOfId) return 'COMPENSATION';
  const latest = o.offers[0] ?? null;
  if (latest?.status === 'GONDERILDI' && APPROVAL_STATUSES.includes(o.status)) {
    if (o.productionApprovalRequired && (latest.approvalRequestedAt || latest.approvedAt)) return 'ALREADY';
    return 'REQUEST';
  }
  if (o.status === 'URETIMDE') return 'NO_OFFER';
  if (o.status === 'YENI' || o.status === 'HAZIRLANIYOR') return o.productionApprovalRequired ? 'ALREADY' : 'FLAG_ONLY';
  return 'NO_OFFER';
}

/**
 * Salt okunur plan. Yalnızca okur (bir READ ONLY işlemde çağrılabilir).
 * @param {any} db  @param {{ cutoff: string }} p
 * @returns {Promise<{ cutoff: string, rows: object[], counts: Record<string, number>, code: string }>}
 */
export async function planEnrollment(db, { cutoff }) {
  // Gün sınırına bir gün pay bırakılır; kesin karar yerel gün anahtarıyla (dayKey) verilir
  const from = new Date(new Date(`${cutoff}T12:00:00Z`).getTime() - 2 * 86_400_000);
  const orders = await db.order.findMany({
    where: {
      orderTypeCode: 'GLASS_ORDER', removedAt: null, status: { notIn: ['IPTAL', 'ARSIVLENDI'] },
      OR: [{ estimatedShipDate: { gte: from } }, { actualShipDate: { gte: from } }],
    },
    orderBy: { orderNo: 'asc' },
    select: {
      id: true, orderNo: true, status: true, onHold: true, version: true, compOfId: true, productionApprovalRequired: true,
      estimatedShipDate: true, actualShipDate: true,
      offers: { orderBy: { createdAt: 'desc' }, select: OFFER_SELECT },
    },
  });
  const inScope = orders.filter((o) => inApprovalScope(dayKey(o.actualShipDate ?? o.estimatedShipDate), cutoff));
  const ids = inScope.map((o) => o.id);
  const [items, invoices, invoiceBatches, proformas, proformaBatches] = ids.length ? await Promise.all([
    db.loadingConfirmationItem.groupBy({ by: ['orderId'], where: { orderId: { in: ids } }, _count: { _all: true } }),
    db.fgoDocument.findMany({ where: { orderId: { in: ids }, kind: 'INVOICE' }, select: { orderId: true } }),
    db.billingBatchOrder.findMany({ where: { orderId: { in: ids }, batch: { kind: 'INVOICE', status: 'ISSUED' } }, select: { orderId: true } }),
    db.fgoDocument.findMany({ where: { orderId: { in: ids }, kind: 'PROFORMA' }, select: { orderId: true } }),
    db.billingBatchOrder.findMany({ where: { orderId: { in: ids }, activeKey: { not: null }, batch: { kind: 'PROFORMA' } }, select: { orderId: true } }),
  ]) : [[], [], [], [], []];
  const loaded = new Map(items.map((r) => [r.orderId, r._count._all]));
  const invoiced = new Set([...invoices, ...invoiceBatches].map((r) => r.orderId));
  const proforma = new Set([...proformas, ...proformaBatches].map((r) => r.orderId));
  const rows = inScope.map((o) => {
    const latest = o.offers[0] ?? null;
    const category = enrollCategory(o, { loaded: (loaded.get(o.id) ?? 0) > 0, finalInvoiced: invoiced.has(o.id) });
    return {
      id: o.id, orderNo: o.orderNo, status: o.status, onHold: o.onHold, version: o.version, shipDay: dayKey(o.actualShipDate ?? o.estimatedShipDate),
      category, offerId: latest?.id ?? null, offerStatus: latest?.status ?? null, sentAt: latest?.sentAt ?? null,
      confirmationItems: loaded.get(o.id) ?? 0, proforma: proforma.has(o.id), finalInvoice: invoiced.has(o.id),
      flagged: !!o.productionApprovalRequired,
    };
  });
  const counts = {};
  for (const r of rows) counts[r.category] = (counts[r.category] ?? 0) + 1;
  return { cutoff, rows, counts, code: approvalCodeOf(cutoff, rows) };
}

/** Onay kodu: yazılacak siparişlerin (kimlik, kategori, sürüm, güncel teklif) parmak izi — ön izleme değişirse değişir */
export function approvalCodeOf(cutoff, rows) {
  const basis = rows.filter((r) => ENROLL_WRITES.includes(r.category)).map((r) => `${r.id}:${r.category}:${r.version}:${r.offerId ?? '-'}`).sort().join('|');
  return crypto.createHash('sha256').update(`${cutoff}|${basis}`).digest('hex').slice(0, 10).toUpperCase();
}

/**
 * Planı uygular (tek işlem). Onay kodu ön izlemeninkiyle aynı olmalı (işlem içinde yeniden hesaplanır).
 * @param {any} db
 * @param {{ cutoff: string, code: string, operator: string, notify?: boolean, now?: Date }} p
 *   notify: false → müşteriye e-posta / zil kuyruğa yazılmaz; talep yazılır, süre BAŞLAMAZ (iletim yok) — bildirim sonra
 *   applyNotify ile kontrollü başlatılır
 * @returns {Promise<{ ok: true, requested: number, flagged: number, skipped: Record<string, number>, ids: string[] } | { ok: false, code: string, expected?: string }>}
 */
export async function applyEnrollment(db, { cutoff, code, operator, notify = true, now = new Date() }) {
  if (typeof code !== 'string' || !/^[0-9A-F]{10}$/.test(code)) return { ok: false, code: 'CODE_REQUIRED' };
  const op = String(operator ?? '').slice(0, 64) || 'bilinmiyor';
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`;
    const plan = await planEnrollment(tx, { cutoff });
    if (plan.code !== code) return { ok: false, code: 'APPROVAL_MISMATCH', expected: plan.code };
    let requested = 0;
    let flagged = 0;
    const ids = [];
    for (const r of plan.rows.filter((x) => ENROLL_WRITES.includes(x.category))) {
      // Sürüm kilidi: ön izlemeden bu yana siparişte işlem yapıldıysa tüm geçiş geri alınır (yeniden ön izleme)
      const bumped = await tx.order.updateMany({ where: { id: r.id, version: r.version }, data: { version: { increment: 1 }, productionApprovalRequired: true } });
      if (bumped.count !== 1) throw Object.assign(new Error('CONFLICT'), { code: 'CONFLICT', orderNo: r.orderNo });
      ids.push(r.id);
      if (r.category === 'FLAG_ONLY') {
        // Yalnızca kapsam bayrağı: müşteriye henüz bir şey sorulmadığı için geçmişe satır yazılmaz (denetim kaydında listelenir)
        flagged++;
        continue;
      }
      // Aynı sürüme ikinci talep açılmaz (koşullu); karar verilmiş sürüm atlanmaz — planda ALREADY olurdu
      const set = await tx.offer.updateMany({
        where: { id: r.offerId, orderId: r.id, status: 'GONDERILDI', approvalRequestedAt: null, approvedAt: null, changeRequestedAt: null },
        data: { approvalRequestedAt: now },
      });
      if (set.count !== 1) throw Object.assign(new Error('CONFLICT'), { code: 'CONFLICT', orderNo: r.orderNo });
      requested++;
      await writeHistory(tx, { orderId: r.id, event: ENROLL_EVENT, from: r.status, to: r.status, actorId: null });
      if (notify) {
        await enqueueOutbox(tx, outboxEvent(`ORDER_${ENROLL_EVENT}`, {
          orderId: r.id, payload: { approval: { offerId: r.offerId }, from: r.status, to: r.status, actorId: null },
        }));
      }
    }
    const skipped = {};
    for (const r of plan.rows) if (!ENROLL_WRITES.includes(r.category)) skipped[r.category] = (skipped[r.category] ?? 0) + 1;
    await writeAudit(tx, {
      action: 'PRODUCTION_APPROVAL_ENROLL', entityType: 'Order', entityId: null, userId: null,
      details: {
        cutoff, code, operator: op, via: 'SERVER_CLI', notify, requested, flagged, skipped, orders: ids,
      },
    }, { role: 'SYSTEM' });
    return { ok: true, requested, flagged, skipped, ids };
  }, TX).catch((e) => {
    if (e?.code === 'CONFLICT') return { ok: false, code: 'CONFLICT' };
    throw e;
  });
}

/**
 * Bildirimin kontrollü başlatılması — ön izleme (salt okunur): onay talebi açılmış, müşteriye İLETİLMEMİŞ, karara
 * bağlanmamış güncel sürümler; kuyrukta bekleyen gönderimi olan sürüm listelenmez (ikinci bildirim yazılmaz).
 * orderNos verilirse yalnızca o siparişler (pilot müşteriyle kademeli başlatma).
 * @param {any} db  @param {{ orderNos?: string[] | null }} [p]
 */
export async function planNotify(db, { orderNos = null } = {}) {
  const orders = await db.order.findMany({
    where: {
      orderTypeCode: 'GLASS_ORDER', removedAt: null, productionApprovalRequired: true, status: { in: [...APPROVAL_STATUSES] },
      ...(orderNos?.length ? { orderNo: { in: orderNos } } : {}),
    },
    orderBy: { orderNo: 'asc' },
    select: {
      id: true, orderNo: true, status: true, version: true,
      offers: { orderBy: { createdAt: 'desc' }, take: 1, select: { ...OFFER_SELECT, approvalDeliveredAt: true, approvalDeliveryError: true } },
    },
  });
  const open = orders.filter((o) => {
    const x = o.offers[0];
    // Talep kaydı olmayan güncel sürüm de (özellik kapalıyken gönderilmiş — acil durdurma, 4.2.6) bildirime alınır
    return x?.status === 'GONDERILDI' && !x.approvalDeliveredAt && !x.approvedAt && !x.changeRequestedAt;
  });
  const queued = open.length ? await db.notificationOutbox.findMany({
    where: { orderId: { in: open.map((o) => o.id) }, status: 'PENDING', type: { in: [...APPROVAL_REQUEST_TYPES] } },
    select: { orderId: true, payload: true },
  }) : [];
  const busy = new Set(queued.map((q) => `${q.orderId}:${q.payload?.approval?.offerId ?? ''}`));
  const rows = open.filter((o) => !busy.has(`${o.id}:${o.offers[0].id}`)).map((o) => ({
    id: o.id, orderNo: o.orderNo, status: o.status, version: o.version, offerId: o.offers[0].id, error: o.offers[0].approvalDeliveryError ?? null,
    requested: !!o.offers[0].approvalRequestedAt,
  }));
  const missing = orderNos?.length ? orderNos.filter((n) => !rows.some((r) => r.orderNo === n)) : [];
  const basis = rows.map((r) => `${r.id}:${r.offerId}:${r.version}`).sort().join('|');
  return { rows, missing, code: crypto.createHash('sha256').update(`NOTIFY|${basis}`).digest('hex').slice(0, 10).toUpperCase() };
}

/**
 * Bildirimi başlatır (tek işlem, aynı danışma kilidi): her sürüm için ORDER_PRODUCTION_APPROVAL_REQUESTED kuyruğa yazılır
 * (e-posta + zil); süre iletimde başlar. Onay kodu ön izlemeninkiyle aynı olmalı. Koşullu: sürüm bu arada iletildiyse /
 * karara bağlandıysa / sipariş değiştiyse hiçbir şey yazılmaz (CONFLICT).
 * @param {any} db  @param {{ code: string, operator: string, orderNos?: string[] | null, now?: Date }} p
 */
export async function applyNotify(db, { code, operator, orderNos = null, now = new Date() }) {
  if (typeof code !== 'string' || !/^[0-9A-F]{10}$/.test(code)) return { ok: false, code: 'CODE_REQUIRED' };
  const op = String(operator ?? '').slice(0, 64) || 'bilinmiyor';
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK}, 0))`;
    const plan = await planNotify(tx, { orderNos });
    if (plan.code !== code) return { ok: false, code: 'APPROVAL_MISMATCH', expected: plan.code };
    for (const r of plan.rows) {
      const bumped = await tx.order.updateMany({ where: { id: r.id, version: r.version }, data: { version: { increment: 1 } } });
      if (bumped.count !== 1) throw Object.assign(new Error('CONFLICT'), { code: 'CONFLICT' });
      const w = await tx.offer.updateMany({
        where: { id: r.offerId, status: 'GONDERILDI', approvalDeliveredAt: null, approvedAt: null, changeRequestedAt: null },
        data: { approvalDeliveryError: null, approvalDeliveryFailedAt: null, ...(r.requested ? {} : { approvalRequestedAt: now }) },
      });
      if (w.count !== 1) throw Object.assign(new Error('CONFLICT'), { code: 'CONFLICT' });
      await enqueueOutbox(tx, outboxEvent(`ORDER_${ENROLL_EVENT}`, {
        orderId: r.id, payload: { approval: { offerId: r.offerId }, from: r.status, to: r.status, actorId: null },
      }));
    }
    await writeAudit(tx, {
      action: 'PRODUCTION_APPROVAL_NOTIFY', entityType: 'Order', entityId: null, userId: null,
      details: { code, operator: op, via: 'SERVER_CLI', at: now.toISOString(), queued: plan.rows.length, orders: plan.rows.map((r) => r.id), filter: orderNos ?? null },
    }, { role: 'SYSTEM' });
    return { ok: true, queued: plan.rows.length, missing: plan.missing };
  }, TX).catch((e) => {
    if (e?.code === 'CONFLICT') return { ok: false, code: 'CONFLICT' };
    throw e;
  });
}
