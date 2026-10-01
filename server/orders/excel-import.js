// Teklif tablosuna Excel'den aktarma (satış, sipariş sayfası → "Excel'den Aktar"): müşterinin yüklediği .xlsx'in
// satırları; satış Genişlik / Yükseklik / Adet sütunlarını seçer. Cam tipi Excel'den alınmaz — siparişteki cam tüm
// satırlara uygulanır (OfferEditor). Burada yalnızca satır doğrulama var; fiyat ve hesap teklif tablosunun mevcut kuralıdır.
// Saf fonksiyon: tarayıcıda (ön izleme) ve testte aynı.

export const IMPORT_MAX_ROWS = 1000;
export const IMPORT_MAX_COLS = 30;

/** Hücre → sayı: 1200 · "1200" · "1.200" (binlik) · "1200,5" / "1200.5"; geçersiz → NaN, boş → null */
export function cellNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = String(v).trim().replace(/\s/g, '').replace(/mm$/i, '');
  if (s === '') return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

const empty = (v) => v == null || String(v).trim() === '';

/**
 * Satırları doğrular. map: sütun indeksleri (0 tabanlı). Tamamen boş satır atlanır.
 * Genişlik ve yükseklik sayı ve > 0 (mm, tam sayıya yuvarlanır); adet tam sayı ve > 0.
 * @param {(string | number | boolean | null)[][]} rows
 * @param {{ width: number, height: number, qty: number }} map
 * @param {{ skipHeader?: boolean }} [o]  ilk satır başlıksa atlanır
 * @returns {{ rows: { line: number, en: number | null, boy: number | null, adet: number | null, errors: ('width' | 'height' | 'qty')[] }[], valid: number, invalid: number }}
 *   line: Excel'deki satır numarası (1 tabanlı)
 */
export function validateImportRows(rows, map, { skipHeader = false } = {}) {
  const out = [];
  rows.forEach((r, i) => {
    if (skipHeader && i === 0) return;
    if (!r || r.every(empty)) return;
    const w = cellNumber(r[map.width]);
    const h = cellNumber(r[map.height]);
    const q = cellNumber(r[map.qty]);
    const errors = [];
    if (!(typeof w === 'number' && w > 0)) errors.push('width');
    if (!(typeof h === 'number' && h > 0)) errors.push('height');
    if (!(typeof q === 'number' && Number.isInteger(q) && q > 0)) errors.push('qty');
    out.push({
      line: i + 1,
      en: typeof w === 'number' && w > 0 ? Math.round(w) : null,
      boy: typeof h === 'number' && h > 0 ? Math.round(h) : null,
      adet: typeof q === 'number' && Number.isInteger(q) && q > 0 ? q : null,
      errors,
    });
  });
  const valid = out.filter((x) => x.errors.length === 0).length;
  return { rows: out, valid, invalid: out.length - valid };
}

/** İlk satır başlık gibi mi (seçili sütunlardan biri sayı değil ve boş değil) */
export function looksLikeHeader(rows, map) {
  const r = rows[0];
  if (!r) return false;
  return [map.width, map.height, map.qty].some((c) => !empty(r[c]) && Number.isNaN(cellNumber(r[c])));
}
