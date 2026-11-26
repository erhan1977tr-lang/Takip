// Telefon (Web Push) bildirimleri — veritabanı tarafı (4.2.33, karar 331).
//   - Kaynak TEKTİR: zil bildirimleri (Notification). Yeni olay, yeni kitle ya da ikinci bir kuyruk yoktur; her zil satırı,
//     sahibinin "Bu cihazda bildirimleri aç" dediği cihazlara bir kez gider. Kim neyi görür kuralı zildekiyle aynıdır
//     (satır alıcıya göre zaten süzülmüş / maskeli yazılır — server/notifications/inapp.js).
//   - Metin kısadır: başlık + sipariş no (+ iç ekip için firma). Ayrıntı satırı (tutar, kullanıcı adı, hata metni, adres)
//     kilit ekranına YAZILMAZ.
//   - Anahtarlar (VAPID) işçi tarafından ilk açılışta üretilir ve saklanır (özel anahtar AUTH_SECRET ile mühürlü); sunucuda
//     elle ayar gerekmez. Yönetici tümünü Ayarlar → Entegrasyonlar'dan kapatabilir (acil durdurma).
//   - Gönderim yalnızca işçide, iş akışı işleminin DIŞINDA yapılır; push hizmetine en çok bir kez (satır önce koşullu
//     işaretlenir, sonra gönderilir — yeniden deneme yoktur; zil bildirimi zaten kalır).
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { openSecret, sealSecret } from '../crypto/secret.js';
import { translate } from '../i18n/index.js';
import { renderInApp } from '../notifications/inapp.js';
import { safeLink } from '../notifications/feed.js';
import {
  SUBSCRIPTION_LIMITS, encryptPayload, generateVapidKeys, parseSubscription, pushEndpoint, pushOutcome, pushPayload,
  vapidAuthorization, vapidKeysValid,
} from './webpush.js';

export const PUSH_KEY = 'push';
const SECRET_PURPOSE = 'push-vapid';
/** Bundan eski zil satırı telefona gönderilmez (işçi uzun süre durduysa eski bildirimler yağmaz) */
export const PUSH_WINDOW_MS = 15 * 60_000;
/** Art arda bu kadar başarısız gönderimden sonra abonelik silinir (cihaz kaybolmuş / tarayıcı silinmiş) */
export const MAX_FAILURES = 20;

async function readRow(db) {
  const row = await db.integrationSetting.findUnique({ where: { key: PUSH_KEY } });
  const v = row?.value && typeof row.value === 'object' ? row.value : {};
  return {
    enabled: v.enabled !== false, // varsayılan açık; yalnızca yönetici kapatır
    publicKey: typeof v.publicKey === 'string' ? v.publicKey : null,
    privateSealed: typeof v.privateSealed === 'string' ? v.privateSealed : null,
  };
}

/** Ekran / tarayıcı için: açık mı ve tarayıcıya verilecek açık anahtar (yoksa henüz hazır değil) */
export async function getPushSettings(db) {
  const s = await readRow(db);
  return { enabled: s.enabled, publicKey: s.publicKey, ready: s.enabled && !!s.publicKey };
}

/**
 * Anahtar çifti yoksa (ya da bozuksa) üretip saklar; varsa dokunmaz. İşçi açılışında çağrılır. Aynı anda iki çağrı tek
 * çift üretir (danışma kilidi). @returns {Promise<'EXISTS' | 'CREATED'>}
 */
export async function ensureVapidKeys(db, { secret }) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('push-vapid', 0))`;
    const s = await readRow(tx);
    const priv = s.privateSealed ? openSecret(s.privateSealed, secret, SECRET_PURPOSE) : null;
    if (s.publicKey && priv && vapidKeysValid(s.publicKey, priv)) return 'EXISTS';
    const k = generateVapidKeys();
    // Anahtar değişince eski abonelikler (eski açık anahtarla alınmış) artık çalışmaz → silinir; kullanıcı yeniden açar
    await tx.pushSubscription.deleteMany({});
    const value = { enabled: s.enabled, publicKey: k.publicKey, privateSealed: sealSecret(k.privateKey, secret, SECRET_PURPOSE) };
    await tx.integrationSetting.upsert({ where: { key: PUSH_KEY }, create: { key: PUSH_KEY, value }, update: { value } });
    return 'CREATED';
  });
}

/**
 * Yönetici: telefon bildirimlerini aç / kapat (SETTINGS_MANAGE, denetim kaydıyla). Anahtarlara ve aboneliklere dokunmaz.
 * @returns {Promise<{ ok: true } | { ok: false, code: 'FORBIDDEN' }>}
 */
export async function savePushSettings(db, { enabled }, actor) {
  if (!can(actor?.role, 'SETTINGS_MANAGE')) return { ok: false, code: 'FORBIDDEN' };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('push-vapid', 0))`;
    const before = await readRow(tx);
    const value = { enabled: !!enabled, publicKey: before.publicKey, privateSealed: before.privateSealed };
    await tx.integrationSetting.upsert({ where: { key: PUSH_KEY }, create: { key: PUSH_KEY, value, updatedById: actor.id }, update: { value, updatedById: actor.id } });
    await writeAudit(tx, {
      action: 'SETTINGS_UPDATE', entityType: 'IntegrationSetting', entityId: PUSH_KEY, userId: actor.id,
      details: { before: { enabled: before.enabled }, after: { enabled: !!enabled } },
    }, actor);
    return { ok: true };
  });
}

/** Ekran için sayılar (yönetici kartı): abonelik ve kullanıcı sayısı */
export async function pushStats(db) {
  const [subscriptions, users] = await Promise.all([
    db.pushSubscription.count(),
    db.pushSubscription.groupBy({ by: ['userId'] }).then((r) => r.length),
  ]);
  return { subscriptions, users };
}

/**
 * Oturumdaki kullanıcının bu cihaz aboneliğini kaydeder. Aynı uç nokta başka bir kullanıcıdaysa (aynı telefonda başka
 * hesapla giriş) o kayıt bu kullanıcıya geçer — bir cihaz tek kişiye bildirim alır. Kullanıcı başına en çok 10 cihaz
 * (fazlası en eskiden silinir). Uç nokta yalnızca bilinen push hizmetleri (pushEndpoint).
 * @param {{ id: string, isActive?: boolean }} user  oturumdaki kullanıcı
 * @returns {Promise<{ ok: true } | { ok: false, code: 'ENDPOINT' | 'KEYS' | 'DISABLED' | 'FORBIDDEN' }>}
 */
export async function saveSubscription(db, { user, subscription }) {
  if (!user?.id) return { ok: false, code: 'FORBIDDEN' };
  const s = await readRow(db);
  if (!s.enabled || !s.publicKey) return { ok: false, code: 'DISABLED' };
  const sub = parseSubscription(subscription);
  if (!sub.ok) return sub;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`push-user:${user.id}`}, 0))`;
    await tx.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
    await tx.pushSubscription.create({ data: { userId: user.id, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth } });
    const all = await tx.pushSubscription.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    const extra = all.slice(SUBSCRIPTION_LIMITS.perUser).map((r) => r.id);
    if (extra.length) await tx.pushSubscription.deleteMany({ where: { id: { in: extra } } });
  });
  return { ok: true };
}

/**
 * Bu cihazın aboneliğini siler — yalnızca oturumdaki kullanıcının kendi kaydı (başkasının uç noktası silinmez).
 * Çıkışta da çağrılır. @returns {Promise<number>} silinen
 */
export async function removeSubscription(db, { userId, endpoint }) {
  const ep = pushEndpoint(endpoint);
  if (!userId || !ep) return 0;
  const r = await db.pushSubscription.deleteMany({ where: { userId, endpoint: ep } });
  return r.count;
}

/** Kullanıcının bu uç noktası kayıtlı mı (ayar ekranındaki düğmenin durumu) */
export async function hasSubscription(db, { userId, endpoint }) {
  const ep = pushEndpoint(endpoint);
  if (!userId || !ep) return false;
  return (await db.pushSubscription.count({ where: { userId, endpoint: ep } })) > 0;
}

const localeOf = (u) => {
  const l = u?.fixedLanguage || u?.language;
  return l === 'tr' ? 'tr' : 'ro';
};

/**
 * Kilit ekranında görünecek metin: zil başlığı + sipariş no (+ iç ekip için alıcıya göre maskeli firma). Ayrıntı satırı
 * (tutar, kişi adı, hata, adres) yazılmaz.
 * @param {'ro' | 'tr'} locale
 * @param {{ type?: string | null, params?: any, message?: string | null }} n
 */
export function pushText(locale, n) {
  const p = n.params && typeof n.params === 'object' && !Array.isArray(n.params) ? n.params : {};
  const { title } = renderInApp(locale, n);
  const customer = p.aud === 'customer';
  const order = p.orderNo ? (customer ? translate(locale, 'notifications.order', { orderNo: p.orderNo }) : String(p.orderNo)) : '';
  const firm = !customer && typeof p.firm === 'string' ? p.firm : '';
  return { title: title || 'TAKİP', body: [order, firm].filter(Boolean).join(' · ') };
}

/**
 * Bekleyen zil satırlarını telefonlara gönderir (işçi). Yalnızca: telefon bildirimi açık, anahtar hazır, kullanıcı aktif
 * ve silinmemiş, satır son 15 dakikada yazılmış ve aboneliğin kendisinden YENİ (abonelikten önceki eski bildirimler
 * gönderilmez). Satır önce koşullu işaretlenir (pushedAt) → aynı satır ikinci kez gönderilmez.
 * @param {any} db
 * @param {{ secret: string, subject: string, fetchImpl?: typeof fetch, now?: Date, limit?: number, timeoutMs?: number, log?: Function }} o
 */
export async function dispatchPush(db, { secret, subject, fetchImpl = fetch, now = new Date(), limit = 100, timeoutMs = 10_000, log = () => {} }) {
  const s = await readRow(db);
  if (!s.enabled) return { skipped: 'DISABLED' };
  const privateKey = s.privateSealed ? openSecret(s.privateSealed, secret, SECRET_PURPOSE) : null;
  if (!s.publicKey || !privateKey || !vapidKeysValid(s.publicKey, privateKey)) return { skipped: 'NO_KEYS' };
  const rows = await db.notification.findMany({
    where: {
      pushedAt: null, createdAt: { gte: new Date(now.getTime() - PUSH_WINDOW_MS) },
      user: { isActive: true, deletedAt: null, pushSubscriptions: { some: {} } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: {
      id: true, type: true, params: true, message: true, link: true, createdAt: true,
      user: { select: { language: true, fixedLanguage: true, pushSubscriptions: { select: { id: true, endpoint: true, p256dh: true, auth: true, createdAt: true } } } },
    },
  });
  const r = { notifications: 0, sent: 0, gone: 0, failed: 0 };
  for (const n of rows) {
    const claim = await db.notification.updateMany({ where: { id: n.id, pushedAt: null }, data: { pushedAt: now } });
    if (claim.count !== 1) continue;
    const subs = n.user.pushSubscriptions.filter((x) => x.createdAt <= n.createdAt);
    if (!subs.length) continue;
    r.notifications += 1;
    const text = pushText(localeOf(n.user), n);
    const payload = pushPayload({ ...text, link: safeLink(n.link), tag: n.id });
    for (const sub of subs) {
      const outcome = await sendOne(sub, payload, { publicKey: s.publicKey, privateKey, subject, fetchImpl, now, timeoutMs });
      if (outcome === 'SENT') {
        r.sent += 1;
        await db.pushSubscription.updateMany({ where: { id: sub.id }, data: { lastSentAt: now, failures: 0 } });
      } else if (outcome === 'GONE') {
        r.gone += 1;
        await db.pushSubscription.deleteMany({ where: { id: sub.id } });
      } else {
        r.failed += 1;
        await db.pushSubscription.updateMany({ where: { id: sub.id }, data: { failures: { increment: 1 } } });
        await db.pushSubscription.deleteMany({ where: { id: sub.id, failures: { gte: MAX_FAILURES } } });
        log('telefon bildirimi gönderilemedi:', outcome);
      }
    }
  }
  return r;
}

/** Tek cihaza gönderim. Uç nokta yeniden doğrulanır; yönlendirme izlenmez; yanıt gövdesi okunmaz. Hata metni dönmez. */
async function sendOne(sub, payload, { publicKey, privateKey, subject, fetchImpl, now, timeoutMs }) {
  const endpoint = pushEndpoint(sub.endpoint);
  if (!endpoint) return 'GONE';
  try {
    const body = encryptPayload({ p256dh: sub.p256dh, auth: sub.auth, payload });
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        TTL: '86400',
        Urgency: 'normal',
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        Authorization: vapidAuthorization({ endpoint, publicKey, privateKey, subject, now }),
      },
      body,
    });
    try {
      await res.body?.cancel();
    } catch {
      // yok sayılır
    }
    const o = pushOutcome(res.status);
    return o === 'FAILED' ? `HTTP_${res.status}` : o;
  } catch (e) {
    return e?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
  }
}
