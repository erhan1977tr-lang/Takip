// Muhasebe → Tedarikçi Hesap Durumu.
//   A) Yükleme kârlılığı (yükleme = yükleme günü; Yüklemeler sekmesiyle aynı gruplama):
//        kâr = cam satış (müşteriye giden yönetici fiyatı) − cam alış/maliyet (satış fiyatı = fabrika fiyat tablosu)
//              − nakliye (yönetici elle girer, LoadingCost)
//   B) Fabrika cari hesabı: borç = toplam cam alış/maliyet − fabrikaya yapılan ödemeler (FactoryPayment).
//      Ödemeler yüklemelere/siparişlere bağlı değildir ve dağıtılmaz.
// Para birimleri asla birbirine eklenmez: her toplam para birimi başına ayrı tutulur.
import { orderLoad } from '../orders/loading.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const add = (map, cur, key, v) => {
  const o = (map[cur] ??= { sale: 0, cost: 0, transport: 0 });
  o[key] = round2(o[key] + v);
};

/**
 * Siparişin muhasebe satırı: müşteriye gönderilmiş son teklif (satış = yönetici fiyatı, maliyet = satış fiyatı).
 * Gönderilmiş teklifi olmayan sipariş null (henüz fiyatı belli değil).
 * @param {{ id: string, orderNo: string, actualShipDate: Date | null, estimatedShipDate: Date | null, price?: { amount: unknown } | null,
 *   offers: { status: string, currency: string, amount: unknown, offerAmount: unknown, lines: object[] }[], items?: { camAdedi: number }[] }} o
 */
export function orderLine(o) {
  const sent = o.offers.find((x) => x.status === 'GONDERILDI');
  const d = o.actualShipDate ?? o.estimatedShipDate;
  if (!sent || !d) return null;
  const load = orderLoad({
    lines: sent.lines.map((l) => ({ description: l.description, enMm: l.enMm, boyMm: l.boyMm, adet: l.adet, unit: l.unit, kind: l.kind, weightKgM2: l.weightKgM2 != null ? Number(l.weightKgM2) : null })),
    items: o.items ?? [],
  });
  const sale = Number(o.price?.amount ?? sent.offerAmount ?? 0);
  return { orderId: o.id, orderNo: o.orderNo, day: new Date(d).toISOString().slice(0, 10), currency: sent.currency, m2: load.metraj, sale, cost: Number(sent.amount ?? 0) };
}

/**
 * Yükleme günleri: m², para birimi başına satış / maliyet / nakliye / kâr.
 * @param {ReturnType<typeof orderLine>[]} lines
 * @param {{ shipDay: Date, amount: unknown, currency: string }[]} costs
 */
export function loadingProfits(lines, costs) {
  const days = new Map();
  const dayOf = (key) => {
    if (!days.has(key)) days.set(key, { day: key, orders: 0, m2: 0, byCur: {} });
    return days.get(key);
  };
  for (const l of lines) {
    if (!l) continue;
    const d = dayOf(l.day);
    d.orders++;
    d.m2 = round2(d.m2 + l.m2);
    add(d.byCur, l.currency, 'sale', l.sale);
    add(d.byCur, l.currency, 'cost', l.cost);
  }
  for (const c of costs) add(dayOf(new Date(c.shipDay).toISOString().slice(0, 10)).byCur, c.currency, 'transport', Number(c.amount));
  const out = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  for (const d of out) for (const v of Object.values(d.byCur)) v.profit = round2(v.sale - v.cost - v.transport);
  return out;
}

/**
 * Üst özet ve fabrika bakiyesi, para birimi başına.
 * @param {ReturnType<typeof loadingProfits>} days
 * @param {{ amount: unknown, currency: string }[]} payments
 */
export function supplierSummary(days, payments) {
  const s = {};
  const cur = (c) => (s[c] ??= { sale: 0, cost: 0, transport: 0, profit: 0, paid: 0, balance: 0 });
  for (const d of days) {
    for (const [c, v] of Object.entries(d.byCur)) {
      const o = cur(c);
      o.sale = round2(o.sale + v.sale);
      o.cost = round2(o.cost + v.cost);
      o.transport = round2(o.transport + v.transport);
      o.profit = round2(o.profit + v.profit);
    }
  }
  for (const p of payments) {
    const o = cur(p.currency);
    o.paid = round2(o.paid + Number(p.amount));
  }
  for (const o of Object.values(s)) o.balance = round2(o.cost - o.paid);
  return s;
}

export const CURRENCIES = ['EUR', 'RON', 'USD', 'TRY'];
export const MAX_AMOUNT = 100_000_000;

/** Tutar: "1.234,56" / "1234.56" → sayı (pozitif); geçersiz → null */
export function parseAmount(v) {
  let s = String(v ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= MAX_AMOUNT ? round2(n) : null;
}

/**
 * Sayfa verisi: bugüne kadar yüklenmiş (yükleme günü bugün ya da önce) cam siparişleri, nakliye ve ödemeler.
 * @param {Date} endOfToday  bu andan önceki yükleme günleri
 */
export async function supplierData(db, endOfToday) {
  const orders = await db.order.findMany({
    where: {
      orderTypeCode: 'GLASS_ORDER', status: { not: 'IPTAL' }, onHold: false,
      OR: [{ actualShipDate: { lt: endOfToday } }, { actualShipDate: null, estimatedShipDate: { lt: endOfToday } }],
    },
    include: { price: true, items: { select: { camAdedi: true } }, offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
  });
  const [costs, payments] = await Promise.all([
    db.loadingCost.findMany({ orderBy: [{ shipDay: 'desc' }, { createdAt: 'asc' }] }),
    db.factoryPayment.findMany({ orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }] }),
  ]);
  const days = loadingProfits(orders.map(orderLine), costs);
  return { days, costs, payments, summary: supplierSummary(days, payments) };
}
