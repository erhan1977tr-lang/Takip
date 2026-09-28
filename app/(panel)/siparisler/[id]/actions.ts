'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireUser, type CurrentUser } from '@/lib/auth/session';
import { loadOrder, transition, type OrderDetail } from '@/lib/orders';
import { audit } from '@/lib/audit';
import { filesFrom, removeUpload, saveUpload, type StoredFile } from '@/lib/storage';
import { availableActions, fileProblem, offerTotals, parseDateOnly } from '@/server/orders/rules.js';

const back = (id: string, q: string) => `/siparisler/${id}?${q}`;
const err = (id: string, msg: string) => back(id, `error=${encodeURIComponent(msg)}`);

async function guard(formData: FormData, action: string): Promise<{ user: CurrentUser; order: OrderDetail }> {
  const user = await requireUser();
  const id = String(formData.get('id') ?? '');
  const order = await loadOrder(id, user);
  const allowed = availableActions({ role: user.appRole, status: order.status, onHold: order.onHold, canApprove: user.canApprove });
  if (!allowed.includes(action)) redirect(err(order.id, 'Bu işlem şu anda yapılamaz (sipariş durumu değişmiş olabilir). Sayfayı yenileyin.'));
  return { user, order };
}

function done(id: string, ok: string): never {
  revalidatePath('/siparisler');
  revalidatePath(`/siparisler/${id}`);
  redirect(back(id, `ok=${ok}`));
}

/** Teklif yoksa siparişin cam kalemlerinden bir taslak oluşturur. */
async function ensureOfferDraft(tx: Prisma.TransactionClient, order: OrderDetail, userId: string) {
  const existing = await tx.offer.findFirst({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } });
  if (existing) {
    if (existing.status !== 'HAZIRLANIYOR') await tx.offer.update({ where: { id: existing.id }, data: { status: 'HAZIRLANIYOR' } });
    return;
  }
  const src: { glassName: string | null; camAdedi: number }[] = order.items.length ? order.items : [{ glassName: '', camAdedi: 1 }];
  const lines = src.map((it, i) => ({
    sortOrder: i, description: it.glassName || '', adet: Math.max(1, it.camAdedi || 1), unit: 'm2',
  }));
  await tx.offer.create({ data: { orderId: order.id, createdById: userId, lines: { create: lines } } });
}

// ---------------- Satış ----------------
export async function sendToDrawingAction(formData: FormData) {
  const { user, order } = await guard(formData, 'send_to_drawing');
  await db.$transaction((tx) => transition(tx, order, 'CIZIM_GEREKLI', user.id, 'Çizim ekibine gönderildi', { needsDrawing: true }));
  done(order.id, 'to_drawing');
}

export async function startOfferAction(formData: FormData) {
  const { user, order } = await guard(formData, 'start_offer');
  await db.$transaction(async (tx) => {
    await ensureOfferDraft(tx, order, user.id);
    await transition(tx, order, 'TEKLIF_HAZIRLANIYOR', user.id, 'Çizim gerekmedi, teklif hazırlanıyor', { needsDrawing: false });
  });
  done(order.id, 'to_offer');
}

export async function holdAction(formData: FormData) {
  const hold = String(formData.get('hold')) === '1';
  const { user, order } = await guard(formData, hold ? 'hold' : 'unhold');
  const note = String(formData.get('note') ?? '').trim().slice(0, 500);
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { onHold: hold } });
    await tx.orderStatusHistory.create({
      data: { orderId: order.id, fromStatus: order.status, toStatus: order.status, changedById: user.id, note: hold ? `Beklemeye alındı${note ? `: ${note}` : ''}` : 'Beklemeden çıkarıldı' },
    });
  });
  await audit(hold ? 'ORDER_HOLD' : 'ORDER_UNHOLD', 'Order', order.id, user.id, { note });
  done(order.id, hold ? 'held' : 'unheld');
}

export async function setShipDateAction(formData: FormData) {
  const { user, order } = await guard(formData, 'set_ship_date');
  const d = parseDateOnly(String(formData.get('date') ?? ''));
  if (!d) redirect(err(order.id, 'Geçerli bir tarih seçin.'));
  await db.order.update({ where: { id: order.id }, data: { estimatedShipDate: d } });
  await audit('ORDER_SHIP_DATE', 'Order', order.id, user.id, { from: order.estimatedShipDate, to: d });
  done(order.id, 'ship_date');
}

export async function markProductionAction(formData: FormData) {
  const { user, order } = await guard(formData, 'mark_production');
  await db.$transaction((tx) => transition(tx, order, 'URETIMDE', user.id, 'Teklif müşteri adına onaylandı, üretime alındı'));
  done(order.id, 'production');
}

export async function markShippedAction(formData: FormData) {
  const { user, order } = await guard(formData, 'mark_shipped');
  await db.$transaction((tx) => transition(tx, order, 'YUKLENDI', user.id, null, { actualShipDate: new Date() }));
  done(order.id, 'shipped');
}

export async function archiveAction(formData: FormData) {
  const { user, order } = await guard(formData, 'archive');
  await db.$transaction((tx) => transition(tx, order, 'ARSIVLENDI', user.id));
  done(order.id, 'archived');
}

export async function cancelAction(formData: FormData) {
  const { user, order } = await guard(formData, 'cancel');
  const note = String(formData.get('note') ?? '').trim().slice(0, 500);
  if (!note) redirect(err(order.id, 'İptal nedeni yazın.'));
  await db.$transaction((tx) => transition(tx, order, 'IPTAL', user.id, note));
  done(order.id, 'cancelled');
}

// ---------------- Çizim ----------------
export async function startDrawingAction(formData: FormData) {
  const { user, order } = await guard(formData, 'start_drawing');
  await db.$transaction((tx) => transition(tx, order, 'CIZIM_YAPILIYOR', user.id, null, { assignedDrawer: { connect: { id: user.id } } }));
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
      await transition(tx, order, 'ONAY_BEKLIYOR', user.id, `Çizim v${version} onaya gönderildi`);
    });
  } catch (e) {
    await removeUpload(stored.storageKey);
    throw e;
  }
  done(order.id, 'drawing_uploaded');
}

// ---------------- Müşteri ----------------
export async function approveDrawingAction(formData: FormData) {
  const { user, order } = await guard(formData, 'approve_drawing');
  const latest = order.drawings[order.drawings.length - 1];
  await db.$transaction(async (tx) => {
    if (latest) await tx.drawing.update({ where: { id: latest.id }, data: { status: 'ONAYLANDI' } });
    await ensureOfferDraft(tx, order, user.id);
    await transition(tx, order, 'TEKLIF_HAZIRLANIYOR', user.id, `Çizim v${latest?.version ?? '?'} müşteri tarafından onaylandı`);
  });
  done(order.id, 'drawing_approved');
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
    await transition(tx, order, 'REVIZYON_ISTENDI', user.id, comment, { revisionCount: { increment: 1 } });
  });
  done(order.id, 'revision_requested');
}

export async function acceptOfferAction(formData: FormData) {
  const { user, order } = await guard(formData, 'accept_offer');
  await db.$transaction((tx) => transition(tx, order, 'URETIMDE', user.id, 'Teklif müşteri tarafından onaylandı'));
  done(order.id, 'offer_accepted');
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

// ---------------- Teklif tablosu ----------------
type LineInput = { description: string; poz: string | null; enMm: number | null; boyMm: number | null; adet: number; unit: string; unitPrice: string };

function readLines(formData: FormData): LineInput[] | string {
  const col = (k: string) => formData.getAll(k).map((v) => String(v).trim());
  const desc = col('l_desc'), poz = col('l_poz'), en = col('l_en'), boy = col('l_boy'), adet = col('l_adet'), unit = col('l_unit'), price = col('l_price');
  const lines: LineInput[] = [];
  for (let i = 0; i < desc.length; i++) {
    if (!desc[i] && !en[i] && !boy[i] && !price[i]) continue; // boş satır
    const toInt = (s: string) => (s ? Math.trunc(Number(s.replace(',', '.'))) : null);
    const e = toInt(en[i]), b = toInt(boy[i]), a = toInt(adet[i]) ?? 1;
    const p = Number((price[i] || '0').replace(',', '.'));
    if (!desc[i]) return `${i + 1}. satırda açıklama eksik.`;
    if ((e !== null && (e <= 0 || e > 10000)) || (b !== null && (b <= 0 || b > 10000))) return `${i + 1}. satırda ölçü 1–10000 mm arasında olmalı.`;
    if (!Number.isFinite(a) || a <= 0 || a > 100000) return `${i + 1}. satırda adet geçersiz.`;
    if (!Number.isFinite(p) || p < 0 || p > 1_000_000) return `${i + 1}. satırda fiyat geçersiz.`;
    lines.push({ description: desc[i].slice(0, 300), poz: poz[i] ? poz[i].slice(0, 60) : null, enMm: e, boyMm: b, adet: a, unit: unit[i] === 'adet' ? 'adet' : 'm2', unitPrice: p.toFixed(2) });
  }
  return lines;
}

/** intent: save | submit (satış) · save | approve | return (yönetici) */
export async function saveOfferAction(formData: FormData) {
  const user = await requireUser(['SATIS', 'ADMIN']);
  const order = await loadOrder(String(formData.get('id') ?? ''), user);
  const intent = String(formData.get('intent') ?? 'save');
  const acts = availableActions({ role: user.appRole, status: order.status, onHold: order.onHold });
  const canEdit = acts.includes('edit_offer') || acts.includes('approve_price');
  if (!canEdit) redirect(err(order.id, 'Teklif şu anda düzenlenemez.'));
  const offer = order.offers[0];
  if (!offer) redirect(err(order.id, 'Teklif bulunamadı.'));

  const lines = readLines(formData);
  if (typeof lines === 'string') redirect(err(order.id, lines));
  if ((intent === 'submit' || intent === 'approve') && lines.length === 0) redirect(err(order.id, 'Teklifte en az bir satır olmalı.'));
  if ((intent === 'submit' || intent === 'approve') && lines.some((l) => l.unit === 'm2' && (!l.enMm || !l.boyMm))) {
    redirect(err(order.id, 'm² ile fiyatlanan satırlarda en ve boy girilmeli.'));
  }
  const totals = offerTotals(lines);
  const isAdmin = user.appRole === 'ADMIN';
  const camEtiket = String(formData.get('camEtiket') ?? '').trim().slice(0, 120) || null;
  const sandikEtiket = String(formData.get('sandikEtiket') ?? '').trim().slice(0, 120) || null;
  const returnNote = String(formData.get('returnNote') ?? '').trim().slice(0, 1000);
  if (intent === 'return' && !returnNote) redirect(err(order.id, 'Satışa geri gönderme nedenini yazın.'));

  await db.$transaction(async (tx) => {
    await tx.offerLine.deleteMany({ where: { offerId: offer.id } });
    await tx.offerLine.createMany({ data: lines.map((l, i) => ({ ...l, offerId: offer.id, sortOrder: i })) });
    await tx.offer.update({ where: { id: offer.id }, data: { amount: totals.amount.toFixed(2) } });
    if (isAdmin) await tx.order.update({ where: { id: order.id }, data: { camEtiket, sandikEtiket } });

    if (intent === 'submit' && acts.includes('submit_offer')) {
      await tx.offer.update({ where: { id: offer.id }, data: { status: 'YONETIMDE' } });
      await transition(tx, order, 'FIYAT_BEKLIYOR', user.id, `Teklif yönetime gönderildi (${totals.amount.toFixed(2)} ${offer.currency})`);
    } else if (intent === 'approve' && acts.includes('approve_price')) {
      await tx.offer.update({ where: { id: offer.id }, data: { status: 'GONDERILDI' } });
      await tx.price.upsert({
        where: { orderId: order.id },
        create: { orderId: order.id, amount: totals.amount.toFixed(2), setById: user.id },
        update: { amount: totals.amount.toFixed(2), setById: user.id, setAt: new Date() },
      });
      await transition(tx, order, 'FIYATLANDI', user.id, `Fiyat onaylandı, teklif müşteriye gönderildi (${totals.amount.toFixed(2)} ${offer.currency})`);
    } else if (intent === 'return' && acts.includes('return_offer')) {
      await tx.offer.update({ where: { id: offer.id }, data: { status: 'HAZIRLANIYOR' } });
      await transition(tx, order, 'TEKLIF_HAZIRLANIYOR', user.id, `Satışa geri gönderildi: ${returnNote}`);
    }
  });
  await audit('OFFER_SAVED', 'Offer', offer.id, user.id, { intent, amount: totals.amount, lines: lines.length });
  done(order.id, intent === 'save' ? 'offer_saved' : `offer_${intent}`);
}
