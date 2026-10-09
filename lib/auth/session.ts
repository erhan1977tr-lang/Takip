import crypto from 'node:crypto';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AppRole, Customer, User } from '@prisma/client';
import { db } from '../db';
import { secureCookies } from '../env';
import { homeFor } from '../roles';
import { userCan, type Permission } from '../permissions';
import { SESSION_TTL_MS, liveSession, recordActivity } from '../../server/auth/session-policy.js';

const COOKIE = 'takip_session';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Yalnızca Server Action veya Route Handler içinden çağrılır (çerez yazar). */
export async function createSession(userId: string): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  // Mutlak ömür 30 gün; ayrıca 30 dakika etkinlik olmayan oturum geçersizdir (server/auth/session-policy.js)
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

/**
 * İsteğin oturumu (istek başına bir kez okunur). SALT OKUR: sayfa isteği, otomatik yenileme, bildirim yoklaması ya da
 * dosya indirme oturumu UZATMAZ — son etkinlik anını yalnızca reportSessionActivity yazar (karar 135).
 * `idle`: bu istek oturumu 30 dakika etkinlik olmadığı için geçersiz buldu (giriş sayfasında açıklama gösterilir).
 */
const loadSession = cache(async () => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return { user: null, remainingMs: 0, idle: false };
  const live = await liveSession(db, hashToken(token), { include: { user: { include: { customer: true } } } });
  if (!live.session) return { user: null, remainingMs: 0, idle: live.reason === 'idle' };
  // Oturum kullanıcısı sayfalara taşınır: şifre özeti ve firmasının ticari iç alanları (kur yüzdesi, fiyat tablosu
  // bağlantıları, grup) bu nesnede hiç bulunmaz (SEC-07)
  const { passwordHash: _passwordHash, customer, ...user } = live.session.user as User & { customer: Customer | null };
  // (alan listesi: server/orders/customer-view.js → INTERNAL_CUSTOMER_FIELDS)
  const firm = customer ? { ...customer, fxMarkupPercent: null, priceTableId: null, profilePriceTableId: null, groupName: null } : null;
  return { user: { ...user, customer: firm }, remainingMs: live.remainingMs, idle: false };
});

export async function getCurrentUser() {
  return (await loadSession()).user;
}

/** Oturumun (etkinlik olmazsa) kendiliğinden kapanmasına kalan süre — panel düzeni tarayıcıdaki izleyiciye verir. */
export async function sessionRemainingMs(): Promise<number> {
  return (await loadSession()).remainingMs;
}

/**
 * Tarayıcının etkinlik bildirimi (app/oturum/etkinlik): oturumu uzatan tek yol. Geçersiz oturumda çerez de silinir.
 * Yalnızca Route Handler / Server Action içinden çağrılır.
 */
export async function reportSessionActivity(idleMs: number): Promise<{ state: 'active'; remainingMs: number } | { state: 'expired' }> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return { state: 'expired' };
  const r = await recordActivity(db, hashToken(token), { idleMs });
  if (r.state === 'active') return { state: 'active', remainingMs: r.remainingMs };
  jar.delete(COOKIE);
  return { state: 'expired' };
}

/** Çerezdeki oturum anahtarının özeti (çerez yoksa null): istek sınırı anahtarı ve vekilin gövde kapısı için. Salt okunur. */
export async function sessionKey(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? hashToken(token) : null;
}

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

/**
 * Yetkilerden EN AZ BİRİ gerekir (ör. Ayarlar sayfası: kritik ayarlar SETTINGS_MANAGE, operasyonel ayarlar
 * OPS_SETTINGS_MANAGE — karar 219). Sayfa hangi bölümü göstereceğini ayrıca userCan ile seçer; her işlem kendi yetkisini ister.
 */
export async function requireAnyPermission(permissions: Permission[]): Promise<CurrentUser> {
  const user = await requireUser();
  if (!permissions.some((p) => userCan(user, p))) redirect(homeFor(user.appRole));
  return user;
}

/** Oturum yoksa girişe, rol uymuyorsa kendi ana sayfasına yönlendirir. Yeni kodda requirePermission kullanın. */
export async function requireUser(roles?: AppRole[]): Promise<CurrentUser> {
  const { user, idle } = await loadSession();
  if (!user) redirect(idle ? '/login?info=idle' : '/login');
  if (roles && !roles.includes(user.appRole)) redirect(homeFor(user.appRole));
  return user;
}
