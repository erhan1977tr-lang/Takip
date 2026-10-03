// Muhasebe → Profil / Cam Tahsilat: FGO'da kesilen belgeler ve FGO'dan okunan ödeme durumu.
// Belgeler sipariş akışında kaydedilir (fgo_proforma / fgo_invoice → FgoDocument); burada yalnızca listelenir ve
// mevcut FGO bağlantısı (server/integrations/fgo.js) üzerinden yenilenir: elle "FGO ile Güncelle" ya da işçinin
// saatlik otomatik eşitlemesi (syncFgoDocuments). Ayrı FGO bağlantısı, ayrı belge / ödeme kaydı yok.
import { FGO_NOT_FOUND, FgoError, fgoKey, fgoReady, fgoStatus, getFgoSettings } from '../integrations/fgo.js';
import { removeDeletedDocument } from '../integrations/fgo-deleted.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const numOrNull = (v) => (v == null ? null : Number(v));

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
 * Alacak (Kalan) — aynı ticari borç iki kez sayılmaz (karar 88). Belgelerin hiçbiri silinmez ya da gizlenmez; yalnızca
 * her belgenin toplama giren payı hesaplanır. Sipariş başına:
 *   - Kapanış faturası (INVOICE) varsa alacağın kaynağı faturalardır: fatura + (camda) avans faturası. Kapanış faturası
 *     avansı zaten eksi satırla düşer, bu yüzden ikisi aynı tutarı iki kez içermez. Proforma sayılmaz (replaced).
 *   - Fatura yoksa proforma alacağı temsil eder. Avans faturası kesildiyse proformanın o kadarı faturaya dönmüştür:
 *     proformadan yalnızca avans faturasının (ya da FGO'nun proformada gösterdiği tahsilatın — hangisi büyükse)
 *     karşılamadığı kısım sayılır; avans faturasının kendi kalanı ayrıca sayılır.
 * Tutarı FGO'dan henüz okunmamış belge (total yok) toplamlara girmez. Para birimleri birbirine eklenmez.
 * @param {{ id: string, orderId: string | null, batchId?: string | null, kind: string, currency: string, total: unknown, paid: unknown }[]} docs
 * @returns {{ shares: Map<string, { debt: number | null, rest: number | null, replaced: boolean }>,
 *   sums: Record<string, { total: number, paid: number, rest: number }> }}
 */
export function receivables(docs) {
  // Borcun birimi: sipariş ya da müşteri partisi (müşteri proforması — birden çok sipariş, tek belge; karar 100).
  // Partideki siparişlerin sipariş başına belgesi olamaz (çift faturalama engeli), bu yüzden aynı borç iki birimde yer almaz.
  const byOrder = new Map();
  for (const d of docs) {
    const unit = d.orderId ?? `batch:${d.batchId}`;
    if (!byOrder.has(unit)) byOrder.set(unit, []);
    byOrder.get(unit).push(d);
  }
  const shares = new Map();
  const own = (d) => ({ debt: numOrNull(d.total), rest: remaining(d.total, d.paid), replaced: false });
  for (const list of byOrder.values()) {
    const invoice = list.find((d) => d.kind === 'INVOICE');
    const advance = list.find((d) => d.kind === 'ADVANCE');
    for (const d of list) {
      if (d.kind !== 'PROFORMA') {
        shares.set(d.id, own(d));
      } else if (invoice) {
        shares.set(d.id, { debt: 0, rest: 0, replaced: true });
      } else if (d.total == null) {
        shares.set(d.id, { debt: null, rest: null, replaced: false });
      } else {
        const total = Number(d.total);
        const invoiced = Math.min(total, Number(advance?.total ?? 0)); // avans faturasına dönen kısım
        const covered = Math.max(invoiced, Number(d.paid ?? 0));
        shares.set(d.id, { debt: round2(total - invoiced), rest: round2(Math.max(0, total - covered)), replaced: false });
      }
    }
  }
  const sums = {};
  for (const d of docs) {
    const s = shares.get(d.id);
    if (s.debt == null) continue;
    const c = (sums[d.currency] ??= { total: 0, paid: 0, rest: 0 });
    c.total = round2(c.total + s.debt);
    c.rest = round2(c.rest + s.rest);
  }
  for (const c of Object.values(sums)) c.paid = round2(c.total - c.rest);
  return { shares, sums };
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

/** Sipariş tipinin belgeleri: sipariş belgeleri + (cam) müşteri partisi belgeleri */
const docsOfType = (orderType) => (orderType === 'GLASS_ORDER'
  ? { OR: [{ order: { orderTypeCode: orderType } }, { batchId: { not: null } }] }
  : { order: { orderTypeCode: orderType } });

/**
 * Belgeler (sipariş tipine göre), en yeniler önce. Müşteri proforması (parti belgesi) Cam Tahsilat'ta bir kez görünür:
 * müşterisi, kaynak siparişleri ve seçilen yükleme günleriyle.
 * @param {'PROFILE_ORDER' | 'GLASS_ORDER'} orderType
 */
export function listDocuments(db, orderType) {
  return db.fgoDocument.findMany({
    where: docsOfType(orderType),
    orderBy: [{ issuedAt: 'desc' }],
    include: {
      order: { select: { id: true, orderNo: true, status: true, customer: { select: { name: true } } } },
      batch: { select: { id: true, loadingDays: true, customer: { select: { name: true } }, orders: { select: { orderId: true, orderNo: true }, orderBy: { orderNo: 'asc' } } } },
    },
    take: 500,
  });
}

// ---------- FGO ile eşitleme: tek seferde tek tur ----------
// Elle "FGO ile Güncelle" ve işçinin otomatik eşitlemesi aynı anda çalışmasın diye ortak, süreli bir kilit
// (IntegrationSetting 'fgo-sync'; işçinin antivirüs durum kaydı gibi bir durum satırı — iş verisi değil).
export const FGO_SYNC_KEY = 'fgo-sync';
export const SYNC_EVERY_MS = 60 * 60_000;
const LEASE_MS = 10 * 60_000;

const syncValue = (row) => (row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? row.value : {});

/**
 * Son eşitleme bilgisi (Tahsilat ekranı). lastRun: son tur (elle ya da otomatik) ve o turun sayıları; lastAuto: son otomatik tur.
 * @returns {Promise<{ lastRun?: string, lastAuto?: string, checked?: number, failed?: number, leaseUntil?: string | null }>}
 */
export async function syncStatus(db) {
  return syncValue(await db.integrationSetting.findUnique({ where: { key: FGO_SYNC_KEY } }));
}

/** Kilidi alır; başka bir tur sürüyorsa false */
async function takeLease(db, now) {
  const row = await db.integrationSetting.findUnique({ where: { key: FGO_SYNC_KEY } });
  const v = syncValue(row);
  if (v.leaseUntil && new Date(v.leaseUntil).getTime() > now.getTime()) return false;
  const value = { ...v, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString() };
  if (!row) {
    try {
      await db.integrationSetting.create({ data: { key: FGO_SYNC_KEY, value } });
      return true;
    } catch {
      return false; // aynı anda başka bir tur satırı oluşturdu
    }
  }
  // Satır bu arada değiştiyse (başka tur kilidi aldı) güncelleme hiçbir satıra uymaz
  const r = await db.integrationSetting.updateMany({ where: { key: FGO_SYNC_KEY, updatedAt: row.updatedAt }, data: { value } });
  return r.count === 1;
}

async function releaseLease(db, patch) {
  const v = await syncStatus(db);
  await db.integrationSetting.update({ where: { key: FGO_SYNC_KEY }, data: { value: { ...v, ...patch, leaseUntil: null } } });
}

/**
 * FGO'dan tutar ve ödenen kısmı yeniler. FGO saniyede bir istek kabul eder; tur başına en çok `limit` belge.
 *   - Tamamen ödenmiş belgeler sorulmaz. auto (işçi): yerine fatura kesilmiş proformalar da sorulmaz (artık değişmesi
 *     alacağı etkilemez).
 *   - Elle turda FGO "belge yok" derse kayıt kaldırılır ve sipariş belgeden önceki hâline döner (karar 65). Otomatik
 *     turda bu YAPILMAZ: hata belgeye yazılır, sipariş ve kayıt olduğu gibi kalır (yönetici "FGO ile Güncelle" ile
 *     doğrular). Otomatik tur hiçbir sipariş adımını değiştirmez, yönetici uyarısı da üretmez.
 * @param {any} db
 * @param {{ orderType?: 'PROFILE_ORDER' | 'GLASS_ORDER' | null, auto?: boolean, secret: string, appUrl?: string, fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<unknown>, limit?: number, now?: Date }} opts
 * @returns {Promise<{ ok: true, checked: number, failed: number } | { ok: false, code: 'FGO_DISABLED' | 'NO_KEY' | 'BUSY' }>}
 */
export async function refreshDocuments(db, {
  orderType = null, auto = false, secret, appUrl = '', fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), limit = 40, now = new Date(),
}) {
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  const key = fgoKey(settings, secret);
  if (!key) return { ok: false, code: 'NO_KEY' };
  if (!(await takeLease(db, now))) return { ok: false, code: 'BUSY' };
  let checked = 0, failed = 0;
  try {
    const all = await db.fgoDocument.findMany({
      where: orderType ? docsOfType(orderType) : {},
      orderBy: [{ checkedAt: { sort: 'asc', nulls: 'first' } }],
    });
    const { shares } = receivables(all);
    const docs = all
      .filter((d) => paymentStatus(d.total, d.paid) !== 'PAID' && !(auto && shares.get(d.id)?.replaced))
      .slice(0, limit);
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
        // FGO'da silinmiş belge (ör. deneme faturası): elle turda kaydı kaldırılır, siparişinde düğme yeniden çıkar (karar 65)
        if (!auto && e instanceof FgoError && !e.retry && FGO_NOT_FOUND.test(e.message)) {
          await removeDeletedDocument(db, d, e.message);
          checked++;
          continue;
        }
        await db.fgoDocument.update({ where: { id: d.id }, data: { checkedAt: new Date(), checkError: String(e?.message ?? e).slice(0, 300) } });
        failed++;
      }
    }
  } finally {
    const at = now.toISOString();
    await releaseLease(db, { lastRun: at, checked, failed, ...(auto ? { lastAuto: at } : {}) });
  }
  return { ok: true, checked, failed };
}

/**
 * İşçi (scripts/worker.mjs her dakika çağırır): son otomatik turdan bu yana bir saat geçtiyse açık belgelerin FGO
 * durumunu yeniler. Sipariş işlemlerinin dışında çalışır; hatası hiçbir iş kaydını geri almaz.
 * @returns {Promise<{ ran: boolean, checked?: number, failed?: number, code?: string }>}
 */
export async function syncFgoDocuments(db, { now = new Date(), everyMs = SYNC_EVERY_MS, limit = 30, ...ctx } = {}) {
  const v = await syncStatus(db);
  if (v.lastAuto && now.getTime() - new Date(v.lastAuto).getTime() < everyMs) return { ran: false };
  const r = await refreshDocuments(db, { ...ctx, auto: true, limit, now });
  return r.ok ? { ran: true, checked: r.checked, failed: r.failed } : { ran: false, code: r.code };
}
