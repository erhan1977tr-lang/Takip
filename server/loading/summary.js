// Yükleme özeti (Yüklemeler → "Yükleme Özeti Excel"): seçilen yükleme gününün tüm müşteri / siparişleri (P3 — karar 241;
// hesaplar karar 233'teki gibi):
//   1. sayfa "Firmalar": bilgi satırları (onaylı mı / planlanan mı açıkça yazılır), firma bazlı özet (yükleme ekranındaki
//      firma tablosuyla aynı değerler — server/loading/day-firms.js; sandık / ağırlık dahil) ve misafir yük / fiziksel sandık
//      ilişkisi.
//   2. sayfa "Döküm": DÜZ tablo — her kalem ayrı satır (sipariş içinde aynı cam tek kalem), sütunlar
//      SİPARİŞ NO | MÜŞTERİ | PROJE | AÇIKLAMA | ADET | BİRİM | METRAJ | BİRİM FİYAT | TUTAR | Para birimi; süzgeç / sıralama
//      açık; para birimi başına toplam tablonun ALTINDA (süzgeç aralığına girmez; para birimleri toplanmaz).
//   Yönetici (iki fiyatı da gören rol): ikinci döküm sayfası "Döküm (Fabrika)" — aynı satırlar fabrika (satış) fiyatıyla
//   (ürün sahibi kararı: aynı satırda iki fiyat yerine ayrı sayfa).
// Satırlar: aynı siparişin içinde aynı ad → tek satır (siparişler arasında birleştirilmez). Tutar fatura kuralıyla
// (server/glass/billing.js → glassTotals): cam + o cama ait CNC / delik / diğer kalemler (sandık parası dahil) — birleştirme
// tutarı değiştirmez (her satırın parçaları aynen toplanır). Birim fiyat = camın AĞIRLIKLI ortalaması Σ(m² × fiyat) / Σm²
// (yalnızca cam satırları; işlemler tutardadır, birim fiyatta değil).
// Bedelsiz telafi (karar 231): fiziksel olarak yüklenir — ayrı satır, fiyat ve tutar 0 (faturalanmaz, satış değildir).
// Kaynak: onaylı gün → yalnızca etkin YÜKLENDİ kalemleri (effectiveItems + itemAsLine; çağıran verir); onaysız gün →
// planlanan teklif miktarları (açıkça "planlanan" yazılır).
// Hangi fiyat ve firma adı: rolün görebildiği (çağıran temizlenmiş veri ve priceOf verir: yönetici müşteri fiyatı,
// denetimci müşteri fiyatı, satış satış fiyatı; satışta firma adları maskeli).
import { glassTotals } from '../glass/billing.js';
import { isM2Glass, offerLineTotals } from '../orders/rules.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const add = (t, r) => {
  t.adet += r.adet;
  t.m2 = round3(t.m2 + r.m2);
  t.total = round2(t.total + r.total);
  return t;
};
const zero = () => ({ adet: 0, m2: 0, total: 0 });

/**
 * Bir siparişin döküm satırları (aynı ad tek satır; bedelsiz cam ayrı satır, tutarı 0).
 * @param {object[]} lines  teklif satırı biçiminde
 * @param {{ priceOf: (l: any) => unknown, nameOf?: (l: any) => string }} o
 * @returns {{ name: string, adet: number, m2: number, price: number, total: number, free: boolean }[]}
 */
export function orderSummaryRows(lines, { priceOf, nameOf = (l) => l.description }) {
  const name = (l) => String(nameOf(l) ?? '').trim();
  // Ağırlıklı ortalama cam fiyatı: Σ(m² × fiyat) / Σm² — yalnızca fiyatlı, bedelsiz olmayan m² cam satırları
  const weight = new Map();
  for (const l of lines) {
    if (!isM2Glass(l) || l.free || priceOf(l) == null) continue;
    const m2 = offerLineTotals({ ...l, unitPrice: 0 }).metraj;
    if (!(m2 > 0)) continue;
    const w = weight.get(name(l)) ?? { m2: 0, value: 0 };
    w.m2 += m2;
    w.value += m2 * Number(priceOf(l));
    weight.set(name(l), w);
  }
  const paid = glassTotals({ lines }, { nameOf: name, priceOf }).map((g) => {
    const w = weight.get(g.name);
    return { name: g.name, adet: g.adet, m2: g.qty, price: w && w.m2 > 0 ? round2(w.value / w.m2) : g.price, total: g.total, free: false };
  });
  // Bedelsiz cam (telafi): fiziksel yük — satır görünür, tutar 0
  const free = new Map();
  for (const l of lines) {
    if (!isM2Glass(l) || !l.free) continue;
    const m2 = offerLineTotals({ ...l, unitPrice: 0 }).metraj;
    if (!(m2 > 0)) continue;
    const r = free.get(name(l)) ?? { name: name(l), adet: 0, m2: 0, price: 0, total: 0, free: true };
    r.adet += Math.max(0, Math.trunc(Number(l.adet) || 0));
    r.m2 = round3(r.m2 + m2);
    free.set(name(l), r);
  }
  return [...paid, ...free.values()];
}

/**
 * Döküm: müşteri → sipariş; sipariş ara toplamı, müşteri toplamı ve genel toplam para birimi başına.
 * @param {{ orderNo: string, title: string | null, currency: string, customer: { id: string, name: string }, lines: object[] }[]} orders
 * @param {{ priceOf: (l: any) => unknown, nameOf?: (l: any) => string }} o
 */
export function buildLoadingSummary(orders, { priceOf, nameOf }) {
  const byCustomer = new Map();
  let offerLines = 0;
  for (const o of orders) {
    offerLines += o.lines.length;
    const rows = orderSummaryRows(o.lines, { priceOf, nameOf });
    if (rows.length === 0) continue;
    const c = byCustomer.get(o.customer.id) ?? { id: o.customer.id, name: o.customer.name, orders: [], totals: {} };
    const subtotal = rows.reduce(add, zero());
    c.orders.push({ orderNo: o.orderNo, title: o.title, currency: o.currency, rows, subtotal });
    add((c.totals[o.currency] ??= zero()), subtotal);
    byCustomer.set(o.customer.id, c);
  }
  const customers = [...byCustomer.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  const totals = {};
  for (const c of customers) {
    c.orders.sort((a, b) => a.orderNo.localeCompare(b.orderNo, 'tr', { numeric: true }));
    for (const [cur, t] of Object.entries(c.totals)) add((totals[cur] ??= zero()), t);
  }
  return { customers, totals, orders: orders.length, offerLines };
}

/**
 * @typedef {{ name: string, orders: number, camAdet: number, cnc: number, delik: number, metraj: number, netKg: number, crates: number, grossKg: number,
 *   money: Record<string, { sales: number, offer: number, hasSales: boolean, hasOffer: boolean }> }} FirmLine
 * @typedef {{ orderNo: string, owner: string, host: string, crate: string }} GuestLine  crate: "#15" ya da "sandık seçimi bekliyor"
 * @typedef {{ sheetName: string, title: string, lines: ReturnType<typeof buildLoadingSummary> }} DetailSheet  bir döküm sayfası (rolün görebildiği tek fiyat türüyle)
 * @typedef {{ title: string, sheetFirms: string, linesNone: string, firmsTitle: string, guestTitle: string, guestNone: string,
 *   total: string, free: string, unit: string,
 *   cols: { order: string, customer: string, project: string, desc: string, qty: string, unit: string, m2: string, price: string, amount: string, currency: string },
 *   firmCols: { firm: string, orders: string, glass: string, cnc: string, holes: string, m2: string, net: string, crates: string, gross: string, factory: string, offer: string },
 *   guestCols: { order: string, owner: string, host: string, crate: string } }} SummaryText
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
 * Döküm sayfasının düz satırları (buildLoadingSummary sırasıyla: müşteri → sipariş no → kalem). Her satır kendi siparişinin
 * numarasını, müşterisini, projesini ve para birimini taşır — süzgeç / sıralama sonrası da okunur.
 * @param {ReturnType<typeof buildLoadingSummary>} lines @param {{ free: string, unit: string }} text
 * @returns {(string | number | null)[][]}
 */
export function detailRows(lines, text) {
  return lines.customers.flatMap((c) => c.orders.flatMap((o) => o.rows.map((r) => [
    o.orderNo, c.name, o.title ?? '', r.free ? `${r.name} — ${text.free}` : r.name, r.adet, text.unit, r.m2, r.price, r.total, o.currency,
  ])));
}

/**
 * "Yükleme Özeti" çalışma kitabı (server/files/xlsx-report.js → writeReportXlsx): 1. sayfa "Firmalar" (bilgi + firma özeti +
 * misafir yük), ardından her DetailSheet için bir "Döküm" sayfası (düz tablo + para birimi başına toplam).
 * @param {{ subtitle: string, stats: [string, string | number][], firms: FirmLine[], total: FirmLine, guests: GuestLine[],
 *   details: DetailSheet[], money: { sales: boolean, offer: boolean }, text: SummaryText }} p
 * @returns {import('../files/xlsx-report.js').Sheet[]}
 */
export function loadingSummarySheets({ subtitle, stats, firms, total, guests, details, money, text }) {
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
  const c = text.cols;
  /** @type {import('../files/xlsx-report.js').Column[]} */
  const detailColumns = [
    { header: c.order, width: 14, type: 'text' }, { header: c.customer, width: 26, type: 'wrap' }, { header: c.project, width: 24, type: 'wrap' },
    { header: c.desc, width: 40, type: 'wrap' }, { header: c.qty, width: 8, type: 'int' }, { header: c.unit, width: 7, type: 'text' },
    { header: c.m2, width: 12, type: 'm2' }, { header: c.price, width: 13, type: 'dec2' }, { header: c.amount, width: 14, type: 'dec2' },
    { header: c.currency, width: 11, type: 'text' },
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
    ...details.map((d) => ({
      name: d.sheetName, title: d.title, subtitle, landscape: true,
      blocks: [{
        columns: detailColumns,
        rows: detailRows(d.lines, text),
        // Para birimi başına toplam (para birimleri toplanmaz; para birimi adına göre sıralı); tablonun altında, süzgeç aralığının dışında
        totals: Object.entries(d.lines.totals).sort(([a], [b]) => a.localeCompare(b)).map(([cur, t]) => ['', '', '', text.total, t.adet, '', t.m2, '', t.total, cur]),
        empty: text.linesNone,
      }],
    })),
  ];
}
