'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { setLocaleCookie } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { isLocale } from '@/server/i18n/index.js';

/**
 * Kullanıcının kendi ayarları (karar 198 — bütün roller): dil (boş = Otomatik: girişte giriş ekranının algıladığı dil;
 * Türkçe / Română: her girişte bu dil), bildirim sesi; müşteride bildirim e-postaları (ACCOUNT_SETTINGS — iç ekipte bu
 * alan formda yoktur ve gönderilse de değişmez). Yalnızca oturumdaki kullanıcının kaydı değişir; başka kullanıcının
 * kimliği hiçbir alandan okunmaz. Davet / şifre e-postaları ve fatura belgeleri bu ayardan etkilenmez.
 */
export async function saveSettingsAction(formData: FormData) {
  const user = await requireUser();
  const raw = String(formData.get('fixedLanguage') ?? '');
  const fixedLanguage = isLocale(raw) ? raw : null;
  const notificationSound = formData.get('notificationSound') === 'on';
  const customerAccount = userCan(user, 'ACCOUNT_SETTINGS');
  const emailNotifications = customerAccount ? formData.get('emailNotifications') === 'on' : user.emailNotifications;
  await db.user.update({
    where: { id: user.id },
    data: { fixedLanguage, notificationSound, ...(customerAccount ? { emailNotifications } : {}), ...(fixedLanguage ? { language: fixedLanguage } : {}) },
  });
  await audit('USER_SETTINGS', 'User', user.id, user.id, { fixedLanguage, notificationSound, ...(customerAccount ? { emailNotifications } : {}) });
  // Seçilen dil hemen geçerli olur
  if (fixedLanguage) await setLocaleCookie(fixedLanguage);
  revalidatePath('/', 'layout');
  redirect('/ayarlar?ok=1');
}
