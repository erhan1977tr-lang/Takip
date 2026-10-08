// Teklif PDF'i (sipariş sayfası → "PDF İndir"): logo, başlık, sipariş no, firma, tarih; satırlar (sıra, açıklama, poz,
// en, boy, adet, m², birim fiyat, tutar); toplam ve notlar (KDV hariç, EUR kur notu). Veri: offerExportData — Excel ile aynı.
import { PdfDoc, fitText, wrapText } from './pdf.js';
import { BRAND, brandImage, drawBrandLogo, finishPages } from './brand.js';

const M = 40;
const ROW = 18;
const BLUE = [0.07, 0.36, 0.55];
const GREY = [0.45, 0.45, 0.45];
// Sütun genişlikleri (toplam 515 = A4 − 2 × kenar)
const W = { n: 22, desc: 150, poz: 45, en: 42, boy: 42, adet: 32, m2: 46, unit: 72, amount: 64 };

const money = (v) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
const num = (v) => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(v);

/**
 * @param {ReturnType<typeof import('../orders/offer-export.js').offerExportData>} data
 * @param {Parameters<typeof import('../orders/offer-export.js').offerXlsx>[1] & { piece: string }} text
 * @returns {Buffer}
 */
export function offerPdf(data, text) {
  const doc = new PdfDoc({ title: `${text.title} ${text.orderNo}`, author: BRAND.company });
  const logo = brandImage(doc); // resmî GKH logosu (ortak başlık — server/pdf/brand.js)
  let page;
  let y = 0;
  const cols = () => {
    let x = M;
    const out = {};
    for (const [k, w] of Object.entries(W)) { out[k] = { x, w }; x += w; }
    return out;
  };
  const C = cols();
  const head = () => {
    page.rect(M, y, 515, ROW, { fill: 0.94, stroke: false });
    const h = (k, s, align = 'right') => page.text(C[k].x + (align === 'left' ? 3 : 0), y + 12.5, fitText(s, 7.5, C[k].w - 4, true), { size: 7.5, bold: true, align, width: C[k].w - 3 });
    h('n', text.cols.n, 'left'); h('desc', text.cols.desc, 'left'); h('poz', text.cols.poz, 'left');
    h('en', text.cols.en); h('boy', text.cols.boy); h('adet', text.cols.adet); h('m2', text.cols.m2);
    h('unit', text.cols.unitPrice); h('amount', `${text.cols.amount} (${text.currency})`);
    y += ROW;
  };
  const newPage = (first) => {
    page = doc.addPage();
    if (first) {
      // Logo solda (oranı korunur); başlık metni logonun çizilen genişliğinin sağında başlar (logo değişse de üst üste binmez)
      const tx = M + drawBrandLogo(page, logo, { x: M, y: 30, height: 56 }) + 16;
      page.text(tx, 46, `${text.title} ${text.orderNo}`, { size: 17, bold: true, color: BLUE });
      page.text(tx, 64, fitText(text.firm, 11, M + 515 - tx, true), { size: 11, bold: true });
      page.text(tx, 80, text.date, { size: 9, color: GREY });
      y = 104;
    } else {
      page.text(M, 36, `${text.title} ${text.orderNo} — ${text.firm}`, { size: 9, color: GREY });
      y = 48;
    }
    head();
  };
  const ensure = (h) => { if (y + h > page.height - 50) newPage(false); };

  newPage(true);
  for (const r of data.rows) {
    ensure(ROW);
    const cell = (k, s, o = {}) => page.text(C[k].x + (o.align === 'left' ? 3 : 0), y + 12.5, fitText(s, 8, C[k].w - 5, !!o.bold), { size: 8, align: o.align ?? 'right', width: C[k].w - 3, bold: !!o.bold, color: o.color });
    cell('n', r.n == null ? '' : String(r.n), { align: 'left' });
    cell('desc', r.sub ? `   ${r.desc}` : r.desc, { align: 'left', color: r.sub ? GREY : undefined });
    cell('poz', r.poz, { align: 'left' });
    cell('en', r.en == null ? '' : String(r.en));
    cell('boy', r.boy == null ? '' : String(r.boy));
    cell('adet', String(r.adet));
    cell('m2', r.m2 == null ? '—' : num(r.m2));
    cell('unit', r.free ? text.free : r.unitPrice == null ? '—' : `${money(r.unitPrice)} / ${r.unit === 'm2' ? 'm²' : text.piece}`);
    cell('amount', money(r.amount));
    y += ROW;
    page.line(M, y, M + 515, y, 0.4, 0.85);
  }
  ensure(60);
  y += 6;
  page.line(M + 515 - 220, y, M + 515, y, 1.2, 0.2);
  page.text(M + 515 - 220, y + 16, text.total, { size: 11, bold: true, color: BLUE });
  if (data.metraj) page.text(C.m2.x - 40, y + 16, `${num(data.metraj)} m²`, { size: 9, align: 'right', width: C.m2.w + 40 });
  page.text(C.amount.x - 60, y + 16, `${money(data.total)} ${text.currency}`, { size: 11, bold: true, align: 'right', width: C.amount.w + 60 });
  y += 36;
  for (const note of text.notes) {
    for (const l of wrapText(note, 8, 515)) { ensure(12); page.text(M, y, l, { size: 8, color: GREY }); y += 11; }
  }
  finishPages(doc); // ortak altbilgi: resmî firma adı + sayfa / toplam
  return doc.toBuffer();
}
