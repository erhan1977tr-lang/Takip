// Teklif dışa aktarma (sipariş sayfası → "PDF İndir" / "Excel İndir"): yönetici ve müşteri aynı satırları ve tutarları
// alır; PDF (server/pdf/offer.js) ve Excel aynı veriden (offerExportData) üretilir. Fiyat hesabı mevcut kuraldır
// (offerLineTotals); burada yalnızca müşteriye giden fiyat kullanılır, satış fiyatı hiçbir dosyaya girmez.
// Kim indirir: OFFER_EXPORT (yönetici, müşteri). Excel: OFFER_SEND (yönetici) her zaman; müşteri yalnızca yöneticinin
// siparişte açtığı izinle (Order.customerExcel). Kontrol sunucuda (route) yapılır: canExportOffer.
import { isSalesCrate, offerLineTotals } from './rules.js';
import { writeReportXlsx } from '../files/xlsx-report.js';

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
    // Satışın sandık ücreti (karar 211): ekrandaki gibi cam prosesi düzeninde — numarasız, üstündeki camın altında
    const crate = !sub && isSalesCrate(l);
    if (!sub && !crate) n += 1;
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
      n: sub || crate ? null : n, sub: sub || crate, desc, poz: l.poz ?? '', en: l.enMm ?? null, boy: l.boyMm ?? null, adet: Number(l.adet) || 0,
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
  // Ortak rapor düzeni (Paket 7, karar 190): logo, başlık + firma / tarih satırı, biçimli tablo, filtre, dondurulmuş başlık,
  // m² ve para biçimleri, toplam satırı, notlar. Satırlar ve tutarlar aynen (offerExportData).
  const c = text.cols;
  return writeReportXlsx({
    sheets: [{
      name: text.orderNo, title: `${text.title} ${text.orderNo}`, subtitle: [text.firm, text.date].filter(Boolean).join(' · '), landscape: true,
      blocks: [{
        columns: [
          { header: c.n, width: 5, type: 'int' }, { header: c.desc, width: 44, type: 'wrap' }, { header: c.poz, width: 10, type: 'text' },
          { header: c.en, width: 9, type: 'mm' }, { header: c.boy, width: 9, type: 'mm' }, { header: c.adet, width: 7, type: 'int' },
          { header: c.m2, width: 11, type: 'm2' }, { header: `${c.unitPrice} (${text.currency})`, width: 16, type: 'dec2' }, { header: `${c.amount} (${text.currency})`, width: 16, type: 'dec2' },
        ],
        rows: data.rows.map((r) => [r.n ?? '', r.desc, r.poz, r.en ?? '', r.boy ?? '', r.adet, r.m2 ?? '', r.free ? text.free : r.unitPrice ?? '', r.amount]),
        totals: [[text.total, '', '', '', '', '', data.metraj || '', '', data.total]],
      }],
      notes: text.notes,
    }],
  });
}
