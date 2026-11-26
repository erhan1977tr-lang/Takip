'use server';

import { redirect } from 'next/navigation';
import { destroySession, getCurrentUser } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { db } from '@/lib/db';
import { setLocaleCookie } from '@/lib/i18n';
import { isLocale } from '@/server/i18n/index.js';
import { removeSubscription } from '@/server/push/service.js';

export async function logoutAction(formData?: FormData) {
  const user = await getCurrentUser();
  // Bu cihazın telefon bildirimi aboneliği (4.2.33): çıkış yapılan telefona artık bildirim gitmez (yalnızca kendi kaydı)
  const endpoint = String(formData?.get('pushEndpoint') ?? '');
  if (user && endpoint) await removeSubscription(db, { userId: user.id, endpoint }).catch(() => 0);
  await destroySession();
  if (user) await audit('USER_LOGOUT', 'User', user.id, user.id);
  redirect('/login?info=logout');
}

/**
 * Paneldeki dil seçimi (SEC-15): dil çerezi yazılır ve kullanıcının dili (User.language — e-postalar bu dilde gider)
 * kaydedilir. Kayıt değiştiren işlem olduğu için sunucu işlemidir (POST + kaynak denetimi); /dil adresi (GET) yalnızca
 * çerezi yazar, veritabanına dokunmaz.
 */
export async function setLanguageAction(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  await setLocaleCookie(locale);
  const user = await getCurrentUser();
  if (user && user.language !== locale) await db.user.update({ where: { id: user.id }, data: { language: locale } });
}
