// Hatalı giriş / kod denemesi sınırı — Next tarafı: isteğin IP adresi ve veritabanı servisinin ince sarmalayıcısı.
// Sınırların saf hesabı: server/auth/throttle.js · kilit denetimi + deneme kaydı (atomik): server/auth/attempts.js ·
// kilit olayının denetim kaydı ve yönetici bildirimi: server/auth/lock-events.js.
import { headers } from 'next/headers';
import { db } from '../db';
import { runAttempt as runAttemptIn } from '../../server/auth/attempts.js';
import { recordLock } from '../../server/auth/lock-events.js';
import { clientIp } from '../../server/security/client-ip.js';
import { getEnv } from '../env';

export type AttemptKind = 'LOGIN' | 'CODE';

/**
 * İsteğin IP adresi — giriş / kod sınırı, depo bağlantısı sınırı ve denetim kaydının ORTAK kaynağı. Yalnızca güvenilen
 * vekilin (Caddy) yazdığı adres kullanılır; istemcinin gönderdiği CF-Connecting-IP / X-Real-IP başlıkları sayılmaz.
 */
export async function requestIp(): Promise<string> {
  const h = await headers();
  return clientIp((k: string) => h.get(k), { source: getEnv().CLIENT_IP_SOURCE }) ?? 'unknown';
}

/**
 * Bir giriş / kod denemesinin TAMAMI (karar 148; güvenlik denetimi AUD-10) — giriş ve kod ekranının tek giriş noktası:
 *   1. deneme hakkı, doğrulamadan ÖNCE kısa bir işlemde (e-posta + IP kilidi altında) sayılır ve yazılır — aynı anda gelen
 *      istekler 5 / 20 / 30 sınırlarını aşamaz; hak yoksa `verify` hiç çağrılmaz (`locked`);
 *   2. `verify` (şifre / kod doğrulaması) o işlemin ve kilidin DIŞINDA çalışır;
 *   3. sonuç yazılır: başarısız → deneme kalıcı hata olur · giriş başarılı → deneme ve bu e-posta + IP'nin tamamlanmış
 *      hataları silinir · kod doğru → yalnızca deneme silinir · beklenmeyen hata → deneme hata sayılır.
 * Eski "say → doğrula → kaydet" işlevleri (throttleCheck / recordFailure / clearFailures: ayrı, kilitsiz sorgular)
 * kaldırıldı; burada başka bir yol yoktur (test/auth-attempts.test.js denetler).
 *
 * Kilit olayı (karar 149; güvenlik denetimi AUD-11) da BURADA yazılır — çağıran ekranın hatırlaması gerekmez:
 * deneme başarısız bitti ve bir sınırı doldurduysa (sonuçtaki `filled`) tek bir LOGIN_LOCKED denetim kaydı, e-posta geneli
 * sınır dolduysa yöneticiye bildirim (server/auth/lock-events.js). Kilitliyken gelen istek (`locked`) için hiçbir şey
 * yazılmaz: o yol salt-okunurdur. Kayıt / bildirim yazılamasa da deneme sonucu değişmez (recordLock hata fırlatmaz).
 */
export async function runAttempt<T extends { ok: boolean }>(
  kind: AttemptKind,
  email: string,
  ip: string,
  verify: () => Promise<T>,
): Promise<{ locked: true; minutes: number } | { locked: false; outcome: T }> {
  const result = (await runAttemptIn(db, { kind, email, ip }, verify)) as
    | { locked: true; minutes: number }
    | { locked: false; outcome: T; filled?: string[] };
  if (!result.locked && result.filled?.length) {
    await recordLock(db, { kind, email, ip, filled: result.filled, timeZone: getEnv().APP_TIMEZONE });
  }
  return result;
}
