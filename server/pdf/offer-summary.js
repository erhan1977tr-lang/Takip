// "Tekliflerim" PDF dökümü (karar 164; müşteri ana sayfası → Tekliflerim → PDF): seçilen tarih aralığındaki her teklif
// AYRI ve ayrıntılı (sipariş, teklif tarihi, sürüm; satırlar: sıra, açıklama, poz, en, boy, adet, m², birim fiyat, tutar;
// teklif toplamı), belgenin sonunda GENEL TOPLAM (para birimi başına: teklif sayısı, toplam m², toplam tutar) ve notlar
// (KDV hariç, EUR kur notu). Veri: server/orders/customer-offers.js → customerOfferReport (satırlar teklif PDF'iyle aynı
// hesaptan — offerExportData); yalnızca müşteri fiyatı. Logo ve yazı tipi ortak altyapıdan (server/pdf/brand.js, pdf.js:
// Türkçe ve Romence harfler gömülü yazı tipiyle).
import { PdfDoc, fitText, wrapText } from './pdf.js';
import { BRAND, brandImage, drawBrandLogo, finishPages } from './brand.js';

const M = 40;
const WIDTH = 515;
const ROW = 18;
const BLUE = [0.07, 0.36, 0.55];
const GREY = [0.45, 0.45, 0.45];
// Sütun genişlikleri (toplam 515 = A4 − 2 × kenar) — teklif PDF'iyle aynı düzen
const W = { n: 22, desc: 150, poz: 45, en: 42, boy: 42, adet: 32, m2: 46, unit: 72, amount: 64 };

const money = (v) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
const num = (v) => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(v);
const dmy = (day) => String(day ?? '').slice(0, 10).split('-').reverse().join('.');
const fill = (s, p) => String(s ?? '').replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? `{${k}}`).toString());

/**
 * @param {ReturnType<typeof import('../orders/customer-offers.js').customerOfferReport>} report
 * @param {{ title: string, firm: string, range: string, generated: string, offerDate: string, version: string,
 *   cols: { n: string, desc: string, poz: string, en: string, boy: string, adet: string, m2: string, unitPrice: string, amount: string },
 *   free: string, piece: string, subtotal: string, grandTotal: string, count: string, empty: string, notes: string[] }} text
 *   version: "sürüm {n}" · count: "{n} teklif"
 * @returns {Buffer}
 */
export function offerSummaryPdf(report, text) {
  const doc = new PdfDoc({ title: `${text.title} ${text.range}`, author: BRAND.company });
  const logo = brandImage(doc); // resmî GKH logosu (ortak başlık — server/pdf/brand.js)
  let page;
  let y = 0;
  const C = (() => {
    let x = M;
    const out = {};
    for (const [k, w] of Object.entries(W)) { out[k] = { x, w }; x += w; }
    return out;
  })();
  const newPage = (first) => {
    page = doc.addPage();
    if (first) {
      // Logo solda (oranı korunur); başlık metni logonun çizilen genişliğinin sağında başlar
      const tx = M + drawBrandLogo(page, logo, { x: M, y: 30, height: 56 }) + 16;
      page.text(tx, 46, text.title, { size: 17, bold: true, color: BLUE });
      page.text(tx, 64, fitText(text.firm, 11, M + WIDTH - tx, true), { size: 11, bold: true });
      page.text(tx, 80, fitText(`${text.range} · ${text.generated}`, 9, M + WIDTH - tx), { size: 9, color: GREY });
      y = 108;
    } else {
      page.text(M, 36, fitText(`${text.title} — ${text.firm} · ${text.range}`, 9, WIDTH), { size: 9, color: GREY });
      y = 50;
    }
  };
  const ensure = (h) => {
    if (y + h > page.height - 50) {
      newPage(false);
      return true;
    }
    return false;
  };
  const head = (currency) => {
    page.rect(M, y, WIDTH, ROW, { fill: 0.94, stroke: false });
    const h = (k, s, align = 'right') => page.text(C[k].x + (align === 'left' ? 3 : 0), y + 12.5, fitText(s, 7.5, C[k].w - 4, true), { size: 7.5, bold: true, align, width: C[k].w - 3 });
    h('n', text.cols.n, 'left'); h('desc', text.cols.desc, 'left'); h('poz', text.cols.poz, 'left');
    h('en', text.cols.en); h('boy', text.cols.boy); h('adet', text.cols.adet); h('m2', text.cols.m2);
    h('unit', text.cols.unitPrice); h('amount', `${text.cols.amount} (${currency})`);
    y += ROW;
  };
  /** Teklifin başlık şeridi: sipariş no — sipariş adı · teklif tarihi · sürüm */
  const sectionHead = (s) => {
    page.rect(M, y, WIDTH, ROW + 4, { fill: 0.88, stroke: false });
    const right = `${text.offerDate}: ${dmy(s.day)}${s.version > 1 ? ` · ${fill(text.version, { n: s.version })}` : ''}`;
    const rightW = 170;
    page.text(M + 4, y + 14.5, fitText(`${s.orderNo}${s.title ? ` — ${s.title}` : ''}`, 10, WIDTH - rightW - 12, true), { size: 10, bold: true, color: BLUE });
    page.text(M + WIDTH - rightW - 4, y + 14.5, fitText(right, 8.5, rightW), { size: 8.5, color: GREY, align: 'right', width: rightW });
    y += ROW + 6;
  };

  newPage(true);
  if (report.sections.length === 0) {
    page.text(M, y + 14, text.empty, { size: 10, color: GREY });
    y += 30;
  }
  for (const s of report.sections) {
    // Başlık şeridi + tablo başlığı + en az bir satır aynı sayfada kalır
    ensure(ROW * 3 + 10);
    sectionHead(s);
    head(s.currency);
    for (const r of s.data.rows) {
      if (ensure(ROW)) head(s.currency);
      const cell = (k, v, o = {}) => page.text(C[k].x + (o.align === 'left' ? 3 : 0), y + 12.5, fitText(v, 8, C[k].w - 5, !!o.bold), { size: 8, align: o.align ?? 'right', width: C[k].w - 3, bold: !!o.bold, color: o.color });
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
      page.line(M, y, M + WIDTH, y, 0.4, 0.85);
    }
    // Teklif toplamı: m² ve tutar
    ensure(ROW + 8);
    y += 4;
    page.text(M + WIDTH - 330, y + 12, text.subtotal, { size: 9, bold: true });
    page.text(C.m2.x - 60, y + 12, `${num(s.data.metraj)} m²`, { size: 9, bold: true, align: 'right', width: C.m2.w + 60 });
    page.text(C.amount.x - 70, y + 12, `${money(s.data.total)} ${s.currency}`, { size: 9, bold: true, align: 'right', width: C.amount.w + 70 });
    y += ROW + 14;
  }
  // Genel toplam (para birimi başına; farklı para birimleri toplanmaz)
  if (report.totals.length) {
    ensure(30 + report.totals.length * 18);
    page.line(M, y, M + WIDTH, y, 1.2, 0.2);
    y += 18;
    page.text(M, y, text.grandTotal, { size: 12, bold: true, color: BLUE });
    for (const t of report.totals) {
      page.text(M + 150, y, fill(text.count, { n: t.count }), { size: 10 });
      page.text(C.m2.x - 80, y, `${num(t.m2)} m²`, { size: 11, bold: true, align: 'right', width: C.m2.w + 80 });
      page.text(C.amount.x - 90, y, `${money(t.amount)} ${t.currency}`, { size: 11, bold: true, align: 'right', width: C.amount.w + 90 });
      y += 18;
    }
    y += 8;
  }
  for (const note of text.notes) {
    for (const l of wrapText(note, 8, WIDTH)) { ensure(12); page.text(M, y, l, { size: 8, color: GREY }); y += 11; }
  }
  finishPages(doc); // ortak altbilgi: resmî firma adı + sayfa / toplam
  return doc.toBuffer();
}
