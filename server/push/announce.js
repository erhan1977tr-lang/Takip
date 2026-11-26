// Müşterilere tek seferlik bilgi e-postası: "TAKİP'i ana ekrana ekleyin, telefon bildirimlerini açın" (4.2.33, karar 331).
//   - Yalnızca Admin'in açık isteğiyle (Yönetici → Duyuru, USER_MANAGE): önizleme + alıcı sayısı → onay kutusu → "Gönder".
//   - Bir duyuru anahtarı (ANNOUNCEMENT_KEY) yalnızca BİR kez kuyruğa girer: IntegrationSetting 'announcement:<anahtar>'
//     işareti aynı işlemde yazılır, kilit altında; ikinci istek ALREADY (çift tıklama / iki sekme ikinci e-posta üretmez).
//   - Alıcı: etkin, silinmemiş, şifresini kurmuş müşteri kullanıcıları; geçerli tek e-posta adresi; e-posta bildirimleri açık
//     (kullanıcının "e-posta istemiyorum" seçimine uyulur). Kullanıcı başına bir kuyruk satırı, dili kullanıcının dili.
//   - Gönderim işçide (dispatchAnnouncements): alıcı başına en çok bir ileti — gönderimden ÖNCE işaret (sendingAt); işaretli
//     bulunan satır (işçi gönderim sırasında durdu) FAILED / UNKNOWN olur, kendiliğinden yeniden gönderilmez. Yalnızca SMTP'ye
//     hiç bağlanılamadıysa (CONN) yeniden denenir (en çok 3).
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { isEmail } from '../documents/delivery.js';
import { sendBrandedMail } from '../mail/send.js';
import { renderAnnouncementPwa } from '../mail/templates/announcement-pwa.js';

export const ANNOUNCEMENT_EMAIL = 'ANNOUNCEMENT_EMAIL';
export const ANNOUNCEMENT_KEY = 'pwa-2026-11';
const MARK = `announcement:${ANNOUNCEMENT_KEY}`;
const MAX_ATTEMPTS = 3;
const FORBIDDEN = /** @type {{ ok: false, code: 'FORBIDDEN' }} */ ({ ok: false, code: 'FORBIDDEN' });
const allowed = (actor) => !!actor?.id && can(actor.role, 'USER_MANAGE');
const langOf = (u) => ((u.fixedLanguage || u.language) === 'tr' ? 'tr' : 'ro');

const RECIPIENT_WHERE = {
  type: 'CUSTOMER', appRole: 'MUSTERI', isActive: true, deletedAt: null, emailNotifications: true,
  customerId: { not: null }, passwordHash: { not: null },
};

/** Duyuruyu alacak kullanıcılar (geçerli e-posta adresi olanlar) */
export async function announcementRecipients(db) {
  const users = await db.user.findMany({
    where: RECIPIENT_WHERE,
    select: { id: true, email: true, name: true, language: true, fixedLanguage: true },
    orderBy: { createdAt: 'asc' },
  });
  return users.filter((u) => isEmail(u.email));
}

/**
 * Sayfa için durum: alıcı sayısı (dile göre), daha önce kuyruğa girdiyse ne zaman ve gönderim sonuçları.
 * Hiçbir şey yazmaz.
 * @returns {Promise<{ ok: false, code: 'FORBIDDEN' } | { ok: true, key: string, queuedAt: string | null,
 *   recipients: { total: number, tr: number, ro: number }, jobs: { pending: number, sent: number, failed: number, skipped: number } }>}
 */
export async function announcementStatus(db, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const [mark, users, counts] = await Promise.all([
    db.integrationSetting.findUnique({ where: { key: MARK } }),
    announcementRecipients(db),
    db.notificationOutbox.groupBy({ by: ['status'], where: { type: ANNOUNCEMENT_EMAIL, payload: { path: ['key'], equals: ANNOUNCEMENT_KEY } }, _count: true }),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count]));
  return {
    ok: /** @type {true} */ (true), key: ANNOUNCEMENT_KEY,
    queuedAt: mark?.value?.queuedAt ?? null,
    recipients: { total: users.length, tr: users.filter((u) => langOf(u) === 'tr').length, ro: users.filter((u) => langOf(u) === 'ro').length },
    jobs: { pending: byStatus.PENDING ?? 0, sent: byStatus.SENT ?? 0, failed: byStatus.FAILED ?? 0, skipped: byStatus.SKIPPED ?? 0 },
  };
}

/**
 * Duyuruyu kuyruğa yazar (bir kez). Admin'in açık onayı (confirm) zorunlu.
 * @param {any} db
 * @param {{ actor: any, confirm: boolean, ip?: string | null }} p
 * @returns {Promise<{ ok: true, queued: number } | { ok: false, code: 'FORBIDDEN' | 'CONFIRM' | 'ALREADY' | 'NO_RECIPIENTS' }>}
 */
export async function queueAnnouncement(db, { actor, confirm, ip = null }) {
  if (!allowed(actor)) return FORBIDDEN;
  if (confirm !== true) return { ok: false, code: 'CONFIRM' };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${MARK}, 0))`;
    if (await tx.integrationSetting.findUnique({ where: { key: MARK } })) return { ok: false, code: 'ALREADY' };
    const users = await announcementRecipients(tx);
    if (!users.length) return { ok: false, code: 'NO_RECIPIENTS' };
    const now = new Date();
    await tx.integrationSetting.create({ data: { key: MARK, value: { queuedAt: now.toISOString(), byId: actor.id, count: users.length } } });
    await tx.notificationOutbox.createMany({
      data: users.map((u) => ({ type: ANNOUNCEMENT_EMAIL, payload: { key: ANNOUNCEMENT_KEY, userId: u.id, lang: langOf(u) }, inAppAt: now })),
    });
    await writeAudit(tx, {
      action: 'ANNOUNCEMENT_QUEUED', entityType: 'Announcement', entityId: ANNOUNCEMENT_KEY, userId: actor.id,
      details: { key: ANNOUNCEMENT_KEY, count: users.length },
    }, { role: actor.role, ip });
    return { ok: true, queued: users.length };
  });
}

const notSent = (e) => e?.command === 'CONN';

/**
 * İşçi: kuyruktaki duyuru e-postalarını gönderir (alıcı başına en çok bir ileti).
 * @param {any} db
 * @param {{ transport: any, from: string, appUrl: string, now?: Date, limit?: number, log?: Function }} o
 */
export async function dispatchAnnouncements(db, { transport, from, appUrl, now = new Date(), limit = 20, log = () => {} }) {
  if (!transport) return { sent: 0, failed: 0, skipped: 0 };
  const rows = await db.notificationOutbox.findMany({
    where: { type: ANNOUNCEMENT_EMAIL, status: 'PENDING', availableAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: limit,
  });
  let sent = 0, failed = 0, skipped = 0;
  for (const row of rows) {
    const claimed = await db.notificationOutbox.updateMany({ where: { id: row.id, status: 'PENDING', attempts: row.attempts }, data: { attempts: { increment: 1 } } });
    if (claimed.count === 0) continue;
    const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
    if (p.sendingAt) { // önceki deneme gönderim sırasında yarıda kaldı: gitmiş olabilir → yeniden gönderilmez
      await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'FAILED', lastError: 'UNKNOWN' } });
      failed++;
      continue;
    }
    // Alıcı gönderim anında yeniden okunur: bu arada kapatılan / silinen / e-postayı kapatan kullanıcıya gitmez
    const user = typeof p.userId === 'string'
      ? await db.user.findFirst({ where: { id: p.userId, ...RECIPIENT_WHERE }, select: { email: true, name: true, language: true, fixedLanguage: true } })
      : null;
    if (!user || !isEmail(user.email)) {
      await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'NO_RECIPIENT' } });
      skipped++;
      continue;
    }
    await db.notificationOutbox.update({ where: { id: row.id }, data: { payload: { ...p, sendingAt: now.toISOString() } } });
    const lang = p.lang === 'tr' ? 'tr' : 'ro';
    const mail = renderAnnouncementPwa({ lang, name: user.name, appUrl });
    try {
      await sendBrandedMail(transport, { from, to: user.email, subject: mail.subject, text: mail.text, html: mail.html, lang });
      await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
      sent++;
    } catch (e) {
      const attempt = row.attempts + 1;
      const retry = notSent(e) && attempt < MAX_ATTEMPTS;
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: retry
          ? { payload: p, lastError: 'CONN', availableAt: new Date(now.getTime() + attempt * 10 * 60_000) }
          : { status: 'FAILED', lastError: notSent(e) ? 'CONN' : 'SMTP' },
      });
      failed++;
      log('duyuru e-postası gönderilemedi', notSent(e) ? 'CONN' : 'SMTP');
    }
  }
  return { sent, failed, skipped };
}
