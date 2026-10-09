'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, type AppRole } from '@prisma/client';
import { db } from '@/lib/db';
import { requirePermission, destroyAllSessions } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { issueInvite, sendEmailChangeCode } from '@/lib/invite';
import { getT } from '@/lib/i18n';
import { actorOf } from '@/lib/actor';
import { applyEmailChange, checkEmailChange, deleteUser } from '@/server/users/lifecycle.js';

export type UserFormState = { error?: string; ok?: string; warn?: string; values?: Record<string, string> };

// Yönetici Yardımcısı (karar 219) atanabilir; yönetici rolü bu ekrandan verilmez (yalnızca sunucu komutu — scripts/create-admin.mjs)
const ASSIGNABLE: AppRole[] = ['MUSTERI', 'SATIS', 'CIZIM', 'DENETIMCI', 'YONETICI_YARDIMCISI'];
// Davet e-postası dilleri: formda yalnızca Romence ve Türkçe sunulur (eski 'en' kayıtları olduğu gibi kalır)
const LANGS = ['ro', 'tr'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createUserAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const admin = await requirePermission('USER_MANAGE');
  const { t, locale } = await getT();
  const v = (k: string) => String(formData.get(k) ?? '').trim();
  const values = {
    email: v('email').toLowerCase(), name: v('name'), unit: v('unit'), phone: v('phone'),
    customerId: v('customerId'), appRole: v('appRole'), language: v('language') || locale,
    canApprove: formData.get('canApprove') ? 'on' : '', sendInvite: formData.get('sendInvite') ? 'on' : '',
  };
  const fail = (error: string) => ({ error, values });

  if (!EMAIL_RE.test(values.email) || values.email.length > 200) return fail(t('admin.userActions.invalidEmail'));
  if (!ASSIGNABLE.includes(values.appRole as AppRole)) return fail(t('admin.userActions.selectRole'));
  const role = values.appRole as AppRole;
  if (!values.customerId) return fail(t('admin.userActions.selectFirm'));
  const firm = await db.customer.findUnique({ where: { id: values.customerId } });
  if (!firm) return fail(t('admin.userActions.firmNotFound'));
  if (role === 'MUSTERI' && firm.type !== 'CUSTOMER') return fail(t('admin.userActions.customerNeedsCustomerFirm'));
  if (role !== 'MUSTERI' && firm.type !== 'FACTORY') return fail(t('admin.userActions.teamNeedsFactory'));
  if (await db.user.findUnique({ where: { email: values.email } })) return fail(t('admin.userActions.emailTaken'));

  let userId: string;
  try {
    const user = await db.user.create({
      data: {
        email: values.email,
        name: values.name.slice(0, 120),
        unit: values.unit.slice(0, 120) || null,
        phone: values.phone.slice(0, 40) || null,
        appRole: role,
        type: role === 'MUSTERI' ? 'CUSTOMER' : 'INTERNAL',
        customerId: firm.id,
        canApprove: role === 'MUSTERI' && values.canApprove === 'on',
        language: LANGS.includes(values.language) ? values.language : locale,
      },
    });
    userId = user.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return fail(t('admin.userActions.emailTaken'));
    throw err;
  }
  await audit('USER_CREATE', 'User', userId, admin.id, { email: values.email, role, firm: firm.name });

  const send = values.sendInvite === 'on';
  const res = await issueInvite(userId, { send });
  revalidatePath('/admin/users');
  revalidatePath('/admin/firms');

  if (!send) {
    return { ok: t('admin.userActions.assignedNotInvited', { email: values.email, firm: firm.name }) };
  }
  if (!res.sent) {
    return { warn: t('admin.userActions.mailFailed', { email: values.email, error: res.error ?? t('admin.userActions.unknownError') }) };
  }
  return { ok: t('admin.userActions.assignedInvited', { email: values.email, firm: firm.name }) };
}

async function targetUser(formData: FormData, adminId: string) {
  const id = String(formData.get('id') ?? '');
  if (id === adminId) redirect('/admin/users?error=self');
  const user = await db.user.findUnique({ where: { id } });
  if (!user || user.deletedAt) redirect('/admin/users?error=notfound');
  return user;
}

/** Şifresi olmayan kullanıcıya yeni kod gönderir. */
export async function sendInviteAction(formData: FormData) {
  const admin = await requirePermission('USER_MANAGE');
  const user = await targetUser(formData, admin.id);
  if (user.passwordHash) redirect('/admin/users?error=active');
  const res = await issueInvite(user.id, { send: true });
  await audit('INVITE_SENT', 'User', user.id, admin.id, { sent: res.sent });
  revalidatePath('/admin/users');
  redirect(`/admin/users?${res.sent ? 'ok=invite' : 'error=mail'}&email=${encodeURIComponent(user.email)}`);
}

/** Şifreyi sıfırlar, tüm oturumları kapatır ve yeni kod gönderir. */
export async function resetPasswordAction(formData: FormData) {
  const admin = await requirePermission('USER_MANAGE');
  const user = await targetUser(formData, admin.id);
  await db.user.update({ where: { id: user.id }, data: { passwordHash: null } });
  await destroyAllSessions(user.id);
  const res = await issueInvite(user.id, { send: true });
  await audit('PASSWORD_RESET', 'User', user.id, admin.id, { sent: res.sent });
  revalidatePath('/admin/users');
  redirect(`/admin/users?${res.sent ? 'ok=reset' : 'error=mail'}&email=${encodeURIComponent(user.email)}`);
}

/** Hesabı pasifleştirir ya da yeniden etkinleştirir (kayıtlar silinmez). */
export async function toggleActiveAction(formData: FormData) {
  const admin = await requirePermission('USER_MANAGE');
  const user = await targetUser(formData, admin.id);
  const isActive = !user.isActive;
  await db.user.update({ where: { id: user.id }, data: { isActive } });
  if (!isActive) await destroyAllSessions(user.id);
  await audit(isActive ? 'USER_ACTIVATE' : 'USER_DEACTIVATE', 'User', user.id, admin.id);
  revalidatePath('/admin/users');
  redirect(`/admin/users?ok=${isActive ? 'activated' : 'deactivated'}&email=${encodeURIComponent(user.email)}`);
}

// Sonuç kodu → sayfa uyarısı (sayfa yalnızca bilinen kodları sabit metne çevirir)
const LIFECYCLE_ERR: Record<string, string> = {
  FORBIDDEN: 'forbidden', NOT_FOUND: 'notfound', SELF: 'self', PROTECTED: 'protected', DELETED: 'notfound',
  INVALID_EMAIL: 'invalidEmail', SAME_EMAIL: 'sameEmail', EMAIL_TAKEN: 'emailTaken', STALE: 'stale', CONFIRM_REQUIRED: 'confirm', INVITE: 'mail',
};
const errOf = (code: string) => LIFECYCLE_ERR[code] ?? 'notfound';

/**
 * Kullanıcının e-posta adresini değiştirir (yalnızca gerçek yönetici — USER_MANAGE, karar 222). Sıra:
 *   1. ön denetim (biçim, benzersizlik, hedef: kendisi / yönetici / silinmiş değil);
 *   2. yeni adrese tek kullanımlık, süreli kod gönderilir — gönderilemezse HİÇBİR ŞEY değişmez (hesap erişilebilir kalır);
 *   3. tek işlemde: e-posta güncellenir, şifre sıfırlanır, bütün oturumlar silinir, eski davetler kapanır, yeni davet kaydı
 *      ve denetim kaydı (eski → yeni adres) yazılır. Bu arada hedef değiştiyse işlem yapılmaz (gönderilen kod geçersiz kalır).
 */
export async function changeEmailAction(formData: FormData) {
  const admin = await requirePermission('USER_MANAGE');
  const actor = await actorOf(admin);
  const id = String(formData.get('id') ?? '');
  const back = (q: string) => redirect(`/admin/users?${q}`);
  const check = await checkEmailChange(db, { targetId: id, newEmail: formData.get('email'), actor });
  if (!check.ok) back(`error=${errOf(check.code)}&eposta=${encodeURIComponent(id)}`);
  const ok = check as Extract<typeof check, { ok: true }>;
  const mail = await sendEmailChangeCode({ to: ok.email, name: ok.user.name, firmName: ok.user.firmName, language: ok.user.language });
  if (!mail.sent) {
    await audit('USER_EMAIL_CHANGE_FAILED', 'User', ok.user.id, admin.id, { reason: 'mail' });
    back(`error=mailChange&eposta=${encodeURIComponent(id)}`);
  }
  const sent = mail as Extract<typeof mail, { sent: true }>;
  const r = await applyEmailChange(db, { targetId: id, oldEmail: ok.user.email, newEmail: ok.email, invite: sent.invite, actor });
  if (!r.ok) back(`error=${errOf(r.code)}&eposta=${encodeURIComponent(id)}`);
  revalidatePath('/admin/users');
  back(`ok=emailChanged&email=${encodeURIComponent(ok.email)}`);
}

/**
 * Kullanıcıyı siler (anonimleştirir — karar 221; yalnızca gerçek yönetici). İki adım: sayfa önce etkilenecek kayıtları
 * gösterir (?sil=<id>), yönetici kullanıcının e-posta adresini elle yazarak onaylar; sunucu adresi yeniden denetler.
 */
export async function deleteUserAction(formData: FormData) {
  const admin = await requirePermission('USER_MANAGE');
  const id = String(formData.get('id') ?? '');
  const r = await deleteUser(db, { targetId: id, confirmEmail: formData.get('confirm'), actor: await actorOf(admin) });
  if (!r.ok) redirect(`/admin/users?error=${errOf(r.code)}${r.code === 'CONFIRM_REQUIRED' ? `&sil=${encodeURIComponent(id)}` : ''}`);
  revalidatePath('/admin/users');
  redirect(`/admin/users?ok=deleted&email=${encodeURIComponent((r as { email: string }).email)}`);
}
