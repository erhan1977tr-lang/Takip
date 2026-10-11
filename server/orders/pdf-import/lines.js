// Fabrika PDF'i aktarımı (karar 255): PDF metin parçalarından (pdf.js getTextContent — extract.js) satırlar.
// Saf modül: veritabanı, dosya ve ağ yok. Aynı sayfada taban çizgileri birbirine yakın parçalar bir satırdır; satırın
// parçaları soldan sağa dizilip tek boşlukla birleştirilir. Ayrıştırıcı (parse.js) yalnızca bu satır metinleriyle çalışır.

/** Aynı satır sayılan en büyük dikey uzaklık (punto). Fabrika formunda satırlar ~12 pt aralıklıdır; satır içi kayma < 1 pt. */
export const LINE_TOLERANCE = 3;

/**
 * Parçalar arasında boşluk: genişliği bilinen parçada (pdf.js) sonraki parça hemen bitişikse (ör. bir sözcüğün ayrı
 * basılmış harfleri) boşluk konmaz; arada boşluk varsa ya da genişlik bilinmiyorsa tek boşluk.
 * @param {{ page: number, x: number, y: number, str: string, w?: number, h?: number }[]} items  y: sayfanın üstünden aşağı doğru (punto)
 * @returns {{ page: number, y: number, text: string }[]}  sayfa sırasıyla, yukarıdan aşağı
 */
export function buildLines(items) {
  const byPage = new Map();
  for (const it of items ?? []) {
    const str = String(it?.str ?? '').replace(/\s+/g, ' ').trim();
    if (!str || !Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
    const page = Number.isInteger(it.page) ? it.page : 1;
    if (!byPage.has(page)) byPage.set(page, []);
    const raw = String(it.str);
    byPage.get(page).push({
      x: it.x, y: it.y, str, w: Number.isFinite(it.w) && it.w > 0 ? it.w : null, h: Number.isFinite(it.h) && it.h > 0 ? it.h : 8,
      lead: /^\s/.test(raw), trail: /\s$/.test(raw),
    });
  }
  const out = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const parts = byPage.get(page).sort((a, b) => a.y - b.y || a.x - b.x);
    /** @type {{ y: number, parts: { x: number, str: string }[] }[]} */
    const rows = [];
    for (const p of parts) {
      const row = rows[rows.length - 1];
      // Satırın ilk parçasının taban çizgisine göre: kayma birikmez
      if (row && p.y - row.y <= LINE_TOLERANCE) row.parts.push(p);
      else rows.push({ y: p.y, parts: [p] });
    }
    for (const r of rows) {
      const parts = r.parts.sort((a, b) => a.x - b.x);
      let text = '';
      parts.forEach((p, i) => {
        const prev = parts[i - 1];
        const touching = prev && prev.w != null && !prev.trail && !p.lead && p.x - (prev.x + prev.w) < Math.max(0.8, prev.h * 0.15);
        text += (i === 0 || touching ? '' : ' ') + p.str;
      });
      text = text.replace(/\s+/g, ' ').trim();
      if (text) out.push({ page, y: Math.round(r.y * 100) / 100, text });
    }
  }
  return out;
}
