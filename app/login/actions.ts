'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { burnPasswordCheck, verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { setLocaleCookie } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { clearFailures, recordFailure, requestIp, throttleCheck } from '@/lib/auth/throttle';
import { homeFor } from '@/lib/roles';
import { isLocale } from '@/server/i18n/index.js';

export async function loginAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  const lang = formData.get('lang');
  const back = `/login?email=${encodeURIComponent(email)}`;

  // Çok hatalı deneme → geçici kilit (şifre hiç kontrol edilmez; kilit süresince doğru şifre de açmaz)
  const ip = await requestIp();
  const lock = await throttleCheck(email, ip);
  if (lock.locked) {
    const locked = email ? await db.user.findUnique({ where: { email }, select: { id: true } }) : null;
    await audit('LOGIN_LOCKED', 'User', locked?.id ?? null, locked?.id ?? null, { ip });
    redirect(`${back}&error=locked&m=${lock.minutes}`);
  }

  const user = email ? await db.user.findUnique({ where: { email } }) : null;

  // Şifresi henüz belirlenmemiş, daveti gönderilmiş kullanıcı → ilk kurulum ekranı
  if (user && user.isActive && !user.passwordHash) {
    const invite = await db.userInvite.findFirst({
      where: { userId: user.id, usedAt: null, sentAt: { not: null } },
    });
    if (invite) redirect(`/setup?email=${encodeURIComponent(email)}`);
  }

  if (!user || !user.isActive || !user.passwordHash) {
    await burnPasswordCheck(password);
    await recordFailure('LOGIN', email, ip);
    redirect(`${back}&error=invalid`);
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    await recordFailure('LOGIN', email, ip);
    await audit('LOGIN_FAILED', 'User', user.id, user.id, { ip });
    redirect(`${back}&error=invalid`);
  }

  await clearFailures(email, ip);

  await createSession(user.id);
  // Giriş ekranı hangi dildeyse panel de o dille devam eder; kullanıcının dili e-postalar için de saklanır
  if (isLocale(lang)) {
    await setLocaleCookie(lang);
    if (user.language !== lang) await db.user.update({ where: { id: user.id }, data: { language: lang } });
  }
  await audit('USER_LOGIN', 'User', user.id, user.id, { ip });
  redirect(homeFor(user.appRole));
}
