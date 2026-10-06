// FGO'nun verdiği belge bağlantıları (güvenlik denetimi 3.50.9 AUD-5 + AUD-7, karar 144).
//
// FGO belge keserken / factura/print ile bir PDF bağlantısı verir. Bu bağlantı DIŞ veridir: TAKİP onu yalnızca FGO'nun
// kendi adresiyse kullanır — indirirken, e-postaya yazarken, ekranda tıklanabilir gösterirken. Kural TEK yerdedir (pdfUrl);
// indirme (downloadFgoPdf) her yönlendirme adımını aynı kuralla yeniden doğrular ve yanıtı sınırlı okur.
//
// Bu dosya bilerek bağımsızdır (içe aktarma yok): sayfalar, e-posta ve işçi aynı kuralı çekinmeden kullanabilsin.

/** İndirilen PDF'in en büyük boyu (çözülmüş / açılmış bayt) */
export const PDF_MAX_BYTES = 15 * 1024 * 1024;
/** Yönlendirmeler ve gövdenin okunması dahil, bir indirmenin TOPLAM süresi */
export const PDF_TIMEOUT_MS = 20_000;
/** İzlenen en çok yönlendirme (ilk istek + 3 yönlendirme = en çok 4 istek) */
export const PDF_MAX_REDIRECTS = 3;

/**
 * Bağlantı FGO'nun kendi adresi mi? Öyleyse normalleştirilmiş adres, değilse null.
 *   - yalnızca https
 *   - sunucu adı tam olarak fgo.ro ya da *.fgo.ro (benzer adlar — evilfgo.ro, fgo.ro.kotu.example — değil)
 *   - kullanıcı adı / şifre içeren adres değil (https://fgo.ro@kotu.example ya da https://a:b@fgo.ro)
 *   - varsayılan dışı port değil (https://fgo.ro:8443; ":443" normalleştirmede düşer ve kabul edilir)
 * Dize olmayan değer, göreli adres, başka şema (http, javascript, file, data) → null.
 * @param {unknown} link
 * @returns {string | null}
 */
export function pdfUrl(link) {
  if (typeof link !== 'string' || link.length === 0 || link.length > 2000) return null;
  let u;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  if (u.port !== '') return null;
  if (u.hostname !== 'fgo.ro' && !u.hostname.endsWith('.fgo.ro')) return null;
  return u.toString();
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** @param {number} status @param {string} error */
const fail = (status, error) => ({ ok: /** @type {const} */ (false), status, error });
const quiet = (p) => Promise.resolve(p).catch(() => undefined);
/** Döngü denetimi için adres (parça — #… — sunucuya gitmez) */
const withoutHash = (url) => url.split('#', 1)[0];

/**
 * FGO'daki bir PDF'i sunucu tarafında indirir. Adres ve HER yönlendirme hedefi pdfUrl ile doğrulanır; doğrulanmayan bir
 * hedefe hiçbir istek gönderilmez. Yanıt akışla okunur ve sınırlanır (Content-Length'e güvenilmez).
 *
 *   Yönlendirme : otomatik izlenmez (redirect: 'manual'). 301 / 302 / 303 / 307 / 308 yanıtında Location, o anki adrese
 *                 göre çözülür ve pdfUrl'den geçirilir; geçmezse indirme hedefe gidilmeden biter. En çok 3 yönlendirme;
 *                 4.'sü ve daha önce gidilmiş bir adrese dönüş (döngü) reddedilir.
 *   Süre        : tek bir süre (20 sn) bütün adımları ve gövdenin okunmasını kapsar.
 *   Boy         : geçerli sayısal Content-Length sınırı aşıyorsa gövde okunmadan reddedilir; ayrıca okunan (çözülmüş)
 *                 bayt sayılır ve sınır aşılınca okuma iptal edilir — boyu bildirilmeyen (chunked) ve sıkıştırılmış
 *                 yanıtlar da sınırlıdır. Boş gövde ve "%PDF-" ile başlamayan yanıt reddedilir.
 *   Hata metni  : sabit, kısa metinlerdir; adres, Location ya da ağ hatasının ayrıntısı içermez (kayda / ekrana yazılır).
 *
 * @param {unknown} link
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, maxRedirects?: number }} [o]
 * @returns {Promise<{ ok: true, bytes: Buffer } | { ok: false, status: number, error: string }>}
 *   status: son yanıtın HTTP durumu (yanıt alınmadıysa / reddedildiyse 0)
 */
export async function downloadFgoPdf(link, { fetchImpl = fetch, timeoutMs = PDF_TIMEOUT_MS, maxBytes = PDF_MAX_BYTES, maxRedirects = PDF_MAX_REDIRECTS } = {}) {
  let url = pdfUrl(link);
  if (!url) return fail(0, 'PDF adresi FGO adresi değil');
  // Tek süre: yönlendirmeler + gövde. fetch'e de verilir; ayrıca her bekleme bu sürenin dolmasıyla yarışır (fetch'in
  // süreyi uygulamasına güvenilmez). Kendi zamanlayıcımız kullanılır (AbortSignal.timeout'unki süreci ayakta tutmaz).
  const deadline = new AbortController();
  const { signal } = deadline;
  const timer = setTimeout(() => deadline.abort(new DOMException('süre doldu', 'TimeoutError')), timeoutMs);
  const expired = new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  expired.catch(() => undefined);
  const within = (p) => Promise.race([p, expired]);
  /** Yanıt gövdesini bırakır (bağlantı kapanır); iptal de süreyle sınırlıdır ve hatası yutulur */
  const drop = (body) => quiet(body ? within(body.cancel()) : undefined);
  const seen = new Set();
  let reader = null;
  try {
    for (let redirects = 0; ; redirects++) {
      if (seen.has(withoutHash(url))) return fail(0, 'yönlendirme döngüsü');
      seen.add(withoutHash(url));
      const res = await within(fetchImpl(url, { redirect: 'manual', signal, headers: { accept: 'application/pdf' } }));
      // Yönlendirme izlenmiş bir yanıt (fetch 'manual'i uygulamadıysa) ya da okunamayan yönlendirme: kabul edilmez
      if (res.redirected || res.type === 'opaqueredirect') {
        await drop(res.body);
        return fail(0, 'beklenmeyen yönlendirme');
      }
      if (REDIRECTS.has(res.status)) {
        await drop(res.body);
        if (redirects >= maxRedirects) return fail(0, 'çok fazla yönlendirme');
        const location = res.headers.get('location');
        let next = null;
        try {
          next = location ? pdfUrl(new URL(location, url).toString()) : null;
        } catch {
          next = null;
        }
        // Hedef FGO adresi değilse oraya HİÇBİR istek gönderilmez
        if (!next) return fail(0, 'yönlendirme FGO dışı bir adrese');
        url = next;
        continue;
      }
      if (!res.ok) {
        await drop(res.body);
        return fail(res.status, `HTTP ${res.status}`);
      }
      // Bildirilen boy sınırı aşıyorsa gövde hiç okunmaz (bildirim yoksa / yanlışsa aşağıdaki sayım geçerlidir)
      const declared = (res.headers.get('content-length') ?? '').trim();
      if (/^\d+$/.test(declared) && Number(declared) > maxBytes) {
        await drop(res.body);
        return fail(0, 'PDF çok büyük');
      }
      if (!res.body) return fail(0, 'PDF boş');
      reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      let checked = false;
      for (;;) {
        const { done, value } = await within(reader.read());
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > maxBytes) return fail(0, 'PDF çok büyük');
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        // İlk 5 bayt gelir gelmez: PDF değilse (HTML giriş sayfası, JSON hata …) gerisi okunmaz
        if (!checked && total >= 5) {
          checked = true;
          const head = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
          if (head.subarray(0, 5).toString('latin1') !== '%PDF-') return fail(0, 'yanıt PDF değil');
        }
      }
      if (total === 0) return fail(0, 'PDF boş');
      if (!checked) return fail(0, 'yanıt PDF değil');
      reader = null;
      return { ok: true, bytes: Buffer.concat(chunks, total) };
    }
  } catch (e) {
    // Ağ / süre hatası: ayrıntı (adres, IP, Location) hata metnine yazılmaz
    return fail(0, signal.aborted || e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'zaman aşımı' : 'bağlantı hatası');
  } finally {
    // Yarıda bırakılan okuma (sınır, PDF değil, süre) iptal edilir: bağlantı kapanır, gövdenin gerisi alınmaz
    if (reader) await drop(reader);
    clearTimeout(timer);
  }
}
