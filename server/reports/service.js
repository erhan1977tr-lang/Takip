// Yönetici raporları (3.89.0, karar 284) — panel, Excel ve Telegram asistanının ORTAK, SALT OKUNUR hesap servisi.
//
// Tek giriş: runReport(db, input, { actor, now, timeZone }). Filtreler server/reports/filters.js'teki tek ayrıştırıcıdan
// geçer; her kanal aynı fonksiyonu aynı filtreyle çağırır, bu yüzden aynı filtre her kanalda aynı toplamı verir. Telegram
// için ayrı SQL ya da ayrı formül yoktur (server/assistant/tools.js → rapor aracı bunu çağırır).
//
// Hesap kuralları TAKİP'in mevcut kurallarıdır — burada yeni formül yazılmaz:
//   - cam m²: offerLineTotals (kayıtlı parça m², ayrılmış cam — karar 114, 261), 3 ondalık, binde bir tamsayıyla toplanır;
//   - yükleme bölümleri: loadingParts + effectiveItems (onaylı yüklemenin GEÇERLİ kalemleri; yalnızca LOADED fiilen yüklenmiş
//     sayılır, kalan etkin aktarımın gününde planlıdır, ikisi de yoksa "planlanmamış kalan");
//   - satış / maliyet: Muhasebe → Tedarikçi Hesap Durumu'nun motoru (orderLine, confirmedLine, lineTotals → glassTotals);
//   - alacak: receivables (proforma + avans + nihai fatura aynı borcu iki kez saymaz — karar 88, 101);
//   - stok: StockMovement (yalnızca eklenen hareketler; tür bazında bir kez sayılır), stockLevels, reservedLevels.
// Yazma yok: yalnızca findMany / findUnique / findFirst / count / groupBy. Kaldırılmış (removedAt) ve İPTAL siparişler hiçbir
// rapora girmez. Para birimleri asla toplanmaz; eksik veri sıfır gösterilmez (null + açıklama kodu).
import { can } from '../auth/permissions.js';
import { localDay } from '../profile/dates.js';
import { effectiveItems, isGlassLine } from '../loading/confirmation.js';
import { isCrateLine, offerLineTotals } from '../orders/rules.js';
import { dayKey, loadedOffer } from '../orders/loading.js';
import { loadingParts } from '../orders/customer-offers.js';
import { confirmedLine, orderLine } from '../accounting/supplier.js';
import { receivables } from '../accounting/receivables.js';
import { reservedLevels, stockLevels } from '../profile/stock.js';
import { dateRange, instantRange, monthOf, parseReportFilters, shiftDay } from './filters.js';

export const REPORT_PERMISSION = 'REPORT_VIEW';
/**
 * Sorgu sınırları: bir rapor bu kadar kaydı aşarsa EKSİK toplam verilmez — rapor reddedilir (TOO_LARGE) ve kullanıcıdan
 * aralığı / filtreyi daraltması istenir (sessiz kısaltma yok).
 */
export const REPORT_LIMITS = Object.freeze({ orders: 5000, items: 80_000, docs: 20_000, movements: 50_000, payments: 20_000, supplierOrders: 3000 });
/** Panelde gösterilen en çok satır (Excel bütün satırları yazar; toplamlar her zaman bütün satırlardan) */
export const PANEL_ROWS = 300;

/** Telegram asistanının aktörü: tek yetkili kullanıcı denetimi server/assistant/bot.js'tedir (isAllowed) */
export const ASSISTANT_ACTOR = Object.freeze({ assistant: true });
const allowed = (actor) => actor?.assistant === true || (!!actor?.role && can(actor.role, REPORT_PERMISSION));

class ReportError extends Error {
  /** @param {string} code */
  constructor(code) { super(code); this.code = code; }
}

// ---------------------------------------------------------------- küçük yardımcılar
const milli = (v) => Math.round((Number(v ?? 0) + Number.EPSILON) * 1000);
const cents = (v) => Math.round((Number(v ?? 0) + Number.EPSILON) * 100);
const fromMilli = (n) => n / 1000;
const fromCents = (n) => n / 100;
const isGlass = (l) => isGlassLine(l) && !l.crateFee && !isCrateLine(l);
const lineM2 = (l) => offerLineTotals({ ...l, unit: 'm2', unitPrice: 0, free: false }).metraj;
const qtyOf = (l) => Math.max(0, Math.trunc(Number(l.adet ?? l.quantity ?? 0)));
/** Arama için katlama: büyük / küçük harf, aksan ve Türkçe I / ı farkı yok */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i').toLowerCase();
const matches = (q) => {
  const fq = fold(q);
  return (...vals) => !fq || vals.some((v) => v != null && fold(v).includes(fq));
};
async function take(promise, limit) {
  const rows = await promise;
  if (rows.length > limit) throw new ReportError('TOO_LARGE');
  return rows;
}
const ACTIVE_ORDER = { removedAt: null, status: { not: /** @type {const} */ ('IPTAL') } };
const typeCodes = (t) => (t === 'GLASS' ? ['GLASS_ORDER'] : t === 'PROFILE' ? ['PROFILE_ORDER'] : ['GLASS_ORDER', 'PROFILE_ORDER']);

/**
 * Tablo kurucu. columns: [anahtar, tür, seçenek] — tür: text | day | month | code | int | m2 | money | currency | dec3
 * @returns {ReportTable}
 */
function table(key, columns, rows, opts = {}) {
  return { key, columns: columns.map(([k, type, o]) => ({ key: k, type, ...(o ?? {}) })), rows, ...opts };
}
/**
 * @typedef {{ key: string, type: string, dict?: string }} ReportColumn
 * @typedef {{ key: string, columns: ReportColumn[], rows: (string | number | null)[][], totals?: (string | number | null)[][], basis?: string,
 *   chart?: { label: number, value: number } }} ReportTable
 * @typedef {{ key: string, value: number | null, type: string, unit?: string, note?: string }} ReportCard
 */

// ---------------------------------------------------------------- firma
const customerWhere = (q) => ({
  type: /** @type {const} */ ('CUSTOMER'),
  OR: [{ name: { contains: q, mode: /** @type {const} */ ('insensitive') } }, ...(/^[A-Za-z]{3}$/.test(q) ? [{ prefix: q.toUpperCase() }] : [])],
});
/** Firma filtresi: kimlik (panel) ya da metin (Telegram). Metin birden çok firmaya uyuyorsa tahmin edilmez. */
async function resolveCustomer(tx, f) {
  if (f.customerId) {
    const c = await tx.customer.findUnique({ where: { id: f.customerId }, select: { id: true, name: true, type: true } });
    if (!c || c.type !== 'CUSTOMER') return { error: 'CUSTOMER_NOT_FOUND' };
    return { customer: { id: c.id, name: c.name } };
  }
  if (!f.customer) return { customer: null };
  const list = await tx.customer.findMany({ where: customerWhere(f.customer), take: 6, orderBy: { name: 'asc' }, select: { id: true, name: true, prefix: true } });
  if (list.length === 0) return { error: 'CUSTOMER_NOT_FOUND' };
  const exact = list.filter((c) => fold(c.name) === fold(f.customer) || (c.prefix ?? '').toUpperCase() === f.customer.toUpperCase());
  if (exact.length === 1) return { customer: { id: exact[0].id, name: exact[0].name } };
  if (list.length === 1) return { customer: { id: list[0].id, name: list[0].name } };
  return { error: 'CUSTOMER_AMBIGUOUS', candidates: list.map((c) => c.name) };
}

// ---------------------------------------------------------------- cam siparişinin miktarları (tek kural)
/**
 * Siparişin cam miktarları: sipariş edilen (iç ekibin gördüğü teklif — gönderilmiş son teklif, yoksa son taslak), fiilen
 * yüklenen (onaylı yükleme), planlanan (onaysız yükleme günü ya da etkin aktarım) ve planlanmamış kalan; her biri ticari
 * ve bedelsiz telafi olarak ayrı, cam türü bazında. Teklif tablosu yoksa miktar bilinmez (noOffer — sıfır sayılmaz).
 * @param {any} order  offers (en yeni önce, satırlarla), loadedItems (onay günüyle), replans
 * @param {(l: any) => boolean} lineOk  ürün filtresi (cam adı)
 */
export function orderGlass(order, lineOk = () => true) {
  const offer = loadedOffer(order.offers, false);
  const glassLines = (offer?.lines ?? []).filter(isGlass);
  if (!offer || glassLines.length === 0) return { noOffer: true, state: 'NOT_LOADED', types: new Map(), loadedDays: [] };
  const items = effectiveItems(order.loadedItems ?? []);
  const loadedDays = new Set(items.filter((i) => i.status === 'LOADED' && i.quantity > 0).map((i) => new Date(i.confirmation.shipDay).toISOString().slice(0, 10)));
  const parts = loadingParts(order, offer);
  /** @type {Map<string, any>} */
  const types = new Map();
  const add = (l, bucket) => {
    if (!isGlass(l) || !lineOk(l)) return;
    const k = `${l.description}\u0000${l.free ? 1 : 0}`;
    const t = types.get(k) ?? { name: l.description, nameRo: l.descriptionRo ?? null, free: !!l.free, ordered: [0, 0], loaded: [0, 0], planned: [0, 0], open: [0, 0] };
    t[bucket][0] += qtyOf(l);
    t[bucket][1] += milli(lineM2(l));
    types.set(k, t);
  };
  for (const l of offer.lines) add(l, 'ordered');
  for (const p of parts) {
    const bucket = p.day == null ? 'open' : items.length && loadedDays.has(p.day) ? 'loaded' : 'planned';
    for (const l of p.lines) add(l, bucket);
  }
  let ordered = 0;
  let loaded = 0;
  for (const t of types.values()) { ordered += t.ordered[0]; loaded += t.loaded[0]; }
  const state = loaded === 0 ? 'NOT_LOADED' : loaded >= ordered ? 'LOADED' : 'PARTIAL';
  return { noOffer: false, state, types, loadedDays: [...loadedDays].sort(), offerSent: offer.status === 'GONDERILDI' };
}
/** Cam türlerinin toplamı (binde bir m²) */
function sumTypes(types) {
  const z = () => ({ ordered: [0, 0], loaded: [0, 0], planned: [0, 0], open: [0, 0] });
  const out = { com: z(), free: z() };
  for (const t of types.values()) {
    const o = t.free ? out.free : out.com;
    for (const b of ['ordered', 'loaded', 'planned', 'open']) { o[b][0] += t[b][0]; o[b][1] += t[b][1]; }
  }
  return out;
}
/** Profil siparişinin "yükleme" karşılığı: teslim edildi mi */
const profileDelivered = (o) => ['TESLIM_EDILDI', 'FATURALANDI'].includes(o.profile?.stage ?? '') || o.profile?.deliveredAt != null;
const loadingStateOf = (o, g) => (o.orderTypeCode === 'PROFILE_ORDER' ? (profileDelivered(o) ? 'LOADED' : 'NOT_LOADED') : g.state);

// ---------------------------------------------------------------- sipariş sorgusu (sipariş + cam raporu ortak)
const LINE_SELECT = {
  id: true, description: true, descriptionRo: true, enMm: true, boyMm: true, adet: true, unit: true, kind: true, free: true, pieceBase: true,
  pieceM2: true, crateFee: true, unitPrice: true, offerPrice: true, weightKgM2: true, sortOrder: true, compensationId: true,
};
const ORDER_SELECT = {
  id: true, orderNo: true, status: true, orderTypeCode: true, onHold: true, createdAt: true, estimatedShipDate: true, actualShipDate: true,
  customer: { select: { id: true, name: true } },
  items: { select: { glassName: true, glassNameRo: true } },
  offers: { orderBy: { createdAt: /** @type {const} */ ('desc') }, select: { status: true, currency: true, sentAt: true, createdAt: true, offerAmount: true, lines: { orderBy: { sortOrder: /** @type {const} */ ('asc') }, select: LINE_SELECT } } },
  loadedItems: { select: { confirmationId: true, offerLineId: true, replanId: true, revision: true, status: true, quantity: true, confirmation: { select: { shipDay: true } } } },
  replans: { where: { status: /** @type {const} */ ('ACTIVE') }, select: { status: true, quantity: true, shipDay: true, sourceItem: { select: { offerLineId: true } } } },
  profile: { select: { stage: true, deliveredAt: true, pickupDate: true, approvedAt: true } },
  profileItems: { orderBy: { sortOrder: /** @type {const} */ ('asc') }, select: { code: true, nameTr: true, nameRo: true, unitCode: true, qty: true, productId: true } },
};
/** Oluşturma tarihi aralıktaki etkin siparişler (sipariş + cam + profil raporlarının ortak tabanı) */
async function ordersCreated(tx, f, ctx, types) {
  return take(tx.order.findMany({
    where: {
      ...ACTIVE_ORDER, ...(f.status ? { status: f.status } : {}), orderTypeCode: { in: types },
      createdAt: instantRange(f, ctx.timeZone), ...(ctx.customer ? { customerId: ctx.customer.id } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { orderNo: 'asc' }], select: ORDER_SELECT, take: REPORT_LIMITS.orders + 1,
  }), REPORT_LIMITS.orders);
}

// ================================================================ A. SİPARİŞ RAPORU
async function ordersReport(tx, f, ctx) {
  const orders = await ordersCreated(tx, f, ctx, typeCodes(f.orderType));
  const want = matches(f.product);
  const rows = [];
  const byCustomer = new Map();
  const byMonth = new Map();
  let noOffer = 0;
  for (const o of orders) {
    const glass = o.orderTypeCode === 'GLASS_ORDER';
    const lineOk = (l) => want(l.description, l.descriptionRo);
    const g = glass ? orderGlass(o, lineOk) : null;
    if (f.product) {
      const hit = glass ? [...(g?.types.values() ?? [])].length > 0 || o.items.some((i) => want(i.glassName, i.glassNameRo)) : o.profileItems.some((i) => want(i.code, i.nameTr, i.nameRo));
      if (!hit) continue;
    }
    const state = loadingStateOf(o, g ?? { state: 'NOT_LOADED' });
    if (f.loading !== 'ALL' && state !== f.loading) continue;
    const done = glass ? ['YUKLENDI', 'ARSIVLENDI'].includes(o.status) || state === 'LOADED' : o.status === 'ARSIVLENDI' || profileDelivered(o);
    const s = g && !g.noOffer ? sumTypes(g.types) : null;
    if (glass && (!g || g.noOffer)) noOffer++;
    const m2 = (b) => (s ? s.com[b][1] + s.free[b][1] : null);
    const created = localDay(o.createdAt, ctx.timeZone);
    const planned = o.orderTypeCode === 'PROFILE_ORDER' ? (o.profile?.pickupDate ? new Date(o.profile.pickupDate).toISOString().slice(0, 10) : null)
      : (o.actualShipDate ?? o.estimatedShipDate ? dayKey(o.actualShipDate ?? o.estimatedShipDate) : null);
    rows.push([o.orderNo, o.customer.name, o.orderTypeCode === 'PROFILE_ORDER' ? 'PROFILE' : 'GLASS', created, o.status, state, done ? 'DONE' : 'WAITING', planned,
      s ? s.com.ordered[0] + s.free.ordered[0] : null, m2('ordered') == null ? null : fromMilli(m2('ordered')), m2('loaded') == null ? null : fromMilli(m2('loaded')),
      m2('planned') == null ? null : fromMilli(m2('planned') + m2('open'))]);
    const c = byCustomer.get(o.customer.id) ?? { name: o.customer.name, n: 0, glass: 0, profile: 0, done: 0, waiting: 0, ordered: 0, loaded: 0, rest: 0, unknown: 0 };
    c.n++; c[glass ? 'glass' : 'profile']++; c[done ? 'done' : 'waiting']++;
    if (s) { c.ordered += m2('ordered'); c.loaded += m2('loaded'); c.rest += m2('planned') + m2('open'); } else if (glass) c.unknown++;
    byCustomer.set(o.customer.id, c);
    const mk = monthOf(created);
    const mm = byMonth.get(mk) ?? { n: 0, glass: 0, profile: 0, m2: 0 };
    mm.n++; mm[glass ? 'glass' : 'profile']++; if (s) mm.m2 += m2('ordered');
    byMonth.set(mk, mm);
  }
  const cust = [...byCustomer.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const tot = cust.reduce((t, c) => { for (const k of ['n', 'glass', 'profile', 'done', 'waiting', 'ordered', 'loaded', 'rest', 'unknown']) t[k] += c[k]; return t; }, { n: 0, glass: 0, profile: 0, done: 0, waiting: 0, ordered: 0, loaded: 0, rest: 0, unknown: 0 });
  return {
    basis: 'ORDER_CREATED',
    cards: [
      { key: 'orders', value: tot.n, type: 'int' }, { key: 'glassOrders', value: tot.glass, type: 'int' }, { key: 'profileOrders', value: tot.profile, type: 'int' },
      { key: 'completed', value: tot.done, type: 'int' }, { key: 'waiting', value: tot.waiting, type: 'int' },
      { key: 'orderedM2', value: fromMilli(tot.ordered), type: 'm2' }, { key: 'loadedM2', value: fromMilli(tot.loaded), type: 'm2' }, { key: 'remainingM2', value: fromMilli(tot.rest), type: 'm2' },
    ],
    tables: [
      table('byCustomer', [['customer', 'text'], ['orders', 'int'], ['glassOrders', 'int'], ['profileOrders', 'int'], ['completed', 'int'], ['waiting', 'int'], ['orderedM2', 'm2'], ['loadedM2', 'm2'], ['remainingM2', 'm2'], ['noOfferTable', 'int']],
        cust.map((c) => [c.name, c.n, c.glass, c.profile, c.done, c.waiting, fromMilli(c.ordered), fromMilli(c.loaded), fromMilli(c.rest), c.unknown]),
        { totals: [['', tot.n, tot.glass, tot.profile, tot.done, tot.waiting, fromMilli(tot.ordered), fromMilli(tot.loaded), fromMilli(tot.rest), tot.unknown]], chart: { label: 0, value: 1 } }),
      table('byMonth', [['month', 'month'], ['orders', 'int'], ['glassOrders', 'int'], ['profileOrders', 'int'], ['orderedM2', 'm2']],
        [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => [k, v.n, v.glass, v.profile, fromMilli(v.m2)]), { chart: { label: 0, value: 1 } }),
      table('orders', [['orderNo', 'text'], ['customer', 'text'], ['type', 'code', { dict: 'type' }], ['created', 'day'], ['status', 'code', { dict: 'status' }], ['loading', 'code', { dict: 'loading' }],
        ['progress', 'code', { dict: 'progress' }], ['plannedDay', 'day'], ['orderedPcs', 'int'], ['orderedM2', 'm2'], ['loadedM2', 'm2'], ['remainingM2', 'm2']], rows),
    ],
    notes: [...(noOffer ? ['NO_OFFER_TABLE'] : []), 'COMPLETED_RULE', 'M2_RULE'],
  };
}

// ================================================================ B. CAM RAPORU
async function glassReport(tx, f, ctx) {
  const orders = await ordersCreated(tx, f, ctx, ['GLASS_ORDER']);
  const want = matches(f.product);
  const types = new Map(); // firma + cam türü
  const partial = [];
  const byMonth = new Map();
  const total = { com: { ordered: [0, 0], loaded: [0, 0], planned: [0, 0], open: [0, 0] }, free: { ordered: [0, 0], loaded: [0, 0], planned: [0, 0], open: [0, 0] } };
  let noOffer = 0;
  for (const o of orders) {
    const g = orderGlass(o, (l) => want(l.description, l.descriptionRo));
    if (g.noOffer) { if (!f.product || o.items.some((i) => want(i.glassName, i.glassNameRo))) noOffer++; continue; }
    if (g.types.size === 0) continue;
    if (f.loading !== 'ALL' && g.state !== f.loading) continue;
    const s = sumTypes(g.types);
    for (const k of ['com', 'free']) for (const b of ['ordered', 'loaded', 'planned', 'open']) { total[k][b][0] += s[k][b][0]; total[k][b][1] += s[k][b][1]; }
    for (const t of g.types.values()) {
      const key = `${o.customer.id}\u0000${t.name}`;
      const r = types.get(key) ?? { customer: o.customer.name, name: t.name, com: [0, 0], free: [0, 0], loadedCom: 0, loadedFree: 0, planned: 0, open: 0 };
      r[t.free ? 'free' : 'com'][0] += t.ordered[0];
      r[t.free ? 'free' : 'com'][1] += t.ordered[1];
      r[t.free ? 'loadedFree' : 'loadedCom'] += t.loaded[1];
      r.planned += t.planned[1];
      r.open += t.open[1];
      types.set(key, r);
    }
    if (g.state === 'PARTIAL') {
      const m = (b) => s.com[b][1] + s.free[b][1];
      partial.push([o.orderNo, o.customer.name, fromMilli(m('ordered')), fromMilli(m('loaded')), fromMilli(m('planned')), fromMilli(m('open')), g.loadedDays.join(', ')]);
    }
    const mk = monthOf(localDay(o.createdAt, ctx.timeZone));
    const mm = byMonth.get(mk) ?? { com: [0, 0], free: [0, 0] };
    mm.com[0] += s.com.ordered[0]; mm.com[1] += s.com.ordered[1]; mm.free[0] += s.free.ordered[0]; mm.free[1] += s.free.ordered[1];
    byMonth.set(mk, mm);
  }
  const rows = [...types.values()].sort((a, b) => a.customer.localeCompare(b.customer) || b.com[1] - a.com[1] || a.name.localeCompare(b.name));
  const sumRow = rows.reduce((t, r) => { t[0] += r.com[0]; t[1] += r.com[1]; t[2] += r.free[0]; t[3] += r.free[1]; t[4] += r.loadedCom; t[5] += r.loadedFree; t[6] += r.planned; t[7] += r.open; return t; }, [0, 0, 0, 0, 0, 0, 0, 0]);
  const T = total;
  return {
    basis: 'ORDER_CREATED',
    cards: [
      { key: 'commercialM2', value: fromMilli(T.com.ordered[1]), type: 'm2' }, { key: 'commercialPcs', value: T.com.ordered[0], type: 'int' },
      { key: 'freeM2', value: fromMilli(T.free.ordered[1]), type: 'm2' }, { key: 'freePcs', value: T.free.ordered[0], type: 'int' },
      { key: 'loadedM2', value: fromMilli(T.com.loaded[1] + T.free.loaded[1]), type: 'm2' }, { key: 'plannedM2', value: fromMilli(T.com.planned[1] + T.free.planned[1]), type: 'm2' },
      { key: 'openM2', value: fromMilli(T.com.open[1] + T.free.open[1]), type: 'm2' }, { key: 'partialOrders', value: partial.length, type: 'int' },
    ],
    tables: [
      table('byCustomerGlass', [['customer', 'text'], ['glass', 'text'], ['commercialPcs', 'int'], ['commercialM2', 'm2'], ['freePcs', 'int'], ['freeM2', 'm2'], ['loadedM2', 'm2'], ['loadedFreeM2', 'm2'], ['plannedM2', 'm2'], ['openM2', 'm2']],
        rows.map((r) => [r.customer, r.name, r.com[0], fromMilli(r.com[1]), r.free[0], fromMilli(r.free[1]), fromMilli(r.loadedCom), fromMilli(r.loadedFree), fromMilli(r.planned), fromMilli(r.open)]),
        { totals: [['', '', sumRow[0], fromMilli(sumRow[1]), sumRow[2], fromMilli(sumRow[3]), fromMilli(sumRow[4]), fromMilli(sumRow[5]), fromMilli(sumRow[6]), fromMilli(sumRow[7])]] }),
      table('byMonth', [['month', 'month'], ['commercialPcs', 'int'], ['commercialM2', 'm2'], ['freePcs', 'int'], ['freeM2', 'm2']],
        [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => [k, v.com[0], fromMilli(v.com[1]), v.free[0], fromMilli(v.free[1])]), { chart: { label: 0, value: 2 } }),
      table('partial', [['orderNo', 'text'], ['customer', 'text'], ['orderedM2', 'm2'], ['loadedM2', 'm2'], ['plannedM2', 'm2'], ['openM2', 'm2'], ['loadedDays', 'text']], partial),
    ],
    notes: [...(noOffer ? ['NO_OFFER_TABLE'] : []), 'FREE_SEPARATE', 'LOADED_CONFIRMED_ONLY', 'M2_RULE'],
    counts: { noOffer },
  };
}

// ================================================================ C. PROFİL VE STOK RAPORU
async function profileReport(tx, f, ctx) {
  const want = matches(f.product);
  const orders = f.orderType === 'GLASS' ? [] : await ordersCreated(tx, f, ctx, ['PROFILE_ORDER']);
  const byProduct = new Map();
  const byCustomer = new Map();
  for (const o of orders) {
    // Profil siparişi kısmen teslim edilmez: "kısmi" filtresinde profil siparişi yoktur
    if (f.loading !== 'ALL' && loadingStateOf(o, null) !== f.loading) continue;
    for (const it of o.profileItems) {
      if (!want(it.code, it.nameTr, it.nameRo) || !(it.qty > 0)) continue;
      const k = `${it.code}\u0000${it.unitCode}`;
      const p = byProduct.get(k) ?? { code: it.code, name: it.nameTr, nameRo: it.nameRo, unit: it.unitCode, productId: it.productId, qty: 0, orders: new Set() };
      p.qty += it.qty; p.orders.add(o.id);
      byProduct.set(k, p);
      const ck = `${o.customer.id}\u0000${it.unitCode}`;
      const c = byCustomer.get(ck) ?? { name: o.customer.name, unit: it.unitCode, qty: 0, orders: new Set() };
      c.qty += it.qty; c.orders.add(o.id);
      byCustomer.set(ck, c);
    }
  }
  // Ürünler (paket içeriği = profil boyu / kutu metresi; RAL ürün kodunun parçasıdır — ayrı alan yoktur)
  const products = await take(tx.profileProduct.findMany({
    select: { id: true, code: true, nameTr: true, nameRo: true, unitCode: true, packContent: true, packMeasure: true, criticalStock: true, isActive: true },
    orderBy: { code: 'asc' }, take: 5001,
  }), 5000);
  const prodById = new Map(products.map((p) => [p.id, p]));
  const pack = (id) => { const p = prodById.get(id); return p?.packContent != null ? `${Number(p.packContent)} ${p.packMeasure === 'M' ? 'm' : 'buc'}` : null; };
  // Stok hareketleri (aralıkta oluşturulan) — tür bazında; mal kabulü girişi (supplierReceiptId) elle girişten ayrı
  const shown = products.filter((p) => want(p.code, p.nameTr, p.nameRo));
  const ids = shown.map((p) => p.id);
  const moves = await tx.stockMovement.groupBy({
    by: ['productId', 'kind'], where: { productId: { in: ids }, createdAt: instantRange(f, ctx.timeZone) }, _sum: { qty: true }, _count: { _all: true },
  });
  const receiptMoves = await tx.stockMovement.groupBy({
    by: ['productId'], where: { productId: { in: ids }, kind: 'GIRIS', supplierReceiptId: { not: null }, createdAt: instantRange(f, ctx.timeZone) }, _sum: { qty: true },
  });
  const rec = new Map(receiptMoves.map((r) => [r.productId, r._sum.qty ?? 0]));
  const mv = new Map();
  for (const r of moves) {
    const m = mv.get(r.productId) ?? { GIRIS: 0, CIKIS: 0, SAYIM: 0, IADE: 0, KABUL_DUZELTME: 0 };
    m[r.kind] = r._sum.qty ?? 0;
    mv.set(r.productId, m);
  }
  // Mal kabulü düzeltmesi (karar 286) ayrı sütun (−): net = bütün türlerin toplamı (stok bakiyesiyle aynı kural)
  const moveRows = [];
  for (const p of shown) {
    const m = mv.get(p.id);
    if (!m) continue;
    const r = rec.get(p.id) ?? 0;
    moveRows.push([p.code, p.nameTr, p.unitCode, r, m.KABUL_DUZELTME, m.GIRIS - r, m.CIKIS, m.IADE, m.SAYIM, m.GIRIS + m.KABUL_DUZELTME + m.CIKIS + m.IADE + m.SAYIM]);
  }
  // Birimler toplanmaz: hareket toplamı birim başına
  const moveTotals = [...moveRows.reduce((acc, r) => {
    const t = acc.get(r[2]) ?? [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 7; i++) t[i] += Number(r[3 + i]);
    acc.set(r[2], t);
    return acc;
  }, new Map()).entries()].map(([u, t]) => ['', '', u, ...t]);
  // Güncel stok (aralıktan bağımsız)
  const [levels, reserved] = await Promise.all([stockLevels(tx, ids), reservedLevels(tx, ids)]);
  const stockRows = shown.filter((p) => p.isActive || (levels.get(p.id) ?? 0) !== 0).map((p) => {
    const st = levels.get(p.id) ?? 0;
    const rz = reserved.get(p.id) ?? 0;
    const state = st < 0 ? 'NEGATIVE' : p.criticalStock != null && st <= p.criticalStock ? 'CRITICAL' : st < rz ? 'SHORT' : 'OK';
    return [p.code, p.nameTr, p.unitCode, pack(p.id), st, rz, st - rz, p.criticalStock, state];
  });
  const low = stockRows.filter((r) => r[8] !== 'OK');
  // Tedarikçi siparişleri (son kesin revizyon) ve mal kabulleri (aralıkta)
  const supplierOrders = await take(tx.supplierOrder.findMany({
    where: { status: { not: 'TASLAK' }, revisions: { some: { finalizedAt: instantRange(f, ctx.timeZone) } } },
    select: {
      orderNo: true, status: true, currency: true, supplier: { select: { name: true } },
      revisions: { where: { finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, take: 1, select: { revision: true, orderDate: true, lines: { select: { id: true, code: true, qty: true, unitCode: true, color: true, productId: true } } } },
      receipts: { select: { lines: { select: { orderLineId: true, qty: true } } } },
      receiptCorrections: { select: { lines: { select: { orderLineId: true, qty: true } } } },
    },
    orderBy: { orderNo: 'asc' }, take: REPORT_LIMITS.supplierOrders + 1,
  }), REPORT_LIMITS.supplierOrders);
  const soRows = [];
  for (const so of supplierOrders) {
    const rev = so.revisions[0];
    if (!rev) continue;
    const received = new Map();
    for (const r of so.receipts) for (const l of r.lines) received.set(l.orderLineId, (received.get(l.orderLineId) ?? 0) + l.qty);
    // Net teslim alınan = kabuller − kabul düzeltmeleri (karar 286)
    for (const c of so.receiptCorrections) for (const l of c.lines) received.set(l.orderLineId, Math.max(0, (received.get(l.orderLineId) ?? 0) - l.qty));
    for (const l of rev.lines) {
      if (!want(l.code)) continue;
      const got = received.get(l.id) ?? 0;
      soRows.push([so.orderNo, so.supplier.name, new Date(rev.orderDate).toISOString().slice(0, 10), so.status, l.code, l.color ?? null, l.unitCode, l.qty, got, Math.max(0, l.qty - got)]);
    }
  }
  const receipts = await take(tx.supplierReceiptLine.findMany({
    where: { receipt: { receivedOn: dateRange(f) } },
    select: { code: true, color: true, lengthM: true, qty: true, unitCode: true, receipt: { select: { receivedOn: true, seq: true, order: { select: { orderNo: true, supplier: { select: { name: true } } } } } } },
    orderBy: [{ receipt: { receivedOn: 'asc' } }, { sortOrder: 'asc' }], take: REPORT_LIMITS.movements + 1,
  }), REPORT_LIMITS.movements);
  const recRows = receipts.filter((l) => want(l.code)).map((l) => [new Date(l.receipt.receivedOn).toISOString().slice(0, 10), 'RECEIPT', l.receipt.order.orderNo, l.receipt.order.supplier.name, l.code, l.color ?? null, l.lengthM == null ? null : Number(l.lengthM), l.unitCode, l.qty]);
  // Kabul düzeltmeleri (karar 286): düzeltmenin yapıldığı gün (uygulama saat diliminde), eksi miktar; orijinal kabul satırı değişmez
  const fixes = await take(tx.supplierReceiptCorrectionLine.findMany({
    where: { correction: { createdAt: instantRange(f, ctx.timeZone) } },
    select: { code: true, color: true, lengthM: true, qty: true, unitCode: true, correction: { select: { createdAt: true, order: { select: { orderNo: true, supplier: { select: { name: true } } } } } } },
    orderBy: [{ correction: { createdAt: 'asc' } }, { sortOrder: 'asc' }], take: REPORT_LIMITS.movements + 1,
  }), REPORT_LIMITS.movements);
  for (const l of fixes) {
    if (!want(l.code)) continue;
    recRows.push([localDay(l.correction.createdAt, ctx.timeZone), 'CORRECTION', l.correction.order.orderNo, l.correction.order.supplier.name, l.code, l.color ?? null, l.lengthM == null ? null : Number(l.lengthM), l.unitCode, -l.qty]);
  }
  recRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const unitSum = (rows, uIdx, qIdx) => [...rows.reduce((m, r) => m.set(r[uIdx], (m.get(r[uIdx]) ?? 0) + Number(r[qIdx])), new Map()).entries()];
  const prodRows = [...byProduct.values()].sort((a, b) => a.code.localeCompare(b.code)).map((p) => [p.code, p.name, p.unit, pack(p.productId), p.qty, p.orders.size]);
  const custRows = [...byCustomer.values()].sort((a, b) => a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit)).map((c) => [c.name, c.unit, c.qty, c.orders.size]);
  return {
    basis: 'PROFILE_CREATED',
    cards: [
      { key: 'profileOrders', value: new Set(orders.filter((o) => o.profileItems.some((i) => want(i.code, i.nameTr, i.nameRo))).map((o) => o.id)).size, type: 'int' },
      { key: 'products', value: prodRows.length, type: 'int' },
      { key: 'lowStock', value: low.length, type: 'int' },
      { key: 'receipts', value: new Set(receipts.map((l) => `${l.receipt.order.orderNo}#${l.receipt.seq}`)).size, type: 'int' },
    ],
    tables: [
      table('byProduct', [['code', 'text'], ['product', 'text'], ['unit', 'text'], ['packContent', 'text'], ['qty', 'int'], ['orders', 'int']], prodRows,
        { totals: unitSum(prodRows, 2, 4).map(([u, q]) => ['', '', u, '', q, null]) }),
      table('byCustomerProfile', [['customer', 'text'], ['unit', 'text'], ['qty', 'int'], ['orders', 'int']], custRows),
      table('stock', [['code', 'text'], ['product', 'text'], ['unit', 'text'], ['packContent', 'text'], ['stock', 'int'], ['reserved', 'int'], ['available', 'int'], ['critical', 'int'], ['stockState', 'code', { dict: 'stock' }]],
        stockRows.sort((a, b) => (a[8] === 'OK') - (b[8] === 'OK') || String(a[0]).localeCompare(String(b[0]))), { basis: 'NOW' }),
      table('movements', [['code', 'text'], ['product', 'text'], ['unit', 'text'], ['inReceipt', 'int'], ['receiptFix', 'int'], ['inManual', 'int'], ['out', 'int'], ['returns', 'int'], ['count', 'int'], ['net', 'int']], moveRows,
        { totals: moveTotals, basis: 'MOVEMENT_CREATED' }),
      table('supplierOrders', [['supplierOrderNo', 'text'], ['supplier', 'text'], ['orderDate', 'day'], ['status', 'code', { dict: 'supplierStatus' }], ['code', 'text'], ['color', 'text'], ['unit', 'text'], ['ordered', 'int'], ['received', 'int'], ['remaining', 'int']], soRows, { basis: 'SUPPLIER_FINALIZED' }),
      table('receipts', [['receivedOn', 'day'], ['entry', 'code', { dict: 'receiptEntry' }], ['supplierOrderNo', 'text'], ['supplier', 'text'], ['code', 'text'], ['color', 'text'], ['lengthM', 'dec3'], ['unit', 'text'], ['qty', 'int']], recRows,
        { totals: unitSum(recRows, 7, 8).map(([u, q]) => ['', null, '', '', '', '', null, u, q]), basis: 'RECEIVED_ON' }),
    ],
    notes: ['UNITS_SEPARATE', 'STOCK_NOW', 'MOVES_KIND', 'RECEIPT_CORRECTION', 'RAL_IN_CODE', ...(f.customerId || f.customer ? ['CUSTOMER_PROFILE_ONLY'] : [])],
  };
}

// ================================================================ D. YÜKLEME RAPORU
async function loadingReport(tx, f, ctx) {
  const want = matches(f.product);
  const range = dateRange(f);
  const glassOn = f.orderType !== 'PROFILE';
  const profileOn = f.orderType !== 'GLASS';
  const custWhere = ctx.customer ? { customerId: ctx.customer.id } : {};
  // 1) Onaylı günler: geçerli kalemler (düzeltmeler uygulanmış)
  const confirmations = glassOn ? await tx.loadingConfirmation.findMany({ where: { shipDay: range }, select: { id: true, shipDay: true } }) : [];
  const confirmedDays = new Set(confirmations.map((c) => c.shipDay.toISOString().slice(0, 10)));
  const items = confirmations.length ? await take(tx.loadingConfirmationItem.findMany({
    where: { confirmationId: { in: confirmations.map((c) => c.id) }, ...custWhere, order: { ...ACTIVE_ORDER, ...(f.status ? { status: f.status } : {}) } },
    select: {
      confirmationId: true, offerLineId: true, replanId: true, revision: true, status: true, quantity: true, m2: true, kind: true, unit: true, description: true, descriptionRo: true, free: true,
      orderId: true, confirmation: { select: { shipDay: true } }, order: { select: { orderNo: true, customer: { select: { id: true, name: true } } } },
    },
    take: REPORT_LIMITS.items + 1,
  }), REPORT_LIMITS.items) : [];
  const eff = effectiveItems(items).filter((i) => isGlass(i) && want(i.description, i.descriptionRo));
  /** @type {Map<string, any>} gün + sipariş */
  const rows = new Map();
  const row = (day, state, orderNo, customer, note = null) => {
    const k = `${day}|${orderNo}|${state}`;
    const r = rows.get(k) ?? { day, state, orderNo, customer, com: [0, 0], free: [0, 0], notLoaded: [0, 0], note };
    rows.set(k, r);
    return r;
  };
  for (const i of eff) {
    const r = row(i.confirmation.shipDay.toISOString().slice(0, 10), 'ACTUAL', i.order.orderNo, i.order.customer.name);
    const q = Math.max(0, i.quantity);
    if (i.status === 'LOADED') { const b = i.free ? r.free : r.com; b[0] += q; b[1] += milli(i.m2); } else { r.notLoaded[0] += q; r.notLoaded[1] += milli(i.m2); }
  }
  // 2) Planlanan: onaysız günlere planlı ve hiç onay kalemi olmayan siparişler (onaylı güne planlı ama onayda olmayan → not)
  let outside = 0;
  if (glassOn) {
    const planned = await take(tx.order.findMany({
      where: {
        ...ACTIVE_ORDER, ...(f.status ? { status: f.status } : {}), orderTypeCode: 'GLASS_ORDER', onHold: false, loadedItems: { none: {} }, ...custWhere,
        OR: [{ actualShipDate: { gte: new Date(`${shiftDay(f.from, -1)}T00:00:00Z`), lt: new Date(`${shiftDay(f.to, 2)}T00:00:00Z`) } },
          { actualShipDate: null, estimatedShipDate: { gte: new Date(`${shiftDay(f.from, -1)}T00:00:00Z`), lt: new Date(`${shiftDay(f.to, 2)}T00:00:00Z`) } }],
      },
      select: { orderNo: true, actualShipDate: true, estimatedShipDate: true, customer: { select: { name: true } }, offers: ORDER_SELECT.offers },
      take: REPORT_LIMITS.orders + 1,
    }), REPORT_LIMITS.orders);
    for (const o of planned) {
      const day = dayKey(o.actualShipDate ?? o.estimatedShipDate);
      if (day < f.from || day > f.to) continue;
      if (confirmedDays.has(day)) { outside++; continue; }
      const offer = loadedOffer(o.offers, false);
      const lines = (offer?.lines ?? []).filter((l) => isGlass(l) && want(l.description, l.descriptionRo));
      if (f.product && !lines.length) continue;
      // Teklif tablosu yok (ya da camsız): miktar bilinmez — satır "miktar bilinmiyor" notuyla, sıfır sayılmaz
      const r = row(day, 'PLANNED', o.orderNo, o.customer.name, offer?.lines.some(isGlass) ? null : 'NO_OFFER');
      for (const l of lines) { const b = l.free ? r.free : r.com; b[0] += qtyOf(l); b[1] += milli(lineM2(l)); }
    }
    // Etkin aktarımlar (yüklenmeyen camın ileri güne planlanan kalanı): kayıtlı adet ve m²
    const replans = await take(tx.loadingReplan.findMany({
      where: { status: 'ACTIVE', shipDay: range, ...custWhere, order: { ...ACTIVE_ORDER, onHold: false, ...(f.status ? { status: f.status } : {}) } },
      select: { quantity: true, m2: true, shipDay: true, fromDay: true, order: { select: { orderNo: true, customer: { select: { name: true } } } }, sourceItem: { select: { free: true, description: true, descriptionRo: true } } },
      take: REPORT_LIMITS.items + 1,
    }), REPORT_LIMITS.items);
    for (const rp of replans) {
      if (!want(rp.sourceItem.description, rp.sourceItem.descriptionRo)) continue;
      const day = rp.shipDay.toISOString().slice(0, 10);
      if (confirmedDays.has(day)) continue;
      const r = row(day, 'PLANNED', rp.order.orderNo, rp.order.customer.name, `REPLAN:${rp.fromDay.toISOString().slice(0, 10)}`);
      const b = rp.sourceItem.free ? r.free : r.com;
      b[0] += rp.quantity; b[1] += milli(rp.m2);
    }
  }
  let list = [...rows.values()];
  if (f.loading === 'LOADED') list = list.filter((r) => r.state === 'ACTUAL');
  else if (f.loading === 'NOT_LOADED') list = list.filter((r) => r.state === 'PLANNED');
  else if (f.loading === 'PARTIAL') list = list.filter((r) => r.state === 'ACTUAL' && r.notLoaded[0] > 0);
  list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.customer.localeCompare(b.customer) || a.orderNo.localeCompare(b.orderNo)));
  // 3) Profil teslimleri: fiilen teslim (deliveredAt) ve planlı alım günü (teslim edilmemiş)
  const prof = [];
  if (profileOn && !(f.loading === 'PARTIAL')) {
    const po = await take(tx.order.findMany({
      where: {
        ...ACTIVE_ORDER, ...(f.status ? { status: f.status } : {}), orderTypeCode: 'PROFILE_ORDER', ...(ctx.customer ? { customerId: ctx.customer.id } : {}),
        OR: [{ profile: { deliveredAt: instantRange(f, ctx.timeZone) } }, { profile: { deliveredAt: null, pickupDate: range, stage: { in: ['ONAYLANDI', 'PROFORMA', 'DEPODA'] } } }],
      },
      select: { orderNo: true, customer: { select: { name: true } }, profile: { select: { deliveredAt: true, pickupDate: true, stage: true } }, profileItems: { orderBy: { sortOrder: 'asc' }, select: { code: true, nameTr: true, nameRo: true, unitCode: true, qty: true } } },
      take: REPORT_LIMITS.orders + 1,
    }), REPORT_LIMITS.orders);
    for (const o of po) {
      const delivered = o.profile?.deliveredAt != null;
      if (f.loading === 'LOADED' && !delivered) continue;
      if (f.loading === 'NOT_LOADED' && delivered) continue;
      const its = o.profileItems.filter((i) => want(i.code, i.nameTr, i.nameRo));
      if (f.product && !its.length) continue;
      const day = delivered ? localDay(o.profile.deliveredAt, ctx.timeZone) : new Date(o.profile.pickupDate).toISOString().slice(0, 10);
      const units = [...its.reduce((m, i) => m.set(i.unitCode, (m.get(i.unitCode) ?? 0) + i.qty), new Map()).entries()].map(([u, q]) => `${q} ${u}`).join(', ');
      prof.push([day, delivered ? 'ACTUAL' : 'PLANNED', o.orderNo, o.customer.name, its.length, units]);
    }
    prof.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : String(a[2]).localeCompare(String(b[2]))));
  }
  // Gün ve firma özetleri
  const days = new Map();
  const custs = new Map();
  const T = { actCom: [0, 0], actFree: [0, 0], plan: [0, 0], notLoaded: [0, 0] };
  for (const r of list) {
    const d = days.get(r.day) ?? { state: confirmedDays.has(r.day) ? 'ACTUAL' : 'PLANNED', firms: new Set(), orders: new Set(), pcs: 0, com: 0, free: 0, notLoaded: 0 };
    d.firms.add(r.customer); d.orders.add(r.orderNo);
    d.pcs += r.com[0] + r.free[0]; d.com += r.com[1]; d.free += r.free[1]; d.notLoaded += r.notLoaded[1];
    days.set(r.day, d);
    const c = custs.get(r.customer) ?? { orders: new Set(), actCom: 0, actFree: 0, plan: 0, notLoaded: 0, pcs: 0 };
    c.orders.add(r.orderNo);
    if (r.state === 'ACTUAL') { c.actCom += r.com[1]; c.actFree += r.free[1]; c.pcs += r.com[0] + r.free[0]; T.actCom[0] += r.com[0]; T.actCom[1] += r.com[1]; T.actFree[0] += r.free[0]; T.actFree[1] += r.free[1]; }
    else { c.plan += r.com[1] + r.free[1]; T.plan[0] += r.com[0] + r.free[0]; T.plan[1] += r.com[1] + r.free[1]; }
    c.notLoaded += r.notLoaded[1]; T.notLoaded[0] += r.notLoaded[0]; T.notLoaded[1] += r.notLoaded[1];
    custs.set(r.customer, c);
  }
  const custRows = [...custs.entries()].sort((a, b) => (b[1].actCom + b[1].actFree) - (a[1].actCom + a[1].actFree) || a[0].localeCompare(b[0]))
    .map(([n, c]) => [n, c.orders.size, c.pcs, fromMilli(c.actCom), fromMilli(c.actFree), fromMilli(c.plan), fromMilli(c.notLoaded)]);
  return {
    basis: 'LOADING_DAY',
    cards: [
      { key: 'confirmedDays', value: [...days.values()].filter((d) => d.state === 'ACTUAL').length, type: 'int' },
      { key: 'loadedM2', value: fromMilli(T.actCom[1]), type: 'm2' }, { key: 'loadedFreeM2', value: fromMilli(T.actFree[1]), type: 'm2' },
      { key: 'loadedPcs', value: T.actCom[0] + T.actFree[0], type: 'int' },
      { key: 'plannedM2', value: fromMilli(T.plan[1]), type: 'm2' }, { key: 'notLoadedM2', value: fromMilli(T.notLoaded[1]), type: 'm2' },
      { key: 'profileDelivered', value: prof.filter((p) => p[1] === 'ACTUAL').length, type: 'int' }, { key: 'profilePlanned', value: prof.filter((p) => p[1] === 'PLANNED').length, type: 'int' },
    ],
    tables: [
      table('days', [['day', 'day'], ['dayState', 'code', { dict: 'dayState' }], ['customers', 'int'], ['orders', 'int'], ['pcs', 'int'], ['commercialM2', 'm2'], ['freeM2', 'm2'], ['notLoadedM2', 'm2']],
        [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, d]) => [k, d.state, d.firms.size, d.orders.size, d.pcs, fromMilli(d.com), fromMilli(d.free), fromMilli(d.notLoaded)]),
        { chart: { label: 0, value: 5 } }),
      table('byCustomerLoading', [['customer', 'text'], ['orders', 'int'], ['loadedPcs', 'int'], ['loadedM2', 'm2'], ['loadedFreeM2', 'm2'], ['plannedM2', 'm2'], ['notLoadedM2', 'm2']], custRows,
        { totals: [['', null, T.actCom[0] + T.actFree[0], fromMilli(T.actCom[1]), fromMilli(T.actFree[1]), fromMilli(T.plan[1]), fromMilli(T.notLoaded[1])]], chart: { label: 0, value: 3 } }),
      table('loadingOrders', [['day', 'day'], ['dayState', 'code', { dict: 'dayState' }], ['orderNo', 'text'], ['customer', 'text'], ['commercialPcs', 'int'], ['commercialM2', 'm2'], ['freePcs', 'int'], ['freeM2', 'm2'], ['notLoadedPcs', 'int'], ['notLoadedM2', 'm2'], ['note', 'note']],
        list.map((r) => (r.note === 'NO_OFFER'
          ? [r.day, r.state, r.orderNo, r.customer, null, null, null, null, null, null, r.note]
          : [r.day, r.state, r.orderNo, r.customer, r.com[0], fromMilli(r.com[1]), r.free[0], fromMilli(r.free[1]), r.notLoaded[0], fromMilli(r.notLoaded[1]), r.note]))),
      table('profileDeliveries', [['day', 'day'], ['dayState', 'code', { dict: 'dayState' }], ['orderNo', 'text'], ['customer', 'text'], ['lines', 'int'], ['qtyByUnit', 'text']], prof),
    ],
    notes: ['LOADED_CONFIRMED_ONLY', 'FREE_SEPARATE', 'M2_RULE', ...(list.some((r) => r.note === 'NO_OFFER') ? ['NO_OFFER_TABLE'] : []), ...(outside ? ['OUTSIDE_CONFIRMATION'] : [])],
    counts: { outside },
  };
}

// ================================================================ E. FİNANS RAPORU
async function financeReport(tx, f, ctx) {
  const range = dateRange(f);
  const inst = instantRange(f, ctx.timeZone);
  const glassOn = f.orderType !== 'PROFILE';
  const profileOn = f.orderType !== 'GLASS';
  const statusWhere = f.status ? { status: f.status } : {};
  /** @type {any[]} */
  const lines = []; // sipariş satırları: { day, orderNo, customer, currency, sale, cost, noCost, confirmed }
  if (glassOn) {
    // Onaylı yüklemeler: geçerli LOADED kalemleri (onay anındaki satış / maliyet kopyası)
    const confirmations = await tx.loadingConfirmation.findMany({ where: { shipDay: range }, select: { id: true, shipDay: true } });
    const items = confirmations.length ? await take(tx.loadingConfirmationItem.findMany({
      where: { confirmationId: { in: confirmations.map((c) => c.id) }, ...(ctx.customer ? { customerId: ctx.customer.id } : {}), order: { ...ACTIVE_ORDER, ...statusWhere } },
      orderBy: [{ orderId: 'asc' }, { sortOrder: 'asc' }],
      select: {
        id: true, confirmationId: true, offerLineId: true, replanId: true, revision: true, status: true, quantity: true, m2: true, kind: true, unit: true, description: true, descriptionRo: true,
        enMm: true, boyMm: true, free: true, sortOrder: true, unitCost: true, unitSale: true, weightKgM2: true, pieceBase: true, pieceM2: true, currency: true, orderId: true,
        confirmation: { select: { shipDay: true } }, order: { select: { orderNo: true, customer: { select: { id: true, name: true } } } },
      },
      take: REPORT_LIMITS.items + 1,
    }), REPORT_LIMITS.items) : [];
    const groups = new Map();
    for (const it of effectiveItems(items)) {
      const k = `${it.confirmationId}|${it.orderId}`;
      const g = groups.get(k) ?? { orderId: it.orderId, orderNo: it.order.orderNo, customer: it.order.customer, day: it.confirmation.shipDay.toISOString().slice(0, 10), items: [] };
      g.items.push(it);
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      const l = confirmedLine(g);
      if (l) lines.push({ ...l, customer: g.customer });
    }
    // Planlanan (onaysız): hiç onay kalemi olmayan, gönderilmiş teklifli siparişler — Muhasebe ekranının kuralı (orderLine)
    const planned = await take(tx.order.findMany({
      where: {
        ...ACTIVE_ORDER, ...statusWhere, orderTypeCode: 'GLASS_ORDER', onHold: false, loadedItems: { none: {} }, ...(ctx.customer ? { customerId: ctx.customer.id } : {}),
        OR: [{ actualShipDate: { gte: new Date(`${shiftDay(f.from, -1)}T00:00:00Z`), lt: new Date(`${shiftDay(f.to, 2)}T00:00:00Z`) } },
          { actualShipDate: null, estimatedShipDate: { gte: new Date(`${shiftDay(f.from, -1)}T00:00:00Z`), lt: new Date(`${shiftDay(f.to, 2)}T00:00:00Z`) } }],
      },
      select: { id: true, orderNo: true, actualShipDate: true, estimatedShipDate: true, customer: { select: { id: true, name: true } }, items: { select: { camAdedi: true } }, offers: ORDER_SELECT.offers },
      take: REPORT_LIMITS.orders + 1,
    }), REPORT_LIMITS.orders);
    const confirmedDays = new Set(confirmations.map((c) => c.shipDay.toISOString().slice(0, 10)));
    for (const o of planned) {
      const l = orderLine(o);
      if (!l || l.day < f.from || l.day > f.to || confirmedDays.has(l.day)) continue;
      lines.push({ ...l, customer: o.customer });
    }
  }
  // Profil satışı: müşterinin onayladığı teklif (onay anı aralıkta) — maliyet sipariş anında saklanmadığı için kâr yok
  const profileSales = [];
  if (profileOn) {
    const po = await take(tx.profileOrder.findMany({
      where: { approvedAt: inst, approvedOfferId: { not: null }, order: { ...ACTIVE_ORDER, ...statusWhere, ...(ctx.customer ? { customerId: ctx.customer.id } : {}) } },
      select: { approvedOfferId: true, approvedAt: true, order: { select: { orderNo: true, customer: { select: { id: true, name: true } } } } },
      take: REPORT_LIMITS.orders + 1,
    }), REPORT_LIMITS.orders);
    const offers = po.length ? await tx.offer.findMany({ where: { id: { in: po.map((p) => p.approvedOfferId) } }, select: { id: true, currency: true, offerAmount: true } }) : [];
    const byId = new Map(offers.map((o) => [o.id, o]));
    for (const p of po) {
      const of = byId.get(p.approvedOfferId);
      profileSales.push({ day: localDay(p.approvedAt, ctx.timeZone), orderNo: p.order.orderNo, customer: p.order.customer, currency: of?.currency ?? null, sale: of?.offerAmount == null ? null : Number(of.offerAmount) });
    }
  }
  // FGO belgeleri (kesim anı aralıkta): türe göre ayrı — proforma bilgi içindir, faturalanan = avans + nihai fatura
  const docWhere = {
    issuedAt: inst,
    ...(ctx.customer ? { OR: [{ order: { customerId: ctx.customer.id } }, { batch: { customerId: ctx.customer.id } }] } : {}),
  };
  const docs = await take(tx.fgoDocument.findMany({
    where: docWhere,
    select: { id: true, kind: true, currency: true, total: true, issuedAt: true, orderId: true, batchId: true, order: { select: { orderTypeCode: true, removedAt: true, status: true, customer: { select: { id: true, name: true } } } }, batch: { select: { customer: { select: { id: true, name: true } } } } },
    take: REPORT_LIMITS.docs + 1,
  }), REPORT_LIMITS.docs);
  const docKeep = (d) => (d.order ? typeCodes(f.orderType).includes(d.order.orderTypeCode) && d.order.removedAt == null : glassOn);
  const docList = docs.filter(docKeep);
  // Elle kaydedilen tahsilat (ödeme günü aralıkta; iptal edilen kayıt sayılmaz)
  const payments = await take(tx.manualPayment.findMany({
    where: { paidOn: range, voidedAt: null, ...(ctx.customer ? { customerId: ctx.customer.id } : {}), order: { removedAt: null, orderTypeCode: { in: typeCodes(f.orderType) } } },
    select: { paidOn: true, amount: true, currency: true, customer: { select: { id: true, name: true } } },
    take: REPORT_LIMITS.payments + 1,
  }), REPORT_LIMITS.payments);
  // Güncel açık alacak (aralıktan bağımsız): bütün FGO belgeleri, çift sayımsız kural
  const allDocs = await take(tx.fgoDocument.findMany({
    where: ctx.customer ? { OR: [{ order: { customerId: ctx.customer.id } }, { batch: { customerId: ctx.customer.id } }] } : {},
    select: { id: true, orderId: true, batchId: true, kind: true, currency: true, total: true, paid: true, order: { select: { orderTypeCode: true } }, batch: { select: { parentId: true, chainOrderId: true, lines: { select: { ronGross: true, refBatchId: true, refDocId: true } } } } },
    take: REPORT_LIMITS.docs + 1,
  }), REPORT_LIMITS.docs);
  const open = receivables(allDocs.filter((d) => (d.order ? typeCodes(f.orderType).includes(d.order.orderTypeCode) : glassOn))).sums;

  // ---- toplamlar (para birimi başına, kuruşla)
  const cur = new Map();
  const C = (c) => {
    if (!cur.has(c)) cur.set(c, { sale: 0, cost: 0, profitOk: 0, missingOrders: 0, missingSale: 0, transport: 0, profileSale: 0, profileMissing: 0, proforma: 0, advance: 0, invoice: 0, docMissing: 0, collected: 0 });
    return cur.get(c);
  };
  const cust = new Map();
  const K = (c, currency) => {
    const k = `${c.id}|${currency}`;
    if (!cust.has(k)) cust.set(k, { name: c.name, currency, sale: 0, cost: 0, profit: 0, profitMissing: false, profileSale: 0, invoiced: 0, collected: 0 });
    return cust.get(k);
  };
  const months = new Map();
  const M = (m, currency) => {
    const k = `${m}|${currency}`;
    if (!months.has(k)) months.set(k, { month: m, currency, sale: 0, cost: 0, profit: 0, profitMissing: false, profileSale: 0, invoiced: 0, collected: 0 });
    return months.get(k);
  };
  const orderRows = [];
  for (const l of lines) {
    const s = cents(l.sale); const c = cents(l.cost); const missing = l.noCost > 0;
    const t = C(l.currency);
    t.sale += s; t.cost += c;
    if (missing) { t.missingOrders++; t.missingSale += s; } else t.profitOk += s - c;
    const k = K(l.customer, l.currency); k.sale += s; k.cost += c; if (missing) k.profitMissing = true; else k.profit += s - c;
    const m = M(monthOf(l.day), l.currency); m.sale += s; m.cost += c; if (missing) m.profitMissing = true; else m.profit += s - c;
    orderRows.push([l.day, l.confirmed ? 'ACTUAL' : 'PLANNED', l.orderNo, l.customer.name, l.currency, fromCents(s), fromCents(c), missing ? null : fromCents(s - c), missing ? 'MISSING_COST' : null]);
  }
  for (const p of profileSales) {
    if (p.sale == null || !p.currency) { C(p.currency ?? 'EUR').profileMissing++; continue; }
    const v = cents(p.sale);
    C(p.currency).profileSale += v; K(p.customer, p.currency).profileSale += v; M(monthOf(p.day), p.currency).profileSale += v;
    orderRows.push([p.day, 'PROFILE', p.orderNo, p.customer.name, p.currency, fromCents(v), null, null, 'PROFILE_NO_COST']);
  }
  // Nakliye (yükleme gününe bağlı; firmaya dağıtılmaz — firma filtresinde nakliye gösterilmez)
  if (glassOn && !ctx.customer) {
    const costs = await tx.loadingCost.findMany({ where: { shipDay: range }, select: { amount: true, currency: true } });
    for (const x of costs) C(x.currency).transport += cents(x.amount);
  }
  for (const d of docList) {
    const c = C(d.currency);
    if (d.total == null) { c.docMissing++; continue; }
    const v = cents(d.total);
    if (d.kind === 'PROFORMA') c.proforma += v;
    else {
      c[d.kind === 'ADVANCE' ? 'advance' : 'invoice'] += v;
      const who = d.order?.customer ?? d.batch?.customer;
      if (who) K(who, d.currency).invoiced += v;
      M(monthOf(localDay(d.issuedAt, ctx.timeZone)), d.currency).invoiced += v;
    }
  }
  for (const p of payments) {
    const v = cents(p.amount);
    C(p.currency).collected += v; K(p.customer, p.currency).collected += v;
    M(monthOf(p.paidOn.toISOString().slice(0, 10)), p.currency).collected += v;
  }
  const currencies = [...cur.keys()].sort();
  const summary = currencies.map((c) => {
    const t = cur.get(c);
    const profit = t.missingOrders ? null : t.profitOk - t.transport;
    return [c, fromCents(t.sale), fromCents(t.cost), customerFilterTransport(ctx, t.transport), profit == null ? null : fromCents(profit), fromCents(t.profitOk), t.missingOrders,
      fromCents(t.profileSale), fromCents(t.proforma), fromCents(t.advance), fromCents(t.invoice), fromCents(t.advance + t.invoice), fromCents(t.collected),
      open[c] ? open[c].total : 0, open[c] ? open[c].paid : 0, open[c] ? open[c].rest : 0];
  });
  const cards = [];
  for (const c of currencies) {
    const t = cur.get(c);
    if (t.sale || t.profileSale) cards.push({ key: 'sales', value: fromCents(t.sale + t.profileSale), type: 'money', unit: c });
    if (t.sale) cards.push({ key: 'profit', value: t.missingOrders ? null : fromCents(t.profitOk - t.transport), type: 'money', unit: c, ...(t.missingOrders ? { note: 'MISSING_COST' } : {}) });
    if (t.advance || t.invoice) cards.push({ key: 'invoiced', value: fromCents(t.advance + t.invoice), type: 'money', unit: c });
    if (t.collected) cards.push({ key: 'collected', value: fromCents(t.collected), type: 'money', unit: c });
  }
  for (const [c, o] of Object.entries(open)) if (o.rest) cards.push({ key: 'openReceivable', value: o.rest, type: 'money', unit: c });
  const custRows = [...cust.values()].sort((a, b) => a.currency.localeCompare(b.currency) || (b.sale + b.profileSale) - (a.sale + a.profileSale) || a.name.localeCompare(b.name))
    .map((k) => [k.name, k.currency, fromCents(k.sale), fromCents(k.cost), k.profitMissing ? null : fromCents(k.profit), fromCents(k.profileSale), fromCents(k.sale + k.profileSale), fromCents(k.invoiced), fromCents(k.collected)]);
  const monthRows = [...months.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.currency.localeCompare(b.currency)))
    .map((m) => [m.month, m.currency, fromCents(m.sale), fromCents(m.cost), m.profitMissing ? null : fromCents(m.profit), fromCents(m.profileSale), fromCents(m.invoiced), fromCents(m.collected)]);
  orderRows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : String(a[2]).localeCompare(String(b[2]))));
  const anyMissing = currencies.some((c) => cur.get(c).missingOrders > 0);
  return {
    basis: 'FINANCE',
    cards,
    tables: [
      table('financeSummary', [['currency', 'currency'], ['glassSale', 'money'], ['glassCost', 'money'], ['transport', 'money'], ['profit', 'money'], ['profitComplete', 'money'], ['missingCostOrders', 'int'],
        ['profileSale', 'money'], ['proforma', 'money'], ['advance', 'money'], ['finalInvoice', 'money'], ['invoiced', 'money'], ['collected', 'money'], ['openTotal', 'money'], ['openPaid', 'money'], ['openRest', 'money']], summary),
      table('financeByCustomer', [['customer', 'text'], ['currency', 'currency'], ['glassSale', 'money'], ['glassCost', 'money'], ['grossProfit', 'money'], ['profileSale', 'money'], ['totalSale', 'money'], ['invoiced', 'money'], ['collected', 'money']], custRows,
        { chart: { label: 0, value: 6 } }),
      table('financeByMonth', [['month', 'month'], ['currency', 'currency'], ['glassSale', 'money'], ['glassCost', 'money'], ['grossProfit', 'money'], ['profileSale', 'money'], ['invoiced', 'money'], ['collected', 'money']], monthRows,
        { chart: { label: 0, value: 2 } }),
      table('financeOrders', [['day', 'day'], ['dayState', 'code', { dict: 'dayState' }], ['orderNo', 'text'], ['customer', 'text'], ['currency', 'currency'], ['sale', 'money'], ['cost', 'money'], ['grossProfit', 'money'], ['note', 'note']], orderRows),
    ],
    notes: ['SALES_BASIS', 'PROFIT_RULE', 'INVOICE_RULE', 'COLLECTION_RULE', 'OPEN_NOW', 'CURRENCY_SEPARATE', ...(anyMissing ? ['MISSING_COST'] : []), ...(profileOn ? ['PROFILE_NO_COST'] : []),
      ...(ctx.customer ? ['TRANSPORT_HIDDEN'] : []), ...(f.product || f.loading !== 'ALL' ? ['FILTER_IGNORED'] : []),
      // Durum filtresi satış / yükleme bölümüne uygulanır; FGO belgeleri ve tahsilatlar durumdan bağımsızdır (karar 288 — D19)
      ...(f.status ? ['STATUS_PARTIAL'] : []),
      ...(currencies.some((c) => cur.get(c).docMissing) ? ['DOC_TOTAL_MISSING'] : [])],
  };
}
/** Firma filtresinde nakliye firmaya dağıtılmaz: değer yok (null) */
const customerFilterTransport = (ctx, v) => (ctx.customer ? null : fromCents(v));

const BUILDERS = { orders: ordersReport, glass: glassReport, profile: profileReport, loading: loadingReport, finance: financeReport };

/**
 * Raporu üretir (salt okunur).
 * @param {any} db  Prisma istemcisi ya da salt okunur işlem (Telegram: readOnly)
 * @param {Record<string, unknown>} input  filtreler (parseReportFilters'ın girdisi)
 * @param {{ actor: any, now?: Date, timeZone: string }} ctx
 * @returns {Promise<{ ok: true, report: any } | { ok: false, code: string, errors?: string[], candidates?: string[] }>}
 */
export async function runReport(db, input, { actor, now = new Date(), timeZone }) {
  if (!allowed(actor)) return { ok: false, code: 'FORBIDDEN' };
  const f = parseReportFilters(input, { now, timeZone });
  if (f.errors.length) return { ok: false, code: 'INVALID_FILTERS', errors: f.errors };
  const who = await resolveCustomer(db, f);
  if (who.error) return { ok: false, code: who.error, ...(who.candidates ? { candidates: who.candidates } : {}) };
  try {
    const body = await BUILDERS[f.kind](db, f, { timeZone, now, customer: who.customer });
    return {
      ok: true,
      report: {
        kind: f.kind, range: { from: f.from, to: f.to }, period: f.period, generatedAt: now.toISOString(), today: localDay(now, timeZone),
        filters: { customer: who.customer, orderType: f.orderType, status: f.status, product: f.product, loading: f.loading, period: f.period, month: f.month, year: f.year },
        ...body,
      },
    };
  } catch (e) {
    if (e instanceof ReportError) return { ok: false, code: e.code };
    throw e;
  }
}

/** Panelin firma seçimi için firmalar (yalnızca ad; yetki sayfada denetlenir) */
export async function reportCustomers(db, actor) {
  if (!allowed(actor)) return [];
  return db.customer.findMany({ where: { type: 'CUSTOMER' }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 2000 });
}
