// Yükleme onayı (karar 92): camın FİİLEN yüklendiğinin kalıcı kaydı. Planlanan yükleme günü kanıt değildir.
//
//   - Yükleme günü başına tek onay (LoadingConfirmation.shipDay benzersiz + işlem kilidi).
//   - Onay, o günün uygun siparişlerinin müşteriye GÖNDERİLMİŞ teklif satırlarını kopyalar (LoadingConfirmationItem):
//     müşteri, sipariş, kaynak satır, cam, fiilen onaylanan adet / m², birim maliyet (OfferLine.unitPrice), müşteri
//     birim fiyatı (OfferLine.offerPrice), tutarlar, para birimi, durum. Kopya sonradan değişmez: fiyat tablosu,
//     teklif, müşteri fiyatı ya da katalog değişse de onaylı yükleme aynı kalır.
//   - Kopya teklif satırı biçimindedir; kârlılık (ve Aşama 7D'de fatura) aynı hesap kuralıyla (glassTotals) kopyadan
//     türetilir — ayrı bir fiyat formülü yoktur.
//   - "Eksiksiz Yüklendi": önizlemedeki bütün kalemler tam adetle LOADED kaydedilir. Yüklenmeyen cam varsa (kırık,
//     eksik, hazır değil — Aşama 7E, karar 102) yönetici cam satırı başına yüklenmeyen adedi ve nedenini girer: satır
//     LOADED (yüklenen adet) + NOT_LOADED (kalan adet, neden) olarak iki kayda bölünür. Yüklenmeyen kalan sonradan ileri
//     bir güne aktarılır (server/loading/replan.js → LoadingReplan); o gün onaylanırken kalan, kaynağının ticari
//     kopyasıyla ve replanId ile yeni kalem(ler) olur. Zincir böylece her denemede izlenir; eski onay hiç değişmez.
//   - Yalnızca yönetici (LOADING_CONFIRM); kontrol burada, sunucuda yapılır.
//   - Onaylı yükleme düzenlenmez / silinmez; sipariş tarihi ya da teklif sonradan değişse de yeniden üretilmez.
//   - Düzeltme (Aşama 7F-1, karar 105 — server/loading/correction.js): yanlış onaylanan yüklenen / yüklenmeyen dağılımı
//     kayıt EKLENEREK düzeltilir. Kalemin "kapsamı" = onay + sipariş + teklif satırı (ya da aktarım); düzeltilen kapsamın
//     yeni kalemleri revision = n ile eklenir, eskileri durur. GEÇERLİ durum her kapsamın en yüksek sıradaki kalemleridir:
//     tek yerde hesaplanır → effectiveItems(). Onayı okuyan her hesap (kart, yüklenmeyenler, aktarım kapasitesi,
//     kârlılık, fatura) bu işlevi kullanır; ayrı bir "düzeltilmiş" hesap yoktur.
import crypto from 'node:crypto';
import { can } from '../auth/permissions.js';
import { offerLineTotals, parseDateOnly } from '../orders/rules.js';
import { dayKey } from '../orders/loading.js';
import { writeAudit, writeHistory } from '../orders/journal.js';
import { glassTotals } from '../glass/billing.js';

/**
 * @typedef {{ orderId: string, orderNo: string, title: string | null, customerId: string, customerName: string, currency: string, offerId?: string, items: any[], replanFrom?: string[] }} ConfirmOrder
 * @typedef {{ orderId: string, orderNo: string, customerId: string, customerName: string, reason: 'NO_SENT_OFFER' | 'ALREADY_CONFIRMED' | 'ORDER_CANCELLED' | 'ORDER_ON_HOLD', day?: string }} SkippedOrder
 * @typedef {{ key: string, quantity: unknown, reason: unknown, note?: unknown }} NotLoadedInput
 * @typedef {Record<string, { sale: number, cost: number }>} MoneyByCur
 * @typedef {{ name: string, adet: number, m2: number, sale: number, cost: number }} GlassRow
 * @typedef {{ orderId: string, orderNo: string, title: string | null, currency: string, glass: GlassRow[], adet: number, m2: number, sale: number, cost: number, noCost: number, replanFrom: string[] }} OrderSummary
 * @typedef {{ customerId: string, name: string, orders: OrderSummary[], adet: number, m2: number, byCur: MoneyByCur }} CustomerSummary
 * @typedef {{ customers: CustomerSummary[], totals: { orders: number, adet: number, m2: number, items: number, byCur: MoneyByCur, noCost: number } }} LoadingSummary
 * @typedef {{ loaded: number, notLoaded: number, reason: string | null }} ScopeSplit
 * @typedef {{ key: string, orderId: string, orderNo: string, customerName: string, description: string, descriptionRo: string | null, enMm: number | null, boyMm: number | null, before: ScopeSplit, after: ScopeSplit }} CorrectionChange
 * @typedef {{ revision: number, reason: string, by: string, at: Date, changes: CorrectionChange[] }} CorrectionView
 */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const int = (v) => Math.max(0, Math.trunc(Number(v) || 0));

export const isGlassLine = (l) => (l.kind ?? 'CAM') === 'CAM' && (l.unit ?? 'm2') === 'm2';
const sentOffer = (o) => o.offers.find((x) => x.status === 'GONDERILDI') ?? null;

/** "YYYY-MM-DD" → @db.Date değeri (UTC gece yarısı) */
export const shipDayDate = (day) => new Date(`${day}T00:00:00.000Z`);

/**
 * Teklif satırının onay kopyası. quantity: FİİLEN onaylanan adet (verilmezse satırın tamamı).
 * Tutarlar yuvarlanmadan (4 hane) saklanır; toplamlar mevcut kuralla grup düzeyinde yuvarlanır.
 *   maliyet = miktar × OfferLine.unitPrice (müşteriye bedelsiz satırda da sayılır — karar 89)
 *   satış   = miktar × OfferLine.offerPrice (bedelsiz satırda 0)
 * Eski tekliflerde (müşteri fiyatı sütunu yok) müşteriye giden fiyat satırdaki tek fiyattır.
 */
export function snapshotLine(order, offer, l, { quantity = l.adet, status = 'LOADED', reason = null, note = null } = {}) {
  const qty = int(quantity);
  const glass = isGlassLine(l);
  const m2 = glass ? offerLineTotals({ ...l, adet: qty, unit: 'm2', unitPrice: 0 }).metraj : 0;
  const base = glass ? m2 : qty;
  const legacy = offer.offerAmount == null;
  const unitCost = Number(l.unitPrice ?? 0);
  const unitSale = legacy ? unitCost : l.offerPrice == null ? null : Number(l.offerPrice);
  return {
    orderId: order.id, customerId: order.customerId, offerLineId: l.id ?? null, sortOrder: l.sortOrder ?? 0,
    kind: l.kind ?? 'CAM', unit: l.unit ?? 'm2', description: l.description ?? '', descriptionRo: l.descriptionRo ?? null,
    glassProductId: l.glassProductId ?? null, enMm: l.enMm ?? null, boyMm: l.boyMm ?? null,
    weightKgM2: l.weightKgM2 == null ? null : Number(l.weightKgM2), free: !!l.free,
    quantity: qty, m2, currency: offer.currency,
    unitCost, unitSale,
    costAmount: round4(base * unitCost),
    saleAmount: l.free || unitSale == null ? 0 : round4(base * unitSale),
    status, notLoadedReason: status === 'NOT_LOADED' ? reason : null, notLoadedNote: status === 'NOT_LOADED' ? note : null,
  };
}

/** Yüklenmeme nedenleri (karar 102). OTHER için açıklama zorunludur. */
export const NOT_LOADED_REASONS = ['BROKEN', 'MISSING', 'NOT_READY', 'OTHER'];
const dayOfDate = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Onay kaleminin (ya da plan kaleminin) başka bir adetle yeniden kopyası: ticari değerler KALEMDEN gelir (birim maliyet,
 * müşteri birim fiyatı, cam, ölçü) — güncel teklif / fiyat tablosu okunmaz. Kısmi yüklemede satırı bölmek ve yüklenmeyen
 * kalanı ileri güne taşımak için. Hesap snapshotLine ile aynıdır (m², tutarlar).
 */
export function snapshotOfItem(it, { quantity, status = 'LOADED', reason = null, note = null }) {
  const line = {
    id: it.offerLineId ?? null, sortOrder: it.sortOrder, kind: it.kind, unit: it.unit, description: it.description, descriptionRo: it.descriptionRo ?? null,
    glassProductId: it.glassProductId ?? null, enMm: it.enMm ?? null, boyMm: it.boyMm ?? null, weightKgM2: it.weightKgM2 == null ? null : Number(it.weightKgM2),
    free: !!it.free, adet: quantity, unitPrice: Number(it.unitCost), offerPrice: it.unitSale == null ? null : Number(it.unitSale),
  };
  // offerAmount dolu: müşteri fiyatı kalemdeki unitSale'dir (eski teklif kuralı kalemde zaten uygulanmıştır)
  const row = snapshotLine({ id: it.orderId, customerId: it.customerId }, { currency: it.currency, offerAmount: 0 }, line, { quantity, status, reason, note });
  return it.replanId ? { ...row, replanId: it.replanId } : row;
}

/**
 * Kalemin kapsam anahtarı (yüklenmeyen adet girişi ve düzeltme bu anahtarla eşleşir): aktarılan kalan → r:…, teklif
 * satırı → l:… Bir onayda bir kapsam: aynı teklif satırının (ya da aynı aktarımın) yüklenen + yüklenmeyen kalemleri.
 */
export const itemKey = (i) => (i.replanId ? `r:${i.replanId}` : `l:${i.offerLineId}`);

/** Onaylar arasında benzersiz kapsam: onay + kapsam anahtarı */
export const scopeOf = (i) => `${i.confirmationId}|${itemKey(i)}`;

/**
 * Onay kalemlerinin GEÇERLİ hâli (karar 105) — tek yetkili işlev: her kapsamın en yüksek sıradaki (revision) kalemleri.
 * Düzeltilmemiş kapsamda onay anındaki kalemler (revision 0), düzeltilmiş kapsamda son düzeltmenin kalemleri döner;
 * eski satırlar tarihçedir ve hiçbir hesaba girmez. Birden çok onayın kalemleri birlikte verilebilir.
 * upTo: yalnızca bu sıraya kadar olan düzeltmeler (bir faturanın kesildiği andaki durum, düzeltme tarihçesi).
 * @template {{ confirmationId?: string, offerLineId?: string | null, replanId?: string | null, revision?: number | null }} T
 * @param {T[]} items  @param {number} [upTo]
 * @returns {T[]}
 */
export function effectiveItems(items, upTo = Infinity) {
  const top = new Map();
  for (const i of items) {
    const r = i.revision ?? 0;
    if (r > upTo) continue;
    const k = scopeOf(i);
    if (!top.has(k) || top.get(k) < r) top.set(k, r);
  }
  return items.filter((i) => (i.revision ?? 0) === top.get(scopeOf(i)));
}

/** Kalemlerin sipariş başına gruplanmış hâli (önizleme / onaylı görünüm biçimi); kalemler order ve customer ile yüklenmiş olmalı */
function groupByOrder(items) {
  const byOrder = new Map();
  for (const it of items) {
    const o = byOrder.get(it.orderId) ?? { orderId: it.orderId, orderNo: it.order.orderNo, title: it.order.title ?? null, customerId: it.customerId, customerName: it.customer.name, currency: it.currency, items: [], replanFrom: [] };
    o.items.push(it);
    // Aktarılmış kalan: hangi yüklemeden geldiği (ekranda "… yüklemesinden aktarıldı")
    const from = it.replan ? dayOfDate(it.replan.fromDay) : null;
    if (from && !o.replanFrom.includes(from)) o.replanFrom.push(from);
    byOrder.set(it.orderId, o);
  }
  return [...byOrder.values()];
}

/** Onay kalemi → hesap kurallarının beklediği teklif satırı biçimi (glassTotals, orderLoad) */
export const itemAsLine = (it) => ({
  id: it.offerLineId ?? it.id, description: it.description, descriptionRo: it.descriptionRo, enMm: it.enMm, boyMm: it.boyMm,
  adet: it.quantity, unit: it.unit, kind: it.kind, free: it.free, sortOrder: it.sortOrder,
  unitPrice: Number(it.unitCost), offerPrice: it.unitSale == null ? null : Number(it.unitSale),
  weightKgM2: it.weightKgM2 == null ? null : Number(it.weightKgM2),
});

const sumTotals = (rows) => round2(rows.reduce((s, r) => s + r.total, 0));

/**
 * Bir siparişin (onay kalemlerinin ya da teklif satırlarının) cam, m², satış ve maliyet toplamı — fatura / yükleme dökümü
 * kuralıyla (glassTotals). noCost: müşterinin ödediği ama maliyeti kayıtlı olmayan satır sayısı.
 * @param {any[]} lines  teklif satırı biçiminde: description, descriptionRo, enMm, boyMm, adet, unit, kind, free, unitPrice, offerPrice
 * @param {(l: any) => string} [nameOf]
 * @returns {{ glass: GlassRow[], adet: number, m2: number, cost: number, sale: number, noCost: number }}
 */
export function lineTotals(lines, nameOf = (l) => l.description) {
  const offer = { lines };
  const cost = glassTotals(offer, { nameOf, priceOf: (l) => l.unitPrice, includeFree: true });
  const sale = new Map(glassTotals(offer, { nameOf, priceOf: (l) => l.offerPrice }).map((g) => [g.name, g.total]));
  const glass = cost.map((g) => ({ name: g.name, adet: g.adet, m2: g.qty, cost: g.total, sale: sale.get(g.name) ?? 0 }));
  return {
    glass,
    adet: glass.reduce((s, g) => s + g.adet, 0),
    m2: round2(glass.reduce((s, g) => s + g.m2, 0)),
    cost: sumTotals(cost),
    sale: round2(glass.reduce((s, g) => s + g.sale, 0)),
    noCost: lines.filter((l) => !l.free && Number(l.offerPrice ?? 0) > 0 && !(Number(l.unitPrice ?? 0) > 0)).length,
  };
}

/**
 * O günün onay planı (önizleme ve onay aynı fonksiyonu kullanır).
 *   orders: onaylanacak siparişler ve kalemleri · skipped: o güne planlı ama onaya girmeyen siparişler ve nedeni
 *     NO_SENT_OFFER — müşteriye gönderilmiş teklifi yok (fiyatı belli değil)
 *     ALREADY_CONFIRMED — başka bir onaylı yüklemede yüklenmiş (aynı cam iki kez sayılmaz)
 * @param {{ id: string, orderNo: string, title?: string | null, customerId: string, customer: { id: string, name: string }, offers: object[] }[]} orders  o günün siparişleri
 * @param {Map<string, string>} loadedElsewhere  sipariş → onaylandığı gün ("YYYY-MM-DD"): başka bir onayda kalemi olan
 *   sipariş (yüklenmiş ya da yüklenmemiş) tarihinden yeniden plana girmez — kalanı yalnızca aktarımla (replans) gelir
 * @param {any[]} [replans]  o güne aktarılmış kalanlar (etkin LoadingReplan + kaynağı + siparişi)
 *     ORDER_CANCELLED / ORDER_ON_HOLD — aktarılan kalanın siparişi iptal / beklemede (onaya girmez)
 * @returns {{ orders: ConfirmOrder[], skipped: SkippedOrder[], items: any[] }}
 */
export function planItems(orders, loadedElsewhere = new Map(), replans = []) {
  const plan = [];
  const skipped = [];
  for (const o of orders) {
    const ref = { orderId: o.id, orderNo: o.orderNo, customerId: o.customerId, customerName: o.customer?.name ?? '' };
    if (loadedElsewhere.has(o.id)) {
      skipped.push({ ...ref, reason: 'ALREADY_CONFIRMED', day: loadedElsewhere.get(o.id) });
      continue;
    }
    const offer = sentOffer(o);
    if (!offer) {
      skipped.push({ ...ref, reason: 'NO_SENT_OFFER' });
      continue;
    }
    const items = offer.lines.map((l) => snapshotLine(o, offer, l));
    if (items.length === 0) {
      skipped.push({ ...ref, reason: 'NO_SENT_OFFER' });
      continue;
    }
    plan.push({ ...ref, title: o.title ?? null, offerId: offer.id, currency: offer.currency, items });
  }
  // İleri güne aktarılmış kalanlar: yalnızca aktarılan adet, kaynağın ticari kopyasıyla (siparişin tamamı değil)
  const carried = new Map();
  for (const r of replans) {
    const o = r.order;
    const ref = { orderId: o.id, orderNo: o.orderNo, customerId: o.customerId, customerName: o.customer?.name ?? '' };
    if (o.status === 'IPTAL' || o.onHold) {
      if (!skipped.some((s) => s.orderId === o.id)) skipped.push({ ...ref, reason: o.status === 'IPTAL' ? 'ORDER_CANCELLED' : 'ORDER_ON_HOLD' });
      continue;
    }
    const g = carried.get(o.id) ?? { ...ref, title: o.title ?? null, currency: r.sourceItem.currency, items: [], replanFrom: [] };
    g.items.push({ ...snapshotOfItem(r.sourceItem, { quantity: r.quantity }), replanId: r.id });
    const from = dayOfDate(r.fromDay);
    if (!g.replanFrom.includes(from)) g.replanFrom.push(from);
    carried.set(o.id, g);
  }
  plan.push(...carried.values());
  // Kalanı bu güne aktarılmış sipariş "başka yüklemede onaylandı" diye ayrıca listelenmez (bu günde kalanıyla yer alıyor)
  const shown = skipped.filter((s) => !(s.reason === 'ALREADY_CONFIRMED' && carried.has(s.orderId)));
  return { orders: plan, skipped: shown, items: plan.flatMap((p) => p.items) };
}

/**
 * Yüklenmeyen adetleri plana uygular: ilgili cam satırı LOADED (yüklenen) + NOT_LOADED (kalan, neden) olarak bölünür.
 * Yalnızca cam (m²) satırları bölünebilir; işlem satırları (CNC, delik, sandık…) ilk yüklemeyle birlikte kalır.
 * @param {ConfirmOrder[]} orders  @param {NotLoadedInput[]} input
 * @returns {{ ok: true, orders: ConfirmOrder[], items: any[], notLoaded: { orderId: string, quantity: number, reason: string }[] } | { ok: false, code: 'BAD_EXCEPTION' | 'BAD_QUANTITY' | 'BAD_REASON' | 'NOTE_REQUIRED' }}
 */
export function applyNotLoaded(orders, input = []) {
  const wanted = new Map();
  for (const x of input ?? []) {
    const q = Number(String(x.quantity ?? '').trim() || 0);
    if (q === 0) continue;
    const key = String(x.key ?? '');
    if (wanted.has(key)) return { ok: false, code: 'BAD_EXCEPTION' };
    if (!Number.isInteger(q) || q < 0) return { ok: false, code: 'BAD_QUANTITY' };
    const reason = String(x.reason ?? '');
    if (!NOT_LOADED_REASONS.includes(reason)) return { ok: false, code: 'BAD_REASON' };
    const note = String(x.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    if (reason === 'OTHER' && !note) return { ok: false, code: 'NOTE_REQUIRED' };
    wanted.set(key, { quantity: q, reason, note });
  }
  const notLoaded = [];
  const out = orders.map((o) => ({
    ...o,
    items: o.items.flatMap((it) => {
      const w = wanted.get(itemKey(it));
      if (!w) return [it];
      wanted.delete(itemKey(it));
      if (!isGlassLine(it)) return [{ bad: 'BAD_EXCEPTION' }];
      if (w.quantity > it.quantity) return [{ bad: 'BAD_QUANTITY' }];
      notLoaded.push({ orderId: o.orderId, quantity: w.quantity, reason: w.reason });
      const rest = it.quantity - w.quantity;
      return [
        ...(rest > 0 ? [snapshotOfItem(it, { quantity: rest })] : []),
        snapshotOfItem(it, { quantity: w.quantity, status: 'NOT_LOADED', reason: w.reason, note: w.note }),
      ];
    }),
  }));
  const bad = out.flatMap((o) => o.items).find((i) => i.bad);
  if (bad) return { ok: false, code: bad.bad };
  // Plandaki hiçbir kalemle eşleşmeyen giriş (taklit istek ya da bu arada değişen liste)
  if (wanted.size > 0) return { ok: false, code: 'BAD_EXCEPTION' };
  return { ok: true, orders: out, items: out.flatMap((o) => o.items), notLoaded };
}

/**
 * Önizlemenin parmak izi: yönetici neyi gördüyse o onaylanır. Arada sipariş / teklif / tarih değiştiyse parmak izi
 * tutmaz ve onay reddedilir (STALE_PREVIEW) — yönetici güncel içeriği yeniden kontrol eder.
 */
export function planKey(day, items) {
  const rows = items.map((i) => [i.orderId, i.offerLineId, i.quantity, i.m2, i.unitCost, i.unitSale, i.free, i.currency, ...(i.replanId ? [i.replanId] : [])]);
  return crypto.createHash('sha256').update(JSON.stringify([day, rows])).digest('hex').slice(0, 32);
}

/**
 * Kalemleri müşteri → sipariş → cam olarak özetler (önizleme ve onaylı görünüm aynı özeti kullanır).
 * @param {ConfirmOrder[]} orders
 * @param {(l: any) => string} [nameOf]
 * @returns {LoadingSummary}
 */
export function summarize(orders, nameOf) {
  const customers = new Map();
  const totals = { orders: 0, adet: 0, m2: 0, items: 0, byCur: {}, noCost: 0 };
  for (const o of orders) {
    const loaded = o.items.filter((i) => i.status === 'LOADED');
    const t = lineTotals(loaded.map(itemAsLine), nameOf);
    const c = customers.get(o.customerId) ?? { customerId: o.customerId, name: o.customerName, orders: [], adet: 0, m2: 0, byCur: {} };
    c.orders.push({ orderId: o.orderId, orderNo: o.orderNo, title: o.title ?? null, currency: o.currency, ...t, replanFrom: o.replanFrom ?? [] });
    for (const x of [c, totals]) {
      x.adet += t.adet;
      x.m2 = round2(x.m2 + t.m2);
      const cur = (x.byCur[o.currency] ??= { sale: 0, cost: 0 });
      cur.sale = round2(cur.sale + t.sale);
      cur.cost = round2(cur.cost + t.cost);
    }
    totals.orders++;
    totals.items += o.items.length;
    totals.noCost += t.noCost;
    customers.set(o.customerId, c);
  }
  return { customers: [...customers.values()].sort((a, b) => b.m2 - a.m2), totals };
}

const ORDER_INCLUDE = {
  customer: { select: { id: true, name: true } },
  offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
};

/** O güne planlı cam siparişleri (Yüklemeler sayfasıyla aynı kural: gerçek, yoksa tahmini yükleme günü; bekleyen ve iptal hariç) */
async function ordersOfDay(db, day) {
  const d = shipDayDate(day);
  const rows = await db.order.findMany({
    where: {
      orderTypeCode: 'GLASS_ORDER', onHold: false, status: { not: 'IPTAL' },
      OR: [
        { actualShipDate: { gte: new Date(d.getTime() - 86_400_000), lt: new Date(d.getTime() + 2 * 86_400_000) } },
        { actualShipDate: null, estimatedShipDate: { gte: new Date(d.getTime() - 86_400_000), lt: new Date(d.getTime() + 2 * 86_400_000) } },
      ],
    },
    include: ORDER_INCLUDE,
    orderBy: [{ customerId: 'asc' }, { customerOrderNo: 'asc' }],
  });
  return rows.filter((o) => dayKey(o.actualShipDate ?? o.estimatedShipDate) === day);
}

/**
 * Siparişler → fiilen yüklendikleri gün (herhangi bir onayda LOADED kalemi olanlar)
 * @param {any} db
 * @param {string[]} orderIds
 * @returns {Promise<Map<string, string>>}
 */
export async function loadedDays(db, orderIds) {
  if (orderIds.length === 0) return new Map();
  const rows = await db.loadingConfirmationItem.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, confirmationId: true, offerLineId: true, replanId: true, revision: true, status: true, quantity: true, confirmation: { select: { shipDay: true } } },
    orderBy: { confirmation: { shipDay: 'asc' } },
  });
  // Geçerli durum: düzeltmeyle "yüklenmedi"ye çevrilen kalem yüklenmiş sayılmaz
  const out = new Map();
  for (const r of effectiveItems(rows)) if (r.status === 'LOADED' && r.quantity > 0 && !out.has(r.orderId)) out.set(r.orderId, dayOfDate(r.confirmation.shipDay));
  return out;
}

/**
 * Siparişler → herhangi bir onayda kalemi olanların (yüklenmiş YA DA yüklenmemiş) ilk onay günü. Böyle bir sipariş
 * tarihinden yeniden plana girmez: yüklenen kısmı sayılmıştır, yüklenmeyen kalanı yalnızca aktarımla ileri güne gelir.
 * @param {any} db  @param {string[]} orderIds
 * @returns {Promise<Map<string, string>>}
 */
export async function confirmedDays(db, orderIds) {
  if (orderIds.length === 0) return new Map();
  const rows = await db.loadingConfirmationItem.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, confirmation: { select: { shipDay: true } } },
    orderBy: { confirmation: { shipDay: 'asc' } },
  });
  const out = new Map();
  for (const r of rows) if (!out.has(r.orderId)) out.set(r.orderId, dayOfDate(r.confirmation.shipDay));
  return out;
}

/** O güne aktarılmış, henüz onaylanmamış kalanlar (kaynak kalemi ve siparişiyle) */
function replansOfDay(db, day) {
  return db.loadingReplan.findMany({
    where: { shipDay: shipDayDate(day), status: 'ACTIVE' },
    include: { sourceItem: true, order: { select: { id: true, orderNo: true, title: true, customerId: true, status: true, onHold: true, customerOrderNo: true, customer: { select: { id: true, name: true } } } } },
    orderBy: [{ customerId: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * Önizleme: o gün onaylanırsa neyin kaydedileceği (+ parmak izi). Hiçbir şey yazmaz.
 * İçerik: o güne planlı siparişlerin (başka onayda kalemi olmayanların) teklif satırları + o güne aktarılmış kalanlar.
 * @param {any} db
 * @param {string} day
 * @returns {Promise<{ orders: ConfirmOrder[], skipped: SkippedOrder[], items: any[], key: string }>}
 */
export async function previewLoading(db, day) {
  const [orders, replans] = await Promise.all([ordersOfDay(db, day), replansOfDay(db, day)]);
  const plan = planItems(orders, await confirmedDays(db, orders.map((o) => o.id)), replans);
  return { ...plan, key: planKey(day, plan.items) };
}

/**
 * Onaylı yükleme (yoksa null): kalemler sipariş başına gruplanmış, önizlemeyle aynı biçimde.
 *   orders      : GEÇERLİ durum (effectiveItems — düzeltmeler uygulanmış)
 *   revision    : son düzeltmenin sırası (0 = hiç düzeltilmedi)
 *   original    : onay anındaki kayıt (revision 0 kalemleri) — yalnızca düzeltme varsa; tarihçe için
 *   corrections : düzeltmeler (sıra, kim, ne zaman, neden, kapsam başına önce → sonra)
 * @param {any} db
 * @param {string} day
 * @returns {Promise<null | { id: string, day: string, confirmedAt: Date, confirmedBy: string, note: string | null, orders: ConfirmOrder[], revision: number, original: ConfirmOrder[] | null, corrections: CorrectionView[] }>}
 */
export async function loadConfirmation(db, day) {
  const c = await db.loadingConfirmation.findUnique({
    where: { shipDay: shipDayDate(day) },
    include: {
      confirmedBy: { select: { name: true } },
      items: { orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }, { revision: 'asc' }, { status: 'asc' }], include: { order: { select: { orderNo: true, title: true } }, customer: { select: { name: true } }, replan: { select: { fromDay: true } } } },
      corrections: { orderBy: { revision: 'asc' }, include: { createdBy: { select: { name: true } } } },
    },
  });
  if (!c) return null;
  const split = (rows) => ({
    loaded: rows.filter((i) => i.status === 'LOADED').reduce((n, i) => n + i.quantity, 0),
    notLoaded: rows.filter((i) => i.status === 'NOT_LOADED').reduce((n, i) => n + i.quantity, 0),
    reason: rows.find((i) => i.status === 'NOT_LOADED')?.notLoadedReason ?? null,
  });
  // Tarihçe: her düzeltmenin eklediği kapsamlar, bir önceki geçerli durumla (önce → sonra)
  const corrections = c.corrections.map((x) => {
    const before = effectiveItems(c.items, x.revision - 1);
    const scopes = new Map();
    for (const it of c.items.filter((i) => i.revision === x.revision)) scopes.set(itemKey(it), [...(scopes.get(itemKey(it)) ?? []), it]);
    return {
      revision: x.revision, reason: x.reason, by: x.createdBy?.name ?? '—', at: x.createdAt,
      changes: [...scopes.entries()].map(([key, rows]) => ({
        key, orderId: rows[0].orderId, orderNo: rows[0].order.orderNo, customerName: rows[0].customer.name,
        description: rows[0].description, descriptionRo: rows[0].descriptionRo ?? null, enMm: rows[0].enMm ?? null, boyMm: rows[0].boyMm ?? null,
        before: split(before.filter((i) => itemKey(i) === key)), after: split(rows),
      })),
    };
  });
  return {
    id: c.id, day, confirmedAt: c.confirmedAt, confirmedBy: c.confirmedBy?.name ?? '—', note: c.note,
    orders: groupByOrder(effectiveItems(c.items)), revision: c.corrections.at(-1)?.revision ?? 0,
    original: c.corrections.length ? groupByOrder(c.items.filter((i) => i.revision === 0)) : null, corrections,
  };
}

/**
 * "Eksiksiz Yüklendi": o günün önizlemedeki bütün kalemlerini tam adetle LOADED olarak kaydeder.
 * notLoaded verilirse (yüklenmeyen cam: kalem anahtarı, adet, neden, açıklama) o cam satırları yüklenen + yüklenmeyen
 * olarak bölünür (applyNotLoaded). O güne aktarılmış kalanlar onaya girince aktarım CONFIRMED olur.
 * Aynı gün ikinci kez onaylanamaz: işlem kilidi + benzersiz yükleme günü (aynı anda gelen iki istekten biri reddedilir).
 * @param {any} db
 * @param {{ day: string, key: string, note?: string | null, notLoaded?: NotLoadedInput[], actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, id: string, orders: number, items: number, notLoaded: number } | { ok: false, code: 'FORBIDDEN' | 'BAD_DAY' | 'FUTURE_DAY' | 'ALREADY_CONFIRMED' | 'NOTHING_TO_CONFIRM' | 'STALE_PREVIEW' | 'BAD_EXCEPTION' | 'BAD_QUANTITY' | 'BAD_REASON' | 'NOTE_REQUIRED' }>}
 */
export async function confirmLoading(db, { day, key, note = null, notLoaded = [], actor, now = new Date() }) {
  if (!can(actor?.role, 'LOADING_CONFIRM')) return { ok: false, code: 'FORBIDDEN' };
  if (!parseDateOnly(day)) return { ok: false, code: 'BAD_DAY' };
  // Yükleme fiilen yapıldıktan sonra onaylanır: gelecekteki bir gün onaylanamaz (onay geri alınamaz)
  if (day > dayKey(now)) return { ok: false, code: 'FUTURE_DAY' };
  const shipDay = shipDayDate(day);
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('loading-confirmation', 0))`;
      if (await tx.loadingConfirmation.findUnique({ where: { shipDay }, select: { id: true } })) return { ok: false, code: 'ALREADY_CONFIRMED' };
      const base = await previewLoading(tx, day);
      if (base.items.length === 0) return { ok: false, code: 'NOTHING_TO_CONFIRM' };
      if (base.key !== key) return { ok: false, code: 'STALE_PREVIEW' };
      const split = applyNotLoaded(base.orders, notLoaded);
      if (!split.ok) return split;
      const plan = { ...base, orders: split.orders, items: split.items };
      const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
      const c = await tx.loadingConfirmation.create({ data: { shipDay, confirmedById: actor.id, confirmedAt: now, note: text } });
      await tx.loadingConfirmationItem.createMany({
        data: plan.items.map((i) => ({
          ...i, confirmationId: c.id, scopeKey: itemKey(i), m2: i.m2.toFixed(2), unitCost: i.unitCost.toFixed(2), unitSale: i.unitSale == null ? null : i.unitSale.toFixed(2),
          costAmount: i.costAmount.toFixed(4), saleAmount: i.saleAmount.toFixed(4),
        })),
      });
      // O güne aktarılmış kalanlar onaya girdi: aktarım kapanır (aynı kalan ikinci kez onaylanamaz — ayrıca
      // LoadingConfirmationItem [replanId, status] benzersizdir)
      const replanIds = [...new Set(plan.items.map((i) => i.replanId).filter(Boolean))];
      if (replanIds.length) {
        const closed = await tx.loadingReplan.updateMany({ where: { id: { in: replanIds }, status: 'ACTIVE' }, data: { status: 'CONFIRMED', closedAt: now } });
        if (closed.count !== replanIds.length) throw new Error('aktarım durumu değişti');
      }
      const statuses = new Map((await tx.order.findMany({ where: { id: { in: plan.orders.map((o) => o.orderId) } }, select: { id: true, status: true } })).map((o) => [o.id, o.status]));
      const dateText = day.split('-').reverse().join('.');
      for (const o of plan.orders) {
        const st = statuses.get(o.orderId) ?? null;
        const missing = o.items.filter((i) => i.status === 'NOT_LOADED').reduce((s, i) => s + i.quantity, 0);
        // Tam yüklenen sipariş: "eksiksiz yüklendi"; yüklenmeyen camı olan: ayrı olay (adet)
        if (o.items.some((i) => i.status === 'LOADED')) await writeHistory(tx, { orderId: o.orderId, event: missing ? 'LOADING_PARTIAL' : 'LOADING_CONFIRMED', from: st, to: st, actorId: actor.id, note: dateText });
        if (missing) await writeHistory(tx, { orderId: o.orderId, event: 'LOADING_NOT_LOADED', from: st, to: st, actorId: actor.id, note: `${dateText} · ${missing}` });
      }
      const { totals } = summarize(plan.orders);
      await writeAudit(tx, {
        action: 'LOADING_CONFIRMED', entityType: 'LoadingConfirmation', entityId: c.id, userId: actor.id,
        details: {
          shipDay: day, confirmedAt: now.toISOString(), note: text,
          customers: [...new Map(plan.orders.map((o) => [o.customerId, o.customerName])).entries()].map(([id, name]) => ({ id, name })),
          orders: plan.orders.map((o) => ({ id: o.orderId, orderNo: o.orderNo, offerId: o.offerId, items: o.items.length })),
          skipped: plan.skipped.map((s) => ({ orderNo: s.orderNo, reason: s.reason })),
          items: plan.items.length, pieces: totals.adet, m2: totals.m2, totals: totals.byCur, noCostLines: totals.noCost,
          notLoaded: plan.items.filter((i) => i.status === 'NOT_LOADED').map((i) => ({ orderId: i.orderId, offerLineId: i.offerLineId, quantity: i.quantity, m2: i.m2, reason: i.notLoadedReason, replanId: i.replanId ?? null })),
          replans: replanIds,
        },
      }, actor);
      return { ok: true, id: c.id, orders: plan.orders.length, items: plan.items.length, notLoaded: split.notLoaded.length };
    }, { timeout: 30_000 });
  } catch (e) {
    // Kilit dışında aynı gün için ikinci kayıt denenirse veritabanı reddeder (benzersiz yükleme günü)
    if (e?.code === 'P2002') return { ok: false, code: 'ALREADY_CONFIRMED' };
    throw e;
  }
}
