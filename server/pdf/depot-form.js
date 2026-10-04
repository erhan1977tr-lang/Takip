// "Comanda Depozit" formu (PDF): ürün sahibinin Excel formunun düzeni (Comanda_Depozit.xls) — üstte logo, DATA,
// DATA DE LIVRARE, FIRMA, TELEFON, NR MASINI; altında kategori kategori tüm ürünler (görsel, ad, adet). Siparişteki
// ürünlerin adedi yazılır ve satır vurgulanır. Metin Romence (depo Romanya'da).
import { PdfDoc, fitText, wrapText } from './pdf.js';
import { BRAND, brandImage, drawBrandLogo } from './brand.js';

const M = 40; // kenar boşluğu
const COL = { img: 64, qty: 90 };
const ROW = 19;
const HEAD = 20;

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10).split('-').reverse().join('.') : '');

/**
 * @param {object} p
 * @param {string} p.orderNo
 * @param {string} p.firmName
 * @param {string | null} p.phone
 * @param {string | null} p.plate
 * @param {Date | null} p.pickupDate   DATA DE LIVRARE
 * @param {Date} p.date                DATA (gönderim günü)
 * @param {{ code: string, name: string, unit: string }[]} p.categories  sıralı; unit: kategorinin birimi (CUTII…)
 * @param {{ id: string | null, code: string, categoryCode: string, name: string, image: Buffer | null }[]} p.products  sıralı (formda görünecek ürünler)
 * @param {Map<string, number>} p.qty  ürün kodu → adet (siparişteki)
 * @param {string | null} [p.note]     müşterinin notu (varsa formun altında)
 * @returns {Buffer}
 */
export function depotFormPdf(p) {
  const doc = new PdfDoc({ title: `Comanda depozit ${p.orderNo}`, author: BRAND.company });
  const logo = brandImage(doc); // resmî GKH logosu (ortak başlık — server/pdf/brand.js)
  let page;
  let y = 0;
  const width = () => page.width - 2 * M;
  const nameW = () => width() - COL.img - COL.qty;

  const header = (first) => {
    page = doc.addPage();
    if (first) {
      drawBrandLogo(page, logo, { x: M, y: 30, height: 84 }); // solda; sağdaki tarih / sipariş alanlarına taşmaz
      const lx = page.width - M - 230;
      const field = (label, value, yy) => {
        page.text(lx, yy, label, { size: 10, bold: true });
        page.text(lx + 110, yy, value, { size: 11, bold: true });
        page.line(lx + 108, yy + 4, page.width - M, yy + 4, 0.4, 0.6);
      };
      field('DATA :', day(p.date), 48);
      field('DATA DE LIVRARE :', day(p.pickupDate), 70);
      field('COMANDA :', p.orderNo, 92);
      const info = (label, value, yy) => {
        page.text(M + 100, yy, label, { size: 10, bold: true, align: 'right', width: 70 });
        page.text(M + 178, yy, fitText(value ?? '', 11, width() - 178, true), { size: 11, bold: true });
        page.line(M + 176, yy + 4, page.width - M, yy + 4, 0.4, 0.6);
      };
      info('FIRMA :', p.firmName, 142);
      info('TELEFON :', p.phone, 160);
      info('NR MASINI :', p.plate, 178);
      y = 192;
      if (p.note) {
        // Müşterinin notu tablonun üstünde (en fazla 2 satır)
        const lines = wrapText(`OBSERVAȚII: ${p.note}`, 8.5, width()).slice(0, 2);
        for (const l of lines) { page.text(M, y + 4, l, { size: 8.5 }); y += 11; }
        y += 4;
      }
    } else {
      page.text(M, 36, `Comanda depozit ${p.orderNo} — ${p.firmName}`, { size: 9, color: [0.4, 0.4, 0.4] });
      y = 48;
    }
  };

  const ensure = (h) => {
    if (y + h > page.height - 34) header(false);
  };

  header(true);
  for (const cat of p.categories) {
    const rows = p.products.filter((x) => x.categoryCode === cat.code);
    if (!rows.length) continue;
    ensure(HEAD + ROW);
    page.rect(M, y, width(), HEAD, { fill: 0.93 });
    page.line(M + COL.img + nameW(), y, M + COL.img + nameW(), y + HEAD);
    page.text(M, y + 14.5, cat.name.toUpperCase(), { size: 12, bold: true, align: 'center', width: COL.img + nameW() });
    page.text(M + COL.img + nameW(), y + 13.5, cat.unit.toUpperCase(), { size: 8, bold: true, align: 'center', width: COL.qty });
    y += HEAD;
    for (const r of rows) {
      ensure(ROW);
      const q = p.qty.get(r.code) ?? 0;
      const hit = q > 0;
      if (hit) page.rect(M + COL.img, y, nameW() + COL.qty, ROW, { fill: 0.88, stroke: false });
      page.rect(M, y, width(), ROW);
      page.line(M + COL.img, y, M + COL.img, y + ROW);
      page.line(M + COL.img + nameW(), y, M + COL.img + nameW(), y + ROW);
      if (r.image) page.image(doc.image(r.image), M + 2, y + 1.5, COL.img - 4, ROW - 3);
      page.text(M + COL.img + 4, y + 12.8, fitText(r.name, hit ? 8.5 : 8, nameW() - 8, hit), { size: hit ? 8.5 : 8, bold: hit });
      if (hit) page.text(M + COL.img + nameW(), y + 13.8, String(q), { size: 11.5, bold: true, align: 'center', width: COL.qty });
      y += ROW;
    }
  }
  const pages = doc.pages.length;
  doc.pages.forEach((pg, i) => {
    pg.text(M, pg.height - 24, `Comanda ${p.orderNo} · generată automat (Takip)`, { size: 7.5, color: [0.45, 0.45, 0.45] });
    pg.text(pg.width - M - 80, pg.height - 24, `${i + 1} / ${pages}`, { size: 7.5, color: [0.45, 0.45, 0.45], align: 'right', width: 80 });
  });
  return doc.toBuffer();
}
