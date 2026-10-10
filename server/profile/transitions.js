// Profil siparişi iş akışı işlemleri (Aşama 6). Cam siparişiyle aynı çalıştırıcıdan geçer (server/orders/transitions.js →
// executeAction): yetki/adım kontrolü, tek veritabanı işleminde değişiklik + geçmiş + denetim + bildirim kuyruğu, iyimser kilit.
import { WorkflowError } from '../domain/workflow.js';
import { outboxEvent } from '../domain/outbox.js';
import { DOC_EMAIL } from '../documents/delivery.js';
import { getEnv } from '../env.js';
import { executeAction } from '../orders/transitions.js';
import { DEPOT_CALENDAR, DEPOT_TIME_ZONE, NoOpenDayError, dayDate, dayKeyOf, localDay, pickupOnForward, pickupProblem } from './dates.js';
import { BEFORE_WAREHOUSE, PICKUP_EDITABLE, PROFILE_TYPE, cleanPhone, cleanPlate, customerPickupOpen, missingPickup, missingPrices, optionalField, orderStatusFor, parsePrice, profileActions, profileTotals } from './rules.js';
import { calendarOverrides } from '../calendar/service.js';
import { can } from '../auth/permissions.js';
import { deductOrderStock, returnOrderStock, shortages, stockLevels, stockLockKeys } from './stock.js';
import { fgoReady, getFgoSettings } from '../integrations/fgo.js';
import { parseManualRate } from '../fx/bt.js';
import { FX_SNAPSHOT_CLEAR, fxSnapshot, manualExchangeRate } from '../fx/resolve.js';

export { WorkflowError };

const INCLUDE = {
  profile: true,
  profileItems: { orderBy: { sortOrder: 'asc' } },
  offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
};

/** Depo e-postası kuyruk olayı (server/profile/warehouse.js gönderir) */
export const WAREHOUSE_EMAIL = 'WAREHOUSE_EMAIL';
/** FGO kuyruk olayları (server/profile/fgo-jobs.js keser): proforma (onayda) ve fatura (teslimde) */
export const FGO_PROFORMA = 'FGO_PROFORMA';
export const FGO_INVOICE = 'FGO_INVOICE';
/** FGO işçisinin yapabildiği işlemler (kişi değil) */
const FGO_SYSTEM_ACTIONS = { fgo_proforma: 'ONAYLANDI', fgo_invoice: 'TESLIM_EDILDI' };

export const profileWorkflow = {
  orderType: PROFILE_TYPE,
  check({ orderType, action, actor, ctx }) {
    if (orderType !== PROFILE_TYPE) return { ok: false, code: 'WRONG_ORDER_TYPE' };
    const o = ctx.order;
    const stage = o.profile?.stage;
    if (!stage) return { ok: false, code: 'NOT_ALLOWED' };
    // Depo bağlantısı: yalnızca "teslim edildi", sipariş depodayken
    if (actor.depot) return action === 'mark_delivered' && stage === 'DEPODA' && o.status !== 'IPTAL' ? { ok: true, to: null } : { ok: false, code: 'NOT_ALLOWED' };
    // FGO işçisi: yalnızca belge kesildiğini kaydeder, sipariş o adımdayken
    // FGO'da silinmiş belgenin kaydı her adımda kaldırılabilir (karar 65)
    if (actor.fgo && action === 'fgo_doc_deleted') return { ok: true, to: null };
    if (actor.fgo) return FGO_SYSTEM_ACTIONS[action] === stage && o.status !== 'IPTAL' ? { ok: true, to: null } : { ok: false, code: 'NOT_ALLOWED' };
    const acts = profileActions({ role: actor.role, stage, status: o.status, canApprove: !!actor.canApprove, paid: !!o.profile.paidAt });
    return acts.includes(action) ? { ok: true, to: null } : { ok: false, code: 'NOT_ALLOWED' };
  },
};

const today = (now) => dayDate(localDay(now, getEnv().APP_TIMEZONE));
const dayText = (d) => dayKeyOf(d).split('-').reverse().join('.');
const latestOffer = (o) => o.offers[0] ?? null;
const latestSent = (o) => o.offers.find((x) => x.status === 'GONDERILDI') ?? null;

/** Adımı değiştirir; genel sipariş durumu adıma göre güncellenir (fiyat beklerken SLA işler, sonra işlemez). */
async function setStage(h, stage, extra = {}) {
  await h.tx.profileOrder.update({ where: { orderId: h.order.id }, data: { stage, stageSince: h.now, ...extra } });
  const status = orderStatusFor(stage);
  await h.set({ ...(status !== h.status ? { status } : {}), ...(stage !== 'FIYAT_BEKLIYOR' ? { slaDeadline: null } : {}) });
  h.stage = stage;
}

/**
 * Formdan gelen müşteri fiyatlarını teklif satırlarına uygular (yalnızca fiyat; adetler müşterinindir).
 * @param {{ id: string, offerPrice: unknown }[]} input
 * @returns {object[]} güncel satırlar (offerPrice sayı ya da null)
 */
function applyPrices(lines, input) {
  const byId = new Map((input ?? []).map((l) => [l.id, l.offerPrice]));
  return lines.map((l) => {
    if (!byId.has(l.id)) return { ...l, offerPrice: l.offerPrice == null ? null : Number(l.offerPrice) };
    const p = parsePrice(byId.get(l.id));
    if (Number.isNaN(p)) throw new WorkflowError('BAD_PRICE', { code: l.poz });
    return { ...l, offerPrice: p };
  });
}

function requirePrices(lines) {
  const rows = missingPrices(lines);
  if (rows.length) throw new WorkflowError('PROFILE_PRICE_MISSING', { rows: rows.join(', ') });
}

async function writePrices(h, offer, lines) {
  for (const l of lines) {
    const before = offer.lines.find((x) => x.id === l.id);
    const was = before?.offerPrice == null ? null : Number(before.offerPrice);
    if (was !== l.offerPrice) await h.tx.offerLine.update({ where: { id: l.id }, data: { offerPrice: l.offerPrice == null ? null : l.offerPrice.toFixed(2) } });
  }
  const offerAmount = profileTotals(lines).amount.toFixed(2);
  await h.tx.offer.update({ where: { id: offer.id }, data: { offerAmount } });
  return offerAmount;
}

async function setPrice(h, amount) {
  await h.tx.price.upsert({
    where: { orderId: h.order.id },
    create: { orderId: h.order.id, amount, setById: h.actor.id },
    update: { amount, setById: h.actor.id, setAt: h.now },
  });
}

/** Romanya deposunun takvim kararları (yöneticinin açık / kapalı günleri), işlem içinde bir kez okunur */
async function depotOverrides(h) {
  h.depotOverrides ??= await calendarOverrides(h.tx, DEPOT_CALENDAR, { now: h.now });
  return h.depotOverrides;
}

/** Yönetici (fiyat ve teslim kararları): teslim gününü depo kuralından bağımsız, açık bir güne alabilir */
const isStaff = (h) => !h.actor.depot && !h.actor.fgo && can(h.actor.role, 'OFFER_SEND');

/**
 * Sipariş depoya iletilirken alış (teslim) günü (karar 194): iletim anının depo kuralından erkense ya da depo o gün kapalıysa
 * ileri kayar; kayma müşteriye bildirilir (PICKUP_MOVED, gün olayın verisinde).
 * @returns {Promise<{ pickupDate: Date, moved: boolean }>}
 */
async function forwardPickup(h) {
  let r;
  try {
    r = pickupOnForward({ now: h.now, pickupDate: h.order.profile.pickupDate ?? null, overrides: await depotOverrides(h) });
  } catch (e) {
    if (e instanceof NoOpenDayError) throw new WorkflowError('NO_OPEN_DAY');
    throw e;
  }
  if (r.moved) {
    // Önceki gün `prevDay` anahtarıyla (outbox yükünde `from` / `to` sipariş durumu için ayrılmıştır)
    const prevDay = h.order.profile.pickupDate ? dayKeyOf(h.order.profile.pickupDate) : null;
    h.event('PICKUP_MOVED', dayText(r.pickupDate), { day: dayKeyOf(r.pickupDate), ...(prevDay ? { prevDay } : {}) });
  }
  return r;
}

/** Alış günü, telefon, plaka — doğrulanmış olarak */
async function pickupInput(h, { requireAll }) {
  const p = h.payload;
  const out = {};
  if (p.pickupDate !== undefined || requireAll) {
    const d = p.pickupDate;
    const problem = pickupProblem(d, { now: h.now, overrides: await depotOverrides(h), staff: isStaff(h) });
    if (problem) throw new WorkflowError(problem);
    out.pickupDate = dayDate(dayKeyOf(d));
  }
  // Depoya gitmeden önce telefon ve plaka boş bırakılabilir (Paket B — karar 229: depo formu gönderilmeden önce
  // tamamlanır; eksikse sipariş depoya gönderilmez). Onayda (requireAll) ve depodaki siparişte zorunlu kalır.
  const optional = !requireAll && BEFORE_WAREHOUSE.includes(h.order.profile.stage);
  if (p.phone !== undefined || requireAll) {
    const phone = optional ? optionalField(p.phone, cleanPhone) : cleanPhone(p.phone);
    if (phone === undefined || (!optional && !phone)) throw new WorkflowError('BAD_PHONE');
    out.contactPhone = phone;
  }
  if (p.plate !== undefined || requireAll) {
    const plate = optional ? optionalField(p.plate, cleanPlate) : cleanPlate(p.plate);
    if (plate === undefined || (!optional && !plate)) throw new WorkflowError('BAD_PLATE');
    out.vehiclePlate = plate;
  }
  return out;
}

/**
 * Depoya sipariş formu gitmeden önceki son denetim (karar 229): alış günü, telefon ve plaka dolu olmalı. Eksikse depo
 * e-postası kuyruğa girmez, stok düşülmez; eksik alanlar hatanın ayrıntısındadır.
 */
function requirePickupInfo(profile) {
  const missing = missingPickup(profile);
  if (missing.length) throw new WorkflowError('PICKUP_INFO_MISSING', { fields: missing });
}

/** FGO açıksa kuyruğa iş ekler (gönderim işçide; işlem içinde dış istek yapılmaz) */
async function queueFgo(h, type) {
  const s = await getFgoSettings(h.tx);
  if (!fgoReady(s)) return false;
  h.outbox.push(outboxEvent(type, { orderId: h.order.id, payload: { orderNo: h.order.orderNo } }));
  return true;
}

/**
 * Siparişin kuyruktaki (bekleyen) FGO işleri. Belge kesme sonucu belirsiz kalan iş ("[BELIRSIZ] …", karar 209) de bekleyen
 * iştir: yönetici FGO'ya bakıp karar verene kadar o belge için yeni iş ya da elle belge girilmez.
 */
async function pendingFgoJobs(h, types) {
  return h.tx.notificationOutbox.findMany({ where: { orderId: h.order.id, status: 'PENDING', type: { in: types } }, select: { type: true, lastError: true } });
}
const parkedJob = (jobs) => jobs.some((j) => typeof j.lastError === 'string' && j.lastError.startsWith('[BELIRSIZ]'));

/** Elle girilen kur (yönetici): boş → null; geçersiz → hata */
function manualRate(v) {
  if (v == null || String(v).trim() === '') return null;
  const r = parseManualRate(v);
  if (r == null) throw new WorkflowError('BAD_FX_RATE');
  return r;
}

/**
 * Elle girilen kurun kaydı (karar 96, 98): müşterinin politikası kayda geçer, kur MANUAL diye işaretlenir.
 * @param {any} h  @param {number} rate
 */
async function manualFx(h, rate) {
  const customer = await h.tx.customer.findUnique({ where: { id: h.order.customerId }, select: { fxPolicy: true } });
  const day = localDay(h.now, getEnv().APP_TIMEZONE);
  return fxSnapshot(manualExchangeRate({ customer, manualRate: rate, day, now: h.now }), dayDate(day));
}

const shortText = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;

/**
 * Sipariş depoya gider: kalemler stoktan düşülür (bir kez), depo e-postası kuyruğa girer (PDF ve gönderim işçide).
 * Stok yetmese de gönderilir; eksikler döner (sonuçta ve denetim kaydında).
 * @returns {Promise<{ productId: string, need: number, have: number }[]>}
 */
async function toWarehouse(h, extra) {
  const p = h.order.profile;
  requirePickupInfo({ ...p, ...extra });
  const items = h.order.profileItems.map((i) => ({ productId: i.productId, qty: i.qty }));
  const levels = await stockLevels(h.tx, items.map((i) => i.productId).filter(Boolean));
  const missing = shortages(items, levels);
  if (!p.stockDeducted) await deductOrderStock(h.tx, { orderId: h.order.id, orderNo: h.order.orderNo, items, actorId: h.actor.id ?? null, actor: h.actor });
  await setStage(h, 'DEPODA', { ...extra, warehouseSentAt: h.now, stockDeducted: true });
  h.event('WAREHOUSE_SENT');
  h.outbox.push(outboxEvent(WAREHOUSE_EMAIL, { orderId: h.order.id, payload: { orderNo: h.order.orderNo } }));
  return missing;
}

const ACTIONS = {
  /** Yönetici fiyatları kaydeder (teklif henüz müşteride değil). */
  async save_profile_prices(h) {
    const offer = latestOffer(h.order);
    if (!offer || offer.status !== 'YONETIMDE') throw new WorkflowError('OFFER_NOT_FOUND');
    const lines = applyPrices(offer.lines, h.payload.lines);
    const offerAmount = await writePrices(h, offer, lines);
    h.audit = { offerId: offer.id, offerAmount, intent: 'save' };
  },
  /** Fiyatlar eksiksizse teklif müşteriye gider (müşteri bundan sonra görür ve onaylayabilir). */
  async send_profile_offer(h) {
    const offer = latestOffer(h.order);
    if (!offer || offer.status !== 'YONETIMDE') throw new WorkflowError('OFFER_NOT_FOUND');
    const lines = applyPrices(offer.lines, h.payload.lines);
    requirePrices(lines);
    const offerAmount = await writePrices(h, offer, lines);
    await h.tx.offer.update({ where: { id: offer.id }, data: { status: 'GONDERILDI', statusSince: h.now, sentAt: h.now } });
    await setPrice(h, offerAmount);
    await setStage(h, 'TEKLIF_GONDERILDI');
    // Olay notunda tutar yok (tutarlar denetim kaydında)
    h.event('PROFILE_OFFER_SENT');
    h.audit = { offerId: offer.id, offerAmount, intent: 'send' };
  },
  /** Müşterideki (henüz onaylanmamış) teklif güncellenir: eski sürüm kalır, yeni sürüm hemen müşteriye gider. */
  async update_profile_offer(h) {
    const prev = latestSent(h.order);
    if (!prev) throw new WorkflowError('OFFER_NOT_FOUND');
    const lines = applyPrices(prev.lines, h.payload.lines);
    requirePrices(lines);
    const offerAmount = profileTotals(lines).amount.toFixed(2);
    const created = await h.tx.offer.create({
      data: {
        orderId: h.order.id, createdById: h.actor.id, currency: prev.currency, amount: 0, offerAmount,
        status: 'GONDERILDI', statusSince: h.now, sentAt: h.now,
        lines: {
          create: lines.map((l, i) => ({
            sortOrder: i, kind: 'PROFIL', description: l.description, descriptionRo: l.descriptionRo, poz: l.poz, adet: l.adet, unit: 'adet',
            unitCode: l.unitCode, profileProductId: l.profileProductId, unitPrice: 0, listPrice: l.listPrice,
            offerPrice: l.offerPrice == null ? null : l.offerPrice.toFixed(2),
          })),
        },
      },
    });
    await setPrice(h, offerAmount);
    h.event('OFFER_UPDATED', shortText(h.payload.note, 500));
    h.audit = { offerId: created.id, from: prev.offerAmount?.toString() ?? null, offerAmount };
  },
  /** Müşteri ekrandaki son teklifi onaylar; alış günü, telefon ve plaka zorunludur. */
  async approve_profile_offer(h) {
    const sent = latestSent(h.order);
    if (!sent) throw new WorkflowError('OFFER_NOT_FOUND');
    // Bu arada yönetici teklifi güncellediyse eski sürüm onaylanamaz
    if (h.payload.offerId && h.payload.offerId !== sent.id) throw new WorkflowError('STALE_OFFER');
    const info = await pickupInput(h, { requireAll: true });
    await setStage(h, 'ONAYLANDI', { ...info, approvedAt: h.now, approvedById: h.actor.id, approvedOfferId: sent.id });
    h.event('PROFILE_APPROVED', dayText(info.pickupDate));
    // FGO açıksa proforma kendiliğinden kesilir (işçi; kur müşterinin kur politikasından o an çözülür)
    const fgo = await queueFgo(h, FGO_PROFORMA);
    h.audit = { offerId: sent.id, pickupDate: dayKeyOf(info.pickupDate), fgo };
  },
  /**
   * Teslim bilgileri: müşteri ve yönetici depo e-postası gidene kadar değiştirebilir; yönetici teslim gününü depoda iken de
   * değiştirebilir (karar 194). Yöneticinin değiştirdiği teslim günü müşteriye bildirilir (DELIVERY_DATE_CHANGED — değişiklik
   * başına bir olay; aynı gün yeniden kaydedilirse olay da bildirim de yok). Müşterinin kendi değişikliği PICKUP_UPDATED.
   */
  async update_pickup(h) {
    const stage = h.order.profile.stage;
    const staff = isStaff(h);
    if (!(PICKUP_EDITABLE.includes(stage) || (staff && stage === 'DEPODA'))) throw new WorkflowError('PICKUP_LOCKED');
    const prev = h.order.profile.pickupDate ? dayKeyOf(h.order.profile.pickupDate) : null;
    // Müşteri alış gününden BİR GÜN ÖNCESİNE kadar değiştirebilir (karar 229; depo günü, sunucu saati)
    if (!staff && !customerPickupOpen({ pickupDay: prev, today: localDay(h.now, DEPOT_TIME_ZONE) })) throw new WorkflowError('PICKUP_DEADLINE');
    const info = await pickupInput(h, { requireAll: false });
    const before = { pickupDate: prev, contactPhone: h.order.profile.contactPhone, vehiclePlate: h.order.profile.vehiclePlate };
    await h.tx.profileOrder.update({ where: { orderId: h.order.id }, data: info });
    const date = info.pickupDate ?? h.order.profile.pickupDate;
    const day = date ? dayKeyOf(date) : null;
    const changed = staff && !!day && day !== prev;
    if (changed) h.event('DELIVERY_DATE_CHANGED', dayText(date), { day, ...(prev ? { prevDay: prev } : {}) });
    else h.event('PICKUP_UPDATED', date ? dayText(date) : null);
    // Ödemesi alınmış ama teslim bilgisi eksik olduğu için depoya gidemeyen sipariş (karar 229): bilgiler şimdi
    // tamamlandıysa ödeme kuralıyla aynı yoldan HEMEN depoya iletilir (bir kez; stok kilitleri PROFILE_LOCKS'ta)
    const merged = { ...h.order.profile, ...info };
    let forwarded = false;
    if (h.order.profile.paidAt && BEFORE_WAREHOUSE.includes(stage) && missingPickup(merged).length === 0) {
      h.order.profile = merged;
      const r = await forwardPickup(h);
      const missing = await toWarehouse(h, { pickupDate: r.pickupDate });
      forwarded = true;
      h.result = { deliveryDateChanged: changed, forwarded, shortages: missing, moved: r.moved, pickupDate: r.pickupDate };
    }
    h.audit = { before, after: { ...before, ...info, pickupDate: day }, ...(changed ? { deliveryDateChanged: true } : {}), ...(forwarded ? { forwarded: true } : {}) };
    if (!forwarded) h.result = { deliveryDateChanged: changed, forwarded: false };
  },
  /**
   * Proforma elle kesildi. FGO açıksa kur zorunludur (fatura aynı kurla kesilir); kuyruktaki otomatik proforma
   * artık kesilmez (işçi adım değiştiği için atlar).
   */
  async mark_proforma(h) {
    // Sonucu belirsiz FGO proforması (karar 209): FGO'da kesilmiş olabilir — önce yönetici FGO'ya bakıp karar verir
    if (parkedJob(await pendingFgoJobs(h, [FGO_PROFORMA]))) throw new WorkflowError('FGO_UNCERTAIN');
    const proformaNo = shortText(h.payload.proformaNo, 60);
    const given = manualRate(h.payload.fxRate);
    const rate = given ?? (h.order.profile.fxRate != null ? Number(h.order.profile.fxRate) : null);
    if (rate == null && fgoReady(await getFgoSettings(h.tx))) throw new WorkflowError('FX_RATE_REQUIRED');
    const fx = given != null ? await manualFx(h, given) : {};
    await setStage(h, 'PROFORMA', { proformaNo, proformaAt: h.now, ...fx });
    h.event('PROFORMA', proformaNo);
    h.audit = { proformaNo, fxRate: rate };
  },
  /** FGO işçisi: proforma kesildi (RON; kur müşterinin kur politikasından ya da yöneticinin elle girdiği) */
  async fgo_proforma(h) {
    const p = h.payload;
    const proformaNo = `${p.series}${p.number}`;
    await setStage(h, 'PROFORMA', {
      proformaNo, proformaAt: h.now, proformaLink: p.link ?? null, proformaAmount: Number(p.amount).toFixed(2),
      // Kur kaydı kurla birlikte bir kez yazılır; siparişte zaten kayıtlı kur (elle) kullanıldıysa dokunulmaz
      ...(p.fx ?? {}),
    });
    // Muhasebe → Profil Tahsilat için belge kaydı (ödeme durumu FGO'dan okunur)
    const doc = await h.tx.fgoDocument.create({ data: { orderId: h.order.id, kind: 'PROFORMA', series: String(p.series), number: String(p.number), issuedAt: h.now, link: p.link ?? null } });
    // Müşteri e-postası (yalnızca TAKİP gönderir — karar 111): belge kaydıyla aynı işlemde, belge başına bir kez
    h.outbox.push(outboxEvent(DOC_EMAIL, { orderId: h.order.id, payload: { docId: doc.id } }));
    h.event('PROFORMA', proformaNo);
    h.audit = { proformaNo, fxRate: p.rate, fxSource: p.source, amountRon: p.amount, fgo: true };
  },
  /**
   * Yönetici: FGO'da yeniden dene (proforma ya da fatura, adıma göre). Kur alınamadıysa burada elle girilir.
   */
  async retry_fgo(h) {
    const stage = h.order.profile.stage;
    const type = stage === 'ONAYLANDI' ? FGO_PROFORMA : stage === 'TESLIM_EDILDI' ? FGO_INVOICE : null;
    if (!type) throw new WorkflowError('NOT_ALLOWED');
    // Aynı belge için kuyrukta iş varsa (beklemede ya da sonucu belirsiz) ikinci iş yazılmaz (karar 209)
    const jobs = await pendingFgoJobs(h, [FGO_PROFORMA, FGO_INVOICE]);
    if (parkedJob(jobs)) throw new WorkflowError('FGO_UNCERTAIN');
    if (jobs.length) throw new WorkflowError('FGO_BUSY');
    const rate = manualRate(h.payload.fxRate);
    if (rate != null) {
      // Fatura, proformanın kuruyla kesilir: proforma FGO'dan kesildiyse kur değiştirilemez
      if (stage === 'TESLIM_EDILDI' && h.order.profile.fxSource && h.order.profile.fxSource !== 'MANUAL') throw new WorkflowError('FX_RATE_LOCKED');
      await h.tx.profileOrder.update({ where: { orderId: h.order.id }, data: await manualFx(h, rate) });
    }
    if (stage === 'TESLIM_EDILDI' && rate == null && h.order.profile.fxRate == null) throw new WorkflowError('FX_RATE_REQUIRED');
    if (!(await queueFgo(h, type))) throw new WorkflowError('FGO_DISABLED');
    h.event('FGO_RETRY', type === FGO_PROFORMA ? 'proforma' : 'factura');
    h.audit = { type, fxRate: rate };
  },
  /**
   * Ödeme teyit edildi. Sipariş henüz depoda değilse hemen depoya gider (stoktan düşülür, depo e-postası kuyruğa girer);
   * müşterinin alış günü iletim anının depo kuralından (12:00, depo takvimi — karar 194) erkense o güne kayar. Depoya elle
   * gönderilmiş siparişte yalnızca ödeme günü kaydedilir.
   */
  async mark_paid(h) {
    const d = h.payload.paidDate;
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new WorkflowError('INVALID_DATE');
    const t = today(h.now);
    const paidAt = dayDate(dayKeyOf(d));
    if (dayKeyOf(paidAt) > dayKeyOf(t)) throw new WorkflowError('PAID_IN_FUTURE');
    if (!BEFORE_WAREHOUSE.includes(h.order.profile.stage)) {
      await h.tx.profileOrder.update({ where: { orderId: h.order.id }, data: { paidAt } });
      h.event('PAID', dayText(paidAt));
      h.audit = { paidAt: dayKeyOf(paidAt), stage: h.order.profile.stage };
      h.result = { sent: false, shortages: [], moved: false };
      return;
    }
    h.event('PAID', dayText(paidAt));
    // Teslim bilgisi eksik (karar 229): ödeme kaydedilir, sipariş depoya GÖNDERİLMEZ (depo e-postası yok, stok düşülmez);
    // bilgiler tamamlanınca (müşteri ya da yönetici) sipariş aynı kuralla depoya iletilir (update_pickup)
    const missingInfo = missingPickup(h.order.profile);
    if (missingInfo.length) {
      await h.tx.profileOrder.update({ where: { orderId: h.order.id }, data: { paidAt } });
      h.audit = { paidAt: dayKeyOf(paidAt), stage: h.order.profile.stage, pickupMissing: missingInfo };
      h.result = { sent: false, shortages: [], moved: false, pickupMissing: missingInfo };
      return;
    }
    // Sipariş ŞİMDİ depoya iletilir: alış günü bu anın depo kuralıyla denetlenir (karar 194)
    const r = await forwardPickup(h);
    const missing = await toWarehouse(h, { paidAt, pickupDate: r.pickupDate });
    h.audit = { paidAt: dayKeyOf(paidAt), pickupDate: dayKeyOf(r.pickupDate), moved: r.moved, shortages: missing };
    h.result = { sent: true, shortages: missing, moved: r.moved, pickupDate: r.pickupDate };
  },
  /** "Siparişi depoya gönder": yönetici ödeme beklemeden gönderir (alış günü bu anın depo kuralıyla denetlenir). */
  async send_to_warehouse(h) {
    if (!h.order.profile.pickupDate) throw new WorkflowError('PICKUP_MISSING');
    requirePickupInfo(h.order.profile);
    const r = await forwardPickup(h);
    const missing = await toWarehouse(h, { pickupDate: r.pickupDate });
    h.audit = { manual: true, shortages: missing, pickupDate: dayKeyOf(r.pickupDate), moved: r.moved };
    h.result = { shortages: missing, moved: r.moved, pickupDate: r.pickupDate };
  },
  /** Depo e-postası yeniden gönderilir (yeni bağlantıyla; eski bağlantı geçersiz olur). */
  async resend_warehouse(h) {
    h.outbox.push(outboxEvent(WAREHOUSE_EMAIL, { orderId: h.order.id, payload: { orderNo: h.order.orderNo, resend: true } }));
    h.event('WAREHOUSE_RESENT');
  },
  /**
   * Müşteri malı teslim aldı: depo bağlantısından (imzalı belgeyle) ya da yönetici elle. Belgeler siparişin iç dosyası olur.
   * payload.files: kaydedilmiş dosyalar (server/files/store.js)
   */
  async mark_delivered(h) {
    const files = h.payload.files ?? [];
    if (h.actor.depot && files.length === 0) throw new WorkflowError('DELIVERY_FILE');
    if (files.length) {
      await h.tx.orderFile.createMany({
        data: files.map((f) => ({
          orderId: h.order.id, kind: 'INTERNAL', source: h.actor.depot ? 'DEPOT_LINK' : null, uploadedById: h.actor.id ?? null,
          name: f.name, storageKey: f.storageKey, size: f.size, mime: f.mime ?? null, checksum: f.checksum ?? null,
          scanStatus: f.scanStatus ?? 'SKIPPED', scanSignature: f.scanSignature ?? null, scannedAt: f.scannedAt ?? null,
        })),
      });
    }
    await setStage(h, 'TESLIM_EDILDI', { deliveredAt: h.now, deliveredVia: h.actor.depot ? 'DEPOT_LINK' : 'ADMIN' });
    h.event('DELIVERED', h.actor.depot ? 'depot' : null);
    // FGO açıksa fatura kendiliğinden kesilir (proformanın kuruyla)
    const fgo = await queueFgo(h, FGO_INVOICE);
    h.audit = { via: h.actor.depot ? 'DEPOT_LINK' : 'ADMIN', files: files.map((f) => ({ name: f.name, checksum: f.checksum ?? null })), fgo };
  },
  async mark_invoiced(h) {
    if (parkedJob(await pendingFgoJobs(h, [FGO_INVOICE, 'FGO_PROFILE_ADVANCE']))) throw new WorkflowError('FGO_UNCERTAIN');
    const invoiceNo = shortText(h.payload.invoiceNo, 60);
    await setStage(h, 'FATURALANDI', { invoiceNo, invoicedAt: h.now });
    h.event('INVOICED', invoiceNo);
    h.audit = { invoiceNo };
  },
  /** FGO işçisi: fatura kesildi (proformanın kuruyla) → arşiv */
  async fgo_invoice(h) {
    const p = h.payload;
    const invoiceNo = `${p.series}${p.number}`;
    await setStage(h, 'FATURALANDI', { invoiceNo, invoicedAt: h.now, invoiceLink: p.link ?? null });
    const doc = await h.tx.fgoDocument.create({ data: { orderId: h.order.id, kind: 'INVOICE', series: String(p.series), number: String(p.number), issuedAt: h.now, link: p.link ?? null } });
    h.outbox.push(outboxEvent(DOC_EMAIL, { orderId: h.order.id, payload: { docId: doc.id } }));
    h.event('INVOICED', invoiceNo);
    h.audit = { invoiceNo, fxRate: p.rate, amountRon: p.amount, fgo: true };
  },
  /**
   * FGO'da silinmiş belge (karar 65): kayıt kaldırılır, sipariş belgeden önceki adıma döner — fatura silindiyse
   * FATURALANDI → TESLIM_EDILDI, proforma silindiyse PROFORMA → ONAYLANDI (kur sıfırlanır). Yeni belge
   * "FGO'da yeniden dene" ile kesilir. Daha ileri adımdaki siparişte yalnızca belge bilgisi silinir, adım değişmez.
   */
  async fgo_doc_deleted(h) {
    const p = h.payload;
    const no = `${p.series}${p.number}`;
    await h.tx.fgoDocument.delete({ where: { id: p.docId } });
    const pr = h.order.profile;
    const open = h.order.status !== 'IPTAL';
    if (p.kind === 'INVOICE' && pr.invoiceNo === no) {
      const clear = { invoiceNo: null, invoicedAt: null, invoiceLink: null };
      if (open && pr.stage === 'FATURALANDI') await setStage(h, 'TESLIM_EDILDI', clear);
      else await h.tx.profileOrder.update({ where: { orderId: h.order.id }, data: clear });
    } else if (p.kind === 'PROFORMA' && pr.proformaNo === no) {
      const clear = { proformaNo: null, proformaAt: null, proformaLink: null, proformaAmount: null };
      if (open && pr.stage === 'PROFORMA') await setStage(h, 'ONAYLANDI', { ...clear, ...FX_SNAPSHOT_CLEAR });
      else await h.tx.profileOrder.update({ where: { orderId: h.order.id }, data: clear });
    }
    h.event('FGO_DOC_DELETED', no);
    h.audit = { kind: p.kind, series: p.series, number: p.number, reason: p.reason ?? null, fgo: true };
  },
  /** Yalnızca yönetici; depoya gitmiş siparişin stok çıkışı geri alınır. Depo bağlantısı geçersiz olur. */
  async cancel(h) {
    if (!h.payload.note) throw new WorkflowError('CANCEL_REASON');
    let returned = 0;
    if (h.order.profile.stockDeducted) {
      returned = await returnOrderStock(h.tx, { orderId: h.order.id, orderNo: h.order.orderNo, actorId: h.actor.id ?? null });
    }
    await h.tx.profileOrder.update({
      where: { orderId: h.order.id },
      data: { depotTokenHash: null, depotTokenExpiresAt: null, stockDeducted: false },
    });
    await h.set({ status: 'IPTAL', slaDeadline: null });
    h.event('CANCELLED', h.payload.note);
    h.audit = { stage: h.order.profile.stage, stockReturned: returned };
  },
};

export const PROFILE_ACTIONS = Object.keys(ACTIONS);

/**
 * Stoğa yazabilen işlemler (depo çıkışı, iptal iadesi) ürünlerin stok kilitlerini sürüm artışından ÖNCE alır — elle sayım,
 * Excel'den stok ve öbür siparişlerin depo çıkışıyla aynı kilitler, aynı sıra (karar 177; server/profile/stock.js). Sayım
 * bu siparişin çıkışını ya tamamen görür ya da çıkış sayımı bekler: sayımın "önce / sonra"sı gerçek stoğa eşit kalır.
 * @param {{ profileItems: { productId: string | null }[] }} order
 */
const stockLocks = (order) => stockLockKeys(order.profileItems.map((i) => i.productId));
// update_pickup (karar 229): ödenmiş ama teslim bilgisi eksik sipariş, bilgi tamamlanınca depoya iletilir (stok çıkışı)
export const PROFILE_LOCKS = { mark_paid: stockLocks, send_to_warehouse: stockLocks, cancel: stockLocks, update_pickup: stockLocks };

/**
 * Profil siparişi işlemi.
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ orderId: string, action: string, actor: { id: string | null, role: string, canApprove?: boolean, customerId?: string | null, ip?: string | null, system?: boolean, depot?: boolean }, payload?: object }} p
 */
export function runProfileAction(db, { orderId, action, actor, payload = {} }) {
  return executeAction(db, { workflow: profileWorkflow, actions: ACTIONS, include: INCLUDE, locks: PROFILE_LOCKS, orderId, action, actor, payload });
}

/** Depo bağlantısından işlemi yapan (kişi değil) */
/** @param {string | null} [ip] */
export const depotActor = (ip = null) => ({ id: null, role: 'DEPOT', system: true, depot: true, ip });

/** FGO işçisi (kişi değil) */
export const fgoActor = () => ({ id: null, role: 'SYSTEM', system: true, fgo: true, ip: null });
