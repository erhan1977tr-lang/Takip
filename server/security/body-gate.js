// Gövde kapısı (güvenlik denetimi AUD-4, karar 143) — vekil (Caddy) büyük bir istek gövdesini uygulamaya İLETMEDEN önce
// "bu istemci büyük gövde gönderebilir mi?" diye sorar; yanıt bu dosyadaki kuraldan gelir.
//
// Neden: sunucu işlemleri (Server Actions) formun bulunduğu SAYFANIN adresine POST edilir ve Next gövdenin tamamını,
// işlem (ve içindeki oturum / yetki denetimi) çalışmadan ÖNCE okur. Büyük gövdeye izin verilen sayfalarda (dosya yükleme
// formu olanlar) giriş yapmamış bir istemci de yüzlerce MB'lık gövdeyi uygulamanın belleğine okutabiliyordu.
//
// Akış (deploy/Caddyfile): yükleme sayfalarına gelen, gövdesi küçük olduğu BİLİNMEYEN (Content-Length > 2 MB ya da hiç
// yok) ve GET / HEAD olmayan istekte Caddy, gövdeye dokunmadan, uygulamaya gövdesiz bir GET /oturum/govde-izni yollar
// (özgün adres X-Forwarded-Uri başlığında; çerezler aynen). Yanıt TAM OLARAK "204 + X-Takip-Govde: izin" ise istek
// büyük kademeyle uygulamaya iletilir; başka her yanıtta (401, hata, zaman aşımı, bozuk yanıt, uygulama kapalı) Caddy
// isteği gövdeyi okumadan reddeder.
//
// Kural — yeni bir kimlik doğrulama DEĞİL, mevcut iki denetimin salt okunur kullanımı:
//   /siparisler/* ve yönetim Excel sayfaları → geçerli oturum (server/auth/session-policy.js → peekSession: liveSession
//                                              ile aynı kural; etkin kullanıcı, 30 gün / 30 dakika)
//   /depo/<anahtar>                           → geçerli depo bağlantısı (server/profile/warehouse.js → findDepotOrder;
//                                              depo sayfasının ve işleminin kullandığı denetim) — oturum gerekmez
//   başka her adres                           → izin yok
// Kapı bir kaynak korumasıdır, yetkilendirme değildir: işlem kendi oturum / yetki / sipariş kapsamı denetimini aynen
// yapar. Kapı hiçbir şey yazmaz (oturum uzamaz, satır silinmez, hatalı deneme sayılmaz), dış istek yapmaz, günlüğe
// çerez / anahtar yazmaz.
//
// Bu dosyadaki adres listeleri Caddyfile'daki eşleştiricilerle aynı olmalıdır (test/body-gate.test.js denetler).
import { peekSession } from '../auth/session-policy.js';
import { findDepotOrder } from '../profile/warehouse.js';

/** Vekilin sorduğu iç adres (dışarıdan gelen isteklere Caddy 404 verir; yalnızca GET, gövdesiz). */
export const GATE_PATH = '/oturum/govde-izni';
/** İzin yanıtı: 204 + bu başlık. Başka hiçbir yanıt izin sayılmaz. */
export const GATE_HEADER = 'x-takip-govde';
export const GATE_ALLOW = 'izin';
export const GATE_ALLOW_STATUS = 204;
export const GATE_DENY_STATUS = 401;
/** Vekilin özgün istek adresini (yol + sorgu) yazdığı başlık. İstemcinin gönderdiği değer vekilde ezilir. */
export const GATE_URI_HEADER = 'x-forwarded-uri';

/** Gövdesi bundan büyük olmayan (Content-Length ile bildirilen) istek kapıya hiç sorulmaz: olağan 2 MB kademesindedir. */
export const GATE_SMALL_BYTES = 2_000_000;

/** Oturum isteyen büyük gövdeli sayfalar: sipariş sayfaları (ön ek) … */
export const SESSION_UPLOAD_PREFIX = '/siparisler/';
/** … ve yönetim Excel yüklemeleri (tam adres). */
export const ADMIN_UPLOAD_PAGES = Object.freeze(['/admin/fiyatlar', '/admin/musteri-fiyatlari', '/admin/katalog', '/admin/profil-katalogu', '/admin/stok']);
/** Depo bağlantısı: /depo/<anahtar> — anahtarın biçimini ve geçerliliğini findDepotOrder denetler. */
export const DEPOT_PREFIX = '/depo/';

/**
 * Özgün istek adresinin hangi denetime bağlı olduğu. Adres, uygulamanın kendi ürettiği biçimde (küçük harf, kodlanmamış,
 * tek eğik çizgi) olmalıdır; başka her biçim "bilinmeyen adres"tir ve izin almaz (kapalı tarafa düşer).
 * @param {unknown} uri  vekilin yazdığı özgün istek hedefi (yol + sorgu)
 * @returns {{ kind: 'session' } | { kind: 'depot', token: string } | null}
 */
export function gateTarget(uri) {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2048 || uri[0] !== '/') return null;
  const path = uri.split(/[?#]/, 1)[0];
  if (path.includes('//') || path.includes('\\') || path.includes('%') || /(^|\/)\.\.?(\/|$)/.test(path)) return null;
  if (path.startsWith(SESSION_UPLOAD_PREFIX) || ADMIN_UPLOAD_PAGES.includes(path)) return { kind: 'session' };
  if (path.startsWith(DEPOT_PREFIX)) {
    const token = path.slice(DEPOT_PREFIX.length).replace(/\/$/, '');
    return token && !token.includes('/') ? { kind: 'depot', token } : null;
  }
  return null;
}

/**
 * Kapının kararı. Denetimler dışarıdan verilir (oturum: çerezden; depo: anahtardan) — ikisi de salt okunur olmalıdır.
 * Denetim hata verirse (veritabanı yok vb.) karar "izin yok"tur.
 * @param {{ uri: unknown, sessionOk: () => Promise<boolean>, depotOk: (token: string) => Promise<boolean> }} o
 * @returns {Promise<boolean>}
 */
export async function bodyGate({ uri, sessionOk, depotOk }) {
  const target = gateTarget(uri);
  if (!target) return false;
  try {
    return (target.kind === 'session' ? await sessionOk() : await depotOk(target.token)) === true;
  } catch {
    return false;
  }
}

/**
 * Kapının uygulamadaki tam kararı (app/oturum/govde-izni bunu çağırır): mevcut iki denetim, salt okunur.
 *   oturum : peekSession — liveSession'ın kuralı (etkin kullanıcı, mutlak 30 gün, boşta 30 dakika), yazmadan
 *   depo   : findDepotOrder — depo sayfasının ve depo işleminin denetimi (biçim, özet, süre, iptal edilmemiş sipariş)
 * @param {any} db
 * @param {{ uri: unknown, tokenHash: string | null | undefined, now?: number }} o  tokenHash: oturum çerezindeki anahtarın özeti
 * @returns {Promise<boolean>}
 */
export function gateDecision(db, { uri, tokenHash, now = Date.now() }) {
  return bodyGate({
    uri,
    sessionOk: async () => !!tokenHash && (await peekSession(db, tokenHash, { now, include: { user: { select: { isActive: true } } } })).reason === 'ok',
    depotOk: async (token) => (await findDepotOrder(db, token, new Date(now))) !== null,
  });
}

/**
 * Kapının HTTP yanıtı (durum + başlıklar; gövde yok). İzin: 204 + X-Takip-Govde: izin · izin yok: 401.
 * @param {boolean} allowed
 * @returns {{ status: number, headers: Record<string, string> }}
 */
export function gateResponse(allowed) {
  const headers = { 'Cache-Control': 'no-store' };
  return allowed === true ? { status: GATE_ALLOW_STATUS, headers: { ...headers, [GATE_HEADER]: GATE_ALLOW } } : { status: GATE_DENY_STATUS, headers };
}

/**
 * Vekildeki "küçük gövde" kuralının aynısı (Caddyfile'daki Content-Length düzenli ifadesinin karşılığı; testte ikisi
 * karşılaştırılır): bildirilen boy 0 … 2.000.000 bayt ise istek kapıya sorulmaz.
 * @param {string | null | undefined} contentLength
 */
export function declaredSmall(contentLength) {
  return typeof contentLength === 'string' && /^(\d{1,6}|1\d{6}|2000000)$/.test(contentLength);
}
