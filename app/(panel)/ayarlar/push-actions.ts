'use server';

import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth/session';
import { audit } from '@/lib/audit';
import { createRateLimiter } from '@/server/security/rate-limit.js';
import { createNotifications } from '@/server/notifications/inapp.js';
import { getPushSettings, hasSubscription, removeSubscription, saveSubscription } from '@/server/push/service.js';

// Telefon bildirimi (4.2.33, karar 331): yalnızca oturumdaki kullanıcının KENDİ cihaz kaydı. Uç nokta tarayıcıdan gelir ve
// yalnızca bilinen push hizmetlerinden biri olabilir (server/push/webpush.js). Denetim kaydına uç nokta yazılmaz.
const limiter = createRateLimiter({ limit: 30, windowMs: 10 * 60_000 });
const testLimiter = createRateLimiter({ limit: 3, windowMs: 10 * 60_000 });

export type PushState = { ready: boolean, registered: boolean };

export async function pushStatusAction(endpoint: string | null): Promise<PushState> {
  const user = await requireUser();
  const s = await getPushSettings(db);
  const registered = s.ready && !!endpoint ? await hasSubscription(db, { userId: user.id, endpoint }) : false;
  return { ready: s.ready, registered };
}

export async function savePushAction(subscription: unknown): Promise<{ ok: boolean, code?: string }> {
  const user = await requireUser();
  if (!limiter.take(`push:${user.id}`).ok) return { ok: false, code: 'RATE_LIMIT' };
  const r = await saveSubscription(db, { user, subscription });
  if (r.ok) await audit('PUSH_SUBSCRIBED', 'User', user.id, user.id, {});
  return r.ok ? { ok: true } : { ok: false, code: r.code };
}

export async function removePushAction(endpoint: string): Promise<{ ok: boolean }> {
  const user = await requireUser();
  if (!limiter.take(`push:${user.id}`).ok) return { ok: false };
  const n = await removeSubscription(db, { userId: user.id, endpoint });
  if (n) await audit('PUSH_UNSUBSCRIBED', 'User', user.id, user.id, {});
  return { ok: true };
}

/** Deneme bildirimi: zile bir satır yazılır, işçi birkaç saniye içinde telefona gönderir (10 dakikada en çok 3). */
export async function testPushAction(): Promise<{ ok: boolean, code?: string }> {
  const user = await requireUser();
  if (!testLimiter.take(`push-test:${user.id}`).ok) return { ok: false, code: 'RATE_LIMIT' };
  const s = await getPushSettings(db);
  if (!s.ready) return { ok: false, code: 'DISABLED' };
  await createNotifications(db, {
    key: `push-test:${user.id}:${Date.now()}`, type: 'PUSH_TEST', link: '/ayarlar',
    users: [{ id: user.id, appRole: user.appRole, aud: user.type === 'CUSTOMER' ? 'customer' : 'staff' }],
  });
  return { ok: true };
}
