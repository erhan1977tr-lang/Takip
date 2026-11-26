// Telefon (Web Push) bildirimi — saf kurallar ve şifreleme (4.2.33, karar 331). Dış paket kullanılmaz: yalnızca node:crypto.
//   - VAPID (RFC 8292): sunucunun kimliği; ES256 imzalı kısa ömürlü JWT + açık anahtar ("vapid t=…, k=…").
//   - İçerik şifreleme (RFC 8291 + RFC 8188, aes128gcm): bildirim metni push hizmetinden (Google / Apple / Mozilla)
//     UÇTAN UCA şifreli geçer — hizmet metni okuyamaz, yalnızca cihaz açar.
//   - Uç nokta (endpoint) tarayıcıdan gelir → yalnızca bilinen push hizmetlerinin https adresleri kabul edilir (sunucu
//     başka bir adrese istek atmaz — SSRF koruması). Bu listeyi genişletmek karardır.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s ?? ''), 'base64url');

/** Bilinen push hizmetleri: tam ad ya da ".<sonek>" (alt alan). */
export const PUSH_HOSTS = Object.freeze([
  'fcm.googleapis.com',                 // Chrome / Android / Edge (Chromium)
  'android.googleapis.com',
  '.push.apple.com',                    // Safari / iPhone (web.push.apple.com)
  'updates.push.services.mozilla.com',  // Firefox
  '.push.services.mozilla.com',
  '.notify.windows.com',                // Edge (Windows)
]);

export const SUBSCRIPTION_LIMITS = Object.freeze({ endpoint: 1024, perUser: 10 });

/**
 * Tarayıcının verdiği uç nokta güvenli bir push hizmeti adresi mi? Değilse null; ise normalleştirilmiş adres.
 * https, kullanıcı adı / parola yok, varsayılan dışı bağlantı noktası yok, ad listedeki bir push hizmeti.
 */
export function pushEndpoint(value) {
  if (typeof value !== 'string' || !value || value.length > SUBSCRIPTION_LIMITS.endpoint) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const ok = PUSH_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) && host.length > h.length : host === h));
  return ok ? u.toString() : null;
}

/**
 * Tarayıcı aboneliğini doğrular ({ endpoint, keys: { p256dh, auth } } — PushSubscription.toJSON()).
 * p256dh: sıkıştırılmamış P-256 noktası (65 bayt, 0x04 ile başlar); auth: 16 bayt.
 * @returns {{ ok: true, endpoint: string, p256dh: string, auth: string } | { ok: false, code: string }}
 */
export function parseSubscription(sub) {
  const endpoint = pushEndpoint(sub?.endpoint);
  if (!endpoint) return { ok: false, code: 'ENDPOINT' };
  const p256dh = typeof sub?.keys?.p256dh === 'string' ? sub.keys.p256dh : '';
  const auth = typeof sub?.keys?.auth === 'string' ? sub.keys.auth : '';
  if (!/^[A-Za-z0-9_-]+=*$/.test(p256dh) || !/^[A-Za-z0-9_-]+=*$/.test(auth)) return { ok: false, code: 'KEYS' };
  const pk = unb64u(p256dh);
  const a = unb64u(auth);
  if (pk.length !== 65 || pk[0] !== 4 || a.length !== 16) return { ok: false, code: 'KEYS' };
  try {
    crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pk.subarray(1, 33)), y: b64u(pk.subarray(33)) }, format: 'jwk' });
  } catch {
    return { ok: false, code: 'KEYS' };
  }
  return { ok: true, endpoint, p256dh: b64u(pk), auth: b64u(a) };
}

/** Yeni VAPID anahtar çifti: açık anahtar (65 bayt, base64url — tarayıcıya verilir) + özel anahtar (JWK "d") */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return { publicKey: rawPublic(pub), privateKey: priv.d };
}

function rawPublic(jwk) {
  return b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
}

function privateKeyObject(publicKey, d) {
  const pk = unb64u(publicKey);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pk.subarray(1, 33)), y: b64u(pk.subarray(33)), d }, format: 'jwk' });
}

/** Saklanan anahtar çifti birbirine uyuyor mu (bozuk / yarım kayıt kullanılmaz) */
export function vapidKeysValid(publicKey, privateKey) {
  try {
    const e = crypto.createECDH('prime256v1');
    e.setPrivateKey(unb64u(privateKey));
    return b64u(e.getPublicKey()) === publicKey;
  } catch {
    return false;
  }
}

/**
 * VAPID yetki başlığı (RFC 8292). aud = uç noktanın kökeni; ömür 12 saat; sub = uygulamanın adresi (https) ya da mailto.
 * @returns {string} "vapid t=<jwt>, k=<açık anahtar>"
 */
export function vapidAuthorization({ endpoint, publicKey, privateKey, subject, now = new Date() }) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(now.getTime() / 1000) + 12 * 3600;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp, sub: subject }));
  const data = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKeyObject(publicKey, privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${publicKey}`;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * İçeriği şifreler (RFC 8291 / aes128gcm, tek kayıt). salt ve sunucu anahtarı yalnızca test için verilir.
 * @param {{ p256dh: string, auth: string, payload: Buffer | string, salt?: Buffer, serverKey?: crypto.ECDH }} p
 * @returns {Buffer} gövde: salt(16) ‖ rs(4) ‖ idlen(1) ‖ as_public(65) ‖ şifreli içerik
 */
export function encryptPayload({ p256dh, auth, payload, salt = crypto.randomBytes(16), serverKey = null }) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = serverKey ?? crypto.createECDH('prime256v1');
  if (!serverKey) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // son kayıt sınırlayıcısı
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Push hizmetine gidecek en büyük içerik (şifrelenmeden önce). Hizmetler 4096 bayta kadar kabul eder. */
export const PAYLOAD_MAX = 3000;

/**
 * Bildirim içeriği (JSON): başlık, kısa metin, uygulama içi yol. Uzun metin kısaltılır; yol uygulama içi değilse yok.
 * @param {{ title: string, body: string, link: string | null, tag?: string }} n
 */
export function pushPayload({ title, body, link, tag = undefined }) {
  const cut = (s, n) => {
    const v = String(s ?? '').replace(/\s+/g, ' ').trim();
    return v.length > n ? `${v.slice(0, n - 1)}…` : v;
  };
  const data = { title: cut(title, 120) || 'TAKİP', body: cut(body, 240), url: link ?? '/', ...(tag ? { tag: cut(tag, 64) } : {}) };
  return Buffer.from(JSON.stringify(data)); // en çok ~1,6 KB (120 + 240 karakter, yol ≤ 2000) < PAYLOAD_MAX
}

/**
 * Push hizmetinin yanıtı ne demek: SENT (201 / 200 / 202), GONE (404 / 410 — abonelik bitti, silinir), FAILED (diğer).
 * @param {number} status
 */
export function pushOutcome(status) {
  if (status >= 200 && status < 300) return 'SENT';
  if (status === 404 || status === 410) return 'GONE';
  return 'FAILED';
}
