// GKH kurumsal kimliği — TEK kaynak (karar 129). TAKİP'in ürettiği şirket PDF'leri (server/pdf/brand.js) ve bütün HTML
// e-postalar (server/mail/layout.js) resmî GKH Trading Invest logosunu buradan alır; logo hiçbir yerde ayrıca kopyalanmaz.
//   Kalıcı kaynak dosya : assets/brand/gkh-trading-invest-logo.png ya da .jpg (klasörde bu adla TEK dosya; adı LOGO.file)
//   Gömülü kopya        : server/branding/logo.js (node scripts/brand-logo.mjs ile dosyadan üretilir; test eşitliği denetler)
// Logo dış adresten yüklenmez, geçici dosya yoluna bağlı değildir. En-boy oranı her kullanımda korunur (gerilmez, kırpılmaz).
import { LOGO } from './logo.js';

export const BRAND = Object.freeze({
  company: 'GKH Trading Invest SRL',
  logo: Object.freeze({ file: LOGO.file, mime: LOGO.mime, width: LOGO.width, height: LOGO.height, sha256: LOGO.sha256 }),
});

let bytes;
/** Logonun baytları (PDF'e gömmek / e-postaya eklemek için). @returns {Buffer} */
export function brandLogoBytes() {
  bytes ??= Buffer.from(LOGO.base64, 'base64');
  return bytes;
}

/**
 * Verilen yüksekliğe karşılık gelen genişlik (ya da tersi) — oran korunur.
 * @param {{ width?: number, height?: number }} box
 * @returns {{ width: number, height: number }}
 */
export function brandLogoSize({ width, height }) {
  const ratio = LOGO.width / LOGO.height;
  if (height != null) return { width: height * ratio, height };
  if (width != null) return { width, height: width / ratio };
  return { width: LOGO.width, height: LOGO.height };
}
