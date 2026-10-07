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
import { verifyInviteCode } from '@/server/auth/invite-claim.js';
import { recordCodeFailure } from '@/server/auth/lock-events.js';
import { requestIp, runAttempt } from '@/lib/auth/throttle';

function back(email: string, error?: string) {
  return `/setup?email=${encodeURIComponent(email)}${error ? `&error=${error}` : ''}`;
}

/** Adım 1: e-postadaki kodu doğrula. */
export async function verifyCodeAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const code = String(formData.get('code') ?? '').replace(/\s+/g, '');

  // İki sınır da doğrulamadan ÖNCE, atomik olarak alınır (karar 148) — aynı anda gelen istekler ikisini de aşamaz:
  //   1. e-posta / IP deneme sınırı (5 / 20 / 30): runAttempt denemeyi önce ayırır (server/auth/attempts.js); kod
  //      doğrulaması o işlemin dışında çalışır. Yanlış kod → hata kaydı · doğru kod → yalnızca ayrılan deneme silinir.
  //   2. davet başına 5 deneme: hak, kod karşılaştırılmadan önce alınır (server/auth/invite-claim.js)
  const ip = await requestIp();
  const attempt = await runAttempt('CODE', email, ip, () => verifyInviteCode(db, { email, code, secret: authSecret() }));
  if (attempt.locked) redirect(`${back(email, 'throttled')}&m=${attempt.minutes}`);

  const result = attempt.outcome;
  // Dışarıya tek bir sonuç (SEC-10): kod yanlış, süresi dolmuş, kilitli ya da böyle bir davet yok — hepsi aynı yanıt;
  // bir e-postanın davet bekleyip beklemediği bu ekrandan anlaşılamaz. Her başarısız deneme sınıra sayılır.
  if (!result.ok) {
    // Kalıcı kayıt (karar 149): yalnızca gerçek bir davette gerçekten KARŞILAŞTIRILAN yanlış kod için (CODE_FAILED) —
    // o sonuç ancak bir hak harcandıysa oluşur, bu yüzden davet başına en çok 5 satır. Davet yok / kullanılmış / süresi
    // dolmuş / kilitli ise kod karşılaştırılmamıştır: kayıt yazılmaz. Kodun kendisi hiçbir kayda verilmez.
    if (result.reason === 'wrong_code') await recordCodeFailure(db, { email, ip });
    redirect(back(email, 'wrong_code'));
  }

  await setSetupToken(result.inviteId, result.userId);
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
