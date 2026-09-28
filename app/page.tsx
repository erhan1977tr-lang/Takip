import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { homeFor } from '@/lib/roles';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? homeFor(user.appRole) : '/login');
}
