// İstemcinin IP adresi — giriş / kod denemesi sınırı (throttle), depo bağlantısı sınırı ve denetim kaydı AYNI kaynağı
// kullanır (lib/auth/throttle.ts → requestIp). Güvenlik denetimi SEC-01 (karar 116).
//
//   Güvenilen sınır Caddy'dir: uygulamaya yalnızca Caddy üzerinden erişilir (docker ağı; app:3000 dışarı açık değil) ve
//   Caddy, güvenilmeyen istemciden gelen X-Forwarded-For'u ATAR, yerine kendi gördüğü bağlantı adresini yazar.
//   Bu yüzden:
//     - yalnızca X-Forwarded-For okunur ve SON (en sağdaki) değeri alınır: en yakın vekilin — Caddy'nin — yazdığı adres.
//       İstemcinin başlığa önceden yazdığı değerler sonuca giremez (vekil ekleyerek de, değiştirerek de çalışsa).
//     - CF-Connecting-IP, X-Real-IP, True-Client-IP gibi başlıklara GÜVENİLMEZ (istemci serbestçe yazabilir; Caddy de
//       bunları uygulamaya iletmeden siler — deploy/Caddyfile).
//     - değer geçerli bir IP adresi değilse yok sayılır.
//
//   İleride Cloudflare bilinçli olarak öne konursa (CLIENT_IP_SOURCE=cloudflare): gerçek istemci adresi CF-Connecting-IP
//   başlığındadır. O zaman ÜÇÜ BİRLİKTE yapılmalıdır, yoksa başlık yine sahtelenebilir:
//     1. sunucunun 80/443 portları yalnızca Cloudflare adres aralıklarına açılır (güvenlik duvarı),
//     2. deploy/Caddyfile'da CF-Connecting-IP ve CF-IPCountry'yi silen satırlar kaldırılır (ve trusted_proxies Cloudflare aralıkları yazılır),
//     3. /opt/takip/.env → CLIENT_IP_SOURCE=cloudflare.
import net from 'node:net';

export const CLIENT_IP_SOURCES = ['proxy', 'cloudflare'];

const ipOf = (v) => {
  const s = String(v ?? '').trim().replace(/^\[|\]$/g, '');
  // IPv4-eşlenmiş IPv6 (::ffff:1.2.3.4) düz IPv4 olarak yazılır: aynı istemci tek anahtarla sayılsın
  const plain = s.toLowerCase().startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
  return net.isIP(plain) ? plain : null;
};

/**
 * @param {(name: string) => string | null | undefined} get  istek başlığı okuyucu
 * @param {{ source?: 'proxy' | 'cloudflare' }} [o]  varsayılan 'proxy' (Caddy)
 * @returns {string | null}
 */
export function clientIp(get, { source = 'proxy' } = {}) {
  if (source === 'cloudflare') {
    const cf = ipOf(get('cf-connecting-ip'));
    if (cf) return cf;
  }
  const xff = String(get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? ipOf(xff[xff.length - 1]) : null;
}
