'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { burnPasswordCheck, verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { setLocaleCookie } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { requestIp, runAttempt } from '@/lib/auth/throttle';
import { homeFor } from '@/lib/roles';
import { isLocale } from '@/server/i18n/index.js';

export async function loginAction(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  const lang = formData.get('lang');
  const back = `/login?email=${encodeURIComponent(email)}`;

  // Çok hatalı deneme → geçici kilit (şifre hiç kontrol edilmez; kilit süresince doğru şifre de açmaz).
  // Kilit denetimi ve denemenin sayılması TEK atomik adımdır (karar 148): runAttempt denemeyi şifre doğrulanmadan ÖNCE
  // ayırır — aynı anda gelen istekler 5 / 20 / 30 sınırını aşamaz. Aşağıdaki doğrulama (scrypt) o işlemin ve kilidin
  // DIŞINDA çalışır; sonucu runAttempt yazar: yanlış → hata kaydı · doğru → bu e-posta + IP'nin hataları temizlenir.
  const ip = await requestIp();
  const attempt = await runAttempt('LOGIN', email, ip, async () => {
    const found = email ? await db.user.findUnique({ where: { email } }) : null;
    // Dışarıya tek bir sonuç döner (SEC-10): hesap yok, pasif, şifresi henüz belirlenmemiş (davet bekliyor) ya da şifre
    // yanlış — hepsi aynı "e-posta veya şifre hatalı" yanıtıdır; davet bekleyen hesap girişten ayırt edilemez.
    // İlk giriş (davet kodu) giriş ekranındaki bağlantıdan ve davet e-postasındaki adresten /setup ekranında yapılır.
    if (!found || !found.isActive || !found.passwordHash) {
      await burnPasswordCheck(password);
      return { ok: false as const, user: null };
    }
    if (!(await verifyPassword(password, found.passwordHash))) return { ok: false as const, user: found };
    return { ok: true as const, user: found };
  });
  if (attempt.locked) {
    const locked = email ? await db.user.findUnique({ where: { email }, select: { id: true } }) : null;
    await audit('LOGIN_LOCKED', 'User', locked?.id ?? null, locked?.id ?? null, { ip });
    redirect(`${back}&error=locked&m=${attempt.minutes}`);
  }
  if (!attempt.outcome.ok) {
    const failed = attempt.outcome.user;
    if (failed) await audit('LOGIN_FAILED', 'User', failed.id, failed.id, { ip });
    redirect(`${back}&error=invalid`);
  }
  const user = attempt.outcome.user;

  await createSession(user.id);
  // Giriş ekranı hangi dildeyse panel de o dille devam eder; kullanıcının dili e-postalar için de saklanır
  // Müşteri "sabit dil" seçtiyse (Ayarlar) panel her girişte o dille açılır
  const loginLang = isLocale(user.fixedLanguage) ? user.fixedLanguage : lang;
  if (isLocale(loginLang)) {
    await setLocaleCookie(loginLang);
    if (user.language !== loginLang) await db.user.update({ where: { id: user.id }, data: { language: loginLang } });
  }
  await audit('USER_LOGIN', 'User', user.id, user.id, { ip });
  redirect(homeFor(user.appRole));
}
