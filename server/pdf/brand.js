// PDF'lerde GKH kurumsal başlığı — ortak (karar 129). TAKİP'in ürettiği her şirket belgesi (teklif, Comanda Depozit,
// nakliye listesi ve ileride eklenecek belgeler) resmî logoyu buradan alır; logo belgeye GÖMÜLÜR (dış adres yok).
// Yeni bir PDF üretici yazarken: `const logo = brandImage(doc)` + ilk sayfanın başlığında `drawBrandLogo(...)`,
// belge yazarı için BRAND.company. Logo hiçbir zaman gerilmez: genişlik verilen yükseklikten ve logonun kendi oranından
// hesaplanır.
import { BRAND, brandLogoBytes, brandLogoSize } from '../branding/index.js';

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
