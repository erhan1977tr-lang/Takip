// Cam siparişi FGO belgeleri (proforma → avans faturası → kapanış faturası). Profil akışından ayrıdır ve müşteri onayı
// yoktur; sipariş durumu değişmez. Yönetici sipariş sayfasındaki düğmelerle ister; belgeyi işçi keser (FGO isteği
// veritabanı işleminin dışında), kesilen belge FgoDocument'e yazılır (Muhasebe → Cam Tahsilat ile aynı kayıt) ve
// müşterinin firma e-postasına Romence e-postayla FGO bağlantısı gönderilir.
//
// Kararlar (ürün sahibi, 01.10.2026):
//   - Proforma ödendi = FGO'da proformaya tahsilat görünür VEYA yönetici "Ödeme alındı" der (tutarıyla).
//   - Avans faturası = tahsil edilen tutar (TVA dahil), tek satır "Avans marfă conform proformă …".
//   - Cam yüklendi = yükleme gününden (gerçek, yoksa tahmini) 2 gün sonra.
//   - Yüklenince kapanış faturası: cam satırları + varsa avansı düşen eksi satır ("Stornare avans").
//   - Kur: proforma günün BT kuru; avans ve kapanış faturası proformanın kuru; proforma yoksa fatura gününün kuru.
//   - Günlük belge sınırı (deneme güvenliği) FGO ayarlarında.
import { writeAudit, writeHistory } from '../orders/journal.js';
import { offerLineTotals } from '../orders/rules.js';
import { getEnv } from '../env.js';
import { fetchBtEurSell, rateForDay } from '../fx/bt.js';
import {
  FgoError, dailyLimitReached, emitereForm, fgoEmit, fgoKey, fgoReady, fgoStatus, getFgoSettings, missingBilling, ronTotal,
} from '../integrations/fgo.js';
import { dayDate, dayKeyOf, localDay, localDayStart } from '../profile/dates.js';
import { glassLabel } from '../catalog/glass.js';

export const GLASS_FGO = 'FGO_GLASS';
export const DOC_EMAIL = 'FGO_DOC_EMAIL';
export const LOADED_AFTER_DAYS = 2;
export const KINDS = ['PROFORMA', 'ADVANCE', 'INVOICE'];
const SUFFIX = { PROFORMA: 'P', ADVANCE: 'A', INVOICE: 'F' };
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Cam yüklendi mi: yükleme günü + 2 gün ≤ bugün (bugün: "YYYY-MM-DD") */
export function isLoaded(order, today) {
  const d = order.actualShipDate ?? order.estimatedShipDate;
  if (!d) return false;
  const x = new Date(`${new Date(d).toISOString().slice(0, 10)}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + LOADED_AFTER_DAYS);
  return x.toISOString().slice(0, 10) <= today;
}

/** Müşteriye gönderilmiş son teklif */
export const sentOffer = (order) => order.offers?.find((o) => o.status === 'GONDERILDI') ?? null;

/**
 * Belge satırları — yalnızca CAM (ürün sahibinin kuralı): satır adı yalnızca camın Romence niteliği (ölçü / adet yazılmaz);
 * CNC ve delik (ve m² dışındaki her satır) tutarı ait olduğu camın tutarına eklenir — üstündeki cam satırına, yoksa
 * sonraki cama. Aynı nitelikteki camlar tek satırda toplanır (m² toplamı). Bedelsiz ve fiyatsız satırlar yazılmaz.
 * @returns {{ code: string, name: string, unit: 'mp', qty: number, eurTotal: number }[]}
 */
export function glassLines(offer) {
  const groups = new Map();
  let last = null;
  let carry = 0; // camdan önce gelen ek işlem tutarı (sonraki cama eklenir)
  for (const l of offer.lines) {
    if (l.free || l.offerPrice == null) continue;
    const price = Number(l.offerPrice);
    const isGlass = (l.kind ?? 'CAM') === 'CAM' && (l.unit ?? 'm2') === 'm2';
    if (isGlass) {
      const qty = offerLineTotals({ ...l, unitPrice: 0 }).metraj;
      if (!(qty > 0)) continue;
      const name = String(l.descriptionRo || l.description).trim();
      const g = groups.get(name) ?? { code: '', name, unit: 'mp', qty: 0, eurTotal: 0 };
      g.qty = Math.round((g.qty + qty) * 1000) / 1000;
      g.eurTotal = round2(g.eurTotal + qty * price + carry);
      carry = 0;
      groups.set(name, g);
      last = g;
    } else {
      const extra = round2(Math.max(0, Math.trunc(Number(l.adet) || 0)) * price);
      if (last) last.eurTotal = round2(last.eurTotal + extra);
      else carry = round2(carry + extra);
    }
  }
  const out = [...groups.values()];
  if (carry && out.length) out[out.length - 1].eurTotal = round2(out[out.length - 1].eurTotal + carry);
  return out;
}

/** Cam satırını RON birim fiyata çevirir: (cam + işlemler) toplamı × kur / m² */
export const toRonLines = (lines, rate) => lines.map((g) => ({ code: g.code, name: g.name, unit: g.unit, qty: g.qty, ron: round2((g.eurTotal * rate) / g.qty) }));

/** TVA dahil tutar → TVA hariç birim fiyat (avans satırı) */
export const netOf = (gross, vatRate) => round2(Number(gross) / (1 + Number(vatRate) / 100));

/**
 * Düğmeler (yönetici). docs: siparişin FgoDocument'leri; billing: GlassBilling; pending: kuyruktaki belge türleri.
 * @param {{ status: string, loaded: boolean, docs: { kind: string, paid?: unknown }[], billing: { paidAmount?: unknown } | null, pending?: string[], hasOffer: boolean }} p
 * @returns {{ actions: ('proforma' | 'mark_paid' | 'advance' | 'invoice')[], paidAmount: number | null, wait: string | null }}
 */
export function billingState({ status, loaded, docs, billing, pending = [], hasOffer }) {
  const by = Object.fromEntries(docs.map((d) => [d.kind, d]));
  const proforma = by.PROFORMA;
  const docPaid = proforma?.paid != null && Number(proforma.paid) > 0 ? Number(proforma.paid) : null;
  const paidAmount = billing?.paidAmount != null ? Number(billing.paidAmount) : docPaid;
  const res = (actions, wait = null) => ({ actions, paidAmount, wait });
  if (status === 'IPTAL') return res([], 'cancelled');
  if (by.INVOICE) return res([], 'done');
  if (pending.length) return res([], 'pending');
  if (!hasOffer) return res([], 'no_offer');
  if (loaded) return res(['invoice']);
  if (!proforma) return res(['proforma']);
  if (by.ADVANCE) return res([], 'wait_loading');
  if (paidAmount == null) return res(['mark_paid'], 'wait_payment');
  return res(['advance']);
}

/** Belgeyi kuyruğa alır (yönetici). Aynı anda iki istek ya da tekrar kesim engellenir (kilit + durum + benzersiz kayıt). */
export async function requestGlassDocument(db, { orderId, kind, actor, now = new Date() }) {
  const settings = await getFgoSettings(db);
  if (!fgoReady(settings)) return { ok: false, code: 'FGO_DISABLED' };
  const tz = getEnv().APP_TIMEZONE;
  if (await dailyLimitReached(db, settings, localDayStart(now, tz))) return { ok: false, code: 'FGO_DAILY_LIMIT' };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`glass-billing:${orderId}`}, 0))`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { offers: { orderBy: { createdAt: 'desc' }, select: { id: true, status: true } }, fgoDocuments: true, glassBilling: true },
    });
    if (!order || order.orderTypeCode !== 'GLASS_ORDER') return { ok: false, code: 'NOT_FOUND' };
    const pending = await tx.notificationOutbox.findMany({ where: { orderId, type: GLASS_FGO, status: 'PENDING' } });
    const st = billingState({
      status: order.status, loaded: isLoaded(order, localDay(now, tz)), docs: order.fgoDocuments, billing: order.glassBilling,
      pending: pending.map((p) => p.payload?.kind), hasOffer: order.offers.some((o) => o.status === 'GONDERILDI'),
    });
    const action = { PROFORMA: 'proforma', ADVANCE: 'advance', INVOICE: 'invoice' }[kind];
    if (!st.actions.includes(action)) return { ok: false, code: 'NOT_ALLOWED' };
    await tx.notificationOutbox.create({ data: { type: GLASS_FGO, orderId, payload: { kind, orderNo: order.orderNo } } });
    await writeHistory(tx, { orderId, event: 'FGO_DOC_REQUESTED', from: order.status, to: order.status, actorId: actor.id, note: kind });
    await writeAudit(tx, { action: 'FGO_DOC_REQUEST', entityType: 'Order', entityId: orderId, userId: actor.id, details: { kind } }, actor);
    return { ok: true };
  });
}

/** Yönetici: proforma ödendi (tutar RON, TVA dahil) */
export async function markGlassPaid(db, { orderId, amount, actor, now = new Date() }) {
  return db.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { fgoDocuments: true } });
    if (!order || order.orderTypeCode !== 'GLASS_ORDER') return { ok: false, code: 'NOT_FOUND' };
    const docs = order.fgoDocuments;
    if (!docs.some((d) => d.kind === 'PROFORMA') || docs.some((d) => d.kind !== 'PROFORMA')) return { ok: false, code: 'NOT_ALLOWED' };
    await tx.glassBilling.upsert({
      where: { orderId },
      create: { orderId, paidAt: now, paidAmount: amount.toFixed(2), paidById: actor.id },
      update: { paidAt: now, paidAmount: amount.toFixed(2), paidById: actor.id },
    });
    await writeHistory(tx, { orderId, event: 'GLASS_PAID', from: order.status, to: order.status, actorId: actor.id, note: null });
    await writeAudit(tx, { action: 'GLASS_PAID', entityType: 'Order', entityId: orderId, userId: actor.id, details: { amountRon: amount } }, actor);
    return { ok: true };
  });
}

// ---------- işçi ----------
export const MAX_ATTEMPTS = 8;
const backoffMinutes = (attempt) => [1, 5, 15, 30, 60, 120, 240, 480][Math.min(attempt, 7)];
class Permanent extends Error {}
const ddmmyyyy = (d) => dayKeyOf(d).split('-').reverse().join('.');

/**
 * Kuyruktaki cam belgelerini keser. onlyOrderId: düğmeye basılınca o siparişin işi hemen denenir.
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ now?: Date, fetchImpl?: typeof fetch, rateImpl?: Function, secret?: string, appUrl?: string, timeZone?: string, onlyOrderId?: string | null, log?: Function }} [ctx]
 */
export async function dispatchGlassJobs(db, { now = new Date(), fetchImpl = fetch, rateImpl = fetchBtEurSell, secret, appUrl, timeZone, onlyOrderId = null, log = () => {} } = {}) {
  const env = getEnv();
  secret ??= env.AUTH_SECRET;
  appUrl ??= env.APP_URL ?? '';
  timeZone ??= env.APP_TIMEZONE ?? 'Europe/Bucharest';
  const rows = await db.notificationOutbox.findMany({
    where: { type: GLASS_FGO, status: 'PENDING', availableAt: { lte: now }, ...(onlyOrderId ? { orderId: onlyOrderId } : {}) },
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
    const kind = row.payload?.kind;
    try {
      if (!fgoReady(settings)) throw new Permanent('FGO kapalı');
      if (!KINDS.includes(kind)) throw new Permanent('bilinmeyen belge türü');
      const order = await db.order.findUnique({
        where: { id: row.orderId ?? '' },
        include: { customer: true, price: true, glassBilling: true, fgoDocuments: true, offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } } },
      });
      if (!order || order.status === 'IPTAL') throw new Permanent('sipariş yok ya da iptal');
      if (order.fgoDocuments.some((d) => d.kind === kind)) {
        await db.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'belge zaten var' } });
        continue;
      }
      const missing = missingBilling(order.customer);
      if (missing.length) throw new Permanent(`Müşterinin fatura bilgisi eksik: ${missing.join(', ')}`);
      const key = fgoKey(settings, secret);
      if (!key) throw new Permanent('FGO anahtarı açılamadı; Entegrasyonlar ekranında yeniden girin');
      if (await dailyLimitReached(db, settings, localDayStart(now, timeZone))) throw new Error(`Günlük FGO belge sınırı (${settings.dailyLimit}) doldu`);
      const offer = sentOffer(order);
      if (!offer) throw new Permanent('Müşteriye gönderilmiş teklif yok');
      if (offer.currency !== 'EUR' && offer.currency !== 'RON') throw new Permanent(`Desteklenmeyen para birimi: ${offer.currency}`);

      // Kur: proforma günün kuru; avans ve kapanış faturası proformanın kuru; proforma yoksa bugünün kuru. RON teklifte kur 1.
      const b = order.glassBilling;
      const today = localDay(now, timeZone);
      let rate, rateDay, source;
      if (offer.currency === 'RON') {
        rate = 1; rateDay = dayDate(today); source = 'RON';
      } else if (b?.fxRate != null) {
        rate = Number(b.fxRate); rateDay = b.fxDate ?? dayDate(today); source = b.fxSource ?? 'MANUAL';
      } else {
        if (kind === 'ADVANCE') throw new Permanent('Proformanın kuru yok');
        const r = await rateForDay(db, { settings, day: today, rateImpl });
        rate = r.rate; rateDay = dayDate(today); source = r.source;
      }
      const proforma = order.fgoDocuments.find((d) => d.kind === 'PROFORMA');
      const advance = order.fgoDocuments.find((d) => d.kind === 'ADVANCE');
      let lines;
      if (kind === 'ADVANCE') {
        const paid = b?.paidAmount != null ? Number(b.paidAmount) : proforma?.paid != null ? Number(proforma.paid) : 0;
        if (!(paid > 0)) throw new Permanent('Tahsil edilen tutar yok');
        lines = [{ code: '', name: `Avans marfă conform proformă ${proforma.series}${proforma.number}`, unit: 'buc', qty: 1, ron: netOf(paid, settings.vatRate) }];
      } else {
        // Romence ad: satırda yoksa katalogdaki camın Romence adı ve rengi
        const ids = offer.lines.filter((l) => !l.descriptionRo && l.glassProductId).map((l) => l.glassProductId);
        if (ids.length) {
          const glasses = new Map((await db.glassProduct.findMany({ where: { id: { in: ids } } })).map((x) => [x.id, glassLabel(x, 'ro')]));
          for (const l of offer.lines) if (!l.descriptionRo && glasses.has(l.glassProductId)) l.descriptionRo = glasses.get(l.glassProductId);
        }
        lines = toRonLines(glassLines(offer), rate);
        if (lines.length === 0) throw new Permanent('Teklifte fiyatlı cam satırı yok');
        if (kind === 'INVOICE' && advance) {
          // Avans düşümü: avans faturasının TVA hariç tutarı eksi satır olarak
          const gross = advance.total != null ? Number(advance.total) : Number(b?.paidAmount ?? 0);
          lines.push({ code: '', name: `Stornare avans conform factură ${advance.series}${advance.number}`, unit: 'buc', qty: -1, ron: netOf(gross, settings.vatRate) });
        }
      }
      const form = emitereForm({
        settings, key, kind: kind === 'PROFORMA' ? 'proforma' : 'invoice', orderNo: order.orderNo, appUrl, customer: order.customer, lines,
        rate, rateDate: ddmmyyyy(rateDay), extern: `${order.orderNo}-${SUFFIX[kind]}`,
        // Açıklama: yalnızca cam siparişinin açıklaması (ürün sahibinin isteği)
        text: order.title ?? '', rateNote: false,
      });
      const doc = await fgoEmit(settings, form, fetchImpl);
      const amount = ronTotal(lines, rate);
      await db.$transaction(async (tx) => {
        const created = await tx.fgoDocument.create({ data: { orderId: order.id, kind, series: doc.series, number: doc.number, issuedAt: now, link: doc.link } });
        if (b?.fxRate == null && kind !== 'ADVANCE') {
          await tx.glassBilling.upsert({
            where: { orderId: order.id },
            create: { orderId: order.id, fxRate: rate.toFixed(4), fxDate: rateDay, fxSource: source },
            update: { fxRate: rate.toFixed(4), fxDate: rateDay, fxSource: source },
          });
        }
        await tx.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
        await tx.notificationOutbox.create({ data: { type: DOC_EMAIL, orderId: order.id, payload: { docId: created.id } } });
        await writeHistory(tx, { orderId: order.id, event: 'FGO_DOC_ISSUED', from: order.status, to: order.status, actorId: null, note: `${kind}:${doc.series}${doc.number}` });
        await writeAudit(tx, { action: 'FGO_DOC_ISSUED', entityType: 'Order', entityId: order.id, userId: null, details: { kind, series: doc.series, number: doc.number, fxRate: rate, fxSource: source, amountRonNet: amount } }, { role: 'SYSTEM' });
      });
      done++;
      try {
        const st = await fgoStatus(settings, key, { series: doc.series, number: doc.number, appUrl }, fetchImpl);
        await db.fgoDocument.update({
          where: { series_number: { series: doc.series, number: doc.number } },
          data: { total: st.total == null ? null : st.total.toFixed(2), paid: st.paid == null ? null : st.paid.toFixed(2), checkedAt: new Date() },
        });
      } catch {
        // Muhasebe ekranından yeniden okunur
      }
    } catch (e) {
      failed++;
      const msg = String(e?.message ?? e).slice(0, 500);
      const final = e instanceof Permanent || (e instanceof FgoError && !e.retry) || attempt >= MAX_ATTEMPTS;
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { lastError: msg, ...(final ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) },
      });
      if (final && row.orderId) {
        await db.$transaction(async (tx) => {
          await writeHistory(tx, { orderId: row.orderId, event: 'FGO_FAILED', actorId: null, note: `${kind}: ${msg}`.slice(0, 200) });
          await tx.adminAlert.create({ data: { type: 'FGO_FAILED', orderId: row.orderId, details: { code: kind, error: msg.slice(0, 300), attempts: attempt } } });
        });
      }
      log('cam FGO belgesi kesilemedi', kind, row.orderId, msg);
    }
  }
  return { done, failed };
}

// ---------- müşteriye e-posta ----------
const KIND_RO = { PROFORMA: 'Factură proformă', ADVANCE: 'Factură de avans', INVOICE: 'Factură' };

/** Romence e-posta: belge no, tutar ve FGO PDF bağlantısı */
export function renderDocEmail({ kind, series, number, orderNo, total, link, firmName }) {
  const title = `${KIND_RO[kind] ?? 'Document'} ${series}${number}`;
  const amount = total != null ? `${Number(total).toFixed(2).replace('.', ',')} RON (cu TVA)` : '—';
  const text = [
    `Stimate client ${firmName},`,
    '',
    `Vă transmitem documentul ${title} pentru comanda ${orderNo}.`,
    `Număr document: ${series}${number}`,
    `Valoare: ${amount}`,
    link ? `Document (PDF): ${link}` : '',
    '',
    'Cu stimă,',
    'GKH',
  ].filter((x) => x !== '').join('\n');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<p>Stimate client ${esc(firmName)},</p><p>Vă transmitem documentul <b>${esc(title)}</b> pentru comanda <b>${esc(orderNo)}</b>.</p>`
    + `<p>Număr document: <b>${esc(`${series}${number}`)}</b><br>Valoare: <b>${esc(amount)}</b></p>`
    + (link ? `<p><a href="${esc(link)}">Deschide documentul (PDF)</a></p>` : '') + '<p>Cu stimă,<br>GKH</p>';
  return { subject: `${title} — comanda ${orderNo}`, text, html };
}

/** Kuyruktaki belge e-postalarını gönderir (alıcı: firmanın Müşteriler kartındaki e-postası). */
export async function dispatchDocEmails(db, { transport, from, now = new Date(), log = () => {} }) {
  if (!transport) return { sent: 0, failed: 0 };
  const rows = await db.notificationOutbox.findMany({ where: { type: DOC_EMAIL, status: 'PENDING', availableAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: 10 });
  let sent = 0, failed = 0;
  for (const row of rows) {
    const claimed = await db.notificationOutbox.updateMany({ where: { id: row.id, status: 'PENDING', attempts: row.attempts }, data: { attempts: { increment: 1 } } });
    if (claimed.count === 0) continue;
    const attempt = row.attempts + 1;
    try {
      const doc = await db.fgoDocument.findUnique({ where: { id: String(row.payload?.docId ?? '') }, include: { order: { include: { customer: true } } } });
      if (!doc) throw new Permanent('belge yok');
      const to = doc.order.customer.email;
      if (!to) throw new Permanent('Firmanın e-postası yok (Yönetim → Müşteriler)');
      const mail = renderDocEmail({ kind: doc.kind, series: doc.series, number: doc.number, orderNo: doc.order.orderNo, total: doc.total, link: doc.link, firmName: doc.order.customer.name });
      await transport.sendMail({ from, to, subject: mail.subject, text: mail.text, html: mail.html });
      await db.$transaction(async (tx) => {
        await tx.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
        await writeHistory(tx, { orderId: doc.orderId, event: 'FGO_DOC_EMAILED', actorId: null, note: `${doc.series}${doc.number} → ${to}` });
      });
      sent++;
    } catch (e) {
      failed++;
      const msg = String(e?.message ?? e).slice(0, 300);
      const final = e instanceof Permanent || attempt >= MAX_ATTEMPTS;
      await db.notificationOutbox.update({ where: { id: row.id }, data: { lastError: msg, ...(final ? { status: 'FAILED' } : { availableAt: new Date(now.getTime() + backoffMinutes(attempt) * 60_000) }) } });
      log('belge e-postası gönderilemedi', row.orderId, msg);
    }
  }
  return { sent, failed };
}
