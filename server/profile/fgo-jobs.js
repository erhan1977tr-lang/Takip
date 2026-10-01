// FGO işleri (Aşama 6b): kuyruktaki proforma ve faturaları keser (scripts/worker.mjs her dakika çağırır).
//   FGO_PROFORMA: sipariş ONAYLANDI adımındaysa → kur (siparişte elle girilmişse o, yoksa BT'den o an) → PRF proforma (RON)
//   FGO_INVOICE:  sipariş TESLIM_EDILDI adımındaysa → proformanın kuruyla GKH fatura (RON) → arşiv
// Sipariş bu arada başka adıma geçtiyse (ör. yönetici elle proforma girdi) iş atlanır. FGO'nun reddettiği belge
// (ör. eksik müşteri bilgisi) yeniden denenmez: yöneticiye "Önemli kararlar"da uyarı düşer, sipariş sayfasında
// "FGO'da yeniden dene" ve elle düğmeler kalır. Ağ hatası artan aralıklarla yeniden denenir.
// Aynı belge iki kez kesilmesin: FGO'ya IdExtern (sipariş no + tür) ve VerificareDuplicat gönderilir.
import { writeHistory } from '../orders/journal.js';
import { getEnv } from '../env.js';
import { fetchBtEurSell } from '../fx/bt.js';
import { FgoError, emitereForm, fgoEmit, fgoKey, fgoReady, getFgoSettings, missingBilling, ronTotal } from '../integrations/fgo.js';
import { unitLabel } from './catalog.js';
import { dayDate, dayKeyOf, localDay } from './dates.js';
import { FGO_INVOICE, FGO_PROFORMA, fgoActor, runProfileAction } from './transitions.js';

export const FGO_MAX_ATTEMPTS = 8;
const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120, 240, 480][Math.min(attempt, 7)];
const STAGE_OF = { [FGO_PROFORMA]: 'ONAYLANDI', [FGO_INVOICE]: 'TESLIM_EDILDI' };

/** Belge satırları: müşterinin onayladığı teklifin kopyası (EUR) */
export function documentLines(offer) {
  return offer.lines.map((l) => ({
    code: l.poz ?? '', name: l.descriptionRo || l.description, unit: unitLabel(l.unitCode ?? '', 'ro'), qty: l.adet, eur: Number(l.offerPrice ?? 0),
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

      // Kur: proformada siparişte elle girilmiş kur ya da BT'den o an; faturada yalnızca proformanın kuru
      let rate = p.fxRate != null ? Number(p.fxRate) : null;
      let rateDay = p.fxDate ?? null;
      let source = p.fxSource ?? null;
      if (rate == null) {
        if (row.type === FGO_INVOICE) throw new Permanent('Proformanın kuru yok; kuru girip yeniden deneyin');
        const r = await rateImpl({ url: settings.fxUrl });
        if (!r.ok) throw new Error(`BT kuru alınamadı: ${r.error}`);
        rate = r.rate;
        rateDay = dayDate(localDay(now, timeZone));
        source = r.source;
      }
      const lines = documentLines(offer);
      const kind = row.type === FGO_PROFORMA ? 'proforma' : 'invoice';
      const form = emitereForm({
        settings, key, kind, orderNo: order.orderNo, appUrl, customer: order.customer, lines, rate,
        rateDate: dayKeyOf(rateDay).split('-').reverse().join('.'),
      });
      const doc = await fgoEmit(settings, form, fetchImpl);
      const amount = ronTotal(lines, rate);
      await runProfileAction(db, {
        orderId: order.id, action: kind === 'proforma' ? 'fgo_proforma' : 'fgo_invoice', actor: fgoActor(),
        payload: { ...doc, rate, rateDate: rateDay, source, amount },
      });
      await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
      done++;
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
