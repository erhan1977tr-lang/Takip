// Cam siparişi iş akışı işlemleri — hepsi transitionOrder'dan geçer (ADR 0002):
// tek yerde yetki/durum kontrolü, aynı veritabanı işleminde değişiklik + geçmiş + denetim + bildirim kuyruğu,
// iyimser kilit (Order.version) ile aynı anda yapılan işlemlerin ikincisinin reddi.
//
// Form okuma ve dil metinleri uygulama katmanında (app/.../actions.ts); burada yalnızca kurallar ve kayıt.
import { transitionOrder } from '../domain/transition.js';
import { WorkflowError } from '../domain/workflow.js';
import { can } from '../auth/permissions.js';
import { availableActions, drawingFlags, shouldAutoProduce, slaDeadline } from './rules.js';
import { orderScope } from './scope.js';
import { enqueueOutbox, writeAudit, writeHistory } from './journal.js';
import { enrichLines, loadPricing, prefillLines, pricingForUser } from '../pricing/tables.js';
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

async function offerEdit(h, intent) {
  const { tx, order, actor, payload, now } = h;
  const offer = latestOffer(order);
  if (!offer) throw new WorkflowError('OFFER_NOT_FOUND');
  const { amount } = payload;
  const lines = await completeLines(h, offer, payload.lines);
  await tx.offerLine.deleteMany({ where: { offerId: offer.id } });
  await tx.offerLine.createMany({ data: lines.map((l, i) => ({ ...l, offerId: offer.id, sortOrder: i })) });
  await tx.offer.update({ where: { id: offer.id }, data: { amount } });
  // Etiketleri yalnızca yönetici, fiyat onayı sırasında girer
  if (can(actor.role, 'OFFER_SEND') && offer.status === 'YONETIMDE' && payload.labels) await h.set(payload.labels);

  if (intent === 'submit') {
    await tx.offer.update({ where: { id: offer.id }, data: { status: 'YONETIMDE', statusSince: now } });
    h.event('OFFER_SUBMITTED', money(amount, offer.currency));
    // Liste fiyatından farklı fiyat → yöneticinin "Önemli kararlar" listesi
    h.overrides = await recordPriceOverrides(tx, { orderId: order.id, offerId: offer.id, orderNo: order.orderNo, currency: offer.currency, lines, actor, now });
  } else if (intent === 'approve') {
    await tx.offer.update({ where: { id: offer.id }, data: { status: 'GONDERILDI', statusSince: now, sentAt: now } });
    await tx.price.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, amount, setById: actor.id },
      update: { amount, setById: actor.id, setAt: now },
    });
    h.event('OFFER_SENT', money(amount, offer.currency));
    h.auto = true;
  } else if (intent === 'return') {
    await tx.offer.update({ where: { id: offer.id }, data: { status: 'HAZIRLANIYOR', statusSince: now } });
    h.event('OFFER_RETURNED', payload.returnNote);
  }
  h.sla = true;
  h.audit = { offerId: offer.id, intent, amount, lines: lines.length, ...(h.overrides ? { priceOverrides: h.overrides } : {}) };
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
    await h.tx.drawing.update({ where: { id: last.id }, data: { status: 'ONAY_BEKLIYOR', sentAt: h.now, sentById: h.actor.id } });
    await h.set({ drawingTrack: 'ONAY_BEKLIYOR', drawingSince: h.now });
    h.event('DRAWING_UPLOADED', `v${last.version}`);
    h.sla = true;
    h.result = { drawingId: last.id, version: last.version };
    h.audit = { drawingId: last.id, version: last.version, files: last.files.map((f) => f.name) };
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
      await h.tx.drawingRevision.create({ data: { drawingId: latest.id, requestedById: h.actor.id, comment } });
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
    const { amount } = payload;
    const lines = await completeLines(h, prev, payload.lines);
    const created = await tx.offer.create({
      data: {
        orderId: order.id, createdById: actor.id, currency: prev.currency, amount, priceTableId: prev.priceTableId ?? null,
        status: 'GONDERILDI', statusSince: now, sentAt: now,
        lines: { create: lines.map((l, i) => ({ ...l, sortOrder: i })) },
      },
    });
    await tx.price.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, amount, setById: actor.id },
      update: { amount, setById: actor.id, setAt: now },
    });
    if (payload.labels) await h.set(payload.labels);
    const from = Number(prev.amount).toFixed(2);
    h.event('OFFER_UPDATED', `${from} → ${money(amount, prev.currency)}${payload.note ? ` · ${payload.note}` : ''}`);
    h.audit = { offerId: created.id, from, amount, lines: lines.length };
  },
  async check_offer(h) {
    h.event('OFFER_CHECKED', h.order.drawings.length ? `v${h.order.drawings.length}` : null);
  },
};

export const ORDER_ACTIONS = Object.keys(ACTIONS);

/**
 * Bir iş akışı işlemini uygular.
 * @param {import('@prisma/client').PrismaClient} db
 * @param {{ orderId: string, action: string, actor: { id: string, role: string, canApprove?: boolean, customerId?: string | null, ip?: string | null }, payload?: object }} p
 *   payload.expectedVersion: kullanıcının ekranda gördüğü sipariş sürümü (verilirse değişmişse CONFLICT)
 * @returns {Promise<{ order: object, result: any, entries: object[] }>}
 * @throws {WorkflowError} NOT_FOUND | NOT_ALLOWED | CONFLICT | STALE_DRAWING | OFFER_NOT_FOUND | ...
 */
export function runOrderAction(db, { orderId, action, actor, payload = {} }) {
  const def = ACTIONS[action];
  if (!def) throw new WorkflowError('UNKNOWN_ACTION');
  const scope = orderScope({ appRole: actor.role, customerId: actor.customerId ?? null });
  return transitionOrder({
    db,
    workflow: glassWorkflow,
    orderId,
    action,
    actor,
    payload,
    deps: {
      async loadOrder(tx, id) {
        const o = await tx.order.findFirst({ where: { id, ...scope }, include: INCLUDE });
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
          sla: false, auto: false, audit: undefined, result: undefined, overrides: 0,
          async set(data) {
            await tx.order.update({ where: { id: order.id }, data });
            if (data.status) h.status = data.status;
          },
          event(code, note = null) {
            entries.push({ event: code, from: order.status, to: h.status, note: note || null });
          },
        };
        await def(h);
        if (h.sla) await refreshSla(tx, order.id);
        if (h.auto) {
          const produced = await autoProduction(tx, order.id);
          if (produced) entries.push(produced);
          h.result = { ...(h.result ?? {}), produced: !!produced };
        }
        const updated = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
        return { order: updated, entries, audit: h.audit, result: h.result ?? null };
      },
      history: (tx, e) => writeHistory(tx, e),
      audit: (tx, entry) => writeAudit(tx, entry, actor),
      outbox: { enqueue: (tx, ev) => enqueueOutbox(tx, ev) },
      sanitize: (o) => o,
    },
  });
}
