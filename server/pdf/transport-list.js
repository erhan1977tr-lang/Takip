// "Nakliye listesi" PDF'i (ürün sahibinin örneğinin düzeni): başlık + yükleme günü; SANDIK ETİKETİ başına ara toplam
// satırı (sandık adedi + ağırlık; karar 253) ve sandıklar (no, U × G × Y mm, ağırlık kg, not); sonda sandık adedi ve toplam
// ağırlık; sandığı girilmemiş siparişler. Sandıkta başka firmanın camı varsa (misafir yük, karar 124) sandığın NOT
// sütununda yazılır.
// Her sayfanın başlığında, sağ üstte resmî GKH logosu (ortak başlık — server/pdf/brand.js; karar 129).
// Fiyat yok. Metinler kullanıcının dilinde (server/i18n/*/loading.js → transport).
// Satış ekipleri (karar 300): liste bölümlüyse (list.sections) her satışçı için başlık → etiket grupları ve sandıklar →
// satışçının ara toplamı (sandık adedi + ağırlık) ve o bölümün eksik / bekleyen siparişleri; en altta genel toplam.
import { PdfDoc, fitText } from './pdf.js';
import { BRAND, brandImage, drawBrandLogo, finishPages } from './brand.js';

const M = 40;
const ROW = 22;
const BLUE = [0.07, 0.36, 0.55];
const GREY = [0.45, 0.45, 0.45];
const COL = { no: 50, dims: 175, kg: 95 }; // not: kalan genişlik

const fmtKg = (v) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

/**
 * @param {{ day: string, list: ReturnType<typeof import('../loading/transport.js').buildTransportList>,
 *   text: { title: string, day: string, colNo: string, colDims: string, colKg: string, colNote: string, subtotal: string,
 *   crateCount: string, totalKg: string, missing: string, noPrice: string, empty: string, guest: string, waiting: string,
 *   teamSubtotal?: string, grandTotal?: string }, company?: string }} p
 *   text.teamSubtotal: "{name}: {n} sandık · {kg} kg" (satışçı ara toplamı) · text.grandTotal: genel toplam başlığı
 *   text.subtotal: "{n} sandık · ara toplam"; company: logonun yanında yazan firma adı — verilmezse resmî ad (BRAND.company)
 * @returns {Buffer}
 */
export function transportListPdf({ day, list, text, company = BRAND.company }) {
  const dayText = day.split('-').reverse().join('.');
  const doc = new PdfDoc({ title: `${text.title} ${day}`, author: company });
  const logo = brandImage(doc);
  let page;
  let y = 0;
  const W = () => page.width - 2 * M;
  const noteW = () => W() - COL.no - COL.dims - COL.kg;
  const xs = () => ({ no: M, dims: M + COL.no, kg: M + COL.no + COL.dims, note: M + COL.no + COL.dims + COL.kg + 8 });

  const tableHead = () => {
    const x = xs();
    page.rect(M, y, W(), ROW, { fill: 0.95, stroke: false });
    page.text(x.no + 6, y + 14, text.colNo, { size: 8, bold: true });
    page.text(x.dims, y + 14, text.colDims, { size: 8, bold: true });
    page.text(x.kg, y + 14, text.colKg, { size: 8, bold: true, align: 'right', width: COL.kg });
    page.text(x.note, y + 14, text.colNote, { size: 8, bold: true });
    y += ROW;
  };
  const newPage = (first) => {
    page = doc.addPage();
    page.text(M, 46, text.title, { size: 17, bold: true, color: BLUE });
    // Logo sağ üstte (çizginin üstünde, oranı korunarak); firma adı logonun solunda
    const lw = drawBrandLogo(page, logo, { x: page.width - M, y: 22, height: 48, align: 'right' });
    page.text(page.width - M - lw - 10 - 200, 36, company, { size: 9, color: GREY, align: 'right', width: 200 });
    page.text(M, 64, `${text.day}: ${dayText}`, { size: 9.5, color: GREY });
    page.line(M, 76, page.width - M, 76, 1.2, 0.2);
    y = 80;
    if (!first || list.groups.length) tableHead();
  };
  const ensure = (h) => { if (y + h > page.height - 60) newPage(false); };

  newPage(true);
  const x = xs();
  const drawGroups = (groups) => groups.forEach((g, gi) => {
    ensure(ROW * 2);
    if (gi > 0) page.line(M, y, page.width - M, y, 1.2, 0);
    page.text(x.no + 6, y + 15, g.code, { size: 11, bold: true, color: BLUE });
    page.text(x.kg - 40, y + 15, `${fmtKg(g.totalKg)} kg`, { size: 10, align: 'right', width: COL.kg + 40 });
    page.text(x.note, y + 15, fitText(text.subtotal.replace('{n}', String(g.crates.length)), 8, noteW(), false), { size: 8, color: GREY });
    y += ROW;
    page.line(M, y, page.width - M, y, 0.4, 0.8);
    for (const c of g.crates) {
      ensure(ROW);
      page.text(x.no, y + 15, String(c.crateNo), { size: 9.5, align: 'center', width: COL.no });
      page.text(x.dims, y + 15, fitText(c.dims || '—', 9.5, COL.dims - 6), { size: 9.5 });
      page.text(x.kg, y + 15, c.weight == null ? '—' : fmtKg(c.weight), { size: 9.5, align: 'right', width: COL.kg });
      // Not sütunu: sandığın notu ve misafir yük (karar 253 — sandığın notunda: "Misafir yük: firma · sipariş no";
      // yalnızca fiziksel bilgi). Birden çok kalem alt alta, aynı sütunda.
      const notes = [
        ...(c.note ? [{ t: c.note, guest: false }] : []),
        ...(c.guests ?? []).map((gu) => ({ t: `${text.guest}: ${[gu.firm, gu.orderNo].filter(Boolean).join(' · ')}`, guest: true })),
      ];
      notes.forEach((n, i) => {
        if (i > 0) { y += ROW - 8; ensure(ROW - 8); }
        page.text(x.note, y + 15, fitText(n.t, 8, noteW() - 8, n.guest), n.guest ? { size: 8, bold: true, color: BLUE } : { size: 8, color: GREY });
      });
      y += ROW;
      page.line(M, y, page.width - M, y, 0.4, 0.85);
    }
  });
  const drawNotes = (part) => {
    if (part.missing.length) {
      ensure(20);
      page.text(M, y + 6, fitText(`${text.missing}: ${part.missing.join(', ')}`, 9.5, W(), true), { size: 9.5, bold: true, color: BLUE });
      y += 18;
    }
    if (part.waiting?.length) {
      ensure(20);
      page.text(M, y + 6, fitText(`${text.waiting}: ${part.waiting.map((w) => `${w.orderNo} → ${w.host}`).join(', ')}`, 9.5, W(), true), { size: 9.5, bold: true, color: BLUE });
      y += 18;
    }
  };
  const sections = Array.isArray(list.sections) ? list.sections : null;
  if (sections) {
    sections.forEach((sec) => {
      // Satışçı başlığı → grupları → satışçı ara toplamı (karar 300)
      ensure(ROW * 3);
      page.rect(M, y, W(), ROW, { fill: 0.9, stroke: false });
      page.text(M + 6, y + 15, fitText(sec.name || '—', 11, W() - 12, true), { size: 11, bold: true });
      y += ROW;
      drawGroups(sec.groups);
      ensure(ROW);
      const sub = (text.teamSubtotal ?? '{name}: {n} · {kg} kg').replace('{name}', sec.name || '—').replace('{n}', String(sec.crateCount)).replace('{kg}', fmtKg(sec.totalKg));
      page.text(M, y + 15, fitText(sub, 10, W(), true), { size: 10, bold: true, color: BLUE, align: 'right', width: W() });
      y += ROW;
      drawNotes(sec);
      y += 6;
    });
  } else {
    drawGroups(list.groups);
  }
  if (!list.groups.length) {
    page.text(M, y + 20, text.empty, { size: 10, color: GREY });
    y += 30;
  }

  // Toplamlar (sağda) — bölümlü listede genel toplam (bütün satışçılar)
  ensure(70);
  y += 18;
  const tx = page.width - M - 190;
  if (sections && text.grandTotal) {
    page.text(tx + 12, y, text.grandTotal, { size: 9, bold: true });
    y += 8;
  }
  page.text(tx + 12, y + 10, text.crateCount, { size: 9, color: GREY });
  page.text(tx, y + 10, String(list.crateCount), { size: 10, align: 'right', width: 190 });
  y += 16;
  page.line(tx, y, page.width - M, y, 1.2, 0.2);
  page.text(tx + 12, y + 16, text.totalKg, { size: 11, bold: true, color: BLUE });
  page.text(tx, y + 16, `${fmtKg(list.totalKg)} kg`, { size: 11, bold: true, align: 'right', width: 190 });
  y += 34;
  if (!sections) drawNotes(list);

  finishPages(doc, { note: `${company} · ${text.noPrice}`, margin: M }); // ortak altbilgi
  return doc.toBuffer();
}
