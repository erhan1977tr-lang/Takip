import { db } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { requestIp } from '@/lib/auth/throttle';
import { writeAudit } from '@/server/orders/journal.js';
import { BT_PAGE_MAX_BYTES, applyBtPage, getBtAutoSettings, tokenMatches } from '@/server/fx/bt-auto.js';
import { createRateLimiter } from '@/server/security/rate-limit.js';

export const dynamic = 'force-dynamic';

// Anahtar doğru olsun olmasın, IP başına saatte en çok 40 istek (görev saat başına en çok ~7 dener)
const limiter = createRateLimiter({ limit: 40, windowMs: 3_600_000 });
const json = (body: object, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Günün BT kuru — otomatik alma (4.2.30, server/fx/bt-auto.js). BT sunucumuzu engellediği için sayfayı izin verilen bir
 * makinedeki zamanlanmış görev alır ve buraya OLDUĞU GİBİ gönderir; bütün doğrulama sunucuda yapılır.
 * Kimlik: `Authorization: Bearer btk_…` (Entegrasyonlar'da oluşturulan anahtar; veritabanında yalnızca özeti). Tarayıcı
 * oturumu / çerez kullanılmaz, kullanıcı adına hiçbir şey yapılmaz. Otomatik kur kapalıysa hiçbir şey yazılmaz.
 * Yanıt yalnızca sabit kodlar içerir; gönderilen metin saklanmaz, günlüğe yazılmaz.
 */
export async function POST(req: Request) {
  const ip = await requestIp();
  if (!limiter.take(ip).ok) return json({ error: 'rate' }, 429);
  const settings = await getBtAutoSettings(db);
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!tokenMatches(token, settings.tokenHash)) return json({ error: 'unauthorized' }, 401);
  if (!settings.enabled) return json({ error: 'disabled' }, 409);
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > BT_PAGE_MAX_BYTES) return json({ error: 'TOO_LARGE' }, 413);
  let html = '';
  try {
    html = await req.text();
  } catch {
    return json({ error: 'bad-request' }, 400);
  }
  const r = await applyBtPage(db, { html, now: new Date(), timeZone: getEnv().APP_TIMEZONE, writeAudit });
  return r.ok ? json({ ok: true, rate: r.rate.toFixed(4), applied: r.applied, reason: r.reason ?? null }, 200) : json({ ok: false, error: r.code }, 422);
}
