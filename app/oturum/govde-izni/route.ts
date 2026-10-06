import { db } from '@/lib/db';
import { sessionKey } from '@/lib/auth/session';
import { GATE_URI_HEADER, gateDecision, gateResponse } from '@/server/security/body-gate.js';

export const dynamic = 'force-dynamic';

/**
 * Gövde kapısı (karar 143) — vekilin (Caddy) iç sorusu: "özgün adresi X-Forwarded-Uri'de yazan bu istek, büyük gövde
 * gönderebilir mi?" Caddy bunu, yükleme sayfalarına gelen büyük (ya da boyu bilinmeyen) gövdeli isteklerde, gövdeyi
 * uygulamaya iletmeden ÖNCE sorar. Yanıt: 204 + X-Takip-Govde: izin (izin) ya da 401 (izin yok). Kural ve gerekçe:
 * server/security/body-gate.js (oturum: liveSession'ın kuralı, yazmadan; depo: findDepotOrder).
 *
 * Salt okunur: yalnızca GET (başka yöntemler 405), istek gövdesi hiç okunmaz, hiçbir kayıt değişmez (oturum uzamaz,
 * geçersiz oturum satırı silinmez, çerez silinmez, hatalı depo denemesi sayılmaz), dış istek yok, günlük yok. Dışarıdan
 * bu adrese gelen isteklere Caddy 404 verir; adres vekilsiz ortamda (geliştirme, test) erişilebilir olsa da yalnızca
 * çağıranın kendi oturumunun / bağlantısının geçerli olup olmadığını söyler. Yetkilendirme değildir: işlemler kendi
 * oturum / yetki / kapsam denetimini aynen yapar.
 */
export async function GET(req: Request) {
  const allowed = await gateDecision(db, { uri: req.headers.get(GATE_URI_HEADER), tokenHash: await sessionKey() });
  const { status, headers } = gateResponse(allowed);
  return new Response(null, { status, headers });
}
