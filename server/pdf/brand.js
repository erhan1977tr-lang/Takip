// PDF'lerde GKH kurumsal başlığı — ortak (karar 129). TAKİP'in ürettiği her şirket belgesi (teklif, Comanda Depozit,
// nakliye listesi ve ileride eklenecek belgeler) resmî logoyu buradan alır; logo belgeye GÖMÜLÜR (dış adres yok).
// Yeni bir PDF üretici yazarken: `const logo = brandImage(doc)` + ilk sayfanın başlığında `drawBrandLogo(...)`,
// belge yazarı için BRAND.company. Logo hiçbir zaman gerilmez: genişlik verilen yükseklikten ve logonun kendi oranından
// hesaplanır.
import { BRAND, brandLogoBytes, brandLogoSize } from '../branding/index.js';
import { fitText } from './pdf.js';

export { BRAND };

/**
 * Resmî logoyu belgeye ekler (belge başına bir kez; aynı içerik yeniden eklenmez).
 * @param {import('./pdf.js').PdfDoc} doc
 */
export const brandImage = (doc) => doc.image(brandLogoBytes());

/**
 * Logoyu sol üst köşesi (x, y) olacak biçimde, verilen yükseklikte çizer; çizilen genişliği döner (oran korunur).
 * align 'right': x, logonun SAĞ kenarıdır.
 * @param {{ image: Function }} page
 * @param {any} img  brandImage(doc) sonucu
 * @param {{ x: number, y: number, height: number, align?: 'left' | 'right' }} o
 * @returns {number} çizilen genişlik (pt)
 */
export function drawBrandLogo(page, img, { x, y, height, align = 'left' }) {
  const { width } = brandLogoSize({ height });
  page.image(img, align === 'right' ? x - width : x, y, width, height);
  return width;
}

const FOOT_GREY = [0.45, 0.45, 0.45];
/**
 * Ortak altbilgi (Paket 7, karar 190): her sayfanın altında solda not (verilmezse resmî firma adı — BRAND.company), sağda
 * "sayfa / toplam". Bütün sayfalar çizildikten sonra bir kez çağrılır; TAKİP'in her PDF üreticisi bunu kullanır.
 * @param {{ pages: { width: number, height: number, text: Function }[] }} doc  PdfDoc
 * @param {{ note?: string, margin?: number }} [o]
 */
export function finishPages(doc, { note = BRAND.company, margin = 40 } = {}) {
  const pages = doc.pages.length;
  doc.pages.forEach((pg, i) => {
    if (note) pg.text(margin, pg.height - 24, fitText(note, 7.5, pg.width - 2 * margin - 100), { size: 7.5, color: FOOT_GREY });
    pg.text(pg.width - margin - 80, pg.height - 24, `${i + 1} / ${pages}`, { size: 7.5, color: FOOT_GREY, align: 'right', width: 80 });
  });
}
