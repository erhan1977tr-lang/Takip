import crypto from 'node:crypto';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AppRole } from '@prisma/client';
import { db } from '../db';
import { secureCookies } from '../env';
import { homeFor } from '../roles';

const COOKIE = 'takip_session';
const TTL_DAYS = 30;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Yalnızca Server Action veya Route Handler içinden çağrılır (çerez yazar). */
export async function createSession(userId: string): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86_400_000);
  const userAgent = (await headers()).get('user-agent')?.slice(0, 250) ?? null;
  await db.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt, userAgent } });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(),
    path: '/',
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  jar.delete(COOKIE);
}

/** Bir kullanıcının tüm oturumlarını kapatır (şifre sıfırlama, hesabı pasifleştirme). */
export async function destroyAllSessions(userId: string): Promise<void> {
  await db.session.deleteMany({ where: { userId } });
}

export const getCurrentUser = cache(async () => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { customer: true } } },
  });
  if (!session || session.expiresAt <= new Date() || !session.user.isActive) return null;
  return session.user;
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/** Oturum yoksa girişe, rol uymuyorsa kendi ana sayfasına yönlendirir. */
export async function requireUser(roles?: AppRole[]): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (roles && !roles.includes(user.appRole)) redirect(homeFor(user.appRole));
  return user;
}
