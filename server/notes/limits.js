// Not yazma ve not çevirisi SINIRLARI — karar 147 (güvenlik denetimi 3.50.9 AUD-9).
//
// Sorun: not eklemede hiçbir sınır yoktu ve müşteriye açık her not ücretli bir çeviri çağrısı (Google) yapıyordu —
// giriş yapmış tek bir kullanıcı (ya da ele geçirilmiş bir hesap) sınırsız kayıt ve sınırsız ücretli çağrı üretebiliyordu.
//
// Sınırlar (ürün sahibi kararı):
//   not yazma    — müşteri: kullanıcı başına 10 dakikada en çok 20 not · iç ekip (yönetici, satış, çizim): 10 dakikada 60 not
//                  → aşılırsa not REDDEDİLİR (RATE_LIMIT)
//   sipariş      — bir siparişte toplam en çok 500 not (iç notlar dahil) → aşılırsa not reddedilir (ORDER_LIMIT);
//                  bu sayı veritabanında, siparişe özel kilit altında denetlenir (server/notes/translation.js → addNote)
//   çeviri       — müşteri notunun çevirisi: kullanıcı başına saatte en çok 30 sağlayıcı çağrısı → aşılırsa not YİNE
//                  KAYDEDİLİR ama sağlayıcı çağrılmaz; not "çevrilemedi: RATE_LIMIT" olarak işaretlenir (iç ekip nedenini
//                  görür ve sonra "yeniden dene" ile çevirtir; sayfa açılışı / yenileme kendiliğinden çevirmez)
//   yeniden dene — kullanıcı başına 10 dakikada en çok 20 sağlayıcı çağrısı → aşılırsa istek reddedilir, not olduğu gibi kalır
//
// Hız sınırları ortak bellek içi sınırlayıcıyla (server/security/rate-limit.js) tutulur: `take` TEK adımda denetler ve
// sayar (aralarında bekleme yoktur) — paralel isteklerle "önce bak, sonra say" yarışı oluşmaz. Sayaç uygulama süreciyle
// birlikte sıfırlanır (tek süreçli kurulum; kısa pencereli kötüye kullanım sınırı için yeterli).
// Sayılan şey ÜST SINIRDIR: hak, not / çağrı yapılmadan hemen önce alınır; sonradan başka bir nedenle (sipariş bulunamadı,
// sipariş dolu, veritabanı hatası) reddedilen istek de hakkını kullanmış olur — yazılan not ve yapılan sağlayıcı çağrısı
// sayısı hiçbir zaman sınırı aşamaz.
import { createRateLimiter } from '../security/rate-limit.js';
import { canRetryTranslation } from './view.js';

const MIN = 60_000;
export const NOTE_LIMITS = Object.freeze({
  /** Müşteri: kullanıcı başına not */
  customerNotes: Object.freeze({ limit: 20, windowMs: 10 * MIN }),
  /** İç ekip (yönetici, satış, çizim): kullanıcı başına not */
  staffNotes: Object.freeze({ limit: 60, windowMs: 10 * MIN }),
  /** Bir siparişteki toplam not (iç notlar dahil) */
  perOrder: 500,
  /** Müşteri notunun çevirisi: kullanıcı başına sağlayıcı çağrısı */
  customerTranslations: Object.freeze({ limit: 30, windowMs: 60 * MIN }),
  /** "Çeviriyi yeniden dene": kullanıcı başına sağlayıcı çağrısı */
  retries: Object.freeze({ limit: 20, windowMs: 10 * MIN }),
});

/** Nota yazılan güvenli kod: çeviri hız sınırı yüzünden yapılmadı (server/notes/view.js → TRANSLATE_ERRORS içinde) */
export const TRANSLATION_RATE_LIMITED = 'RATE_LIMIT';

/**
 * İç ekip: not yazan VE iç notları gören rol (yönetici, satış, çizim) — çeviri kurallarındaki aynı küme
 * (canRetryTranslation). Öteki not yazan rol müşteridir.
 */
export const isNoteStaff = canRetryTranslation;

/**
 * Sınır sayaçları (uygulama süreci başına bir tane: `noteLimits`; testler kendi örneğini verir).
 * Her işlev TEK adımda denetler ve sayar; `now` milisaniyedir (testler saati kendisi verir).
 * @param {typeof NOTE_LIMITS} [limits]
 */
export function createNoteLimits(limits = NOTE_LIMITS) {
  const customerNotes = createRateLimiter(limits.customerNotes);
  const staffNotes = createRateLimiter(limits.staffNotes);
  const customerTranslations = createRateLimiter(limits.customerTranslations);
  const retries = createRateLimiter(limits.retries);
  const key = (actor) => String(actor?.id ?? '');
  return {
    /** Bir siparişteki en çok not sayısı */
    perOrder: limits.perOrder,
    /** Not yazma hakkı (müşteri / iç ekip ayrı sınır). @returns {boolean} */
    note: (actor, now = Date.now()) => (isNoteStaff(actor?.role) ? staffNotes : customerNotes).take(key(actor), now).ok,
    /**
     * Notun çevirisi için sağlayıcı çağrısı hakkı. Sınır müşteri notlarınadır; iç ekibin notu not yazma sınırıyla
     * sınırlıdır (ayrı çeviri sınırı yoktur). @returns {boolean}
     */
    translation: (actor, now = Date.now()) => (isNoteStaff(actor?.role) ? true : customerTranslations.take(key(actor), now).ok),
    /** "Yeniden dene" için sağlayıcı çağrısı hakkı. @returns {boolean} */
    retry: (actor, now = Date.now()) => retries.take(key(actor), now).ok,
  };
}

/** Uygulama sürecinin ortak sayaçları (sunucu işlemleri bunu kullanır) */
export const noteLimits = createNoteLimits();
