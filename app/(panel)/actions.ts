'use server';

import { redirect } from 'next/navigation';
import { destroySession, getCurrentUser } from '@/lib/auth/session';
import { audit } from '@/lib/audit';

export async function logoutAction() {
  const user = await getCurrentUser();
  await destroySession();
  if (user) await audit('USER_LOGOUT', 'User', user.id, user.id);
  redirect('/login?info=logout');
}
