// "Kontrol Et" kanıtı (karar 84): çizim taslağı müşteriye yalnızca görüntüleyicide açılıp kontrol edildikten sonra
// gönderilebilir. Durum saklanmaz (şema değişikliği yok): görüntüleyici sayfası, o an gösterdiği taslak için sunucuda
// imzalı kısa ömürlü bir kanıt üretir; "Müşteriye gönder" bu kanıtla gelir ve send_drawing işlemi kanıtı doğrular.
// Kanıt şunlara bağlıdır: çizim sürümü, kullanıcı, taslaktaki dosyaların tam listesi ve zaman. Dosya eklenir ya da
// çıkarılırsa, başka kullanıcı gönderirse ya da süre dolarsa kanıt geçersizdir → taslak yeniden açılıp kontrol edilir.
// Sipariş sayfasından (ya da elle hazırlanmış istekle) kanıtsız gönderim reddedilir.
import crypto from 'node:crypto';

export const REVIEW_TTL_MS = 2 * 60 * 60 * 1000;

const fileKey = (files) => files.map((f) => f.id).sort().join(',');
const sign = (secret, parts) => crypto.createHmac('sha256', secret).update(parts.join('|')).digest('base64url');

/**
 * @param {{ secret: string, drawingId: string, userId: string, files: { id: string }[], now?: number }} p
 * @returns {string} "<zaman>.<imza>"
 */
export function reviewToken({ secret, drawingId, userId, files, now = Date.now() }) {
  const ts = String(Math.trunc(now));
  return `${ts}.${sign(secret, ['drawing-review', drawingId, userId, fileKey(files), ts])}`;
}

/** Kanıt bu sürüm, bu kullanıcı ve bu dosya listesi için mi ve süresi içinde mi */
export function verifyReviewToken(token, { secret, drawingId, userId, files, now = Date.now() }) {
  if (typeof token !== 'string' || !secret) return false;
  const [ts, mac, ...rest] = token.split('.');
  if (!ts || !mac || rest.length || !/^\d{10,16}$/.test(ts)) return false;
  const at = Number(ts);
  if (at > now + 60_000 || now - at > REVIEW_TTL_MS) return false;
  const expected = Buffer.from(sign(secret, ['drawing-review', drawingId, userId, fileKey(files), ts]));
  const given = Buffer.from(mac);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
