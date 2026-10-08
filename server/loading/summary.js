// Yükleme özeti (Yüklemeler → "Yükleme Özeti Excel"; eski adı "Yükleme Dökümü"): seçilen yükleme gününün tüm müşteri /
// siparişleri tek Excel'de. Paket 7: 1. sayfa firma bazlı özet (yükleme ekranındaki firma tablosuyla aynı değerler —
// server/loading/day-firms.js) ve misafir yük / fiziksel sandık ilişkisi AYRI tabloda; 2. sayfa satır dökümü. Satırlarda
// "Sandık (Fiziksel)" sütunu yoktur (kaldırıldı): ticari satır sahibinde kalır, fiziksel ilişki ayrı tablodadır.
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

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Satır dökümü: müşteri + para birimi + cam + birim fiyat başına tek satır.
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
 * @typedef {{ name: string, orders: number, camAdet: number, cnc: number, delik: number, metraj: number, netKg: number, crates: number, grossKg: number,
 *   money: Record<string, { sales: number, offer: number, hasSales: boolean, hasOffer: boolean }> }} FirmLine
 * @typedef {{ orderNo: string, owner: string, host: string, crate: string }} GuestLine  crate: "#15" ya da "sandık seçimi bekliyor"
 * @typedef {{ title: string, linesTitle: string, sheetFirms: string, sheetLines: string, firmsTitle: string, guestTitle: string, guestNone: string,
 *   total: string, unit: string, currency: string, cols: string[],
 *   firmCols: { firm: string, orders: string, glass: string, cnc: string, holes: string, m2: string, net: string, crates: string, gross: string, factory: string, offer: string },
 *   guestCols: { order: string, owner: string, host: string, crate: string } }} SummaryText
 *   cols: satır dökümünün 9 başlığı (sipariş, müşteri, proje, açıklama, adet, birim, metraj, birim fiyat, tutar)
 */

/**
 * Firma tablosunun tutar sütunları (para birimi başına; farklı para birimleri toplanmaz). Yalnızca görünen tutar: fabrika
 * satış (money.sales) ve teklif (money.offer) — çağıran rolün görebildiğini verir.
 * @param {FirmLine[]} firms @param {{ sales: boolean, offer: boolean }} money
 * @returns {{ key: 'sales' | 'offer', cur: string }[]}
 */
export function moneyColumns(firms, money) {
  const curs = [...new Set(firms.flatMap((f) => Object.keys(f.money)))].sort();
  const out = [];
  for (const key of /** @type {const} */ (['sales', 'offer'])) {
    if (!money[key]) continue;
    for (const cur of curs) if (firms.some((f) => (key === 'sales' ? f.money[cur]?.hasSales : f.money[cur]?.hasOffer))) out.push({ key, cur });
  }
  return out;
}

/**
 * "Yükleme Özeti" çalışma kitabının sayfaları (server/files/xlsx-report.js → writeReportXlsx):
 *   1. sayfa: başlık bilgileri + firma bazlı özet (firma başına tek satır, toplam) + misafir yük / fiziksel sandık ilişkisi
 *   2. sayfa: satır dökümü (buildLoadingSummary) ve para birimi başına toplam
 * @param {{ subtitle: string, stats: [string, string | number][], firms: FirmLine[], total: FirmLine, guests: GuestLine[],
 *   lines: ReturnType<typeof buildLoadingSummary>, money: { sales: boolean, offer: boolean }, text: SummaryText }} p
 * @returns {import('../files/xlsx-report.js').Sheet[]}
 */
export function loadingSummarySheets({ subtitle, stats, firms, total, guests, lines, money, text }) {
  const mcols = moneyColumns([...firms, total], money);
  const amount = (f, c) => {
    const v = f.money[c.cur];
    return v && (c.key === 'sales' ? v.hasSales : v.hasOffer) ? v[c.key] : null;
  };
  const firmRow = (f, label) => [label ?? f.name, f.orders, f.camAdet, f.cnc, f.delik, f.metraj, f.netKg, f.crates, f.grossKg, ...mcols.map((c) => amount(f, c))];
  const fc = text.firmCols;
  /** @type {import('../files/xlsx-report.js').Column[]} */
  const firmColumns = [
    { header: fc.firm, width: 30, type: 'wrap' }, { header: fc.orders, width: 10, type: 'int' }, { header: fc.glass, width: 10, type: 'int' },
    { header: fc.cnc, width: 9, type: 'int' }, { header: fc.holes, width: 9, type: 'int' }, { header: fc.m2, width: 12, type: 'm2' },
    { header: fc.net, width: 12, type: 'kg' }, { header: fc.crates, width: 10, type: 'int' }, { header: fc.gross, width: 12, type: 'kg' },
    ...mcols.map((c) => ({ header: `${c.key === 'sales' ? fc.factory : fc.offer} (${c.cur})`, width: 16, type: /** @type {const} */ ('money'), unit: c.cur })),
  ];
  const gc = text.guestCols;
  const detail = [
    { header: text.cols[0], width: 18, type: 'wrap' }, { header: text.cols[1], width: 24, type: 'wrap' }, { header: text.cols[2], width: 24, type: 'wrap' },
    { header: text.cols[3], width: 40, type: 'wrap' }, { header: text.cols[4], width: 8, type: 'int' }, { header: text.cols[5], width: 7, type: 'text' },
    { header: text.cols[6], width: 11, type: 'dec2' }, { header: text.cols[7], width: 13, type: 'dec2' }, { header: text.cols[8], width: 14, type: 'dec2' },
    { header: text.currency, width: 9, type: 'text' },
  ];
  return [
    {
      name: text.sheetFirms, title: text.title, subtitle, landscape: true, info: stats,
      blocks: [
        { title: text.firmsTitle, columns: firmColumns, rows: firms.map((f) => firmRow(f)), totals: [firmRow(total, text.total)] },
        {
          title: text.guestTitle, empty: text.guestNone,
          // Firma tablosunun sütunlarına hizalı: sipariş (Firma sütunu), ticari sahip (4 sütun), fiziksel sandık sahibi (3), sandık (1)
          columns: [
            { header: gc.order, width: 30, type: 'text' }, { header: gc.owner, width: 38, type: 'wrap', span: 4 },
            { header: gc.host, width: 34, type: 'wrap', span: 3 }, { header: gc.crate, width: 12, type: 'text' },
          ],
          rows: guests.map((g) => [g.orderNo, g.owner, g.host, g.crate]),
        },
      ],
    },
    {
      name: text.sheetLines, title: text.linesTitle, subtitle, landscape: true,
      blocks: [{
        columns: /** @type {import('../files/xlsx-report.js').Column[]} */ (detail),
        rows: lines.rows.map((r) => [r.orders.join(', '), r.customer, r.titles.join(', '), r.name, r.adet, text.unit, r.m2, r.unit, r.total, r.currency]),
        totals: Object.entries(lines.totals).map(([cur, t]) => ['', '', '', text.total, t.adet, '', t.m2, '', t.total, cur]),
      }],
    },
  ];
}
