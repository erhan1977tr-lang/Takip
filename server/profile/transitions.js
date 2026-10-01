// Profil siparişi iş akışı işlemleri (Aşama 6). Cam siparişiyle aynı çalıştırıcıdan geçer (server/orders/transitions.js →
// executeAction): yetki/adım kontrolü, tek veritabanı işleminde değişiklik + geçmiş + denetim + bildirim kuyruğu, iyimser kilit.
import { WorkflowError } from '../domain/workflow.js';
import { outboxEvent } from '../domain/outbox.js';
import { getEnv } from '../env.js';
import { executeAction } from '../orders/transitions.js';
import { dayDate, dayKeyOf, localDay, pickupAfterPayment, pickupProblem } from './dates.js';
import { BEFORE_WAREHOUSE, PICKUP_EDITABLE, PROFILE_TYPE, cleanPhone, cleanPlate, missingPrices, orderStatusFor, parsePrice, profileActions, profileTotals } from './rules.js';
import { deductOrderStock, returnOrderStock, shortages, stockLevels } from './stock.js';
import { fgoReady, getFgoSettings } from '../integrations/fgo.js';
import { parseManualRate } from '../fx/bt.js';

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

/** Alış günü, telefon, plaka — doğrulanmış olarak */
function pickupInput(h, { requireAll }) {
  const p = h.payload;
  const out = {};
  if (p.pickupDate !== undefined || requireAll) {
    const d = p.pickupDate;
    const paidAt = h.order.profile.paidAt ?? null;
    const problem = pickupProblem(d, { today: today(h.now), paidAt });
    if (problem) throw new WorkflowError(problem);
    out.pickupDate = dayDate(dayKeyOf(d));
  }
  if (p.phone !== undefined || requireAll) {
    const phone = cleanPhone(p.phone);
    if (!phone) throw new WorkflowError('BAD_PHONE');
    out.contactPhone = phone;
  }
  if (p.plate !== undefined || requireAll) {
    const plate = cleanPlate(p.plate);
    if (!plate) throw new WorkflowError('BAD_PLATE');
    out.vehiclePlate = plate;
  }
  return out;
}

/** FGO açıksa kuyruğa iş ekler (gönderim işçide; işlem içinde dış istek yapılmaz) */
async function queueFgo(h, type) {
  const s = await getFgoSettings(h.tx);
  if (!fgoReady(s)) return false;
  h.outbox.push(outboxEvent(type, { orderId: h.order.id, payload: { orderNo: h.order.orderNo } }));
  return true;
}

/** Elle girilen kur (yönetici): boş → null; geçersiz → hata */
function manualRate(v) {
  if (v == null || String(v).trim() === '') return null;
  const r = parseManualRate(v);
  if (r == null) throw new WorkflowError('BAD_FX_RATE');
  return r;
}

const shortText = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;

/**
 * Sipariş depoya gider: kalemler stoktan düşülür (bir kez), depo e-postası kuyruğa girer (PDF ve gönderim işçide).
 * Stok yetmese de gönderilir; eksikler döner (sonuçta ve denetim kaydında).
 * @returns {Promise<{ productId: string, need: number, have: number }[]>}
 */
async function toWarehouse(h, extra) {
  const p = h.order.profile;
  const items = h.order.profileItems.map((i) => ({ productId: i.productId, qty: i.qty }));
  const levels = await stockLevels(h.tx, items.map((i) => i.productId).filter(Boolean));
  const missing = shortages(items, levels);
  if (!p.stockDeducted) await deductOrderStock(h.tx, { orderId: h.order.id, orderNo: h.order.orderNo, items, actorId: h.actor.id ?? null });
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
    const info = pickupInput(h, { requireAll: true });
    await setStage(h, 'ONAYLANDI', { ...info, approvedAt: h.now, approvedById: h.actor.id, approvedOfferId: sent.id });
    h.event('PROFILE_APPROVED', dayText(info.pickupDate));
    // FGO açıksa proforma kendiliğinden kesilir (işçi; BT kuru o an alınır)
    const fgo = await queueFgo(h, FGO_PROFORMA);
    h.audit = { offerId: sent.id, pickupDate: dayKeyOf(info.pickupDate), fgo };
  },
  /** Teslim bilgileri depo e-postası gidene kadar değiştirilebilir. */
  async update_pickup(h) {
    if (!PICKUP_EDITABLE.includes(h.order.profile.stage)) throw new WorkflowError('PICKUP_LOCKED');
    const info = pickupInput(h, { requireAll: false });
    const before = { pickupDate: h.order.profile.pickupDate ? dayKeyOf(h.order.profile.pickupDate) : null, contactPhone: h.order.profile.contactPhone, vehiclePlate: h.order.profile.vehiclePlate };
    await h.tx.profileOrder.update({ where: { orderId: h.order.id }, data: info });
    const date = info.pickupDate ?? h.order.profile.pickupDate;
    h.event('PICKUP_UPDATED', date ? dayText(date) : null);
    h.audit = { before, after: { ...before, ...info, pickupDate: date ? dayKeyOf(date) : null } };
  },
  /**
   * Proforma elle kesildi. FGO açıksa kur zorunludur (fatura aynı kurla kesilir); kuyruktaki otomatik proforma
   * artık kesilmez (işçi adım değiştiği için atlar).
   */
  async mark_proforma(h) {
    const proformaNo = shortText(h.payload.proformaNo, 60);
    const given = manualRate(h.payload.fxRate);
    const rate = given ?? (h.order.profile.fxRate != null ? Number(h.order.profile.fxRate) : null);
    if (rate == null && fgoReady(await getFgoSettings(h.tx))) throw new WorkflowError('FX_RATE_REQUIRED');
    const fx = given != null ? { fxRate: given.toFixed(4), fxDate: today(h.now), fxSource: 'MANUAL' } : {};
    await setStage(h, 'PROFORMA', { proformaNo, proformaAt: h.now, ...fx });
    h.event('PROFORMA', proformaNo);
    h.audit = { proformaNo, fxRate: rate };
  },
  /** FGO işçisi: proforma kesildi (RON, BT kuruyla) */
  async fgo_proforma(h) {
    const p = h.payload;
    const proformaNo = `${p.series}${p.number}`;
    await setStage(h, 'PROFORMA', {
      proformaNo, proformaAt: h.now, proformaLink: p.link ?? null, proformaAmount: Number(p.amount).toFixed(2),
      fxRate: Number(p.rate).toFixed(4), fxDate: p.rateDate, fxSource: p.source,
    });
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
    const rate = manualRate(h.payload.fxRate);
    if (rate != null) {
      // Fatura, proformanın kuruyla kesilir: proforma FGO'dan kesildiyse kur değiştirilemez
      if (stage === 'TESLIM_EDILDI' && h.order.profile.fxSource && h.order.profile.fxSource !== 'MANUAL') throw new WorkflowError('FX_RATE_LOCKED');
      await h.tx.profileOrder.update({ where: { orderId: h.order.id }, data: { fxRate: rate.toFixed(4), fxDate: today(h.now), fxSource: 'MANUAL' } });
    }
    if (stage === 'TESLIM_EDILDI' && rate == null && h.order.profile.fxRate == null) throw new WorkflowError('FX_RATE_REQUIRED');
    if (!(await queueFgo(h, type))) throw new WorkflowError('FGO_DISABLED');
    h.event('FGO_RETRY', type === FGO_PROFORMA ? 'proforma' : 'factura');
    h.audit = { type, fxRate: rate };
  },
  /**
   * Ödeme teyit edildi. Sipariş henüz depoda değilse hemen depoya gider (stoktan düşülür, depo e-postası kuyruğa girer);
   * müşterinin alış günü ödemeden sonraki ilk iş gününden önceyse o güne kayar. Depoya elle gönderilmiş siparişte
   * yalnızca ödeme günü kaydedilir.
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
    const r = pickupAfterPayment({ paidAt, pickupDate: h.order.profile.pickupDate, today: t });
    h.event('PAID', dayText(paidAt));
    if (r.moved) h.event('PICKUP_MOVED', dayText(r.pickupDate));
    const missing = await toWarehouse(h, { paidAt, pickupDate: r.pickupDate });
    h.audit = { paidAt: dayKeyOf(paidAt), pickupDate: dayKeyOf(r.pickupDate), moved: r.moved, shortages: missing };
    h.result = { sent: true, shortages: missing, moved: r.moved, pickupDate: r.pickupDate };
  },
  /** "Siparişi depoya gönder": yönetici ödeme beklemeden gönderir. */
  async send_to_warehouse(h) {
    if (!h.order.profile.pickupDate) throw new WorkflowError('PICKUP_MISSING');
    const missing = await toWarehouse(h, {});
    h.audit = { manual: true, shortages: missing };
    h.result = { shortages: missing };
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
    h.event('INVOICED', invoiceNo);
    h.audit = { invoiceNo, fxRate: p.rate, amountRon: p.amount, fgo: true };
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
 * Profil siparişi işlemi.
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ orderId: string, action: string, actor: { id: string | null, role: string, canApprove?: boolean, customerId?: string | null, ip?: string | null, system?: boolean, depot?: boolean }, payload?: object }} p
 */
export function runProfileAction(db, { orderId, action, actor, payload = {} }) {
  return executeAction(db, { workflow: profileWorkflow, actions: ACTIONS, include: INCLUDE, orderId, action, actor, payload });
}

/** Depo bağlantısından işlemi yapan (kişi değil) */
/** @param {string | null} [ip] */
export const depotActor = (ip = null) => ({ id: null, role: 'DEPOT', system: true, depot: true, ip });

/** FGO işçisi (kişi değil) */
export const fgoActor = () => ({ id: null, role: 'SYSTEM', system: true, fgo: true, ip: null });
