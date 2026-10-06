// Uygulama içi yol doğrulaması (güvenlik denetimi 3.50.9 AUD-6 + ilgili "safeLink" maddesi, karar 145).
//
// Dışarıdan gelen ya da kayıtta duran bir değer "site içi yol" olarak kullanılacaksa (yönlendirme adresi — /dil?next=…,
// bildirim bağlantısı) TEK kural buradadır. Değeri sonunda TARAYICI bir adres olarak çözer ve tarayıcının ayrıştırıcısı
// (WHATWG URL) dize karşılaştırmasından farklı davranır: sekme / satır sonu karakterlerini adresin HER yerinden atar ve
// ters bölüyü bölü sayar — "/<sekme>/kotu.example" ve "/\kotu.example" tarayıcıda "//kotu.example" (başka site) olur.
// Bu yüzden "tek bölüyle başlıyor mu" diye bakmak yetmez.
//
// Kural (hepsi birden):
//   1. dize; 1 … 2000 karakter
//   2. TEK "/" ile başlar ("//" değil)
//   3. yalnızca yazdırılabilir ASCII (0x21 … 0x7E) ve ters bölü YOK — boşluk, sekme, satır sonu, öteki denetim
//      karakterleri, DEL ve ASCII dışı her şey reddedilir (böylece değer her zaman geçerli bir HTTP başlık değeridir)
//   4. sabit bir sahte http kaynağına göre ayrıştırıldığında TAM o kaynakta kalır ve yolu "//" ile başlamaz
//      (nokta parçalarının silinmesiyle "//…" yoluna dönüşen "/.//x", "/a/..//x", "/%2e%2e//x" de reddedilir)
// Geçerliyse değer DEĞİŞTİRİLMEDEN döner (normalleştirilmiş adres değil: sorgu ve parça bayt bayt aynı kalır); değilse null.
// Yüzde kodlaması yeniden ÇÖZÜLMEZ: "/%5cx" ya da "/%09/x" tarayıcıda da sitenin kendi yoludur.
//
// Bu dosya bilerek bağımsızdır (içe aktarma yok) ve tarayıcıda da çalışır (server/notifications/feed.js istemci
// paketine girer).

/** Kabul edilen en uzun değer */
export const INTERNAL_PATH_MAX = 2000;
/** Ayrıştırmanın yapıldığı sahte kaynak (hiçbir yere istek gönderilmez; ".invalid" ayrılmış bir addır) */
const ORIGIN = 'http://takip.invalid';
/** Tek "/" ile başlar; ardından yalnızca yazdırılabilir ASCII, ters bölü (0x5C) hariç */
const SHAPE = /^\/(?!\/)[\x21-\x5b\x5d-\x7e]*$/;

/**
 * Değer uygulama içi bir yol mu? Öyleyse AYNEN kendisi, değilse null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function internalPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > INTERNAL_PATH_MAX) return null;
  if (!SHAPE.test(value)) return null;
  let url;
  try {
    url = new URL(value, ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN || url.pathname.startsWith('//')) return null;
  return value;
}
