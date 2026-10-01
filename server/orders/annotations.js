// Revizyon talebindeki çizim üstü işaretler (müşteri "Revizyon iste" ekranında koyar): iğne, dikdörtgen, serbest çizgi,
// metin. Konumlar sayfanın genişlik / yüksekliğine oranlıdır (0–1), böylece her ekran boyutunda aynı yere düşer.
// Tarayıcıdan gelen veri burada doğrulanır ve sadeleştirilir; DrawingRevision.annotations (JSON) olarak saklanır.
// İşaretler sürümün dosyasını değiştirmez; revizyon talebiyle birlikte geçmişte kalır.

export const ANNOTATION_TYPES = ['pin', 'rect', 'free', 'text'];
export const MAX_ANNOTATIONS = 200;
export const MAX_POINTS = 400;
export const MAX_ANNOTATION_TEXT = 500;

const unit = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, Math.round(v * 10000) / 10000)) : null);

/**
 * @param {unknown} raw      tarayıcıdan gelen dizi (ya da JSON metni)
 * @param {string[]} fileIds işaretlenebilecek dosyalar (karar verilen sürümün dosyaları)
 * @returns {{ fileId: string, page: number, type: string, x: number, y: number, w?: number, h?: number, points?: number[][], text: string }[]}
 */
export function cleanAnnotations(raw, fileIds) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const allowed = new Set(fileIds);
  const out = [];
  for (const a of list) {
    if (out.length >= MAX_ANNOTATIONS) break;
    if (!a || typeof a !== 'object' || !ANNOTATION_TYPES.includes(a.type) || !allowed.has(a.fileId)) continue;
    const page = Number.isInteger(a.page) && a.page >= 1 && a.page <= 500 ? a.page : 1;
    const x = unit(a.x), y = unit(a.y);
    if (x == null || y == null) continue;
    const item = { fileId: a.fileId, page, type: a.type, x, y, text: String(a.text ?? '').trim().slice(0, MAX_ANNOTATION_TEXT) };
    if (a.type === 'rect') {
      const w = unit(a.w), h = unit(a.h);
      if (!w || !h) continue;
      item.w = Math.min(w, 1 - x);
      item.h = Math.min(h, 1 - y);
    }
    if (a.type === 'free') {
      const pts = (Array.isArray(a.points) ? a.points : []).slice(0, MAX_POINTS)
        .map((p) => (Array.isArray(p) ? [unit(p[0]), unit(p[1])] : [null, null])).filter((p) => p[0] != null && p[1] != null);
      if (pts.length < 2) continue;
      item.points = pts;
    }
    out.push(item);
  }
  return out;
}
