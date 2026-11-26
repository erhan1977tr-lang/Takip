// Müşterilere tek seferlik bilgi e-postası: "TAKİP'i ana ekrana ekleyin, telefon bildirimlerini açın" (4.2.33, karar 331;
// alıcı ve zamanlama 4.2.39).
//   - Yalnızca Admin'in açık isteğiyle (Yönetici → Duyuru, USER_MANAGE): alıcı listesi + önizleme → gönderim zamanı → onay kutusu.
//   - Bir duyuru anahtarı (ANNOUNCEMENT_KEY) yalnızca BİR kez kuyruğa girer: IntegrationSetting 'announcement:<anahtar>'
//     işareti aynı işlemde yazılır, kilit altında; ikinci istek ALREADY (çift tıklama / iki sekme ikinci e-posta üretmez).
//   - Alıcı (4.2.39, Erhan): firmanın mali belge adresi — financialRecipient (fatura e-postası, yoksa firma e-postası).
//     Firma başına bir ileti; aynı adres birden çok firmada geçiyorsa bir kez. Yalnızca panele girebilen (etkin, silinmemiş,
//     şifresini kurmuş) en az bir müşteri kullanıcısı olan firmalar. Dil: her zaman Romence (4.2.40, Erhan).
//   - Adres düzeltme (4.2.40, Erhan): Admin bu duyuru için bir firmanın adresini sayfada değiştirebilir (yalnızca bu duyuru;
//     firma kaydı değişmez). Düzeltilmiş adres kuyruk satırında override: true ile saklanır; gönderimde firmanın hâlâ
//     panele girebilen kullanıcısı varsa gider.
//   - Zaman: Admin'in seçtiği an (Bucharest saatiyle; şimdiden sonra, en çok 14 gün sonra) → kuyruk satırı o ana kadar bekler.
//   - Gönderim işçide (dispatchAnnouncements): alıcı başına en çok bir ileti — gönderimden ÖNCE işaret (sendingAt); işaretli
//     bulunan satır (işçi gönderim sırasında durdu) FAILED / UNKNOWN olur, kendiliğinden yeniden gönderilmez. Yalnızca SMTP'ye
//     hiç bağlanılamadıysa (CONN) yeniden denenir (en çok 3).
import { can } from '../auth/permissions.js';
import { writeAudit } from '../orders/journal.js';
import { financialRecipient, isEmail } from '../documents/delivery.js';
import { sendBrandedMail } from '../mail/send.js';
import { renderAnnouncementPwa } from '../mail/templates/announcement-pwa.js';

export const ANNOUNCEMENT_EMAIL = 'ANNOUNCEMENT_EMAIL';
export const ANNOUNCEMENT_KEY = 'pwa-2026-11';
export const ANNOUNCEMENT_TZ = 'Europe/Bucharest';
const MAX_AHEAD_MS = 14 * 24 * 3600_000;
const MARK = `announcement:${ANNOUNCEMENT_KEY}`;
const MAX_ATTEMPTS = 3;
const FORBIDDEN = /** @type {{ ok: false, code: 'FORBIDDEN' }} */ ({ ok: false, code: 'FORBIDDEN' });
const allowed = (actor) => !!actor?.id && can(actor.role, 'USER_MANAGE');

const USER_WHERE = { type: 'CUSTOMER', appRole: 'MUSTERI', isActive: true, deletedAt: null, passwordHash: { not: null } };
const FIRM_SELECT = {
  id: true, name: true, email: true, billingEmail: true,
  users: { where: USER_WHERE, select: { id: true }, take: 1 },
};

/** Firma → alıcı (adres yoksa null). Gönderimde de aynı kural kullanılır. */
function firmRecipient(c) {
  if (!c || !c.users?.length) return null;
  const to = financialRecipient(c);
  if (!to) return null;
  const billing = String(c.billingEmail ?? '').trim() === to;
  return { to, source: billing ? 'BILLING' : 'FIRM', lang: /** @type {'ro'} */ ('ro') };
}

/**
 * Duyuruyu alacak adresler (firma başına; aynı adres bir kez) ve adresi olmayan firmalar.
 * overrides: firma kimliği → bu duyuru için kullanılacak adres (Admin'in sayfada düzelttiği; doğrulanmış).
 * @param {any} db
 * @param {Record<string, string>} [overrides]
 * @returns {Promise<{ recipients: { to: string, lang: 'tr' | 'ro', source: 'BILLING' | 'FIRM' | 'OVERRIDE', customerIds: string[], firms: string[] }[], missing: string[] }>}
 */
export async function announcementRecipients(db, overrides = {}) {
  const firms = await db.customer.findMany({
    where: { type: 'CUSTOMER', users: { some: USER_WHERE } }, select: FIRM_SELECT, orderBy: { name: 'asc' },
  });
  const byAddr = new Map();
  const missing = [];
  for (const c of firms) {
    const o = Object.hasOwn(overrides, c.id) ? overrides[c.id] : null;
    const base = firmRecipient(c);
    const r = o && o.toLowerCase() !== base?.to.toLowerCase() ? { to: o, source: 'OVERRIDE', lang: 'ro' } : base;
    if (!r) { missing.push(c.name); continue; }
    const k = r.to.toLowerCase();
    const cur = byAddr.get(k);
    if (cur) { cur.customerIds.push(c.id); cur.firms.push(c.name); continue; }
    byAddr.set(k, { to: r.to, lang: /** @type {'ro'} */ ('ro'), source: /** @type {any} */ (r.source), customerIds: [c.id], firms: [c.name] });
  }
  return { recipients: [...byAddr.values()], missing };
}

/** Bucharest'te "YYYY-MM-DD" + "HH:MM" → UTC an (yaz / kış saati dahil). Geçersizse null. */
export function wallToUtc(day, hhmm, timeZone = ANNOUNCEMENT_TZ) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  const t = /^(\d{2}):(\d{2})$/.exec(String(hhmm ?? ''));
  if (!d || !t || Number(t[1]) > 23 || Number(t[2]) > 59) return null;
  const want = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  if (new Date(want).toISOString().slice(0, 10) !== `${d[1]}-${d[2]}-${d[3]}`) return null; // 2026-13-01, 02-30
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const wall = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  };
  let ms = want;
  for (let i = 0; i < 3; i++) ms += want - wall(ms);
  if (wall(ms) !== want) return null; // yaz saatine geçişte olmayan saat
  return new Date(ms);
}

/** Sayfanın önerdiği zaman: yarın 10:00 (Bucharest) */
export function defaultSendAt(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: ANNOUNCEMENT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = fmt.format(now);
  const [y, m, d] = today.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { day: next, time: '10:00' };
}

/**
 * Sayfa için durum: alıcı listesi, adresi olmayan firmalar, daha önce kuyruğa girdiyse ne zaman / hangi saate ve sonuçlar.
 * Hiçbir şey yazmaz.
 */
export async function announcementStatus(db, actor) {
  if (!allowed(actor)) return FORBIDDEN;
  const [mark, list, counts] = await Promise.all([
    db.integrationSetting.findUnique({ where: { key: MARK } }),
    announcementRecipients(db),
    db.notificationOutbox.groupBy({ by: ['status'], where: { type: ANNOUNCEMENT_EMAIL, payload: { path: ['key'], equals: ANNOUNCEMENT_KEY } }, _count: true }),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count]));
  const r = list.recipients;
  return {
    ok: /** @type {true} */ (true), key: ANNOUNCEMENT_KEY,
    queuedAt: mark?.value?.queuedAt ?? null, sendAt: mark?.value?.sendAt ?? null,
    list: r, missing: list.missing,
    recipients: { total: r.length, tr: r.filter((x) => x.lang === 'tr').length, ro: r.filter((x) => x.lang === 'ro').length },
    jobs: { pending: byStatus.PENDING ?? 0, sent: byStatus.SENT ?? 0, failed: byStatus.FAILED ?? 0, skipped: byStatus.SKIPPED ?? 0 },
  };
}

/**
 * Duyuruyu kuyruğa yazar (bir kez). Admin'in açık onayı (confirm) ve gönderim zamanı (sendAt) zorunlu.
 * @param {any} db
 * overrides: firma kimliği → bu duyuru için adres (boş = firmanın mali belge adresi). Her biri tek geçerli adres olmalı.
 * @param {{ actor: any, confirm: boolean, sendAt: Date | null, overrides?: Record<string, string>, ip?: string | null, now?: Date }} p
 * @returns {Promise<{ ok: true, queued: number, sendAt: string } | { ok: false, code: 'FORBIDDEN' | 'CONFIRM' | 'SEND_AT' | 'ADDRESS' | 'ALREADY' | 'NO_RECIPIENTS' }>}
 */
export async function queueAnnouncement(db, { actor, confirm, sendAt, overrides = {}, ip = null, now = new Date() }) {
  if (!allowed(actor)) return FORBIDDEN;
  if (confirm !== true) return { ok: false, code: 'CONFIRM' };
  /** @type {Record<string, string>} */
  const fixed = {};
  for (const [id, raw] of Object.entries(overrides ?? {})) {
    const v = String(raw ?? '').trim();
    if (!v) continue;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !isEmail(v)) return { ok: false, code: 'ADDRESS' };
    fixed[id] = v;
  }
  if (!(sendAt instanceof Date) || Number.isNaN(sendAt.getTime()) || sendAt <= now || sendAt.getTime() - now.getTime() > MAX_AHEAD_MS) {
    return { ok: false, code: 'SEND_AT' };
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${MARK}, 0))`;
    if (await tx.integrationSetting.findUnique({ where: { key: MARK } })) return { ok: false, code: 'ALREADY' };
    const { recipients } = await announcementRecipients(tx, fixed);
    if (!recipients.length) return { ok: false, code: 'NO_RECIPIENTS' };
    const at = new Date();
    await tx.integrationSetting.create({ data: { key: MARK, value: { queuedAt: at.toISOString(), sendAt: sendAt.toISOString(), byId: actor.id, count: recipients.length } } });
    await tx.notificationOutbox.createMany({
      data: recipients.map((r) => ({
        type: ANNOUNCEMENT_EMAIL, availableAt: sendAt, inAppAt: at,
        payload: { key: ANNOUNCEMENT_KEY, to: r.to, customerIds: r.customerIds, lang: r.lang, ...(r.source === 'OVERRIDE' ? { override: true } : {}) },
      })),
    });
    await writeAudit(tx, {
      action: 'ANNOUNCEMENT_QUEUED', entityType: 'Announcement', entityId: ANNOUNCEMENT_KEY, userId: actor.id,
      details: { key: ANNOUNCEMENT_KEY, count: recipients.length, sendAt: sendAt.toISOString(), recipient: 'FINANCIAL', lang: 'ro', overrides: recipients.filter((r) => r.source === 'OVERRIDE').length },
    }, { role: actor.role, ip });
    return { ok: true, queued: recipients.length, sendAt: sendAt.toISOString() };
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
    // Alıcı gönderim anında yeniden okunur: firmalardan biri hâlâ bu adresi mali belge adresi olarak kullanıyor ve panele
    // girebilen kullanıcısı varsa gider; adres değiştiyse / firma kaldırıldıysa atlanır (başka adrese kendiliğinden gitmez).
    const ids = Array.isArray(p.customerIds) ? p.customerIds.filter((x) => typeof x === 'string') : [];
    const firms = ids.length && typeof p.to === 'string'
      ? await db.customer.findMany({ where: { id: { in: ids }, type: 'CUSTOMER' }, select: FIRM_SELECT })
      : [];
    // Admin'in bu duyuru için düzelttiği adres: firmanın hâlâ panele girebilen kullanıcısı varsa gider
    const still = p.override === true
      ? firms.some((c) => c.users?.length > 0) && isEmail(String(p.to))
      : firms.some((c) => firmRecipient(c)?.to.toLowerCase() === String(p.to).toLowerCase());
    const user = still ? { email: String(p.to) } : null;
    if (!user) {
      await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'NO_RECIPIENT' } });
      skipped++;
      continue;
    }
    await db.notificationOutbox.update({ where: { id: row.id }, data: { payload: { ...p, sendingAt: now.toISOString() } } });
    const lang = 'ro'; // duyuru her zaman Romence (4.2.40)
    const mail = renderAnnouncementPwa({ lang, name: null, appUrl });
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
