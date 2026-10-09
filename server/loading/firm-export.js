// Firma + yükleme günü çıktısı (Yüklemeler → firma satırı → "PDF" / "Excel"; Paket 7, karar 187; ayrıntı Yönetici Paneli
// Paketi 1, karar 215). Saf: PDF (server/pdf/firm-loading.js) ve Excel (server/files/xlsx-report.js) AYNI veriden üretilir
// (firmExportData) — sipariş kapsamı ve tutarlar iki belgede birebir aynıdır.
//
//   Kim: firmDocsAllowed — yükleme belgelerini indiren VE müşteri fiyatını gören rol (yönetici; salt okuyan denetimci).
//   Satış bu işlemleri görmez, sunucu reddeder; satışın gün belgeleri (nakliye listesi, Yükleme Özeti Excel'i) ayrıdır.
//   Kapsam: yalnızca seçilen firmanın o günkü siparişleri (ticari) ve o firmanın o günkü sandıkları (fiziksel). Firma satırı
//   yükleme ekranındaki firma tablosundan gelir (server/loading/day-firms.js — tek atıf kuralı).
//   Ayrıntı (orderDetail): her siparişin yükleme hesabındaki teklifinin satırları — teklif tablosundaki gibi cam, altındaki
//   CNC / delik ve sandık parası AYRI, numaralı kalem (ürün sahibinin seçimi); m² ve tutar teklif PDF'iyle aynı hesaptan
//   (offerExportData). Sipariş tutarı satırların toplamıdır (kayıtlı teklif tutarıyla aynı); farklı para birimleri toplanmaz.
//   Finansal tutar: YALNIZCA müşteri teklif tutarı ve yalnızca müşteriye GÖNDERİLMİŞ teklifte; fabrika satış tutarı bu
//   çıktılara hiçbir rolde girmez (iki tutar yan yana yalnızca yöneticinin Özet ekranında).
//   Müşteriyle paylaşılabilir biçim: başka firmanın adı yazılmaz — misafir yükte yalnızca sandık numarası ("başka firmanın
//   sandığıyla"); ev sahibi firmanın sandığındaki başka firma siparişi listelenmez (sandığın ağırlığı fizikseldir).
import { rowsTotal } from './day-firms.js';
import { offerExportData } from '../orders/offer-export.js';
import { loadedOffer } from '../orders/loading.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const dims = (c) => [c.lengthMm, c.widthMm, c.heightMm].some((d) => d != null)
  ? [c.lengthMm, c.widthMm, c.heightMm].map((d) => (d == null ? '—' : String(d))).join(' × ')
  : (c.dimensions ?? '');
const num = (v) => (v == null || v === '' ? null : Number(v));
const none = () => null;

/**
 * Firma satırının belge işlemleri (PDF, Excel, Özet): yükleme belgelerini indiren (TRANSPORT_LIST_VIEW) VE müşteri fiyatını
 * gören (PRICE_FINAL_VIEW) rol — yönetici ve salt okuyan denetimci. Satış yalnızca "Sandık"ı görür; bu üç işlemin adresi
 * sunucuda da bu kuralla reddedilir. Rol adına değil yetkiye bakılır.
 * @param {(permission: string) => boolean} can
 */
export const firmDocsAllowed = (can) => can('TRANSPORT_LIST_VIEW') && can('PRICE_FINAL_VIEW');

/**
 * @typedef {ReturnType<typeof offerExportData>['rows'][number] & { salesUnitPrice?: number | null, salesAmount?: number | null }} DetailRow
 *   salesUnitPrice / salesAmount: fabrika satış fiyatı ve tutarı — yalnızca salesPrice verilince (yöneticinin Özet ekranı)
 */

/**
 * Bir yükleme satırının sipariş ayrıntısı. Teklif: yükleme hesabınınki (loadedOffer — ekrandaki firma tablosuyla aynı:
 * gönderilmiş son teklif, yoksa son taslak; aktarılmış kalanda yalnızca aktarılan adet). Satırlar teklif tablosundaki gibi
 * (offerExportData): cam satırı numaralı, CNC / delik alt satırı numarasız, sandık parası ayrı ve numaralı kalem.
 * Müşteri tutarı yalnızca müşteriye GÖNDERİLMİŞ teklifte (gönderilmemişte birim fiyat ve tutar boş).
 * @param {{ offers?: { status: string, currency?: string, lines?: object[] }[] } | null | undefined} o  yükleme satırı (role göre temizlenmiş)
 * @param {{ price?: ((l: any) => unknown) | null, salesPrice?: ((l: any) => unknown) | null, locale?: 'tr' | 'ro', kindLabel?: (k: string) => string }} p
 *   price: müşteri fiyatı erişimcisi (görmeyen rolde null) · salesPrice: fabrika satış fiyatı erişimcisi (yalnızca yönetici Özet'i)
 * @returns {{ sent: boolean, currency: string | null, rows: DetailRow[], metraj: number, total: number | null, salesTotal: number | null }}
 */
export function orderDetail(o, { price = null, salesPrice = null, locale = 'tr', kindLabel = (k) => k } = {}) {
  const offer = loadedOffer(o?.offers, false);
  if (!offer) return { sent: false, currency: null, rows: [], metraj: 0, total: null, salesTotal: null };
  const sent = offer.status === 'GONDERILDI';
  const priced = sent && !!price;
  const lines = offer.lines ?? [];
  const customer = offerExportData({ lines, price: priced ? price : none, locale, kindLabel });
  const sales = salesPrice ? offerExportData({ lines, price: salesPrice, locale, kindLabel }) : null;
  const rows = customer.rows.map((r, i) => ({
    ...r,
    unitPrice: priced ? r.unitPrice : null,
    amount: priced ? r.amount : null,
    ...(sales ? { salesUnitPrice: sales.rows[i].unitPrice, salesAmount: sales.rows[i].amount } : {}),
  }));
  return { sent, currency: offer.currency ?? null, rows, metraj: customer.metraj, total: priced ? customer.total : null, salesTotal: sales ? sales.total : null };
}

/**
 * @param {{ id: string, name: string, rows: { entry: { orderId: string, orderNo: string, replan?: boolean, o?: { title?: string | null, offers?: any[], replan?: { fromDay: string } | null },
 *   load: { camAdet: number, cnc?: number, delik?: number, metraj: number },
 *   money?: { currency: string, offer: number | null } | null }, guest: { crateNo: number | null, waiting: boolean, hostHere: boolean } | null }[],
 *   crateList: { crateNo: number, lengthMm?: number | null, widthMm?: number | null, heightMm?: number | null, dimensions?: string | null, netAgirlik?: unknown, brutAgirlik?: unknown, note?: string | null, orderIds?: string[] }[],
 *   orders: number, camAdet: number, cnc: number, delik: number, metraj: number, netKg: number, grossKg: number, crates: number, realCrates: boolean }} firm
 * @param {{ offer: boolean, price?: ((l: any) => unknown) | null, locale?: 'tr' | 'ro', kindLabel?: (k: string) => string }} o
 *   offer: teklif tutarı görünür mü (yönetici / denetimci) · price: satırın müşteri fiyatı erişimcisi (temizlenmiş veride)
 */
export function firmExportData(firm, { offer, price = null, locale = 'tr', kindLabel = (k) => k }) {
  const own = new Map(firm.rows.map((r) => [r.entry.orderId, r.entry.orderNo]));
  const orders = firm.rows.map((r) => {
    const detail = orderDetail(r.entry.o, { price: offer ? price : null, locale, kindLabel });
    // Sipariş tutarı: satırlardan (ayrıntıyla aynı sayı); satırı olmayan siparişte yükleme satırının tutarı
    const lineTotal = offer && detail.total != null && detail.rows.length > 0 ? detail.total : null;
    return {
      orderNo: r.entry.orderNo, title: r.entry.o?.title ?? '', camAdet: r.entry.load.camAdet, cnc: r.entry.load.cnc ?? 0, delik: r.entry.load.delik ?? 0,
      metraj: r.entry.load.metraj, currency: r.entry.money?.currency ?? detail.currency ?? 'EUR',
      offer: offer ? lineTotal ?? r.entry.money?.offer ?? null : null,
      // Aktarılmış kalan (karar 102): satır siparişin tamamı değil, önceki yüklemeden aktarılan adet
      replanFrom: r.entry.replan ? r.entry.o?.replan?.fromDay ?? null : null,
      // Fiziksel sandık bilgisi: yalnızca sandık NUMARASI (başka firmanın adı yazılmaz)
      guestCrate: r.guest ? r.guest.crateNo : null, guest: !!r.guest, waiting: !!r.guest?.waiting,
      detail,
    };
  });
  const sub = rowsTotal(firm.rows.map((r) => ({ entry: { ...r.entry, money: null } })));
  /** @type {Record<string, number>} */
  const totals = {};
  for (const o of orders) if (o.offer != null) totals[o.currency] = round2((totals[o.currency] ?? 0) + o.offer);
  const currencies = offer ? Object.keys(totals).sort() : [];
  return {
    firm: firm.name,
    orders,
    currencies,
    totals: { orders: sub.orders, camAdet: sub.camAdet, cnc: sub.cnc, delik: sub.delik, metraj: sub.metraj, offer: Object.fromEntries(currencies.map((c) => [c, totals[c]])) },
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
 * Firma satırının "Özet" ekranı (Paket 7, karar 187; ayrıntı karar 215): firma + gün, her siparişin teklif satırları
 * (orderDetail — PDF / Excel ile aynı satırlar, sandık parası ayrı kalem). Tutarlar yalnızca finance verilince (yönetici,
 * OFFER_SEND): fabrika satış (satış fiyatı) ve müşteri teklifi (müşteriye gönderilen fiyat) AYRI — satır, sipariş ve para
 * birimi başına; farklı para birimleri toplanmaz. Sipariş tutarları satırların toplamıdır (satırı olmayan siparişte yükleme
 * satırının tutarı): sipariş tablosu, ayrıntı ve para birimi toplamları aynı sayıyı gösterir. finance yoksa (denetimci)
 * satırlar fiyatsızdır.
 * @param {Parameters<typeof firmExportData>[0]} firm
 * @param {{ finance: boolean, salesPrice?: ((l: any) => unknown) | null, price?: ((l: any) => unknown) | null, locale?: 'tr' | 'ro', kindLabel?: (k: string) => string }} p
 */
export function firmSummaryData(firm, { finance, salesPrice = null, price = null, locale = 'tr', kindLabel = (k) => k }) {
  const orders = firm.rows.map((r) => {
    const detail = orderDetail(r.entry.o, { price: finance ? price : null, salesPrice: finance ? salesPrice : null, locale, kindLabel });
    const lines = detail.rows.length > 0;
    const money = /** @type {{ currency?: string, sales?: number | null, offer?: number | null } | null | undefined} */ (r.entry.money);
    return {
      orderId: r.entry.orderId, orderNo: r.entry.orderNo, title: r.entry.o?.title ?? '', sent: detail.sent,
      replanFrom: r.entry.replan ? r.entry.o?.replan?.fromDay ?? null : null,
      camAdet: r.entry.load.camAdet, cnc: r.entry.load.cnc ?? 0, delik: r.entry.load.delik ?? 0, metraj: r.entry.load.metraj,
      currency: money?.currency ?? detail.currency ?? 'EUR',
      sales: finance ? (lines ? detail.salesTotal : money?.sales ?? null) : null,
      offer: finance ? (lines ? detail.total : money?.offer ?? null) : null,
      detail,
    };
  });
  /** @type {Record<string, { sales: number, offer: number, hasSales: boolean, hasOffer: boolean }>} */
  const totals = {};
  for (const o of orders) {
    if (o.sales == null && o.offer == null) continue;
    const t = totals[o.currency] ?? { sales: 0, offer: 0, hasSales: false, hasOffer: false };
    if (o.sales != null) { t.sales = round2(t.sales + o.sales); t.hasSales = true; }
    if (o.offer != null) { t.offer = round2(t.offer + o.offer); t.hasOffer = true; }
    totals[o.currency] = t;
  }
  return { orders, currencies: Object.keys(totals).sort(), totals };
}

/**
 * Ayrıntı satırlarının para birimi başına toplamı (m² ve tutar) — Excel'in ayrıntı sayfası ve PDF'in sonu.
 * @param {ReturnType<typeof firmExportData>} d
 * @returns {{ currency: string, m2: number, amount: number }[]}
 */
export function detailTotals(d) {
  /** @type {Map<string, { currency: string, m2: number, amount: number }>} */
  const by = new Map();
  for (const o of d.orders) {
    if (o.offer == null || !o.detail.currency) continue;
    const t = by.get(o.currency) ?? { currency: o.currency, m2: 0, amount: 0 };
    t.m2 = round2(t.m2 + o.detail.metraj);
    t.amount = round2(t.amount + o.offer);
    by.set(o.currency, t);
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Firma çıktısının Excel sayfaları (server/files/xlsx-report.js): 1. sayfa bilgi + siparişler (sipariş başına bir satır,
 * toplam) + sandıklar; 2. sayfa ayrıntı — her teklif satırı bir satır (sipariş no her satırda: süzgeçle siparişe göre
 * daraltılır), para birimi başına toplam. Sipariş tutarı (1. sayfa) = o siparişin ayrıntı satırlarının toplamı (2. sayfa).
 * @param {ReturnType<typeof firmExportData>} d
 * @param {{ title: string, subtitle: string, sheet: string, detailSheet: string, detailTitle: string, ordersTitle: string, cratesTitle: string, total: string, noCrates: string, noOrders: string,
 *   free: string, currency: string, replanNote: string,
 *   info: [string, string | number][], notes: string[],
 *   cols: { order: string, project: string, glass: string, cnc: string, holes: string, m2: string, offer: string, crate: string, dims: string, net: string, gross: string, orders: string, note: string,
 *     n: string, desc: string, poz: string, en: string, boy: string, adet: string, unitPrice: string, amount: string } }} text
 *   replanNote: "{from} yüklemesinden aktarılan kalan" ({from} yerine gün yazılır)
 * @returns {import('../files/xlsx-report.js').Sheet[]}
 */
export function firmExportSheets(d, text) {
  return [firmExportSheet(d, text), firmDetailSheet(d, text)];
}

/**
 * 1. sayfa (Paket 7 düzeni aynen): bilgi, siparişler, sandıklar.
 * @param {ReturnType<typeof firmExportData>} d
 * @param {Parameters<typeof firmExportSheets>[1]} text
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

/**
 * 2. sayfa: ayrıntı (teklif satırları). Birim fiyat ve tutar müşteri fiyatıyla; bedelsiz satırda "Bedelsiz"; gönderilmemiş
 * teklifte boş. Para birimi ayrı sütunda; toplam para birimi başına (toplanmaz).
 * @param {ReturnType<typeof firmExportData>} d
 * @param {Parameters<typeof firmExportSheets>[1]} text
 * @returns {import('../files/xlsx-report.js').Sheet}
 */
export function firmDetailSheet(d, text) {
  const c = text.cols;
  /** @type {import('../files/xlsx-report.js').Column[]} */
  const columns = [
    { header: c.order, width: 14, type: 'text' }, { header: c.project, width: 22, type: 'wrap' }, { header: c.n, width: 5, type: 'int' },
    { header: c.desc, width: 40, type: 'wrap' }, { header: c.poz, width: 9, type: 'text' }, { header: c.en, width: 9, type: 'mm' },
    { header: c.boy, width: 9, type: 'mm' }, { header: c.adet, width: 7, type: 'int' }, { header: c.m2, width: 10, type: 'm2' },
    { header: c.unitPrice, width: 13, type: 'dec2' }, { header: c.amount, width: 14, type: 'dec2' }, { header: text.currency, width: 9, type: 'text' },
  ];
  const rows = [];
  for (const o of d.orders) {
    const cur = o.offer != null ? o.currency : '';
    const project = [o.title, o.replanFrom ? text.replanNote.replace('{from}', o.replanFrom.split('-').reverse().join('.')) : ''].filter(Boolean).join(' · ');
    for (const r of o.detail.rows) {
      const unit = r.free && r.unitPrice != null ? text.free : r.unitPrice;
      rows.push([o.orderNo, project, r.n ?? '', r.desc, r.poz, r.en ?? '', r.boy ?? '', r.adet, r.m2 ?? '', unit ?? '', r.amount ?? '', r.amount != null ? cur : '']);
    }
  }
  return {
    name: text.detailSheet, title: text.detailTitle, subtitle: text.subtitle, landscape: true,
    blocks: [{
      columns, empty: text.noOrders, rows,
      totals: detailTotals(d).map((t) => [text.total, '', '', '', '', '', '', '', t.m2, '', t.amount, t.currency]),
    }],
    notes: text.notes,
  };
}
