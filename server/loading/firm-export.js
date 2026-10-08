// Firma + yükleme günü çıktısı (Yüklemeler → firma satırı → "PDF" / "Excel"; Paket 7, karar 187). Saf: PDF
// (server/pdf/firm-loading.js) ve Excel (server/files/xlsx-report.js) AYNI veriden üretilir (firmExportData).
//
//   Kapsam: yalnızca seçilen firmanın o günkü siparişleri (ticari) ve o firmanın o günkü sandıkları (fiziksel). Firma satırı
//   yükleme ekranındaki firma tablosundan gelir (server/loading/day-firms.js — tek atıf kuralı).
//   Finansal tutar: YALNIZCA müşteri teklif tutarı (o tutarı görebilen rolde: yönetici, denetimci); fabrika satış tutarı bu
//   çıktılara hiçbir rolde girmez. Satış kullanıcısının çıktısında tutar sütunu yoktur.
//   Müşteriyle paylaşılabilir biçim: başka firmanın adı yazılmaz — misafir yükte yalnızca sandık numarası ("başka firmanın
//   sandığıyla"); ev sahibi firmanın sandığındaki başka firma siparişi listelenmez (sandığın ağırlığı fizikseldir).
import { rowsTotal } from './day-firms.js';

const dims = (c) => [c.lengthMm, c.widthMm, c.heightMm].some((d) => d != null)
  ? [c.lengthMm, c.widthMm, c.heightMm].map((d) => (d == null ? '—' : String(d))).join(' × ')
  : (c.dimensions ?? '');
const num = (v) => (v == null || v === '' ? null : Number(v));

/**
 * @param {{ id: string, name: string, rows: { entry: { orderId: string, orderNo: string, o?: { title?: string | null }, load: { camAdet: number, cnc?: number, delik?: number, metraj: number },
 *   money?: { currency: string, offer: number | null } | null }, guest: { crateNo: number | null, waiting: boolean, hostHere: boolean } | null }[],
 *   crateList: { crateNo: number, lengthMm?: number | null, widthMm?: number | null, heightMm?: number | null, dimensions?: string | null, netAgirlik?: unknown, brutAgirlik?: unknown, note?: string | null, orderIds?: string[] }[],
 *   orders: number, camAdet: number, cnc: number, delik: number, metraj: number, netKg: number, grossKg: number, crates: number, realCrates: boolean }} firm
 * @param {{ offer: boolean }} o  teklif tutarı görünür mü (yönetici / denetimci)
 */
export function firmExportData(firm, { offer }) {
  const own = new Map(firm.rows.map((r) => [r.entry.orderId, r.entry.orderNo]));
  const orders = firm.rows.map((r) => ({
    orderNo: r.entry.orderNo, title: r.entry.o?.title ?? '', camAdet: r.entry.load.camAdet, cnc: r.entry.load.cnc ?? 0, delik: r.entry.load.delik ?? 0,
    metraj: r.entry.load.metraj, currency: r.entry.money?.currency ?? 'EUR', offer: offer ? r.entry.money?.offer ?? null : null,
    // Fiziksel sandık bilgisi: yalnızca sandık NUMARASI (başka firmanın adı yazılmaz)
    guestCrate: r.guest ? r.guest.crateNo : null, guest: !!r.guest, waiting: !!r.guest?.waiting,
  }));
  const sub = rowsTotal(firm.rows.map((r) => ({ entry: { ...r.entry, money: offer && r.entry.money ? { currency: r.entry.money.currency, sales: null, offer: r.entry.money.offer } : null } })));
  const currencies = offer ? Object.keys(sub.money).filter((c) => sub.money[c].hasOffer).sort() : [];
  return {
    firm: firm.name,
    orders,
    currencies,
    totals: { orders: sub.orders, camAdet: sub.camAdet, cnc: sub.cnc, delik: sub.delik, metraj: sub.metraj, offer: Object.fromEntries(currencies.map((c) => [c, sub.money[c].offer])) },
    // Fiziksel: firma satırındaki sandık adedi ve ağırlıklar (girilmiş sandık yoksa tahmin — realCrates false)
    physical: { crates: firm.crates, netKg: firm.netKg, grossKg: firm.grossKg, realCrates: firm.realCrates },
    crates: firm.crateList.map((c) => ({
      no: c.crateNo, dims: dims(c), net: num(c.netAgirlik), gross: num(c.brutAgirlik), note: c.note ?? '',
      // Sandığın içindeki bu firmanın siparişleri (başka firmanın siparişi müşteriyle paylaşılabilir çıktıya yazılmaz)
      orders: (c.orderIds ?? []).filter((id) => own.has(id)).map((id) => own.get(id)),
    })),
  };
}

/**
 * Firma çıktısının Excel sayfası (server/files/xlsx-report.js).
 * @param {ReturnType<typeof firmExportData>} d
 * @param {{ title: string, subtitle: string, sheet: string, ordersTitle: string, cratesTitle: string, total: string, noCrates: string, noOrders: string,
 *   info: [string, string | number][], notes: string[],
 *   cols: { order: string, project: string, glass: string, cnc: string, holes: string, m2: string, offer: string, crate: string, dims: string, net: string, gross: string, orders: string, note: string } }} text
 * @returns {import('../files/xlsx-report.js').Sheet}
 */
export function firmExportSheet(d, text) {
  const c = text.cols;
  /** @type {import('../files/xlsx-report.js').Column[]} */
  const orderCols = [
    { header: c.order, width: 16, type: 'text' }, { header: c.project, width: 34, type: 'wrap' }, { header: c.glass, width: 10, type: 'int' },
    { header: c.cnc, width: 9, type: 'int' }, { header: c.holes, width: 9, type: 'int' }, { header: c.m2, width: 12, type: 'm2' },
    ...d.currencies.map((cur) => ({ header: `${c.offer} (${cur})`, width: 16, type: /** @type {const} */ ('money'), unit: cur })),
  ];
  const amount = (o, cur) => (o.currency === cur ? o.offer : null);
  return {
    name: text.sheet, title: text.title, subtitle: text.subtitle, landscape: true, info: text.info,
    blocks: [
      {
        title: text.ordersTitle, columns: orderCols, empty: text.noOrders,
        rows: d.orders.map((o) => [o.orderNo, o.title, o.camAdet, o.cnc, o.delik, o.metraj, ...d.currencies.map((cur) => amount(o, cur))]),
        totals: d.orders.length ? [[text.total, null, d.totals.camAdet, d.totals.cnc, d.totals.delik, d.totals.metraj, ...d.currencies.map((cur) => d.totals.offer[cur])]] : [],
      },
      {
        title: text.cratesTitle, empty: text.noCrates,
        // Sipariş tablosunun sütunlarına hizalı (sütun genişliğini sipariş tablosu belirler); siparişler iki sütun kaplar
        columns: [
          { header: c.crate, width: 16, type: 'int' }, { header: c.dims, width: 34, type: 'text' }, { header: c.net, width: 10, type: 'kg' },
          { header: c.gross, width: 9, type: 'kg' }, { header: c.orders, width: 21, type: 'wrap', span: 2 }, { header: c.note, width: 24, type: 'wrap' },
        ],
        // Sandık adedi ve toplam ağırlık başlık bilgisinde (firma satırının fiziksel değerleri — boş ağırlık tahminle tamamlanır)
        rows: d.crates.map((x) => [x.no, x.dims, x.net, x.gross, x.orders.join(', '), x.note]),
      },
    ],
    notes: text.notes,
  };
}
