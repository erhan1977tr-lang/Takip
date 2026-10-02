// FGO işleri (Aşama 6b): kuyruktaki proforma ve faturaları keser (scripts/worker.mjs her dakika çağırır).
//   FGO_PROFORMA: sipariş ONAYLANDI adımındaysa → kur (siparişte elle girilmişse o, yoksa BT'den o an) → PRF proforma (RON)
//   FGO_INVOICE:  sipariş TESLIM_EDILDI adımındaysa → proformanın kuruyla GKH fatura (RON) → arşiv
// Sipariş bu arada başka adıma geçtiyse (ör. yönetici elle proforma girdi) iş atlanır. FGO'nun reddettiği belge
// (ör. eksik müşteri bilgisi) yeniden denenmez: yöneticiye "Önemli kararlar"da uyarı düşer, sipariş sayfasında
// "FGO'da yeniden dene" ve elle düğmeler kalır. Ağ hatası artan aralıklarla yeniden denenir.
// Aynı belge iki kez kesilmesin: FGO'ya IdExtern (sipariş no + tür) ve VerificareDuplicat gönderilir.
import { writeHistory } from '../orders/journal.js';
import { getEnv } from '../env.js';
import { dailyRateFor, fetchBtEurSell } from '../fx/bt.js';
import { FgoError, dailyLimitReached, emitereForm, fgoEmit, fgoKey, fgoStatus, fgoReady, getFgoSettings, missingBilling, reserveInvoiceNumber, afterInvoiceIssued, ronTotal, fgoUnit } from '../integrations/fgo.js';
import { dayDate, dayKeyOf, localDay, localDayStart } from './dates.js';
import { FGO_INVOICE, FGO_PROFORMA, fgoActor, runProfileAction } from './transitions.js';

export const FGO_MAX_ATTEMPTS = 8;
const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120, 240, 480][Math.min(attempt, 7)];
const STAGE_OF = { [FGO_PROFORMA]: 'ONAYLANDI', [FGO_INVOICE]: 'TESLIM_EDILDI' };

/**
 * Belge satırları: müşterinin onayladığı teklifin kopyası (EUR). Birim: FGO eşlemesi (fgoUnit — en çok 5 karakter;
 * "bucăți" → "buc"). Katalog birimi olmayan satır adetle fiyatlanır (OfferLine.unit = 'adet'). Eşlemede olmayan kod
 * olduğu gibi gider; geçersizse emitereForm belgeyi FGO'ya göndermeden reddeder.
 */
export function documentLines(offer) {
  return offer.lines.map((l) => ({
    code: l.poz ?? '', name: l.descriptionRo || l.description, unit: fgoUnit(l.unitCode || l.unit || 'adet') ?? String(l.unitCode ?? '').trim(), qty: l.adet, eur: Number(l.offerPrice ?? 0),
  }));
}

class Permanent extends Error {}

async function alert(db, orderId, code, message, attempts) {
  await db.$transaction(async (tx) => {
    await writeHistory(tx, { orderId, event: 'FGO_FAILED', actorId: null, note: `${code}: ${message}`.slice(0, 200) });
    await tx.adminAlert.create({ data: { type: 'FGO_FAILED', orderId, details: { code, error: message.slice(0, 300), attempts } } });
  });
}

/**
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ now?: Date, fetchImpl?: typeof fetch, rateImpl?: typeof fetchBtEurSell, secret?: string, appUrl?: string, timeZone?: string, log?: Function }} ctx
 */
export async function dispatchFgoJobs(db, { now = new Date(), fetchImpl = fetch, rateImpl = fetchBtEurSell, secret, appUrl, timeZone, log = () => {} } = {}) {
  const env = getEnv();
  secret ??= env.AUTH_SECRET;
  appUrl ??= env.APP_URL ?? '';
  timeZone ??= env.APP_TIMEZONE ?? 'Europe/Bucharest';
  const rows = await db.notificationOutbox.findMany({
    where: { type: { in: [FGO_PROFORMA, FGO_INVOICE] }, status: 'PENDING', availableAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  if (rows.length === 0) return { done: 0, failed: 0 };
  const settings = await getFgoSettings(db);
  let done = 0, failed = 0;
  for (const row of rows) {
    const claimed = await db.notificationOutbox.updateMany({ where: { id: row.id, status: 'PENDING', attempts: row.attempts }, data: { attempts: { increment: 1 } } });
    if (claimed.count === 0) continue;
    const attempt = row.attempts + 1;
    const skip = (why) => db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: why } });
    try {
      if (!fgoReady(settings)) {
        await skip('FGO kapalı');
        continue;
      }
      const order = row.orderId ? await db.order.findUnique({
        where: { id: row.orderId },
        include: { customer: true, profile: true, offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
      }) : null;
      if (!order || order.status === 'IPTAL' || order.profile?.stage !== STAGE_OF[row.type]) {
        await skip('sipariş bu adımda değil');
        continue;
      }
      const p = order.profile;
      const offer = order.offers.find((o) => o.id === p.approvedOfferId);
      if (!offer) throw new Permanent('Onaylanan teklif bulunamadı');
      const missing = missingBilling(order.customer);
      if (missing.length) throw new Permanent(`Müşterinin fatura bilgisi eksik: ${missing.join(', ')}`);
      const key = fgoKey(settings, secret);
      if (!key) throw new Permanent('FGO anahtarı açılamadı; Entegrasyonlar ekranında yeniden girin');
      // Deneme güvenliği: günlük belge sınırı dolduysa ertesi gün yeniden denenir
      if (await dailyLimitReached(db, settings, localDayStart(now, timeZone))) throw new Error(`Günlük FGO belge sınırı (${settings.dailyLimit}) doldu`);

      // Kur: proformada siparişte elle girilmiş kur ya da BT'den o an; faturada yalnızca proformanın kuru
      let rate = p.fxRate != null ? Number(p.fxRate) : null;
      let rateDay = p.fxDate ?? null;
      let source = p.fxSource ?? null;
      if (rate == null) {
        if (row.type === FGO_INVOICE) throw new Permanent('Proformanın kuru yok; kuru girip yeniden deneyin');
        const day = localDay(now, timeZone);
        // Elle modda (varsayılan) BT'ye hiç gidilmez: yöneticinin bugün girdiği kur
        const r = settings.fxMode === 'auto' ? await rateImpl({ url: settings.fxUrl }) : { ok: false, error: 'elle' };
        if (r.ok) {
          rate = r.rate;
          source = r.source;
        } else {
          // BT okunamadıysa yöneticinin bugün girdiği kur (Entegrasyonlar → günün kuru)
          rate = await dailyRateFor(db, day);
          if (rate == null) throw new Error(settings.fxMode === 'auto' ? `BT kuru alınamadı (${r.error}); Entegrasyonlar'da günün kurunu girin` : 'Günün BT kuru girilmedi (Entegrasyonlar → Günün BT kuru); kur girilince proforma kesilir');
          source = 'MANUAL_DAY';
        }
        rateDay = dayDate(day);
      }
      const lines = documentLines(offer);
      const kind = row.type === FGO_PROFORMA ? 'proforma' : 'invoice';
      // Numarayı FGO verir (karar 87); yalnızca yönetici elle numara girdiyse o numara gönderilir. Proforma hep FGO'dan.
      const sentNo = kind === 'invoice' ? await reserveInvoiceNumber(db, settings, { key, appUrl, fetchImpl }) : null;
      const form = emitereForm({
        settings, key, kind, orderNo: order.orderNo, appUrl, customer: order.customer, lines, rate,
        rateDate: dayKeyOf(rateDay).split('-').reverse().join('.'),
        number: sentNo,
      });
      const doc = await fgoEmit(settings, form, fetchImpl);
      const amount = ronTotal(lines, rate);
      await runProfileAction(db, {
        orderId: order.id, action: kind === 'proforma' ? 'fgo_proforma' : 'fgo_invoice', actor: fgoActor(),
        payload: { ...doc, rate, rateDate: rateDay, source, amount },
      });
      await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
      done++;
      if (kind === 'invoice') await afterInvoiceIssued(db, { sent: sentNo, issued: doc.number, orderId: order.id }).catch((e) => log('fatura numarası ayarı güncellenemedi', e?.message));
      // Muhasebe: belgenin TVA dahil tutarı hemen okunur (olmazsa "FGO ile güncelle" sonra okur)
      try {
        const st = await fgoStatus(settings, key, { series: doc.series, number: doc.number, appUrl }, fetchImpl);
        await db.fgoDocument.update({
          where: { series_number: { series: doc.series, number: doc.number } },
          data: { total: st.total == null ? null : st.total.toFixed(2), paid: st.paid == null ? null : st.paid.toFixed(2), checkedAt: new Date() },
        });
      } catch {
        // tahsilat ekranından yeniden denenir
      }
    } catch (e) {
      failed++;
      const msg = String(e?.message ?? e).slice(0, 500);
      const permanent = e instanceof Permanent || (e instanceof FgoError && !e.retry);
      const final = permanent || attempt >= FGO_MAX_ATTEMPTS;
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { lastError: msg, ...(final ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) },
      });
      if (final && row.orderId) await alert(db, row.orderId, row.type, msg, attempt);
      log('FGO işi olmadı', row.type, row.orderId, msg);
    }
  }
  return { done, failed };
}
