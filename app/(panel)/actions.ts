'use server';

import { redirect } from 'next/navigation';
import { destroySession } from '@/lib/auth/session';

export async function logoutAction() {
  await destroySession();
  redirect('/login?info=logout');
}
