import { reportSessionActivity, sessionKey } from '@/lib/auth/session';
import { ACTIVITY_HEADER, ACTIVITY_RATE_LIMIT } from '@/server/auth/activity-tracker.js';
import { createRateLimiter } from '@/server/security/rate-limit.js';
import { sameOriginRequest } from '@/server/security/same-origin.js';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ limit: ACTIVITY_RATE_LIMIT, windowMs: 60_000 });
const json = (body: object, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Etkinlik bildirimi (karar 135) — oturumun 30 dakikalık boşta kalma süresini uzatan TEK istek. Tarayıcıdaki izleyici
 * (components/SessionActivity.tsx) yalnızca gerçek kullanıcı etkinliği olduğunda, en çok dakikada bir yollar; gövde:
 * { idle: son etkinlikten bu yana geçen ms }. idle ≥ 30 dakika "oturum bitti mi?" sorusudur, hiçbir şeyi uzatmaz.
 * Geçersiz oturum canlandırılmaz (401 + çerez silinir). Başka hiçbir istek (sayfa, otomatik yenileme, bildirim
 * yoklaması, dosya) oturumu uzatmaz.
 * Koruma: özel başlık + aynı kaynak denetimi (başka site yollayamaz; çerez de SameSite=Lax) + oturum başına istek sınırı.
 */
export async function POST(req: Request) {
  const h = req.headers;
  const sameOrigin = sameOriginRequest({
    secFetchSite: h.get('sec-fetch-site'), origin: h.get('origin'), host: h.get('host'), forwardedHost: h.get('x-forwarded-host'),
  });
  if (h.get(ACTIVITY_HEADER) !== '1' || !sameOrigin) return json({ error: 'forbidden' }, 403);
  const key = await sessionKey();
  if (!key) return json({ state: 'expired' }, 401);
  if (!limiter.take(key).ok) return json({ error: 'rate' }, 429);
  let idle: unknown = null;
  try {
    idle = ((await req.json()) as { idle?: unknown } | null)?.idle;
  } catch {
    idle = null;
  }
  if (typeof idle !== 'number' || !Number.isFinite(idle) || idle < 0) return json({ error: 'bad-request' }, 400);
  const result = await reportSessionActivity(idle);
  return json(result, result.state === 'active' ? 200 : 401);
}
