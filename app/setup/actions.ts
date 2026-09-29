'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { authSecret } from '@/lib/env';
import { hashPassword, passwordProblem } from '@/lib/auth/password';
import { createSession, destroyAllSessions } from '@/lib/auth/session';
import { clearSetupToken, readSetupToken, setSetupToken } from '@/lib/auth/setupToken';
import { audit } from '@/lib/audit';
import { homeFor } from '@/lib/roles';
import { setLocaleCookie } from '@/lib/i18n';
import { isLocale } from '@/server/i18n/index.js';
import { checkInvite } from '@/server/auth/inviteCode.js';
import { recordFailure, requestIp, throttleCheck } from '@/lib/auth/throttle';

function back(email: string, error?: string) {
  return `/setup?email=${encodeURIComponent(email)}${error ? `&error=${error}` : ''}`;
}

/** Adım 1: e-postadaki kodu doğrula. */
export async function verifyCodeAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const code = String(formData.get('code') ?? '').replace(/\s+/g, '');

  const ip = await requestIp();
  const lock = await throttleCheck(email, ip);
  if (lock.locked) redirect(`${back(email, 'throttled')}&m=${lock.minutes}`);

  const user = email ? await db.user.findUnique({ where: { email } }) : null;
  const invite =
    user && user.isActive && !user.passwordHash
      ? await db.userInvite.findFirst({
          where: { userId: user.id, usedAt: null, sentAt: { not: null } },
          orderBy: { createdAt: 'desc' },
        })
      : null;

  if (!user || !invite) {
    await recordFailure('CODE', email, ip);
    redirect(back(email, 'wrong_code'));
  }

  const result = checkInvite({ code, email, record: invite, secret: authSecret() });
  if (!result.ok) {
    if (result.reason === 'wrong_code') {
      await recordFailure('CODE', email, ip);
      await db.userInvite.update({ where: { id: invite.id }, data: { attempts: { increment: 1 } } });
    }
    redirect(back(email, result.reason));
  }

  await setSetupToken(invite.id, user.id);
  redirect(back(email));
}

/** Adım 2: şifreyi iki kez girerek belirle. */
export async function setPasswordAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const pw1 = String(formData.get('password') ?? '');
  const pw2 = String(formData.get('password2') ?? '');

  const token = await readSetupToken();
  if (!token) redirect(back(email, 'session'));

  const invite = await db.userInvite.findUnique({ where: { id: token.inviteId }, include: { user: true } });
  if (!invite || invite.userId !== token.userId || invite.usedAt || invite.expiresAt <= new Date() || !invite.user.isActive) {
    await clearSetupToken();
    redirect(back(email, 'session'));
  }

  const problem = passwordProblem(pw1);
  if (problem) redirect(back(email, 'weak'));
  if (pw1 !== pw2) redirect(back(email, 'mismatch'));

  const passwordHash = await hashPassword(pw1);
  await db.$transaction([
    db.user.update({ where: { id: invite.userId }, data: { passwordHash } }),
    db.userInvite.updateMany({ where: { userId: invite.userId, usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  await destroyAllSessions(invite.userId);
  await clearSetupToken();
  await createSession(invite.userId);
  // İlk giriş hangi dilde yapıldıysa panel o dille açılır; kullanıcının dili e-postalar için de saklanır
  const lang = formData.get('lang');
  if (isLocale(lang)) {
    await setLocaleCookie(lang);
    if (invite.user.language !== lang) await db.user.update({ where: { id: invite.userId }, data: { language: lang } });
  }
  await audit('PASSWORD_SET', 'User', invite.userId, invite.userId);
  redirect(homeFor(invite.user.appRole));
}
