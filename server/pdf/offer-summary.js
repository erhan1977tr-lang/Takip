// "Tekliflerim" PDF dökümü (karar 164, Paket B — karar 226; müşteri ana sayfası → Tekliflerim → PDF): yükleme günü
// başlıkları; altında her sipariş AYRI ve ayrıntılı (sipariş, yükleme günü, teklif tarihi, sürüm; satırlar: sıra, açıklama,
// poz, en, boy, adet, birim, m², birim fiyat, tutar), grup toplamı; sonda GENEL TOPLAM (para birimi başına) ve notlar
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
// Sütun genişlikleri (toplam 515 = A4 − 2 × kenar): sıra, açıklama, poz, en, boy, adet, birim, metraj, birim fiyat, tutar
const W = { n: 20, desc: 156, poz: 34, en: 36, boy: 38, adet: 26, um: 26, m2: 50, unit: 58, amount: 71 };

const money = (v) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
// Metraj 3 ondalıkla GÖSTERİLİR (hesap kesinliği değişmez — karar 226)
const m3 = (v) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(v);
const int = (v) => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(v);
const dmy = (day) => String(day ?? '').slice(0, 10).split('-').reverse().join('.');
const fill = (s, p) => String(s ?? '').replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? `{${k}}`).toString());

/**
 * Döküm YÜKLEME GÜNÜNE göre (Paket B — karar 226): her yükleme günü ayrı başlık; altında her sipariş ayrı başlıkla
 * (sipariş no, adı, yükleme günü + teklif tarihi, bölüm tutarı) ve satırlarıyla; grup toplamı; sonda genel toplam (para
 * birimi başına: sipariş sayısı, m², cam adedi, tutar). Yalnızca müşteri fiyatı (veri çağırandan temizlenmiş gelir).
 * @param {ReturnType<typeof import('../orders/customer-offers.js').customerOfferReport>} report
 * @param {{ title: string, firm: string, range: string, generated: string, offerDate: string, loadingDate: string, noDate: string,
 *   version: string, partial: string, continued: string,
 *   cols: { n: string, desc: string, poz: string, en: string, boy: string, adet: string, um: string, m2: string, unitPrice: string, amount: string },
 *   free: string, piece: string, groupTotal: string, grandTotal: string, count: string, pieces: string, empty: string, notes: string[] }} text
 *   version: "sürüm {n}" · count: "{n} sipariş" · pieces: "{n} adet"
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
  const room = (h) => y + h <= page.height - 50;
  const head = () => {
    page.rect(M, y, WIDTH, ROW, { fill: 0.94, stroke: false });
    const h = (k, s, align = 'right') => page.text(C[k].x + (align === 'left' ? 3 : 0), y + 12.5, fitText(s, 7.5, C[k].w - 4, true), { size: 7.5, bold: true, align, width: C[k].w - 3 });
    h('n', text.cols.n, 'left'); h('desc', text.cols.desc, 'left'); h('poz', text.cols.poz, 'left');
    h('en', text.cols.en); h('boy', text.cols.boy); h('adet', text.cols.adet); h('um', text.cols.um, 'left'); h('m2', text.cols.m2);
    h('unit', text.cols.unitPrice); h('amount', text.cols.amount);
    y += ROW;
  };
  /** Yükleme günü başlığı (grup) */
  const groupHead = (g) => {
    page.rect(M, y, WIDTH, ROW + 6, { fill: 0.82, stroke: false });
    const label = g.day ? `${text.loadingDate}: ${dmy(g.day)}` : text.noDate;
    page.text(M + 5, y + 16, fitText(label, 11.5, 300, true), { size: 11.5, bold: true, color: BLUE });
    const right = fill(text.count, { n: new Set(g.sections.map((s) => s.orderId)).size });
    page.text(M + WIDTH - 205, y + 16, fitText(right, 9, 200), { size: 9, color: GREY, align: 'right', width: 200 });
    y += ROW + 10;
  };
  /** Siparişin başlık şeridi: sipariş no — adı · yükleme günü / teklif tarihi · bölüm tutarı */
  const sectionHead = (s, cont = false) => {
    const h = 30;
    page.rect(M, y, WIDTH, h, { fill: 0.95, stroke: false });
    page.line(M, y, M + WIDTH, y, 1, 0.25);
    const left = `${s.orderNo}${s.title ? ` — ${s.title}` : ''}${cont ? ` (${text.continued})` : ''}`;
    page.text(M + 4, y + 13, fitText(left, 10, 255, true), { size: 10, bold: true, color: BLUE });
    const sub = [s.version > 1 ? fill(text.version, { n: s.version }) : '', s.partial ? text.partial : ''].filter(Boolean).join(' · ');
    if (sub) page.text(M + 4, y + 25, fitText(sub, 7.5, 255), { size: 7.5, color: GREY });
    const dates = [s.day ? `${text.loadingDate}: ${dmy(s.day)}` : text.noDate, `${text.offerDate}: ${dmy(s.offerDay)}`];
    page.text(M + 262, y + 12, fitText(dates[0], 8, 168), { size: 8, color: GREY, align: 'right', width: 168 });
    page.text(M + 262, y + 23, fitText(dates[1], 8, 168), { size: 8, color: GREY, align: 'right', width: 168 });
    page.text(M + WIDTH - 82, y + 15, fitText(`${money(s.data.total)} ${s.currency}`, 9.5, 80, true), { size: 9.5, bold: true, align: 'right', width: 80 });
    y += h + 2;
  };
  /** Satır yüksekliği: açıklama en çok iki satıra kaydırılır (örnek dökümdeki gibi), fazlası kısaltılır */
  const descLines = (r) => {
    const w = C.desc.w - 6;
    const all = wrapText(r.sub ? `   ${r.desc}` : r.desc, 8, w);
    return all.length <= 2 ? all : [all[0], fitText(all.slice(1).join(' '), 8, w)];
  };
  const rowHeight = (r) => (descLines(r).length > 1 ? ROW + 10 : ROW);
  const row = (r) => {
    const cell = (k, v, o = {}) => page.text(C[k].x + (o.align === 'left' ? 3 : 0), y + 12.5, fitText(v, 8, C[k].w - 5, !!o.bold), { size: 8, align: o.align ?? 'right', width: C[k].w - 3, bold: !!o.bold, color: o.color });
    cell('n', r.n == null ? '' : String(r.n), { align: 'left', color: GREY });
    for (const [i, l] of descLines(r).entries()) page.text(C.desc.x + 3, y + 12.5 + i * 10, l, { size: 8, color: r.sub ? GREY : undefined });
    cell('poz', r.poz, { align: 'left' });
    cell('en', r.en == null ? '' : String(r.en));
    cell('boy', r.boy == null ? '' : String(r.boy));
    cell('adet', String(r.adet));
    cell('um', r.unit === 'm2' ? 'm²' : text.piece, { align: 'left', color: GREY });
    cell('m2', r.m2 == null ? '' : m3(r.m2));
    cell('unit', r.free ? text.free : r.unitPrice == null ? '—' : money(r.unitPrice));
    cell('amount', money(r.amount));
    y += rowHeight(r);
    page.line(M, y, M + WIDTH, y, 0.4, 0.85);
  };
  const totalLine = (label, t, size) => {
    page.text(M + 4, y + 12, fitText(label, size, 150, true), { size, bold: true, color: BLUE });
    page.text(M + 150, y + 12, fitText(`${fill(text.count, { n: t.count })} · ${fill(text.pieces, { n: int(t.pieces) })}`, size - 1, 150), { size: size - 1 });
    page.text(C.m2.x - 60, y + 12, `${m3(t.m2)} m²`, { size, bold: true, align: 'right', width: C.m2.w + 60 });
    page.text(C.amount.x - 90, y + 12, `${money(t.amount)} ${t.currency}`, { size, bold: true, align: 'right', width: C.amount.w + 90 });
    y += size + 9;
  };

  newPage(true);
  if (report.groups.length === 0) {
    page.text(M, y + 14, text.empty, { size: 10, color: GREY });
    y += 30;
  }
  for (const g of report.groups) {
    // Grup başlığı + ilk siparişin başlığı + tablo başlığı + en az bir satır aynı sayfada kalır
    if (!room(ROW + 10 + 32 + ROW * 2)) newPage(false);
    groupHead(g);
    for (const [i, s] of g.sections.entries()) {
      if (i > 0 && !room(32 + ROW * 2)) newPage(false);
      sectionHead(s);
      head();
      for (const r of s.data.rows) {
        if (!room(rowHeight(r))) { newPage(false); sectionHead(s, true); head(); }
        row(r);
      }
      y += 8;
    }
    // Grup toplamı (para birimi başına)
    if (!room(8 + g.totals.length * 18)) newPage(false);
    page.line(M, y, M + WIDTH, y, 0.8, 0.4);
    y += 2;
    for (const t of g.totals) totalLine(text.groupTotal, t, 9);
    y += 14;
  }
  // Genel toplam (para birimi başına; farklı para birimleri toplanmaz)
  if (report.totals.length) {
    if (!room(30 + report.totals.length * 22)) newPage(false);
    page.line(M, y, M + WIDTH, y, 1.4, 0.2);
    y += 6;
    for (const t of report.totals) totalLine(text.grandTotal, t, 11);
    y += 8;
  }
  for (const note of text.notes) {
    for (const l of wrapText(note, 8, WIDTH)) { if (!room(12)) newPage(false); page.text(M, y, l, { size: 8, color: GREY }); y += 11; }
  }
  finishPages(doc); // ortak altbilgi: resmî firma adı + sayfa / toplam
  return doc.toBuffer();
}
