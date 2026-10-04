// Not çevirisinin SAF kuralları (karar 127–128): yön, görünürlük ve ekran durumu. Bu dosya sağlayıcıyı (Google), ortamı
// ve veritabanını YÜKLEMEZ — yalnızca yetki matrisini kullanır. Sipariş sayfası ve lib/orders.ts yalnızca bu dosyayı
// yükler: sayfa açılışı, yenileme, otomatik yenileme ve sunucu bileşeni çizimi bu yüzden çeviri isteği ÜRETEMEZ
// (çeviri yalnızca server/notes/translation.js içindeki addNote / retryNoteTranslation ile yapılır).
import { can } from '../auth/permissions.js';

/** Güvenli çeviri hata kodları (nota yazılan / ekranda metne çevrilen) */
export const TRANSLATE_ERRORS = ['TIMEOUT', 'NETWORK', 'QUOTA', 'AUTH', 'BAD_REQUEST', 'SERVER', 'HTTP', 'BAD_RESPONSE', 'NO_KEY', 'INTERRUPTED', 'ERROR'];
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
 * Çeviriyle çalışan iç ekip: not yazan VE iç notları gören rol (yönetici, satış, çizim). Çeviriyi, durumunu ve hata
 * kodunu yalnızca bu roller görür; çevrilemeyen notun çevirisini yalnızca bu roller yeniden isteyebilir.
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
 *   yönetici / satış / çizim    : çeviri + durum + güvenli hata kodu
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
  if (canRetryTranslation(role)) return n.translationStatus === 'DONE' ? n : { ...n, translation: null };
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
