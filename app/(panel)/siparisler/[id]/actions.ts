'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireUser, type CurrentUser } from '@/lib/auth/session';
import { currentOffer, loadOrder, logEvent, maybeAutoProduction, refreshSla, type OrderDetail } from '@/lib/orders';
import { audit } from '@/lib/audit';
import { filesFrom, removeUpload, saveUpload, type StoredFile } from '@/lib/storage';
import { LINE_KIND, availableActions, fileProblem, offerProblems, offerTotals, parseDateOnly } from '@/server/orders/rules.js';

const back = (id: string, q: string) => `/siparisler/${id}?${q}`;
const err = (id: string, msg: string) => back(id, `error=${encodeURIComponent(msg)}`);

function actionsFor(user: CurrentUser, order: OrderDetail) {
  return availableActions({
    role: user.appRole, status: order.status, onHold: order.onHold, canApprove: user.canApprove,
    drawing: order.drawingTrack, offer: currentOffer(order)?.status ?? null,
  });
}

async function guard(formData: FormData, action: string): Promise<{ user: CurrentUser; order: OrderDetail }> {
  const user = await requireUser();
  const order = await loadOrder(String(formData.get('id') ?? ''), user);
  if (!actionsFor(user, order).includes(action)) {
    redirect(err(order.id, 'Bu işlem şu anda yapılamaz (sipariş durumu değişmiş olabilir). Sayfayı yenileyin.'));
  }
  return { user, order };
}

function done(id: string, ok: string): never {
  revalidatePath('/siparisler');
  revalidatePath('/teklifler');
  revalidatePath(`/siparisler/${id}`);
  redirect(back(id, `ok=${ok}`));
}

type Tx = Prisma.TransactionClient;

/** Teklif yoksa siparişin cam kalemlerinden bir taslak açar. */
async function ensureOfferDraft(tx: Tx, order: OrderDetail, userId: string) {
  if (order.offers.length) return;
  const src: { glassName: string | null; camAdedi: number }[] = order.items.length ? order.items : [{ glassName: '', camAdedi: 1 }];
  await tx.offer.create({
    data: {
      orderId: order.id, createdById: userId,
      lines: { create: src.map((it, i) => ({ sortOrder: i, description: it.glassName || '', adet: Math.max(1, it.camAdedi || 1), unit: 'm2' })) },
    },
  });
}

// ---------------- Satış kararı ----------------
/** Çizim gerekli: çizim ekibine yönlendir. Teklif hattı da açılır, satış teklifi paralel yazabilir. */
export async function sendToDrawingAction(formData: FormData) {
  const { user, order } = await guard(formData, 'send_to_drawing');
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { status: 'HAZIRLANIYOR', drawingTrack: 'GEREKLI', drawingSince: new Date() } });
    await ensureOfferDraft(tx, order, user.id);
    await logEvent(tx, order.id, 'SENT_TO_DRAWING', user.id);
    await refreshSla(tx, order.id);
  });
  done(order.id, 'to_drawing');
}

/** Çizim gerekmiyor: doğrudan teklife geç. */
export async function noDrawingAction(formData: FormData) {
  const { user, order } = await guard(formData, 'no_drawing');
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { status: 'HAZIRLANIYOR', drawingTrack: 'YOK', drawingSince: null } });
    await ensureOfferDraft(tx, order, user.id);
    await logEvent(tx, order.id, 'NO_DRAWING', user.id);
    await refreshSla(tx, order.id);
  });
  done(order.id, 'to_offer');
}

/**
 * Satış kararını geri alır (teklif hâlâ satıştayken): sipariş yeniden karar bekler.
 * Teklif taslağı silinmez; karar yeniden verildiğinde kaldığı yerden devam edilir.
 */
async function undoDecision(formData: FormData, action: 'undo_drawing' | 'undo_no_drawing') {
  const { user, order } = await guard(formData, action);
  await db.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: { status: 'YENI', drawingTrack: 'YOK', drawingSince: null, assignedDrawer: { disconnect: true } },
    });
    await logEvent(tx, order.id, action === 'undo_drawing' ? 'UNDO_DRAWING' : 'UNDO_NO_DRAWING', user.id);
    await refreshSla(tx, order.id);
  });
  done(order.id, action);
}

/** "Çizime Göndermeyi Geri Al" — çizim müşteriye gitmeden önce. */
export async function undoDrawingAction(formData: FormData) {
  await undoDecision(formData, 'undo_drawing');
}

/** "Teklife Göndermeyi Geri Al" */
export async function undoNoDrawingAction(formData: FormData) {
  await undoDecision(formData, 'undo_no_drawing');
}

export async function holdAction(formData: FormData) {
  const hold = String(formData.get('hold')) === '1';
  const { user, order } = await guard(formData, hold ? 'hold' : 'unhold');
  const note = String(formData.get('note') ?? '').trim().slice(0, 500);
  const produced = await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { onHold: hold } });
    await logEvent(tx, order.id, hold ? 'HOLD' : 'UNHOLD', user.id, note || null);
    await refreshSla(tx, order.id);
    return hold ? false : maybeAutoProduction(tx, order.id, user.id);
  });
  done(order.id, hold ? 'held' : produced ? 'unheld_production' : 'unheld');
}

export async function setShipDateAction(formData: FormData) {
  const { user, order } = await guard(formData, 'set_ship_date');
  const d = parseDateOnly(String(formData.get('date') ?? ''));
  if (!d) redirect(err(order.id, 'Geçerli bir tarih seçin.'));
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { estimatedShipDate: d } });
    await logEvent(tx, order.id, 'SHIP_DATE', user.id, d.toISOString().slice(0, 10).split('-').reverse().join('.'));
  });
  done(order.id, 'ship_date');
}

export async function markShippedAction(formData: FormData) {
  const { user, order } = await guard(formData, 'mark_shipped');
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { status: 'YUKLENDI', actualShipDate: new Date() } });
    await logEvent(tx, order.id, 'SHIPPED', user.id);
  });
  done(order.id, 'shipped');
}

export async function archiveAction(formData: FormData) {
  const { user, order } = await guard(formData, 'archive');
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { status: 'ARSIVLENDI' } });
    await logEvent(tx, order.id, 'ARCHIVED', user.id);
  });
  done(order.id, 'archived');
}

export async function cancelAction(formData: FormData) {
  const { user, order } = await guard(formData, 'cancel');
  const note = String(formData.get('note') ?? '').trim().slice(0, 500);
  if (!note) redirect(err(order.id, 'İptal nedeni yazın.'));
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { status: 'IPTAL' } });
    await logEvent(tx, order.id, 'CANCELLED', user.id, note);
    await refreshSla(tx, order.id);
  });
  done(order.id, 'cancelled');
}

// ---------------- Çizim hattı ----------------
export async function startDrawingAction(formData: FormData) {
  const { user, order } = await guard(formData, 'start_drawing');
  await db.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: { drawingTrack: 'YAPILIYOR', drawingSince: new Date(), assignedDrawer: { connect: { id: user.id } } },
    });
    await logEvent(tx, order.id, 'DRAWING_STARTED', user.id);
    await refreshSla(tx, order.id);
  });
  done(order.id, 'drawing_started');
}

export async function uploadDrawingAction(formData: FormData) {
  const { user, order } = await guard(formData, 'upload_drawing');
  const file = filesFrom(formData, 'file')[0];
  if (!file) redirect(err(order.id, 'Çizim dosyası seçin.'));
  const problem = fileProblem(file.name, file.size);
  if (problem) redirect(err(order.id, problem));
  const stored = await saveUpload(file);
  const version = order.drawings.length + 1;
  try {
    await db.$transaction(async (tx) => {
      await tx.drawing.create({
        data: {
          orderId: order.id, version, fileUrl: stored.storageKey, fileName: stored.name, fileSize: stored.size,
          status: 'ONAY_BEKLIYOR', uploadedById: user.id,
        },
      });
      await tx.order.update({ where: { id: order.id }, data: { drawingTrack: 'ONAY_BEKLIYOR', drawingSince: new Date() } });
      await logEvent(tx, order.id, 'DRAWING_UPLOADED', user.id, `v${version}`);
      await refreshSla(tx, order.id);
    });
  } catch (e) {
    await removeUpload(stored.storageKey);
    throw e;
  }
  done(order.id, 'drawing_uploaded');
}

/** Müşterinin tek onayı: çizim onayı. Teklif hattını etkilemez. */
export async function approveDrawingAction(formData: FormData) {
  const { user, order } = await guard(formData, 'approve_drawing');
  const latest = order.drawings[order.drawings.length - 1];
  const produced = await db.$transaction(async (tx) => {
    if (latest) await tx.drawing.update({ where: { id: latest.id }, data: { status: 'ONAYLANDI' } });
    await tx.order.update({ where: { id: order.id }, data: { drawingTrack: 'ONAYLANDI', drawingSince: new Date() } });
    await logEvent(tx, order.id, 'DRAWING_APPROVED', user.id, latest ? `v${latest.version}` : null);
    await refreshSla(tx, order.id);
    return maybeAutoProduction(tx, order.id, user.id);
  });
  done(order.id, produced ? 'drawing_approved_production' : 'drawing_approved');
}

export async function requestRevisionAction(formData: FormData) {
  const { user, order } = await guard(formData, 'request_revision');
  const comment = String(formData.get('comment') ?? '').trim().slice(0, 2000);
  if (!comment) redirect(err(order.id, 'Revizyon için ne değişmesi gerektiğini yazın.'));
  const latest = order.drawings[order.drawings.length - 1];
  await db.$transaction(async (tx) => {
    if (latest) {
      await tx.drawing.update({ where: { id: latest.id }, data: { status: 'REVIZYON_ISTENDI' } });
      await tx.drawingRevision.create({ data: { drawingId: latest.id, requestedById: user.id, comment } });
    }
    await tx.order.update({
      where: { id: order.id },
      data: { drawingTrack: 'REVIZYON_ISTENDI', drawingSince: new Date(), revisionCount: { increment: 1 } },
    });
    await logEvent(tx, order.id, 'REVISION_REQUESTED', user.id, comment);
    await refreshSla(tx, order.id);
  });
  done(order.id, 'revision_requested');
}

// ---------------- Sandıklar ----------------
/** Sandık ölçü ve ağırlıkları (gerçek kayıt). Boş bırakılan satırlar silinir. */
export async function saveCratesAction(formData: FormData) {
  const { user, order } = await guard(formData, 'edit_crates');
  const col = (k: string) => formData.getAll(k).map((v) => String(v).trim());
  const dim = col('c_dim'), net = col('c_net'), brut = col('c_brut');
  const toKg = (s: string) => (s ? Number(s.replace(',', '.')) : null);
  const rows: { dimensions: string | null; netAgirlik: number | null; brutAgirlik: number | null }[] = [];
  for (let i = 0; i < dim.length; i++) {
    if (!dim[i] && !net[i] && !brut[i]) continue;
    const n = toKg(net[i]), b = toKg(brut[i]);
    for (const v of [n, b]) if (v !== null && (!Number.isFinite(v) || v < 0 || v > 20000)) redirect(err(order.id, `${i + 1}. sandıkta ağırlık geçersiz.`));
    if (n !== null && b !== null && b < n) redirect(err(order.id, `${i + 1}. sandıkta brüt ağırlık netten küçük olamaz.`));
    rows.push({ dimensions: dim[i] ? dim[i].slice(0, 80) : null, netAgirlik: n, brutAgirlik: b });
  }
  await db.$transaction(async (tx) => {
    await tx.crate.deleteMany({ where: { orderId: order.id } });
    if (rows.length) await tx.crate.createMany({ data: rows.map((r, i) => ({ ...r, orderId: order.id, crateNo: i + 1 })) });
    await logEvent(tx, order.id, 'CRATES', user.id, `${rows.length} sandık`);
  });
  revalidatePath('/yuklemeler');
  done(order.id, 'crates_saved');
}

// ---------------- Ortak ----------------
export async function addFilesAction(formData: FormData) {
  const { user, order } = await guard(formData, 'add_file');
  const files = filesFrom(formData, 'files');
  if (!files.length) redirect(err(order.id, 'Dosya seçin.'));
  for (const f of files) {
    const p = fileProblem(f.name, f.size);
    if (p) redirect(err(order.id, p));
  }
  const stored: StoredFile[] = [];
  try {
    for (const f of files) stored.push(await saveUpload(f));
    await db.orderFile.createMany({
      data: stored.map((s) => ({ ...s, orderId: order.id, uploadedById: user.id, kind: user.appRole === 'MUSTERI' ? ('CUSTOMER' as const) : ('INTERNAL' as const) })),
    });
  } catch (e) {
    await Promise.all(stored.map((s) => removeUpload(s.storageKey)));
    throw e;
  }
  await audit('ORDER_FILES_ADDED', 'Order', order.id, user.id, { count: stored.length });
  done(order.id, 'files_added');
}

export async function addNoteAction(formData: FormData) {
  const user = await requireUser();
  const order = await loadOrder(String(formData.get('id') ?? ''), user);
  const text = String(formData.get('text') ?? '').trim().slice(0, 4000);
  if (!text) redirect(err(order.id, 'Not boş olamaz.'));
  const internal = user.appRole !== 'MUSTERI' && formData.get('internal') === 'on';
  await db.orderNote.create({ data: { orderId: order.id, userId: user.id, text, internal } });
  done(order.id, 'note_added');
}

// ---------------- Teklif hattı ----------------
type LineInput = { description: string; poz: string | null; enMm: number | null; boyMm: number | null; adet: number; unit: string; unitPrice: string; kind: string; free: boolean };

function readLines(formData: FormData): LineInput[] | string {
  const col = (k: string) => formData.getAll(k).map((v) => String(v).trim());
  const desc = col('l_desc'), poz = col('l_poz'), en = col('l_en'), boy = col('l_boy'), adet = col('l_adet'), unit = col('l_unit'), price = col('l_price');
  const kinds = col('l_kind'), free = col('l_free');
  const lines: LineInput[] = [];
  for (let i = 0; i < desc.length; i++) {
    const kind = kinds[i] === 'CNC' || kinds[i] === 'DELIK' ? kinds[i] : 'CAM';
    const sub = kind !== 'CAM';
    if (!sub && !desc[i] && !en[i] && !boy[i] && !price[i]) continue; // boş cam satırı
    if (sub && !desc[i]) desc[i] = LINE_KIND[kind as keyof typeof LINE_KIND];
    const toInt = (s: string) => (s ? Math.trunc(Number(s.replace(',', '.'))) : null);
    const e = toInt(en[i]), b = toInt(boy[i]), a = toInt(adet[i]) ?? 1;
    const p = Number((price[i] || '0').replace(',', '.'));
    if (!desc[i]) return `${i + 1}. satırda açıklama eksik.`;
    if ((e !== null && (e <= 0 || e > 10000)) || (b !== null && (b <= 0 || b > 10000))) return `${i + 1}. satırda ölçü 1–10000 mm arasında olmalı.`;
    if (!Number.isFinite(a) || a <= 0 || a > 100000) return `${i + 1}. satırda adet geçersiz.`;
    if (!Number.isFinite(p) || p < 0 || p > 1_000_000) return `${i + 1}. satırda fiyat geçersiz.`;
    const isFree = free[i] === '1';
    lines.push({
      description: desc[i].slice(0, 300), poz: poz[i] ? poz[i].slice(0, 60) : null, enMm: e, boyMm: b, adet: a,
      unit: sub || unit[i] === 'adet' ? 'adet' : 'm2', unitPrice: (isFree ? 0 : p).toFixed(2), kind, free: isFree,
    });
  }
  return lines;
}

/** Müşteriye gidecek teklif için eksik ya da null. */
function finalProblem(lines: LineInput[]): string | null {
  const p = offerProblems(lines);
  return p.length ? p.join(' ') : null;
}

const labels = (formData: FormData) => ({
  camEtiket: String(formData.get('camEtiket') ?? '').trim().slice(0, 120) || null,
  sandikEtiket: String(formData.get('sandikEtiket') ?? '').trim().slice(0, 120) || null,
});

/**
 * intent: save | submit (satış) · save | approve | return (yönetici, fiyat onayında)
 *         update (yönetici, teklif müşterideyken: yeni sürüm hemen müşteriye gider)
 */
export async function saveOfferAction(formData: FormData) {
  const user = await requireUser(['SATIS', 'ADMIN']);
  const order = await loadOrder(String(formData.get('id') ?? ''), user);
  const intent = String(formData.get('intent') ?? 'save');
  const acts = actionsFor(user, order);
  if (intent === 'update') return updateSentOffer(user, order, acts, formData);
  if (!acts.includes('edit_offer') && !acts.includes('approve_price')) redirect(err(order.id, 'Teklif şu anda düzenlenemez.'));
  const offer = currentOffer(order);
  if (!offer) redirect(err(order.id, 'Teklif bulunamadı.'));

  const lines = readLines(formData);
  if (typeof lines === 'string') redirect(err(order.id, lines));
  const finalize = intent === 'submit' || intent === 'approve';
  const problem = finalize ? finalProblem(lines) : null;
  if (problem) redirect(err(order.id, problem));
  const totals = offerTotals(lines);
  const amount = totals.amount.toFixed(2);
  const isAdmin = user.appRole === 'ADMIN';
  const { camEtiket, sandikEtiket } = labels(formData);
  const returnNote = String(formData.get('returnNote') ?? '').trim().slice(0, 1000);
  if (intent === 'return' && !returnNote) redirect(err(order.id, 'Satışa geri gönderme nedenini yazın.'));
  const now = new Date();

  const produced = await db.$transaction(async (tx) => {
    await tx.offerLine.deleteMany({ where: { offerId: offer.id } });
    await tx.offerLine.createMany({ data: lines.map((l, i) => ({ ...l, offerId: offer.id, sortOrder: i })) });
    await tx.offer.update({ where: { id: offer.id }, data: { amount } });
    if (isAdmin && acts.includes('approve_price')) await tx.order.update({ where: { id: order.id }, data: { camEtiket, sandikEtiket } });

    if (intent === 'submit' && acts.includes('submit_offer')) {
      await tx.offer.update({ where: { id: offer.id }, data: { status: 'YONETIMDE', statusSince: now } });
      await logEvent(tx, order.id, 'OFFER_SUBMITTED', user.id, `${amount} ${offer.currency}`);
    } else if (intent === 'approve' && acts.includes('approve_price')) {
      await tx.offer.update({ where: { id: offer.id }, data: { status: 'GONDERILDI', statusSince: now, sentAt: now } });
      await tx.price.upsert({
        where: { orderId: order.id },
        create: { orderId: order.id, amount, setById: user.id },
        update: { amount, setById: user.id, setAt: now },
      });
      await logEvent(tx, order.id, 'OFFER_SENT', user.id, `${amount} ${offer.currency}`);
    } else if (intent === 'return' && acts.includes('return_offer')) {
      await tx.offer.update({ where: { id: offer.id }, data: { status: 'HAZIRLANIYOR', statusSince: now } });
      await logEvent(tx, order.id, 'OFFER_RETURNED', user.id, returnNote);
    }
    await refreshSla(tx, order.id);
    return intent === 'approve' ? maybeAutoProduction(tx, order.id, user.id) : false;
  });
  await audit('OFFER_SAVED', 'Offer', offer.id, user.id, { intent, amount, lines: lines.length });
  done(order.id, intent === 'save' ? 'offer_saved' : produced ? `offer_${intent}_production` : `offer_${intent}`);
}

/**
 * Yönetici, müşterideki teklifi günceller (ör. çizim revizyonu ölçüleri değiştirdi). Eski sürüm silinmez;
 * yeni sürüm doğrudan müşteriye gönderilmiş olarak kaydedilir ve fiyat güncellenir. Satış bu işlemi yapamaz.
 */
async function updateSentOffer(user: CurrentUser, order: OrderDetail, acts: string[], formData: FormData): Promise<never> {
  if (!acts.includes('update_offer')) redirect(err(order.id, 'Teklif şu anda güncellenemez.'));
  const prev = currentOffer(order);
  if (!prev) redirect(err(order.id, 'Teklif bulunamadı.'));
  const lines = readLines(formData);
  if (typeof lines === 'string') redirect(err(order.id, lines));
  const problem = finalProblem(lines);
  if (problem) redirect(err(order.id, problem));
  const amount = offerTotals(lines).amount.toFixed(2);
  const note = String(formData.get('updateNote') ?? '').trim().slice(0, 1000);
  const now = new Date();
  const created = await db.$transaction(async (tx) => {
    const o = await tx.offer.create({
      data: {
        orderId: order.id, createdById: user.id, currency: prev.currency, amount,
        status: 'GONDERILDI', statusSince: now, sentAt: now,
        lines: { create: lines.map((l, i) => ({ ...l, sortOrder: i })) },
      },
    });
    await tx.price.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, amount, setById: user.id },
      update: { amount, setById: user.id, setAt: now },
    });
    await tx.order.update({ where: { id: order.id }, data: labels(formData) });
    await logEvent(tx, order.id, 'OFFER_UPDATED', user.id, `${Number(prev.amount).toFixed(2)} → ${amount} ${prev.currency}${note ? ` · ${note}` : ''}`);
    return o;
  });
  await audit('OFFER_UPDATED', 'Offer', created.id, user.id, { from: Number(prev.amount).toFixed(2), amount, lines: lines.length });
  done(order.id, 'offer_updated');
}

/** Yönetici, teklif gönderildikten sonra gelen çizimi kontrol etti ve teklifte değişiklik gerekmiyor. */
export async function checkOfferAction(formData: FormData) {
  const { user, order } = await guard(formData, 'update_offer');
  await db.$transaction(async (tx) => {
    await logEvent(tx, order.id, 'OFFER_CHECKED', user.id, order.drawings.length ? `v${order.drawings.length}` : null);
  });
  done(order.id, 'offer_checked');
}
