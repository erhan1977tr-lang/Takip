// Müşteri proformasına FGO'dan gelen tahsilattan OTOMATİK avans faturası (karar 326 — ürün sahibi, 23.11.2026).
//
// İşçi (scripts/worker.mjs) on dakikada bir çağırır. Aday = kesilmiş (ISSUED) müşteri proforması partisi; FGO belgesinde
// tahsilat > 0. Her aday için yöneticinin düğmesiyle AYNI çekirdek çalışır (autoAdvanceBatch → issueAdvance): aynı
// kilitler, aynı tutar kuralı (paymentState: tahsilat − kesilmiş avans, proforma toplamıyla sınırlı), aynı benzersiz
// anahtar — ikinci tur ya da düğmeyle eşzamanlı istek ikinci avans açamaz. Belge, mevcut parti işçisiyle (dispatchBatchJobs)
// FGO'da kesilir ve mevcut belge e-postasıyla müşteriye gider (karar 111).
//
// Kesilmez (yönetici karar verir, mevcut düğme kalır):
//   - aynı müşteride aynı tutar riski (DUPLICATE_RISK, karar 208) → muhasebeye BİR uygulama içi bildirim (proforma + tutar başına)
//   - elle kayda dayanan ya da FGO ile uyuşmayan tahsilat (MANUAL_BASIS)
// FGO kapalı / günlük sınır doldu → bu tur hiçbir şey yapılmaz, sonraki turda yeniden bakılır.
// Sipariş başına (siparişin kendi proforması) ve profil zincirlerine DOKUNMAZ.

import { autoAdvanceBatch } from './invoice-batch.js';
import { notifyStaff } from '../notifications/inapp.js';

export const AUTO_ADVANCE_EVERY_MS = 10 * 60_000;
const BATCH_LIMIT = 50;

/**
 * Adaylar: ISSUED müşteri proforması, belgesinde tahsilat var, iptal edilmemiş. Asıl karar çekirdekte (kilit altında) verilir.
 * @param {any} db
 */
export function autoAdvanceCandidates(db) {
  return db.billingBatch.findMany({
    where: { kind: 'PROFORMA', status: 'ISSUED', document: { is: { paid: { gt: 0 } } } },
    select: { id: true, customerId: true, customer: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
    take: BATCH_LIMIT * 4,
  });
}

/**
 * Bir tur. Hata bir adayı düşürür, diğerlerini durdurmaz.
 * @param {any} db
 * @param {{ now?: Date, log?: (...a: any[]) => void }} [o]
 * @returns {Promise<{ checked: number, issued: number, held: number, skipped: number, failed: number, stopped?: string }>}
 */
export async function autoAdvanceTick(db, { now = new Date(), log = () => {} } = {}) {
  const out = { checked: 0, issued: 0, held: 0, skipped: 0, failed: 0 };
  const list = await autoAdvanceCandidates(db);
  for (const c of list) {
    if (out.issued >= BATCH_LIMIT) break;
    out.checked++;
    let r;
    try {
      r = await autoAdvanceBatch(db, { proformaBatchId: c.id, now });
    } catch (e) {
      out.failed++;
      log('otomatik avans hatası:', c.id, e?.message ?? e);
      continue;
    }
    if (r.ok) { out.issued++; continue; }
    if (r.code === 'FGO_DISABLED' || r.code === 'FGO_DAILY_LIMIT') return { ...out, stopped: r.code };
    if (r.code === 'DUPLICATE_RISK') {
      out.held++;
      const amount = Number(r.amount ?? 0);
      await notifyStaff(db, {
        audience: 'accounting', key: `auto-advance-hold:${c.id}:${amount.toFixed(2)}`, type: 'ADVANCE_AUTO_HELD', firmName: c.customer?.name ?? null,
        params: { ref: String(r.ref ?? ''), amount: amount.toFixed(2).replace('.', ',') },
        link: `/admin/muhasebe/cam/proforma?musteri=${c.customerId}#partiler`,
      }).catch(() => 0);
      continue;
    }
    out.skipped++;
  }
  return out;
}
