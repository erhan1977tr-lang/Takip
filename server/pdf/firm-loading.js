// Firma yükleme listesi PDF'i (Yüklemeler → firma satırı → "PDF"; Paket 7, karar 187): seçilen firmanın o günkü siparişleri
// (sipariş no, proje, cam adedi, CNC, delik, toplam m², yalnızca müşteri teklif tutarı — görebilen rolde), firmanın sandıkları
// (no, ölçü, net, brüt, içindeki siparişler, not) ve notlar. Veri: server/loading/firm-export.js → firmExportData (Excel ile aynı).
// Ortak başlık (resmî GKH logosu, oranı korunur — server/pdf/brand.js) ve ortak altbilgi (firma adı + sayfa / toplam); uzun
// tablolar sayfaya bölünür, her yeni sayfada tablo başlığı yinelenir. Türkçe ve Romence harfler gömülü yazı tipiyle (pdf.js).
import { PdfDoc, fitText, wrapText } from './pdf.js';
import { BRAND, brandImage, drawBrandLogo, finishPages } from './brand.js';

const M = 40;
const WIDTH = 515;
const ROW = 18;
const BLUE = [0.07, 0.36, 0.55];
const GREY = [0.45, 0.45, 0.45];

const money = (v) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
const m2 = (v) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
const kg = (v) => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(v);
// Sola dayalı sütun sağa dayalı bir sütunun hemen ardından geliyorsa araya boşluk (sayı ile metin bitişmesin)
const LPAD = { orders: 12, project: 6 };

/**
 * @param {ReturnType<typeof import('../loading/firm-export.js').firmExportData>} d
 * @param {{ title: string, firm: string, day: string, generated: string, ordersTitle: string, cratesTitle: string, total: string,
 *   noOrders: string, noCrates: string, stats: [string, string][], notes: string[],
 *   cols: { order: string, project: string, glass: string, cnc: string, holes: string, m2: string, offer: string, crate: string, dims: string, net: string, gross: string, orders: string, note: string } }} text
 *   day: "Yükleme günü: 08.10.2026" · generated: "Oluşturma: …" · stats: [etiket, değer] (sipariş, cam, …, brüt)
 * @returns {Buffer}
 */
export function firmLoadingPdf(d, text) {
  const doc = new PdfDoc({ title: `${text.title} — ${text.firm}`, author: BRAND.company });
  const logo = brandImage(doc); // resmî GKH logosu (ortak başlık)
  const withMoney = d.currencies.length > 0;
  // Sütunlar (toplam 515): teklif tutarı yoksa proje sütunu genişler
  const OW = withMoney
    ? { order: 72, project: 168, glass: 46, cnc: 40, holes: 40, m2: 56, offer: 93 }
    : { order: 80, project: 255, glass: 46, cnc: 40, holes: 40, m2: 54 };
  const CW = { no: 42, dims: 148, net: 62, gross: 62, orders: 116, note: 85 };
  const cols = (w) => {
    let x = M;
    /** @type {Record<string, { x: number, w: number }>} */
    const out = {};
    for (const [k, v] of Object.entries(w)) { out[k] = { x, w: v }; x += v; }
    return out;
  };
  const OC = cols(OW);
  const CC = cols(CW);
  let page;
  let y = 0;
  /** @type {(() => void) | null} */
  let repeat = null; // sayfa bölününce yinelenecek tablo başlığı

  const newPage = (first) => {
    page = doc.addPage();
    if (first) {
      // Logo solda (oranı korunur); başlık metni logonun çizilen genişliğinin sağında başlar
      const tx = M + drawBrandLogo(page, logo, { x: M, y: 30, height: 56 }) + 16;
      page.text(tx, 46, fitText(text.title, 17, M + WIDTH - tx, true), { size: 17, bold: true, color: BLUE });
      page.text(tx, 64, fitText(text.firm, 11, M + WIDTH - tx, true), { size: 11, bold: true });
      page.text(tx, 80, fitText(`${text.day} · ${text.generated}`, 9, M + WIDTH - tx), { size: 9, color: GREY });
      y = 104;
    } else {
      page.text(M, 36, fitText(`${text.title} — ${text.firm} · ${text.day}`, 9, WIDTH), { size: 9, color: GREY });
      y = 50;
      repeat?.();
    }
  };
  const ensure = (h) => {
    if (y + h > page.height - 50) newPage(false);
  };
  const pad = (k, left) => (left ? LPAD[k] ?? 3 : 0);
  const head = (C, labels, aligns) => {
    page.rect(M, y, WIDTH, ROW, { fill: 0.94, stroke: false });
    for (const [k, s] of Object.entries(labels)) {
      const left = aligns[k] === 'left';
      page.text(C[k].x + pad(k, left), y + 12.5, fitText(s, 7.5, C[k].w - 5 - pad(k, left), true), { size: 7.5, bold: true, align: left ? 'left' : 'right', width: C[k].w - 3 });
    }
    y += ROW;
  };
  const cell = (C, k, s, o = {}) => {
    const left = o.align === 'left';
    page.text(C[k].x + pad(k, left), y + 12.5, fitText(s, o.size ?? 8, C[k].w - 5 - pad(k, left), !!o.bold), { size: o.size ?? 8, align: left ? 'left' : 'right', width: C[k].w - 3, bold: !!o.bold, color: o.color });
  };
  const section = (title) => {
    ensure(ROW * 3);
    page.text(M, y + 14, title, { size: 10.5, bold: true, color: BLUE });
    y += 22;
  };

  newPage(true);
  // Özet şeridi: sipariş, cam, CNC, delik, m², net, sandık, brüt (firma satırının değerleri)
  const statLine = text.stats.map(([k, v]) => `${k}: ${v}`).join('   ·   ');
  for (const l of wrapText(statLine, 9, WIDTH)) { page.text(M, y + 4, l, { size: 9 }); y += 13; }
  y += 8;

  // Siparişler
  section(text.ordersTitle);
  const oLabels = { order: text.cols.order, project: text.cols.project, glass: text.cols.glass, cnc: text.cols.cnc, holes: text.cols.holes, m2: text.cols.m2, ...(withMoney ? { offer: text.cols.offer } : {}) };
  const oAlign = { order: 'left', project: 'left' };
  if (d.orders.length === 0) {
    page.text(M, y + 10, text.noOrders, { size: 9, color: GREY });
    y += 22;
  } else {
    repeat = () => head(OC, oLabels, oAlign);
    head(OC, oLabels, oAlign);
    for (const o of d.orders) {
      ensure(ROW);
      cell(OC, 'order', o.orderNo, { align: 'left', bold: true });
      cell(OC, 'project', o.title || '—', { align: 'left', color: o.title ? undefined : GREY });
      cell(OC, 'glass', String(o.camAdet));
      cell(OC, 'cnc', o.cnc ? String(o.cnc) : '–');
      cell(OC, 'holes', o.delik ? String(o.delik) : '–');
      cell(OC, 'm2', m2(o.metraj));
      if (withMoney) cell(OC, 'offer', o.offer == null ? '—' : `${money(o.offer)} ${o.currency}`);
      y += ROW;
      page.line(M, y, M + WIDTH, y, 0.4, 0.85);
    }
    repeat = null;
    // Toplam: para birimi başına ayrı satır (farklı para birimleri toplanmaz)
    const totalRows = withMoney ? d.currencies : [null];
    totalRows.forEach((cur, i) => {
      ensure(ROW + 4);
      if (i === 0) {
        page.line(M, y, M + WIDTH, y, 1, 0.3);
        cell(OC, 'order', text.total, { align: 'left', bold: true });
        cell(OC, 'glass', String(d.totals.camAdet), { bold: true });
        cell(OC, 'cnc', d.totals.cnc ? String(d.totals.cnc) : '–', { bold: true });
        cell(OC, 'holes', d.totals.delik ? String(d.totals.delik) : '–', { bold: true });
        cell(OC, 'm2', m2(d.totals.metraj), { bold: true });
      }
      if (cur) cell(OC, 'offer', `${money(d.totals.offer[cur])} ${cur}`, { bold: true });
      y += ROW;
    });
    y += 10;
  }

  // Sandıklar (fiziksel): yalnızca bu firmanın sandıkları ve içlerindeki bu firmanın siparişleri
  section(text.cratesTitle);
  const cLabels = { no: text.cols.crate, dims: text.cols.dims, net: text.cols.net, gross: text.cols.gross, orders: text.cols.orders, note: text.cols.note };
  const cAlign = { no: 'left', dims: 'left', orders: 'left', note: 'left' };
  if (d.crates.length === 0) {
    page.text(M, y + 10, text.noCrates, { size: 9, color: GREY });
    y += 22;
  } else {
    repeat = () => head(CC, cLabels, cAlign);
    head(CC, cLabels, cAlign);
    for (const c of d.crates) {
      ensure(ROW);
      cell(CC, 'no', String(c.no), { align: 'left', bold: true });
      cell(CC, 'dims', c.dims || '—', { align: 'left' });
      cell(CC, 'net', c.net == null ? '—' : kg(c.net));
      cell(CC, 'gross', c.gross == null ? '—' : kg(c.gross));
      cell(CC, 'orders', c.orders.join(', ') || '—', { align: 'left' });
      cell(CC, 'note', c.note || '', { align: 'left', color: GREY });
      y += ROW;
      page.line(M, y, M + WIDTH, y, 0.4, 0.85);
    }
    repeat = null;
    y += 10;
  }

  for (const note of text.notes) {
    for (const l of wrapText(note, 8, WIDTH)) { ensure(12); page.text(M, y + 4, l, { size: 8, color: GREY }); y += 11; }
  }
  finishPages(doc, { margin: M }); // ortak altbilgi: resmî firma adı + sayfa / toplam
  return doc.toBuffer();
}
