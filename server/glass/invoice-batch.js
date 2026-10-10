// Onaylı yüklemeden müşteri faturası ve müşteri proformasının avans zinciri (Aşama 7D-3, karar 101).
//
//   Kaynak: YALNIZCA onaylı yükleme (LoadingConfirmation) ve LOADED kalemleri (LoadingConfirmationItem). Planlanan gün,
//   siparişin güncel adedi, güncel teklif, fiyat tablosu ya da "+2 gün" kuralı faturaya girmez. Kısmi yüklemede yalnızca
//   o onayda LOADED olan adet faturalanır; kalan, ileride onaylandığı yüklemenin faturasına girer.
//
//   Müşteri başına fatura: bir onaydaki LOADED kalemler müşteriye göre ayrılır. Bir müşterinin kapsamı, birbirine
//   eklenemeyecek kaynaklar varsa ayrı fatura gruplarına bölünür (kur ortalaması / uydurma kur yok):
//     - kaynak para birimi (EUR, RON)
//     - belge zinciri: müşteri proforması (PROFORMA partisi — kur o partinin kur kaydıdır) ya da zincirsiz (doğrudan
//       fatura — kur, parti oluşturulurken müşterinin kur politikasından bir kez çözülür)
//   Uyumlu kapsamda sonuç: onay + müşteri başına TEK fatura.
//
//   Satırlar: sipariş faturasıyla aynı kural (invoiceLines — yalnızca cam, işlemler ait olduğu cama eklenir), onay
//   kalemlerinden; siparişler arasında birleştirilmez, açıklama "Comanda {no} — …" ile başlar.
//
//   Avans zinciri (sipariş başına akışın müşteri partisine uyarlanmış hâli):
//     proformaya FGO'da tahsilat görünür → avans faturası (tutar = tahsilat − daha önce avansı kesilen) → fatura, avansı
//     "Stornare avans conform factură …" eksi satırıyla düşer. Proformada avansı kesilmemiş tahsilat varken fatura
//     KESİLMEZ (ADVANCE_REQUIRED); avans yüklemeden sonra da kesilebilir. Bir fatura, avansın en çok kendi tutarı
//     kadarını düşer; kalanı zincirin sonraki faturalarına kalır (proforma birden çok yüklemeyi kapsayabilir).
//
//   Yükleme düzeltmesi (Aşama 7F-1, karar 105): kaynak, onayın GEÇERLİ kalemleridir (effectiveItems — düzeltmeler
//   uygulanmış). Düzeltme kesilmiş bir faturanın kapsamını değiştirdiyse hiçbir belge OTOMATİK kesilmez / değiştirilmez:
//   fark yalnızca saptanır (orderImpacts → UNDER_INVOICED / OVER_INVOICED = "muhasebe işlemi gerekli") ve o kapsamın
//   yeniden faturalanması engellenir — onayın siparişi zaten fatura partisindedir (activeKey); fazla faturalanan kapsamdan
//   ileri güne aktarılan cam, yüklendiği onayda müşteri faturasına ALINMAZ (heldReplans → ACCOUNTING_ACTION).
//   Storno / düzeltme faturası / ek fatura Aşama 7F-2'dedir.
//
//   Sipariş seçimi (karar 125): yönetici bir fatura grubunun UYGUN siparişlerinden yalnızca seçtiklerini faturaya alabilir
//   (select: { key, orderIds }). Seçim yalnızca grubun siparişlerini daraltır; uygunluğu, kapsamı (geçerli LOADED kalemler),
//   kuru, avans kurallarını ve dondurmaları yine bu hesap belirler. Grubun dışındaki bir sipariş (başka para birimi / zincir,
//   zaten faturalanmış, sipariş zincirinde, muhasebe işlemi bekleyen …) seçilirse fatura oluşturulmaz (NOT_ELIGIBLE).
//   Seçilmeyen sipariş olduğu gibi kalır ve aynı onaydan sonraki faturaya girer; avans düşümü seçilen faturanın tutarına göredir.
//
//   Siparişin KENDİ proforma zinciri (P1, karar 239 — önceki "sipariş sayfasından, siparişin tamamı" kuralının yerine):
//   kendi proforması (FgoDocument PROFORMA) olan siparişin nihai faturası da BURADAN, aynı hesapla kesilir — yalnızca o
//   onayda YÜKLENEN ve henüz faturalanmamış kapsam (kısmi yüklemede kısmi fatura; kalan sonraki onayın faturasına girer).
//   Ödeme şartı yoktur. Zincir siparişin kendisidir: kur = proformanın kur kaydı (GlassBilling, yeniden çözülmez), avans =
//   siparişin avans faturaları (her biri en çok kendi kalanı kadar, "Stornare avans" eksi satırı; BillingBatchLine.refDocId),
//   avansı kesilmemiş tahsilat varken fatura kesilmez (ADVANCE_REQUIRED). Her böyle sipariş kendi fatura grubudur (kendi
//   kuru), parti BillingBatch.chainOrderId taşır. Sipariş düzeyinde istek kuyruktayken (proforma / avans kesiliyor) kapsam
//   beklenir (ORDER_PENDING); eski sipariş düzeyi kapanış faturası olan sipariş yeniden faturalanmaz (ORDER_INVOICED).
//
//   Parti (BillingBatch, kind INVOICE / ADVANCE) değişmez kopyadır; belgeyi işçi yalnızca kayıttan keser
//   (server/glass/batch.js → dispatchBatchJobs). Tekrar engeli: müşteri + sipariş kilitleri, önizleme parmak izi,
//   BillingBatch.uniqueKey ve BillingBatchOrder.activeKey (veritabanında benzersiz), FGO IdExtern.
import crypto from 'node:crypto';
import { can } from '../auth/permissions.js';
import { getEnv } from '../env.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { parseDateOnly } from '../orders/rules.js';
import { effectiveItems, itemAsLine, itemKey, scopeOf, shipDayDate } from '../loading/confirmation.js';
import { glassLabel } from '../catalog/glass.js';
import { bnrRate } from '../fx/bnr.js';
import { FxUnavailable, fxSnapshot, resolveExchangeRate } from '../fx/resolve.js';
import { dailyLimitReached, fgoReady, getFgoSettings, missingBilling } from '../integrations/fgo.js';
import { dayDate, localDay, localDayStart } from '../profile/dates.js';
import { GLASS_FGO, glassLines, glassTotals, invoiceLines, netOf, orderChain } from './billing.js';
import { BATCH_FGO } from './batch.js';
import { centsText, paymentState, toCents } from '../finance/payments.js';
import { advanceRisk, financeLock, recordDuplicateAck } from '../finance/service.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => (v == null ? 0 : Number(v));
const ddmmyyyy = (day) => day.split('-').reverse().join('.');
const isUnique = (e) => e?.code === 'P2002';
const EPS = 0.005;

/** Fatura grubunun kimliği = partinin tekrar anahtarı (zincir: müşteri proforması partisi, siparişin kendi zinciri ya da yok) */
export const invoiceKeyOf = ({ confirmationId, customerId, currency, chainId, orderChainId = null }) =>
  `INVOICE:${confirmationId}:${customerId}:${currency}:${chainId ?? (orderChainId ? `ORDER-${orderChainId}` : 'DIRECT')}`;
/** Bir siparişin bir onaydaki yüklenen kapsamı bir kez faturalanır */
export const invoiceOrderKey = (confirmationId, orderId) => `INVOICE:${confirmationId}:${orderId}`;
const refOf = (doc) => (doc ? `${doc.series}${doc.number}` : null);

/** Partinin kur kaydı → çözücü sonucu biçimi (zincirdeki fatura proformanın kurunu kullanır; yeniden çözülmez) */
const fxOfBatch = (b) => ({
  policy: b.fxPolicy, currency: b.fxCurrency, baseRate: Number(b.fxBaseRate).toFixed(4), markupPercent: b.fxMarkupPercent == null ? null : Number(b.fxMarkupPercent).toFixed(3),
  finalRate: Number(b.fxRate).toFixed(4), rate: Number(b.fxRate), source: b.fxSource, sourceDate: new Date(b.fxSourceDate).toISOString().slice(0, 10),
  resolvedAt: new Date(b.fxResolvedAt).toISOString(), manual: b.fxManual === true,
});

/**
 * Siparişin proformasının kur kaydı → çözücü sonucu biçimi (siparişin zincirindeki fatura proformanın kurunu kullanır;
 * yeniden çözülmez — karar 96). Eski kayıtta eksik alanlar kur kaydının kendisinden tamamlanır. Kur yoksa null.
 * @param {any} b  GlassBilling  @param {string} currency
 */
export function fxOfOrderChain(b, currency) {
  if (!b || b.fxRate == null || !(Number(b.fxRate) > 0)) return null;
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const rateDay = b.fxDate ?? b.fxResolvedAt ?? new Date();
  return {
    policy: b.fxPolicy ?? 'MANUAL', currency: b.fxCurrency ?? currency, baseRate: Number(b.fxBaseRate ?? b.fxRate).toFixed(4),
    markupPercent: b.fxMarkupPercent == null ? null : Number(b.fxMarkupPercent).toFixed(3), finalRate: Number(b.fxRate).toFixed(4), rate: Number(b.fxRate),
    source: b.fxSource ?? 'MANUAL', sourceDate: day(b.fxSourceDate ?? rateDay), resolvedAt: new Date(b.fxResolvedAt ?? rateDay).toISOString(), manual: b.fxManual === true,
  };
}

/** Siparişin proforma kur kaydı → fatura partisinin kur alanları (eski kayıtta eksikler kayıttan tamamlanır) */
function fxDataOfOrderChain(b, currency) {
  const rateDay = b.fxDate ?? b.fxResolvedAt ?? new Date();
  return {
    fxRate: b.fxRate, fxDate: rateDay, fxSource: b.fxSource ?? 'MANUAL', fxPolicy: b.fxPolicy ?? 'MANUAL', fxCurrency: b.fxCurrency ?? currency,
    fxBaseRate: b.fxBaseRate ?? b.fxRate, fxMarkupPercent: b.fxMarkupPercent ?? null, fxSourceDate: b.fxSourceDate ?? rateDay,
    fxResolvedAt: b.fxResolvedAt ?? rateDay, fxManual: b.fxManual === true,
  };
}

/**
 * Siparişin KENDİ proforma zincirinin (sipariş başına FgoDocument'ler) fatura için avans durumu (P1, karar 239). Tahsilat
 * ve avans tek kuraldan (orderChain — sipariş sayfası, istek ve işçi aynı sonucu kullanır); her avans faturasının kalanı =
 * avansın tutarı − bu zincirin etkin (VOID olmayan) fatura partilerinde onu düşen satırlar (BillingBatchLine.refDocId).
 * @param {any} db  @param {{ id: string, fgoDocuments: any[], manualPayments?: any[] }} order
 */
export async function orderChainState(db, order) {
  const c = orderChain(order.fgoDocuments, order.manualPayments ?? []);
  if (!c.proforma) return null;
  const ids = c.advances.map((a) => a.id).filter(Boolean);
  const invoices = await db.billingBatch.count({ where: { chainOrderId: order.id, kind: 'INVOICE', status: { not: 'VOID' } } });
  const usedRows = ids.length
    ? await db.billingBatchLine.findMany({ where: { refDocId: { in: ids }, batch: { kind: 'INVOICE', status: { not: 'VOID' } } }, select: { refDocId: true, ronGross: true } })
    : [];
  const used = new Map();
  for (const r of usedRows) used.set(r.refDocId, round2((used.get(r.refDocId) ?? 0) + num(r.ronGross)));
  const advances = c.advances.map((a) => {
    const gross = a.total != null ? Number(a.total) : num(a.advanced);
    const spent = used.get(a.id) ?? 0;
    return { docId: a.id, ref: refOf(a), gross, used: spent, left: round2(Math.max(0, gross - spent)) };
  });
  return {
    ref: refOf(c.proforma), total: c.proforma.total == null ? null : Number(c.proforma.total), paid: c.paid, manualRon: c.manualRon,
    advanced: c.advanced, advanceRequired: c.advanceRequired, basis: c.basis, match: c.match, advancePending: false, advances, invoices,
  };
}

/**
 * Müşteri proformasının (PROFORMA partisi) avans durumu — tek yerde hesaplanır.
 *   paid            : FGO'nun proformada gösterdiği tahsilat (TVA dahil) — "FGO doğrulandı"
 *   manualRon       : partinin siparişlerinde yöneticinin elle kaydettiği ödemeler (RON; karar 206)
 *   advanced        : etkin avans partilerinin toplamı (kuyruktaki / kesilemeyen dahil)
 *   advanceRequired : max(paid, manualRon) − advanced (> 0 ise fatura kesilmez; aynı ödeme iki kez sayılmaz — karar 207)
 *   advances[].left : kesilmiş avansın henüz faturada düşülmemiş kısmı
 * @param {any} db  @param {string} proformaBatchId
 */
export async function chainState(db, proformaBatchId) {
  const p = await db.billingBatch.findUnique({
    where: { id: proformaBatchId },
    include: {
      document: true,
      children: { where: { status: { not: 'VOID' } }, orderBy: { createdAt: 'asc' }, include: { document: true, lines: { select: { ronGross: true, refBatchId: true } } } },
    },
  });
  if (!p) return null;
  const invoices = p.children.filter((c) => c.kind === 'INVOICE');
  const used = new Map();
  for (const l of invoices.flatMap((c) => c.lines)) if (l.refBatchId) used.set(l.refBatchId, round2((used.get(l.refBatchId) ?? 0) + num(l.ronGross)));
  const advances = p.children.filter((c) => c.kind === 'ADVANCE').map((a) => {
    const planned = round2(a.lines.reduce((s, l) => s + num(l.ronGross), 0));
    // Düşülebilecek tutar: FGO'nun avans faturasında gösterdiği toplam (okunmadıysa kesilen tutar)
    const gross = a.document?.total != null ? Number(a.document.total) : planned;
    const spent = used.get(a.id) ?? 0;
    return { batchId: a.id, status: a.status, ref: refOf(a.document), lastError: a.lastError ?? null, planned, gross, used: spent, left: a.status === 'ISSUED' ? round2(Math.max(0, gross - spent)) : 0 };
  });
  const manual = await db.manualPayment.findMany({ where: { batchId: p.id }, select: { ron: true, voidedAt: true } });
  const plannedCents = advances.reduce((s, a) => s + toCents(a.planned), 0n);
  const payments = paymentState({ fgoPaid: p.document?.paid ?? 0, proformaTotal: p.document?.total ?? null, payments: manual, advanced: centsText(plannedCents) });
  return {
    batch: p, ref: refOf(p.document), total: p.document?.total == null ? null : Number(p.document.total),
    paid: payments.fgoPaid, manualRon: payments.manualRon, advanced: payments.advanced, advanceRequired: payments.advanceRequired, basis: payments.advanceBasis,
    match: payments.match, payments, advancePending: advances.some((a) => a.status !== 'ISSUED'), advances, invoices: invoices.length,
  };
}

/**
 * Avans faturası partisi: proformaya gelen ve avansı kesilmemiş tahsilat kadar (uydurma tutar yok). Yükleme öncesi de
 * sonrası da kesilebilir. Tek satır: "Avans marfă conform proformă …" (sipariş başına avans faturasıyla aynı).
 * @param {any} db
 * Aynı müşteride aynı tutarlı avans / başka zincirde aynı tutarlı elle kayıt varsa DUPLICATE_RISK (karar 208): ack = ackKey.
 * @param {{ proformaBatchId: string, actor: any, now?: Date, ack?: string | null }} o
 * @returns {Promise<{ ok: true, batchId: string, amount: number } | { ok: false, code: string, matches?: any[], ackKey?: string }>}
 */
export async function createAdvanceBatch(db, { proformaBatchId, actor, now = new Date(), ack = null }) {
  if (!can(actor?.role, 'ACCOUNTING_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  if (await dailyLimitReached(db, settings, localDayStart(now, getEnv().APP_TIMEZONE))) return { ok: false, code: 'FGO_DAILY_LIMIT' };
  const head = await db.billingBatch.findUnique({ where: { id: proformaBatchId }, select: { customerId: true } });
  if (!head) return { ok: false, code: 'NOT_FOUND' };
  try {
    return await db.$transaction(async (tx) => {
      // Kilit sırası: müşteri finans kilidi (elle ödeme kaydıyla sıralanır, karar 206) → müşteri parti kilidi
      await financeLock(tx, head.customerId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-batch:${head.customerId}`}, 0))`;
      const st = await chainState(tx, proformaBatchId);
      if (!st || st.batch.kind !== 'PROFORMA') return { ok: false, code: 'NOT_FOUND' };
      if (st.batch.status !== 'ISSUED' || !st.batch.document) return { ok: false, code: 'NOT_ALLOWED' };
      if (st.advancePending) return { ok: false, code: 'ADVANCE_PENDING' };
      if (!(st.advanceRequired > 0)) return { ok: false, code: 'NOTHING_TO_ADVANCE' };
      // Aynı müşteride aynı tutar (karar 208): yönetici gördüğü eşleşmeleri onaylamadan avans partisi açılmaz
      const risk = await advanceRisk(tx, { customerId: head.customerId, ron: st.advanceRequired, chainKey: `batch:${proformaBatchId}`, now });
      if (risk.matches.length && ack !== risk.ackKey) return { ok: false, code: 'DUPLICATE_RISK', matches: risk.matches, ackKey: risk.ackKey };
      const p = st.batch;
      const gross = st.advanceRequired;
      const net = netOf(gross, settings.vatRate);
      const orders = await tx.billingBatchOrder.findMany({ where: { batchId: p.id }, orderBy: { orderNo: 'asc' } });
      const uniqueKey = `ADVANCE:${p.id}:${Math.round(st.advanced * 100)}`;
      const batch = await tx.billingBatch.create({
        data: {
          customerId: p.customerId, kind: 'ADVANCE', status: 'PENDING', parentId: p.id, uniqueKey, currency: p.currency, loadingDays: p.loadingDays,
          selectionKey: uniqueKey, sourceTotal: '0.00', ronNet: net.toFixed(2), createdById: actor.id, createdAt: now, basis: st.basis,
          // Avans RON'dur; zincirin kur kaydı (proformanınki) partide de durur
          fxRate: p.fxRate, fxDate: p.fxDate, fxSource: p.fxSource, fxPolicy: p.fxPolicy, fxCurrency: p.fxCurrency, fxBaseRate: p.fxBaseRate,
          fxMarkupPercent: p.fxMarkupPercent, fxSourceDate: p.fxSourceDate, fxResolvedAt: p.fxResolvedAt, fxManual: p.fxManual,
          // Kaynak siparişler (izlenebilirlik); kapsam anahtarı proformada kalır
          orders: { create: orders.map((o) => ({ orderId: o.orderId, orderNo: o.orderNo, offerId: o.offerId, loadingDay: o.loadingDay, sourceAmount: '0.00', activeKey: null })) },
          lines: { create: [{ sortOrder: 0, name: `Avans marfă conform proformă ${st.ref}`, unit: 'buc', quantity: '1', ronUnit: net.toFixed(2), ronNet: net.toFixed(2), ronGross: gross.toFixed(2) }] },
        },
      });
      await tx.notificationOutbox.create({ data: { type: BATCH_FGO, payload: { batchId: batch.id } } });
      const statuses = new Map((await tx.order.findMany({ where: { id: { in: orders.map((o) => o.orderId) } }, select: { id: true, status: true } })).map((o) => [o.id, o.status]));
      for (const o of orders) await writeHistory(tx, { orderId: o.orderId, event: 'FGO_DOC_REQUESTED', from: statuses.get(o.orderId), to: statuses.get(o.orderId), actorId: actor.id, note: `ADVANCE · ${st.ref}` });
      await writeAudit(tx, {
        action: 'BILLING_BATCH_CREATED', entityType: 'BillingBatch', entityId: batch.id, userId: actor.id,
        details: { customerId: p.customerId, kind: 'ADVANCE', proforma: st.ref, proformaBatchId: p.id, basis: st.basis, paid: st.paid, manualRon: st.manualRon, advancedBefore: st.advanced, amountRon: gross, ...(risk.matches.length ? { duplicateAck: risk.matches.map((m) => m.key) } : {}) },
      }, actor);
      if (risk.matches.length) await recordDuplicateAck(tx, { orderId: null, customerId: p.customerId, subject: 'ADVANCE', matches: risk.matches, amountRon: gross, actor, key: `batch:${batch.id}` });
      return { ok: true, batchId: batch.id, amount: gross };
    }, { timeout: 30_000 });
  } catch (e) {
    if (isUnique(e)) return { ok: false, code: 'ADVANCE_PENDING' };
    throw e;
  }
}

/**
 * @typedef {{ name: string, pieces: number, m2: number, amount: number, net: number, gross: number }} InvoiceLine
 * @typedef {{ orderId: string, orderNo: string, title: string | null, offerId: string | null, lines: InvoiceLine[], sourceTotal: number, ronNet: number, ronGross: number }} InvoiceOrder
 * @typedef {{ advanceBatchId: string | null, advanceDocId?: string | null, ref: string | null, gross: number, net: number }} StornoLine
 * @typedef {{ batchId: string, status: string, ref: string | null, link: string | null, total: number | null, paid: number | null, lastError: string | null, orders: string[], impacts: OrderImpact[] }} IssuedInvoice
 * @typedef {{
 *   key: string, currency: string, chainId: string | null, orderChainId: string | null,
 *   chain: null | { kind: 'BATCH' | 'ORDER', orderId: string | null, ref: string | null, total: number | null, paid: number, advanced: number, advanceRequired: number, advancePending: boolean, proformaBatchId: string | null },
 *   orders: InvoiceOrder[], unselected: { orderId: string, orderNo: string, title: string | null }[], uniqueKey: string,
 *   fx: import('../fx/resolve.js').FxResult | null, fxError: { code: string, error: string } | null,
 *   sourceTotal: number, ronNet: number | null, ronGross: number | null, storno: StornoLine[], payable: number | null,
 *   problems: string[], previewKey: string,
 * }} InvoiceGroup
 * @typedef {{ orderId: string, orderNo: string, reason: 'ORDER_PENDING' | 'ORDER_INVOICED' | 'PROFORMA_NOT_ISSUED' | 'CURRENCY' | 'NO_LINES' | 'ACCOUNTING_ACTION', ref: string | null }} ExcludedOrder
 * @typedef {{ customerId: string, name: string, missingBilling: string[], groups: InvoiceGroup[], issued: IssuedInvoice[], excluded: ExcludedOrder[] }} CustomerBilling
 * @typedef {{ ok: true, day: string, confirmationId: string, revision: number, customers: CustomerBilling[] }} LoadingBilling
 */

/** Bir siparişin yüklenen kalemleri → fatura satırları (sipariş faturasıyla aynı kural: invoiceLines) */
function orderInvoiceLines(orderNo, items, rate, vatRate) {
  const offer = { lines: items.map(itemAsLine) };
  const src = glassLines(offer);
  const pieces = glassTotals(offer);
  return invoiceLines(offer, rate, vatRate).map((l, i) => ({
    name: `Comanda ${orderNo} — ${l.name}`.slice(0, 250), pieces: pieces[i]?.adet ?? 0, m2: l.qty, amount: src[i]?.eurTotal ?? 0, net: l.net, gross: l.gross,
  }));
}

/** Romence ad: kalemde yoksa katalogdaki camın Romence adı (sipariş faturasıyla aynı) */
async function withRoLabels(db, items) {
  const missingRo = items.filter((i) => !i.descriptionRo && i.glassProductId).map((i) => i.glassProductId);
  if (missingRo.length === 0) return items;
  const labels = new Map((await db.glassProduct.findMany({ where: { id: { in: missingRo } } })).map((x) => [x.id, glassLabel(x, 'ro')]));
  return items.map((it) => (!it.descriptionRo && labels.has(it.glassProductId) ? { ...it, descriptionRo: labels.get(it.glassProductId) } : it));
}

/** Yüklenen kalemlerin ticari kapsamı, fatura kuralıyla (glassLines): adet ve kaynak para birimi tutarı */
function commercialScope(items) {
  const offer = { lines: items.filter((i) => i.status === 'LOADED').map(itemAsLine) };
  return { pieces: glassTotals(offer).reduce((n, g) => n + g.adet, 0), amount: round2(glassLines(offer).reduce((n, g) => n + g.eurTotal, 0)) };
}

/**
 * Yükleme düzeltmesinin FİNANSAL ETKİSİ (karar 105) — yalnızca saptama; hiçbir belge kesilmez / değişmez.
 * Bir onayın verilen (geçerli ya da düzeltme sonrası olacak) kalemlerindeki yüklenen ticari kapsam, o onaydan kesilmiş
 * etkin fatura partisinin saklı kapsamıyla (BillingBatchLine) sipariş başına karşılaştırılır:
 *   NO_BILLING              : bu onaydan fatura yok (kapsam serbest; fatura geçerli durumdan kesilir)
 *   ORDER_CHAIN             : eski sipariş düzeyi kapanış faturası (siparişin tamamı, sipariş sayfasından — karar 239'dan önce)
 *   QUEUED_BILLING          : fatura kuyrukta (kesilmek üzere) — düzeltme yapılamaz
 *   FAILED_BILLING          : fatura kesilemedi — önce yönetici yeniden dener ya da vazgeçer
 *   NO_FINANCIAL_DIFFERENCE : fatura kesilmiş, yüklenen ticari kapsam aynı
 *   UNDER_INVOICED          : fatura kesilmiş, fiilen yüklenen faturadakinden FAZLA → muhasebe işlemi gerekli
 *   OVER_INVOICED           : fatura kesilmiş, fiilen yüklenen faturadakinden AZ → muhasebe işlemi gerekli
 * @typedef {'NO_BILLING' | 'ORDER_CHAIN' | 'QUEUED_BILLING' | 'FAILED_BILLING' | 'NO_FINANCIAL_DIFFERENCE' | 'UNDER_INVOICED' | 'OVER_INVOICED'} ImpactCode
 * @typedef {{ code: ImpactCode, orderId: string, orderNo: string, batchId: string | null, ref: string | null, currency: string | null,
 *   invoiced: { pieces: number, amount: number } | null, effective: { pieces: number, amount: number }, diff: number, invoicePaid: boolean, advanceDeducted: boolean }} OrderImpact
 * @param {any} db
 * @param {{ confirmationId: string, items: any[], orderIds?: string[] }} o  items: onayın kalemleri (geçerli hâl), orderIds: yalnızca bu siparişler
 * @returns {Promise<Map<string, OrderImpact>>}
 */
export async function orderImpacts(db, { confirmationId, items, orderIds = undefined }) {
  const ids = orderIds ?? [...new Set(items.map((i) => i.orderId))];
  if (ids.length === 0) return new Map();
  const [orders, covered, rows] = await Promise.all([
    db.order.findMany({ where: { id: { in: ids } }, select: { id: true, orderNo: true, fgoDocuments: { select: { kind: true, series: true, number: true }, orderBy: { issuedAt: 'asc' } } } }),
    db.billingBatchOrder.findMany({
      where: { activeKey: { in: ids.map((id) => invoiceOrderKey(confirmationId, id)) } },
      select: { orderId: true, batch: { select: { id: true, status: true, currency: true, document: true, lines: { select: { orderId: true, pieces: true, amount: true, refBatchId: true } } } } },
    }),
    withRoLabels(db, items.filter((i) => ids.includes(i.orderId))),
  ]);
  const out = new Map();
  for (const o of orders) {
    // Teklif sırasıyla: işlem satırları (CNC, delik) faturadaki gibi üstündeki cama eklenir
    const effective = commercialScope(rows.filter((i) => i.orderId === o.id).sort((x, y) => x.sortOrder - y.sortOrder));
    const base = { orderId: o.id, orderNo: o.orderNo, batchId: null, ref: null, currency: rows.find((i) => i.orderId === o.id)?.currency ?? null, invoiced: null, effective, diff: 0, invoicePaid: false, advanceDeducted: false };
    const b = covered.find((x) => x.orderId === o.id)?.batch ?? null;
    if (!b) {
      // Kendi proforma zinciri olan sipariş de onaydan faturalanır (karar 239); yalnızca eski sipariş düzeyi kapanış faturası
      // siparişin tamamını faturalamıştır
      const legacy = o.fgoDocuments.find((d) => d.kind === 'INVOICE');
      out.set(o.id, { ...base, code: legacy ? 'ORDER_CHAIN' : 'NO_BILLING', ref: legacy ? refOf(legacy) : null });
      continue;
    }
    const mine = b.lines.filter((l) => l.orderId === o.id);
    const invoiced = { pieces: mine.reduce((n, l) => n + (l.pieces ?? 0), 0), amount: round2(mine.reduce((n, l) => n + num(l.amount), 0)) };
    const diff = round2(effective.amount - invoiced.amount);
    const more = Math.abs(diff) > EPS ? diff > 0 : effective.pieces > invoiced.pieces;
    const same = Math.abs(diff) <= EPS && effective.pieces === invoiced.pieces;
    out.set(o.id, {
      ...base, batchId: b.id, ref: refOf(b.document), currency: b.currency, invoiced, diff,
      invoicePaid: num(b.document?.paid) > 0, advanceDeducted: b.lines.some((l) => l.refBatchId),
      code: b.status === 'PENDING' ? 'QUEUED_BILLING' : b.status === 'FAILED' ? 'FAILED_BILLING' : same ? 'NO_FINANCIAL_DIFFERENCE' : more ? 'UNDER_INVOICED' : 'OVER_INVOICED',
    });
  }
  return out;
}

/** "Muhasebe işlemi gerekli": kesilmiş fatura, düzeltilmiş fiili yüklemeyle uyuşmuyor (otomatik belge kesilmez) */
export const ACTION_REQUIRED = ['UNDER_INVOICED', 'OVER_INVOICED'];

/**
 * Faturası DONDURULAN aktarımlar (çift faturalama engeli, karar 105): kaynağı — ya da zincirde daha gerideki bir kaynak —
 * kesilmiş bir faturada yüklenmiş diye faturalanmış, sonra düzeltmeyle "yüklenmedi" olmuş kapsam olan aktarım. O cam
 * faturada zaten vardır; yüklendiği onayda yeniden faturalanırsa aynı mal iki kez faturalanır. Fatura FGO'da silinir /
 * parti geçersiz olursa dondurma kendiliğinden kalkar (kapsam yeniden geçerli durumdan faturalanır).
 * @param {any} db  @param {string[]} replanIds
 * @returns {Promise<Map<string, string>>}  aktarım → çelişen faturanın numarası
 */
export async function heldReplans(db, replanIds) {
  const out = new Map();
  const memo = new Map();
  const loaded = (rows) => rows.filter((x) => x.status === 'LOADED').reduce((n, x) => n + x.quantity, 0);
  const overInvoiced = async (src) => {
    const k = scopeOf(src);
    if (memo.has(k)) return memo.get(k);
    const bo = await db.billingBatchOrder.findUnique({
      where: { activeKey: invoiceOrderKey(src.confirmationId, src.orderId) },
      select: { loadingRevision: true, batch: { select: { status: true, document: { select: { series: true, number: true } } } } },
    });
    let ref = null;
    if (bo?.batch.status === 'ISSUED') {
      const rows = (await db.loadingConfirmationItem.findMany({
        where: { confirmationId: src.confirmationId, orderId: src.orderId },
        select: { confirmationId: true, offerLineId: true, replanId: true, revision: true, status: true, quantity: true },
      })).filter((x) => itemKey(x) === itemKey(src));
      // Faturanın kesildiği andaki yüklenen adet > bugünkü geçerli yüklenen adet: aradaki cam faturalanmıştır
      if (loaded(effectiveItems(rows)) < loaded(effectiveItems(rows, bo.loadingRevision))) ref = refOf(bo.batch.document) ?? '—';
    }
    memo.set(k, ref);
    return ref;
  };
  for (const id of new Set(replanIds)) {
    let cur = id;
    for (let depth = 0; cur && depth < 50; depth++) {
      const r = await db.loadingReplan.findUnique({ where: { id: cur }, select: { sourceItem: { select: { confirmationId: true, orderId: true, offerLineId: true, replanId: true } } } });
      if (!r) break;
      const ref = await overInvoiced(r.sourceItem);
      if (ref) { out.set(id, ref); break; }
      cur = r.sourceItem.replanId;
    }
  }
  return out;
}

/**
 * Bir siparişin bir onaydaki yüklenen kapsamının FATURA DURUMU — tek karar yeri. Faturalama görünümü (loadingBilling) ve
 * "fatura bekliyor" uyarısı (server/accounting/uninvoiced.js) aynı kuralı kullanır; ikinci bir uygunluk kuralı yazılmaz.
 *   IN_INVOICE : kapsam bu onaydan bir fatura partisinde (kuyrukta / kesilmiş / kesilemedi) — yeniden faturalanmaz
 *   EXCLUDED   : müşteri faturasına girmez (reason, ref):
 *     ORDER_PENDING       — siparişin kendi belge isteği kuyrukta (proforma / avans kesiliyor): kesilince yeniden bakılır
 *     ORDER_INVOICED      — eski sipariş düzeyi kapanış faturası siparişin tamamını faturalamış (karar 239'dan önce)
 *     ACCOUNTING_ACTION   — bu güne aktarılıp yüklenen cam kaynağındaki kesilmiş faturada zaten faturalanmış (karar 105)
 *     CURRENCY / NO_LINES — faturalanabilir kalem yok
 *     PROFORMA_NOT_ISSUED — müşteri proforması henüz kesilmedi (kuyrukta / kesilemedi)
 *   OPEN       : faturalanabilir (currency, chainId: müşteri proforması partisi ya da null, orderChainId: siparişin kendi
 *                proforma zinciri ya da null — karar 239, offerId)
 * @param {{ confirmationId: string, order: any, items: any[], pendingJob: boolean, held: Map<string, string> }} p
 *   items: siparişin bu onaydaki GEÇERLİ yüklenen kalemleri
 */
export function invoiceScope({ confirmationId, order, items, pendingJob, held }) {
  const no = (reason, ref = null) => ({ state: /** @type {const} */ ('EXCLUDED'), reason, ref });
  const inv = order.billingBatchOrders.find((b) => b.activeKey === invoiceOrderKey(confirmationId, order.id));
  if (inv) return { state: /** @type {const} */ ('IN_INVOICE'), batch: inv.batch };
  // Siparişin kendi belgeleri (karar 239): istek kuyruktaysa beklenir; eski kapanış faturası varsa sipariş faturalanmıştır;
  // kendi proforması varsa kapsam siparişin zincirinde faturalanır
  if (pendingJob) return no('ORDER_PENDING');
  const legacy = order.fgoDocuments.find((d) => d.kind === 'INVOICE');
  if (legacy) return no('ORDER_INVOICED', refOf(legacy));
  const ownProforma = order.fgoDocuments.some((d) => d.kind === 'PROFORMA');
  const hold = items.map((i) => (i.replanId ? held.get(i.replanId) : null)).find(Boolean);
  if (hold) return no('ACCOUNTING_ACTION', hold);
  const currency = items[0]?.currency ?? null;
  if (currency !== 'EUR' && currency !== 'RON') return no('CURRENCY');
  if (glassLines({ lines: items.map(itemAsLine) }).length === 0) return no('NO_LINES');
  const pro = order.billingBatchOrders.find((b) => b.batch.kind === 'PROFORMA');
  if (pro && pro.batch.status !== 'ISSUED') return no('PROFORMA_NOT_ISSUED');
  return { state: /** @type {const} */ ('OPEN'), currency, chainId: pro ? pro.batch.id : null, orderChainId: ownProforma ? order.id : null, offerId: pro?.offerId ?? null };
}

/** Parmak izi: önizlenen = kesilen (kalemler, kur, avans düşümü) */
function previewKeyOf(g) {
  const body = JSON.stringify({
    key: g.key, fx: g.fx ? [g.fx.finalRate, g.fx.source, g.fx.sourceDate, g.fx.manual] : null,
    orders: g.orders.map((o) => [o.orderId, o.lines.map((l) => [l.name, l.pieces, l.m2, l.amount, l.net, l.gross])]),
    storno: g.storno.map((s) => [s.advanceBatchId, s.advanceDocId ?? null, s.gross]),
  });
  return crypto.createHash('sha256').update(body).digest('hex');
}

/**
 * Onaylı yükleme gününün faturalama görünümü = kesilecek faturaların hesabı. Hiçbir şey yazmaz.
 *   groups  : henüz faturası olmayan kapsam (müşteri + para birimi + zincir başına bir grup) — onayın GEÇERLİ yüklenen
 *             kalemlerinden (effectiveItems; düzeltmeler uygulanmış)
 *   issued  : bu onaydan kesilmiş / kuyruktaki / kesilemeyen fatura partileri; impacts: kesilmiş faturası geçerli
 *             yüklemeyle uyuşmayan siparişler (muhasebe işlemi gerekli — otomatik belge kesilmez)
 *   excluded: müşteri faturasına girmeyen siparişler ve nedeni (ACCOUNTING_ACTION: cam başka bir faturada zaten var)
 *   revision: onayın son düzeltme sırası (fatura partisi hangi durumdan kesildiğini saklar)
 * manual: { key, rate } — yöneticinin o grup için elle girdiği kur (yalnızca zincirsiz EUR grubunda geçerli).
 * fx: { [groupKey]: FxResult } — parti oluşturulurken, işlem içinde kur yeniden çözülmesin diye.
 * select: { key, orderIds } — yöneticinin o grup için seçtiği siparişler (karar 125); grubun orders / tutarları / avans
 *   düşümü yalnızca seçilenlerden hesaplanır, seçilmeyenler `unselected`te döner. Grupta olmayan sipariş → NOT_ELIGIBLE.
 * @param {any} db
 * @param {{ day: string, now?: Date, bnrImpl?: typeof bnrRate, manual?: { key: string, rate: string | number } | null, fx?: Record<string, any>, vatRate?: number,
 *   select?: { key: string, orderIds: string[] } | null }} o
 * @returns {Promise<LoadingBilling | { ok: false, code: string }>}
 */
export async function loadingBilling(db, { day, now = new Date(), bnrImpl = bnrRate, manual = null, fx = {}, vatRate = undefined, select = null }) {
  if (!parseDateOnly(day)) return { ok: false, code: 'BAD_DAY' };
  const conf = await db.loadingConfirmation.findUnique({
    where: { shipDay: shipDayDate(day) },
    include: { items: { orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }] } },
  });
  if (!conf) return { ok: false, code: 'NOT_CONFIRMED' };
  vatRate ??= (await getFgoSettings(db)).vatRate;
  // Geçerli durum (karar 105): düzeltilmiş kapsamda son düzeltmenin kalemleri; yalnızca LOADED olanlar faturalanır
  const effective = effectiveItems(conf.items);
  const revision = conf.items.reduce((m, i) => Math.max(m, i.revision ?? 0), 0);
  const loadedItems = await withRoLabels(db, effective.filter((i) => i.status === 'LOADED'));
  const orderIds = [...new Set(loadedItems.map((i) => i.orderId))];
  const [orders, jobs, batches] = await Promise.all([
    db.order.findMany({
      where: { id: { in: orderIds } },
      select: {
        id: true, orderNo: true, title: true, customerId: true, customerOrderNo: true, customer: true,
        // Siparişin kendi zinciri (karar 239): belgeler (avans tutarları), proformanın kur kaydı, elle ödeme kayıtları
        fgoDocuments: { select: { id: true, kind: true, seq: true, series: true, number: true, total: true, paid: true, advanced: true }, orderBy: { issuedAt: 'asc' } },
        glassBilling: true,
        manualPayments: { where: { batchId: null }, select: { ron: true, voidedAt: true, proformaRef: true } },
        billingBatchOrders: { where: { activeKey: { not: null } }, select: { activeKey: true, offerId: true, batch: { select: { id: true, kind: true, status: true, document: { select: { series: true, number: true } } } } } },
      },
      orderBy: [{ customerId: 'asc' }, { customerOrderNo: 'asc' }],
    }),
    orderIds.length ? db.notificationOutbox.findMany({ where: { orderId: { in: orderIds }, type: GLASS_FGO, status: 'PENDING' }, select: { orderId: true } }) : [],
    db.billingBatch.findMany({
      where: { confirmationId: conf.id, kind: 'INVOICE', status: { not: 'VOID' } },
      orderBy: { createdAt: 'asc' },
      include: { document: true, customer: true, orders: { select: { orderId: true, orderNo: true }, orderBy: { orderNo: 'asc' } } },
    }),
  ]);
  const pending = new Set(jobs.map((j) => j.orderId));
  const itemsOf = new Map();
  for (const it of loadedItems) {
    if (!itemsOf.has(it.orderId)) itemsOf.set(it.orderId, []);
    itemsOf.get(it.orderId).push(it);
  }
  // Kesilmiş faturası geçerli yüklemeyle uyuşmayan siparişler ve faturası dondurulan aktarımlar (yalnızca saptama)
  const invoicedIds = [...new Set(batches.flatMap((b) => b.orders.map((x) => x.orderId)))];
  const [impacts, held] = await Promise.all([
    orderImpacts(db, { confirmationId: conf.id, items: effective, orderIds: invoicedIds }),
    heldReplans(db, loadedItems.map((i) => i.replanId).filter(Boolean)),
  ]);

  /** @type {Map<string, CustomerBilling & { open: Map<string, any>, customer: any }>} */
  const byCustomer = new Map();
  const entryOf = (customer) => {
    let c = byCustomer.get(customer.id);
    if (!c) {
      c = { customerId: customer.id, name: customer.name, customer, missingBilling: missingBilling(customer), groups: [], issued: [], excluded: [], open: new Map() };
      byCustomer.set(customer.id, c);
    }
    return c;
  };
  for (const o of orders) {
    const c = entryOf(o.customer);
    const items = itemsOf.get(o.id) ?? [];
    // Kapsamın fatura durumu tek yerden (invoiceScope): zaten faturada / müşteri faturasına girmez / faturalanabilir
    const sc = invoiceScope({ confirmationId: conf.id, order: o, items, pendingJob: pending.has(o.id), held });
    if (sc.state === 'IN_INVOICE') continue;
    if (sc.state === 'EXCLUDED') { c.excluded.push({ orderId: o.id, orderNo: o.orderNo, reason: sc.reason, ref: sc.ref }); continue; }
    const key = invoiceKeyOf({ confirmationId: conf.id, customerId: o.customerId, currency: sc.currency, chainId: sc.chainId, orderChainId: sc.orderChainId });
    const g = c.open.get(key) ?? { key, currency: sc.currency, chainId: sc.chainId, orderChainId: sc.orderChainId, raw: [] };
    g.raw.push({ order: o, items, offerId: sc.offerId });
    c.open.set(key, g);
  }

  const today = localDay(now, getEnv().APP_TIMEZONE);
  for (const c of byCustomer.values()) {
    for (const g of c.open.values()) {
      /** @type {string[]} */
      const problems = [];
      if (c.missingBilling.length) problems.push('BILLING_MISSING');
      const st = g.chainId ? await chainState(db, g.chainId) : null;
      // Siparişin kendi zinciri (karar 239): grupta tek sipariş; kur ve avans o siparişin zincirinden
      const ost = g.orderChainId ? await orderChainState(db, g.raw[0].order) : null;
      // Kur: zincirdeyse proformanın kur kaydı; zincirsizse müşterinin kur politikasından bir kez (RON'da çevrim yok)
      let rate = fx[g.key] ?? null;
      let fxError = null;
      if (!rate) {
        if (st) rate = fxOfBatch(st.batch);
        else if (g.currency === 'RON') rate = { policy: c.customer.fxPolicy, currency: 'RON', baseRate: '1.0000', markupPercent: null, finalRate: '1.0000', rate: 1, source: 'RON', sourceDate: today, resolvedAt: now.toISOString(), manual: false };
        else {
          try {
            if (ost) {
              // Proformanın kuru (kesilirken saklandı); yoksa uydurulmaz, başka kaynağa geçilmez
              rate = fxOfOrderChain(g.raw[0].order.glassBilling, g.currency);
            } else {
              rate = await resolveExchangeRate(db, { customer: c.customer, currency: g.currency, day: today, now, manualRate: manual?.key === g.key ? manual.rate : null, bnrImpl });
            }
          } catch (e) {
            fxError = { code: e instanceof FxUnavailable ? e.code : 'ERROR', error: String(e?.message ?? e).slice(0, 300) };
          }
        }
      }
      // Siparişin zincirinde proformanın kur kaydı yoksa fatura beklemez değil, kesilmez: kur uydurulmaz (karar 96)
      if (!rate) problems.push(ost ? 'CHAIN_RATE_MISSING' : 'FX_UNAVAILABLE');
      // Sipariş seçimi: yalnızca bu grubun uygun siparişleri daraltılır; grupta olmayan sipariş seçilemez
      const picked = select && select.key === g.key ? new Set((select.orderIds ?? []).map(String)) : null;
      const chosen = picked ? g.raw.filter((x) => picked.has(x.order.id)) : g.raw;
      const unselected = picked ? g.raw.filter((x) => !picked.has(x.order.id)).map((x) => ({ orderId: x.order.id, orderNo: x.order.orderNo, title: x.order.title ?? null })) : [];
      if (picked && [...picked].some((id) => !g.raw.some((x) => x.order.id === id))) problems.push('NOT_ELIGIBLE');
      if (picked && chosen.length === 0) problems.push('NOTHING_SELECTED');
      /** @type {InvoiceOrder[]} */
      const list = chosen.map(({ order, items, offerId }) => {
        const lines = rate ? orderInvoiceLines(order.orderNo, items, rate.rate, vatRate) : orderInvoiceLines(order.orderNo, items, 0, vatRate).map((l) => ({ ...l, net: 0, gross: 0 }));
        return {
          orderId: order.id, orderNo: order.orderNo, title: order.title ?? null, offerId: offerId ?? null, lines,
          sourceTotal: round2(lines.reduce((s, l) => s + l.amount, 0)), ronNet: round2(lines.reduce((s, l) => s + l.net, 0)), ronGross: round2(lines.reduce((s, l) => s + l.gross, 0)),
        };
      });
      const ronNet = rate ? round2(list.reduce((s, o) => s + o.ronNet, 0)) : null;
      const ronGross = rate ? round2(list.reduce((s, o) => s + o.ronGross, 0)) : null;
      // Avans zinciri: avansı kesilmemiş tahsilat varken fatura kesilmez; kesilmiş avans faturanın tutarını aşmadan düşülür
      /** @type {StornoLine[]} */
      const storno = [];
      if (st) {
        if (st.advancePending) problems.push('ADVANCE_PENDING');
        if (st.advanceRequired > 0) problems.push('ADVANCE_REQUIRED');
        let room = ronGross ?? 0;
        for (const a of st.advances) {
          const take = round2(Math.min(a.left, room));
          if (!(take > 0)) continue;
          storno.push({ advanceBatchId: a.batchId, advanceDocId: null, ref: a.ref, gross: take, net: netOf(take, vatRate) });
          room = round2(room - take);
        }
      }
      // Siparişin kendi zinciri: aynı kural — avansı kesilmemiş tahsilat varken fatura yok; avans faturaları sırayla, her biri
      // en çok kalanı ve faturanın kalan tutarı kadar düşülür (aynı avans iki kez düşülmez: kullanılan kısım partilerde saklı)
      if (ost) {
        // Zincirden fatura kesildikten sonra proformada görünen tahsilat: avans mı faturanın ödemesi mi — muhasebe kararı;
        // otomatik avans / mahsup yok, kalan kapsamın faturası bekler (yanlış belge kesilmez)
        if (ost.advanceRequired > 0) problems.push(ost.invoices > 0 ? 'PAYMENT_AFTER_INVOICE' : 'ADVANCE_REQUIRED');
        let room = ronGross ?? 0;
        for (const a of ost.advances) {
          const take = round2(Math.min(a.left, room));
          if (!(take > 0)) continue;
          storno.push({ advanceBatchId: null, advanceDocId: a.docId, ref: a.ref, gross: take, net: netOf(take, vatRate) });
          room = round2(room - take);
        }
      }
      /** @type {InvoiceGroup} */
      const group = {
        key: g.key, currency: g.currency, chainId: g.chainId, orderChainId: g.orderChainId ?? null,
        chain: st
          ? { kind: 'BATCH', orderId: null, ref: st.ref, total: st.total, paid: st.paid, advanced: st.advanced, advanceRequired: st.advanceRequired, advancePending: st.advancePending, proformaBatchId: st.batch.id }
          : ost
            ? { kind: 'ORDER', orderId: g.orderChainId, ref: ost.ref, total: ost.total, paid: ost.paid, advanced: ost.advanced, advanceRequired: ost.advanceRequired, advancePending: false, proformaBatchId: null }
            : null,
        orders: list, unselected,
        // Tekrar anahtarı: grubun tamamı faturalanıyorsa grubun anahtarı; yalnızca bir kısmı seçildiyse (ya da grubun anahtarı
        // bu onaydan kesilmiş etkin bir faturada duruyorsa) seçime özgü anahtar — kalan siparişler aynı onaydan ayrı faturaya
        // girebilsin. Aynı siparişin iki kez faturalanmasını BillingBatchOrder.activeKey engeller (veritabanında benzersiz).
        uniqueKey: unselected.length || batches.some((b) => b.uniqueKey === g.key)
          ? `${g.key}:${crypto.createHash('sha256').update(list.map((o) => o.orderId).sort().join(',')).digest('hex').slice(0, 16)}` : g.key,
        fx: rate, fxError, sourceTotal: round2(list.reduce((s, o) => s + o.sourceTotal, 0)), ronNet, ronGross, storno,
        payable: ronGross == null ? null : round2(ronGross - storno.reduce((s, x) => s + x.gross, 0)), problems, previewKey: '',
      };
      group.previewKey = previewKeyOf(group);
      c.groups.push(group);
    }
  }
  for (const b of batches) {
    // Düzeltmeyle hiç yüklenen kalemi kalmamış siparişin faturası da görünür (fark burada bildirilir)
    const c = entryOf(b.customer);
    c.issued.push({
      batchId: b.id, status: b.status, ref: refOf(b.document), link: b.document?.link ?? null, total: b.document?.total == null ? null : Number(b.document.total),
      paid: b.document?.paid == null ? null : Number(b.document.paid), lastError: b.lastError ?? null, orders: b.orders.map((o) => o.orderNo),
      impacts: b.orders.map((o) => impacts.get(o.orderId)).filter((x) => x && ACTION_REQUIRED.includes(x.code)),
    });
  }
  const customers = [...byCustomer.values()].map(({ open: _open, customer: _customer, ...c }) => c).sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, day, confirmationId: conf.id, revision, customers };
}

/**
 * Müşteri faturası partisini oluşturur ve FGO faturasını kuyruğa alır (yönetici).
 * @param {any} db
 * orderIds: yöneticinin grupta seçtiği siparişler (null = grubun uygun siparişlerinin hepsi); sunucuda yeniden doğrulanır.
 * @param {{ day: string, groupKey: string, previewKey: string, orderIds?: string[] | null, manualRate?: string | number | null, actor: any, now?: Date, bnrImpl?: typeof bnrRate }} o
 * @returns {Promise<{ ok: true, batchId: string, orders: number } | { ok: false, code: string }>}
 */
export async function createInvoiceBatch(db, { day, groupKey, previewKey, orderIds = null, manualRate = null, actor, now = new Date(), bnrImpl = bnrRate }) {
  if (!can(actor?.role, 'ACCOUNTING_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  const tz = getEnv().APP_TIMEZONE;
  if (await dailyLimitReached(db, settings, localDayStart(now, tz))) return { ok: false, code: 'FGO_DAILY_LIMIT' };
  const manual = manualRate == null || manualRate === '' ? null : { key: groupKey, rate: manualRate };
  const select = orderIds == null ? null : { key: groupKey, orderIds: (Array.isArray(orderIds) ? orderIds : [orderIds]).map(String) };
  const find = (r) => r.customers.flatMap((c) => c.groups.map((g) => ({ c, g }))).find((x) => x.g.key === groupKey) ?? null;
  // Kur işlemin dışında çözülür (BNR ağ isteği); işlem içinde aynı kurla yeniden hesaplanır
  const first = await loadingBilling(db, { day, now, bnrImpl, manual, select, vatRate: settings.vatRate });
  if (!first.ok) return first;
  const f = find(first);
  if (!f) return { ok: false, code: 'NOTHING_TO_INVOICE' };
  if (f.g.problems.length) return { ok: false, code: f.g.problems[0] };
  if (f.g.previewKey !== previewKey) return { ok: false, code: 'STALE_PREVIEW' };
  try {
    return await db.$transaction(async (tx) => {
      // Kilit sırası: müşteri finans kilidi (elle ödeme / avans istekleriyle sıralanır, karar 206) → müşteri parti kilidi →
      // sipariş belge kilitleri. Avans durumu (tahsilat, kuyruktaki istek) kilitler altında yeniden hesaplanır.
      await financeLock(tx, f.c.customerId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-batch:${f.c.customerId}`}, 0))`;
      for (const id of f.g.orders.map((o) => o.orderId).sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${id}`}, 0))`;
      }
      const again = await loadingBilling(tx, { day, now, fx: { [groupKey]: f.g.fx }, select, vatRate: settings.vatRate });
      if (!again.ok) return again;
      const x = find(again);
      if (!x) return { ok: false, code: 'NOTHING_TO_INVOICE' };
      const g = x.g;
      if (g.problems.length) return { ok: false, code: g.problems[0] };
      if (g.previewKey !== previewKey) return { ok: false, code: 'STALE_PREVIEW' };
      const docDay = dayDate(localDay(now, tz));
      const shipDay = shipDayDate(day);
      const stornoNet = round2(g.storno.reduce((s, y) => s + y.net, 0));
      const goods = g.orders.flatMap((o) => o.lines.map((l) => ({
        orderId: o.orderId, name: l.name, unit: 'mp', quantity: String(l.m2), pieces: l.pieces, amount: l.amount.toFixed(2), ronNet: l.net.toFixed(2), ronGross: l.gross.toFixed(2),
      })));
      // Avans düşümü: eksi satır (miktar −1, TVA hariç birim fiyat); hangi avanstan ne kadar düşüldüğü satırda saklanır
      // Siparişin kendi zincirinde düşüm satırı o siparişindir (FGO kaleminde "Comanda …" — sipariş faturasıyla aynı, karar 111)
      const storno = g.storno.map((y) => ({
        orderId: g.orderChainId ?? null, name: `Stornare avans conform factură ${y.ref}`, unit: 'buc', quantity: '-1', ronUnit: y.net.toFixed(2), ronNet: (-y.net).toFixed(2), ronGross: y.gross.toFixed(2),
        refBatchId: y.advanceBatchId ?? null, refDocId: y.advanceDocId ?? null,
      }));
      // Zincirdeki fatura proformanın kur kaydını taşır (tarihleriyle): müşteri proforması partisi ya da siparişin kendi
      // proforması (GlassBilling — karar 239); doğrudan faturada kur şimdi çözülmüştür. RON siparişin zincirinde kur 1.
      const parent = g.chainId ? await tx.billingBatch.findUnique({ where: { id: g.chainId } }) : null;
      const chainBilling = g.orderChainId && g.currency !== 'RON' ? await tx.glassBilling.findUnique({ where: { orderId: g.orderChainId } }) : null;
      if (g.orderChainId && g.currency !== 'RON' && !fxOfOrderChain(chainBilling, g.currency)) return { ok: false, code: 'FX_UNAVAILABLE' };
      const fxData = parent
        ? { fxRate: parent.fxRate, fxDate: parent.fxDate, fxSource: parent.fxSource, fxPolicy: parent.fxPolicy, fxCurrency: parent.fxCurrency, fxBaseRate: parent.fxBaseRate, fxMarkupPercent: parent.fxMarkupPercent, fxSourceDate: parent.fxSourceDate, fxResolvedAt: parent.fxResolvedAt, fxManual: parent.fxManual }
        : chainBilling ? fxDataOfOrderChain(chainBilling, g.currency) : fxSnapshot(g.fx, docDay);
      const batch = await tx.billingBatch.create({
        data: {
          customerId: x.c.customerId, kind: 'INVOICE', status: 'PENDING', parentId: g.chainId, chainOrderId: g.orderChainId ?? null, confirmationId: again.confirmationId, uniqueKey: g.uniqueKey, currency: g.currency,
          loadingDays: [shipDay], selectionKey: g.previewKey, sourceTotal: g.sourceTotal.toFixed(2), ronNet: round2(g.ronNet - stornoNet).toFixed(2), createdById: actor.id, createdAt: now,
          ...fxData,
          orders: { create: g.orders.map((o) => ({ orderId: o.orderId, orderNo: o.orderNo, offerId: o.offerId, loadingDay: shipDay, sourceAmount: o.sourceTotal.toFixed(2), activeKey: invoiceOrderKey(again.confirmationId, o.orderId), loadingRevision: again.revision })) },
          lines: { create: [...goods, ...storno].map((l, i) => ({ ...l, sortOrder: i })) },
        },
      });
      await tx.notificationOutbox.create({ data: { type: BATCH_FGO, payload: { batchId: batch.id } } });
      const statuses = new Map((await tx.order.findMany({ where: { id: { in: g.orders.map((o) => o.orderId) } }, select: { id: true, status: true } })).map((o) => [o.id, o.status]));
      for (const o of g.orders) {
        await writeHistory(tx, { orderId: o.orderId, event: 'FGO_DOC_REQUESTED', from: statuses.get(o.orderId), to: statuses.get(o.orderId), actorId: actor.id, note: `INVOICE · ${ddmmyyyy(day)}` });
      }
      await writeAudit(tx, {
        action: 'BILLING_BATCH_CREATED', entityType: 'BillingBatch', entityId: batch.id, userId: actor.id,
        details: {
          customerId: x.c.customerId, kind: 'INVOICE', confirmationId: again.confirmationId, loadingRevision: again.revision, day, orders: g.orders.map((o) => o.orderNo), currency: g.currency, sourceTotal: g.sourceTotal,
          ronNet: g.ronNet, ronGross: g.ronGross, storno: g.storno.map((y) => ({ advance: y.ref, gross: y.gross })), proformaBatchId: g.chainId,
          ...(g.orderChainId ? { orderChain: g.orderChainId, proforma: g.chain?.ref ?? null, paid: g.chain?.paid ?? 0 } : {}),
          ...(g.unselected.length ? { notSelected: g.unselected.map((o) => o.orderNo) } : {}),
          fxRate: g.fx.finalRate, fxSource: g.fx.source, fxSourceDate: g.fx.sourceDate, fxManual: g.fx.manual,
        },
      }, actor);
      return { ok: true, batchId: batch.id, orders: g.orders.length };
    }, { timeout: 30_000 });
  } catch (e) {
    // Aynı kapsam için ikinci istek: veritabanı engeller (uniqueKey / activeKey)
    if (isUnique(e)) return { ok: false, code: 'ALREADY_INVOICED' };
    throw e;
  }
}
