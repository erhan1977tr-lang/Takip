// Muhasebe → Profil / Cam Tahsilat: FGO'da kesilen belgeler ve FGO'dan okunan ödeme durumu.
// Belgeler sipariş akışında kaydedilir (fgo_proforma / fgo_invoice → FgoDocument); burada yalnızca listelenir ve
// "FGO ile güncelle" ile mevcut FGO bağlantısı (server/integrations/fgo.js) üzerinden yenilenir. Ayrı FGO bağlantısı yok.
import { FGO_NOT_FOUND, FgoError, fgoKey, fgoReady, fgoStatus, getFgoSettings, removeDeletedDocument } from '../integrations/fgo.js';

/**
 * Ödeme durumu: 0 → Ödenmedi · 0 < ödenen < toplam → Kısmi · ödenen ≥ toplam → Ödendi. Toplam henüz okunmadıysa UNKNOWN.
 * @returns {'UNKNOWN' | 'UNPAID' | 'PARTIAL' | 'PAID'}
 */
export function paymentStatus(total, paid) {
  if (total == null) return 'UNKNOWN';
  const t = Number(total);
  const p = Number(paid ?? 0);
  if (p <= 0) return 'UNPAID';
  if (p + 0.005 < t) return 'PARTIAL';
  return 'PAID';
}

/** Kalan = toplam − ödenen (eksiye düşmez); toplam yoksa null */
export function remaining(total, paid) {
  if (total == null) return null;
  return Math.max(0, Math.round((Number(total) - Number(paid ?? 0)) * 100) / 100);
}

/**
 * Önceki sürümlerde (kayıt tablosundan önce) FGO'dan kesilmiş belgeler: siparişteki numaradan kaydedilir.
 * Yalnızca FGO bağlantısı olan (proformaLink / invoiceLink dolu) ve seri öneki tutan belgeler.
 */
export async function backfillDocuments(db) {
  const s = await getFgoSettings(db);
  const rows = await db.profileOrder.findMany({
    where: { OR: [{ proformaLink: { not: null } }, { invoiceLink: { not: null } }] },
    select: { orderId: true, proformaNo: true, proformaAt: true, proformaLink: true, invoiceNo: true, invoicedAt: true, invoiceLink: true },
  });
  let added = 0;
  for (const r of rows) {
    const docs = [
      r.proformaLink && r.proformaNo && { kind: 'PROFORMA', no: r.proformaNo, series: s.proformaSeries, at: r.proformaAt, link: r.proformaLink },
      r.invoiceLink && r.invoiceNo && { kind: 'INVOICE', no: r.invoiceNo, series: s.invoiceSeries, at: r.invoicedAt, link: r.invoiceLink },
    ].filter(Boolean);
    for (const d of docs) {
      if (!d.no.startsWith(d.series)) continue;
      const number = d.no.slice(d.series.length);
      if (!number) continue;
      const exists = await db.fgoDocument.findUnique({ where: { series_number: { series: d.series, number } } });
      if (exists) continue;
      await db.fgoDocument.create({ data: { orderId: r.orderId, kind: d.kind, series: d.series, number, issuedAt: d.at ?? new Date(), link: d.link } });
      added++;
    }
  }
  return added;
}

/**
 * Belgeler (sipariş tipine göre), en yeniler önce.
 * @param {'PROFILE_ORDER' | 'GLASS_ORDER'} orderType
 */
export function listDocuments(db, orderType) {
  return db.fgoDocument.findMany({
    where: { order: { orderTypeCode: orderType } },
    orderBy: [{ issuedAt: 'desc' }],
    include: { order: { select: { id: true, orderNo: true, status: true, customer: { select: { name: true } } } } },
    take: 500,
  });
}

/**
 * FGO'dan tutar ve ödenen kısmı yeniler. Tamamen ödenmiş belgeler atlanır. FGO saniyede bir istek kabul eder.
 * @returns {Promise<{ ok: true, checked: number, failed: number } | { ok: false, code: 'FGO_DISABLED' | 'NO_KEY' }>}
 */
export async function refreshDocuments(db, { orderType, secret, appUrl = '', fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), limit = 40 }) {
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  const key = fgoKey(settings, secret);
  if (!key) return { ok: false, code: 'NO_KEY' };
  const docs = (await db.fgoDocument.findMany({
    where: { order: { orderTypeCode: orderType } },
    orderBy: [{ checkedAt: { sort: 'asc', nulls: 'first' } }],
  })).filter((d) => paymentStatus(d.total, d.paid) !== 'PAID').slice(0, limit);
  let checked = 0, failed = 0;
  for (const [i, d] of docs.entries()) {
    if (i > 0) await sleep(1100);
    try {
      const r = await fgoStatus(settings, key, { series: d.series, number: d.number, appUrl }, fetchImpl);
      await db.fgoDocument.update({
        where: { id: d.id },
        data: { total: r.total == null ? d.total : r.total.toFixed(2), paid: r.paid == null ? d.paid : r.paid.toFixed(2), checkedAt: new Date(), checkError: null },
      });
      checked++;
    } catch (e) {
      // FGO'da silinmiş belge (ör. deneme faturası): kaydı kaldırılır, numarası yeniden kullanılabilir (karar 64)
      if (e instanceof FgoError && !e.retry && FGO_NOT_FOUND.test(e.message)) {
        await removeDeletedDocument(db, d, e.message);
        checked++;
        continue;
      }
      await db.fgoDocument.update({ where: { id: d.id }, data: { checkedAt: new Date(), checkError: String(e?.message ?? e).slice(0, 300) } });
      failed++;
    }
  }
  return { ok: true, checked, failed };
}
