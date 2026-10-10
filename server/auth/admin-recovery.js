// Yönetici acil erişim kurtarma (P6 — karar 246). YALNIZCA sunucu komutundan: sunucu operatörü SSH ile bağlanıp
// `takip yonetici-kurtar E-POSTA` çalıştırır (deploy/takip.sh → scripts/admin-recover.mjs, araç konteyneri). HTTP yolu
// YOKTUR: bu modülü hiçbir sayfa, sunucu işlemi ya da route içe aktarmaz (test/admin-recovery.test.js tarar).
//
// Kurallar:
//   - Hedef: açıkça yazılan, VAR OLAN, etkin, silinmemiş, iç ekipten bir YÖNETİCİ (appRole ADMIN) hesabı. Başka hesap
//     (yönetici yardımcısı, satış, müşteri…) kurtarılamaz; yeni hesap AÇILMAZ; rol, ad, e-posta, firma, etkinlik değişmez.
//   - Yeni şifre ortak şifre kuralına uyar (server/auth/password-policy.js) ve iki kez aynı yazılır; özet ortak işlevle
//     (server/auth/password-hash.js). Şifre ve özeti hiçbir kayda / çıktıya yazılmaz.
//   - Tek veritabanı işleminde, hesap satırı kilitlenerek (eşzamanlı iki kurtarma sırayla yapılır): şifre özeti yazılır,
//     hesabın BÜTÜN oturumları silinir (açık oturumlar hemen geçersiz), açık davet / doğrulama kodları kapatılır (eski kodla
//     şifre belirlenemez) ve denetim kaydı ADMIN_RECOVERY yazılır (append-only AuditLog). Herhangi bir adım başarısız olursa hiçbiri yazılmaz.
//   - Giriş deneme sayaçlarına (AuthFailure) DOKUNULMAZ (karar 148–149: yönetici "kilit açma" karar olmadan eklenmez;
//     PENDING satırları silinemez). Hesap giriş kilidindeyse kilit, hatalı denemeler durduktan en geç 15 dakika sonra açılır.
//   - Başarısız deneme de denetime yazılır (ADMIN_RECOVERY_FAILED: yalnızca neden kodu; e-posta, şifre yok).
//   - Komut yalnızca etkileşimli terminalde çalışır; şifre komut satırından, ortam değişkeninden ya da borudan alınmaz.
import { passwordIssue } from './password-policy.js';
import { hashPassword } from './password-hash.js';

export const RECOVERY_ROLE = 'ADMIN';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Operatör etiketi: yalnızca güvenli karakterler, kısa (SSH kullanıcı adı / sudo kullanıcısı) */
export const operatorLabel = (v) => String(v ?? '').replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 64) || 'unknown';
export const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Hedef hesabın uygunluğu (saf).
 * @param {{ type: string, appRole: string, isActive: boolean, deletedAt?: Date | null, passwordHash?: string | null } | null} user
 * @returns {null | 'NOT_FOUND' | 'DELETED' | 'INACTIVE' | 'NOT_INTERNAL' | 'NOT_ADMIN'}
 */
export function targetProblem(user) {
  if (!user) return 'NOT_FOUND';
  if (user.deletedAt) return 'DELETED';
  if (!user.isActive) return 'INACTIVE';
  if (user.type !== 'INTERNAL') return 'NOT_INTERNAL';
  if (user.appRole !== RECOVERY_ROLE) return 'NOT_ADMIN';
  return null;
}

/**
 * Yeni şifrenin uygunluğu (saf): ortak kural + iki giriş aynı.
 * @returns {null | 'short' | 'long' | 'trivial' | 'MISMATCH'}
 */
export function newPasswordProblem(password, confirm) {
  const issue = passwordIssue(password);
  if (issue) return issue;
  if (password !== confirm) return 'MISMATCH';
  return null;
}

/**
 * Kurtarılacak hesabı bulur (yalnızca okur). E-posta biçimi bozuksa veritabanına gidilmez.
 * @param {any} db @param {unknown} email
 * @returns {Promise<{ ok: true, user: { id: string, name: string, email: string } } | { ok: false, code: string, userId?: string | null }>}
 */
export async function findRecoveryTarget(db, email) {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) return { ok: false, code: 'BAD_EMAIL' };
  const user = await db.user.findUnique({ where: { email: e }, select: { id: true, name: true, email: true, type: true, appRole: true, isActive: true, deletedAt: true } });
  const problem = targetProblem(user);
  // Uygun olmayan ama var olan hesabın kimliği yalnızca denetim kaydı içindir (komut ekrana yazmaz)
  return problem ? { ok: false, code: problem, userId: user?.id ?? null } : { ok: true, user: { id: user.id, name: user.name, email: user.email } };
}

/**
 * Kurtarma. Şifre özeti işlemden ÖNCE hesaplanır (işlem kısa kalsın); hedef işlem içinde kilitlenip yeniden denetlenir.
 * @param {any} db
 * @param {{ email: unknown, password: string, confirm: string, operator?: unknown, host?: unknown, now?: Date,
 *   hash?: (p: string) => Promise<string>, audit?: (tx: any, data: object) => Promise<unknown> }} p
 *   hash / audit: yalnızca testte değiştirilir (hata senaryosu)
 * @returns {Promise<{ ok: true, userId: string, sessionsRevoked: number, invitesClosed: number } | { ok: false, code: string }>}
 */
export async function recoverAdmin(db, { email, password, confirm, operator, host, now = new Date(), hash = hashPassword, audit = (tx, data) => tx.auditLog.create({ data }) }) {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) return { ok: false, code: 'BAD_EMAIL' };
  const pw = newPasswordProblem(password, confirm);
  if (pw) return { ok: false, code: pw === 'MISMATCH' ? 'MISMATCH' : `WEAK_${pw.toUpperCase()}` };
  const first = await findRecoveryTarget(db, e);
  if (!first.ok) return first;
  const passwordHash = await hash(password);
  return db.$transaction(async (tx) => {
    // Satır kilidi: aynı hesaba eşzamanlı iki kurtarma sırayla; kilitten sonra uygunluk yeniden denetlenir
    const rows = await tx.$queryRaw`SELECT id, type::text AS type, "appRole"::text AS "appRole", "isActive", "deletedAt" FROM "User" WHERE email = ${e} FOR UPDATE`;
    const problem = targetProblem(rows[0] ?? null);
    if (problem) return { ok: false, code: problem };
    const id = rows[0].id;
    // Yalnızca şifre özeti değişir (rol, ad, e-posta, firma, etkinlik aynen)
    await tx.user.update({ where: { id }, data: { passwordHash } });
    const sessions = await tx.session.deleteMany({ where: { userId: id } });
    const invites = await tx.userInvite.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: now } });
    await audit(tx, {
      action: 'ADMIN_RECOVERY', entityType: 'User', entityId: id, userId: id, actorRole: 'SYSTEM', ip: null,
      details: { via: 'SSH_CLI', operator: operatorLabel(operator), host: operatorLabel(host), sessionsRevoked: sessions.count, invitesClosed: invites.count },
    });
    return { ok: true, userId: id, sessionsRevoked: sessions.count, invitesClosed: invites.count };
  });
}

/**
 * Başarısız kurtarma denemesinin denetim kaydı: yalnızca neden kodu (+ bulunduysa hesabın kimliği). E-posta / şifre yok.
 * Kayıt yazılamazsa hata yutulur (komut yine başarısız biter).
 * @param {any} db @param {{ code: string, userId?: string | null, operator?: unknown, host?: unknown }} p
 */
export async function recordRecoveryFailure(db, { code, userId = null, operator, host }) {
  try {
    await db.auditLog.create({
      data: {
        action: 'ADMIN_RECOVERY_FAILED', entityType: 'User', entityId: userId, userId, actorRole: 'SYSTEM', ip: null,
        details: { via: 'SSH_CLI', code: String(code).replace(/[^A-Z_]/g, '').slice(0, 40), operator: operatorLabel(operator), host: operatorLabel(host) },
      },
    });
  } catch {
    // denetim kaydı yazılamadı — komutun sonucu değişmez
  }
}
