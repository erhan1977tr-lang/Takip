// Kullanıcı yaşam döngüsü (Paket A, kararlar 221–222): kullanıcı silme ve kullanıcının e-posta adresini değiştirme.
// TEK yazıcı budur; sayfa ve sunucu işlemleri (app/(panel)/admin/users/actions.ts) yalnızca formu okur ve sonucu çevirir.
//
// Yetki: USER_MANAGE (yalnızca gerçek yönetici — Yönetici Yardımcısında yok, karar 219). Her dışa açık işlevin İLK satırı
// yetki denetimidir; yetkisiz çağrı veritabanına hiç gitmez (FORBIDDEN).
//
// Silme = ANONİMLEŞTİRME (karar 221): kullanıcı satırı fiziksel olarak silinmez, çünkü denetim kaydı (AuditLog) değiştirilemez
// ve kullanıcıya bağlıdır (satır silinse veritabanı denetim satırını güncellemek isterdi — tetikleyici reddeder). Bunun
// yerine kimlik bilgileri silinir (ad, e-posta, telefon, birim, şifre), hesap kalıcı olarak kapanır (isActive=false,
// deletedAt), oturumları, davetleri, bildirimleri ve okunma işaretleri silinir; e-posta adresi serbest kalır. Kullanıcının
// yazdığı notlar, açtığı siparişler, teklifler, olaylar YERİNDE kalır ("Silinmiş kullanıcı" olarak görünür) — başka
// müşterilerin siparişlerine hiçbir şekilde dokunulmaz. Yönetici rolündeki hesap ve kişinin kendi hesabı silinemez.
//
// E-posta değişikliği (karar 222): yeni adres biçim + benzersizlik (büyük-küçük harf farkı sayılmaz) denetiminden geçer;
// tek işlemde e-posta güncellenir, şifre sıfırlanır (yeni adreste şifre belirlenene kadar giriş yok), BÜTÜN oturumlar
// silinir, açık davetler kapanır ve yeni adrese bağlı tek kullanımlık, süreli bir davet kodu kaydı yazılır; denetim kaydı
// eski → yeni adresi tutar. E-posta işlemden ÖNCE gönderilir (lib/user-email.ts): gönderilemezse hiçbir şey değişmez —
// hesap erişilemez bırakılmaz. Yönetici rolündeki hesabın ve kişinin kendi e-postası bu ekrandan değiştirilemez.
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';

/** Silinmiş kullanıcının görünen adı (dil bağımsız; ekranlar kendi metnini kullanabilir) */
export const DELETED_NAME = 'Silinmiş kullanıcı';
/** Silinmiş kullanıcının e-posta adresi: benzersiz, gerçek olmayan alan (RFC 2606 .invalid) — adres yeniden kullanılabilir */
export const deletedEmail = (id) => `silindi+${id}@silindi.invalid`;

export const EMAIL_MAX = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const allowed = (actor) => !!actor?.id && can(actor.role, 'USER_MANAGE');
const FORBIDDEN = fail('FORBIDDEN');

/**
 * Yeni e-posta adresinin biçimi: kırpılır, küçük harfe çevrilir; boşluk / birden çok @ / uzun adres geçersiz.
 * @param {unknown} value
 * @returns {{ ok: true, email: string } | { ok: false, code: 'INVALID_EMAIL' }}
 */
export function parseEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email) || (email.match(/@/g) ?? []).length !== 1) return fail('INVALID_EMAIL');
  if (email.endsWith('.invalid')) return fail('INVALID_EMAIL'); // silinmiş hesaplara ayrılmış alan
  return { ok: true, email };
}

/**
 * Hedef kullanıcıya yönetici işlemi uygulanabilir mi? Kişinin kendisi, yönetici rolündeki hesap (gerçek yönetici) ve
 * silinmiş hesap korunur.
 * @param {{ id: string, appRole: string, deletedAt?: Date | null } | null} target
 * @param {{ id: string }} actor
 * @returns {null | 'NOT_FOUND' | 'SELF' | 'PROTECTED' | 'DELETED'}
 */
export function targetProblem(target, actor) {
  if (!target) return 'NOT_FOUND';
  if (target.deletedAt) return 'DELETED';
  if (target.id === actor.id) return 'SELF';
  if (target.appRole === 'ADMIN') return 'PROTECTED';
  return null;
}

/**
 * Kullanıcının kimliğini siler ve hesabı kalıcı olarak kapatır (çağıranın işlemi içinde). Müşteri silmede de kullanılır.
 * @param {any} tx @param {string} userId @param {Date} now
 */
export async function anonymizeUser(tx, userId, now) {
  await tx.session.deleteMany({ where: { userId } });
  await tx.userInvite.deleteMany({ where: { userId } });
  await tx.notification.deleteMany({ where: { userId } });
  await tx.orderNoteRead.deleteMany({ where: { userId } });
  await tx.teamTagOnUser.deleteMany({ where: { userId } });
  await tx.user.update({
    where: { id: userId },
    data: {
      name: DELETED_NAME, email: deletedEmail(userId), phone: null, unit: null, passwordHash: null, isActive: false,
      canApprove: false, emailNotifications: false, notificationSound: false, fixedLanguage: null, priceTableId: null, deletedAt: now,
    },
  });
}

/**
 * Silme önizlemesi (yalnızca okur): kullanıcıya bağlı, silmeden ETKİLENECEK kayıtlar (silinenler) ve YERİNDE KALANLAR.
 * @param {any} db @param {{ targetId: string, actor: { id: string, role: string } }} p
 * @returns {Promise<{ ok: true, user: { id: string, name: string, email: string, appRole: string, firm: string | null },
 *   removed: { sessions: number, invites: number, notifications: number, reads: number },
 *   kept: { orders: number, notes: number, offers: number, files: number, events: number } } | { ok: false, code: string }>}
 */
export async function userDeletionPreview(db, { targetId, actor }) {
  if (!allowed(actor)) return FORBIDDEN;
  const target = await db.user.findUnique({
    where: { id: String(targetId ?? '') },
    select: { id: true, name: true, email: true, appRole: true, deletedAt: true, customer: { select: { name: true } } },
  });
  const problem = targetProblem(target, actor);
  if (problem) return fail(problem);
  const id = target.id;
  const [sessions, invites, notifications, reads, orders, notes, offers, files, events] = await Promise.all([
    db.session.count({ where: { userId: id } }),
    db.userInvite.count({ where: { userId: id } }),
    db.notification.count({ where: { userId: id } }),
    db.orderNoteRead.count({ where: { userId: id } }),
    db.order.count({ where: { createdById: id } }),
    db.orderNote.count({ where: { userId: id } }),
    db.offer.count({ where: { createdById: id } }),
    db.orderFile.count({ where: { uploadedById: id } }),
    db.orderEvent.count({ where: { userId: id } }),
  ]);
  return {
    ok: true,
    user: { id, name: target.name, email: target.email, appRole: target.appRole, firm: target.customer?.name ?? null },
    removed: { sessions, invites, notifications, reads },
    kept: { orders, notes, offers, files, events },
  };
}

/**
 * Kullanıcıyı siler (anonimleştirir). confirmEmail: yöneticinin elle yazdığı, hedefin BUGÜNKÜ e-posta adresi (ikinci adım).
 * Satır kilitlenir; hedef o arada değiştiyse (silindi / rolü yönetici oldu / adresi değişti) güncel kayıtla yeniden karar verilir.
 * @param {any} db
 * @param {{ targetId: string, confirmEmail: unknown, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, email: string } | { ok: false, code: string }>}
 */
export async function deleteUser(db, { targetId, confirmEmail, actor, now = new Date() }) {
  if (!allowed(actor)) return FORBIDDEN;
  const typed = String(confirmEmail ?? '').trim().toLowerCase();
  if (!typed) return fail('CONFIRM_REQUIRED');
  return db.$transaction(async (tx) => {
    const id = String(targetId ?? '');
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
    const target = await tx.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, appRole: true, deletedAt: true, customerId: true } });
    const problem = targetProblem(target, actor);
    if (problem) return fail(problem);
    if (typed !== target.email.toLowerCase()) return fail('CONFIRM_REQUIRED');
    await anonymizeUser(tx, id, now);
    await writeAudit(tx, {
      action: 'USER_DELETED', entityType: 'User', entityId: id, userId: actor.id,
      details: { email: target.email, name: target.name, role: target.appRole, customerId: target.customerId },
    }, { role: actor.role, ip: actor.ip ?? null });
    return { ok: true, email: target.email };
  });
}

/**
 * E-posta değişikliğinin ön denetimi (yalnızca okur; e-posta göndermeden önce). Son karar applyEmailChange'te, satır
 * kilidi altında AYNI kurallarla yeniden verilir.
 * @param {any} db @param {{ targetId: string, newEmail: unknown, actor: { id: string, role: string } }} p
 * @returns {Promise<{ ok: true, user: { id: string, email: string, name: string, language: string, firmName: string | null }, email: string } | { ok: false, code: string }>}
 */
export async function checkEmailChange(db, { targetId, newEmail, actor }) {
  if (!allowed(actor)) return FORBIDDEN;
  const parsed = parseEmail(newEmail);
  if (!parsed.ok) return parsed;
  const target = await db.user.findUnique({
    where: { id: String(targetId ?? '') },
    select: { id: true, email: true, name: true, language: true, appRole: true, deletedAt: true, customer: { select: { name: true } } },
  });
  const problem = targetProblem(target, actor);
  if (problem) return fail(problem);
  if (parsed.email === target.email.toLowerCase()) return fail('SAME_EMAIL');
  const taken = await db.user.findFirst({ where: { email: { equals: parsed.email, mode: 'insensitive' } }, select: { id: true } });
  if (taken) return fail('EMAIL_TAKEN');
  return { ok: true, email: parsed.email, user: { id: target.id, email: target.email, name: target.name, language: target.language, firmName: target.customer?.name ?? null } };
}

/**
 * E-posta değişikliğini uygular (yeni adrese davet e-postası BAŞARIYLA gittikten sonra). Tek işlem: satır kilidi →
 * yeniden denetim (hedef hâlâ aynı eski adreste mi, yeni adres hâlâ boş mu) → e-posta + şifre sıfırlama → oturumlar
 * silinir → açık davetler kapanır → yeni davet kaydı (gönderilmiş) → denetim kaydı. Biri tutmazsa hiçbir şey değişmez
 * (gönderilmiş kod, kaydı olmadığı için kullanılamaz).
 * @param {any} db
 * @param {{ targetId: string, oldEmail: string, newEmail: string, invite: { codeHash: string, expiresAt: Date }, actor: { id: string, role: string, ip?: string | null }, now?: Date }} p
 * @returns {Promise<{ ok: true, sessions: number } | { ok: false, code: string }>}
 */
export async function applyEmailChange(db, { targetId, oldEmail, newEmail, invite, actor, now = new Date() }) {
  if (!allowed(actor)) return FORBIDDEN;
  const parsed = parseEmail(newEmail);
  if (!parsed.ok) return parsed;
  if (!invite?.codeHash || !(invite.expiresAt instanceof Date)) return fail('INVITE');
  try {
    return await db.$transaction(async (tx) => {
      const id = String(targetId ?? '');
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
      const target = await tx.user.findUnique({ where: { id }, select: { id: true, email: true, appRole: true, deletedAt: true } });
      const problem = targetProblem(target, actor);
      if (problem) return fail(problem);
      if (target.email.toLowerCase() !== String(oldEmail ?? '').toLowerCase()) return fail('STALE');
      if (parsed.email === target.email.toLowerCase()) return fail('SAME_EMAIL');
      const taken = await tx.user.findFirst({ where: { email: { equals: parsed.email, mode: 'insensitive' }, NOT: { id } }, select: { id: true } });
      if (taken) return fail('EMAIL_TAKEN');
      await tx.user.update({ where: { id }, data: { email: parsed.email, passwordHash: null } });
      const sessions = await tx.session.deleteMany({ where: { userId: id } });
      await tx.userInvite.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: now } });
      await tx.userInvite.create({ data: { userId: id, codeHash: invite.codeHash, expiresAt: invite.expiresAt, sentAt: now } });
      await writeAudit(tx, {
        action: 'USER_EMAIL_CHANGED', entityType: 'User', entityId: id, userId: actor.id,
        details: { from: target.email, to: parsed.email, sessionsRevoked: sessions.count },
      }, { role: actor.role, ip: actor.ip ?? null });
      return { ok: true, sessions: sessions.count };
    });
  } catch (e) {
    // Aynı adresi aynı anda alan başka bir kayıt: benzersizlik kısıtı son güvencedir
    if (e && typeof e === 'object' && /** @type {any} */ (e).code === 'P2002') return fail('EMAIL_TAKEN');
    throw e;
  }
}
