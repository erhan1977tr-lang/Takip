// Giriş / kod denemesi güvenlik olaylarının KALICI kaydı (karar 149; güvenlik denetimi 3.50.9 AUD-11).
//
// Sorun: giriş ekranı, hesap / IP kilitliyken gelen HER isteğe bir LOGIN_LOCKED denetim satırı yazıyordu. Kilitli istek
// hiçbir sayaca girmediği için sınırsızdı: giriş yapmamış biri küçük isteklerle, uygulamanın silemediği (yalnızca
// eklenen) AuditLog tablosunu istediği kadar büyütebiliyordu. Kod adımındaki (davet / şifre sıfırlama) yanlış kodlar
// ve kilitler ise hiç kayda geçmiyordu (iz yalnızca 24 saatte silinen deneme tablosundaydı).
//
// Kural — bir kilit = bir kayıt; reddedilen istek hiçbir şey yazmaz:
//   LOGIN_LOCKED  kilidi OLUŞTURAN denemeye bağlıdır: bir sınırı (e-posta + IP 5 · e-posta 20 · IP 30) dolduran ve
//                 başarısız biten deneme için TEK satır (server/auth/attempts.js → `filled`). Hangi denemenin sınırı
//                 doldurduğu e-posta + IP kilidinin altında belirlenir: aynı anda gelen isteklerden yalnızca biri doldurur.
//                 Zaten kilitliyken gelen istek hak ayıramaz → kayıt da bildirim de üretmez.
//   CODE_FAILED   gerçek bir davette gerçekten KARŞILAŞTIRILAN her yanlış kod için bir satır (verifyInviteCode →
//                 'wrong_code'). Davet başına en çok 5 karşılaştırma yapılabildiği için davet başına en çok 5 satır.
//                 Davet yok / kullanılmış / süresi dolmuş / kilitli ise kod karşılaştırılmaz → satır yazılmaz.
//   Bildirim      var olan bir hesabın E-POSTA GENELİ sınırı dolduğunda yalnızca yöneticilere uygulama içi bildirim
//                 (e-posta gönderilmez). Anahtar kullanıcı + gündür: aynı kullanıcı için günde en çok bir bildirim;
//                 tekrar engeli veritabanındadır (Notification [userId, dedupeKey] benzersiz).
//
// Kayda YAZILMAYANLAR (veri azaltma): şifre, davet kodu, oturum / kurulum anahtarı, çerez, tarayıcı bilgisi ve DENENEN
// E-POSTA DİZGİSİ. Kayıt hesabı yalnızca kullanıcı kimliğiyle gösterir; hesabı OLMAYAN bir e-posta için kullanıcıya bağlı
// kayıt yazılmaz (yalnızca IP geneli kilit, kullanıcısız olarak yazılır). IP, öteki denetim kayıtlarındaki gibi tutulur.
//
// Kayıt sayısının sınırı: her satır, sayılan BAŞARISIZ bir doğrulamaya karşılık gelir (şifre / kod gerçekten denendi) —
// bunlar 5 / 20 / 30 sınırlarıyla zaten sınırlıdır. İstek sayısıyla büyüyen hiçbir kayıt yoktur.
//
// Buradaki hiçbir işlev hata fırlatmaz: kayıt ya da bildirim yazılamasa da deneme çoktan sayılmış ve sonuçlanmıştır;
// giriş / kod akışı ve sınırlar etkilenmez.
import { writeAudit } from '../orders/journal.js';
import { notifyStaff } from '../notifications/inapp.js';
import { localDay } from '../profile/dates.js';
import { LOCK_SCOPES } from './throttle.js';

export const LOCK_ACTION = 'LOGIN_LOCKED';
export const CODE_FAILED_ACTION = 'CODE_FAILED';
/** Yöneticiye giden uygulama içi bildirimin tipi */
export const LOCK_NOTICE = 'AUTH_LOCKED';
const KINDS = ['LOGIN', 'CODE'];
const USER = { id: true, appRole: true, name: true, email: true };

const mailOf = (email) => String(email ?? '').trim().toLowerCase();
/** Günlüğe yalnızca hatanın türü yazılır (ileti, sorgu değerlerini — e-posta — taşıyabilir) */
const why = (e) => String(e?.code ?? e?.name ?? 'hata').slice(0, 60);
const ipOf = (ip) => String(ip ?? '').slice(0, 64);

/**
 * Kilit olayının denetim kaydı (saf). Alanlar sabittir: ip, kind (LOGIN | CODE), scopes (sabit sırayla).
 *   hesap var  → kullanıcıya bağlı kayıt, dolan bütün kapsamlar
 *   hesap yok  → kullanıcıya bağlı kayıt YOK; yalnızca IP geneli kilit dolduysa kullanıcısız kayıt
 * @param {{ kind: string, scopes: string[] | null | undefined, userId?: string | null, ip: string }} o
 * @returns {{ action: string, entityType: 'User', entityId: string | null, userId: string | null,
 *   details: { ip: string, kind: 'LOGIN' | 'CODE', scopes: string[] } } | null}
 */
export function lockAuditEntry({ kind, scopes, userId = null, ip }) {
  if (!KINDS.includes(kind)) return null;
  const filled = LOCK_SCOPES.filter((s) => Array.isArray(scopes) && scopes.includes(s));
  const kept = userId ? filled : filled.filter((s) => s === 'ip');
  if (!kept.length) return null;
  return { action: LOCK_ACTION, entityType: 'User', entityId: userId ?? null, userId: userId ?? null, details: { ip: ipOf(ip), kind, scopes: kept } };
}

/** Bildirimin tekrar anahtarı: aynı kullanıcı + aynı (yerel) gün → tek bildirim */
export const lockNoticeKey = (userId, day) => `auth-lock:${userId}:${day}`;

/**
 * Bir kilit olayını yazar: denetim kaydı (tek satır) + gerekiyorsa yöneticilere bildirim. Yalnızca kilidi oluşturan
 * başarısız deneme için çağrılır (runAttempt sonucundaki `filled`); `filled` boşsa hiçbir şey yapmaz, sorgu da atmaz.
 * @param {any} db
 * @param {{ kind: 'LOGIN' | 'CODE', email: string, ip: string, filled: string[] | null | undefined, now?: Date,
 *   timeZone?: string, log?: (...a: any[]) => void }} o
 * @returns {Promise<{ audit: boolean, notified: number }>}  audit: denetim satırı yazıldı mı · notified: YENİ bildirim sayısı
 */
export async function recordLock(db, { kind, email, ip, filled, now = new Date(), timeZone = 'Europe/Bucharest', log = console.error }) {
  const out = { audit: false, notified: 0 };
  const scopes = LOCK_SCOPES.filter((s) => Array.isArray(filled) && filled.includes(s));
  if (!scopes.length || !KINDS.includes(kind)) return out;
  let user = null;
  try {
    const mail = mailOf(email);
    user = mail ? await db.user.findUnique({ where: { email: mail }, select: USER }) : null;
    const entry = lockAuditEntry({ kind, scopes, userId: user?.id ?? null, ip });
    if (entry) {
      await writeAudit(db, entry, { role: user?.appRole ?? null, ip: ipOf(ip) });
      out.audit = true;
    }
  } catch (e) {
    log('kilit olayı denetim kaydına yazılamadı', why(e));
  }
  // Yalnızca gerçek kullanıcı + e-posta geneli kilit: yöneticiye haber. Bildirim yazılamazsa akış etkilenmez.
  if (user && scopes.includes('email')) {
    try {
      out.notified = await notifyStaff(db, {
        audience: 'admin', key: lockNoticeKey(user.id, localDay(now, timeZone)), type: LOCK_NOTICE,
        params: { user: [user.name, user.email].filter(Boolean).join(' · ').slice(0, 200) }, link: '/admin/users',
      });
    } catch (e) {
      log('kilit bildirimi yazılamadı', why(e));
    }
  }
  return out;
}

/**
 * Gerçek bir davette karşılaştırılan YANLIŞ kodun kaydı. Yalnızca verifyInviteCode 'wrong_code' döndürdüğünde çağrılır
 * (o sonuç ancak bir deneme hakkı harcandıysa oluşur → davet başına en çok 5). Kodun kendisi buraya hiç verilmez.
 * @param {any} db
 * @param {{ email: string, ip: string, log?: (...a: any[]) => void }} o
 * @returns {Promise<boolean>}  kayıt yazıldı mı
 */
export async function recordCodeFailure(db, { email, ip, log = console.error }) {
  try {
    const mail = mailOf(email);
    const user = mail ? await db.user.findUnique({ where: { email: mail }, select: USER }) : null;
    if (!user) return false;
    await writeAudit(db, { action: CODE_FAILED_ACTION, entityType: 'User', entityId: user.id, userId: user.id, details: { ip: ipOf(ip) } }, { role: user.appRole, ip: ipOf(ip) });
    return true;
  } catch (e) {
    log('yanlış kod denetim kaydına yazılamadı', why(e));
    return false;
  }
}
