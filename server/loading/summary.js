// Yükleme dökümü (Yüklemeler → "Yükleme Dökümü Excel"): seçilen yükleme gününün tüm müşteri / siparişleri tek Excel'de.
// Veri yalnızca mevcut kayıtlardan: o gün yüklenecek cam siparişleri (gün = gerçek ya da tahmini yükleme günü; elle
// değiştirilen tarih esas) ve teklif satırları. Satırlar müşteriye göre gruplanır. Tek satır = müşteri + para birimi +
// cam + camın BİRİM FİYATI (karar 83): aynı müşteri, aynı cam, aynı fiyat → siparişler arasında da tek satır (adet ve m²
// toplanır, sipariş / proje adları birlikte yazılır); aynı cam farklı fiyatla → ayrı satırlar (fiyatlar birleştirilip
// ortalanmaz). Tutar faturadaki kuralla hesaplanır (server/glass/billing.js → glassTotals): cam fiyatı + o cam satırına
// ait CNC / delik / m² dışındaki diğer kalemler (sandık parası dahil); bunlar ayrıca listelenmez. Birim fiyat = tutar / m²
// (eklenen işlem yoksa camın birim fiyatının kendisi).
// Hangi fiyat: rolün görebildiği fiyat (yönetici / denetimci: müşteri fiyatı; satış: satış fiyatı) — veriler sunucuda
// role göre temizlenmiş gelir (lib/orders.ts → sanitizeRows; satışa müşteri fiyatı ve firma tam adı hiç gelmez).
import { glassTotals } from '../glass/billing.js';
import { writeXlsx } from '../files/xlsx.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * @param {{ orderNo: string, title: string | null, customer: { id: string, name: string }, offers: { status: string, currency: string, lines: object[] }[] }[]} orders
 * @param {{ priceOf: (l: any) => unknown }} o
 */
export function buildLoadingSummary(orders, { priceOf }) {
  const rows = new Map();
  let offerLines = 0;
  for (const o of orders) {
    const offer = o.offers.find((x) => x.status === 'GONDERILDI') ?? o.offers[0];
    if (!offer) continue;
    offerLines += offer.lines.length;
    for (const g of glassTotals(offer, { nameOf: (l) => l.description, priceOf, byPrice: true })) {
      const key = `${o.customer.id}|${offer.currency}|${g.name}|${g.price}`;
      const r = rows.get(key) ?? { customer: o.customer.name, currency: offer.currency, name: g.name, price: g.price, parts: 0, orders: [], titles: [], adet: 0, m2: 0, total: 0 };
      r.parts += 1;
      if (!r.orders.includes(o.orderNo)) r.orders.push(o.orderNo);
      if (o.title && !r.titles.includes(o.title)) r.titles.push(o.title);
      r.adet += g.adet;
      r.m2 = round3(r.m2 + g.qty);
      r.total = round2(r.total + g.total);
      rows.set(key, r);
    }
  }
  const list = [...rows.values()]
    // Birim fiyat: eklenen işlem yoksa camın birim fiyatının kendisi (yuvarlama farkı sayılmaz); varsa tutar / m²
    .map(({ parts, ...r }) => ({ ...r, unit: Math.abs(r.total - r.m2 * r.price) <= 0.02 * parts ? r.price : r.m2 > 0 ? round2(r.total / r.m2) : 0 }))
    .sort((a, b) => a.customer.localeCompare(b.customer, 'tr') || a.name.localeCompare(b.name, 'tr') || a.price - b.price);
  const totals = {};
  for (const r of list) {
    const t = (totals[r.currency] ??= { adet: 0, m2: 0, total: 0 });
    t.adet += r.adet;
    t.m2 = round3(t.m2 + r.m2);
    t.total = round2(t.total + r.total);
  }
  return { rows: list, totals, orders: orders.length, offerLines };
}

/**
 * @param {ReturnType<typeof buildLoadingSummary>} s
 * @param {{ day: string, stats: [string, string | number][], text: { title: string, cols: string[], unit: string, total: string } }} p
 * @returns {Buffer}
 */
export function loadingSummaryXlsx(s, { day, stats, text }) {
  const rows = [
    [`${text.title} · ${day}`],
    ...stats.map(([k, v]) => [k, String(v)]),
    [],
    text.cols,
    ...s.rows.map((r) => [r.orders.join(', '), r.customer, r.titles.join(', '), r.name, r.adet, text.unit, r.m2, r.unit, r.total]),
  ];
  const head = stats.length + 2;
  const bold = [0, head];
  for (const [cur, t] of Object.entries(s.totals)) {
    bold.push(rows.length);
    rows.push(['', '', '', text.total, t.adet, '', t.m2, '', t.total, cur]);
  }
  return writeXlsx({ sheetName: `${day}`, rows, bold, widths: [18, 26, 26, 46, 8, 8, 12, 14, 13] });
}
