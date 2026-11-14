// "INTRAREA MARFĂ" — depo giriş formu (PDF; 4.2.20, karar 320). Ürün sahibinin Excel şablonunun (Intrare_Depozit.xlsx)
// mal kabulündeki adetlerle doldurulmuş hâli: şablonun bütün satırları (görsel, ürün, miktar, ağırlık) her zaman yazılır,
// teslim alınan adetler miktar sütununa, ağırlık = katsayı × adet (server/suppliers/intrare-marfa.js) ağırlık sütununa,
// en altta TOTAL GREUTATE. Üstte PALETI / CUTII (mal kabulünde girilen sayılar). Düzeltmede (REV.n) aynı form güncel (net)
// adetlerle, "REV.n — CORECȚIE" başlığı, gerekçe ve değişen satırlarla üretilir. Fiyat, maliyet, kâr belgede YOKTUR.
// Metin Romence (depo Romanya'da). Logo: resmî GKH logosu (karar 129).
import { PdfDoc, fitText, wrapText } from './pdf.js';
import { BRAND, brandImage, drawBrandLogo, finishPages } from './brand.js';
import { imImage } from './intrare-marfa-images.js';
import { IM_FILLS, fmtKg, intrareMarfaData } from '../suppliers/intrare-marfa.js';

const M = 40;
const COL = { a: 93, b: 273, c: 84, d: 65 };
const ROW = 16;
const TALL = 32;
const HEAD = 20;
const GREY = [0.35, 0.35, 0.35];

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10).split('-').reverse().join('.') : '');

/**
 * @param {object} p
 * @param {string} p.docNo            belge no ("TS-2026-001-1"; düzeltmede "TS-2026-001-1 REV.1")
 * @param {string} p.orderNo          tedarikçi sipariş no
 * @param {string} p.supplierName
 * @param {Date} p.receivedOn         kabul tarihi (DATA)
 * @param {string | null} p.reference aviz / irsaliye
 * @param {number | null} p.pallets   PALETI
 * @param {number | null} p.boxes     CUTII
 * @param {{ code: string, name: string, qty: number, unit: string }[]} p.lines  adetler (düzeltmede güncel net adetler)
 * @param {{ no: number, createdAt: Date, reason: string, baseDocNo: string, changes: { code: string, from: number, to: number, unit: string }[] }} [p.revision]
 * @returns {Buffer}
 */
export function intrareMarfaPdf(p) {
  const rev = p.revision ?? null;
  const doc = new PdfDoc({ title: `Intrare marfa ${p.docNo}`, author: BRAND.company });
  const logo = brandImage(doc);
  const data = intrareMarfaData(p.lines);
  const W = COL.a + COL.b + COL.c + COL.d;
  const xb = M + COL.a, xc = xb + COL.b, xd = xc + COL.c;
  let page;
  let y = 0;

  const field = (label, value, x, yy, lw, vw) => {
    page.text(x, yy, label, { size: 9, bold: true, align: 'right', width: lw });
    page.text(x + lw + 6, yy, fitText(value ?? '', 10, vw, true), { size: 10, bold: true });
    page.line(x + lw + 4, yy + 3.5, x + lw + 6 + vw, yy + 3.5, 0.4, 0.6);
  };
  const header = (first) => {
    page = doc.addPage();
    if (!first) {
      page.text(M, 36, `Intrarea marfă ${p.docNo}${rev ? ' — CORECȚIE' : ''}`, { size: 9, color: [0.4, 0.4, 0.4] });
      y = 48;
      return;
    }
    drawBrandLogo(page, logo, { x: M, y: 28, height: 58 });
    const rx = page.width - M - 250;
    field('DATA :', day(rev ? rev.createdAt : p.receivedOn), rx, 42, 100, 144);
    field('NR. :', p.docNo, rx, 60, 100, 144);
    field('FURNIZOR :', p.supplierName, rx, 78, 100, 144);
    page.text(M, 116, rev ? `INTRAREA MARFĂ — REV.${rev.no}` : 'INTRAREA MARFĂ', { size: 17, bold: true, align: 'center', width: W });
    y = 122;
    if (rev) {
      page.text(M, 136, `CORECȚIE la ${rev.baseDocNo}`, { size: 10.5, bold: true, align: 'center', width: W, color: [0.75, 0.1, 0.1] });
      y = 140;
    }
    field('PALETI :', p.pallets == null ? '' : String(p.pallets), M, y + 18, 56, 90);
    field('CUTII :', p.boxes == null ? '' : String(p.boxes), M, y + 35, 56, 90);
    field('COMANDA FURNIZOR :', p.orderNo, rx, y + 18, 100, 144);
    field('AVIZ / REFERINȚĂ :', p.reference || '—', rx, y + 35, 100, 144);
    y += 44;
    if (rev) {
      y += 4;
      for (const l of wrapText(`MOTIV: ${rev.reason}`, 8.5, W).slice(0, 3)) { page.text(M, y + 4, l, { size: 8.5, bold: true }); y += 11; }
      if (rev.changes.length) {
        const text = `MODIFICĂRI FAȚĂ DE ${rev.baseDocNo}: ${rev.changes.map((c) => `${c.code}: ${c.from} -> ${c.to} ${c.unit}`).join('; ')}`;
        const lines = wrapText(text, 8.5, W);
        lines.slice(0, 4).forEach((l, i) => { page.text(M, y + 4, i === 3 && lines.length > 4 ? fitText(`${l} …`, 8.5, W) : l, { size: 8.5 }); y += 11; });
      }
      y += 2;
    }
    y += 4;
  };
  const ensure = (h) => {
    if (y + h > page.height - 46) header(false);
  };
  const sectionHead = (title, unit, weight) => {
    page.rect(M, y, COL.a + COL.b, HEAD);
    page.rect(xc, y, COL.c, HEAD);
    page.rect(xd, y, COL.d, HEAD);
    page.text(M, y + 14.5, title, { size: 11.5, bold: true, align: 'center', width: COL.a + COL.b });
    page.text(xc, y + 13.5, unit, { size: 7, bold: true, align: 'center', width: COL.c });
    const parts = weight.split(' ');
    if (parts.length > 1) {
      page.text(xd, y + 9.5, parts[0], { size: 6.5, bold: true, align: 'center', width: COL.d });
      page.text(xd, y + 17, parts.slice(1).join(' '), { size: 6.5, bold: true, align: 'center', width: COL.d });
    } else page.text(xd, y + 13.5, weight, { size: 6.5, bold: true, align: 'center', width: COL.d });
    y += HEAD;
  };

  header(true);
  for (const s of data.sections) {
    const heights = s.rows.map((r) => (r.tall ? TALL : ROW));
    ensure(HEAD + heights.reduce((n, h) => n + h, 0));
    sectionHead(s.key, s.unit, s.weight);
    s.rows.forEach((r, i) => {
      const h = heights[i];
      if (r.span > 0) {
        const gh = heights.slice(i, i + r.span).reduce((n, v) => n + v, 0);
        page.rect(M, y, COL.a, gh);
        const img = r.image ? imImage(r.image) : null;
        if (img) page.image(doc.image(img), M + 3, y + 2, COL.a - 6, gh - 4);
      }
      if (r.fill) page.rect(xb, y, COL.b, h, { rgb: IM_FILLS[r.fill] });
      else page.rect(xb, y, COL.b, h);
      page.rect(xc, y, COL.c, h);
      page.rect(xd, y, COL.d, h);
      const ty = y + h / 2 + 2.6;
      page.text(xb + 3, ty, fitText(r.label, 7.5, COL.b - 6), { size: 7.5 });
      if (r.qty != null) page.text(xc, ty + 0.6, String(r.qty), { size: 10, bold: true, align: 'center', width: COL.c });
      if (r.hasWeight) page.text(xd, ty + 0.6, fmtKg(r.grams ?? 0), { size: 9, bold: true, align: 'center', width: COL.d });
      y += h;
    });
  }
  if (data.others.length) {
    ensure(HEAD + ROW);
    sectionHead('ALTE PRODUSE', 'CANTITATE', 'GREUTATEA');
    for (const o of data.others) {
      ensure(ROW);
      page.rect(M, y, COL.a + COL.b, ROW);
      page.rect(xc, y, COL.c, ROW);
      page.rect(xd, y, COL.d, ROW);
      page.text(M + 3, y + 11.6, fitText(`${o.code} — ${o.name}`, 7.5, COL.a + COL.b - 6), { size: 7.5 });
      page.text(xc, y + 12.2, fitText(`${o.qty} ${o.unit}`, 9.5, COL.c - 4, true), { size: 9.5, bold: true, align: 'center', width: COL.c });
      page.text(xd, y + 12.2, '—', { size: 9, align: 'center', width: COL.d });
      y += ROW;
    }
  }
  ensure(34);
  y += 20;
  page.text(xc - 160, y, 'TOTAL GREUTATE :', { size: 9.5, bold: true, align: 'right', width: 160 + COL.c - 6 });
  page.text(xd, y + 0.5, `${fmtKg(data.totalGrams)} kg`, { size: 12, bold: true, align: 'center', width: COL.d });
  y += 8;
  if (data.others.length) {
    y += 12;
    page.text(M, y, 'Produsele din secțiunea „ALTE PRODUSE” nu au coeficient de greutate și nu sunt incluse în total.', { size: 8, color: GREY });
  }
  finishPages(doc, { note: `${BRAND.company} · Intrarea marfă ${p.docNo}${rev ? ' (corecție)' : ''} · generată automat (Takip)`, margin: M });
  return doc.toBuffer();
}
