// FGO işleri (Aşama 6b): kuyruktaki proforma ve faturaları keser (scripts/worker.mjs her dakika çağırır).
//   FGO_PROFORMA: sipariş ONAYLANDI adımındaysa → kur (siparişte elle girilmişse o, yoksa BT'den o an) → PRF proforma (RON)
//   FGO_INVOICE:  sipariş TESLIM_EDILDI adımındaysa → proformanın kuruyla GKH fatura (RON) → arşiv
// Sipariş bu arada başka adıma geçtiyse (ör. yönetici elle proforma girdi) iş atlanır. FGO'nun reddettiği belge
// (ör. eksik müşteri bilgisi) yeniden denenmez: yöneticiye "Önemli kararlar"da uyarı düşer, sipariş sayfasında
// "FGO'da yeniden dene" ve elle düğmeler kalır. Ağ hatası artan aralıklarla yeniden denenir.
// Aynı belge iki kez kesilmesin: FGO'ya IdExtern (sipariş no + tür) ve VerificareDuplicat gönderilir.
// Paket 10 (kararlar 207, 209):
//   FGO_PROFILE_ADVANCE: yöneticinin istediği avans faturası (camdaki avansla aynı kural: max(FGO tahsilatı, elle kayıtlar)
//   − avansı kesilen; tek satır "Avans marfă conform proformă …"). Profilde nihai fatura avans yüzünden BEKLEMEZ (ürün
//   sahibinin kararı); teslimdeki fatura kesilmiş her avansı eksi satırla ("Stornare avans …") düşer.
//   Belge kesme sonucu belirsiz kalırsa iş körlemesine yeniden denenmez: yönetici FGO'ya bakıp karar verir.
import { writeAudit, writeHistory } from '../orders/journal.js';
import { netOf } from '../glass/billing.js';
import { DOC_EMAIL } from '../documents/delivery.js';
import { centsText, toCents } from '../finance/payments.js';
import { PROFILE_ADVANCE, chainPayments, linkCoveredPayments, loadChain, orderPaymentState, orderProformaRef } from '../finance/service.js';
import { expectedGross, parkUncertain } from '../finance/uncertain.js';
import { getEnv } from '../env.js';
import { bnrRate } from '../fx/bnr.js';
import { FxUnavailable, fxDocumentText, fxSnapshot, resolveExchangeRate } from '../fx/resolve.js';
import { FGO_UM, FgoError, dailyLimitReached, emitereForm, fgoEmit, fgoKey, fgoStatus, fgoReady, getFgoSettings, missingBilling, reserveInvoiceNumber, afterInvoiceIssued, ronTotal, fgoUnit, orderDetail, uncertainEmit } from '../integrations/fgo.js';
import { claimFgoJob } from '../integrations/fgo-claim.js';
import { dayDate, localDay, localDayStart } from './dates.js';
import { FGO_INVOICE, FGO_PROFORMA, fgoActor, runProfileAction } from './transitions.js';

export const FGO_MAX_ATTEMPTS = 8;
const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120, 240, 480][Math.min(attempt, 7)];
const STAGE_OF = { [FGO_PROFORMA]: 'ONAYLANDI', [FGO_INVOICE]: 'TESLIM_EDILDI' };

/**
 * Belge satırları: müşterinin onayladığı teklifin kopyası (EUR). Birim: FGO eşlemesi (fgoUnit — en çok 5 karakter;
 * "bucăți" → "buc"). Katalog birimi olmayan satır adetle fiyatlanır (OfferLine.unit = 'adet'). Eşlemede olmayan kod
 * olduğu gibi gider; geçersizse emitereForm belgeyi FGO'ya göndermeden reddeder.
 * orderNo: kalemin FGO açıklamasına (Continut[Descriere]) yazılacak kaynak sipariş — "Comanda GLAP12" (karar 111).
 */
export function documentLines(offer, orderNo = null) {
  return offer.lines.map((l) => ({
    code: l.poz ?? '', name: l.descriptionRo || l.description, unit: fgoUnit(l.unitCode || l.unit || 'adet') ?? String(l.unitCode ?? '').trim(), qty: l.adet, eur: Number(l.offerPrice ?? 0),
    ...(orderNo ? { detail: orderDetail(orderNo) } : {}),
  }));
}

class Permanent extends Error {}

async function alert(db, orderId, code, message, attempts, jobId = null) {
  await db.$transaction(async (tx) => {
    await writeHistory(tx, { orderId, event: 'FGO_FAILED', actorId: null, note: `${code}: ${message}`.slice(0, 200) });
    await tx.adminAlert.create({ data: { type: 'FGO_FAILED', orderId, details: { code, error: message.slice(0, 300), attempts } } });
  });
  // Aynı olay uygulama içi bildirim olarak muhasebe yetkisine (işin kimliğiyle: yeniden denemede ikinci kez yazılmaz)
  const { notifyFgoFailed } = await import('../notifications/inapp.js');
  await notifyFgoFailed(db, { key: `fgo-failed:${jobId ?? `${orderId}:${code}`}`, orderId, error: message });
}

/**
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ now?: Date, fetchImpl?: typeof fetch, bnrImpl?: typeof bnrRate, secret?: string, appUrl?: string, timeZone?: string, log?: Function }} ctx
 */
export async function dispatchFgoJobs(db, { now = new Date(), fetchImpl = fetch, bnrImpl = bnrRate, secret, appUrl, timeZone, log = () => {} } = {}) {
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
    // Atomik sahiplenme + işlem kirası: FGO'ya yalnızca sahiplenen işçi gider (server/integrations/fgo-claim.js)
    if (!(await claimFgoJob(db, row, { now }))) continue;
    const attempt = row.attempts + 1;
    const skip = (why) => db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: why } });
    let prepared = null;
    let form = null;
    let lineList = [];
    let order = null;
    try {
      if (!fgoReady(settings)) {
        await skip('FGO kapalı');
        continue;
      }
      order = row.orderId ? await db.order.findUnique({
        where: { id: row.orderId },
        include: { customer: true, profile: true, fgoDocuments: true, offers: { include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
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
      // Nihai fatura: kuyrukta (ya da sonucu belirsiz) bir avans faturası varsa önce o tamamlanır — fatura onu düşebilsin
      if (row.type === FGO_INVOICE && await db.notificationOutbox.count({ where: { orderId: order.id, type: PROFILE_ADVANCE, status: 'PENDING' } })) {
        throw new Error('Avans faturası kuyrukta; fatura avans kesildikten sonra kesilir');
      }

      // Kur (karar 98, camla aynı kural): siparişte kayıtlı kur varsa (yöneticinin elle girdiği ya da proformanınki) o;
      // yoksa proformada müşterinin kur politikasından çözülür ve proformayla birlikte saklanır. Fatura yalnızca
      // kayıtlı kurla kesilir, yeniden çözmez.
      let rate = p.fxRate != null ? Number(p.fxRate) : null;
      let rateDay = p.fxDate ?? null;
      let source = p.fxSource ?? null;
      /** Yeni çözülen kurun kaydı (proformayla birlikte yazılır); kayıtlı kur kullanıldıysa boş */
      let snap = null;
      if (rate == null) {
        if (row.type === FGO_INVOICE) throw new Permanent('Proformanın kuru yok; kuru girip yeniden deneyin');
        const day = localDay(now, timeZone);
        let fx;
        try {
          fx = await resolveExchangeRate(db, { customer: order.customer, currency: 'EUR', day, now, bnrImpl });
        } catch (e) {
          // Kur alınamadıysa iş bekler ve yeniden denenir (ya da yönetici "FGO'da yeniden dene"de kuru elle girer); bozuk politika beklemez
          if (e instanceof FxUnavailable && ['BAD_POLICY', 'BAD_MANUAL', 'CURRENCY'].includes(e.code)) throw new Permanent(e.message);
          throw e;
        }
        rate = fx.rate;
        source = fx.source;
        rateDay = dayDate(day);
        snap = fxSnapshot(fx, rateDay);
      }
      const lines = documentLines(offer, order.orderNo);
      const kind = row.type === FGO_PROFORMA ? 'proforma' : 'invoice';
      if (kind === 'invoice') {
        // Avans düşümü (karar 207): kesilmiş her avans faturasının TVA hariç tutarı eksi satır olarak (sırasıyla)
        const advances = order.fgoDocuments.filter((d) => d.kind === 'ADVANCE').sort((a, b) => (a.seq ?? 1) - (b.seq ?? 1));
        for (const a of advances) {
          const gross = Number(a.total ?? a.advanced ?? 0);
          lines.push({ code: '', name: `Stornare avans conform factură ${a.series}${a.number}`, unit: FGO_UM.adet, qty: -1, ron: netOf(gross, settings.vatRate), detail: orderDetail(order.orderNo) });
        }
      }
      lineList = lines;
      // Numarayı FGO verir (karar 87); yalnızca yönetici elle numara girdiyse o numara gönderilir. Proforma hep FGO'dan.
      const sentNo = kind === 'invoice' ? await reserveInvoiceNumber(db, settings, { key, appUrl, fetchImpl }) : null;
      form = emitereForm({
        settings, key, kind, orderNo: order.orderNo, appUrl, customer: order.customer, lines, rate,
        rateText: fxDocumentText(snap ?? p),
        number: sentNo,
      });
      prepared = { kind, rate, rateDate: rateDay, source, amount: ronTotal(lines, rate), fx: snap };
      const doc = await fgoEmit(settings, form, fetchImpl);
      // Elle numara FGO'da kullanıldı: alan belge kaydından ÖNCE boşaltılır (kayıt yazılamasa bile numara yinelenmez)
      if (kind === 'invoice') await afterInvoiceIssued(db, { sent: sentNo, issued: doc.number, orderId: order.id }).catch((e) => log('fatura numarası ayarı güncellenemedi', e?.message));
      await recordProfileIssued(db, { orderId: order.id, rowId: row.id, prepared, doc });
      done++;
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
      // Belge FGO'da kesilmiş olabilir (karar 209): yeniden denenmez — yönetici FGO'ya bakıp karar verir
      if (uncertainEmit(e) && prepared && form) {
        await parkUncertain(db, row, {
          target: 'PROFILE', kind: row.type, orderIds: [order.id], orderNo: order.orderNo, prepared, expected: expectedGross(lineList, { rate: prepared.rate, vatRate: settings.vatRate }),
          series: form.Serie, idExtern: form.IdExtern, error: msg, now,
        });
        log('FGO işi: sonuç belirsiz — yönetici incelemesine gönderildi', row.type, row.orderId);
        continue;
      }
      const permanent = e instanceof Permanent || (e instanceof FgoError && !e.retry);
      const final = permanent || attempt >= FGO_MAX_ATTEMPTS;
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { lastError: msg, ...(final ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) },
      });
      if (final && row.orderId) await alert(db, row.orderId, row.type, msg, attempt, row.id);
      log('FGO işi olmadı', row.type, row.orderId, msg);
    }
  }
  return { done, failed };
}

/**
 * Kesilen profil proforması / faturası: sipariş adımı (fgo_proforma / fgo_invoice) + iş SENT. İşçinin başarı yolu; sonucu
 * belirsiz kalan ve yöneticinin FGO'dan doğruladığı belge de bununla yazılır (karar 209). İş yalnızca hâlâ bekliyorsa SENT olur.
 * @param {any} db  @param {{ orderId: string, rowId: string, prepared: any, doc: { series: string, number: string, link?: string | null } }} p
 */
export async function recordProfileIssued(db, { orderId, rowId, prepared, doc }) {
  await runProfileAction(db, {
    orderId, action: prepared.kind === 'proforma' ? 'fgo_proforma' : 'fgo_invoice', actor: fgoActor(),
    payload: { ...doc, link: doc.link ?? null, rate: prepared.rate, rateDate: prepared.rateDate, source: prepared.source, amount: prepared.amount, fx: prepared.fx },
  });
  await db.notificationOutbox.updateMany({ where: { id: rowId, status: 'PENDING' }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
}

/**
 * Profil avans faturaları (yöneticinin isteği — server/finance/service.js → requestProfileAdvance). Tutar ve sıra istekte
 * dondurulmuştur; kesim anında kaynak (FGO tahsilatı / elle kayıtlar) azaldıysa kesilmez. Tek satır, RON; kur cümlesi yok.
 * @param {any} db
 * @param {{ now?: Date, fetchImpl?: typeof fetch, secret?: string, appUrl?: string, timeZone?: string, onlyOrderId?: string | null, log?: Function }} [ctx]
 */
export async function dispatchProfileAdvanceJobs(db, { now = new Date(), fetchImpl = fetch, secret, appUrl, timeZone, onlyOrderId = null, log = () => {} } = {}) {
  const env = getEnv();
  secret ??= env.AUTH_SECRET;
  appUrl ??= env.APP_URL ?? '';
  timeZone ??= env.APP_TIMEZONE ?? 'Europe/Bucharest';
  const rows = await db.notificationOutbox.findMany({
    where: { type: PROFILE_ADVANCE, status: 'PENDING', availableAt: { lte: now }, ...(onlyOrderId ? { orderId: onlyOrderId } : {}) },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  if (rows.length === 0) return { done: 0, failed: 0 };
  const settings = await getFgoSettings(db);
  let done = 0, failed = 0;
  for (const row of rows) {
    if (!(await claimFgoJob(db, row, { now }))) continue;
    const attempt = row.attempts + 1;
    const skip = (why) => db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: why } });
    let prepared = null;
    let form = null;
    let lines = [];
    let chain = null;
    try {
      if (!fgoReady(settings)) throw new Permanent('FGO kapalı');
      chain = row.orderId ? await loadChain(db, row.orderId) : null;
      if (!chain || chain.kind !== 'ORDER' || chain.order.orderTypeCode !== 'PROFILE_ORDER' || chain.order.status === 'IPTAL' || chain.order.removedAt) {
        await skip('sipariş yok ya da iptal');
        continue;
      }
      if (chain.docs.some((d) => d.kind === 'INVOICE')) {
        await skip('fatura kesilmiş');
        continue;
      }
      const seq = Math.trunc(Number(row.payload?.seq)) || 1;
      if (chain.docs.some((d) => d.kind === 'ADVANCE' && (d.seq ?? 1) === seq)) {
        await skip('belge zaten var');
        continue;
      }
      if (!chain.proforma) throw new Permanent('Proforma yok');
      const customer = await db.customer.findUnique({ where: { id: chain.order.customerId } });
      const missing = missingBilling(customer);
      if (missing.length) throw new Permanent(`Müşterinin fatura bilgisi eksik: ${missing.join(', ')}`);
      const key = fgoKey(settings, secret);
      if (!key) throw new Permanent('FGO anahtarı açılamadı; Entegrasyonlar ekranında yeniden girin');
      if (await dailyLimitReached(db, settings, localDayStart(now, timeZone))) throw new Error(`Günlük FGO belge sınırı (${settings.dailyLimit}) doldu`);
      const payments = await chainPayments(db, chain);
      const st = orderPaymentState(chain, payments);
      const gross = Math.round(Number(row.payload?.amount ?? 0) * 100) / 100;
      if (!(gross > 0)) throw new Permanent('Avansı kesilecek tahsilat yok');
      if (gross - st.advanceRequired > 0.005) throw new Permanent(`Ödemedeki tahsilat değişti: avansı kesilecek tutar ${st.advanceRequired.toFixed(2)} RON, istenen ${gross.toFixed(2)} RON`);
      const ref = `${chain.proforma.series}${chain.proforma.number}`;
      lines = [{ code: '', name: `Avans marfă conform proformă ${ref}`, unit: FGO_UM.adet, qty: 1, ron: netOf(gross, settings.vatRate), detail: orderDetail(chain.order.orderNo) }];
      const sentNo = await reserveInvoiceNumber(db, settings, { key, appUrl, fetchImpl });
      form = emitereForm({
        settings, key, kind: 'invoice', orderNo: chain.order.orderNo, appUrl, customer, lines, rate: 1,
        extern: `${chain.order.orderNo}-A${seq > 1 ? seq : ''}`, text: `Comanda ${chain.order.orderNo}.`, rateNote: false, number: sentNo,
      });
      prepared = { kind: 'ADVANCE', seq, advanceGross: gross, basis: row.payload?.basis ?? st.advanceBasis, fgoPaid: st.fgoPaid, manualRon: st.manualRon, advancedBefore: st.advanced, amount: ronTotal(lines, 1) };
      const doc = await fgoEmit(settings, form, fetchImpl);
      await afterInvoiceIssued(db, { sent: sentNo, issued: doc.number, orderId: chain.order.id }).catch((e) => log('fatura numarası ayarı güncellenemedi', e?.message));
      await recordProfileAdvance(db, { orderId: chain.order.id, rowId: row.id, prepared, doc, now });
      done++;
      try {
        const s2 = await fgoStatus(settings, key, { series: doc.series, number: doc.number, appUrl }, fetchImpl);
        await db.fgoDocument.update({ where: { series_number: { series: doc.series, number: doc.number } }, data: { total: s2.total == null ? null : s2.total.toFixed(2), paid: s2.paid == null ? null : s2.paid.toFixed(2), checkedAt: new Date() } });
      } catch {
        // tahsilat ekranından yeniden denenir
      }
    } catch (e) {
      failed++;
      const msg = String(e?.message ?? e).slice(0, 500);
      if (uncertainEmit(e) && prepared && form) {
        await parkUncertain(db, row, {
          target: 'PROFILE_ADVANCE', kind: 'ADVANCE', orderIds: [chain.order.id], orderNo: chain.order.orderNo, prepared, expected: expectedGross(lines, { rate: 1, vatRate: settings.vatRate }),
          series: form.Serie, idExtern: form.IdExtern, error: msg, now,
        });
        log('profil avans faturası: sonuç belirsiz — yönetici incelemesine gönderildi', row.orderId);
        continue;
      }
      const final = e instanceof Permanent || (e instanceof FgoError && !e.retry) || attempt >= FGO_MAX_ATTEMPTS;
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { lastError: msg, ...(final ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) },
      });
      if (final && row.orderId) await alert(db, row.orderId, 'ADVANCE', msg, attempt, row.id);
      log('profil avans faturası kesilemedi', row.orderId, msg);
    }
  }
  return { done, failed };
}

/**
 * Kesilen profil avans faturası: FgoDocument (ADVANCE, sıra, karşıladığı tahsilat, dayanak) + elle kayıtların bağlanması +
 * müşteri e-postası + geçmiş + denetim; iş koşullu olarak SENT (karar 207, 209).
 * @param {any} db  @param {{ orderId: string, rowId: string, prepared: any, doc: { series: string, number: string, link?: string | null }, now?: Date }} p
 */
export async function recordProfileAdvance(db, { orderId, rowId, prepared: p, doc, now = new Date() }) {
  return db.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
    const job = await tx.notificationOutbox.updateMany({ where: { id: rowId, status: 'PENDING' }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
    if (!order || job.count !== 1) throw new Error('JOB_STATE');
    const created = await tx.fgoDocument.create({
      data: { orderId, kind: 'ADVANCE', seq: p.seq, series: doc.series, number: doc.number, issuedAt: now, link: doc.link ?? null, advanced: Number(p.advanceGross).toFixed(2), basis: p.basis ?? 'FGO' },
    });
    const proformaRef = await orderProformaRef(tx, orderId);
    const linked = proformaRef
      ? await linkCoveredPayments(tx, { where: { orderId, batchId: null, proformaRef }, link: { advanceDocId: created.id }, advancedTotal: centsText(toCents(p.advancedBefore) + toCents(p.advanceGross)) })
      : [];
    // Müşteri e-postası (yalnızca TAKİP — karar 111): belge kaydıyla aynı işlemde, belge başına bir kez
    await tx.notificationOutbox.create({ data: { type: DOC_EMAIL, orderId, payload: { docId: created.id } } });
    await writeHistory(tx, { orderId, event: 'FGO_DOC_ISSUED', from: order.status, to: order.status, actorId: null, note: `ADVANCE:${doc.series}${doc.number}` });
    await writeAudit(tx, {
      action: 'FGO_DOC_ISSUED', entityType: 'Order', entityId: orderId, userId: null,
      details: { kind: 'ADVANCE', seq: p.seq, series: doc.series, number: doc.number, basis: p.basis ?? 'FGO', fgoPaid: p.fgoPaid, manualRon: p.manualRon, advancedBefore: p.advancedBefore, advanceRon: p.advanceGross, payments: linked, amountRonNet: p.amount },
    }, { role: 'SYSTEM' });
    return created;
  });
}
