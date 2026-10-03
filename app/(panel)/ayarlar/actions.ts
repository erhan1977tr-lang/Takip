'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { setLocaleCookie } from '@/lib/i18n';
import { audit } from '@/lib/audit';
import { isLocale } from '@/server/i18n/index.js';

/**
 * Müşterinin kendi ayarları: sabit dil (girişte varsayılan dil; boş = giriş ekranındaki dil), bildirim e-postaları ve
 * bildirim sesi (yalnızca ses; e-posta ve zil ayrı kanallardır).
 * Yalnızca kendi kullanıcı kaydı değişir. Davet / şifre e-postaları ve fatura belgeleri bu ayardan etkilenmez.
 */
export async function saveSettingsAction(formData: FormData) {
  const user = await requirePermission('ACCOUNT_SETTINGS');
  const raw = String(formData.get('fixedLanguage') ?? '');
  const fixedLanguage = isLocale(raw) ? raw : null;
  const emailNotifications = formData.get('emailNotifications') === 'on';
  const notificationSound = formData.get('notificationSound') === 'on';
  await db.user.update({
    where: { id: user.id },
    data: { fixedLanguage, emailNotifications, notificationSound, ...(fixedLanguage ? { language: fixedLanguage } : {}) },
  });
  await audit('USER_SETTINGS', 'User', user.id, user.id, { fixedLanguage, emailNotifications, notificationSound });
  // Seçilen dil hemen geçerli olur
  if (fixedLanguage) await setLocaleCookie(fixedLanguage);
  revalidatePath('/', 'layout');
  redirect('/ayarlar?ok=1');
}
