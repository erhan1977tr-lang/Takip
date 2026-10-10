// Revizyon talebindeki çizim üstü işaretler (müşteri "Revizyon iste" ekranında koyar — karar 162 ile kaldırılmış, Paket B / karar 227 ile geri geldi): iğne, dikdörtgen, serbest çizgi,
// metin. Konumlar sayfanın genişlik / yüksekliğine oranlıdır (0–1), böylece her ekran boyutunda aynı yere düşer.
// Tarayıcıdan gelen veri burada doğrulanır ve sadeleştirilir; DrawingRevision.annotations (JSON) olarak saklanır.
// İşaretler sürümün dosyasını değiştirmez; revizyon talebiyle birlikte geçmişte kalır.

export const ANNOTATION_TYPES = ['pin', 'rect', 'free', 'text'];
export const MAX_ANNOTATIONS = 200;
export const MAX_POINTS = 400;
export const MAX_ANNOTATION_TEXT = 500;
/** İşaret numarasının üst sınırı (kalıcı numara — P5, karar 244) */
export const MAX_ANNOTATION_NO = 999;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const unit = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, Math.round(v * 10000) / 10000)) : null);

/**
 * @param {unknown} raw      tarayıcıdan gelen dizi (ya da JSON metni)
 * @param {string[]} fileIds işaretlenebilecek dosyalar (karar verilen sürümün dosyaları)
 * Kalıcı kimlik ve numara (P5 — karar 244): her işaret bir kimlik (id) ve bir numara (no) taşır. Numara işaret konduğunda
 * verilir ve DEĞİŞMEZ: başka işaret silinse, sıra değişse ya da taslak yeniden açılsa da aynı kalır; nottaki "#<no>: …" maddesi
 * ve çizim üstündeki numara hep aynı işareti gösterir. Geçerli ve tekil id / no korunur; eksik, bozuk ya da yinelenen id
 * "m<sıra>" ile, numara mevcut en büyük numaradan sonra sırayla verilir (eski kayıtta — numarasız — sıra numarası: 1, 2, …).
 * @returns {{ id: string, no: number, fileId: string, page: number, type: string, x: number, y: number, w?: number, h?: number, points?: number[][], text: string }[]}
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
    out.push({ item, id: typeof a.id === 'string' && ID_RE.test(a.id) ? a.id : null, no: Number.isInteger(a.no) && a.no >= 1 && a.no <= MAX_ANNOTATION_NO ? a.no : null });
  }
  return withIdentity(out);
}

/** Kimlik ve numara ataması (cleanAnnotations): geçerli + tekil olan korunur, diğerleri sırayla verilir */
function withIdentity(list) {
  const ids = new Set(), nos = new Set();
  const keep = list.map(({ id, no }) => {
    const okId = id != null && !ids.has(id);
    if (okId) ids.add(id);
    const okNo = no != null && !nos.has(no);
    if (okNo) nos.add(no);
    return { id: okId ? id : null, no: okNo ? no : null };
  });
  let next = Math.max(0, ...nos);
  let seq = 0;
  return list.map(({ item }, i) => {
    let { id, no } = keep[i];
    while (id == null) {
      const cand = `m${++seq}`;
      if (!ids.has(cand)) { id = cand; ids.add(cand); }
    }
    if (no == null) no = ++next;
    return { id, no, ...item };
  });
}

/**
 * Ön denetim için (dosya listesi bilinmeden): işaretleri kendi dosya kimlikleriyle doğrular. Saklanan liste HER ZAMAN iş
 * akışında sürümün gerçek dosyalarıyla cleanAnnotations'tan geçer; bu işlev yalnızca formun boş olup olmadığını anlamak içindir.
 * @param {unknown} raw
 */
export function cleanAnnotationsLoose(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const ids = list.slice(0, MAX_ANNOTATIONS).map((a) => (a && typeof a === 'object' && typeof a.fileId === 'string' ? a.fileId : '')).filter(Boolean);
  return cleanAnnotations(list, ids);
}
