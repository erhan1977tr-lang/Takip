'use server';

// Sipariş sayfasının işlemleri. Kurallar ve kayıt server/orders/transitions.js'te (runOrderAction):
// burada yalnızca oturum, form okuma, dosya kaydı ve kullanıcıya gösterilecek mesaj var.
import fs from 'node:fs/promises';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { type CurrentUser, requirePermission } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT, type Dict, type T } from '@/lib/i18n';
import { fileProblemText, offerProblemTexts, workflowErrorText } from '@/lib/labels';
import { loadOrder } from '@/lib/orders';
import { actorOf } from '@/lib/actor';
import { audit } from '@/lib/audit';
import { filesFrom, resolveKey } from '@/lib/storage';
import { readXlsx } from '@/server/files/xlsx.js';
import { isXls, readXls } from '@/server/files/xls.js';
import { IMPORT_MAX_COLS, IMPORT_MAX_ROWS } from '@/server/orders/excel-import.js';
import { discardFiles, storeFiles, type StoredUpload } from '@/lib/uploads';
import { atOfferPrice, availableActions, drawingFlags, fileProblem, offerProblems, offerTotals, parseDateOnly } from '@/server/orders/rules.js';
import { runOrderAction, WorkflowError } from '@/server/orders/transitions.js';

const back = (id: string, q: string) => `/siparisler/${id}?${q}`;
const err = (id: string, msg: string) => back(id, `error=${encodeURIComponent(msg)}`);
const orderIdOf = (formData: FormData) => String(formData.get('id') ?? '');
/** Formda sayfanın gösterdiği sipariş sürümü varsa (teklif düzenleyici) aynı anda yapılan değişiklik yakalanır. */
const expectedVersion = (formData: FormData) => {
  const v = formData.get('v');
  return v === null || v === '' ? undefined : Number(v);
};

function done(id: string, ok: string): never {
  revalidatePath('/siparisler');
  revalidatePath('/teklifler');
  revalidatePath('/yuklemeler');
  revalidatePath(`/siparisler/${id}`);
  redirect(back(id, `ok=${ok}`));
}

/**
 * İşlemi çalıştırır; iş akışı hatasını kullanıcının dilinde mesajla sayfaya döndürür.
 * @returns işlemin sonucu (ör. otomatik üretime geçti mi)
 */
async function act(
  user: CurrentUser, orderId: string, action: string, payload: Record<string, unknown> = {},
): Promise<{ produced?: boolean; drawingId?: string; version?: number; storageKey?: string } | null> {
  try {
    const res = await runOrderAction(db, { orderId, action, actor: await actorOf(user), payload });
    return res.result;
  } catch (e) {
    if (e instanceof WorkflowError) {
      if (e.code === 'NOT_FOUND') notFound();
      const { t, m } = await getT();
      // Fiyatı eksik satırlar: hangi ürün / işlem olduğu yazılır
      const problems = (e.details as { problems?: unknown[] } | undefined)?.problems;
      if (e.code === 'SALES_PRICE_MISSING' && problems?.length) redirect(err(orderId, `${t('order.errors.salesPriceMissing')} ${offerProblemTexts(m, problems).join(' ')}`));
      redirect(err(orderId, workflowErrorText(t, e.code, e.details as Record<string, unknown>)));
    }
    throw e;
  }
}

/** Dosya kaydetmeden önce ön kontrol (asıl kontrol yine işlemin kendisinde yapılır). */
async function ensureAllowed(user: CurrentUser, orderId: string, action: string) {
  const order = await loadOrder(orderId, user);
  const acts = availableActions({
    role: user.appRole, status: order.status, onHold: order.onHold, canApprove: user.canApprove,
    drawing: order.drawingTrack, offer: order.offers[0]?.status ?? null, ...drawingFlags(order),
  });
  if (!acts.includes(action)) {
    const { t } = await getT();
    redirect(err(order.id, t('order.errors.notAllowed')));
  }
  return order;
}

/** Basit işlemler: yalnızca sipariş kimliği (ve varsa not) */
async function simple(formData: FormData, action: string, ok: string, payload: Record<string, unknown> = {}) {
  const user = await requirePermission('ORDER_VIEW');
  const id = orderIdOf(formData);
  await act(user, id, action, payload);
  done(id, ok);
}

// ---------------- Satış kararı ----------------
/** Çizim gerekli: çizim ekibine yönlendir. Teklif hattı da açılır, satış teklifi paralel yazabilir. */
export async function sendToDrawingAction(formData: FormData) {
  await simple(formData, 'send_to_drawing', 'to_drawing');
}

/** Çizim gerekmiyor: doğrudan teklife geç. */
export async function noDrawingAction(formData: FormData) {
  await simple(formData, 'no_drawing', 'to_offer');
}

/** "Çizime Göndermeyi Geri Al" — çizim müşteriye gitmeden önce. Teklif taslağı korunur. */
export async function undoDrawingAction(formData: FormData) {
  await simple(formData, 'undo_drawing', 'undo_drawing');
}

/** "Teklife Göndermeyi Geri Al" */
export async function undoNoDrawingAction(formData: FormData) {
  await simple(formData, 'undo_no_drawing', 'undo_no_drawing');
}

export async function holdAction(formData: FormData) {
  const user = await requirePermission('ORDER_VIEW');
  const id = orderIdOf(formData);
  const hold = String(formData.get('hold')) === '1';
  const note = String(formData.get('note') ?? '').trim().slice(0, 500);
  const res = await act(user, id, hold ? 'hold' : 'unhold', { note });
  done(id, hold ? 'held' : res?.produced ? 'unheld_production' : 'unheld');
}

export async function setShipDateAction(formData: FormData) {
  const user = await requirePermission('ORDER_VIEW');
  const id = orderIdOf(formData);
  const d = parseDateOnly(String(formData.get('date') ?? ''));
  if (!d) {
    const { t } = await getT();
    redirect(err(id, t('order.errors.invalidDate')));
  }
  await act(user, id, 'set_ship_date', { date: d });
  done(id, 'ship_date');
}

export async function markShippedAction(formData: FormData) {
  await simple(formData, 'mark_shipped', 'shipped');
}

export async function archiveAction(formData: FormData) {
  await simple(formData, 'archive', 'archived');
}

export async function cancelAction(formData: FormData) {
  const note = String(formData.get('note') ?? '').trim().slice(0, 500);
  await simple(formData, 'cancel', 'cancelled', { note });
}

// ---------------- Çizim hattı ----------------
export async function startDrawingAction(formData: FormData) {
  await simple(formData, 'start_drawing', 'drawing_started');
}

/**
 * Çizim dosyaları taslağa yüklenir (birden çok dosya). Her dosya kaydedilmeden önce içerik kontrolü ve virüs
 * taramasından geçer. Müşteriye gönderim ayrı adımdır (sendDrawingAction).
 */
export async function uploadDrawingAction(formData: FormData) {
  const user = await requirePermission('ORDER_VIEW');
  const id = orderIdOf(formData);
  const { t } = await getT();
  const files = filesFrom(formData, 'files');
  if (!files.length) redirect(err(id, t('order.errors.drawingFile')));
  for (const f of files) {
    const problem = fileProblemText(t, fileProblem(f.name, f.size));
    if (problem) redirect(err(id, problem));
  }
  const noteCustomer = String(formData.get('noteCustomer') ?? '').trim().slice(0, 2000);
  const noteInternal = String(formData.get('noteInternal') ?? '').trim().slice(0, 2000);
  // Yetki ve durum kontrolü dosya kaydedilmeden önce de yapılır (boşuna tarama/yazma olmasın)
  await ensureAllowed(user, id, 'upload_drawing');
  const stored = await storeFiles(files, { userId: user.id, orderId: id });
  if (!stored.ok) redirect(err(id, fileProblemText(t, stored.problem)!));
  try {
    await act(user, id, 'upload_drawing', {
      files: stored.stored,
      ...(noteCustomer ? { noteCustomer } : {}),
      ...(noteInternal ? { noteInternal } : {}),
    });
  } catch (e) {
    await discardFiles(stored.stored);
    throw e;
  }
  done(id, 'drawing_uploaded');
}

/** Taslaktaki dosyayı çıkarır (müşteriye gönderilmemiş sürüm). */
export async function removeDrawingFileAction(formData: FormData) {
  const user = await requirePermission('ORDER_VIEW');
  const id = orderIdOf(formData);
  const res = await act(user, id, 'remove_drawing_file', { fileId: String(formData.get('fileId') ?? '') });
  if (res?.storageKey) await discardFiles([{ storageKey: res.storageKey }]);
  done(id, 'drawing_file_removed');
}

/**
 * İkinci adım: taslak müşteriye gönderilir (ekranda "emin misiniz?" onayı istenir). Yalnızca "Kontrol Et" ekranından:
 * o ekranın verdiği kontrol kanıtı (review) işlemde doğrulanır (server/orders/review.js); kanıtsız istek reddedilir.
 */
export async function sendDrawingAction(formData: FormData) {
  const drawingId = String(formData.get('drawingId') ?? '') || undefined;
  const review = String(formData.get('review') ?? '').slice(0, 200);
  await simple(formData, 'send_drawing', 'drawing_sent', { drawingId, review });
}

export async function withdrawDrawingAction(formData: FormData) {
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 1000);
  await simple(formData, 'withdraw_drawing', 'drawing_withdrawn', { reason });
}

/** Müşterinin tek onayı: çizim onayı. Ekranda gördüğü sürüm (drawingId) hâlâ son sürüm olmalı. */
export async function approveDrawingAction(formData: FormData) {
  const user = await requirePermission('ORDER_VIEW');
  const id = orderIdOf(formData);
  const drawingId = String(formData.get('drawingId') ?? '') || undefined;
  const res = await act(user, id, 'approve_drawing', { drawingId });
  done(id, res?.produced ? 'drawing_approved_production' : 'drawing_approved');
}

export async function requestRevisionAction(formData: FormData) {
  const comment = String(formData.get('comment') ?? '').trim().slice(0, 2000);
  const drawingId = String(formData.get('drawingId') ?? '') || undefined;
  // Çizim üstü işaretler (cizim/[drawingId] sayfasındaki görüntüleyici): JSON; sunucuda doğrulanır (server/orders/annotations.js)
  const annotations = String(formData.get('annotations') ?? '').slice(0, 400_000);
  await simple(formData, 'request_revision', 'revision_requested', { comment, drawingId, annotations });
}

// ---------------- Sandıklar ----------------
/** Sandık ölçü ve ağırlıkları (gerçek kayıt). Boş bırakılan satırlar silinir. */
// ---------------- Ortak ----------------
/** Dosya eklemek bir durum değişikliği değildir: yetki ve durum kontrolünden sonra dosyalar kaydedilir. */
export async function addFilesAction(formData: FormData) {
  const user = await requirePermission('FILE_UPLOAD');
  const order = await ensureAllowed(user, orderIdOf(formData), 'add_file');
  const { t } = await getT();
  const files = filesFrom(formData, 'files');
  if (!files.length) redirect(err(order.id, t('order.errors.noFiles')));
  for (const f of files) {
    const p = fileProblemText(t, fileProblem(f.name, f.size));
    if (p) redirect(err(order.id, p));
  }
  const stored = await storeFiles(files, { userId: user.id, orderId: order.id });
  if (!stored.ok) redirect(err(order.id, fileProblemText(t, stored.problem)!));
  const kind = userCan(user, 'FILE_INTERNAL_VIEW') ? ('INTERNAL' as const) : ('CUSTOMER' as const);
  try {
    await db.orderFile.createMany({
      data: stored.stored.map((s: StoredUpload) => ({ ...s, orderId: order.id, uploadedById: user.id, kind })),
    });
  } catch (e) {
    await discardFiles(stored.stored);
    throw e;
  }
  await audit('ORDER_FILES_ADDED', 'Order', order.id, user.id, { count: stored.stored.length, names: stored.stored.map((s) => s.name) });
  done(order.id, 'files_added');
}

export async function addNoteAction(formData: FormData) {
  const user = await requirePermission('NOTE_ADD');
  const order = await loadOrder(orderIdOf(formData), user);
  const { t } = await getT();
  const text = String(formData.get('text') ?? '').trim().slice(0, 4000);
  if (!text) redirect(err(order.id, t('order.errors.emptyNote')));
  const internal = userCan(user, 'NOTE_INTERNAL_VIEW') && formData.get('internal') === 'on';
  await db.orderNote.create({ data: { orderId: order.id, userId: user.id, text, internal } });
  done(order.id, 'note_added');
}

// ---------------- Teklif hattı ----------------
/** id: mevcut satır (boş → yeni) · offerPrice: müşteri fiyatı (yalnızca yönetici formunda; satış formunda undefined) */
type LineInput = { id: string | null; description: string; poz: string | null; enMm: number | null; boyMm: number | null; adet: number; unit: string; unitPrice: string; kind: string; free: boolean; offerPrice?: string | null };

function readLines(formData: FormData, t: T): LineInput[] | string {
  const col = (k: string) => formData.getAll(k).map((v) => String(v).trim());
  const desc = col('l_desc'), poz = col('l_poz'), en = col('l_en'), boy = col('l_boy'), adet = col('l_adet'), unit = col('l_unit'), price = col('l_price');
  const kinds = col('l_kind'), free = col('l_free'), ids = col('l_id'), oprice = col('l_oprice');
  const withOffer = oprice.length > 0;
  const lines: LineInput[] = [];
  for (let i = 0; i < desc.length; i++) {
    const kind = kinds[i] === 'CNC' || kinds[i] === 'DELIK' ? kinds[i] : 'CAM';
    const sub = kind !== 'CAM';
    if (!sub && !desc[i] && !en[i] && !boy[i] && !price[i] && !oprice[i]) continue; // boş cam satırı
    const toInt = (s: string) => (s ? Math.trunc(Number(s.replace(',', '.'))) : null);
    const e = toInt(en[i]), b = toInt(boy[i]), a = toInt(adet[i]) ?? 1;
    const p = Number((price[i] || '0').replace(',', '.'));
    // Açıklama yalnızca cam satırında zorunlu; CNC / delik satırının açıklaması boş kalabilir (ekranda tür rozeti görünür)
    if (!sub && !desc[i]) return t('order.errors.lineDescription', { n: i + 1 });
    if ((e !== null && (e <= 0 || e > 10000)) || (b !== null && (b <= 0 || b > 10000))) return t('order.errors.lineDims', { n: i + 1 });
    if (!Number.isFinite(a) || a <= 0 || a > 100000) return t('order.errors.lineQty', { n: i + 1 });
    if (!Number.isFinite(p) || p < 0 || p > 1_000_000) return t('order.errors.linePrice', { n: i + 1 });
    const op = withOffer && oprice[i] ? Number(oprice[i].replace(',', '.')) : null;
    if (op !== null && (!Number.isFinite(op) || op < 0 || op > 1_000_000)) return t('order.errors.linePrice', { n: i + 1 });
    const isFree = free[i] === '1';
    lines.push({
      description: desc[i].slice(0, 300), poz: poz[i] ? poz[i].slice(0, 60) : null, enMm: e, boyMm: b, adet: a,
      unit: sub || unit[i] === 'adet' ? 'adet' : 'm2', unitPrice: (isFree ? 0 : p).toFixed(2), kind, free: isFree,
      id: ids[i] || null,
      ...(withOffer ? { offerPrice: isFree ? '0.00' : op === null ? null : op.toFixed(2) } : {}),
    });
  }
  return lines;
}

/** Müşteriye gidecek teklif için eksik ya da null. */
function finalProblem(lines: LineInput[], m: Dict): string | null {
  const p = offerProblems(lines);
  return p.length ? offerProblemTexts(m, p).join(' ') : null;
}

const labels = (formData: FormData) => ({
  camEtiket: String(formData.get('camEtiket') ?? '').trim().slice(0, 120) || null,
  sandikEtiket: String(formData.get('sandikEtiket') ?? '').trim().slice(0, 120) || null,
});

const INTENT_ACTION: Record<string, string> = {
  save: 'save_offer', submit: 'submit_offer', approve: 'approve_offer', return: 'return_offer', update: 'update_offer',
};

/**
 * intent: save | submit (satış) · save | approve | return (yönetici, fiyat onayında)
 *         update (yönetici, teklif müşterideyken: yeni sürüm hemen müşteriye gider)
 */
export async function saveOfferAction(formData: FormData) {
  const user = await requirePermission('OFFER_PREPARE');
  const id = orderIdOf(formData);
  const intent = String(formData.get('intent') ?? 'save');
  const action = INTENT_ACTION[intent];
  const { t, m } = await getT();
  if (!action) redirect(err(id, t('order.errors.offerNotEditable')));

  const lines = readLines(formData, t);
  if (typeof lines === 'string') redirect(err(id, lines));
  // Satış gönderirken satış fiyatları, yönetici müşteriye gönderirken müşteri fiyatları eksiksiz olmalı (karar 4)
  const problem = intent === 'submit' ? finalProblem(lines, m)
    : intent === 'approve' || intent === 'update' ? finalProblem(atOfferPrice(lines) as LineInput[], m) : null;
  if (problem) redirect(err(id, problem));
  const amount = offerTotals(lines).amount.toFixed(2);
  const returnNote = String(formData.get('returnNote') ?? '').trim().slice(0, 1000);
  const note = String(formData.get('updateNote') ?? '').trim().slice(0, 1000);

  const res = await act(user, id, action, {
    lines, amount, returnNote, note, labels: labels(formData), expectedVersion: expectedVersion(formData),
  });
  if (intent === 'update') done(id, 'offer_updated');
  done(id, intent === 'save' ? 'offer_saved' : res?.produced ? `offer_${intent}_production` : `offer_${intent}`);
}

/** Yönetici, teklif gönderildikten sonra gelen çizimi kontrol etti ve teklifte değişiklik gerekmiyor. */
export async function checkOfferAction(formData: FormData) {
  await simple(formData, 'check_offer', 'offer_checked');
}

/**
 * Yönetici: müşteri bu siparişin teklifini Excel olarak indirebilir mi (Order.customerExcel). İş akışı durumu değil,
 * sipariş ayarıdır; denetim kaydına yazılır. İndirme izni ayrıca sunucuda (teklif/route.ts) denetlenir.
 */
export async function setCustomerExcelAction(formData: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = orderIdOf(formData);
  const allow = String(formData.get('allow')) === '1';
  const order = await db.order.findFirst({ where: { id, orderTypeCode: 'GLASS_ORDER' }, select: { id: true, customerExcel: true } });
  if (!order) notFound();
  if (order.customerExcel !== allow) {
    await db.order.update({ where: { id }, data: { customerExcel: allow } });
    await audit('OFFER_EXCEL_PERMISSION', 'Order', id, user.id, { before: order.customerExcel, after: allow });
  }
  revalidatePath(`/siparisler/${id}`);
  redirect(back(id, 'ok=customer_excel') + '#teklif');
}

/**
 * Satış: siparişe yüklenmiş Excel'in (.xls / .xlsx) satırları — teklif tablosuna aktarma ön izlemesi için (OfferEditor →
 * ExcelImport). Yalnızca okur; hiçbir şey kaydetmez. Dosya bu siparişin olmalı ve antivirüste temiz/beklemede olmalı.
 */
export async function readOfferExcelAction(orderId: string, fileId: string): Promise<{ ok: true; rows: string[][] } | { ok: false; error: string }> {
  const user = await requirePermission('OFFER_PREPARE');
  const { t } = await getT();
  const order = await loadOrder(orderId, user);
  const file = order.files.find((f) => f.id === fileId && /\.xlsx?$/i.test(f.name) && f.scanStatus !== 'INFECTED');
  if (!file) return { ok: false, error: t('offer.import.noFile') };
  try {
    const full = resolveKey(file.storageKey);
    if (!full) return { ok: false, error: t('offer.import.noFile') };
    const buf = await fs.readFile(full);
    // İçeriğe göre: eski .xls (OLE2) ya da .xlsx (zip; .xls adıyla kaydedilmiş .xlsx de olur)
    const { rows } = isXls(buf) ? readXls(buf) : readXlsx(buf);
    const text = (v: unknown) => (v == null ? '' : String(v));
    return { ok: true, rows: rows.slice(0, IMPORT_MAX_ROWS).map((r) => r.slice(0, IMPORT_MAX_COLS).map(text)) };
  } catch {
    return { ok: false, error: t('offer.import.unreadable') };
  }
}
