// Not çevirisinin SAF kuralları (karar 127–128): yön, görünürlük ve ekran durumu. Bu dosya sağlayıcıyı (Google), ortamı
// ve veritabanını YÜKLEMEZ — yalnızca yetki matrisini kullanır. Sipariş sayfası ve lib/orders.ts yalnızca bu dosyayı
// yükler: sayfa açılışı, yenileme, otomatik yenileme ve sunucu bileşeni çizimi bu yüzden çeviri isteği ÜRETEMEZ
// (çeviri yalnızca server/notes/translation.js içindeki addNote / retryNoteTranslation ile yapılır).
import { can } from '../auth/permissions.js';

/** Güvenli çeviri hata kodları (nota yazılan / ekranda metne çevrilen) */
// RATE_LIMIT: sağlayıcı hiç ÇAĞRILMADI — yazanın çeviri hız sınırı dolmuştu (karar 147; server/notes/limits.js). Not
// kayıtlıdır; iç ekip nedenini görür ve sonra "yeniden dene" ile çevirtir.
export const TRANSLATE_ERRORS = ['TIMEOUT', 'NETWORK', 'QUOTA', 'AUTH', 'BAD_REQUEST', 'SERVER', 'HTTP', 'BAD_RESPONSE', 'NO_KEY', 'INTERRUPTED', 'RATE_LIMIT', 'ERROR'];
/** Bu süreden eski "sürüyor" kaydı yarıda kalmış sayılır (sunucu çeviri sırasında kapandı): iç ekip yeniden deneyebilir */
export const STALE_PENDING_MS = 2 * 60_000;

/**
 * Notun çevrileceği dil — yazanın ROLÜNDEN (dil tanımaya bırakılmaz). Not yazamayan / tanımsız rol: null (çeviri yok).
 * @param {string | null | undefined} role
 * @returns {'tr' | 'ro' | null}
 */
export function translationTarget(role) {
  if (role === 'MUSTERI') return 'tr';
  if (role === 'ADMIN' || role === 'SATIS' || role === 'CIZIM') return 'ro';
  return null;
}

/**
 * Çeviriyle çalışan iç ekip: not yazan VE iç notları gören rol (yönetici, satış, çizim). Müşteri notunun Türkçe
 * çevirisini, çeviri durumunu ve hata kodunu yalnızca bu roller görür; çevrilemeyen notun çevirisini yalnızca bu roller
 * yeniden isteyebilir.
 * Denetimci (yalnızca görüntüler, not yazmaz) bu kümede DEĞİLDİR.
 * @param {string | null | undefined} role
 */
export const canRetryTranslation = (role) => can(role, 'NOTE_ADD') && can(role, 'NOTE_INTERNAL_VIEW');

/**
 * Notun çeviri durumu (iç ekip ekranı): done · same · pending · failed (yarıda kalan "sürüyor" da failed sayılır) · null
 * @param {{ internal?: boolean, translationStatus?: string | null, translationError?: string | null, translationAt?: Date | string | null }} n
 * @returns {{ state: 'done' | 'same' | 'pending' | 'failed', code: string | null } | null}
 */
export function translationState(n, now = new Date()) {
  if (!n || n.internal || !n.translationStatus) return null;
  if (n.translationStatus === 'DONE') return { state: 'done', code: null };
  if (n.translationStatus === 'SAME') return { state: 'same', code: null };
  if (n.translationStatus === 'FAILED') return { state: 'failed', code: n.translationError ?? 'ERROR' };
  const at = n.translationAt ? new Date(n.translationAt).getTime() : 0;
  return now.getTime() - at > STALE_PENDING_MS ? { state: 'failed', code: 'INTERRUPTED' } : { state: 'pending', code: null };
}

const NO_TRANSLATION = { translation: null, translationLang: null, translationStatus: null, translationError: null, translationAt: null };

/**
 * Notu görenin rolüne göre çeviri alanları — çeviri notun görünürlüğünü aşamaz; notun kendisine (özgün metin) erişim
 * bu işlevle DEĞİŞMEZ:
 *   iç not                      : çeviri alanı hiç dönmez (iç not çevrilmez; yanlışlıkla yazılmış olsa da gitmez)
 *   yönetici / satış / çizim    : müşteri notunun Türkçe çevirisi + durum + güvenli hata kodu; KENDİ (iç ekip) notunun
 *                                 tamamlanmış Romence çevirisi dönmez — o çeviri müşteri içindir (karar 130); yalnızca
 *                                 süren / başarısız çevirinin durumu ve hata kodu döner (yeniden isteyebilmek için)
 *   müşteri (not yazar, iç notu görmez) : yalnızca Romence'ye TAMAMLANMIŞ çeviri; hata kodu, bekleme durumu ve
 *                                 kendi notunun Türkçesi gitmez
 *   denetimci ve diğer salt okur roller : çeviri alanı HİÇ dönmez — notu yalnızca özgün dilinde görür (karar 128):
 *                                 saklanan çeviri, çeviri hatası / durumu ve "yeniden dene" denetimciye gitmez
 * @template {{ internal: boolean, translation?: string | null, translationLang?: string | null, translationStatus?: string | null, translationError?: string | null, translationAt?: Date | null }} N
 * @param {string | null | undefined} role
 * @param {N} n
 * @returns {N}
 */
export function noteView(role, n) {
  if (n.internal) return { ...n, ...NO_TRANSLATION };
  // İç ekip çevrilmiş METNİ yalnızca Türkçe'ye çevrilen notta (müşterinin notu) alır. İç ekibin kendi notunun Romence
  // çevirisi müşteri içindir: tamamlanmış çeviri iç ekibe HİÇ dönmez (karar 130) — iç ekip kendi notunu yalnızca özgün
  // dilinde görür. Süren / başarısız çevirinin durumu ve hata kodu kalır: çevrilemeyen not "yeniden dene" ile istenebilsin.
  if (canRetryTranslation(role)) {
    if (n.translationLang === 'tr') return n.translationStatus === 'DONE' ? n : { ...n, translation: null };
    return n.translationStatus === 'DONE' || n.translationStatus === 'SAME' ? { ...n, ...NO_TRANSLATION } : { ...n, translation: null };
  }
  if (can(role, 'NOTE_ADD') && n.translationStatus === 'DONE' && n.translationLang === 'ro' && n.translation) return { ...n, translationError: null };
  return { ...n, ...NO_TRANSLATION };
}

/**
 * Siparişin notları, görenin rolüne göre: iç notlar yalnızca iç notları görebilen role (mevcut kural, değişmedi);
 * çeviri alanları noteView ile.
 * @template {{ internal: boolean }} N
 * @param {string | null | undefined} role
 * @param {N[]} notes
 * @returns {N[]}
 */
export function notesFor(role, notes) {
  const all = can(role, 'NOTE_INTERNAL_VIEW');
  return notes.filter((n) => all || !n.internal).map((n) => noteView(role, n));
}

/**
 * Revizyon notunun (DrawingRevision) çeviri alanları, görenin rolüne göre — sipariş notunun kuralıyla AYNI (noteView;
 * revizyon notu hiçbir zaman iç not değildir):
 *   müşterinin talebi (karar 162–163, çeviri Türkçe): iç ekip (yönetici, satış, çizim) çeviriyi, durumu ve güvenli hata
 *     kodunu alır; müşteri kendi notunu yalnızca özgün dilinde görür (Türkçesi gitmez)
 *   çizimcinin "hatalı" açıklaması (karar 167–168, çeviri Romence): müşteri tamamlanmış Romence çeviriyi alır; iç ekip
 *     kendi tarafının notunu yalnızca özgün dilinde görür, süren / başarısız çevirinin durumu ve kodu kalır ("yeniden dene")
 *   denetimci: çeviri alanı hiç almaz.
 * Notun kendisi (comment) bu işlevle değişmez. Girdi değiştirilmez.
 * @template {{ translation?: string | null, translationLang?: string | null, translationStatus?: string | null, translationError?: string | null, translationAt?: Date | null }} R
 * @param {string | null | undefined} role
 * @param {R} r
 * @returns {R}
 */
export function revisionView(role, r) {
  const v = noteView(role, { ...r, internal: false });
  return {
    ...r,
    translation: v.translation ?? null, translationLang: v.translationLang ?? null, translationStatus: v.translationStatus ?? null,
    translationError: v.translationError ?? null, translationAt: v.translationAt ?? null,
  };
}

/**
 * Çizim sürümlerinin revizyon taleplerine revisionView uygular (sipariş verisi: lib/orders.ts → sanitizeOrder).
 * @template {{ revisions?: object[] }} D
 * @param {string | null | undefined} role
 * @param {D[]} drawings
 * @returns {D[]}
 */
export function drawingRevisionsFor(role, drawings) {
  return drawings.map((d) => (Array.isArray(d.revisions) ? { ...d, revisions: d.revisions.map((r) => revisionView(role, r)) } : d));
}

/**
 * Çizim sürümünün müşteri notunun (Drawing.noteCustomer — çizimcinin müşteriye yazdığı not, karar 168) çeviri alanları,
 * görenin rolüne göre — sipariş notunun kuralıyla AYNI (noteView): müşteri tamamlanmış Romence çeviriyi alır; iç ekip notu
 * yalnızca özgün dilinde görür (süren / başarısız çevirinin durumu ve kodu kalır); denetimci çeviri alanı almaz.
 * Notun kendisi bu işlevle değişmez; sürümün içeriği müşteriye kapalıysa (geri çekilen sürüm — karar 146) çeviri de
 * kapalıdır (sürüm erişim kuralı — drawingsView — içerikle birlikte boşaltır). Girdi değiştirilmez.
 * @template {{ translation?: string | null, translationLang?: string | null, translationStatus?: string | null, translationError?: string | null, translationAt?: Date | null }} D
 * @param {string | null | undefined} role
 * @param {D} d
 * @returns {D}
 */
export function drawingNoteView(role, d) {
  if (!d || !('translationStatus' in d)) return d;
  return revisionView(role, d);
}

/**
 * Sipariş verisindeki çizim sürümlerine çeviri görünümü: sürüm notu (drawingNoteView) ve revizyon notları (revisionView).
 * @template {{ revisions?: object[] }} D
 * @param {string | null | undefined} role
 * @param {D[]} drawings
 * @returns {D[]}
 */
export function drawingTranslationsFor(role, drawings) {
  return drawingRevisionsFor(role, drawings).map((d) => drawingNoteView(role, d));
}
