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
import { definitelyNotSent, missingSupplierCodes, OPEN_STATUSES, showPrices } from './rules.js';
import { SUPPLIER_EMAIL, recipientsOf } from './service.js';

/** İşlem kirası: bir gönderim (ekler dahil) en kötü birkaç dakika sürer */
export const SUPPLIER_EMAIL_LEASE_MS = 10 * 60_000;
/** Bağlantı kurulamadığında (ileti gitmedi) en çok bu kadar deneme; sonra "Gönderilemedi" */
export const SUPPLIER_EMAIL_MAX_ATTEMPTS = 3;
const backoffMinutes = (attempt) => [2, 10, 30][Math.min(attempt - 1, 2)];
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const fileOk = (f) => f.scanStatus === 'CLEAN' || f.scanStatus === 'SKIPPED';
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const norm = (a) => String(a).trim().toLowerCase();

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
 *
 * Birden çok alıcı (DÜZELTME 10 M9): tedarikçinin ETKİN adresleri (en çok 10) gönderim anında çözülür ve işe yazılır; her
 * alıcıya AYRI ileti gider (alıcılar birbirinin adresini görmez). Tek iş = tek mantıksal bildirim; her alıcının sonucu işte
 * tutulur (sentTo / unknown / failed) ve denetim kaydına yazılır. Alıcı başına "en çok bir kez": göndermeden önce o alıcı için
 * "gönderiliyor" işareti (sending) yazılır; işçi gönderim sırasında çökerse o alıcı BELİRSİZ sayılır ve otomatik yeniden
 * gönderilmez. Bağlantı hatası (ileti kesinlikle gitmedi) yalnızca o alıcı için yeniden denenir; gönderilmiş alıcıya ikinci
 * ileti gitmez. Sonuç: hepsi gönderildi → GONDERILDI; biri bile başarısız / belirsiz → GONDERIM_HATASI (PARTIAL: en az biri
 * aldı). Yöneticinin "Tekrar gönder"i yalnızca ALMAMIŞ adreslere gider.
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
    const sentTo = list(payload.sentTo).map(norm);
    const unknown = list(payload.unknown).map(norm);
    // Eski biçim (3.96 ve öncesi): tek alıcıya gönderim yarıda kaldı → belirsiz
    const legacyHalf = payload.sendingAt && !payload.recipients;
    if (typeof payload.sending === 'string' && payload.sending && !sentTo.includes(norm(payload.sending)) && !unknown.includes(norm(payload.sending))) unknown.push(norm(payload.sending));
    try {
      if (legacyHalf) {
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
      // Alıcılar: ilk alışta Ayarlar'daki ETKİN adreslerden çözülür ve işe yazılır (yeniden denemede aynı liste)
      const skip = list(payload.skip).map(norm);
      const recipients = Array.isArray(payload.recipients) ? list(payload.recipients).map(norm) : (await recipientsOf(db, o.supplierId)).map(norm).filter((a) => !skip.includes(a));
      const fail = async (code, extra = {}) => {
        await finish(db, row, { ...payload, recipients, sentTo, unknown }, {
          jobStatus: 'FAILED', lastError: code, orderStatus: 'GONDERIM_HATASI', sendError: code,
          audit: { action: 'SUPPLIER_ORDER_EMAIL_FAILED', entityType: 'SupplierOrder', entityId: o.id, details: { orderNo: o.orderNo, revision: r.revision, attempt, code, jobId: row.id, ...extra } },
        });
        out.failed++;
        await notifyFailed(db, row, o.id, code, o.orderNo);
      };
      if (!recipients.length) { await fail('NO_EMAIL'); continue; }
      // Tedarikçi ürün kodu (M5): eksik satır varsa gönderilmez (eski revizyon yeniden gönderilirken de)
      if (missingSupplierCodes(r.lines).length) { await fail('NO_SUPPLIER_CODE'); continue; }
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
      if (fileProblem) { await fail(fileProblem); continue; }
      const lines = r.lines.map((l) => ({
        code: /** @type {string} */ (l.supplierCode), description: l.description, color: l.color, qty: l.qty, unit: unitLabel(l.unitCode, 'tr'),
        unitPrice: l.unitPrice == null ? null : l.unitPrice.toString(), lineTotal: l.lineTotal == null ? null : l.lineTotal.toString(),
      }));
      const prices = showPrices(lines);
      const mail = renderSupplierOrderEmail({
        orderNo: o.orderNo, supplierName: o.supplier.name, orderDate: r.orderDate, revision: r.revision, currency: o.currency,
        lines, showPrices: prices, total: prices && r.total != null ? r.total.toString() : null, note: r.note, attachments: r.files.map((f) => f.name),
      });
      const todo = recipients.filter((a) => !sentTo.includes(a) && !unknown.includes(a));
      const failedNow = [];
      const codes = {};
      for (const to of todo) {
        // "Gönderiliyor" işareti: bu alıcı için gönderim yarıda kalırsa bir daha otomatik gönderilmez
        await db.notificationOutbox.update({ where: { id: row.id }, data: { payload: { ...payload, recipients, sentTo, unknown, sending: to } } });
        try {
          await sendBrandedMail(transport, { from, to, subject: mail.subject, text: mail.text, html: mail.html, lang: 'tr', attachments });
          sentTo.push(to);
        } catch (e) {
          const err = /** @type {any} */ (e);
          codes[to] = err?.responseCode ? `SMTP ${String(err.responseCode).slice(0, 3)}` : 'SMTP';
          if (definitelyNotSent(err)) failedNow.push(to);
          else unknown.push(to);
          log('tedarikçi e-postası bir alıcıya gönderilemedi', o.orderNo);
        }
      }
      if (failedNow.length && attempt < SUPPLIER_EMAIL_MAX_ATTEMPTS) {
        // İleti o alıcılara hiç ulaşmadı: yalnızca onlar için güvenle yeniden denenir
        await db.notificationOutbox.update({
          where: { id: row.id },
          data: { lastError: 'SMTP_CONN', availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000), payload: { ...payload, recipients, sentTo, unknown, sending: null } },
        });
        out.retried++;
        log('tedarikçi e-postası: sunucuya bağlanılamadı, yeniden denenecek', o.orderNo);
        continue;
      }
      const failed = [...failedNow, ...unknown.filter((a) => !failedNow.includes(a))];
      const results = recipients.map((a) => ({ to: a, result: sentTo.includes(a) ? 'SENT' : unknown.includes(a) ? 'UNKNOWN' : failedNow.includes(a) ? (codes[a] ?? 'SMTP') : 'SKIPPED' }));
      const allSent = failed.length === 0;
      const code = allSent ? null : sentTo.length ? 'PARTIAL' : unknown.length && !failedNow.length ? 'UNKNOWN' : 'SMTP';
      await finish(db, row, { ...payload, recipients, sentTo, unknown, failed: failedNow, sending: null, sendingAt: null }, {
        jobStatus: allSent ? 'SENT' : 'FAILED', lastError: code, orderStatus: allSent ? 'GONDERILDI' : 'GONDERIM_HATASI', sendError: code,
        sentAt: sentTo.length ? new Date() : null,
        extra: { attachments: attachments.length, prices },
        audit: {
          action: allSent ? 'SUPPLIER_ORDER_EMAIL_SENT' : 'SUPPLIER_ORDER_EMAIL_FAILED', entityType: 'SupplierOrder', entityId: o.id,
          details: { orderNo: o.orderNo, revision: r.revision, attempt, recipients: results, attachments: attachments.length, prices, jobId: row.id, ...(code ? { code } : {}) },
        },
      });
      if (allSent) out.sent++;
      else { out.failed++; await notifyFailed(db, row, o.id, code, o.orderNo); }
    } catch (e) {
      // Beklenmeyen hata (veritabanı vb.): kira dolunca yeniden denenir; gönderilmiş alıcılar yükte durur, yarıda kalan
      // alıcı bir sonraki alışta belirsiz sayılır
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
