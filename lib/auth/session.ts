import crypto from 'node:crypto';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AppRole } from '@prisma/client';
import { db } from '../db';
import { secureCookies } from '../env';
import { homeFor } from '../roles';
import { userCan, type Permission } from '../permissions';
import { SESSION_TTL_MS, sessionState } from '../../server/auth/session-policy.js';

const COOKIE = 'takip_session';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Yalnızca Server Action veya Route Handler içinden çağrılır (çerez yazar). */
export async function createSession(userId: string): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  // Mutlak ömür 30 gün; ayrıca 7 gün boşta kalan oturum geçersizdir (server/auth/session-policy.js)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
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
  if (!session || !session.user.isActive) return null;
  // Süresi dolmuş (30 gün) ya da boşta kalmış (7 gün) oturum geçersizdir; satırı işçi de saatte bir temizler
  const state = sessionState(session);
  if (state === 'expired' || state === 'idle') {
    await db.session.deleteMany({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  // Etkinlik kaydı en çok 15 dakikada bir yazılır (her istekte veritabanına yazılmaz)
  if (state === 'touch') await db.session.updateMany({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  // Oturum kullanıcısı sayfalara taşınır: şifre özeti ve firmasının ticari iç alanları (kur yüzdesi, fiyat tablosu
  // bağlantıları, grup) bu nesnede hiç bulunmaz (SEC-07)
  const { passwordHash: _passwordHash, customer, ...user } = session.user;
  // (alan listesi: server/orders/customer-view.js → INTERNAL_CUSTOMER_FIELDS)
  const firm = customer ? { ...customer, fxMarkupPercent: null, priceTableId: null, profilePriceTableId: null, groupName: null } : null;
  return { ...user, customer: firm };
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/**
 * Oturum yoksa girişe, yetki yoksa kendi ana sayfasına yönlendirir. Sayfalar ve server action'lar
 * rol adına değil yetkiye bakar (server/auth/permissions.js).
 */
export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser();
  if (!userCan(user, permission)) redirect(homeFor(user.appRole));
  return user;
}

/** Oturum yoksa girişe, rol uymuyorsa kendi ana sayfasına yönlendirir. Yeni kodda requirePermission kullanın. */
export async function requireUser(roles?: AppRole[]): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (roles && !roles.includes(user.appRole)) redirect(homeFor(user.appRole));
  return user;
}
