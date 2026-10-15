// Mal kabulünün belgesi ve depo e-postası (3.87.0, karar 282).
//
// Belge (INTRAREA MARFĂ, server/pdf/goods-receipt.js) her istekte kabulün KOPYASINDAN üretilir (kabul ve satırları değişmez —
// tetikleyici): yeniden indirmek aynı içeriği verir. Fiyat / maliyet okunmaz ve belgeye girmez.
//
// Depo e-postası: kuyruk (NotificationOutbox, tür SUPPLIER_RECEIPT_EMAIL) — iş kabulle AYNI işlemde yazılır, burada işçi
// gönderir. E-posta hatası stoğu ve kabulü asla geri almaz. Alıcılar depo alıcılarıdır (Ayarlar → Entegrasyonlar, profil
// deposu e-postasıyla aynı liste); her alıcıya AYRI ileti gider, sonuç alıcı başına yükte tutulur:
//   - sentTo: iletisi kabul edilen alıcılar → bir daha gönderilmez (mükerrer bildirim yok);
//   - gönderim sırasında yarıda kalan (işçi çöktü / bağlantı kodsuz koptu) alıcı "unknown" olur → otomatik yeniden
//     GÖNDERİLMEZ (gitmiş olabilir);
//   - kesin gitmeyen (bağlanılamadı ya da sunucu açık kodla reddetti) alıcı sonraki turda yeniden denenir; bir alıcının hatası
//     öbürlerini engellemez. En çok MAX_ATTEMPTS tur; sonra iş "Gönderilemedi" (FAILED) kalır, kabul ekranında görünür.
import { writeAudit } from '../orders/journal.js';
import { claimFgoJob } from '../integrations/fgo-claim.js';
import { sendBrandedMail } from '../mail/send.js';
import { renderGoodsReceiptEmail } from '../mail/templates/goods-receipt.js';
import { goodsReceiptPdf } from '../pdf/goods-receipt.js';
import { unitLabel } from '../profile/catalog.js';
import { getWarehouseSettings } from '../profile/warehouse.js';
import { exportFileName } from '../files/export-name.js';
import { RECEIPT_EMAIL, receiptMailNotSent, receiptSummary } from './receipt-rules.js';

export const RECEIPT_EMAIL_LEASE_MS = 10 * 60_000;
export const RECEIPT_EMAIL_MAX_ATTEMPTS = 8;
const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120, 240, 480][Math.min(attempt - 1, 7)];
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const norm = (s) => String(s).trim().toLowerCase();

/** Belgenin dosya adı (e-posta eki; Romence belge) */
export const receiptFileName = (orderNo, seq) => exportFileName('Intrare Marfa', [orderNo, String(seq)], 'pdf');

/**
 * Kabulün belgesi: kopyadan Romence PDF. Görseller katalogdaki güncel ürün görselidir (yalnızca süs; miktar, kod, ad, renk,
 * uzunluk kopyadandır).
 * @param {any} db  @param {string} receiptId
 * @returns {Promise<{ buf: Buffer, receipt: any, orderNo: string, supplierName: string } | null>}
 */
export async function buildReceiptPdf(db, receiptId) {
  const receipt = await db.supplierReceipt.findUnique({
    where: { id: String(receiptId ?? '') },
    include: {
      lines: { orderBy: { sortOrder: 'asc' }, include: { product: { select: { image: { select: { data: true } } } } } },
      order: { select: { id: true, orderNo: true, supplier: { select: { name: true } } } },
    },
  });
  if (!receipt) return null;
  const categories = await db.profileCategory.findMany({ orderBy: { sortOrder: 'asc' }, select: { code: true, nameRo: true } });
  const summary = receiptSummary(receipt.lines);
  const buf = goodsReceiptPdf({
    orderNo: receipt.order.orderNo, supplierName: receipt.order.supplier.name, seq: receipt.seq, receivedOn: receipt.receivedOn,
    reference: receipt.reference, note: receipt.note, complete: receipt.complete,
    categories: categories.map((c) => ({ code: c.code, name: c.nameRo })),
    lines: receipt.lines.map((l) => ({
      code: l.code, name: l.nameRo, color: l.color, length: l.lengthM == null ? null : l.lengthM.toString(), qty: l.qty,
      unit: unitLabel(l.unitCode, 'ro'), categoryCode: l.categoryCode, image: l.product?.image ? Buffer.from(l.product.image.data) : null,
    })),
    totals: summary.byUnit.map((u) => ({ qty: u.qty, unit: unitLabel(u.unitCode, 'ro') })),
  });
  return { buf, receipt, orderNo: receipt.order.orderNo, supplierName: receipt.order.supplier.name };
}

/**
 * Kuyruktaki mal kabulü e-postalarını gönderir (işçi).
 * @param {any} db
 * @param {{ transport: { sendMail: (m: object) => Promise<any> } | null, from: string, now?: Date, log?: Function }} ctx
 *   transport null (SMTP ayarlı değil): hiçbir şey yapılmaz; iş kuyrukta bekler.
 * @returns {Promise<{ sent: number, failed: number, retried: number, skipped: number }>}
 */
export async function dispatchReceiptEmails(db, { transport, from, now = new Date(), log = () => {} }) {
  const out = { sent: 0, failed: 0, retried: 0, skipped: 0 };
  if (!transport) return out;
  const rows = await db.notificationOutbox.findMany({ where: { type: RECEIPT_EMAIL, status: 'PENDING', availableAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: 10 });
  for (const row of rows) {
    if (!(await claimFgoJob(db, row, { now, leaseMs: RECEIPT_EMAIL_LEASE_MS }))) continue;
    const attempt = row.attempts + 1;
    const payload = obj(row.payload);
    const sentTo = list(payload.sentTo).map(norm);
    const unknown = list(payload.unknown).map(norm);
    // Önceki turda gönderim sırasında yarıda kalan alıcı: ileti gitmiş olabilir → yeniden gönderilmez
    if (typeof payload.sending === 'string' && payload.sending && !sentTo.includes(norm(payload.sending)) && !unknown.includes(norm(payload.sending))) unknown.push(norm(payload.sending));
    const save = (data) => db.notificationOutbox.update({ where: { id: row.id }, data: { ...data, payload: { ...payload, sentTo, unknown, sending: null, ...(data.payload ?? {}) } } });
    try {
      const built = await buildReceiptPdf(db, String(payload.receiptId ?? ''));
      if (!built) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'GONE' } });
        out.skipped++;
        continue;
      }
      const { recipients } = await getWarehouseSettings(db);
      const todo = [...new Set(recipients.map(norm))].filter((a) => !sentTo.includes(a) && !unknown.includes(a));
      const r = built.receipt;
      const name = receiptFileName(built.orderNo, r.seq);
      const summary = receiptSummary(r.lines);
      const mail = renderGoodsReceiptEmail({
        orderNo: built.orderNo, supplierName: built.supplierName, seq: r.seq, receivedOn: r.receivedOn, reference: r.reference, complete: r.complete,
        lines: r.lines.map((l) => ({ code: l.code, name: l.nameRo, color: l.color, length: l.lengthM == null ? null : l.lengthM.toString(), qty: l.qty, unit: unitLabel(l.unitCode, 'ro') })),
        totals: summary.byUnit.map((u) => ({ qty: u.qty, unit: unitLabel(u.unitCode, 'ro') })), fileName: name,
      });
      const failedNow = [];
      for (const to of todo) {
        // "Gönderiliyor" işareti: bu alıcı için gönderim yarıda kalırsa bir daha otomatik gönderilmez
        await db.notificationOutbox.update({ where: { id: row.id }, data: { payload: { ...payload, sentTo, unknown, sending: to } } });
        try {
          await sendBrandedMail(transport, {
            from, to, subject: mail.subject, text: mail.text, html: mail.html, lang: 'ro',
            attachments: [{ filename: name, content: built.buf, contentType: 'application/pdf' }],
          });
          sentTo.push(to);
        } catch (e) {
          if (receiptMailNotSent(e)) failedNow.push(to);
          else unknown.push(to);
          log('mal kabulü e-postası bir alıcıya gönderilemedi', built.orderNo, r.seq);
        }
      }
      if (failedNow.length && attempt < RECEIPT_EMAIL_MAX_ATTEMPTS) {
        await save({ lastError: 'SMTP', availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) });
        out.retried++;
        continue;
      }
      const status = failedNow.length || (unknown.length && !sentTo.length) ? 'FAILED' : 'SENT';
      const lastError = failedNow.length ? 'SMTP' : unknown.length ? 'UNKNOWN' : null;
      await db.$transaction(async (tx) => {
        await tx.notificationOutbox.update({
          where: { id: row.id },
          data: { status, lastError, ...(status === 'SENT' ? { sentAt: new Date() } : {}), payload: { ...payload, sentTo, unknown, failed: failedNow, sending: null } },
        });
        await writeAudit(tx, {
          action: status === 'SENT' ? 'SUPPLIER_RECEIPT_EMAIL_SENT' : 'SUPPLIER_RECEIPT_EMAIL_FAILED', entityType: 'SupplierOrder', entityId: r.orderId,
          details: { orderNo: built.orderNo, seq: r.seq, receiptId: r.id, attempt, sent: sentTo.length, unknown: unknown.length, failed: failedNow.length, jobId: row.id },
        }, { role: 'SYSTEM' });
      });
      if (status === 'SENT') out.sent++;
      else out.failed++;
    } catch (e) {
      // Beklenmeyen hata (veritabanı, PDF): kira dolunca yeniden denenir; gönderilmiş alıcılar yükte durur
      log('mal kabulü e-postası işlenemedi', String(payload.receiptId ?? ''), String(/** @type {any} */ (e)?.message ?? e).slice(0, 200));
    }
  }
  return out;
}
