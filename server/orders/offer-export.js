// Teklif dışa aktarma (sipariş sayfası → "PDF İndir" / "Excel İndir"): yönetici ve müşteri aynı satırları ve tutarları
// alır; PDF (server/pdf/offer.js) ve Excel aynı veriden (offerExportData) üretilir. Fiyat hesabı mevcut kuraldır
// (offerLineTotals); burada yalnızca müşteriye giden fiyat kullanılır, satış fiyatı hiçbir dosyaya girmez.
// Kim indirir: OFFER_EXPORT (yönetici, müşteri). Excel: OFFER_SEND (yönetici) her zaman; müşteri yalnızca yöneticinin
// siparişte açtığı izinle (Order.customerExcel). Kontrol sunucuda (route) yapılır: canExportOffer.
import { offerLineTotals } from './rules.js';
import { writeXlsx } from '../files/xlsx.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const isSub = (l) => l.kind === 'CNC' || l.kind === 'DELIK';

/**
 * Sunucu tarafı izin: format = 'pdf' | 'xlsx'.
 * @param {{ canExport: boolean, isAdmin: boolean, customerExcel: boolean }} p
 */
export function canExportOffer(format, { canExport, isAdmin, customerExcel }) {
  if (!canExport && !isAdmin) return false;
  if (format === 'pdf') return true;
  if (format === 'xlsx') return isAdmin || customerExcel;
  return false;
}

/**
 * Teklif satırları → dışa aktarılacak satırlar ve toplam. price(l): satırın müşteri fiyatı (yönetici: offerPrice;
 * müşteri: temizlenmiş veride unitPrice zaten müşteri fiyatıdır).
 * @param {{ lines: object[], price: (l: any) => unknown, locale: 'tr' | 'ro', kindLabel: (k: string) => string }} p
 */
export function offerExportData({ lines, price, locale, kindLabel }) {
  let n = 0;
  let metraj = 0, total = 0;
  const rows = lines.map((l) => {
    const sub = isSub(l);
    if (!sub) n += 1;
    const p = price(l);
    const unitPrice = l.free ? 0 : p == null || p === '' ? null : Number(p);
    const tot = offerLineTotals({ ...l, unitPrice: String(unitPrice ?? 0) });
    const label = sub ? kindLabel(l.kind) : '';
    const own = locale === 'ro' && l.descriptionRo ? l.descriptionRo : l.description;
    const extra = sub && (own === label || own === l.kind || own === 'Delik' || own === 'CNC') ? '' : (own ?? '');
    const desc = sub ? [label, extra].filter(Boolean).join(' – ') : extra;
    const m2 = !sub && l.unit === 'm2' ? tot.metraj : null;
    if (m2) metraj = round2(metraj + m2);
    total = round2(total + tot.amount);
    return {
      n: sub ? null : n, sub, desc, poz: l.poz ?? '', en: l.enMm ?? null, boy: l.boyMm ?? null, adet: Number(l.adet) || 0,
      m2, unit: !sub && l.unit === 'm2' ? 'm2' : 'adet', unitPrice, free: !!l.free, amount: round2(tot.amount),
    };
  });
  return { rows, metraj, total };
}

/**
 * @param {ReturnType<typeof offerExportData>} data
 * @param {{ title: string, orderNo: string, firm: string, date: string, currency: string, notes: string[],
 *   cols: { n: string, desc: string, poz: string, en: string, boy: string, adet: string, m2: string, unitPrice: string, amount: string },
 *   free: string, total: string }} text
 * @returns {Buffer}
 */
export function offerXlsx(data, text) {
  const rows = [
    [`${text.title} ${text.orderNo}`],
    [text.firm],
    [text.date],
    [],
    [text.cols.n, text.cols.desc, text.cols.poz, text.cols.en, text.cols.boy, text.cols.adet, text.cols.m2, `${text.cols.unitPrice} (${text.currency})`, `${text.cols.amount} (${text.currency})`],
    ...data.rows.map((r) => [r.n ?? '', r.desc, r.poz, r.en ?? '', r.boy ?? '', r.adet, r.m2 ?? '', r.free ? text.free : r.unitPrice ?? '', r.amount]),
    [],
    [text.total, '', '', '', '', '', data.metraj || '', '', data.total],
    [],
    ...text.notes.map((x) => [x]),
  ];
  const head = 4;
  return writeXlsx({ sheetName: text.orderNo, rows, bold: [0, head, head + data.rows.length + 2], widths: [5, 44, 10, 8, 8, 7, 10, 16, 16] });
}
