// Cam siparişi iş akışı işlemleri — hepsi transitionOrder'dan geçer (ADR 0002):
// tek yerde yetki/durum kontrolü, aynı veritabanı işleminde değişiklik + geçmiş + denetim + bildirim kuyruğu,
// iyimser kilit (Order.version) ile aynı anda yapılan işlemlerin ikincisinin reddi.
//
// Form okuma ve dil metinleri uygulama katmanında (app/.../actions.ts); burada yalnızca kurallar ve kayıt.
import { transitionOrder } from '../domain/transition.js';
import { WorkflowError } from '../domain/workflow.js';
import { outboxEvent } from '../domain/outbox.js';
import { can } from '../auth/permissions.js';
import { cleanAnnotations } from './annotations.js';
import { revisionNoteWithMarks } from './revision-note.js';
import { assignPieceBases, atOfferPrice, availableActions, drawingFlags, isCrateText, isViewable, offerProblems, offerTotals, sharedOpsGlasses, shouldAutoProduce, slaDeadline } from './rules.js';
import { priceLock } from './financial-lock.js';
import { priceChanges } from './price-changes.js';
import { verifyReviewToken } from './review.js';
import { DWG_DECISION_STATUS, DWG_RESUBMITTED, DWG_SOURCE, dwgNote, dwgReview, hasCustomerDrawingFile, isCustomerDrawingRecord, sourceFilesSnapshot } from './dwg-review.js';
import { getEnv } from '../env.js';
import { orderScope } from './scope.js';
import { enqueueOutbox, writeAudit, writeHistory } from './journal.js';
import { enrichLines, loadPricing, prefillLines, prefillOfferPrices, pricingForCustomer, pricingForUser } from '../pricing/tables.js';
import { recordPriceOverrides } from '../pricing/alerts.js';
import { moveOrderCrates } from '../loading/crates.js';
import { dayKey } from './loading.js';
import { shipDateLocked } from './ship-date.js';

export { WorkflowError };

const INCLUDE = {
  items: true,
  drawings: { orderBy: { version: 'asc' }, include: { files: true } },
  offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
  // Müşterinin sipariş dosyaları: DWG/DXF çizimi için çizimci kararı (karar 167 — drawingFlags → dwgPending)
  files: { where: { kind: 'CUSTOMER' }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, kind: true, checksum: true, scanStatus: true, uploadedById: true } },
};

const latestOffer = (o) => o.offers[0] ?? null;

/** İşlem → izin veren iş akışı eylemleri (server/orders/rules.js → availableActions) */
export const REQUIRES = {
  send_to_drawing: ['send_to_drawing'],
  no_drawing: ['no_drawing'],
  undo_drawing: ['undo_drawing'],
  undo_no_drawing: ['undo_no_drawing'],
  hold: ['hold'],
  unhold: ['unhold'],
  set_ship_date: ['set_ship_date'],
  mark_shipped: ['mark_shipped'],
  archive: ['archive'],
  cancel: ['cancel'],
  start_drawing: ['start_drawing'],
  upload_drawing: ['upload_drawing'],
  send_drawing: ['send_drawing'],
  remove_drawing_file: ['remove_drawing_file'],
  withdraw_drawing: ['withdraw_drawing'],
  approve_drawing: ['approve_drawing'],
  request_revision: ['request_revision'],
  // Müşterinin DWG/DXF çizimi (karar 167): çizimcinin üç ayrı kararı ve müşterinin "hatalı" kararına iki yanıtı
  dwg_ready: ['dwg_ready'],
  dwg_faulty: ['dwg_faulty'],
  dwg_update: ['dwg_update'],
  dwg_resubmit: ['dwg_resubmit'],
  dwg_request_drawing: ['dwg_request_drawing'],
  save_offer: ['edit_offer', 'approve_price'],
  submit_offer: ['submit_offer'],
  approve_offer: ['approve_price'],
  return_offer: ['return_offer'],
  withdraw_offer: ['withdraw_offer'],
  update_offer: ['update_offer'],
  check_offer: ['update_offer'],
};

/** Cam siparişi akışı: bir işlemin geçerli olup olmadığı tüm hatların (çizim, teklif, bekleme) durumuna bakar. */
export const glassWorkflow = {
  orderType: 'GLASS_ORDER',
  check({ orderType, action, actor, ctx }) {
    if (orderType !== 'GLASS_ORDER') return { ok: false, code: 'WRONG_ORDER_TYPE' };
    // Otomatik arşiv ve 3.51.0 onarımı (karar 158): yalnızca işçi (server/orders/auto-archive.js). Hiçbir rolün eylemi
    // değildir — availableActions'ta yoktur, kullanıcıdan gelen istekle çalışmaz. Kanıt / onarım koşulu işlemin kendisinde,
    // aynı veritabanı işleminde yeniden denetlenir.
    if (action === 'auto_archive' || action === 'auto_ship_revert') {
      const o = ctx.order;
      const states = action === 'auto_archive' ? ['YUKLENDI', 'URETIMDE'] : ['YUKLENDI'];
      const ok = actor.system === true && actor.autoArchive === true && states.includes(o.status) && !o.removedAt && (action === 'auto_ship_revert' || !o.onHold);
      return ok ? { ok: true, to: null } : { ok: false, code: 'NOT_ALLOWED' };
    }
    const need = REQUIRES[action];
    if (!need) return { ok: false, code: 'UNKNOWN_ACTION' };
    const o = ctx.order;
    const acts = availableActions({
      role: actor.role, status: o.status, onHold: o.onHold, canApprove: !!actor.canApprove,
      drawing: o.drawingTrack, offer: latestOffer(o)?.status ?? null, ...drawingFlags(o), orderType,
    });
    return need.some((a) => acts.includes(a)) ? { ok: true, to: null } : { ok: false, code: 'NOT_ALLOWED' };
  },
};

// ---------- ortak yardımcılar ----------

/** Siparişin SLA son tarihini güncel çizim ve teklif durumuna göre yeniden hesaplar. */
export async function refreshSla(tx, orderId) {
  const o = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { offers: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  const offer = o.offers[0];
  const deadline = slaDeadline({
    status: o.status, onHold: o.onHold, createdAt: o.createdAt,
    drawing: o.drawingTrack, drawingSince: o.drawingSince,
    offer: offer?.status ?? null, offerSince: offer?.statusSince ?? null,
  });
  await tx.order.update({ where: { id: orderId }, data: { slaDeadline: deadline } });
}

/**
 * Çizim onaylı (ya da gereksiz) ve teklif müşterideyse siparişi otomatik olarak üretime alır.
 * Beklemedeki sipariş geçmez. Üretime geçtiyse geçmiş kaydını döndürür.
 */
export async function autoProduction(tx, orderId) {
  const o = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { offers: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!shouldAutoProduce({ status: o.status, onHold: o.onHold, drawing: o.drawingTrack, offer: o.offers[0]?.status ?? null })) return null;
  await tx.order.update({ where: { id: orderId }, data: { status: 'URETIMDE', slaDeadline: null } });
  // Not bir koddur; ekranda events.PRODUCTION.<kod> olarak çevrilir
  return { event: 'PRODUCTION', from: o.status, to: 'URETIMDE', note: o.drawingTrack === 'YOK' ? 'no_drawing' : 'drawing_approved' };
}

/** Teklif yoksa siparişin cam kalemlerinden bir taslak açar. */
/**
 * Satışçının ilk teklif taslağı: siparişin camları, satışçının fiyat tablosundaki liste fiyatlarıyla (karar 26).
 * Tablo yoksa fiyatlar boş gelir, satışçı elle girer.
 */
async function ensureOfferDraft(tx, order, userId) {
  if (order.offers.length) return;
  const pricing = await pricingForUser(tx, userId);
  const src = order.items.length ? order.items : [{ glassName: '', camAdedi: 1 }];
  await tx.offer.create({
    data: {
      orderId: order.id, createdById: userId,
      ...(pricing ? { priceTableId: pricing.id, currency: pricing.currency } : {}),
      lines: { create: prefillLines(src, pricing) },
    },
  });
}

/**
 * Kaydedilecek satırları katalog ve fiyat tablosuyla tamamlar (cam, iki dildeki ad, ağırlık, liste fiyatı).
 * Teklifin tablosu yoksa (eski teklif) ve kaydeden satışçıysa onun tablosu bağlanır (para birimi aynıysa).
 */
async function completeLines(h, offer, lines) {
  const { tx, order, actor } = h;
  let pricing = await loadPricing(tx, offer.priceTableId);
  if (!pricing && can(actor.role, 'OFFER_PREPARE') && !can(actor.role, 'OFFER_SEND')) {
    const own = await pricingForUser(tx, actor.id);
    if (own && own.currency === offer.currency) {
      pricing = own;
      await tx.offer.update({ where: { id: offer.id }, data: { priceTableId: own.id } });
    }
  }
  const glasses = await tx.glassProduct.findMany();
  return enrichLines(lines, { glasses, items: order.items, previous: offer.lines ?? [], pricing });
}

/** Yükleme günü değiştiyse siparişin sandıkları da yeni güne taşınır (server/loading/crates.js). */
async function followCrates(h, newDate) {
  const old = h.order.actualShipDate ?? h.order.estimatedShipDate;
  if (!old || !newDate) return;
  const r = await moveOrderCrates(h.tx, {
    orderId: h.order.id, customerId: h.order.customerId, fromDay: dayKey(old), toDay: dayKey(newDate), actor: h.actor,
  });
  if (r.moved.length || r.unlinked.length) h.audit = { ...(h.audit ?? {}), crates: r };
}
const dayText = (d) => d.toISOString().slice(0, 10).split('-').reverse().join('.');

function latestDrawing(h) {
  const latest = h.order.drawings[h.order.drawings.length - 1] ?? null;
  // Kullanıcı ekrandaki sürüme göre karar verir; bu arada yeni sürüm yüklendiyse işlem reddedilir
  if (h.payload.drawingId && latest && latest.id !== h.payload.drawingId) throw new WorkflowError('STALE_DRAWING');
  return latest;
}

/**
 * Müşterinin kararı (onay / revizyon) yalnızca müşteriye gönderilmiş ve henüz karara bağlanmamış FABRİKA sürümüne verilir
 * (Paket 3): karara bağlanmış, geri çekilmiş ya da taslak sürüm ve müşterinin DWG/DXF karar kaydı yeni kararı taşımaz —
 * önceki bir sürümün onayı / kararı yeni sürümün kararı gibi kullanılmaz. Eski kayıtlardaki gönderilmiş BEKLIYOR / YAPILIYOR
 * sürümleri karar alabilir (eski davranış).
 */
const CLOSED_VERSION = Object.freeze(['TASLAK', 'ONAYLANDI', 'REVIZYON_ISTENDI', 'GERI_CEKILDI']);
function decidableDrawing(h) {
  const latest = latestDrawing(h);
  if (latest && (isCustomerDrawingRecord(latest) || CLOSED_VERSION.includes(latest.status))) throw new WorkflowError('STALE_DRAWING');
  return latest;
}

// ---------- işlemler ----------
// Her işlem h üzerinden çalışır: h.set(veri) siparişi günceller, h.event(kod, not, veri) geçmişe yazar (veri: olayın bildirim
// kuyruğundaki ek alanları — ör. drawingId; geçmişe yazılmaz), h.sla = true ise sonda SLA yeniden hesaplanır, h.auto = true ise
// otomatik üretim denenir.

// compensationId: TELAFİ satırının işareti (Aşama 9) — satır düzenlenince / teklifin yeni sürümü açılınca satırla taşınır
// splitGroup / pieceBase: ayrılmış cam grubu (karar 114) — teklifin yeni sürümüne ve kopyalarına satırla birlikte taşınır
// crateFee: yöneticinin sandık bedeli satırı (Paket 4) — yeni sürüme ve kopyalara satırla birlikte taşınır
const LINE_FIELDS = ['description', 'descriptionRo', 'poz', 'enMm', 'boyMm', 'adet', 'unit', 'unitPrice', 'kind', 'free', 'glassProductId', 'weightKgM2', 'listPrice', 'offerPrice', 'compensationId', 'splitGroup'];
export const lineData = (l, i) => ({ ...Object.fromEntries(LINE_FIELDS.map((k) => [k, l[k] ?? null])), adet: l.adet ?? 1, unit: l.unit ?? 'm2', kind: l.kind ?? 'CAM', free: !!l.free, crateFee: !!l.crateFee, unitPrice: l.unitPrice ?? 0, pieceBase: l.pieceBase ?? 0, sortOrder: i });
const priceNum = (v) => (v == null || v === '' ? null : Number(v));

/**
 * Satırların iki fiyatı (karar 4): unitPrice = satış fiyatı (satış girer), offerPrice = müşteri fiyatı (yönetici girer).
 * Satırlar (ölçü, adet, satır ekleme/silme) ortaktır: yönetici değiştirince satışın gördüğü teklif de değişir.
 *  - satış kaydederken müşteri fiyatına dokunulmaz (formunda yoktur);
 *  - yönetici kaydederken mevcut satırların satış fiyatına dokunulmaz. Yöneticinin EKLEDİĞİ satır, eklendiği andaki
 *    fabrika fiyatını alır (karar 89): teklifin fiyat tablosundaki liste fiyatı (completeLines → listPrice; satışçının
 *    satırlarının dolduğu kaynakla aynı). Satış fiyatı muhasebede camın maliyetidir; eklenen satırın maliyeti sessizce
 *    0 kalmamalı. Tabloda fiyatı olmayan satır (ör. sandık parası, serbest metin) 0 kalır ve Muhasebe'de
 *    "maliyeti eksik" olarak gösterilir. Tarayıcıdan gelen satış fiyatı yönetici için hiç kullanılmaz.
 * @param {object[]} lines  completeLines() sonucu; satırın `id`'si varsa mevcut satırdır
 * @param {object[]} existing  mevcut satırlar (id → satır)
 */
function mergePrices(lines, existing, admin) {
  const byId = new Map(existing.map((l) => [l.id, l]));
  const sameGlass = (a, b) => (a.kind ?? 'CAM') === 'CAM' && (b.kind ?? 'CAM') === 'CAM' && String(a.description) === String(b.description)
    && (a.unit ?? 'm2') === (b.unit ?? 'm2') && Number(a.enMm ?? 0) === Number(b.enMm ?? 0) && Number(a.boyMm ?? 0) === Number(b.boyMm ?? 0);
  return lines.map((l) => {
    const own = l.id ? byId.get(l.id) : undefined;
    // Ayrılan cam (karar 113): adedi 1'den büyük bir satırdan, işlem eklemek için ayrılmış TEK cam. Yeni bir satırdır
    // ama aynı camdır: kaynağının kayıtlı fiyatlarını (maliyet ve müşteri fiyatı) ve TELAFİ işaretini taşır — ayırma
    // fiyat değişikliği değildir. Kaynak, bu teklifin aynı camı (açıklama, ölçü, birim) olan bir satırı olmalıdır.
    const from = !own && l.from ? byId.get(l.from) : undefined;
    const old = own ?? (from && sameGlass(from, l) ? from : undefined);
    // Bedelsiz TELAFİ satırı (karar 108): müşteriye bedelsizdir ama fabrika maliyeti durur — satış formu bedelsiz satırın
    // fiyatını 0 gönderir; kayıtlı maliyet korunur (bedelsiz telafi kârlılıkta maliyetiyle görünmeli).
    const keepCost = !admin && old?.compensationId && l.free;
    return {
      ...l,
      unitPrice: admin ? (old ? old.unitPrice : (l.listPrice ?? 0)) : keepCost ? old.unitPrice : l.unitPrice,
      offerPrice: admin && l.offerPrice !== undefined ? priceNum(l.offerPrice) : old ? priceNum(old.offerPrice) : null,
      compensationId: old?.compensationId ?? null,
    };
  });
}

/**
 * İşlem sahipliği (karar 113) — her teklif kaydında (taslak dahil) sunucuda denetlenir: CNC / delik satırı adedi 1'den
 * büyük bir cam satırına bağlanamaz. Ekran, işlem eklenirken camı kendiliğinden tek adetlik satıra ayırır; bu denetim
 * taklit / eski istekler içindir.
 */
function requireOwnedOps(lines) {
  if (sharedOpsGlasses(lines ?? []).length) throw new WorkflowError('OPS_MULTI_GLASS');
}

/** Satırları mevcut teklife yazar: eşleşen satır güncellenir, yeni satır eklenir, gelmeyen satır silinir. */
async function writeLines(tx, offerId, lines, existing) {
  const keep = new Set();
  const ids = new Set(existing.map((l) => l.id));
  for (const [i, l] of lines.entries()) {
    if (l.id && ids.has(l.id)) {
      keep.add(l.id);
      await tx.offerLine.update({ where: { id: l.id }, data: lineData(l, i) });
    } else {
      await tx.offerLine.create({ data: { ...lineData(l, i), offerId } });
    }
  }
  const gone = existing.filter((l) => !keep.has(l.id)).map((l) => l.id);
  if (gone.length) await tx.offerLine.deleteMany({ where: { id: { in: gone } } });
  return tx.offerLine.findMany({ where: { offerId }, orderBy: { sortOrder: 'asc' } });
}

/** Satış tutarı ve müşteri tutarı (sunucuda hesaplanır; tarayıcıdan gelen tutara güvenilmez). */
export function amounts(lines) {
  const plain = lines.map((l) => ({ ...l, unitPrice: String(l.unitPrice ?? 0) }));
  return { amount: offerTotals(plain).amount.toFixed(2), offerAmount: offerTotals(atOfferPrice(lines)).amount.toFixed(2) };
}

/** Müşteriye gidecek teklifte müşteri fiyatı eksik satır olmamalı. */
function requireOfferPrices(lines) {
  const p = offerProblems(atOfferPrice(lines));
  if (p.length) throw new WorkflowError('OFFER_PRICE_MISSING', { problems: p });
}

/**
 * Satış teklifi yöneticiye gönderirken (submit) her fiyatlandırılabilir satırın (cam/ürün, CNC, delik ve diğer
 * satırlar) satış fiyatı olmalı: boş ya da 0 kabul edilmez; yalnızca "bedelsiz" işaretli satır fiyatsız olabilir
 * (mevcut kural, offerProblems → missing_prices). Taslak kaydı (save) engellenmez.
 */
function requireSalesPrices(lines) {
  // Yöneticinin sandık bedeli satırı (Paket 4) satışın tablosunda yoktur: satış fiyatı aranmaz
  const p = offerProblems(lines.filter((l) => !l.crateFee).map((l) => ({ ...l, unitPrice: l.unitPrice == null ? '' : String(l.unitPrice) })))
    .filter((x) => x.code === 'missing_prices');
  if (p.length) throw new WorkflowError('SALES_PRICE_MISSING', { problems: p });
}

/**
 * Sandık ücreti satırının iki sahibi vardır (karar 211); sahiplik satırda saklıdır (OfferLine.crateFee) ve bir kez yazılır:
 *   - yöneticinin sandık bedeli (crateFee = true): satışa HİÇ gitmez (lib/orders.ts → offerPrices);
 *   - satışın sandık ücreti (crateFee = false, sandık parası adlı adetli satır — rules.js → isSalesCrate): satış ekler,
 *     görür ve değiştirir; yönetici de görür ve müşteri fiyatını girer. Cam prosesleri gibi bir cam satırının altında durur;
 *     tutarı faturada o camın tutarına eklenir (server/glass/billing.js — mevcut kural, bir kez sayılır).
 * Satışın (müşteri fiyatını göremeyen teklif yazarının) kaydında:
 *   - gelen satırlarda yöneticinin sandık bedeli işareti yok sayılır; yöneticinin sandık satırının kimliğiyle gelinemez (o
 *     satırı görmez; taklit istek CRATE_FEE_ADMIN);
 *   - sandık parası adlı cam türü satır satışın sandık ücretidir: adetle fiyatlanır, ölçüsü yoktur (sunucu böyle yazar);
 *   - yöneticinin sandık satırları satışa hiç gönderilmediği için formunda yoktur: kayıtta olduğu gibi KORUNUR (satırların
 *     sonunda, saklı değerleriyle) — satışın kaydı yöneticinin satırını silmez / değiştirmez.
 * @param {object[]} lines  formdan gelen satırlar
 * @param {object[]} existing  teklifin kayıtlı satırları
 * @returns {{ lines: object[], kept: object[] }}  kept: korunan yönetici sandık satırları (kayıtlı hâlleriyle)
 */
function salesInput(lines, existing) {
  const crateIds = new Set(existing.filter((l) => l.crateFee).map((l) => l.id));
  const out = (lines ?? []).map((l) => {
    if (l.id && crateIds.has(l.id)) throw new WorkflowError('CRATE_FEE_ADMIN');
    const crate = (l.kind ?? 'CAM') === 'CAM' && isCrateText(l.description);
    return { ...l, crateFee: false, ...(crate ? { unit: 'adet', enMm: null, boyMm: null, splitGroup: null } : {}) };
  });
  return { lines: out, kept: existing.filter((l) => l.crateFee) };
}
/**
 * Yöneticinin satırları: sandık bedeli işareti yalnızca cam türü (adetli sandık) satırında geçerlidir. Satırın sahibi
 * değişmez (karar 211): kayıtlı satır kimliğiyle geldiğinde saklı işaretini korur — yöneticinin sandık bedeli satışa
 * açılmaz, satışın sandık ücreti de yöneticinin kaydıyla satıştan gizlenmez. Yöneticinin EKLEDİĞİ sandık satırı (işaretli
 * ya da sandık parası adlı) her zaman yöneticinin sandık bedelidir: satış görmez.
 * @param {object[]} lines  @param {object[]} [existing]  teklifin kayıtlı satırları
 */
const adminInput = (lines, existing = []) => {
  const byId = new Map(existing.map((l) => [l.id, l]));
  return (lines ?? []).map((l) => {
    const own = l.id ? byId.get(l.id) : undefined;
    const cam = (l.kind ?? 'CAM') === 'CAM';
    const crateFee = cam && (own ? !!own.crateFee : !!l.crateFee || isCrateText(l.description));
    // Yeni sandık bedeli satırı adetle fiyatlanır, ölçüsü yoktur (ekranın gönderdiğiyle aynı; taklit / elle yazılmış satır için)
    return { ...l, crateFee, ...(crateFee && !own ? { unit: 'adet', enMm: null, boyMm: null, splitGroup: null } : {}) };
  });
};

/**
 * Yöneticinin müşteri fiyatı değişikliği (Paket 4): satır satır eski → yeni fiyat, sipariş, teklif sürümü, kullanıcı ve
 * zaman denetim kaydına (OFFER_PRICE_CHANGED) yazılır. Değişiklik yoksa kayıt yazılmaz. Tutar geçmiş notuna yazılmaz.
 * @param {any} h  @param {{ offerId: string, intent: string, sent: boolean, currency: string, before: object[], after: object[] }} p
 */
async function recordPriceChange(h, { offerId, intent, sent, currency, before, after }) {
  const { changes, more } = priceChanges(before, after);
  if (changes.length === 0) return null;
  const { tx, order, actor } = h;
  const version = await tx.offer.count({ where: { orderId: order.id } });
  const total = (lines) => offerTotals(atOfferPrice(lines.map((l) => ({ ...l, unitPrice: String(l.unitPrice ?? 0), offerPrice: l.offerPrice == null ? null : String(l.offerPrice) })))).amount.toFixed(2);
  await writeAudit(tx, {
    action: 'OFFER_PRICE_CHANGED', entityType: 'Order', entityId: order.id, userId: actor.id,
    details: { orderNo: order.orderNo, offerId, version, intent, sent, currency, changes, more, oldTotal: total(before), newTotal: total(after) },
  }, actor);
  return { version, count: changes.length + more };
}

/**
 * Telafi (karar 157): "farklı fiyat" kararında camın müşteri fiyatını yönetici OLAĞAN fiyat akışında belirler (fiyat onayı /
 * teklifi güncelle). Belirlenen fiyat telafi kaydına yazılır (yalnızca fiyatı boş bekleyen kayda) ve denetim kaydına girer —
 * uygulanan fiyat da kaynak sipariş, cam ve adetle birlikte izlenebilir olur. Ayrı bir fiyat sistemi değildir.
 * @returns {Promise<{ compensationId: string, offerPrice: number, free: boolean }[]>}
 */
async function recordCompensationPrices(tx, lines) {
  const out = [];
  for (const l of lines) {
    if (!l.compensationId || (l.kind ?? 'CAM') !== 'CAM' || (l.offerPrice == null && !l.free)) continue;
    const price = l.free ? 0 : Number(l.offerPrice);
    const r = await tx.compensation.updateMany({ where: { id: l.compensationId, offerPrice: null }, data: { offerPrice: price.toFixed(2), free: !!l.free } });
    if (r.count) out.push({ compensationId: l.compensationId, offerPrice: price, free: !!l.free });
  }
  return out;
}

async function offerEdit(h, intent) {
  const { tx, order, actor, payload, now } = h;
  const offer = latestOffer(order);
  if (!offer) throw new WorkflowError('OFFER_NOT_FOUND');
  const admin = can(actor.role, 'OFFER_SEND');
  requireOwnedOps(payload.lines);
  // Sandık bedeli yalnızca yöneticinindir (Paket 4): satışın kaydı yöneticinin sandık satırını korur, yenisini açamaz
  const input = admin ? { lines: adminInput(payload.lines, offer.lines), kept: [] } : salesInput(payload.lines, offer.lines);
  // Ayrılmış camların sırası (pieceBase) her kayıtta sunucuda yeniden hesaplanır: m² ve tutar kalemin toplam adedinden (karar 114)
  const merged = assignPieceBases([...mergePrices(await completeLines(h, offer, input.lines), offer.lines, admin), ...input.kept]);
  let saved = await writeLines(tx, offer.id, merged, offer.lines);
  // Satış yöneticiye gönderirken müşteri fiyatı boş satırlar müşterinin fiyat tablosundan dolar (karar 32)
  if (intent === 'submit') {
    requireSalesPrices(saved);
    const pricing = await pricingForCustomer(tx, order.customerId);
    if (pricing && pricing.currency === offer.currency) {
      const filled = prefillOfferPrices(saved, pricing);
      for (const [i, l] of filled.entries()) {
        if (l !== saved[i]) await tx.offerLine.update({ where: { id: l.id }, data: { offerPrice: l.offerPrice } });
      }
      saved = filled;
    }
  }
  const { amount, offerAmount } = amounts(saved);
  await tx.offer.update({ where: { id: offer.id }, data: { amount, offerAmount: admin || intent === 'submit' ? offerAmount : undefined } });
  // Etiketleri yalnızca yönetici, fiyat onayı sırasında girer
  if (admin && offer.status === 'YONETIMDE' && payload.labels) await h.set(payload.labels);

  if (intent === 'submit') {
    await tx.offer.update({ where: { id: offer.id }, data: { status: 'YONETIMDE', statusSince: now } });
    // Satış tutarı geçmiş notuna yazılmaz (AUD-1): tutar denetim kaydında (h.audit.amount); geçmişi çizim ve denetimci de görür
    h.event('OFFER_SUBMITTED');
    // Liste fiyatından farklı fiyat → yöneticinin "Önemli kararlar" listesi
    const ov = await recordPriceOverrides(tx, { orderId: order.id, offerId: offer.id, orderNo: order.orderNo, currency: offer.currency, lines: saved, actor, now });
    h.overrides = ov.count;
    // Satış fabrika fiyat tablosundaki fiyatı GERÇEKTEN değiştirdi (son kayıttan farklı fark) → yöneticiye e-posta (karar 218).
    // Aynı fiyatların yeniden gönderimi yeni bildirim üretmez; olayda tutar yoktur.
    if (ov.changed) h.outbox.push(outboxEvent('ORDER_PRICE_OVERRIDE', { orderId: order.id, payload: { actorId: actor.id ?? null, alertId: ov.alertId, qty: ov.count } }));
  } else if (intent === 'approve') {
    requireOfferPrices(saved);
    await tx.offer.update({ where: { id: offer.id }, data: { status: 'GONDERILDI', statusSince: now, sentAt: now, offerAmount } });
    await tx.price.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, amount: offerAmount, setById: actor.id },
      update: { amount: offerAmount, setById: actor.id, setAt: now },
    });
    // Olay notunda tutar yok: geçmişi satış da görür, müşteri fiyatını görmemeli (tutarlar denetim kaydında)
    h.event('OFFER_SENT');
    h.auto = true;
    h.compensationPrices = await recordCompensationPrices(tx, saved);
  } else if (intent === 'return') {
    await tx.offer.update({ where: { id: offer.id }, data: { status: 'HAZIRLANIYOR', statusSince: now } });
    h.event('OFFER_RETURNED', payload.returnNote);
  }
  // Yöneticinin müşteri fiyatı değişikliği (Paket 4): satır satır eski → yeni, ayrı denetim kaydı (OFFER_PRICE_CHANGED).
  // Gönderilmemiş teklifte müşteri yeni fiyatı yalnızca "onayla ve gönder" ile görür (müşteriye yalnızca gönderilmiş teklif gider).
  const priceChange = admin
    ? await recordPriceChange(h, { offerId: offer.id, intent, sent: intent === 'approve', currency: offer.currency, before: offer.lines, after: intent === 'submit' ? saved : merged })
    : null;
  h.sla = true;
  h.audit = {
    offerId: offer.id, intent, amount, ...(admin || intent === 'submit' ? { offerAmount } : {}), lines: saved.length, ...(h.overrides ? { priceOverrides: h.overrides } : {}),
    ...(priceChange ? { priceChange } : {}),
    ...(h.compensationPrices?.length ? { compensationPrices: h.compensationPrices } : {}),
  };
}

/**
 * Müşterinin DWG/DXF çizimi için çizimci kararını kaydeder (karar 167) — üç kararın ortak gövdesi. Kural tek yerde:
 * server/orders/dwg-review.js → dwgReview. İlk kararda müşteri çiziminin karar kaydı (sürüm satırı, kaynak
 * MUSTERI_DXF_DWG) açılır; düzeltilmiş dosyada açık kayıt (BEKLIYOR) karara bağlanır. Kayıt silinmez, dosyaları değişmez.
 * @returns {Promise<{ id: string, version: number, files: { id: string, name: string, checksum: string | null }[] }>}
 */
async function dwgDecide(h, decision) {
  const review = dwgReview({ status: h.order.status, drawingTrack: h.order.drawingTrack, onHold: h.order.onHold, files: h.order.files, drawings: h.order.drawings });
  if (!review.pending) throw new WorkflowError('DWG_NOT_PENDING');
  const status = DWG_DECISION_STATUS[decision];
  const decided = { status, decidedAt: h.now, decidedById: h.actor.id };
  if (review.record) {
    const files = review.files;
    // Üretime hazır kararında incelenen dosyalardan biri sonradan virüslü çıktıysa (karantina) karar verilemez
    if (decision === 'READY' && files.some((f) => (h.order.files ?? []).find((x) => x.id === f.id)?.scanStatus === 'INFECTED')) throw new WorkflowError('DWG_INFECTED');
    const r = await h.tx.drawing.updateMany({ where: { id: review.record.id, source: DWG_SOURCE, status: DWG_RESUBMITTED }, data: decided });
    if (r.count !== 1) throw new WorkflowError('STALE_DRAWING');
    return { id: review.record.id, version: review.record.version, files };
  }
  const files = sourceFilesSnapshot(review.files);
  const newest = review.files[review.files.length - 1];
  const last = h.order.drawings[h.order.drawings.length - 1];
  const rec = await h.tx.drawing.create({
    data: {
      orderId: h.order.id, source: DWG_SOURCE, version: (last?.version ?? 0) + 1, uploadedById: newest?.uploadedById ?? h.order.createdById,
      scanStatus: 'SKIPPED', sourceFiles: files, ...decided,
    },
  });
  return { id: rec.id, version: rec.version, files };
}

const ACTIONS = {
  async send_to_drawing(h) {
    // Tek etkin çizimci varsa iş kendiliğinden ona atanır (ürün sahibinin kararı); birden çoksa çizimci üstlenir.
    const drawers = await h.tx.user.findMany({ where: { appRole: 'CIZIM', isActive: true }, select: { id: true }, take: 2 });
    const assignedDrawerId = h.order.assignedDrawerId ?? (drawers.length === 1 ? drawers[0].id : null);
    await h.set({ status: 'HAZIRLANIYOR', drawingTrack: 'GEREKLI', drawingSince: h.now, assignedDrawerId });
    await ensureOfferDraft(h.tx, h.order, h.actor.id);
    h.event('SENT_TO_DRAWING');
    h.sla = true;
  },
  async no_drawing(h) {
    await h.set({ status: 'HAZIRLANIYOR', drawingTrack: 'YOK', drawingSince: null });
    await ensureOfferDraft(h.tx, h.order, h.actor.id);
    h.event('NO_DRAWING');
    h.sla = true;
  },
  async undo_drawing(h) {
    await h.set({ status: 'YENI', drawingTrack: 'YOK', drawingSince: null, assignedDrawerId: null });
    h.event('UNDO_DRAWING');
    h.sla = true;
  },
  async undo_no_drawing(h) {
    await h.set({ status: 'YENI', drawingTrack: 'YOK', drawingSince: null, assignedDrawerId: null });
    h.event('UNDO_NO_DRAWING');
    h.sla = true;
  },
  async hold(h) {
    await h.set({ onHold: true });
    h.event('HOLD', h.payload.note || null);
    h.sla = true;
  },
  async unhold(h) {
    await h.set({ onHold: false });
    h.event('UNHOLD', h.payload.note || null);
    h.sla = true;
    h.auto = true;
  },
  /**
   * Tahmini yükleme tarihi (Paket C — karar 230): Yönetici, Yönetici Yardımcısı ve Satış (ORDER_REVIEW). Yükleme
   * tamamlandıktan sonra kilitlidir: durum Yüklendi / Arşiv (CLOSED — availableActions) ya da siparişin herhangi bir
   * yükleme onayı kalemi var (kısmi / çoklu yükleme dahil: kalan cam yalnızca yeniden planlama ile taşınır — karar 106).
   * Aynı gün yeniden yazılmaz. Denetim kaydında eski → yeni gün; sandıklar ve SHIP_DATE olayı eskisi gibi.
   */
  async set_ship_date(h) {
    const d = h.payload.date;
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new WorkflowError('INVALID_DATE');
    if (await shipDateLocked(h.tx, h.order.id)) throw new WorkflowError('SHIP_DATE_LOCKED');
    const before = h.order.estimatedShipDate ?? null;
    if (before && dayKey(before) === dayKey(d)) throw new WorkflowError('SHIP_DATE_UNCHANGED');
    h.audit = { fromDate: before ? dayKey(before) : null, toDate: dayKey(d) };
    await h.set({ estimatedShipDate: d });
    await followCrates(h, h.order.actualShipDate ?? d);
    h.event('SHIP_DATE', dayText(d));
  },
  async mark_shipped(h) {
    await h.set({ status: 'YUKLENDI', actualShipDate: h.now });
    await followCrates(h, h.now);
    h.event('SHIPPED');
  },
  /**
   * Otomatik arşiv (karar 158) — yalnızca işçi (server/orders/auto-archive.js). Mevcut arşiv durumu (ARSIVLENDI; yeni durum
   * yok). Kural kayıttan önce bu işlemde yeniden uygulanır: fiziksel yükleme kanıtı (kişinin "Yüklendi"si ya da eksiksiz
   * yükleme onayı) yoksa ya da yükleme gününden 45 gün geçmediyse işlem reddedilir. "Yüklendi" yazılmaz; fiili yükleme günü,
   * sandıklar, yükleme onayı ve belgeler değişmez; bildirim gitmez (ORDER_AUTO_ARCHIVED hiçbir bildirim kuralında yok).
   */
  async auto_archive(h) {
    const { archiveCheck } = await import('./auto-archive.js');
    const r = await archiveCheck(h.tx, h.order, { today: h.payload.today, now: h.now });
    if (!r.ok) throw new WorkflowError(r.code);
    await h.set({ status: 'ARSIVLENDI' });
    h.event('AUTO_ARCHIVED', dayText(new Date(`${r.proof.day}T12:00:00Z`)));
    h.audit = { auto: true, via: r.proof.via, loadingDay: r.proof.day, today: r.today };
  },
  /**
   * 3.51.0 onarımı (karar 158) — yalnızca işçi. Tarihe bakılarak verilmiş "Yüklendi" (siparişi "Yüklendi" yapan son olay
   * AUTO_SHIPPED) kanıt değildi: sipariş mevcut üretim durumuna geri alınır. Bir kişi sonradan "Yüklendi" dediyse işlem reddedilir.
   */
  async auto_ship_revert(h) {
    const last = await h.tx.orderEvent.findFirst({
      where: { orderId: h.order.id, event: { in: ['SHIPPED', 'AUTO_SHIPPED'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, event: true, createdAt: true },
    });
    if (last?.event !== 'AUTO_SHIPPED') throw new WorkflowError('NOT_ALLOWED');
    await h.set({ status: 'URETIMDE' });
    h.event('AUTO_SHIP_REVERTED');
    h.audit = { auto: true, revertOf: last.id, autoShippedAt: last.createdAt.toISOString() };
  },
  async archive(h) {
    await h.set({ status: 'ARSIVLENDI' });
    h.event('ARCHIVED');
  },
  async cancel(h) {
    if (!h.payload.note) throw new WorkflowError('CANCEL_REASON');
    await h.set({ status: 'IPTAL' });
    h.event('CANCELLED', h.payload.note);
    h.sla = true;
  },
  async start_drawing(h) {
    await h.set({ drawingTrack: 'YAPILIYOR', drawingSince: h.now, assignedDrawerId: h.actor.id });
    h.event('DRAWING_STARTED');
    h.sla = true;
  },
  /**
   * Çizimci dosya yükler: açık taslak sürüm varsa ona eklenir, yoksa yeni sürüm (TASLAK) açılır. Taslak müşteriye
   * görünmez; "Müşteriye gönder" (send_drawing) ayrı ve onaylı ikinci adımdır. Dosyalar kaydedilmeden önce virüs
   * taramasından geçmiştir (server/files/store.js).
   */
  async upload_drawing(h) {
    const files = h.payload.files ?? [];
    if (!files.length || files.some((f) => !f?.storageKey)) throw new WorkflowError('DRAWING_FILE');
    const last = h.order.drawings[h.order.drawings.length - 1];
    const notes = {
      ...(h.payload.noteCustomer !== undefined ? { noteCustomer: h.payload.noteCustomer || null } : {}),
      ...(h.payload.noteInternal !== undefined ? { noteInternal: h.payload.noteInternal || null } : {}),
    };
    let drawing = last?.status === 'TASLAK' ? last : null;
    if (drawing) {
      if (Object.keys(notes).length) await h.tx.drawing.update({ where: { id: drawing.id }, data: notes });
    } else {
      drawing = await h.tx.drawing.create({
        data: { orderId: h.order.id, version: (last?.version ?? 0) + 1, status: 'TASLAK', uploadedById: h.actor.id, scanStatus: 'SKIPPED', ...notes },
      });
    }
    await h.tx.drawingFile.createMany({
      data: files.map((f) => ({
        drawingId: drawing.id, name: f.name, storageKey: f.storageKey, size: f.size, mime: f.mime ?? null, checksum: f.checksum ?? null,
        scanStatus: f.scanStatus ?? 'SKIPPED', scanSignature: f.scanSignature ?? null, scannedAt: f.scannedAt ?? null, uploadedById: h.actor.id,
      })),
    });
    // İlk yükleme çizimi başlatır ve (atanmamışsa) çizimciye atar
    if (h.order.drawingTrack === 'GEREKLI') {
      await h.set({ drawingTrack: 'YAPILIYOR', drawingSince: h.now, assignedDrawerId: h.order.assignedDrawerId ?? h.actor.id });
      h.sla = true;
    }
    h.event('DRAWING_DRAFT', `v${drawing.version} · ${files.map((f) => f.name).join(', ')}`);
    h.result = { drawingId: drawing.id, version: drawing.version };
    h.audit = { drawingId: drawing.id, version: drawing.version, files: files.map((f) => ({ name: f.name, checksum: f.checksum ?? null, scan: f.scanStatus ?? null })) };
  },
  /** Taslaktan dosya çıkarılır (müşteriye gönderilmiş sürümün dosyasına dokunulamaz). */
  async remove_drawing_file(h) {
    const last = h.order.drawings[h.order.drawings.length - 1];
    const file = last?.status === 'TASLAK' ? last.files.find((f) => f.id === h.payload.fileId) : null;
    if (!file) throw new WorkflowError('FILE_NOT_FOUND');
    await h.tx.drawingFile.delete({ where: { id: file.id } });
    h.event('DRAWING_DRAFT', `v${last.version} − ${file.name}`);
    h.result = { storageKey: file.storageKey };
    h.audit = { drawingId: last.id, version: last.version, removed: file.name };
  },
  /**
   * Taslak sürüm müşteriye gönderilir. Tüm dosyalar virüs taramasından temiz geçmiş olmalı (taranmamış ya da
   * tarama kapalıyken yüklenmiş dosya gönderilemez). Ekrandaki taslak (drawingId) hâlâ son sürüm olmalı.
   */
  async send_drawing(h) {
    const last = h.order.drawings[h.order.drawings.length - 1];
    if (last?.status !== 'TASLAK') throw new WorkflowError('DRAWING_NO_DRAFT');
    if (h.payload.drawingId && h.payload.drawingId !== last.id) throw new WorkflowError('STALE_DRAWING');
    if (!last.files.length) throw new WorkflowError('DRAWING_EMPTY');
    if (last.files.some((f) => f.scanStatus === 'INFECTED')) throw new WorkflowError('DRAWING_INFECTED');
    if (last.files.some((f) => f.scanStatus === 'PENDING')) throw new WorkflowError('DRAWING_SCAN_PENDING');
    if (last.files.some((f) => f.scanStatus !== 'CLEAN')) throw new WorkflowError('DRAWING_NOT_SCANNED');
    // Müşterinin uygulamada açabileceği en az bir dosya (PDF / JPG / PNG) şart; DWG, DXF, STEP vb. yanında ek olarak gider
    if (!last.files.some((f) => isViewable(f.name))) throw new WorkflowError('DRAWING_NO_VIEWABLE');
    // Gönderim yalnızca "Kontrol Et" ekranından: o ekranın bu taslak, bu kullanıcı ve bu dosyalar için verdiği kanıt şart
    if (!verifyReviewToken(h.payload.review, { secret: getEnv().AUTH_SECRET, drawingId: last.id, userId: h.actor.id, files: last.files, now: h.now.getTime() })) {
      throw new WorkflowError('DRAWING_NOT_CHECKED');
    }
    await h.tx.drawing.update({ where: { id: last.id }, data: { status: 'ONAY_BEKLIYOR', sentAt: h.now, sentById: h.actor.id } });
    await h.set({ drawingTrack: 'ONAY_BEKLIYOR', drawingSince: h.now });
    h.event('DRAWING_UPLOADED', `v${last.version}`);
    h.sla = true;
    h.result = { drawingId: last.id, version: last.version };
    h.audit = { drawingId: last.id, version: last.version, files: last.files.map((f) => f.name), checked: true };
  },
  /** Müşteriye gönderilmiş sürüm, müşteri karar vermeden gerekçeyle geri çekilir; sürüm geçmişte kalır. */
  async withdraw_drawing(h) {
    const reason = h.payload.reason;
    if (!reason) throw new WorkflowError('WITHDRAW_REASON');
    const latest = latestDrawing(h);
    if (latest?.status !== 'ONAY_BEKLIYOR') throw new WorkflowError('DRAWING_NO_DRAFT');
    await h.tx.drawing.update({ where: { id: latest.id }, data: { status: 'GERI_CEKILDI', withdrawnAt: h.now, withdrawReason: reason } });
    await h.set({ drawingTrack: 'YAPILIYOR', drawingSince: h.now });
    h.event('DRAWING_WITHDRAWN', `v${latest.version}: ${reason}`);
    h.sla = true;
    h.audit = { drawingId: latest.id, version: latest.version, reason };
  },
  async approve_drawing(h) {
    // Onay yalnızca müşterinin onayında bekleyen sürüme verilir (decidableDrawing — Paket 3)
    const latest = decidableDrawing(h);
    if (latest) await h.tx.drawing.update({ where: { id: latest.id }, data: { status: 'ONAYLANDI', decidedAt: h.now, decidedById: h.actor.id } });
    await h.set({ drawingTrack: 'ONAYLANDI', drawingSince: h.now });
    // drawingId: çizimcinin bildirimi onaylanan sürümün ekranına götürür (server/notifications/inapp.js)
    h.event('DRAWING_APPROVED', latest ? `v${latest.version}` : null, latest ? { drawingId: latest.id } : undefined);
    h.sla = true;
    h.auto = true;
    if (latest) h.audit = { drawingId: latest.id, version: latest.version };
  },
  async request_revision(h) {
    let comment = h.payload.comment;
    const latest = decidableDrawing(h);
    // Çizim üstü işaretler yalnızca bu sürümün dosyalarına konabilir; doğrulanıp sadeleştirilerek saklanır (karar 227)
    const annotations = latest ? cleanAnnotations(h.payload.annotations, latest.files.map((f) => f.id)) : [];
    // Numaralı not = maddeler + açıklamalı işaretler ("#n: …", aynı numarayla bağlı — server/orders/revision-note.js)
    if (Array.isArray(h.payload.items)) {
      const note = revisionNoteWithMarks(h.payload.items, annotations);
      if (!note.ok) throw new WorkflowError(note.code === 'EMPTY' ? 'REVISION_COMMENT' : note.code === 'TOO_MANY' ? 'REVISION_TOO_MANY' : 'REVISION_TOO_LONG');
      comment = note.text;
    }
    if (!comment) throw new WorkflowError('REVISION_COMMENT');
    if (latest) {
      await h.tx.drawing.update({ where: { id: latest.id }, data: { status: 'REVIZYON_ISTENDI', decidedAt: h.now, decidedById: h.actor.id } });
      const revision = await h.tx.drawingRevision.create({ data: { drawingId: latest.id, kind: 'TALEP', requestedById: h.actor.id, comment, ...(annotations.length ? { annotations } : {}) } });
      // revisionId: talebin notu, işlem bittikten SONRA bir kez çevrilir (sunucu işlemi → çeviri servisinin
      // translateRevision işlevi, karar 163); iş akışı çeviriyi beklemez, çeviri hatası talebi bozmaz
      h.result = { annotations: annotations.length, revisionId: revision.id };
    }
    await h.set({ drawingTrack: 'REVIZYON_ISTENDI', drawingSince: h.now, revisionCount: { increment: 1 } });
    h.event('REVISION_REQUESTED', comment, latest ? { drawingId: latest.id } : undefined);
    h.sla = true;
    if (latest) h.audit = { drawingId: latest.id, version: latest.version };
  },
  // ---------- müşterinin DWG/DXF çizimi (karar 167) ----------
  /** Üretime Hazır: müşteri onayı beklenmez; çizim hattı onaylı → "Müşteriden onaylı çizimler" (koşullar tamamsa üretim) */
  async dwg_ready(h) {
    const rec = await dwgDecide(h, 'READY');
    await h.set({ drawingTrack: 'ONAYLANDI', drawingSince: h.now, assignedDrawerId: h.order.assignedDrawerId ?? h.actor.id });
    h.event('DWG_READY', `v${rec.version}`, { drawingId: rec.id });
    h.sla = true;
    h.auto = true;
    h.result = { drawingId: rec.id };
    h.audit = { decision: 'READY', drawingId: rec.id, version: rec.version, files: rec.files };
  },
  /**
   * Çizim Hatalı: açıklama zorunlu; müşteriye bildirim. Açıklama, kaydın revizyon notu olarak (tür HATALI) saklanır ve
   * işlemden sonra bir kez Romence'ye çevrilir (translateRevision — karar 168). Müşterinin yanıtı beklenir.
   */
  async dwg_faulty(h) {
    const note = dwgNote(h.payload.note);
    if (!note.ok) throw new WorkflowError(note.code);
    const rec = await dwgDecide(h, 'FAULTY');
    const revision = await h.tx.drawingRevision.create({ data: { drawingId: rec.id, kind: 'HATALI', requestedById: h.actor.id, comment: note.text } });
    await h.set({ drawingTrack: 'DUZELTME_BEKLIYOR', drawingSince: h.now, assignedDrawerId: h.order.assignedDrawerId ?? h.actor.id });
    h.event('DWG_FAULTY', note.text, { drawingId: rec.id });
    h.sla = true;
    h.result = { drawingId: rec.id, revisionId: revision.id };
    h.audit = { decision: 'FAULTY', drawingId: rec.id, version: rec.version, files: rec.files, revisionId: revision.id };
  },
  /**
   * Çizimi Güncelle: orijinal dosya korunur; çizimci yeni çizimi olağan akışla (taslak → Kontrol Et → müşteriye gönder)
   * hazırlar. Müşterinin düzeltmesi beklenirken de verilebilir (hatalı kararı ve açıklaması geçmişte kalır).
   */
  async dwg_update(h) {
    const assignedDrawerId = h.order.assignedDrawerId ?? h.actor.id;
    if (h.order.drawingTrack === 'DUZELTME_BEKLIYOR') {
      await h.set({ drawingTrack: 'YAPILIYOR', drawingSince: h.now, assignedDrawerId });
      h.event('DWG_UPDATE');
      h.audit = { decision: 'UPDATE', after: 'FAULTY' };
    } else {
      const rec = await dwgDecide(h, 'UPDATE');
      await h.set({ drawingTrack: 'YAPILIYOR', drawingSince: h.now, assignedDrawerId });
      h.event('DWG_UPDATE', `v${rec.version}`, { drawingId: rec.id });
      h.audit = { decision: 'UPDATE', drawingId: rec.id, version: rec.version, files: rec.files };
    }
    h.sla = true;
  },
  /**
   * Müşteri, hatalı bulunan çiziminin yerine düzeltilmiş dosya gönderir (mevcut siparişe — müşterinin sipariş dosyası).
   * Dosyalar kaydedilmeden önce içerik denetimi ve virüs taramasından geçmiştir (server/files/store.js). Yeni bir karar
   * kaydı (BEKLIYOR) açılır ve sipariş çizimcinin "DXF/DWG" kuyruğuna döner; önceki kayıtlar değişmez.
   */
  async dwg_resubmit(h) {
    const files = h.payload.files ?? [];
    // En az bir DWG / DXF (düzeltilen müşteri çizimi); yanında PDF gibi başka izinli dosyalar olabilir
    if (!files.length || files.some((f) => !f?.storageKey) || !hasCustomerDrawingFile(files)) throw new WorkflowError('DWG_FILE');
    const created = [];
    for (const f of files) {
      created.push(await h.tx.orderFile.create({
        data: {
          orderId: h.order.id, kind: 'CUSTOMER', name: f.name, storageKey: f.storageKey, size: f.size, mime: f.mime ?? null, checksum: f.checksum ?? null,
          scanStatus: f.scanStatus ?? 'PENDING', scanSignature: f.scanSignature ?? null, scannedAt: f.scannedAt ?? null, uploadedById: h.actor.id,
        },
      }));
    }
    const last = h.order.drawings[h.order.drawings.length - 1];
    const rec = await h.tx.drawing.create({
      data: {
        orderId: h.order.id, source: DWG_SOURCE, version: (last?.version ?? 0) + 1, status: DWG_RESUBMITTED, uploadedById: h.actor.id,
        scanStatus: 'SKIPPED', sourceFiles: sourceFilesSnapshot(created),
      },
    });
    await h.set({ drawingTrack: 'GEREKLI', drawingSince: h.now });
    h.event('DWG_RESUBMITTED', `v${rec.version} · ${created.map((f) => f.name).join(', ')}`, { drawingId: rec.id });
    h.sla = true;
    h.result = { drawingId: rec.id, version: rec.version };
    h.audit = { drawingId: rec.id, version: rec.version, files: created.map((f) => ({ name: f.name, checksum: f.checksum ?? null, scan: f.scanStatus })) };
  },
  /** Müşteri, hatalı bulunan çizimi yerine fabrikanın çizmesini ister: sipariş olağan çizim kuyruğuna döner */
  async dwg_request_drawing(h) {
    await h.set({ drawingTrack: 'GEREKLI', drawingSince: h.now });
    h.event('DWG_FACTORY_REQUESTED');
    h.sla = true;
  },
  save_offer: (h) => offerEdit(h, 'save'),
  submit_offer: (h) => offerEdit(h, 'submit'),
  approve_offer: (h) => offerEdit(h, 'approve'),
  return_offer(h) {
    if (!h.payload.returnNote) throw new WorkflowError('RETURN_REASON');
    return offerEdit(h, 'return');
  },
  /**
   * "Yöneticiye göndermeyi geri al" (karar 212): satış, yöneticiye gönderdiği teklifi yönetici fiyatlandırıp müşteriye
   * göndermeden geri alır — teklif yeniden satışın taslağıdır (HAZIRLANIYOR), satış düzenleyip yeniden gönderir.
   *  - Yalnızca teklifi yöneticiye son gönderen satışçı (son OFFER_SUBMITTED olayının kullanıcısı): OFFER_NOT_OWNER.
   *  - Eşzamanlılık: sipariş sürümü (iyimser kilit, executeAction) ve teklifin durumu koşullu güncellenir — yönetici aynı
   *    anda onaylayıp gönderdiyse / geri gönderdiyse geri alma yazılmaz (CONFLICT ya da NOT_ALLOWED).
   *  - Hiçbir şey silinmez: satırlar, yöneticinin taslak müşteri fiyatları ve sandık bedeli satırları teklifte kalır (satış
   *    müşteri fiyatını ve yöneticinin sandık bedelini görmez). Geçmiş (OFFER_WITHDRAWN) ve denetim kaydı yazılır.
   *  - Teklif yöneticinin fiyat onayı kuyruğundan çıkar (kuyruk teklifin durumundan okunur); bu gönderimin açık "liste
   *    fiyatından farklı fiyat" uyarıları kapanır — yeniden gönderimde güncel olanlar yeniden yazılır (recordPriceOverrides).
   */
  async withdraw_offer(h) {
    const { tx, order, actor, now } = h;
    const offer = latestOffer(order);
    if (!offer || offer.status !== 'YONETIMDE') throw new WorkflowError('NOT_ALLOWED');
    const last = await tx.orderEvent.findFirst({ where: { orderId: order.id, event: 'OFFER_SUBMITTED' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { userId: true } });
    if (!last || !actor.id || last.userId !== actor.id) throw new WorkflowError('OFFER_NOT_OWNER');
    const moved = await tx.offer.updateMany({ where: { id: offer.id, status: 'YONETIMDE' }, data: { status: 'HAZIRLANIYOR', statusSince: now } });
    if (moved.count !== 1) throw new WorkflowError('CONFLICT');
    const alerts = await tx.adminAlert.updateMany({ where: { type: 'PRICE_OVERRIDE', orderId: order.id, resolvedAt: null }, data: { resolvedAt: now } });
    h.event('OFFER_WITHDRAWN');
    h.sla = true;
    h.audit = { offerId: offer.id, offerFrom: 'YONETIMDE', offerTo: 'HAZIRLANIYOR', closedAlerts: alerts.count };
  },
  /**
   * Müşterideki teklifi yönetici günceller: eski sürüm kalır, yeni sürüm yöneticinin açık "Güncelle ve müşteriye gönder"
   * işlemiyle müşteriye gider. Mali kilit (Paket 4 — server/orders/financial-lock.js): siparişin FGO belgesi, müşteri
   * belgesi kapsamı, kuyrukta bekleyen belge isteği ya da onaylı yükleme kalemi varsa geçmiş fiyat değişmez
   * (PRICE_LOCKED + nedenler; düzeltme belgesi 7F-2'dir). Denetim, belge isteği ve yükleme onayıyla AYNI danışma kilitleri
   * altında (yükleme onayı → sipariş belgesi) yapılır: kilit denetimi ile yeni sürüm arasına belge / onay giremez.
   */
  async update_offer(h) {
    const { tx, order, actor, payload, now } = h;
    const prev = latestOffer(order);
    if (!prev) throw new WorkflowError('OFFER_NOT_FOUND');
    // Danışma kilitleri (ACTION_LOCKS) sürüm artışından önce alındı: denetim ile yeni sürüm arasına belge / onay giremez
    const locked = await priceLock(tx, order.id);
    if (locked.length) throw new WorkflowError('PRICE_LOCKED', { reasons: locked });
    requireOwnedOps(payload.lines);
    const lines = assignPieceBases(mergePrices(await completeLines(h, prev, adminInput(payload.lines, prev.lines)), prev.lines, true));
    requireOfferPrices(lines);
    const { amount, offerAmount } = amounts(lines);
    // Müşteriye gitmiş teklif değişmez: yeni sürüm açılır ve hemen müşteriye gönderilmiş sayılır
    const created = await tx.offer.create({
      data: {
        orderId: order.id, createdById: actor.id, currency: prev.currency, amount, offerAmount, priceTableId: prev.priceTableId ?? null,
        status: 'GONDERILDI', statusSince: now, sentAt: now,
        lines: { create: lines.map((l, i) => lineData(l, i)) },
      },
    });
    await tx.price.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, amount: offerAmount, setById: actor.id },
      update: { amount: offerAmount, setById: actor.id, setAt: now },
    });
    if (payload.labels) await h.set(payload.labels);
    const from = prev.offerAmount != null ? Number(prev.offerAmount).toFixed(2) : Number(prev.amount).toFixed(2);
    // Olay notu yalnızca yöneticinin açıklaması (tutarlar denetim kaydında; satış müşteri fiyatını görmez)
    h.event('OFFER_UPDATED', payload.note || null);
    const compensationPrices = await recordCompensationPrices(tx, lines);
    // Satır satır eski → yeni müşteri fiyatı, yeni sürümün numarasıyla (Paket 4)
    const priceChange = await recordPriceChange(h, { offerId: created.id, intent: 'update', sent: true, currency: prev.currency, before: prev.lines, after: lines });
    h.audit = {
      offerId: created.id, from, offerAmount, amount, lines: lines.length, ...(compensationPrices.length ? { compensationPrices } : {}),
      ...(priceChange ? { priceChange } : {}),
    };
  },
  async check_offer(h) {
    h.event('OFFER_CHECKED', h.order.drawings.length ? `v${h.order.drawings.length}` : null);
  },
};

/**
 * İşlemlerin danışma kilitleri — sürüm artışından ÖNCE alınır (executeAction). Müşterideki teklifin yeni sürümü
 * (Paket 4): mali kilit denetimi yükleme onayı ve sipariş belgesi isteğiyle aynı kilitler altında (sıra: yükleme onayı →
 * sipariş belgesi — telafi ve belge isteğiyle aynı sıra).
 * @type {Record<string, (order: { id: string }) => string[]>}
 */
const ACTION_LOCKS = {
  update_offer: (order) => ['loading-confirmation', `glass-billing:${order.id}`],
};

export const ORDER_ACTIONS = Object.keys(ACTIONS);

/** Cam siparişinde işlemden sonra: SLA yeniden hesaplanır, koşullar tamamsa otomatik üretime geçilir. */
async function glassFinish(h, entries) {
  if (h.sla) await refreshSla(h.tx, h.order.id);
  if (h.auto) {
    const produced = await autoProduction(h.tx, h.order.id);
    if (produced) entries.push(produced);
    h.result = { ...(h.result ?? {}), produced: !!produced };
  }
}

/**
 * Sipariş tiplerinin ortak işlem çalıştırıcısı (cam: runOrderAction · profil: server/profile/transitions.js).
 * Siparişi kullanıcının kapsamında yükler, iyimser kilidi uygular, işlemi h üzerinden çalıştırır; geçmiş, denetim
 * ve bildirim kuyruğu transitionOrder'da aynı veritabanı işleminde yazılır.
 * h.outbox'a eklenen olaylar (ör. depo e-postası) varsayılan olaylara eklenir.
 * actor.system: işçi (kapsam yok, kimlik yok).
 * Sonuçtaki outboxIds: işlemin yazdığı kuyruk olayları — işlem kaydedildikten SONRA uygulama içi bildirimi hemen dağıtmak
 * için (lib/notifications.ts → deliverInAppNow → server/notifications/inapp.js → dispatchInAppFor; işçi aynı olayı yeniden dener, tekrar yazılmaz).
 */
export async function executeAction(db, { workflow, actions, include, finish = null, locks = {}, orderId, action, actor, payload = {} }) {
  const def = actions[action];
  if (!def) throw new WorkflowError('UNKNOWN_ACTION');
  const scope = actor.system ? {} : orderScope({ appRole: actor.role, customerId: actor.customerId ?? null });
  /** @type {string[]} */
  const outboxIds = [];
  const res = await transitionOrder({
    db,
    workflow,
    orderId,
    action,
    actor,
    payload,
    deps: {
      async loadOrder(tx, id) {
        const o = await tx.order.findFirst({ where: { id, ...scope }, include });
        return o && { ...o, orderType: o.orderTypeCode };
      },
      async apply(tx, order) {
        if (payload.expectedVersion != null && Number(payload.expectedVersion) !== order.version) return null;
        // İşlemin danışma kilitleri (varsa — ör. update_offer: yükleme onayı → sipariş belgesi) sürüm artışından ÖNCE
        // alınır: kilit sırası belge isteği, yükleme onayı ve telafiyle aynıdır (önce danışma kilidi, sonra sipariş satırı)
        for (const key of locks[action]?.(order) ?? []) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        // Sürüm artırılır ve satır kilitlenir: aynı anda gelen ikinci işlem burada bekler, sonra CONFLICT alır
        const bumped = await tx.order.updateMany({ where: { id: order.id, version: order.version }, data: { version: { increment: 1 } } });
        if (bumped.count === 0) return null;

        const entries = [];
        const h = {
          tx, order, actor, payload, now: new Date(), status: order.status,
          sla: false, auto: false, audit: undefined, result: undefined, overrides: 0, outbox: [],
          async set(data) {
            await tx.order.update({ where: { id: order.id }, data });
            if (data.status) h.status = data.status;
          },
          event(code, note = null, data = undefined) {
            entries.push({ event: code, from: order.status, to: h.status, note: note || null, ...(data ? { data } : {}) });
          },
        };
        await def(h);
        if (finish) await finish(h, entries);
        const updated = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
        return { order: updated, entries, audit: h.audit, result: h.result ?? null, outbox: h.outbox };
      },
      history: (tx, e) => writeHistory(tx, e),
      audit: (tx, entry) => writeAudit(tx, entry, actor),
      outbox: {
        async enqueue(tx, ev) {
          const row = await enqueueOutbox(tx, ev);
          if (row?.id) outboxIds.push(row.id);
          return row;
        },
      },
      events: (applied) => [
        // actorId: uygulama içi bildirimde işlemi yapan kullanıcıya kendi işlemi bildirilmez (server/notifications/inapp.js)
        // e.data: olayın ek alanları (ör. drawingId — bildirimin bağlantısı ilgili çizim sürümüne gider)
        ...applied.entries.map((e) => outboxEvent(`ORDER_${e.event}`, { orderId: applied.order.id, payload: { ...(e.data ?? {}), from: e.from ?? null, to: e.to ?? null, actorId: actor.id ?? null } })),
        ...(applied.outbox ?? []),
      ],
      sanitize: (o) => o,
    },
  });
  return { ...res, outboxIds };
}

/**
 * Bir cam siparişi iş akışı işlemini uygular.
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ orderId: string, action: string, actor: { id: string, role: string, canApprove?: boolean, customerId?: string | null, ip?: string | null }, payload?: object }} p
 *   payload.expectedVersion: kullanıcının ekranda gördüğü sipariş sürümü (verilirse değişmişse CONFLICT)
 * @returns {Promise<{ order: object, result: any, entries: object[], outboxIds: string[] }>}
 * @throws {WorkflowError} NOT_FOUND | NOT_ALLOWED | CONFLICT | STALE_DRAWING | OFFER_NOT_FOUND | ...
 */
export function runOrderAction(db, { orderId, action, actor, payload = {} }) {
  return executeAction(db, { workflow: glassWorkflow, actions: ACTIONS, include: INCLUDE, finish: glassFinish, locks: ACTION_LOCKS, orderId, action, actor, payload });
}
