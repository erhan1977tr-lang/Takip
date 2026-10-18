// Profil iadesi depo e-postaları (DÜZELTME 10 M8, 3.99.0) — işçi. Kuyruk: NotificationOutbox, tür PROFILE_RETURN_EMAIL
// (yük: returnId, notice OPENED | RECEIVED). İş, iadenin açılışı / depo teslimiyle AYNI işlemde yazılır; burada gönderilir.
// Alıcılar = mevcut depo alıcıları (Ayarlar → Entegrasyonlar → depo), gönderim anında çözülür; her alıcıya ayrı ileti.
// "En çok bir kez" (mal kabulü e-postasıyla aynı kural): iş atomik sahiplenilir; her alıcı için göndermeden ÖNCE "gönderiliyor"
// işareti; yarıda kalan alıcı belirsiz sayılır ve otomatik yeniden gönderilmez; yalnızca bağlantı hatası yeniden denenir.
// OPENED bildiriminin tek kullanımlık depo bağlantısı ilk alışta üretilir (iadede yalnızca özeti), iş bitince yükten silinir.
import { writeAudit } from '../orders/journal.js';
import { claimFgoJob } from '../integrations/fgo-claim.js';
import { sendBrandedMail } from '../mail/send.js';
import { renderProfileReturnEmail } from '../mail/templates/profile-return.js';
import { unitLabel } from './catalog.js';
import { getWarehouseSettings, hashToken, newToken } from './warehouse.js';
import { receiptMailNotSent } from '../suppliers/receipt-rules.js';
import { RETURN_EMAIL, RETURN_LINK_DAYS } from './returns.js';

export const RETURN_EMAIL_LEASE_MS = 10 * 60_000;
export const RETURN_EMAIL_MAX_ATTEMPTS = 8;
const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120, 240, 480][Math.min(attempt - 1, 7)];
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const norm = (s) => String(s).trim().toLowerCase();

/**
 * @param {any} db
 * @param {{ transport: { sendMail: (m: object) => Promise<any> } | null, from: string, appUrl: string, now?: Date, log?: Function }} ctx
 * @returns {Promise<{ sent: number, failed: number, retried: number, skipped: number }>}
 */
export async function dispatchReturnEmails(db, { transport, from, appUrl, now = new Date(), log = () => {} }) {
  const out = { sent: 0, failed: 0, retried: 0, skipped: 0 };
  if (!transport) return out;
  const rows = await db.notificationOutbox.findMany({ where: { type: RETURN_EMAIL, status: 'PENDING', availableAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: 10 });
  for (const row of rows) {
    if (!(await claimFgoJob(db, row, { now, leaseMs: RETURN_EMAIL_LEASE_MS }))) continue;
    const attempt = row.attempts + 1;
    const payload = obj(row.payload);
    const sentTo = list(payload.sentTo).map(norm);
    const unknown = list(payload.unknown).map(norm);
    if (typeof payload.sending === 'string' && payload.sending && !sentTo.includes(norm(payload.sending)) && !unknown.includes(norm(payload.sending))) unknown.push(norm(payload.sending));
    try {
      const r = await db.profileReturn.findUnique({
        where: { id: String(payload.returnId ?? '') },
        include: { lines: { orderBy: { sortOrder: 'asc' } }, order: { select: { id: true, orderNo: true, customer: { select: { name: true } } } } },
      });
      const opened = payload.notice === 'OPENED';
      // İade yok ya da (açılış bildiriminde) artık açık değil: gönderilmez
      if (!r || (opened && r.status !== 'ACIK')) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: r ? r.status : 'GONE', payload: { ...payload, token: null } } });
        out.skipped++;
        continue;
      }
      // Açılış bildiriminin depo bağlantısı: ilk alışta üretilir (yalnızca özeti iadede); yeniden denemede aynı bağlantı
      let token = typeof payload.token === 'string' ? payload.token : null;
      if (opened && !token) {
        token = newToken();
        await db.$transaction([
          db.profileReturn.updateMany({ where: { id: r.id, status: 'ACIK' }, data: { depotTokenHash: hashToken(token), depotTokenExpiresAt: new Date(now.getTime() + RETURN_LINK_DAYS * 86_400_000) } }),
          db.notificationOutbox.update({ where: { id: row.id }, data: { payload: { ...payload, token } } }),
        ]);
      }
      const { recipients } = await getWarehouseSettings(db);
      const todo = [...new Set(recipients.map(norm))].filter((a) => !sentTo.includes(a) && !unknown.includes(a));
      const mail = renderProfileReturnEmail({
        notice: opened ? 'OPENED' : 'RECEIVED', orderNo: r.order.orderNo, seq: r.seq, firmName: r.order.customer?.name ?? '', reason: r.reason,
        lines: r.lines.map((l) => ({ code: l.code, name: l.nameRo, qty: l.qty, unit: unitLabel(l.unitCode, 'ro'), good: l.goodQty, damaged: l.damagedQty })),
        link: opened && token ? `${appUrl}/depo-iade/${token}` : null, validDays: RETURN_LINK_DAYS,
      });
      const failedNow = [];
      for (const to of todo) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { payload: { ...payload, token, sentTo, unknown, sending: to } } });
        try {
          await sendBrandedMail(transport, { from, to, subject: mail.subject, text: mail.text, html: mail.html, lang: 'ro' });
          sentTo.push(to);
        } catch (e) {
          if (receiptMailNotSent(e)) failedNow.push(to);
          else unknown.push(to);
          log('iade e-postası bir alıcıya gönderilemedi', r.order.orderNo, r.seq);
        }
      }
      if (failedNow.length && attempt < RETURN_EMAIL_MAX_ATTEMPTS) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { lastError: 'SMTP', availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000), payload: { ...payload, token, sentTo, unknown, sending: null } } });
        out.retried++;
        continue;
      }
      const status = failedNow.length || (unknown.length && !sentTo.length) ? 'FAILED' : 'SENT';
      await db.$transaction(async (tx) => {
        // Bağlantının kendisi işten silinir (yalnızca iadedeki özeti kalır)
        await tx.notificationOutbox.update({
          where: { id: row.id },
          data: { status, lastError: failedNow.length ? 'SMTP' : unknown.length ? 'UNKNOWN' : null, ...(status === 'SENT' ? { sentAt: new Date() } : {}), payload: { ...payload, token: null, sentTo, unknown, failed: failedNow, sending: null } },
        });
        await writeAudit(tx, {
          action: status === 'SENT' ? 'PROFILE_RETURN_EMAIL_SENT' : 'PROFILE_RETURN_EMAIL_FAILED', entityType: 'Order', entityId: r.order.id,
          details: { orderNo: r.order.orderNo, returnId: r.id, seq: r.seq, notice: payload.notice, attempt, sent: sentTo.length, unknown: unknown.length, failed: failedNow.length, jobId: row.id },
        }, { role: 'SYSTEM' });
      });
      if (status === 'SENT') out.sent++;
      else out.failed++;
    } catch (e) {
      log('iade e-postası işlenemedi', String(payload.returnId ?? ''), String(/** @type {any} */ (e)?.message ?? e).slice(0, 200));
    }
  }
  return out;
}
