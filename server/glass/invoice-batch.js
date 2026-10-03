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
//   Parti (BillingBatch, kind INVOICE / ADVANCE) değişmez kopyadır; belgeyi işçi yalnızca kayıttan keser
//   (server/glass/batch.js → dispatchBatchJobs). Tekrar engeli: müşteri + sipariş kilitleri, önizleme parmak izi,
//   BillingBatch.uniqueKey ve BillingBatchOrder.activeKey (veritabanında benzersiz), FGO IdExtern.
import crypto from 'node:crypto';
import { can } from '../auth/permissions.js';
import { getEnv } from '../env.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { parseDateOnly } from '../orders/rules.js';
import { itemAsLine, shipDayDate } from '../loading/confirmation.js';
import { glassLabel } from '../catalog/glass.js';
import { bnrRate } from '../fx/bnr.js';
import { FxUnavailable, fxSnapshot, resolveExchangeRate } from '../fx/resolve.js';
import { dailyLimitReached, fgoReady, getFgoSettings, missingBilling } from '../integrations/fgo.js';
import { dayDate, localDay, localDayStart } from '../profile/dates.js';
import { GLASS_FGO, glassLines, glassTotals, invoiceLines, netOf } from './billing.js';
import { BATCH_FGO, coverageOf } from './batch.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => (v == null ? 0 : Number(v));
const ddmmyyyy = (day) => day.split('-').reverse().join('.');
const isUnique = (e) => e?.code === 'P2002';
const EPS = 0.005;

/** Fatura grubunun kimliği = partinin tekrar anahtarı */
export const invoiceKeyOf = ({ confirmationId, customerId, currency, chainId }) => `INVOICE:${confirmationId}:${customerId}:${currency}:${chainId ?? 'DIRECT'}`;
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
 * Müşteri proformasının (PROFORMA partisi) avans durumu — tek yerde hesaplanır.
 *   paid            : FGO'nun proformada gösterdiği tahsilat (TVA dahil)
 *   advanced        : etkin avans partilerinin toplamı (kuyruktaki / kesilemeyen dahil)
 *   advanceRequired : avansı henüz kesilmemiş tahsilat (> 0 ise fatura kesilmez)
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
  const paid = num(p.document?.paid);
  const advanced = round2(advances.reduce((s, a) => s + a.planned, 0));
  const advanceRequired = paid - advanced > EPS ? round2(paid - advanced) : 0;
  return {
    batch: p, ref: refOf(p.document), total: p.document?.total == null ? null : Number(p.document.total), paid, advanced, advanceRequired,
    advancePending: advances.some((a) => a.status !== 'ISSUED'), advances, invoices: invoices.length,
  };
}

/**
 * Avans faturası partisi: proformaya gelen ve avansı kesilmemiş tahsilat kadar (uydurma tutar yok). Yükleme öncesi de
 * sonrası da kesilebilir. Tek satır: "Avans marfă conform proformă …" (sipariş başına avans faturasıyla aynı).
 * @param {any} db
 * @param {{ proformaBatchId: string, actor: any, now?: Date }} o
 * @returns {Promise<{ ok: true, batchId: string, amount: number } | { ok: false, code: string }>}
 */
export async function createAdvanceBatch(db, { proformaBatchId, actor, now = new Date() }) {
  if (!can(actor?.role, 'ACCOUNTING_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  if (await dailyLimitReached(db, settings, localDayStart(now, getEnv().APP_TIMEZONE))) return { ok: false, code: 'FGO_DAILY_LIMIT' };
  const head = await db.billingBatch.findUnique({ where: { id: proformaBatchId }, select: { customerId: true } });
  if (!head) return { ok: false, code: 'NOT_FOUND' };
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-batch:${head.customerId}`}, 0))`;
      const st = await chainState(tx, proformaBatchId);
      if (!st || st.batch.kind !== 'PROFORMA') return { ok: false, code: 'NOT_FOUND' };
      if (st.batch.status !== 'ISSUED' || !st.batch.document) return { ok: false, code: 'NOT_ALLOWED' };
      if (st.advancePending) return { ok: false, code: 'ADVANCE_PENDING' };
      if (!(st.advanceRequired > 0)) return { ok: false, code: 'NOTHING_TO_ADVANCE' };
      const p = st.batch;
      const gross = st.advanceRequired;
      const net = netOf(gross, settings.vatRate);
      const orders = await tx.billingBatchOrder.findMany({ where: { batchId: p.id }, orderBy: { orderNo: 'asc' } });
      const uniqueKey = `ADVANCE:${p.id}:${Math.round(st.advanced * 100)}`;
      const batch = await tx.billingBatch.create({
        data: {
          customerId: p.customerId, kind: 'ADVANCE', status: 'PENDING', parentId: p.id, uniqueKey, currency: p.currency, loadingDays: p.loadingDays,
          selectionKey: uniqueKey, sourceTotal: '0.00', ronNet: net.toFixed(2), createdById: actor.id, createdAt: now,
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
      await writeAudit(tx, { action: 'BILLING_BATCH_CREATED', entityType: 'BillingBatch', entityId: batch.id, userId: actor.id, details: { customerId: p.customerId, kind: 'ADVANCE', proforma: st.ref, proformaBatchId: p.id, paid: st.paid, advancedBefore: st.advanced, amountRon: gross } }, actor);
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
 * @typedef {{ advanceBatchId: string, ref: string | null, gross: number, net: number }} StornoLine
 * @typedef {{ batchId: string, status: string, ref: string | null, link: string | null, total: number | null, paid: number | null, lastError: string | null, orders: string[] }} IssuedInvoice
 * @typedef {{
 *   key: string, currency: string, chainId: string | null,
 *   chain: null | { ref: string | null, total: number | null, paid: number, advanced: number, advanceRequired: number, advancePending: boolean, proformaBatchId: string },
 *   orders: InvoiceOrder[], fx: import('../fx/resolve.js').FxResult | null, fxError: { code: string, error: string } | null,
 *   sourceTotal: number, ronNet: number | null, ronGross: number | null, storno: StornoLine[], payable: number | null,
 *   problems: string[], previewKey: string,
 * }} InvoiceGroup
 * @typedef {{ orderId: string, orderNo: string, reason: 'ORDER_CHAIN' | 'PROFORMA_NOT_ISSUED' | 'CURRENCY' | 'NO_LINES', ref: string | null }} ExcludedOrder
 * @typedef {{ customerId: string, name: string, missingBilling: string[], groups: InvoiceGroup[], issued: IssuedInvoice[], excluded: ExcludedOrder[] }} CustomerBilling
 * @typedef {{ ok: true, day: string, confirmationId: string, customers: CustomerBilling[] }} LoadingBilling
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

/** Parmak izi: önizlenen = kesilen (kalemler, kur, avans düşümü) */
function previewKeyOf(g) {
  const body = JSON.stringify({
    key: g.key, fx: g.fx ? [g.fx.finalRate, g.fx.source, g.fx.sourceDate, g.fx.manual] : null,
    orders: g.orders.map((o) => [o.orderId, o.lines.map((l) => [l.name, l.pieces, l.m2, l.amount, l.net, l.gross])]),
    storno: g.storno.map((s) => [s.advanceBatchId, s.gross]),
  });
  return crypto.createHash('sha256').update(body).digest('hex');
}

/**
 * Onaylı yükleme gününün faturalama görünümü = kesilecek faturaların hesabı. Hiçbir şey yazmaz.
 *   groups  : henüz faturası olmayan kapsam (müşteri + para birimi + zincir başına bir grup)
 *   issued  : bu onaydan kesilmiş / kuyruktaki / kesilemeyen fatura partileri
 *   excluded: müşteri faturasına girmeyen siparişler ve nedeni
 * manual: { key, rate } — yöneticinin o grup için elle girdiği kur (yalnızca zincirsiz EUR grubunda geçerli).
 * fx: { [groupKey]: FxResult } — parti oluşturulurken, işlem içinde kur yeniden çözülmesin diye.
 * @param {any} db
 * @param {{ day: string, now?: Date, bnrImpl?: typeof bnrRate, manual?: { key: string, rate: string | number } | null, fx?: Record<string, any>, vatRate?: number }} o
 * @returns {Promise<LoadingBilling | { ok: false, code: string }>}
 */
export async function loadingBilling(db, { day, now = new Date(), bnrImpl = bnrRate, manual = null, fx = {}, vatRate = undefined }) {
  if (!parseDateOnly(day)) return { ok: false, code: 'BAD_DAY' };
  const conf = await db.loadingConfirmation.findUnique({
    where: { shipDay: shipDayDate(day) },
    include: { items: { where: { status: 'LOADED' }, orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }] } },
  });
  if (!conf) return { ok: false, code: 'NOT_CONFIRMED' };
  vatRate ??= (await getFgoSettings(db)).vatRate;
  const orderIds = [...new Set(conf.items.map((i) => i.orderId))];
  const [orders, jobs, batches] = await Promise.all([
    db.order.findMany({
      where: { id: { in: orderIds } },
      select: {
        id: true, orderNo: true, title: true, customerId: true, customerOrderNo: true, customer: true,
        fgoDocuments: { select: { kind: true, series: true, number: true }, orderBy: { issuedAt: 'asc' } },
        billingBatchOrders: { where: { activeKey: { not: null } }, select: { activeKey: true, offerId: true, batch: { select: { id: true, kind: true, status: true, document: { select: { series: true, number: true } } } } } },
      },
      orderBy: [{ customerId: 'asc' }, { customerOrderNo: 'asc' }],
    }),
    orderIds.length ? db.notificationOutbox.findMany({ where: { orderId: { in: orderIds }, type: GLASS_FGO, status: 'PENDING' }, select: { orderId: true } }) : [],
    db.billingBatch.findMany({
      where: { confirmationId: conf.id, kind: 'INVOICE', status: { not: 'VOID' } },
      orderBy: { createdAt: 'asc' },
      include: { document: true, orders: { select: { orderNo: true }, orderBy: { orderNo: 'asc' } } },
    }),
  ]);
  const pending = new Set(jobs.map((j) => j.orderId));
  // Romence ad: kalemde yoksa katalogdaki camın Romence adı (sipariş faturasıyla aynı)
  const missingRo = conf.items.filter((i) => !i.descriptionRo && i.glassProductId).map((i) => i.glassProductId);
  const labels = missingRo.length ? new Map((await db.glassProduct.findMany({ where: { id: { in: missingRo } } })).map((x) => [x.id, glassLabel(x, 'ro')])) : new Map();
  const itemsOf = new Map();
  for (const it of conf.items) {
    const row = !it.descriptionRo && labels.has(it.glassProductId) ? { ...it, descriptionRo: labels.get(it.glassProductId) } : it;
    if (!itemsOf.has(it.orderId)) itemsOf.set(it.orderId, []);
    itemsOf.get(it.orderId).push(row);
  }

  /** @type {Map<string, CustomerBilling & { open: Map<string, any>, customer: any }>} */
  const byCustomer = new Map();
  for (const o of orders) {
    let c = byCustomer.get(o.customerId);
    if (!c) {
      c = { customerId: o.customerId, name: o.customer.name, customer: o.customer, missingBilling: missingBilling(o.customer), groups: [], issued: [], excluded: [], open: new Map() };
      byCustomer.set(o.customerId, c);
    }
    const items = itemsOf.get(o.id) ?? [];
    // Bu onaydaki kapsamı zaten bir fatura partisinde: yeniden faturalanmaz
    if (o.billingBatchOrders.some((b) => b.activeKey === invoiceOrderKey(conf.id, o.id))) continue;
    const no = (reason, ref = null) => c.excluded.push({ orderId: o.id, orderNo: o.orderNo, reason, ref });
    // Sipariş başına belge zinciri: fatura sipariş sayfasından kesilir. Karar, çift faturalama denetiminin tek yeri olan
    // coverageOf'tan gelir (karar 100): yalnızca ŞU AN geçerli bir kapsam — siparişin duran FGO belgesi ya da kuyruktaki
    // isteği. Geçmişte belgesi olmuş olması engel değildir: FGO'da silinen belge (kaydı kalkar) ve kesilemeyip bırakılan
    // istek kapsamı serbest bırakır, sipariş müşteri faturasına girer. (Müşteri partisi kapsamı aşağıda zincir olarak ele alınır.)
    const own = coverageOf({ fgoDocuments: o.fgoDocuments }, pending.has(o.id));
    if (own) { no('ORDER_CHAIN', own.ref); continue; }
    const currency = items[0]?.currency ?? null;
    if (currency !== 'EUR' && currency !== 'RON') { no('CURRENCY'); continue; }
    if (glassLines({ lines: items.map(itemAsLine) }).length === 0) { no('NO_LINES'); continue; }
    const pro = o.billingBatchOrders.find((b) => b.batch.kind === 'PROFORMA');
    if (pro && pro.batch.status !== 'ISSUED') { no('PROFORMA_NOT_ISSUED'); continue; }
    const chainId = pro ? pro.batch.id : null;
    const key = invoiceKeyOf({ confirmationId: conf.id, customerId: o.customerId, currency, chainId });
    const g = c.open.get(key) ?? { key, currency, chainId, raw: [] };
    g.raw.push({ order: o, items, offerId: pro?.offerId ?? null });
    c.open.set(key, g);
  }

  const today = localDay(now, getEnv().APP_TIMEZONE);
  for (const c of byCustomer.values()) {
    for (const g of c.open.values()) {
      /** @type {string[]} */
      const problems = [];
      if (c.missingBilling.length) problems.push('BILLING_MISSING');
      const st = g.chainId ? await chainState(db, g.chainId) : null;
      // Kur: zincirdeyse proformanın kur kaydı; zincirsizse müşterinin kur politikasından bir kez (RON'da çevrim yok)
      let rate = fx[g.key] ?? null;
      let fxError = null;
      if (!rate) {
        if (st) rate = fxOfBatch(st.batch);
        else if (g.currency === 'RON') rate = { policy: c.customer.fxPolicy, currency: 'RON', baseRate: '1.0000', markupPercent: null, finalRate: '1.0000', rate: 1, source: 'RON', sourceDate: today, resolvedAt: now.toISOString(), manual: false };
        else {
          try {
            rate = await resolveExchangeRate(db, { customer: c.customer, currency: g.currency, day: today, now, manualRate: manual?.key === g.key ? manual.rate : null, bnrImpl });
          } catch (e) {
            fxError = { code: e instanceof FxUnavailable ? e.code : 'ERROR', error: String(e?.message ?? e).slice(0, 300) };
          }
        }
      }
      if (!rate) problems.push('FX_UNAVAILABLE');
      /** @type {InvoiceOrder[]} */
      const list = g.raw.map(({ order, items, offerId }) => {
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
          storno.push({ advanceBatchId: a.batchId, ref: a.ref, gross: take, net: netOf(take, vatRate) });
          room = round2(room - take);
        }
      }
      /** @type {InvoiceGroup} */
      const group = {
        key: g.key, currency: g.currency, chainId: g.chainId,
        chain: st ? { ref: st.ref, total: st.total, paid: st.paid, advanced: st.advanced, advanceRequired: st.advanceRequired, advancePending: st.advancePending, proformaBatchId: st.batch.id } : null,
        orders: list, fx: rate, fxError, sourceTotal: round2(list.reduce((s, o) => s + o.sourceTotal, 0)), ronNet, ronGross, storno,
        payable: ronGross == null ? null : round2(ronGross - storno.reduce((s, x) => s + x.gross, 0)), problems, previewKey: '',
      };
      group.previewKey = previewKeyOf(group);
      c.groups.push(group);
    }
  }
  for (const b of batches) {
    const c = byCustomer.get(b.customerId);
    if (!c) continue;
    c.issued.push({
      batchId: b.id, status: b.status, ref: refOf(b.document), link: b.document?.link ?? null, total: b.document?.total == null ? null : Number(b.document.total),
      paid: b.document?.paid == null ? null : Number(b.document.paid), lastError: b.lastError ?? null, orders: b.orders.map((o) => o.orderNo),
    });
  }
  const customers = [...byCustomer.values()].map(({ open: _open, customer: _customer, ...c }) => c).sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, day, confirmationId: conf.id, customers };
}

/**
 * Müşteri faturası partisini oluşturur ve FGO faturasını kuyruğa alır (yönetici).
 * @param {any} db
 * @param {{ day: string, groupKey: string, previewKey: string, manualRate?: string | number | null, actor: any, now?: Date, bnrImpl?: typeof bnrRate }} o
 * @returns {Promise<{ ok: true, batchId: string, orders: number } | { ok: false, code: string }>}
 */
export async function createInvoiceBatch(db, { day, groupKey, previewKey, manualRate = null, actor, now = new Date(), bnrImpl = bnrRate }) {
  if (!can(actor?.role, 'ACCOUNTING_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  const tz = getEnv().APP_TIMEZONE;
  if (await dailyLimitReached(db, settings, localDayStart(now, tz))) return { ok: false, code: 'FGO_DAILY_LIMIT' };
  const manual = manualRate == null || manualRate === '' ? null : { key: groupKey, rate: manualRate };
  const find = (r) => r.customers.flatMap((c) => c.groups.map((g) => ({ c, g }))).find((x) => x.g.key === groupKey) ?? null;
  // Kur işlemin dışında çözülür (BNR ağ isteği); işlem içinde aynı kurla yeniden hesaplanır
  const first = await loadingBilling(db, { day, now, bnrImpl, manual, vatRate: settings.vatRate });
  if (!first.ok) return first;
  const f = find(first);
  if (!f) return { ok: false, code: 'NOTHING_TO_INVOICE' };
  if (f.g.problems.length) return { ok: false, code: f.g.problems[0] };
  if (f.g.previewKey !== previewKey) return { ok: false, code: 'STALE_PREVIEW' };
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-batch:${f.c.customerId}`}, 0))`;
      for (const id of f.g.orders.map((o) => o.orderId).sort()) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${id}`}, 0))`;
      }
      const again = await loadingBilling(tx, { day, now, fx: { [groupKey]: f.g.fx }, vatRate: settings.vatRate });
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
      const storno = g.storno.map((y) => ({
        orderId: null, name: `Stornare avans conform factură ${y.ref}`, unit: 'buc', quantity: '-1', ronUnit: y.net.toFixed(2), ronNet: (-y.net).toFixed(2), ronGross: y.gross.toFixed(2), refBatchId: y.advanceBatchId,
      }));
      // Zincirdeki fatura proformanın kur kaydını taşır (tarihleriyle); doğrudan faturada kur şimdi çözülmüştür
      const parent = g.chainId ? await tx.billingBatch.findUnique({ where: { id: g.chainId } }) : null;
      const fxData = parent
        ? { fxRate: parent.fxRate, fxDate: parent.fxDate, fxSource: parent.fxSource, fxPolicy: parent.fxPolicy, fxCurrency: parent.fxCurrency, fxBaseRate: parent.fxBaseRate, fxMarkupPercent: parent.fxMarkupPercent, fxSourceDate: parent.fxSourceDate, fxResolvedAt: parent.fxResolvedAt, fxManual: parent.fxManual }
        : fxSnapshot(g.fx, docDay);
      const batch = await tx.billingBatch.create({
        data: {
          customerId: x.c.customerId, kind: 'INVOICE', status: 'PENDING', parentId: g.chainId, confirmationId: again.confirmationId, uniqueKey: g.key, currency: g.currency,
          loadingDays: [shipDay], selectionKey: g.previewKey, sourceTotal: g.sourceTotal.toFixed(2), ronNet: round2(g.ronNet - stornoNet).toFixed(2), createdById: actor.id, createdAt: now,
          ...fxData,
          orders: { create: g.orders.map((o) => ({ orderId: o.orderId, orderNo: o.orderNo, offerId: o.offerId, loadingDay: shipDay, sourceAmount: o.sourceTotal.toFixed(2), activeKey: invoiceOrderKey(again.confirmationId, o.orderId) })) },
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
          customerId: x.c.customerId, kind: 'INVOICE', confirmationId: again.confirmationId, day, orders: g.orders.map((o) => o.orderNo), currency: g.currency, sourceTotal: g.sourceTotal,
          ronNet: g.ronNet, ronGross: g.ronGross, storno: g.storno.map((y) => ({ advance: y.ref, gross: y.gross })), proformaBatchId: g.chainId,
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
