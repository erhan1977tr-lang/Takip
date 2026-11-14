// Mal kabulünün belgesi ve depo e-postası (3.87.0, karar 282).
//
// Belge (INTRAREA MARFĂ formu, server/pdf/intrare-marfa.js — 4.2.20, karar 320: ürün sahibinin Excel şablonu, teslim alınan
// adetler + otomatik ağırlık + palet / kutu) her istekte kabulün KOPYASINDAN üretilir (kabul ve satırları değişmez —
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
//
// Kabul düzeltmesi (3.91.0, karar 286; belge 4.2.20, karar 320): düzeltme kendi belgesini (aynı INTRAREA MARFĂ formu, güncel
// net adetlerle, "<önceki belge no> REV.n — CORECȚIE") ve kendi TEK işini alır (aynı tür, yükte correctionId). Orijinal kabulün belgesi
// ve e-postası değişmez, yeniden gönderilmez; düzeltme e-postası da yukarıdaki alıcı başına "bir kez" kuralıyla gider.
import { writeAudit } from '../orders/journal.js';
import { claimFgoJob } from '../integrations/fgo-claim.js';
import { sendBrandedMail } from '../mail/send.js';
import { renderGoodsReceiptEmail } from '../mail/templates/goods-receipt.js';
import { intrareMarfaPdf } from '../pdf/intrare-marfa.js';
import { unitLabel } from '../profile/catalog.js';
import { getWarehouseSettings } from '../profile/warehouse.js';
import { exportFileName } from '../files/export-name.js';
import { RECEIPT_EMAIL, receiptMailNotSent, receiptSummary } from './receipt-rules.js';
import { fmtKg, imChanges, imDocNo, intrareMarfaData } from './intrare-marfa.js';

export const RECEIPT_EMAIL_LEASE_MS = 10 * 60_000;
export const RECEIPT_EMAIL_MAX_ATTEMPTS = 8;
const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120, 240, 480][Math.min(attempt - 1, 7)];
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const norm = (s) => String(s).trim().toLowerCase();

/**
 * Belgenin dosya adı (e-posta eki ve indirme; Romence — 4.2.20, karar 320): "Intrare-Marfa-<sipariş no>-<kabul no>.pdf"
 * @param {string} orderNo  @param {number} seq
 */
export const receiptFileName = (orderNo, seq) => exportFileName('Intrare Marfa', [orderNo, String(seq)], 'pdf');
/**
 * Düzeltme belgesinin dosya adı: önceki Intrare Marfă belgesinin adı + "-REV.<n>" (n = o kabulün kaçıncı düzeltmesi)
 * @param {string} orderNo  @param {number} receiptSeq  @param {number} rev
 */
export const correctionFileName = (orderNo, receiptSeq, rev) => receiptFileName(orderNo, receiptSeq).replace(/\.pdf$/, `-REV.${Math.max(1, Math.trunc(Number(rev) || 1))}.pdf`);

const imLine = (l) => ({ code: l.code, name: l.nameRo, qty: l.qty, unit: unitLabel(l.unitCode, 'ro') });

/**
 * Kabulün belgesi: kopyadan INTRAREA MARFĂ formu (Romence PDF, ürün sahibinin şablonu — server/pdf/intrare-marfa.js). Teslim
 * alınan adetler forma yazılır, ağırlıklar şablonun katsayılarıyla hesaplanır; palet / kutu kabulde girilen sayılardır.
 * @param {any} db  @param {string} receiptId
 * @returns {Promise<{ buf: Buffer, receipt: any, orderNo: string, supplierName: string, docNo: string, name: string, totalGrams: number } | null>}
 */
export async function buildReceiptPdf(db, receiptId) {
  const receipt = await db.supplierReceipt.findUnique({
    where: { id: String(receiptId ?? '') },
    include: {
      lines: { orderBy: { sortOrder: 'asc' } },
      order: { select: { id: true, orderNo: true, supplier: { select: { name: true } } } },
    },
  });
  if (!receipt) return null;
  const orderNo = receipt.order.orderNo;
  const supplierName = receipt.order.supplier.name;
  const docNo = imDocNo(orderNo, receipt.seq);
  const lines = receipt.lines.map(imLine);
  const buf = intrareMarfaPdf({
    docNo, orderNo, supplierName, receivedOn: receipt.receivedOn, reference: receipt.reference,
    pallets: receipt.pallets ?? null, boxes: receipt.boxes ?? null, lines,
  });
  return { buf, receipt, orderNo, supplierName, docNo, name: receiptFileName(orderNo, receipt.seq), totalGrams: intrareMarfaData(lines).totalGrams };
}

/**
 * Düzeltmenin belgesi (REV.n): aynı INTRAREA MARFĂ formu, kabulün bu düzeltme dahil GÜNCEL (net) adetleriyle; başlıkta
 * "REV.n — CORECȚIE", önceki belgeye (aynı kabulün bir önceki hâli) referans, gerekçe ve değişen satırlar. n = düzeltmenin o
 * kabuldeki sırası (düzeltmeler eklenir, silinmez: numara değişmez). Kabul, düzeltme ve satırları kopyadır — her istekte aynı içerik.
 * @param {any} db  @param {string} correctionId
 * @returns {Promise<{ buf: Buffer, correction: any, receipt: any, orderNo: string, supplierName: string, rev: number, docNo: string, baseDocNo: string, name: string, totalGrams: number } | null>}
 */
export async function buildCorrectionPdf(db, correctionId) {
  const correction = await db.supplierReceiptCorrection.findUnique({
    where: { id: String(correctionId ?? '') },
    include: {
      lines: { orderBy: { sortOrder: 'asc' } },
      receipt: { select: { id: true, seq: true, receivedOn: true, reference: true, pallets: true, boxes: true, lines: { orderBy: { sortOrder: 'asc' } } } },
      order: { select: { id: true, orderNo: true, supplier: { select: { name: true } } } },
    },
  });
  if (!correction) return null;
  const upTo = await db.supplierReceiptCorrection.findMany({
    where: { receiptId: correction.receiptId, seq: { lte: correction.seq } }, orderBy: { seq: 'asc' },
    select: { id: true, lines: { select: { receiptLineId: true, qty: true } } },
  });
  const rev = upTo.length;
  const fixedBy = (list) => {
    const m = new Map();
    for (const c of list) for (const l of c.lines) m.set(l.receiptLineId, (m.get(l.receiptLineId) ?? 0) + l.qty);
    return m;
  };
  const netOf = (fixed) => correction.receipt.lines.map((l) => ({ ...imLine(l), qty: Math.max(0, l.qty - (fixed.get(l.id) ?? 0)) }));
  const after = netOf(fixedBy(upTo));
  const before = netOf(fixedBy(upTo.filter((c) => c.id !== correction.id)));
  const units = new Map(after.map((l) => [l.code, l.unit]));
  const orderNo = correction.order.orderNo;
  const supplierName = correction.order.supplier.name;
  const seq = correction.receipt.seq;
  const docNo = imDocNo(orderNo, seq, rev);
  const baseDocNo = imDocNo(orderNo, seq, rev - 1);
  const buf = intrareMarfaPdf({
    docNo, orderNo, supplierName, receivedOn: correction.receipt.receivedOn, reference: correction.receipt.reference,
    pallets: correction.receipt.pallets ?? null, boxes: correction.receipt.boxes ?? null, lines: after.filter((l) => l.qty > 0),
    revision: {
      no: rev, createdAt: correction.createdAt, reason: correction.reason, baseDocNo,
      changes: imChanges(before, after).map((c) => ({ ...c, unit: units.get(c.code) ?? '' })),
    },
  });
  return {
    buf, correction, receipt: correction.receipt, orderNo, supplierName, rev, docNo, baseDocNo,
    name: correctionFileName(orderNo, seq, rev), totalGrams: intrareMarfaData(after).totalGrams,
  };
}

/**
 * İşin belgesi ve e-postası: kabul işi (receiptId) ya da düzeltme işi (correctionId)
 * @returns {Promise<null | { buf: Buffer, name: string, mail: { subject: string, text: string, html: string }, orderId: string, orderNo: string, seq: number, receiptId: string, correctionId: string | null, correctionSeq: number | null }>}
 */
async function jobDocument(db, payload) {
  if (payload.correctionId) {
    const built = await buildCorrectionPdf(db, String(payload.correctionId));
    if (!built) return null;
    const c = built.correction;
    const name = built.name;
    const summary = receiptSummary(c.lines);
    const mail = renderGoodsReceiptEmail({
      orderNo: built.orderNo, supplierName: built.supplierName, seq: built.receipt.seq, receivedOn: built.receipt.receivedOn, reference: built.receipt.reference, complete: false,
      correction: { seq: c.seq, createdAt: c.createdAt, reason: c.reason },
      doc: { no: built.docNo, base: built.baseDocNo, pallets: built.receipt.pallets ?? null, boxes: built.receipt.boxes ?? null, weight: fmtKg(built.totalGrams) },
      lines: c.lines.map((l) => ({ code: l.code, name: l.nameRo, color: l.color, length: l.lengthM == null ? null : l.lengthM.toString(), qty: l.qty, unit: unitLabel(l.unitCode, 'ro') })),
      totals: summary.byUnit.map((u) => ({ qty: u.qty, unit: unitLabel(u.unitCode, 'ro') })), fileName: name,
    });
    return { buf: built.buf, name, mail, orderId: c.orderId, orderNo: built.orderNo, seq: built.receipt.seq, receiptId: built.receipt.id, correctionId: c.id, correctionSeq: c.seq };
  }
  const built = await buildReceiptPdf(db, String(payload.receiptId ?? ''));
  if (!built) return null;
  const r = built.receipt;
  const name = built.name;
  const summary = receiptSummary(r.lines);
  const mail = renderGoodsReceiptEmail({
    orderNo: built.orderNo, supplierName: built.supplierName, seq: r.seq, receivedOn: r.receivedOn, reference: r.reference, complete: r.complete,
    doc: { no: built.docNo, pallets: r.pallets ?? null, boxes: r.boxes ?? null, weight: fmtKg(built.totalGrams) },
    lines: r.lines.map((l) => ({ code: l.code, name: l.nameRo, color: l.color, length: l.lengthM == null ? null : l.lengthM.toString(), qty: l.qty, unit: unitLabel(l.unitCode, 'ro') })),
    totals: summary.byUnit.map((u) => ({ qty: u.qty, unit: unitLabel(u.unitCode, 'ro') })), fileName: name,
  });
  return { buf: built.buf, name, mail, orderId: r.orderId, orderNo: built.orderNo, seq: r.seq, receiptId: r.id, correctionId: null, correctionSeq: null };
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
      const doc = await jobDocument(db, payload);
      if (!doc) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'GONE' } });
        out.skipped++;
        continue;
      }
      const { recipients } = await getWarehouseSettings(db);
      const todo = [...new Set(recipients.map(norm))].filter((a) => !sentTo.includes(a) && !unknown.includes(a));
      const { name, mail } = doc;
      const failedNow = [];
      for (const to of todo) {
        // "Gönderiliyor" işareti: bu alıcı için gönderim yarıda kalırsa bir daha otomatik gönderilmez
        await db.notificationOutbox.update({ where: { id: row.id }, data: { payload: { ...payload, sentTo, unknown, sending: to } } });
        try {
          await sendBrandedMail(transport, {
            from, to, subject: mail.subject, text: mail.text, html: mail.html, lang: 'ro',
            attachments: [{ filename: name, content: doc.buf, contentType: 'application/pdf' }],
          });
          sentTo.push(to);
        } catch (e) {
          if (receiptMailNotSent(e)) failedNow.push(to);
          else unknown.push(to);
          log('mal kabulü e-postası bir alıcıya gönderilemedi', doc.orderNo, doc.seq);
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
        const fix = doc.correctionId ? { correctionId: doc.correctionId, correctionSeq: doc.correctionSeq } : {};
        await writeAudit(tx, {
          action: doc.correctionId ? (status === 'SENT' ? 'SUPPLIER_RECEIPT_CORRECTION_EMAIL_SENT' : 'SUPPLIER_RECEIPT_CORRECTION_EMAIL_FAILED')
            : status === 'SENT' ? 'SUPPLIER_RECEIPT_EMAIL_SENT' : 'SUPPLIER_RECEIPT_EMAIL_FAILED',
          entityType: 'SupplierOrder', entityId: doc.orderId,
          details: { orderNo: doc.orderNo, seq: doc.seq, receiptId: doc.receiptId, ...fix, attempt, sent: sentTo.length, unknown: unknown.length, failed: failedNow.length, jobId: row.id },
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
