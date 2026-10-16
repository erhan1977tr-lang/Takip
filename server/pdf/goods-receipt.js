// "INTRAREA MARFĂ" — depo giriş belgesi (PDF; 3.87.0, karar 282). Ürün sahibinin örnek formunun düzeni (Intrare_Depozit):
// üstte resmî GKH logosu, sağda DATA, başlık INTRAREA MARFĂ, altında kategori kategori ürünler (görsel, ürün, miktar). Örnekten
// farkı: yalnızca BU kabulde fiilen teslim alınan ürünler yazılır (boş katalog satırı yok) ve tedarikçi, tedarikçi sipariş no,
// kabul no / tarihi, irsaliye referansı eklenir. Ağırlık (GREUTATE) yazılmaz: katalogda ağırlık yoktur, değer tahmin edilmez.
// Fiyat, alış / satış tutarı, maliyet ya da kâr belgede YOKTUR (çağıran vermez). Metin Romence (depo Romanya'da).
import { PdfDoc, fitText, wrapText } from './pdf.js';
import { BRAND, brandImage, drawBrandLogo, finishPages } from './brand.js';

const M = 40;
const COL = { img: 64, qty: 80 };
const ROW = 22;
const HEAD = 20;

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10).split('-').reverse().join('.') : '');
/** Uzunluk (m): yalnızca ondalık kısmın sondaki sıfırları atılır ("6.000" → "6 m", "60" → "60 m", "6.500" → "6,5 m") */
const len = (s) => {
  if (!s) return '';
  const t = String(s);
  return `${(t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t).replace('.', ',')} m`;
};

/**
 * @param {object} p
 * @param {string} p.orderNo         tedarikçi sipariş no
 * @param {string} p.supplierName
 * @param {number} p.seq             kabul no (siparişte sıra)
 * @param {Date} p.receivedOn
 * @param {string | null} p.reference  aviz / irsaliye referansı
 * @param {string | null} p.note
 * @param {boolean} p.complete
 * @param {{ code: string, name: string }[]} p.categories  sıralı
 * @param {{ code: string, name: string, color: string | null, length: string | null, qty: number, unit: string, categoryCode: string | null, image: Buffer | null }[]} p.lines
 * @param {{ qty: number, unit: string }[]} p.totals   birim başına toplam (birimler toplanmaz)
 * @param {{ seq: number, createdAt: Date, reason: string }} [p.correction]  verilirse belge bir DÜZELTMEDİR (karar 286):
 *   başlık "CORECȚIE RECEPȚIE", orijinal recepția nr. (p.seq) referans olarak yazılır, miktarlar stoktan DÜŞÜLEN adetlerdir
 *   (eksi işaretiyle). Orijinal kabulün belgesi değişmez.
 * @returns {Buffer}
 */
export function goodsReceiptPdf(p) {
  const fix = p.correction ?? null;
  const docName = fix ? `Corectie receptie ${p.orderNo} #${p.seq} - ${fix.seq}` : `Intrarea marfa ${p.orderNo} #${p.seq}`;
  const doc = new PdfDoc({ title: docName, author: BRAND.company });
  const logo = brandImage(doc);
  let page;
  let y = 0;
  const width = () => page.width - 2 * M;
  const nameW = () => width() - COL.img - COL.qty;

  const header = (first) => {
    page = doc.addPage();
    if (first) {
      drawBrandLogo(page, logo, { x: M, y: 30, height: 70 });
      const lx = page.width - M - 250;
      const field = (label, value, yy) => {
        page.text(lx, yy, label, { size: 9.5, bold: true });
        page.text(lx + 124, yy, fitText(value ?? '', 10.5, 124, true), { size: 10.5, bold: true });
        page.line(lx + 122, yy + 4, page.width - M, yy + 4, 0.4, 0.6);
      };
      if (fix) {
        field('DATA :', day(fix.createdAt), 44);
        field('CORECȚIA NR. :', String(fix.seq), 64);
        field('LA RECEPȚIA NR. :', String(p.seq), 84);
        page.text(M, 128, 'CORECȚIE RECEPȚIE — INTRAREA MARFĂ', { size: 16, bold: true, align: 'center', width: width() });
      } else {
        field('DATA :', day(p.receivedOn), 44);
        field('RECEPȚIA NR. :', String(p.seq), 64);
        field('COMANDA FURNIZOR :', p.orderNo, 84);
        page.text(M, 128, 'INTRAREA MARFĂ', { size: 18, bold: true, align: 'center', width: width() });
      }
      const info = (label, value, yy) => {
        page.text(M, yy, label, { size: 9.5, bold: true, align: 'right', width: 120 });
        page.text(M + 128, yy, fitText(value ?? '—', 10.5, width() - 128, true), { size: 10.5, bold: true });
        page.line(M + 126, yy + 4, page.width - M, yy + 4, 0.4, 0.6);
      };
      info('FURNIZOR :', p.supplierName, 156);
      info(fix ? 'COMANDA FURNIZOR :' : 'AVIZ / REFERINȚĂ :', fix ? p.orderNo : p.reference ?? '—', 174);
      y = 190;
      if (fix) {
        info('RECEPȚIA ORIGINALĂ :', `nr. ${p.seq} din ${day(p.receivedOn)}${p.reference ? ` · ${p.reference}` : ''}`, 192);
        y = 208;
        for (const l of wrapText(`MOTIV: ${fix.reason}`, 8.5, width()).slice(0, 4)) { page.text(M, y + 4, l, { size: 8.5 }); y += 11; }
        y += 4;
      } else if (p.note) {
        for (const l of wrapText(`OBSERVAȚII: ${p.note}`, 8.5, width()).slice(0, 3)) { page.text(M, y + 4, l, { size: 8.5 }); y += 11; }
        y += 4;
      }
    } else {
      page.text(M, 36, fix ? `Corecție recepție — ${p.orderNo} — recepția nr. ${p.seq} — corecția nr. ${fix.seq}` : `Intrarea marfă — ${p.orderNo} — recepția nr. ${p.seq}`, { size: 9, color: [0.4, 0.4, 0.4] });
      y = 48;
    }
  };
  const ensure = (h) => {
    if (y + h > page.height - 40) header(false);
  };

  header(true);
  const known = new Set(p.categories.map((c) => c.code));
  const groups = [
    ...p.categories.map((c) => ({ name: c.name, rows: p.lines.filter((l) => l.categoryCode === c.code) })),
    { name: 'ALTE PRODUSE', rows: p.lines.filter((l) => !l.categoryCode || !known.has(l.categoryCode)) },
  ].filter((g) => g.rows.length);
  for (const g of groups) {
    ensure(HEAD + ROW);
    page.rect(M, y, width(), HEAD, { fill: 0.93 });
    page.line(M + COL.img + nameW(), y, M + COL.img + nameW(), y + HEAD);
    page.text(M, y + 14.5, g.name.toUpperCase(), { size: 12, bold: true, align: 'center', width: COL.img + nameW() });
    page.text(M + COL.img + nameW(), y + 13.5, fix ? 'CANTITATE SCĂZUTĂ' : 'CANTITATE', { size: fix ? 7 : 8, bold: true, align: 'center', width: COL.qty });
    y += HEAD;
    for (const r of g.rows) {
      ensure(ROW);
      page.rect(M, y, width(), ROW);
      page.line(M + COL.img, y, M + COL.img, y + ROW);
      page.line(M + COL.img + nameW(), y, M + COL.img + nameW(), y + ROW);
      if (r.image) page.image(doc.image(r.image), M + 2, y + 1.5, COL.img - 4, ROW - 3);
      page.text(M + COL.img + 4, y + 10, fitText(`${r.code} — ${r.name}`, 8.5, nameW() - 8, true), { size: 8.5, bold: true });
      const extra = [r.color ? `Culoare: ${r.color}` : '', r.length ? `Lungime: ${len(r.length)}` : ''].filter(Boolean).join(' · ');
      if (extra) page.text(M + COL.img + 4, y + 19, fitText(extra, 7.5, nameW() - 8), { size: 7.5, color: [0.35, 0.35, 0.35] });
      page.text(M + COL.img + nameW(), y + 15, fitText(`${fix ? '-' : ''}${r.qty} ${r.unit}`, 10.5, COL.qty - 4, true), { size: 10.5, bold: true, align: 'center', width: COL.qty });
      y += ROW;
    }
  }
  ensure(60);
  y += 16;
  page.text(M, y, fix ? `TOTAL CORECTAT (SCĂZUT DIN STOC): ${p.lines.length} poziții` : `TOTAL RECEPȚIONAT: ${p.lines.length} poziții`, { size: 10.5, bold: true });
  page.text(M + width() - 260, y, fitText(p.totals.map((t) => `${fix ? '-' : ''}${t.qty} ${t.unit}`).join(' + '), 11, 260, true), { size: 11, bold: true, align: 'right', width: 260 });
  y += 16;
  page.text(M, y, fix ? `Corecție la recepția nr. ${p.seq}. Documentul original al recepției rămâne neschimbat.`
    : p.complete ? 'Comanda furnizor a fost recepționată integral.' : 'Recepție parțială: restul comenzii urmează.', { size: 9, color: [0.35, 0.35, 0.35] });
  finishPages(doc, { note: `${BRAND.company} · ${fix ? `Corecție recepție ${p.orderNo} #${p.seq}/${fix.seq}` : `Intrarea marfă ${p.orderNo} #${p.seq}`} · generată automat (Takip)`, margin: M });
  return doc.toBuffer();
}
