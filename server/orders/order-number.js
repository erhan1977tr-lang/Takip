// Müşteri sipariş numarası (karar 259): METİN olarak saklanır — "40", "40-1", "40-2", "001-1". Tire ve baştaki sıfırlar
// korunur; oluşturma, taslak, arama ve görüntüleme aynı değeri kullanır. Saf modül (veritabanı yok; tarayıcıda da çalışır).
//
//   Biçim : 1–10 rakamlık bölümler, aralarında tek tire (en çok 4 bölüm, toplam en çok 24 karakter); yalnızca sıfırlardan
//           oluşan numara ("0", "00-0") geçersiz. Sipariş no = firma kodu + bu değer (GLA40-1) — telafi eki (-T) harfle
//           başladığı için hiçbir müşteri numarasıyla çakışmaz.
//   Firma : müşteri numarayı kendi firma koduyla yazabilir ("ALE40-1"): kod, ardından rakam geliyorsa atılır ("40-1").
//           Başka firmanın kodu kabul edilmez (rakam / tire dışı karakter → geçersiz).
//   Öneri : bir sonraki numara = yalnızca rakamdan oluşan etkin numaraların en büyüğü + 1 (tireli numaralar sırayı
//           değiştirmez). Silinmiş siparişin numarası sayılmaz (karar 260).

export const CUSTOMER_NO_MAX = 24;
const NO_RE = /^\d{1,10}(?:-\d{1,10}){0,3}$/;

/**
 * @param {unknown} raw  formdaki metin (ya da eski çağıranlar için pozitif tam sayı)
 * @param {string | null} [prefix]  firmanın 3 harfli kodu (yazılmışsa atılır)
 * @returns {string | null}  geçerli numara ya da null
 */
export function parseCustomerOrderNo(raw, prefix = null) {
  let s;
  if (typeof raw === 'number') s = Number.isSafeInteger(raw) && raw > 0 ? String(raw) : '';
  else if (typeof raw === 'string') s = raw.trim().toUpperCase();
  else return null;
  const code = String(prefix ?? '').trim().toUpperCase();
  if (code && s.startsWith(code) && /\d/.test(s.charAt(code.length))) s = s.slice(code.length);
  if (!s || s.length > CUSTOMER_NO_MAX || !NO_RE.test(s) || !/[1-9]/.test(s)) return null;
  return s;
}

/** Yalnızca rakamdan oluşan numara mı ("40" evet, "40-1" hayır) — öneri sırası bunlardan hesaplanır */
export const isPlainNo = (s) => typeof s === 'string' && /^\d{1,15}$/.test(s);

/** Sipariş numaralarının doğal sırası: "9" < "10" < "10-1" < "10-2" (metin sıralaması "10" < "9" yapardı) */
export const compareOrderNo = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true, sensitivity: 'base' });

/**
 * Listeyi bir anahtara göre doğal numara sırasıyla dizer (kararlı; önce isteğe bağlı birincil anahtar).
 * @template T
 * @param {T[]} list  @param {(x: T) => unknown} noOf  @param {(x: T) => string} [groupOf]
 * @returns {T[]}
 */
export function sortByOrderNo(list, noOf, groupOf) {
  return [...list].sort((x, y) => {
    if (groupOf) {
      const gx = String(groupOf(x) ?? ''), gy = String(groupOf(y) ?? '');
      if (gx !== gy) return gx < gy ? -1 : 1;
    }
    return compareOrderNo(noOf(x), noOf(y));
  });
}
