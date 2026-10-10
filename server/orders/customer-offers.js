// Müşteri ana sayfası → "Tekliflerim" (karar 164): seçilen tarih aralığında FİRMANIN kendi tekliflerinin listesi ve PDF
// dökümü. Saf kural (veritabanı / ağ yok); veri lib/customer-offers.ts'te yüklenir ve role göre temizlenir (müşteri
// fiyatı — sanitizeRows), PDF server/pdf/offer-summary.js'tedir.
//   - Kapsam: yalnızca CAM siparişleri (satırlar, m², müşteri teklif tutarı); iptal edilmiş sipariş dökümde yoktur.
//   - Teklif = siparişin müşteriye gönderilmiş SON sürümü (yeni sürüm eskisinin yerini alır; aynı sipariş iki kez sayılmaz).
//   - Paket B (karar 226): döküm YÜKLEME GÜNÜNE göre gruplanır (loadingParts, customerOfferReport); tarih aralığı
//     teklifin GÖNDERİLDİĞİ güne uygulanır (eski davranış — ürün sahibi, 3.65.1); kısmi yüklenen sipariş bölümlerine
//     ayrılır, tutarı iki kez sayılmaz.
//   - Satırlar ve tutarlar teklif PDF'iyle AYNI hesaptan (offerExportData → offerLineTotals); fiyat erişimcisi çağırandan
//     gelir ve yalnızca müşteri fiyatıdır — fabrika / satış fiyatı hiçbir zaman dökümde yoktur.
//   - Toplamlar para birimi başına ayrı (farklı para birimleri toplanmaz): sipariş sayısı, toplam m², cam adedi, tutar.
import { offerExportData } from './offer-export.js';
import { exportFileName } from '../files/export-name.js';
import { offerTotals, parseDateOnly } from './rules.js';
import { effectiveItems } from '../loading/confirmation.js';
import { localDay } from '../profile/dates.js';

/** En uzun aralık (gün) — yıllık döküm sığar */
export const OFFER_REPORT_MAX_DAYS = 400;
/** Bir dökümdeki en çok teklif (sayfa ve PDF); fazlasında aralık daraltılmalıdır */
export const OFFER_REPORT_MAX = 300;

const DAY_MS = 86_400_000;
const dayKey = (d) => d.toISOString().slice(0, 10);

/**
 * Formdaki tarih aralığı. Boş bırakılan başlangıç → bugünün ayının ilk günü; boş bitiş → bugün.
 * @param {{ bas?: unknown, bit?: unknown }} q   "YYYY-MM-DD"
 * @param {string} today  bugünün yerel günü ("YYYY-MM-DD")
 * @returns {{ ok: true, from: string, to: string } | { ok: false, code: 'BAD_DATE' | 'ORDER' | 'TOO_LONG', from: string, to: string }}
 */
export function offerRange(q, today) {
  const raw = (v) => (typeof v === 'string' ? v.trim() : '');
  const from = raw(q?.bas) || `${today.slice(0, 7)}-01`;
  const to = raw(q?.bit) || today;
  const a = parseDateOnly(from), b = parseDateOnly(to);
  if (!a || !b) return { ok: false, code: 'BAD_DATE', from, to };
  if (a > b) return { ok: false, code: 'ORDER', from, to };
  if ((b.getTime() - a.getTime()) / DAY_MS + 1 > OFFER_REPORT_MAX_DAYS) return { ok: false, code: 'TOO_LONG', from, to };
  return { ok: true, from, to };
}

/**
 * Veritabanı sorgusunun kaba zaman penceresi (UTC): yerel gün sınırları saat dilimine göre kaydığı için bir gün geniş
 * tutulur; kesin süzme customerOfferReport'ta yerel güne göre yapılır.
 * @param {{ from: string, to: string }} r
 * @returns {{ gte: Date, lt: Date }}
 */
export function offerWindow({ from, to }) {
  const a = parseDateOnly(from), b = parseDateOnly(to);
  return { gte: new Date(Date.parse(`${dayKey(a)}T00:00:00.000Z`) - DAY_MS), lt: new Date(Date.parse(`${dayKey(b)}T00:00:00.000Z`) + 2 * DAY_MS) };
}

const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100);
const dayOfDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
/** Yükleme günü sırası: tarihli günler artan, tarihi belli olmayan bölüm en sonda */
const dayCmp = (a, b) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : 1);

/**
 * Siparişin müşteriye gönderilmiş son teklifinin YÜKLEME GÜNLERİNE dağılımı (Paket B — karar 226). Tutar uydurulmaz: her
 * teklif satırının adedi, kayıtlı verideki yükleme bölümlerine ayrılır ve tutar mevcut satır kuralıyla (offerLineTotals,
 * ayrılmış cam kuralı — karar 114: parça m² / tutarı = iki yuvarlanmış ara toplamın farkı) hesaplanır; bölümlerin toplamı
 * her zaman satırın (ve siparişin) ticari toplamına EŞİTTİR — bir sipariş iki gruba tam tutarla girmez.
 *   - Onaylı yüklemesi olmayan sipariş: tek bölüm, planlanan gün (actualShipDate ?? estimatedShipDate; yoksa tarihsiz).
 *   - Onaylı yüklemesi olan sipariş: satırın GEÇERLİ (effectiveItems — düzeltmeler uygulanmış) LOADED adetleri onay
 *     gününe; kalan adet etkin (ACTIVE) aktarımların günlerine (aktarılan adet kadar); hâlâ kalan → tarihsiz bölüm
 *     ("henüz planlanmadı"). İşlem satırları (CNC, delik, sandık) onayda tam adetle yüklendiği için ilk yüklemededir.
 *   - Onay kalemleri teklifin hiçbir satırına bağlanamıyorsa (beklenmez: onaylı yüklemeden sonra fiyat değişmez — karar 171)
 *     sipariş bölünmez, ilk onay gününde tek bölüm olarak gösterilir.
 * @param {{ actualShipDate?: Date | string | null, estimatedShipDate?: Date | string | null,
 *   loadedItems?: { confirmationId: string, offerLineId?: string | null, replanId?: string | null, revision?: number | null, status: string, quantity: number, confirmation: { shipDay: Date | string } }[],
 *   replans?: { status: string, quantity: number, shipDay: Date | string, sourceItem: { offerLineId?: string | null } }[] }} order
 * @param {{ lines: any[] }} offer
 * @returns {{ day: string | null, lines: any[] }[]}  gün sırasıyla; satırlar teklif sırasıyla, yalnızca adedi > 0 olanlar
 */
export function loadingParts(order, offer) {
  // Satırın teklifteki sıra numarası (CNC / delik numarasızdır): bölümlerde de teklifteki numara gösterilir
  let no = 0;
  const lines = (offer.lines ?? []).map((l) => ({ ...l, lineNo: l.kind === 'CNC' || l.kind === 'DELIK' ? null : ++no }));
  const items = effectiveItems(order.loadedItems ?? []);
  const planned = dayOfDate(order.actualShipDate ?? order.estimatedShipDate);
  if (items.length === 0) return [{ day: planned, lines }];
  const loaded = new Map(); // satır → gün → adet
  for (const it of items) {
    if (it.status !== 'LOADED' || !it.offerLineId || !(it.quantity > 0)) continue;
    const day = dayOfDate(it.confirmation.shipDay);
    const m = loaded.get(it.offerLineId) ?? new Map();
    m.set(day, (m.get(day) ?? 0) + it.quantity);
    loaded.set(it.offerLineId, m);
  }
  const confirmedDays = [...new Set(items.map((it) => dayOfDate(it.confirmation.shipDay)))].sort();
  if (!lines.some((l) => loaded.has(l.id))) return [{ day: confirmedDays[0] ?? planned, lines }];
  const active = (order.replans ?? [])
    .filter((r) => r.status === 'ACTIVE' && r.quantity > 0)
    .map((r) => ({ lineId: r.sourceItem?.offerLineId ?? null, day: dayOfDate(r.shipDay), quantity: r.quantity }))
    .sort((a, b) => dayCmp(a.day, b.day));
  const parts = new Map(); // gün → satırlar
  const put = (day, line) => parts.set(day, [...(parts.get(day) ?? []), line]);
  for (const l of lines) {
    const qty = Math.max(0, Math.trunc(Number(l.adet) || 0));
    const alloc = [];
    let left = qty;
    for (const [day, q] of [...(loaded.get(l.id) ?? new Map()).entries()].sort((a, b) => dayCmp(a[0], b[0]))) {
      const take = Math.min(left, q);
      if (take > 0) { alloc.push([day, take]); left -= take; }
    }
    for (const r of active) {
      if (r.lineId !== l.id || left <= 0) continue;
      const take = Math.min(left, r.quantity);
      alloc.push([r.day, take]);
      left -= take;
    }
    if (left > 0) alloc.push([null, left]);
    if (alloc.length === 1) { put(alloc[0][0], l); continue; }
    // Satır bölünür: her bölüm kalemdeki sırasını taşır (pieceBase), m² ve tutar kalemin toplamından hesaplanır
    let base = Math.max(0, Math.trunc(Number(l.pieceBase) || 0));
    for (const [day, q] of alloc) {
      put(day, { ...l, adet: q, pieceBase: base });
      base += q;
    }
  }
  return [...parts.entries()].sort((a, b) => dayCmp(a[0], b[0])).map(([day, ls]) => ({ day, lines: ls }));
}

/**
 * @typedef {{ key: string, orderId: string, orderNo: string, title: string | null, day: string | null, offerDay: string,
 *   version: number, currency: string, partial: boolean, data: ReturnType<typeof offerExportData>, pieces: number }} ReportSection
 * @typedef {{ currency: string, count: number, m2: number, pieces: number, amount: number }} ReportTotal
 */

/** @param {Map<string, any>} map @param {ReportSection} s */
const addTotal = (map, s) => {
  const t = map.get(s.currency) ?? { currency: s.currency, orders: new Set(), m2c: 0, pieces: 0, ac: 0 };
  t.orders.add(s.orderId);
  t.m2c += cents(s.data.metraj);
  t.pieces += s.pieces;
  t.ac += cents(s.data.total);
  map.set(s.currency, t);
};
/** @param {Map<string, any>} map @returns {ReportTotal[]} */
const totalsOf = (map) => [...map.values()]
  .map((t) => ({ currency: t.currency, count: t.orders.size, m2: t.m2c / 100, pieces: t.pieces, amount: t.ac / 100 }))
  .sort((x, y) => x.currency.localeCompare(y.currency));

/**
 * Döküm (Paket B — karar 226): teklifler YÜKLEME GÜNÜNE göre gruplanır. orders: firmanın siparişleri, teklifleri ve
 * satırlarıyla (role göre temizlenmiş), yükleme verisiyle (loadingParts).
 *   Aralık teklifin GÖNDERİLDİĞİ yerel güne uygulanır (eski davranış korunur — 3.65.1): aralıktaki her teklifin bütün
 *   yükleme bölümleri listelenir; tarihi belli olmayan bölüm "Yükleme tarihi belli değil" grubundadır (en sonda).
 *   Toplamlar para birimi başına (farklı para birimleri toplanmaz); grup ve genel toplamda bir sipariş BİR KEZ sayılır
 *   (count = farklı sipariş), m² / adet / tutar bölümlerin toplamıdır (bölümler satırın ticari toplamını paylaşır).
 * @param {any[]} orders
 * @param {{ from: string, to: string, timeZone: string, locale: 'tr' | 'ro', kindLabel: (k: string) => string, price: (l: any) => unknown }} o
 * @returns {{ from: string, to: string, sections: ReportSection[], groups: { day: string | null, sections: ReportSection[], totals: ReportTotal[] }[],
 *   totals: ReportTotal[], orders: number }}
 */
export function customerOfferReport(orders, { from, to, timeZone, locale, kindLabel, price }) {
  /** @type {ReportSection[]} */
  const sections = [];
  for (const order of orders) {
    if (order.orderTypeCode !== 'GLASS_ORDER' || order.status === 'IPTAL') continue;
    const sent = order.offers
      .filter((x) => x.status === 'GONDERILDI' && x.sentAt)
      .sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
    const offer = sent[0];
    if (!offer) continue;
    const offerDay = localDay(new Date(offer.sentAt), timeZone);
    // Aralık TEKLİFİN GÖNDERİLDİĞİ güne uygulanır (karar 164 — 3.65.1'de korunarak geri alındı): aralıktaki teklifin
    // bütün yükleme bölümleri listelenir, gruplama yükleme gününe göredir
    if (offerDay < from || offerDay > to) continue;
    const parts = loadingParts(order, offer);
    for (const p of parts) {
      const data = offerExportData({ lines: p.lines, price, locale, kindLabel });
      // Sıra numarası teklifteki numaradır (bölümde 1'den yeniden başlamaz)
      data.rows.forEach((r, i) => { if (!r.sub) r.n = p.lines[i].lineNo ?? r.n; });
      sections.push({
        key: `${order.id}|${p.day ?? '-'}`, orderId: order.id, orderNo: order.orderNo, title: order.title ?? null,
        day: p.day, offerDay, version: sent.length, currency: offer.currency, partial: parts.length > 1,
        data, pieces: offerTotals(p.lines).adet,
      });
    }
  }
  sections.sort((x, y) => dayCmp(x.day, y.day) || x.orderNo.localeCompare(y.orderNo, 'tr'));
  /** @type {{ day: string | null, sections: ReportSection[], totalsMap: Map<string, any> }[]} */
  const groups = [];
  const grand = new Map();
  for (const s of sections) {
    let g = groups[groups.length - 1];
    if (!g || g.day !== s.day) { g = { day: s.day, sections: [], totalsMap: new Map() }; groups.push(g); }
    g.sections.push(s);
    addTotal(g.totalsMap, s);
    addTotal(grand, s);
  }
  return {
    from, to, sections,
    groups: groups.map((g) => ({ day: g.day, sections: g.sections, totals: totalsOf(g.totalsMap) })),
    totals: totalsOf(grand),
    orders: new Set(sections.map((s) => s.orderId)).size,
  };
}

/**
 * PDF dosya adı, seçili panel dilinde — ortak dosya adı kuralı (server/files/export-name.js, Paket 7):
 * "Tekliflerim-2026-10-01_2026-10-31.pdf" / "Ofertele-Mele-2026-10-01_2026-10-31.pdf".
 * @param {string} base  dilin dosya adı (exports.names.offerReport)
 * @param {{ from: string, to: string }} r
 */
export function offerReportFileName(base, { from, to }) {
  return exportFileName(base, [`${from}_${to}`], 'pdf');
}
