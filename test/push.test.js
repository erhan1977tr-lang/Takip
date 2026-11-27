// Telefon bildirimi (Web Push) ve ana ekrana ekleme (4.2.33, karar 331): saf kurallar, şifreleme, yapı.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  encryptPayload, generateVapidKeys, parseSubscription, pushEndpoint, pushOutcome, pushPayload, vapidAuthorization, vapidKeysValid,
} from '../server/push/webpush.js';
import { PWA_ICONS } from '../server/push/icons.js';
import { GUIDE_VIDEOS } from '../server/push/guide-videos.js';
import { GUIDE_VIDEO_NAMES } from '../server/push/guide-video-list.js';
import { SW_SOURCE } from '../server/push/sw.js';
import { pushText } from '../server/push/service.js';
import { renderAnnouncementPwa } from '../server/mail/templates/announcement-pwa.js';
import { wallToUtc, defaultSendAt } from '../server/push/announce.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('RFC 8291 Ek A test vektörü bayt bayt aynı', () => {
  const as = crypto.createECDH('prime256v1');
  as.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
  const body = encryptPayload({
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    payload: 'When I grow up, I want to be a watermelon',
    salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    serverKey: as,
  });
  assert.equal(body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('şifreli içerik alıcının anahtarıyla açılır (rastgele anahtar ve tuz)', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const text = '{"title":"Teklif gönderildi","body":"Sipariş ALE12"}';
  const body = encryptPayload({ p256dh: ua.getPublicKey('base64url'), auth: auth.toString('base64url'), payload: text });
  // RFC 8291 çözümü (alıcı tarafı)
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const data = body.subarray(21 + idlen);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  assert.equal(plain.subarray(0, -1).toString(), text);
});

test('uç nokta: yalnızca bilinen push hizmetlerinin https adresleri (SSRF koruması)', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QGx', 'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://wns2-db5p.notify.windows.com/w/?token=x',
  ]) assert.ok(pushEndpoint(ok), ok);
  for (const bad of [
    'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', 'https://evil.com/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.com/x', 'https://push.apple.com/x', 'https://notpush.apple.com.evil/x', 'https://127.0.0.1/x', 'https://localhost/x',
    'https://10.0.0.1/x', 'javascript:alert(1)', '', null, 42, `https://fcm.googleapis.com/${'a'.repeat(1100)}`,
  ]) assert.equal(pushEndpoint(bad), null, String(bad));
});

test('abonelik doğrulaması: anahtar uzunluğu ve geçerli nokta', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16).toString('base64url');
  const ok = parseSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { p256dh: ua.getPublicKey('base64url'), auth } });
  assert.equal(ok.ok, true);
  assert.equal(parseSubscription({ endpoint: 'https://evil.com/a', keys: { p256dh: ua.getPublicKey('base64url'), auth } }).code, 'ENDPOINT');
  assert.equal(parseSubscription({ endpoint: 'https://fcm.googleapis.com/a', keys: { p256dh: 'abc', auth } }).code, 'KEYS');
  const bogus = Buffer.alloc(65, 7);
  bogus[0] = 4;
  assert.equal(parseSubscription({ endpoint: 'https://fcm.googleapis.com/a', keys: { p256dh: bogus.toString('base64url'), auth } }).code, 'KEYS');
  assert.equal(parseSubscription({ endpoint: 'https://fcm.googleapis.com/a', keys: { p256dh: ua.getPublicKey('base64url'), auth: 'AAAA' } }).code, 'KEYS');
  assert.equal(parseSubscription(null).code, 'ENDPOINT');
});

test('VAPID: anahtar çifti uyumu ve doğrulanabilir ES256 imza', () => {
  const k = generateVapidKeys();
  assert.equal(vapidKeysValid(k.publicKey, k.privateKey), true);
  assert.equal(vapidKeysValid(k.publicKey, generateVapidKeys().privateKey), false);
  assert.equal(vapidKeysValid(k.publicKey, 'bozuk'), false);
  const now = new Date('2026-11-26T12:00:00Z');
  const h = vapidAuthorization({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', publicKey: k.publicKey, privateKey: k.privateKey, subject: 'https://takip.gkh.ro', now });
  const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m);
  assert.equal(m[4], k.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: 'https://takip.gkh.ro' });
  const pub = Buffer.from(k.publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.equal(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')), true);
});

test('içerik: kısa, geçerli JSON; uzun metin kısaltılır', () => {
  const p = JSON.parse(pushPayload({ title: 'x'.repeat(500), body: 'y'.repeat(1000), link: '/siparisler/abc#teklif', tag: 't' }).toString());
  assert.equal(p.title.length, 120);
  assert.equal(p.body.length, 240);
  assert.equal(p.url, '/siparisler/abc#teklif');
  assert.equal(JSON.parse(pushPayload({ title: '', body: '', link: null }).toString()).url, '/');
  assert.equal(pushOutcome(201), 'SENT');
  assert.equal(pushOutcome(410), 'GONE');
  assert.equal(pushOutcome(404), 'GONE');
  assert.equal(pushOutcome(429), 'FAILED');
});

test('kilit ekranı metni: başlık + sipariş no; tutar / not / kişi yazmaz', () => {
  const n = { type: 'ADVANCE_REQUIRED', params: { orderNo: 'ALE12', firm: 'ALE**********', amount: '1.234,56', note: 'gizli not', person: 'Ion' } };
  const r = pushText('tr', n);
  assert.match(r.body, /ALE12/);
  assert.doesNotMatch(JSON.stringify(r), /1\.234|gizli|Ion/);
  const c = pushText('ro', { type: 'ORDER_OFFER_SENT', params: { orderNo: 'ALE12', aud: 'customer', firm: 'Alegrad' } });
  assert.match(c.body, /ALE12/);
  assert.doesNotMatch(c.body, /Alegrad/);
});

test('simgeler: üretilmiş dosya varlıklarla aynı', () => {
  for (const [name, b64] of Object.entries(PWA_ICONS)) {
    assert.equal(fs.readFileSync(path.join(ROOT, 'assets', 'pwa', name)).toString('base64'), b64, name);
  }
  assert.deepEqual(Object.keys(PWA_ICONS).sort(), fs.readdirSync(path.join(ROOT, 'assets', 'pwa')).filter((f) => f.endsWith('.png')).sort());
});

test('service worker: önbellek / fetch yok, tıklama yalnızca aynı site', () => {
  assert.doesNotMatch(SW_SOURCE, /addEventListener\(['"]fetch/);
  assert.doesNotMatch(SW_SOURCE, /caches\./);
  assert.match(SW_SOURCE, /addEventListener\(['"]push/);
  assert.match(SW_SOURCE, /addEventListener\(['"]notificationclick/);
  assert.match(SW_SOURCE, /self\.location\.origin/);
  assert.doesNotThrow(() => new Function(SW_SOURCE));
});

test('yapı: push isteği yalnızca service.js atar; uygulama özel anahtarı okumaz', () => {
  const svc = read('server/push/service.js');
  assert.match(svc, /redirect: 'error'/);
  for (const f of ['app/(panel)/ayarlar/push-actions.ts', 'components/PushSettings.tsx', 'app/(panel)/ayarlar/page.tsx']) {
    assert.doesNotMatch(read(f), /privateSealed|openSecret|dispatchPush/, f);
  }
  // Çıkışta bu cihazın aboneliği silinir
  assert.match(read('app/(panel)/actions.ts'), /removeSubscription/);
  // Kullanıcı silme / e-posta değişikliği abonelikleri kaldırır
  assert.equal((read('server/users/lifecycle.js').match(/pushSubscription\.deleteMany/g) ?? []).length >= 2, true);
});

test('duyuru e-postası: iki dil, ayarlar bağlantısı, fiyat yok, HTML kaçışlı', () => {
  for (const lang of /** @type {const} */ (['tr', 'ro'])) {
    const m = renderAnnouncementPwa({ lang, name: '<b>Ion</b>', appUrl: 'https://takip.gkh.ro/' });
    assert.ok(m.text.includes(`https://takip.gkh.ro/dil?l=${lang}&next=/kurulum`));
    assert.ok(m.html.includes(`https://takip.gkh.ro/dil?l=${lang}&amp;next=/kurulum`));
    assert.doesNotMatch(m.html, /<b>Ion<\/b>/);
    assert.match(m.html, /&lt;b&gt;Ion/);
    assert.ok(m.subject.length > 10);
  }
  assert.match(renderAnnouncementPwa({ lang: 'tr', appUrl: 'https://x' }).subject, /telefon/);
  // Bildirimi açma adımları ayrıntılı: Ayarlar, kutu, izin, yeşil yazı, deneme bildirimi (4.2.39)
  const tr = renderAnnouncementPwa({ lang: 'tr', appUrl: 'https://x' }).text;
  for (const w of ['"Ayarlar"', '"Telefon bildirimleri"', '"Bu cihazda bildirimleri aç"', '"İzin ver"', '"Bu cihazda açık"', '"Deneme bildirimi gönder"']) assert.ok(tr.includes(w), w);
  const ro = renderAnnouncementPwa({ lang: 'ro', appUrl: 'https://x' }).text;
  for (const w of ['„Setări”', '„Notificări pe telefon”', '„Activează notificările pe acest dispozitiv”', '„Permiteți”', '„Activate pe acest dispozitiv”', '„Trimite o notificare de test”']) assert.ok(ro.includes(w), w);
  assert.match(renderAnnouncementPwa({ lang: 'ro', appUrl: 'https://x' }).subject, /telefon/);
});

test('kurulum videoları: üretilmiş dosya varlıklarla aynı; rehber herkese açık ve veri okumaz', () => {
  for (const [name, b64] of Object.entries(GUIDE_VIDEOS)) {
    assert.equal(fs.readFileSync(path.join(ROOT, 'assets', 'kurulum', name)).toString('base64'), b64, name);
  }
  assert.deepEqual(Object.keys(GUIDE_VIDEOS).sort(), ['android-ro.mp4', 'android-tr.mp4', 'iphone-ro.mp4']);
  assert.deepEqual([...GUIDE_VIDEO_NAMES], Object.keys(GUIDE_VIDEOS).sort());
  const page = read('app/kurulum/page.tsx');
  assert.doesNotMatch(page, /@\/lib\/db|prisma|getCurrentUser|requireUser/);
  assert.match(read('components/PushSettings.tsx'), /href="\/kurulum"/);
  assert.match(page, /g\.end7/);
  assert.match(page, /g\.trouble4/);
});

test('duyuru gönderim saati: Bükreş duvar saati → UTC (4.2.39)', () => {
  assert.equal(wallToUtc('2026-11-27', '10:00').toISOString(), '2026-11-27T08:00:00.000Z');
  assert.equal(wallToUtc('2026-07-01', '10:00').toISOString(), '2026-07-01T07:00:00.000Z');
  assert.equal(wallToUtc('2026-13-01', '10:00'), null);
  assert.equal(wallToUtc('2026-11-27', '25:00'), null);
  assert.equal(wallToUtc('', ''), null);
  assert.deepEqual(defaultSendAt(new Date('2026-11-26T18:00:00Z')), { day: '2026-11-27', time: '10:00' });
  // Bugün 10:00 henüz gelmediyse bugün önerilir (4.2.41): 27.11 06:31 Bucharest → 27.11 10:00
  assert.deepEqual(defaultSendAt(new Date('2026-11-27T04:31:00Z')), { day: '2026-11-27', time: '10:00' });
  assert.deepEqual(defaultSendAt(new Date('2026-11-27T08:00:00Z')), { day: '2026-11-28', time: '10:00' });
});
