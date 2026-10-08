// Tedarikçi sipariş e-postalarının gönderimi (işçi; Paket 6, karar 181). Kuyruk: NotificationOutbox, tür SUPPLIER_ORDER_EMAIL
// (yük: supplierOrderId, revisionId, revision, attempt). İş, "Siparişi onayla / gönder" (ya da yöneticinin açık "Tekrar
// gönder"i) ile AYNI veritabanı işleminde yazılır; burada yalnızca gönderilir.
//
// "En çok bir kez" kuralı — aynı sipariş için ikinci e-posta oluşmaz:
//   - İş atomik olarak sahiplenilir (claimFgoJob: deneme sayısı + işlem kirası) → aynı anda iki işçi aynı işi göndermez.
//   - Göndermeden hemen önce işe "gönderiliyor" işareti (sendingAt) yazılır. İşçi gönderim sırasında çökerse kira dolunca
//     iş yeniden alınır ama işaret görülür: sonuç BELİRSİZ sayılır (UNKNOWN) ve iş otomatik olarak yeniden GÖNDERİLMEZ.
//   - Otomatik yeniden deneme yalnızca e-posta sunucusuna HİÇ bağlanılamadığında (ileti kesinlikle gitmedi — definitelyNotSent).
//     Diğer her hata "Gönderilemedi" olarak kalır; yönetici "Tekrar gönder" ile açıkça yeniden yollar.
//   - "Gönderildi" yalnızca taşıyıcı iletiyi kabul ettikten sonra yazılır; gerçekte gitmemiş sipariş "Gönderildi" görünmez.
//   - İptal edilmiş / teslim alınmış siparişin ya da yeni revizyonla geçersizleşmiş revizyonun işi gönderilmez (SKIPPED).
import fsp from 'node:fs/promises';
import { writeAudit } from '../orders/journal.js';
import { claimFgoJob } from '../integrations/fgo-claim.js';
import { resolveKey } from '../files/store.js';
import { sendBrandedMail } from '../mail/send.js';
import { renderSupplierOrderEmail } from '../mail/templates/supplier-order.js';
import { notifyStaff } from '../notifications/inapp.js';
import { unitLabel } from '../profile/catalog.js';
import { definitelyNotSent, OPEN_STATUSES, showPrices, supplierEmail } from './rules.js';
import { SUPPLIER_EMAIL } from './service.js';

/** İşlem kirası: bir gönderim (ekler dahil) en kötü birkaç dakika sürer */
export const SUPPLIER_EMAIL_LEASE_MS = 10 * 60_000;
/** Bağlantı kurulamadığında (ileti gitmedi) en çok bu kadar deneme; sonra "Gönderilemedi" */
export const SUPPLIER_EMAIL_MAX_ATTEMPTS = 3;
const backoffMinutes = (attempt) => [2, 10, 30][Math.min(attempt - 1, 2)];
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const fileOk = (f) => f.scanStatus === 'CLEAN' || f.scanStatus === 'SKIPPED';

/**
 * İşi kapatır ve siparişin durumunu yazar (yalnızca iş siparişin SON kesin revizyonuna aitse ve sipariş hâlâ açıksa —
 * eski revizyonun işi yeni revizyonun durumunu değiştiremez).
 */
async function finish(db, row, payload, { jobStatus, orderStatus = null, sendError = null, sentAt = null, audit = null, lastError = null, extra = {} }) {
  return db.$transaction(async (tx) => {
    await tx.notificationOutbox.update({
      where: { id: row.id },
      data: { status: jobStatus, lastError, ...(jobStatus === 'SENT' ? { sentAt: sentAt ?? new Date() } : {}), payload: { ...payload, ...extra, sendingAt: payload.sendingAt ?? null } },
    });
    if (orderStatus) {
      const latest = await tx.supplierOrderRevision.findFirst({ where: { orderId: payload.supplierOrderId, finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, select: { id: true } });
      if (latest?.id === payload.revisionId) {
        await tx.supplierOrder.updateMany({
          where: { id: payload.supplierOrderId, status: { in: OPEN_STATUSES } },
          data: { status: orderStatus, sendError, ...(sentAt ? { sentAt } : {}), version: { increment: 1 } },
        });
      }
    }
    if (audit) await writeAudit(tx, audit, { role: 'SYSTEM' });
  });
}

/**
 * Kuyruktaki tedarikçi sipariş e-postalarını gönderir.
 * @param {any} db
 * @param {{ transport: { sendMail: (m: object) => Promise<any> } | null, from: string, now?: Date, log?: Function }} ctx
 *   transport null (SMTP ayarlı değil): hiçbir şey yapılmaz; iş kuyrukta bekler, sipariş "Gönderim bekliyor" kalır.
 * @returns {Promise<{ sent: number, failed: number, skipped: number, retried: number }>}
 */
export async function dispatchSupplierOrderEmails(db, { transport, from, now = new Date(), log = () => {} }) {
  const out = { sent: 0, failed: 0, skipped: 0, retried: 0 };
  if (!transport) return out;
  const rows = await db.notificationOutbox.findMany({ where: { type: SUPPLIER_EMAIL, status: 'PENDING', availableAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: 10 });
  for (const row of rows) {
    if (!(await claimFgoJob(db, row, { now, leaseMs: SUPPLIER_EMAIL_LEASE_MS }))) continue;
    const attempt = row.attempts + 1;
    const payload = obj(row.payload);
    const orderId = String(payload.supplierOrderId ?? '');
    try {
      // Önceki deneme gönderim sırasında yarıda kaldı (işçi çöktü): ileti gitmiş olabilir → yeniden GÖNDERİLMEZ
      if (payload.sendingAt) {
        await finish(db, row, payload, {
          jobStatus: 'FAILED', lastError: 'UNKNOWN', orderStatus: 'GONDERIM_HATASI', sendError: 'UNKNOWN',
          audit: { action: 'SUPPLIER_ORDER_EMAIL_FAILED', entityType: 'SupplierOrder', entityId: orderId, details: { revision: payload.revision ?? null, attempt, code: 'UNKNOWN', jobId: row.id } },
        });
        out.failed++;
        await notifyFailed(db, row, orderId, 'UNKNOWN');
        continue;
      }
      const order = await db.supplierOrder.findUnique({
        where: { id: orderId },
        include: {
          supplier: true,
          revisions: { where: { finalizedAt: { not: null } }, orderBy: { revision: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } }, files: { orderBy: { createdAt: 'asc' } } } },
        },
      });
      const rev = order?.revisions.find((r) => r.id === payload.revisionId) ?? null;
      // Sipariş yok / iptal / teslim alındı ya da bu revizyon yeni bir revizyonla geçersizleşti: gönderilmez
      const reason = !order || !rev ? 'GONE' : !OPEN_STATUSES.includes(order.status) ? order.status : order.revisions[0].id !== rev.id ? 'SUPERSEDED' : null;
      if (reason) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: reason } });
        out.skipped++;
        continue;
      }
      const o = /** @type {NonNullable<typeof order>} */ (order);
      const r = /** @type {NonNullable<typeof rev>} */ (rev);
      // Alıcı GÖNDERİM ANINDA Ayarlar'daki adresten çözülür (yalnızca orası değiştirir)
      const to = supplierEmail(o.supplier.email);
      if (!to) {
        await finish(db, row, payload, {
          jobStatus: 'FAILED', lastError: 'NO_EMAIL', orderStatus: 'GONDERIM_HATASI', sendError: 'NO_EMAIL',
          audit: { action: 'SUPPLIER_ORDER_EMAIL_FAILED', entityType: 'SupplierOrder', entityId: o.id, details: { orderNo: o.orderNo, revision: r.revision, attempt, code: 'NO_EMAIL', jobId: row.id } },
        });
        out.failed++;
        await notifyFailed(db, row, o.id, 'NO_EMAIL', o.orderNo);
        continue;
      }
      // Ekler: yalnızca temiz (ya da antivirüs kapalıyken taranmamış) dosyalar; diskte olmalı
      const attachments = [];
      let fileProblem = null;
      for (const f of r.files) {
        if (!fileOk(f)) { fileProblem = 'FILE_NOT_CLEAN'; break; }
        const full = resolveKey(f.storageKey);
        const content = full ? await fsp.readFile(full).catch(() => null) : null;
        if (!content) { fileProblem = 'FILE_MISSING'; break; }
        attachments.push({ filename: f.name, content, contentType: f.mime ?? 'application/octet-stream' });
      }
      if (fileProblem) {
        await finish(db, row, payload, {
          jobStatus: 'FAILED', lastError: fileProblem, orderStatus: 'GONDERIM_HATASI', sendError: fileProblem,
          audit: { action: 'SUPPLIER_ORDER_EMAIL_FAILED', entityType: 'SupplierOrder', entityId: o.id, details: { orderNo: o.orderNo, revision: r.revision, attempt, code: fileProblem, jobId: row.id } },
        });
        out.failed++;
        await notifyFailed(db, row, o.id, fileProblem, o.orderNo);
        continue;
      }
      const lines = r.lines.map((l) => ({
        code: l.code, description: l.description, color: l.color, qty: l.qty, unit: unitLabel(l.unitCode, 'tr'),
        unitPrice: l.unitPrice == null ? null : l.unitPrice.toString(), lineTotal: l.lineTotal == null ? null : l.lineTotal.toString(),
      }));
      const prices = showPrices(lines);
      const mail = renderSupplierOrderEmail({
        orderNo: o.orderNo, supplierName: o.supplier.name, orderDate: r.orderDate, revision: r.revision, currency: o.currency,
        lines, showPrices: prices, total: prices && r.total != null ? r.total.toString() : null, note: r.note, attachments: r.files.map((f) => f.name),
      });
      // "Gönderiliyor" işareti: bundan sonra yarıda kalan iş asla otomatik yeniden gönderilmez
      const sendingAt = new Date();
      await db.notificationOutbox.update({ where: { id: row.id }, data: { payload: { ...payload, sendingAt: sendingAt.toISOString() } } });
      let info;
      try {
        info = await sendBrandedMail(transport, { from, to, subject: mail.subject, text: mail.text, html: mail.html, lang: 'tr', attachments });
      } catch (e) {
        const err = /** @type {any} */ (e);
        const code = err?.responseCode ? `SMTP ${String(err.responseCode).slice(0, 3)}` : 'SMTP';
        if (definitelyNotSent(err) && attempt < SUPPLIER_EMAIL_MAX_ATTEMPTS) {
          // İleti sunucuya hiç ulaşmadı: güvenle yeniden denenir (işaret kaldırılır)
          await db.notificationOutbox.update({
            where: { id: row.id },
            data: { lastError: 'SMTP_CONN', availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000), payload: { ...payload, sendingAt: null } },
          });
          out.retried++;
          log('tedarikçi e-postası: sunucuya bağlanılamadı, yeniden denenecek', o.orderNo);
          continue;
        }
        await finish(db, row, { ...payload, sendingAt: sendingAt.toISOString() }, {
          jobStatus: 'FAILED', lastError: code, orderStatus: 'GONDERIM_HATASI', sendError: 'SMTP',
          audit: { action: 'SUPPLIER_ORDER_EMAIL_FAILED', entityType: 'SupplierOrder', entityId: o.id, details: { orderNo: o.orderNo, revision: r.revision, attempt, code, jobId: row.id } },
        });
        out.failed++;
        await notifyFailed(db, row, o.id, 'SMTP', o.orderNo);
        log('tedarikçi e-postası gönderilemedi', o.orderNo, code);
        continue;
      }
      await finish(db, row, { ...payload, sendingAt: sendingAt.toISOString() }, {
        jobStatus: 'SENT', orderStatus: 'GONDERILDI', sendError: null, sentAt: new Date(),
        extra: { to, messageId: info?.messageId ?? null, attachments: attachments.length, prices },
        audit: {
          action: 'SUPPLIER_ORDER_EMAIL_SENT', entityType: 'SupplierOrder', entityId: o.id,
          details: { orderNo: o.orderNo, revision: r.revision, attempt, to, attachments: attachments.length, prices, jobId: row.id },
        },
      });
      out.sent++;
    } catch (e) {
      // Beklenmeyen hata (veritabanı vb.): iş "gönderiliyor" işaretliyse bir sonraki alışta belirsiz sayılır; değilse
      // kira dolunca yeniden denenir (ileti gönderilmedi)
      log('tedarikçi e-postası işlenemedi', orderId, String(/** @type {any} */ (e)?.message ?? e).slice(0, 200));
    }
  }
  return out;
}

/** Gönderim hatası yöneticiye uygulama içi bildirilir (iş başına bir kez) */
function notifyFailed(db, row, orderId, code, orderNo = null) {
  return notifyStaff(db, {
    audience: 'supplier', key: `supplier-email-failed:${row.id}`, type: 'SUPPLIER_EMAIL_FAILED',
    params: { ref: orderNo ?? '', error: code }, link: `/siparisler/tedarik/${orderId}`,
  }).catch(() => 0);
}
