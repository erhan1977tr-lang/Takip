// Cam siparişi iş akışı işlemleri — hepsi transitionOrder'dan geçer (ADR 0002):
// tek yerde yetki/durum kontrolü, aynı veritabanı işleminde değişiklik + geçmiş + denetim + bildirim kuyruğu,
// iyimser kilit (Order.version) ile aynı anda yapılan işlemlerin ikincisinin reddi.
//
// Form okuma ve dil metinleri uygulama katmanında (app/.../actions.ts); burada yalnızca kurallar ve kayıt.
import { transitionOrder } from '../domain/transition.js';
import { WorkflowError } from '../domain/workflow.js';
import { can } from '../auth/permissions.js';
import { availableActions, shouldAutoProduce, slaDeadline } from './rules.js';
import { orderScope } from './scope.js';
import { enqueueOutbox, writeAudit, writeHistory } from './journal.js';

export { WorkflowError };

const INCLUDE = {
  items: true,
  drawings: { orderBy: { version: 'asc' } },
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
  approve_drawing: ['approve_drawing'],
  request_revision: ['request_revision'],
  edit_crates: ['edit_crates'],
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
      drawing: o.drawingTrack, offer: latestOffer(o)?.status ?? null,
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
async function ensureOfferDraft(tx, order, userId) {
  if (order.offers.length) return;
  const src = order.items.length ? order.items : [{ glassName: '', camAdedi: 1 }];
  await tx.offer.create({
    data: {
      orderId: order.id, createdById: userId,
      lines: { create: src.map((it, i) => ({ sortOrder: i, description: it.glassName || '', adet: Math.max(1, it.camAdedi || 1), unit: 'm2' })) },
    },
  });
}

const money = (amount, currency) => `${amount} ${currency}`;
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
  const { lines, amount } = payload;
  await tx.offerLine.deleteMany({ where: { offerId: offer.id } });
  await tx.offerLine.createMany({ data: lines.map((l, i) => ({ ...l, offerId: offer.id, sortOrder: i })) });
  await tx.offer.update({ where: { id: offer.id }, data: { amount } });
  // Etiketleri yalnızca yönetici, fiyat onayı sırasında girer
  if (can(actor.role, 'OFFER_SEND') && offer.status === 'YONETIMDE' && payload.labels) await h.set(payload.labels);

  if (intent === 'submit') {
    await tx.offer.update({ where: { id: offer.id }, data: { status: 'YONETIMDE', statusSince: now } });
    h.event('OFFER_SUBMITTED', money(amount, offer.currency));
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
  h.audit = { offerId: offer.id, intent, amount, lines: lines.length };
}

const ACTIONS = {
  async send_to_drawing(h) {
    await h.set({ status: 'HAZIRLANIYOR', drawingTrack: 'GEREKLI', drawingSince: h.now });
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
    h.event('SHIP_DATE', dayText(d));
  },
  async mark_shipped(h) {
    await h.set({ status: 'YUKLENDI', actualShipDate: h.now });
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
  async upload_drawing(h) {
    const f = h.payload.file;
    if (!f?.storageKey) throw new WorkflowError('DRAWING_FILE');
    const version = h.order.drawings.length + 1;
    const drawing = await h.tx.drawing.create({
      data: {
        orderId: h.order.id, version, fileUrl: f.storageKey, fileName: f.name, fileSize: f.size, mime: f.mime ?? null,
        checksum: f.checksum ?? null, scanStatus: f.scanStatus ?? 'SKIPPED', scanSignature: f.scanSignature ?? null,
        scannedAt: f.scannedAt ?? null, status: 'ONAY_BEKLIYOR', uploadedById: h.actor.id,
      },
    });
    await h.set({ drawingTrack: 'ONAY_BEKLIYOR', drawingSince: h.now });
    h.event('DRAWING_UPLOADED', `v${version}`);
    h.sla = true;
    h.result = { drawingId: drawing.id, version };
    h.audit = { drawingId: drawing.id, version };
  },
  async approve_drawing(h) {
    const latest = latestDrawing(h);
    if (latest) await h.tx.drawing.update({ where: { id: latest.id }, data: { status: 'ONAYLANDI' } });
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
      await h.tx.drawing.update({ where: { id: latest.id }, data: { status: 'REVIZYON_ISTENDI' } });
      await h.tx.drawingRevision.create({ data: { drawingId: latest.id, requestedById: h.actor.id, comment } });
    }
    await h.set({ drawingTrack: 'REVIZYON_ISTENDI', drawingSince: h.now, revisionCount: { increment: 1 } });
    h.event('REVISION_REQUESTED', comment);
    h.sla = true;
    if (latest) h.audit = { drawingId: latest.id, version: latest.version };
  },
  async edit_crates(h) {
    const rows = h.payload.rows ?? [];
    await h.tx.crate.deleteMany({ where: { orderId: h.order.id } });
    if (rows.length) await h.tx.crate.createMany({ data: rows.map((r, i) => ({ ...r, orderId: h.order.id, crateNo: i + 1 })) });
    // Not yalnızca sandık sayısıdır; ekranda events.CRATES.count olarak çevrilir
    h.event('CRATES', String(rows.length));
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
    const { lines, amount } = payload;
    const created = await tx.offer.create({
      data: {
        orderId: order.id, createdById: actor.id, currency: prev.currency, amount,
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
          sla: false, auto: false, audit: undefined, result: undefined,
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
