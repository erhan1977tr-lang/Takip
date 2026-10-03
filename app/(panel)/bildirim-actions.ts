'use server';

// Uygulama içi bildirimler (zil): okundu işaretleme ve ses tercihi. Her işlem YALNIZCA oturum sahibinin kendi kaydını
// değiştirir — kullanıcı kimliği istekten alınmaz; başka kullanıcının bildirimi / tercihi bu yoldan değiştirilemez.
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { audit } from '@/lib/audit';

/** Tek bildirimi okundu işaretler (yalnızca kendi bildirimi; başkasının kimliği hiçbir satıra uymaz). */
export async function markNotificationReadAction(id: string): Promise<void> {
  const user = await requireUser();
  await db.notification.updateMany({ where: { id: String(id ?? ''), userId: user.id, isRead: false }, data: { isRead: true, readAt: new Date() } });
  revalidatePath('/', 'layout');
}

/** Kullanıcının bütün okunmamış bildirimlerini okundu işaretler (açık istekle; listeyi açmak okundu yapmaz). */
export async function markAllNotificationsReadAction(): Promise<void> {
  const user = await requireUser();
  await db.notification.updateMany({ where: { userId: user.id, isRead: false }, data: { isRead: true, readAt: new Date() } });
  revalidatePath('/', 'layout');
}

/** Bildirim sesi tercihi (User.notificationSound): yalnızca sesi açar / kapatır; zil, açılır bildirim, e-posta etkilenmez. */
export async function setNotificationSoundAction(on: boolean): Promise<void> {
  const user = await requireUser();
  const notificationSound = on === true;
  await db.user.update({ where: { id: user.id }, data: { notificationSound } });
  await audit('USER_SETTINGS', 'User', user.id, user.id, { notificationSound });
  revalidatePath('/', 'layout');
}
