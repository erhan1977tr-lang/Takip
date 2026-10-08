// Müşteri ana sayfası → "Tekliflerim" (karar 164): seçilen tarih aralığında FİRMANIN kendi tekliflerinin listesi ve PDF
// dökümü. Saf kural (veritabanı / ağ yok); veri lib/customer-offers.ts'te yüklenir ve role göre temizlenir (müşteri
// fiyatı — sanitizeRows), PDF server/pdf/offer-summary.js'tedir.
//   - Kapsam: yalnızca CAM siparişleri (satırlar, m², müşteri teklif tutarı); iptal edilmiş sipariş dökümde yoktur.
//   - Teklif = siparişin müşteriye gönderilmiş SON sürümü (yeni sürüm eskisinin yerini alır; aynı sipariş iki kez sayılmaz).
//     Aralığa giren: o sürümün gönderildiği gün (Romanya saatiyle, uygulamanın saat dilimi) başlangıç ≤ gün ≤ bitiş.
//   - Satırlar ve tutarlar teklif PDF'iyle AYNI hesaptan (offerExportData → offerLineTotals); fiyat erişimcisi çağırandan
//     gelir ve yalnızca müşteri fiyatıdır — fabrika / satış fiyatı hiçbir zaman dökümde yoktur.
//   - Toplamlar para birimi başına ayrı (farklı para birimleri toplanmaz): teklif sayısı, toplam m², toplam tutar.
import { offerExportData } from './offer-export.js';
import { parseDateOnly } from './rules.js';
import { localDay } from '../profile/dates.js';

/** En uzun aralık (gün) — yıllık döküm sığar */
export const OFFER_REPORT_MAX_DAYS = 400;
/** Bir dökümdeki en çok teklif (sayfa ve PDF); fazlasında aralık daraltılmalıdır */
export const OFFER_REPORT_MAX = 300;

const DAY_MS = 86_400_000;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
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

/**
 * Döküm. orders: firmanın siparişleri, teklifleri ve satırlarıyla (role göre temizlenmiş).
 * @param {{ id: string, orderNo: string, title?: string | null, status: string, orderTypeCode: string,
 *   offers: { id: string, status: string, currency: string, sentAt: Date | string | null, createdAt: Date | string, lines: object[] }[] }[]} orders
 * @param {{ from: string, to: string, timeZone: string, locale: 'tr' | 'ro', kindLabel: (k: string) => string, price: (l: any) => unknown }} o
 * @returns {{ from: string, to: string, sections: { orderId: string, orderNo: string, title: string | null, day: string,
 *   version: number, currency: string, data: ReturnType<typeof offerExportData> }[],
 *   totals: { currency: string, count: number, m2: number, amount: number }[] }}
 */
export function customerOfferReport(orders, { from, to, timeZone, locale, kindLabel, price }) {
  const sections = [];
  for (const order of orders) {
    if (order.orderTypeCode !== 'GLASS_ORDER' || order.status === 'IPTAL') continue;
    const sent = order.offers
      .filter((x) => x.status === 'GONDERILDI' && x.sentAt)
      .sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
    const offer = sent[0];
    if (!offer) continue;
    const day = localDay(new Date(offer.sentAt), timeZone);
    if (day < from || day > to) continue;
    const data = offerExportData({ lines: offer.lines, price, locale, kindLabel });
    sections.push({ orderId: order.id, orderNo: order.orderNo, title: order.title ?? null, day, version: sent.length, currency: offer.currency, data });
  }
  sections.sort((x, y) => (x.day === y.day ? x.orderNo.localeCompare(y.orderNo, 'tr') : x.day < y.day ? -1 : 1));
  const byCurrency = new Map();
  for (const s of sections) {
    const t = byCurrency.get(s.currency) ?? { currency: s.currency, count: 0, m2: 0, amount: 0 };
    t.count += 1;
    t.m2 = round2(t.m2 + s.data.metraj);
    t.amount = round2(t.amount + s.data.total);
    byCurrency.set(s.currency, t);
  }
  const totals = [...byCurrency.values()].sort((x, y) => x.currency.localeCompare(y.currency));
  return { from, to, sections, totals };
}

/**
 * PDF dosya adı, seçili panel dilinde: "tekliflerim-2026-10-01_2026-10-31.pdf" / "ofertele-mele-…".
 * @param {string} base  dilin dosya adı kökü (offers.report.fileName)
 * @param {{ from: string, to: string }} r
 */
export function offerReportFileName(base, { from, to }) {
  const safe = String(base ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'oferte';
  return `${safe}-${from}_${to}.pdf`;
}
