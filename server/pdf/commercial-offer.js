// Bağımsız ticari teklifin MÜŞTERİ PDF'i (3.83.0, karar 277) — Romence, GKH logosu, örnek teklif düzeni: üst bilgi (tarih,
// "OFERTA", numara, firma), cam tablosu (dimensiune, cantitate, suprafață, U.M., preț / mp, preț fără TVA), profil / aksesuar
// tablosu (kategori başlıklarıyla; cod, culoare, U.M., cant., preț, total), toplamlar, numaralı koşullar + "*" notlar, iletişim.
//
// Girdi YALNIZCA customerView(...) (server/commercial/rules.js): maliyet, kâr, marj, nakliye / gümrük maliyeti, iç not burada
// YOKTUR — üretici onlara erişemez. Kesinleşmemiş sürüm "taslak" damgası taşır.
import { PdfDoc, fitText, wrapText } from './pdf.js';
import { BRAND, brandImage, drawBrandLogo, finishPages } from './brand.js';

const M = 40;
const WIDTH = 515;
const ROW = 17;
const BLUE = [0.07, 0.36, 0.55];
const GREY = [0.42, 0.42, 0.42];
const RED = [0.75, 0.1, 0.1];
// Sütunlar (toplam 515)
const GW = { n: 18, desc: 170, dim: 72, qty: 44, m2: 54, um: 30, price: 58, amount: 69 };
const PW = { n: 18, desc: 168, code: 64, color: 50, um: 36, qty: 46, price: 63, amount: 70 };

const fmt = (v, frac) => new Intl.NumberFormat('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac }).format(Number(v));
const money = (v) => `${fmt(v, 2)} €`;
/** Fiyat: en az 2, en çok 4 ondalık (girilen hassasiyet korunur) */
const price = (v) => {
  const frac = Math.min(4, Math.max(2, (String(v).split('.')[1] ?? '').replace(/0+$/, '').length));
  return `${fmt(v, frac)} €`;
};
/** Miktar: tam sayı ya da en çok 3 ondalık */
const qty = (v) => {
  const frac = Math.min(3, (String(v).split('.')[1] ?? '').replace(/0+$/, '').length);
  return fmt(v, frac);
};
const dateText = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso);
const colsOf = (W) => {
  let x = M;
  const out = {};
  for (const [k, w] of Object.entries(W)) { out[k] = { x, w }; x += w; }
  return out;
};

/**
 * @param {ReturnType<typeof import('../commercial/rules.js').customerView>} v
 * @param {Record<string, any>} t  Romence metinler (commercial.pdf.* — route çevirir)
 * @param {{ address: string, phone: string, web: readonly string[], email: string }} contact
 * @returns {Buffer}
 */
export function commercialOfferPdf(v, t, contact) {
  const doc = new PdfDoc({ title: `${t.title} ${v.no}`, author: BRAND.company });
  const logo = brandImage(doc);
  let page;
  let y = 0;
  const bottom = () => page.height - 50;
  const newPage = (first) => {
    page = doc.addPage();
    if (first) {
      drawBrandLogo(page, logo, { x: M, y: 28, height: 52 });
      page.text(M + WIDTH - 180, 40, dateText(v.date), { size: 10, align: 'right', width: 180 });
      page.text(M, 64, t.title, { size: 20, bold: true, color: BLUE, align: 'center', width: WIDTH });
      page.text(M + WIDTH - 180, 64, `${t.no} : ${v.no}`, { size: 11, bold: true, align: 'right', width: 180 });
      if (v.version > 1) page.text(M + WIDTH - 180, 78, `${t.revision} ${v.version}`, { size: 8, color: GREY, align: 'right', width: 180 });
      if (v.draft) page.text(M, 84, t.draft, { size: 9, bold: true, color: RED, align: 'center', width: WIDTH });
      page.text(M, 104, `${t.firm} : `, { size: 11, bold: true });
      page.text(M + 46, 104, fitText(v.firmName, 11, WIDTH - 46, true), { size: 11, bold: true });
      y = 122;
    } else {
      page.text(M, 36, fitText(`${t.title} ${t.no} ${v.no} — ${v.firmName}${v.draft ? ` — ${t.draft}` : ''}`, 8.5, WIDTH), { size: 8.5, color: GREY });
      y = 50;
    }
  };
  const ensure = (h) => { if (y + h > bottom()) { newPage(false); return true; } return false; };
  const header = (C, labels, h = 24) => {
    ensure(h + ROW);
    page.rect(M, y, WIDTH, h, { fill: 0.93, stroke: false });
    for (const [k, label, align] of labels) {
      const lines = String(label).split('\n');
      lines.forEach((ln, i) => page.text(C[k].x + (align === 'left' ? 3 : 0), y + (lines.length > 1 ? 10 + i * 9 : 15), fitText(ln, 7.5, C[k].w - 4, true), { size: 7.5, bold: true, align: align ?? 'right', width: C[k].w - 3 }));
    }
    y += h;
  };
  const cell = (C, k, s, o = {}) => page.text(C[k].x + (o.align === 'left' ? 3 : 0), y + 12, fitText(String(s ?? ''), 8, C[k].w - 5, !!o.bold), { size: 8, align: o.align ?? 'right', width: C[k].w - 3, bold: !!o.bold, color: o.color });
  const rule = () => page.line(M, y, M + WIDTH, y, 0.4, 0.85);
  const subtotal = (label, amount, extra) => {
    ensure(ROW + 4);
    y += 2;
    page.line(M + WIDTH - 230, y, M + WIDTH, y, 0.8, 0.3);
    page.text(M + WIDTH - 230, y + 13, label, { size: 8.5, bold: true });
    if (extra) page.text(M + WIDTH - 330, y + 13, extra, { size: 8, color: GREY, align: 'right', width: 95 });
    page.text(M + WIDTH - 100, y + 13, money(amount), { size: 9, bold: true, align: 'right', width: 100 });
    y += ROW + 8;
  };

  newPage(true);

  // ---- Cam
  if (v.glass.length) {
    const C = colsOf(GW);
    const glassHead = () => header(C, [['n', '#', 'left'], ['desc', t.desc, 'left'], ['dim', t.dimension, 'center'], ['qty', t.quantity], ['m2', t.surface], ['um', t.um, 'center'], ['price', t.pricePerM2], ['amount', t.amountNoVat]]);
    glassHead();
    // Cam satırı numaralı; altındaki CNC / delik numarasız (ölçüsüz, m² yok, birim BUC); sandık parası numaralı ayrı kalem
    const row = (n, text, r, { dims = null, m2 = null, um, indent = 0 }) => {
      const lines = wrapText(text, 8, C.desc.w - 6 - indent).slice(0, 3);
      const h = Math.max(ROW, 6 + lines.length * 10);
      if (ensure(h)) glassHead();
      if (n != null) cell(C, 'n', n, { align: 'left' });
      lines.forEach((ln, j) => page.text(C.desc.x + 3 + indent, y + 12 + j * 10, ln, { size: 8 }));
      if (dims) page.text(C.dim.x, y + 12, dims, { size: 8, align: 'center', width: C.dim.w });
      cell(C, 'qty', qty(r.qty));
      if (m2 != null) cell(C, 'm2', fmt(m2, 3));
      page.text(C.um.x, y + 12, um, { size: 8, align: 'center', width: C.um.w });
      cell(C, 'price', price(r.price));
      cell(C, 'amount', money(r.amount), { bold: true });
      y += h;
      rule();
    };
    let n = 0;
    v.glass.forEach((r) => {
      n += 1;
      if (r.crate) { row(n, r.description, r, { um: t.piece }); return; }
      row(n, r.description, r, { dims: `${r.en}  x  ${r.boy}`, m2: r.m2, um: 'MP' });
      for (const o of r.ops ?? []) {
        const label = t.ops[o.kind] ?? o.kind;
        row(null, o.description ? `${label} – ${o.description}` : label, o, { um: t.piece, indent: 10 });
      }
    });
    subtotal(t.glassTotal, v.totals.glass, `${fmt(v.totals.glassM2, 3)} mp`);
    y += 6;
  }

  // ---- Profil / aksesuar (kategori başlıklarıyla; numara her başlıkta yeniden)
  if (v.profileGroups.length) {
    const C = colsOf(PW);
    const profHead = () => header(C, [['n', '#', 'left'], ['desc', t.desc, 'left'], ['code', t.code, 'center'], ['color', t.color, 'center'], ['um', t.um, 'center'], ['qty', t.qtyShort], ['price', t.unitPrice], ['amount', t.amountTotalNoVat]]);
    profHead();
    v.profileGroups.forEach((g, gi) => {
      if (g.title && (gi > 0 || v.profileGroups.length > 1)) {
        if (ensure(ROW * 2)) profHead();
        page.text(M, y + 12, g.title, { size: 8.5, bold: true, color: BLUE, align: 'center', width: C.desc.x + C.desc.w - M + 60 });
        y += ROW;
      }
      g.rows.forEach((r, i) => {
        const lines = wrapText(r.description, 8, C.desc.w - 6).slice(0, 3);
        const h = Math.max(ROW, 6 + lines.length * 10);
        if (ensure(h)) profHead();
        cell(C, 'n', i + 1, { align: 'left' });
        lines.forEach((ln, j) => page.text(C.desc.x + 3, y + 12 + j * 10, ln, { size: 8 }));
        page.text(C.code.x, y + 12, fitText(r.code, 8, C.code.w - 4), { size: 8, align: 'center', width: C.code.w });
        page.text(C.color.x, y + 12, fitText(r.color, 8, C.color.w - 4), { size: 8, align: 'center', width: C.color.w });
        page.text(C.um.x, y + 12, fitText(r.unit, 8, C.um.w - 2), { size: 8, align: 'center', width: C.um.w });
        cell(C, 'qty', qty(r.qty));
        cell(C, 'price', price(r.price));
        cell(C, 'amount', money(r.amount), { bold: true });
        y += h;
        rule();
      });
    });
    subtotal(t.profileTotal, v.totals.profile);
    y += 6;
  }

  // ---- Genel toplam
  ensure(34);
  page.rect(M + WIDTH - 260, y, 260, 24, { fill: 0.93, stroke: false });
  page.text(M + WIDTH - 252, y + 16, t.grandTotal, { size: 10.5, bold: true, color: BLUE });
  page.text(M + WIDTH - 130, y + 16, money(v.totals.total), { size: 11, bold: true, align: 'right', width: 122 });
  y += 40;

  // ---- Koşullar (numaralı) ve "*" notlar
  let n = 0;
  for (const term of v.terms) {
    const star = term.startsWith('*');
    const text = star ? term : `${++n}- ${term}`;
    for (const ln of wrapText(text, 8.5, WIDTH)) {
      ensure(12);
      page.text(M, y, ln, { size: 8.5, color: star ? GREY : undefined });
      y += 12;
    }
    if (!star) y += 1;
  }

  // ---- İletişim (son sayfanın altında)
  ensure(46);
  y = Math.max(y + 14, bottom() - 34);
  page.line(M, y - 10, M + WIDTH, y - 10, 0.6, 0.75);
  page.text(M, y, `${t.address} :`, { size: 8, bold: true });
  page.text(M, y + 11, fitText(contact.address, 8, WIDTH - 120), { size: 8 });
  page.text(M + WIDTH - 120, y + 11, contact.phone, { size: 8, align: 'right', width: 120 });
  const web = [...contact.web, contact.email];
  const slot = WIDTH / web.length;
  web.forEach((w, i) => page.text(M + i * slot, y + 23, fitText(w, 8, slot - 4), { size: 8, color: BLUE, align: 'center', width: slot }));

  finishPages(doc);
  return doc.toBuffer();
}
