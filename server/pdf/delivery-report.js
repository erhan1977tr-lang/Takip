// Teslimat raporu PDF'i (Paket 8, karar 196): raporun KOPYASINDAN (DeliveryReport.data — oluşturulduğu an) üretilir; sipariş,
// firma, teslim günü, durum, teslim edilen ürünler ve miktarlar, açıklama ve fotoğraflar. Fotoğraflar sınırlar içinde belgeye
// gömülür (EXIF yönüyle — telefon fotoğrafı doğru yönde), her fotoğrafın ayrıca güvenli bağlantısı yazılır (giriş + sipariş
// yetkisi gerekir; süreli bağlantı yok). Gömülemeyen fotoğraf (büyük, taranmamış, bozuk) yalnızca bağlantıyla listelenir.
// Ortak başlık (resmî GKH logosu, oranı korunur) ve ortak altbilgi (firma adı + sayfa / toplam — server/pdf/brand.js);
// Türkçe ve Romence harfler gömülü yazı tipiyle (pdf.js). Metinler çağırandan gelir (görenin dili).
import { PdfDoc, fitText, wrapText } from './pdf.js';
import { BRAND, brandImage, drawBrandLogo, finishPages } from './brand.js';

const M = 40;
const WIDTH = 515;
const ROW = 18;
const BLUE = [0.07, 0.36, 0.55];
const GREY = [0.45, 0.45, 0.45];
const PHOTO_BOX = 300;

/**
 * @param {{ items: { code: string, name: string, unit: string, qty: number }[],
 *   photos: { label: string, url: string, buf: Buffer | null }[] }} d
 *   photos: sırayla; buf: gömülecek içerik (yoksa yalnızca etiket + bağlantı)
 * @param {{ title: string, firm: string, subtitle: string, info: [string, string][], note: { label: string, text: string } | null,
 *   itemsTitle: string, photosTitle: string, noPhotos: string, notEmbedded: string, linkHint: string,
 *   cols: { code: string, product: string, unit: string, qty: string } }} text
 * @returns {Buffer}
 */
export function deliveryReportPdf(d, text) {
  const doc = new PdfDoc({ title: `${text.title} — ${text.firm}`, author: BRAND.company });
  const logo = brandImage(doc);
  const C = { code: { x: M, w: 90 }, product: { x: M + 90, w: 285 }, unit: { x: M + 375, w: 70 }, qty: { x: M + 445, w: 70 } };
  let page;
  let y = 0;
  /** @type {(() => void) | null} */
  let repeat = null;

  const newPage = (first) => {
    page = doc.addPage();
    if (first) {
      const tx = M + drawBrandLogo(page, logo, { x: M, y: 30, height: 56 }) + 16;
      page.text(tx, 46, fitText(text.title, 17, M + WIDTH - tx, true), { size: 17, bold: true, color: BLUE });
      page.text(tx, 64, fitText(text.firm, 11, M + WIDTH - tx, true), { size: 11, bold: true });
      page.text(tx, 80, fitText(text.subtitle, 9, M + WIDTH - tx), { size: 9, color: GREY });
      y = 104;
    } else {
      page.text(M, 36, fitText(`${text.title} — ${text.firm}`, 9, WIDTH), { size: 9, color: GREY });
      y = 50;
      repeat?.();
    }
  };
  const ensure = (h) => {
    if (y + h > page.height - 50) newPage(false);
  };
  const section = (title) => {
    ensure(ROW * 3);
    page.text(M, y + 14, title, { size: 10.5, bold: true, color: BLUE });
    y += 22;
  };

  newPage(true);
  // Bilgi satırları: etiket solda, değer sağında (uzun değer satıra bölünür)
  for (const [k, v] of text.info) {
    const lines = wrapText(v || '—', 9.5, WIDTH - 150);
    ensure(lines.length * 13 + 4);
    page.text(M, y + 10, fitText(k, 9, 140, true), { size: 9, bold: true, color: GREY });
    lines.forEach((l, i) => page.text(M + 150, y + 10 + i * 13, l, { size: 9.5 }));
    y += lines.length * 13 + 4;
  }
  if (text.note) {
    const lines = text.note.text.split('\n').flatMap((p) => wrapText(p, 9.5, WIDTH - 150));
    ensure(Math.min(lines.length, 4) * 13 + 4);
    page.text(M, y + 10, fitText(text.note.label, 9, 140, true), { size: 9, bold: true, color: GREY });
    for (const l of lines) {
      ensure(13);
      page.text(M + 150, y + 10, l, { size: 9.5 });
      y += 13;
    }
    y += 4;
  }
  y += 8;

  // Teslim edilen ürünler ve miktarlar
  section(text.itemsTitle);
  const head = () => {
    page.rect(M, y, WIDTH, ROW, { fill: 0.94, stroke: false });
    page.text(C.code.x + 3, y + 12.5, text.cols.code, { size: 7.5, bold: true });
    page.text(C.product.x + 3, y + 12.5, text.cols.product, { size: 7.5, bold: true });
    page.text(C.unit.x + 3, y + 12.5, text.cols.unit, { size: 7.5, bold: true });
    page.text(C.qty.x, y + 12.5, text.cols.qty, { size: 7.5, bold: true, align: 'right', width: C.qty.w - 3 });
    y += ROW;
  };
  repeat = head;
  head();
  for (const it of d.items) {
    ensure(ROW);
    page.text(C.code.x + 3, y + 12.5, fitText(it.code, 8, C.code.w - 6, true), { size: 8, bold: true });
    page.text(C.product.x + 3, y + 12.5, fitText(it.name, 8, C.product.w - 6), { size: 8 });
    page.text(C.unit.x + 3, y + 12.5, fitText(it.unit, 8, C.unit.w - 6), { size: 8 });
    page.text(C.qty.x, y + 12.5, String(it.qty), { size: 8, bold: true, align: 'right', width: C.qty.w - 3 });
    y += ROW;
    page.line(M, y, M + WIDTH, y, 0.4, 0.85);
  }
  repeat = null;
  y += 12;

  // Fotoğraflar: önce liste (her birinin güvenli bağlantısı), sonra gömülü görseller
  section(`${text.photosTitle} (${d.photos.length})`);
  if (d.photos.length === 0) {
    page.text(M, y + 10, text.noPhotos, { size: 9, color: GREY });
    y += 22;
  } else {
    // Görseller önce çözülür: çözülemeyen (bozuk / desteklenmeyen) fotoğraf listede "gömülmedi" diye işaretlenir
    const imgs = d.photos.map((p) => (p.buf ? doc.image(p.buf, { cache: false }) : null));
    for (const l of wrapText(text.linkHint, 8, WIDTH)) { ensure(12); page.text(M, y + 8, l, { size: 8, color: GREY }); y += 11; }
    y += 4;
    d.photos.forEach((p, i) => {
      ensure(30);
      page.text(M, y + 10, fitText(`${i + 1}. ${p.label}${imgs[i] ? '' : ` — ${text.notEmbedded}`}`, 8.5, WIDTH, true), { size: 8.5, bold: true });
      page.text(M + 12, y + 22, fitText(p.url, 7.5, WIDTH - 12), { size: 7.5, color: BLUE });
      y += 28;
    });
    d.photos.forEach((p, i) => {
      const img = imgs[i];
      if (!img) return;
      ensure(PHOTO_BOX + 24);
      page.text(M, y + 10, fitText(`${i + 1}. ${p.label}`, 8.5, WIDTH, true), { size: 8.5, bold: true });
      y += 16;
      page.rect(M, y, WIDTH, PHOTO_BOX, { stroke: true, width: 0.4 });
      page.image(img, M + 4, y + 4, WIDTH - 8, PHOTO_BOX - 8);
      y += PHOTO_BOX + 12;
    });
  }
  finishPages(doc, { margin: M });
  return doc.toBuffer();
}
