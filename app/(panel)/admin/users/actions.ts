'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma, type AppRole } from '@prisma/client';
import { db } from '@/lib/db';
import { requireUser, destroyAllSessions } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { issueInvite } from '@/lib/invite';
import { getT } from '@/lib/i18n';

export type UserFormState = { error?: string; ok?: string; warn?: string; values?: Record<string, string> };

const ASSIGNABLE: AppRole[] = ['MUSTERI', 'SATIS', 'CIZIM'];
// Davet e-postası dilleri: formda yalnızca Romence ve Türkçe sunulur (eski 'en' kayıtları olduğu gibi kalır)
const LANGS = ['ro', 'tr'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createUserAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const admin = await requireUser(['ADMIN']);
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
  if (!user) redirect('/admin/users?error=notfound');
  return user;
}

/** Şifresi olmayan kullanıcıya yeni kod gönderir. */
export async function sendInviteAction(formData: FormData) {
  const admin = await requireUser(['ADMIN']);
  const user = await targetUser(formData, admin.id);
  if (user.passwordHash) redirect('/admin/users?error=active');
  const res = await issueInvite(user.id, { send: true });
  await audit('INVITE_SENT', 'User', user.id, admin.id, { sent: res.sent });
  revalidatePath('/admin/users');
  redirect(`/admin/users?${res.sent ? 'ok=invite' : 'error=mail'}&email=${encodeURIComponent(user.email)}`);
}

/** Şifreyi sıfırlar, tüm oturumları kapatır ve yeni kod gönderir. */
export async function resetPasswordAction(formData: FormData) {
  const admin = await requireUser(['ADMIN']);
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
  const admin = await requireUser(['ADMIN']);
  const user = await targetUser(formData, admin.id);
  const isActive = !user.isActive;
  await db.user.update({ where: { id: user.id }, data: { isActive } });
  if (!isActive) await destroyAllSessions(user.id);
  await audit(isActive ? 'USER_ACTIVATE' : 'USER_DEACTIVATE', 'User', user.id, admin.id);
  revalidatePath('/admin/users');
  redirect(`/admin/users?ok=${isActive ? 'activated' : 'deactivated'}&email=${encodeURIComponent(user.email)}`);
}
