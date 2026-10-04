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
import { assignPieceBases, atOfferPrice, availableActions, drawingFlags, isViewable, offerProblems, offerTotals, sharedOpsGlasses, shouldAutoProduce, slaDeadline } from './rules.js';
import { verifyReviewToken } from './review.js';
import { getEnv } from '../env.js';
import { orderScope } from './scope.js';
import { enqueueOutbox, writeAudit, writeHistory } from './journal.js';
import { enrichLines, loadPricing, prefillLines, prefillOfferPrices, pricingForCustomer, pricingForUser } from '../pricing/tables.js';
import { recordPriceOverrides } from '../pricing/alerts.js';
import { moveOrderCrates } from '../loading/crates.js';
import { dayKey } from './loading.js';

export { WorkflowError };

const INCLUDE = {
  items: true,
  drawings: { orderBy: { version: 'asc' }, include: { files: true } },
  offers: { orderBy: { createdAt: 'desc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
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
  save_offer: ['edit_offer', 'approve_price'],
  submit_offer: ['submit_offer'],
  approve_offer: ['approve_price'],
  return_offer: ['return_offer'],
  update_offer: ['update_offer'],
  check_offer: ['update_offer'],
};

/** Cam siparişi akışı: bir işlemin geçerli olup olmadığı tüm hatların (çizim, teklif, bekleme) durumuna bakar. */
export const glassWorkflow = {
  orderType: 'GLASS_ORDER',
  check({ orderType, action, actor, ctx }) {
    if (orderType !== 'GLASS_ORDER') return { ok: false, code: 'WRONG_ORDER_TYPE' };
    const need = REQUIRES[action];
    if (!need) return { ok: false, code: 'UNKNOWN_ACTION' };
    const o = ctx.order;
    const acts = availableActions({
      role: actor.role, status: o.status, onHold: o.onHold, canApprove: !!actor.canApprove,
      drawing: o.drawingTrack, offer: latestOffer(o)?.status ?? null, ...drawingFlags(o),
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

const money = (amount, currency) => `${amount} ${currency}`;

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

// ---------- işlemler ----------
// Her işlem h üzerinden çalışır: h.set(veri) siparişi günceller, h.event(kod, not) geçmişe yazar,
// h.sla = true ise sonda SLA yeniden hesaplanır, h.auto = true ise otomatik üretim denenir.

// compensationId: TELAFİ satırının işareti (Aşama 9) — satır düzenlenince / teklifin yeni sürümü açılınca satırla taşınır
// splitGroup / pieceBase: ayrılmış cam grubu (karar 114) — teklifin yeni sürümüne ve kopyalarına satırla birlikte taşınır
const LINE_FIELDS = ['description', 'descriptionRo', 'poz', 'enMm', 'boyMm', 'adet', 'unit', 'unitPrice', 'kind', 'free', 'glassProductId', 'weightKgM2', 'listPrice', 'offerPrice', 'compensationId', 'splitGroup'];
export const lineData = (l, i) => ({ ...Object.fromEntries(LINE_FIELDS.map((k) => [k, l[k] ?? null])), adet: l.adet ?? 1, unit: l.unit ?? 'm2', kind: l.kind ?? 'CAM', free: !!l.free, unitPrice: l.unitPrice ?? 0, pieceBase: l.pieceBase ?? 0, sortOrder: i });
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
  const p = offerProblems(lines.map((l) => ({ ...l, unitPrice: l.unitPrice == null ? '' : String(l.unitPrice) })))
    .filter((x) => x.code === 'missing_prices');
  if (p.length) throw new WorkflowError('SALES_PRICE_MISSING', { problems: p });
}

async function offerEdit(h, intent) {
  const { tx, order, actor, payload, now } = h;
  const offer = latestOffer(order);
  if (!offer) throw new WorkflowError('OFFER_NOT_FOUND');
  const admin = can(actor.role, 'OFFER_SEND');
  requireOwnedOps(payload.lines);
  // Ayrılmış camların sırası (pieceBase) her kayıtta sunucuda yeniden hesaplanır: m² ve tutar kalemin toplam adedinden (karar 114)
  const merged = assignPieceBases(mergePrices(await completeLines(h, offer, payload.lines), offer.lines, admin));
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
    h.event('OFFER_SUBMITTED', money(amount, offer.currency));
    // Liste fiyatından farklı fiyat → yöneticinin "Önemli kararlar" listesi
    h.overrides = await recordPriceOverrides(tx, { orderId: order.id, offerId: offer.id, orderNo: order.orderNo, currency: offer.currency, lines: saved, actor, now });
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
  } else if (intent === 'return') {
    await tx.offer.update({ where: { id: offer.id }, data: { status: 'HAZIRLANIYOR', statusSince: now } });
    h.event('OFFER_RETURNED', payload.returnNote);
  }
  h.sla = true;
  h.audit = { offerId: offer.id, intent, amount, ...(admin || intent === 'submit' ? { offerAmount } : {}), lines: saved.length, ...(h.overrides ? { priceOverrides: h.overrides } : {}) };
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
  async set_ship_date(h) {
    const d = h.payload.date;
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new WorkflowError('INVALID_DATE');
    await h.set({ estimatedShipDate: d });
    await followCrates(h, h.order.actualShipDate ?? d);
    h.event('SHIP_DATE', dayText(d));
  },
  async mark_shipped(h) {
    await h.set({ status: 'YUKLENDI', actualShipDate: h.now });
    await followCrates(h, h.now);
    h.event('SHIPPED');
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
    const latest = latestDrawing(h);
    if (latest) await h.tx.drawing.update({ where: { id: latest.id }, data: { status: 'ONAYLANDI', decidedAt: h.now, decidedById: h.actor.id } });
    await h.set({ drawingTrack: 'ONAYLANDI', drawingSince: h.now });
    h.event('DRAWING_APPROVED', latest ? `v${latest.version}` : null);
    h.sla = true;
    h.auto = true;
    if (latest) h.audit = { drawingId: latest.id, version: latest.version };
  },
  async request_revision(h) {
    const comment = h.payload.comment;
    if (!comment) throw new WorkflowError('REVISION_COMMENT');
    const latest = latestDrawing(h);
    if (latest) {
      await h.tx.drawing.update({ where: { id: latest.id }, data: { status: 'REVIZYON_ISTENDI', decidedAt: h.now, decidedById: h.actor.id } });
      // Çizim üstü işaretler yalnızca bu sürümün dosyalarına konabilir; doğrulanıp sadeleştirilerek saklanır
      const annotations = cleanAnnotations(h.payload.annotations, latest.files.map((f) => f.id));
      await h.tx.drawingRevision.create({ data: { drawingId: latest.id, requestedById: h.actor.id, comment, ...(annotations.length ? { annotations } : {}) } });
      h.result = { annotations: annotations.length };
    }
    await h.set({ drawingTrack: 'REVIZYON_ISTENDI', drawingSince: h.now, revisionCount: { increment: 1 } });
    h.event('REVISION_REQUESTED', comment);
    h.sla = true;
    if (latest) h.audit = { drawingId: latest.id, version: latest.version };
  },
  save_offer: (h) => offerEdit(h, 'save'),
  submit_offer: (h) => offerEdit(h, 'submit'),
  approve_offer: (h) => offerEdit(h, 'approve'),
  return_offer(h) {
    if (!h.payload.returnNote) throw new WorkflowError('RETURN_REASON');
    return offerEdit(h, 'return');
  },
  /** Müşterideki teklifi yönetici günceller: eski sürüm kalır, yeni sürüm hemen müşteriye gönderilmiş sayılır. */
  async update_offer(h) {
    const { tx, order, actor, payload, now } = h;
    const prev = latestOffer(order);
    if (!prev) throw new WorkflowError('OFFER_NOT_FOUND');
    requireOwnedOps(payload.lines);
    const lines = assignPieceBases(mergePrices(await completeLines(h, prev, payload.lines), prev.lines, true));
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
    h.audit = { offerId: created.id, from, offerAmount, amount, lines: lines.length };
  },
  async check_offer(h) {
    h.event('OFFER_CHECKED', h.order.drawings.length ? `v${h.order.drawings.length}` : null);
  },
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
 */
export function executeAction(db, { workflow, actions, include, finish = null, orderId, action, actor, payload = {} }) {
  const def = actions[action];
  if (!def) throw new WorkflowError('UNKNOWN_ACTION');
  const scope = actor.system ? {} : orderScope({ appRole: actor.role, customerId: actor.customerId ?? null });
  return transitionOrder({
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
          event(code, note = null) {
            entries.push({ event: code, from: order.status, to: h.status, note: note || null });
          },
        };
        await def(h);
        if (finish) await finish(h, entries);
        const updated = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
        return { order: updated, entries, audit: h.audit, result: h.result ?? null, outbox: h.outbox };
      },
      history: (tx, e) => writeHistory(tx, e),
      audit: (tx, entry) => writeAudit(tx, entry, actor),
      outbox: { enqueue: (tx, ev) => enqueueOutbox(tx, ev) },
      events: (applied) => [
        // actorId: uygulama içi bildirimde işlemi yapan kullanıcıya kendi işlemi bildirilmez (server/notifications/inapp.js)
        ...applied.entries.map((e) => outboxEvent(`ORDER_${e.event}`, { orderId: applied.order.id, payload: { from: e.from ?? null, to: e.to ?? null, actorId: actor.id ?? null } })),
        ...(applied.outbox ?? []),
      ],
      sanitize: (o) => o,
    },
  });
}

/**
 * Bir cam siparişi iş akışı işlemini uygular.
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ orderId: string, action: string, actor: { id: string, role: string, canApprove?: boolean, customerId?: string | null, ip?: string | null }, payload?: object }} p
 *   payload.expectedVersion: kullanıcının ekranda gördüğü sipariş sürümü (verilirse değişmişse CONFLICT)
 * @returns {Promise<{ order: object, result: any, entries: object[] }>}
 * @throws {WorkflowError} NOT_FOUND | NOT_ALLOWED | CONFLICT | STALE_DRAWING | OFFER_NOT_FOUND | ...
 */
export function runOrderAction(db, { orderId, action, actor, payload = {} }) {
  return executeAction(db, { workflow: glassWorkflow, actions: ACTIONS, include: INCLUDE, finish: glassFinish, orderId, action, actor, payload });
}
