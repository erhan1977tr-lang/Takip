// AutoCAD renk dizini (ACI, 1–255) → "#rrggbb". Bağımlılıksız; önizleme hizmetinde ve testlerde kullanılır.
// 1–9 standart renkler; 10–249 ton (24 ton × 10 çeşit: çift = tam doygun, tek = yarı doygun; parlaklık 5 kademe);
// 250–255 gri tonları. 7 (beyaz / siyah) koyu zeminde beyazdır — önizleme koyu zeminde çizer (CAD alışkanlığı).

const BASE = {
  1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255], 6: [255, 0, 255],
  7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192],
  250: [51, 51, 51], 251: [80, 80, 80], 252: [105, 105, 105], 253: [130, 130, 130], 254: [190, 190, 190], 255: [255, 255, 255],
};
const LEVELS = [1, 0.65, 0.5, 0.3, 0.15];

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** HSV (h derece, s ve v 0–1) → RGB */
function hsv(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * ACI renk dizini → "#rrggbb"; geçersiz dizin → null
 * @param {number} i
 */
export function aciColor(i) {
  const n = Math.abs(Math.trunc(Number(i)));
  if (!Number.isFinite(n) || n < 1 || n > 255) return null;
  if (BASE[n]) return hex(BASE[n]);
  const hue = (Math.floor(n / 10) - 1) * 15;
  const v = n % 10;
  return hex(hsv(hue, v % 2 === 0 ? 1 : 0.5, LEVELS[Math.floor(v / 2)]));
}

/** 24 bit gerçek renk (DXF 420) → "#rrggbb"; geçersiz → null */
export function trueColor(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffff) return null;
  return `#${n.toString(16).padStart(6, '0')}`;
}
