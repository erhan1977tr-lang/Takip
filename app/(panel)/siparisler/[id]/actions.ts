'use server';

// Sipariş sayfasının işlemleri. Kurallar ve kayıt server/orders/transitions.js'te (runOrderAction):
// burada yalnızca oturum, form okuma, dosya kaydı ve kullanıcıya gösterilecek mesaj var.
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { type CurrentUser, requirePermission, requireUser } from '@/lib/auth/session';
import { userCan } from '@/lib/permissions';
import { getT, type Dict, type T } from '@/lib/i18n';
import { fileProblemText, lockReasonText, offerProblemTexts, workflowErrorText } from '@/lib/labels';
import { loadOrder } from '@/lib/orders';
import { actorOf } from '@/lib/actor';
import { audit } from '@/lib/audit';
import { filesFrom, resolveKey } from '@/lib/storage';
import { readOfferExcel } from '@/server/orders/excel-file.js';
import { discardFiles, storeFiles, type StoredUpload } from '@/lib/uploads';
import { atOfferPrice, availableActions, drawingFlags, fileProblem, isSplitKey, offerProblems, offerTotals, parseDateOnly } from '@/server/orders/rules.js';
import { runOrderAction, WorkflowError } from '@/server/orders/transitions.js';
import { addNote, retryDrawingTranslation, retryNoteTranslation, translateDrawingNote, translateRevision } from '@/server/notes/translation.js';
import { deliverInAppNow } from '@/lib/notifications';
import { revisionNote } from '@/server/orders/revision-note.js';
import { hasCustomerDrawingFile } from '@/server/orders/dwg-review.js';
import { markNotesRead } from '@/server/notes/unread.js';

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
 * İşlemi çalıştırır; iş akışı hatasını kullanıcının dilinde mesajla sayfaya döndürür. İşlem kaydedildikten sonra
 * yazdığı olayların uygulama içi bildirimleri hemen dağıtılır (işçiyi beklemez — Paket 3; işçi yedektir).
 * @returns işlemin sonucu (ör. otomatik üretime geçti mi)
 */
async function act(
  user: CurrentUser, orderId: string, action: string, payload: Record<string, unknown> = {},
): Promise<{ produced?: boolean; drawingId?: string; version?: number; storageKey?: string; revisionId?: string } | null> {
  try {
    const res = await runOrderAction(db, { orderId, action, actor: await actorOf(user), payload });
    await deliverInAppNow(res.outboxIds);
    return res.result;
  } catch (e) {
    if (e instanceof WorkflowError) {
      if (e.code === 'NOT_FOUND') notFound();
      const { t, m } = await getT();
      // Fiyatı eksik satırlar: hangi ürün / işlem olduğu yazılır
      const problems = (e.details as { problems?: unknown[] } | undefined)?.problems;
      if (e.code === 'SALES_PRICE_MISSING' && problems?.length) redirect(err(orderId, `${t('order.errors.salesPriceMissing')} ${offerProblemTexts(m, problems).join(' ')}`));
      // Mali kilit (Paket 4): fiyat neden değiştirilemez — belge / onaylı yükleme (sabit metin + belge no / gün)
      const reasons = (e.details as { reasons?: { code: string; ref?: string | null; kind?: string | null }[] } | undefined)?.reasons;
      if (e.code === 'PRICE_LOCKED') redirect(err(orderId, [t('order.errors.priceLocked'), ...(reasons ?? []).map((r) => lockReasonText(t, r))].join(' · ')) + '#teklif');
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
    drawing: order.drawingTrack, offer: order.offers[0]?.status ?? null, ...drawingFlags(order), orderType: order.orderTypeCode,
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
 * Gönderim kaydedildikten SONRA sürümün müşteri notu bir kez Romence'ye çevrilir ve sürüme yazılır (translateDrawingNote,
 * karar 168): not müşteriye gittiği anda kesinleşir; çeviri hatası gönderimi bozmaz, sayfa açılışı çeviri yapmaz.
 */
export async function sendDrawingAction(formData: FormData) {
  const user = await requirePermission('ORDER_VIEW');
  const id = orderIdOf(formData);
  const drawingId = String(formData.get('drawingId') ?? '') || undefined;
  const review = String(formData.get('review') ?? '').slice(0, 200);
  const res = await act(user, id, 'send_drawing', { drawingId, review });
  if (res?.drawingId) {
    await translateDrawingNote(db, { drawingId: res.drawingId, orderId: id, actor: await actorOf(user) })
      .catch((e: unknown) => console.warn('[sürüm notu çevirisi] yapılamadı', res.drawingId, String((e as { code?: unknown })?.code ?? 'ERROR')));
  }
  done(id, 'drawing_sent');
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

/**
 * Müşterinin revizyon talebi (karar 162–163). Not NUMARALI maddelerdir ("item" alanları, formdaki sırasıyla — maddesiz
 * eski istekte "comment" tek madde sayılır): server/orders/revision-note.js tek metne çevirir ("1. …\n2. …"); iş akışı
 * (request_revision) değişmedi. Talep kaydedildikten SONRA notu bir kez çevrilir ve talebin satırına yazılır
 * (translateRevision); çeviri hatası talebi bozmaz, sayfa açılışı / yenileme çeviri yapmaz.
 */
export async function requestRevisionAction(formData: FormData) {
  const user = await requirePermission('ORDER_VIEW');
  const id = orderIdOf(formData);
  const drawingId = String(formData.get('drawingId') ?? '') || undefined;
  const items = formData.getAll('item');
  const note = revisionNote(items.length ? items : [formData.get('comment')]);
  if (!note.ok) {
    const { t } = await getT();
    redirect(err(id, t(note.code === 'TOO_MANY' ? 'order.errors.revisionTooMany' : note.code === 'TOO_LONG' ? 'order.errors.revisionTooLong' : 'order.errors.revisionEmpty')));
  }
  // Çizim üstü işaretler (eski istemciler): JSON; sunucuda doğrulanır (server/orders/annotations.js). Müşteri ekranında
  // işaretleme yok (karar 162) — alan gelmezse talep işaretsizdir.
  const annotations = String(formData.get('annotations') ?? '').slice(0, 400_000);
  const res = await act(user, id, 'request_revision', { comment: note.text, drawingId, annotations });
  if (res?.revisionId) {
    // Talep kayıtlıdır: çeviri adımındaki beklenmedik hata (veritabanı) talebi bozmaz, yalnızca günlüğe güvenli kod yazılır
    await translateRevision(db, { revisionId: res.revisionId, orderId: id, actor: await actorOf(user) })
      .catch((e: unknown) => console.warn('[revizyon çevirisi] yapılamadı', res.revisionId, String((e as { code?: unknown })?.code ?? 'ERROR')));
  }
  done(id, 'revision_requested');
}

/**
 * Çizim alanındaki çevrilemeyen notun (müşterinin revizyon talebi, çizimcinin "hatalı" açıklaması ya da sürümün müşteri
 * notu) çevirisini bir kez daha ister — yalnızca iç ekip, açık istekle (karar 168; kural server/notes/translation.js →
 * retryDrawingTranslation: yalnızca başarısız / yarıda kalmış çeviri, eşzamanlı isteklerde sağlayıcıya tek istek).
 */
export async function retryDrawingTranslationAction(formData: FormData) {
  const user = await requirePermission('NOTE_ADD');
  const order = await loadOrder(orderIdOf(formData), user);
  const { t } = await getT();
  const target = String(formData.get('target') ?? '') === 'drawing' ? 'drawing' : 'revision';
  const r = await retryDrawingTranslation(db, { target, id: String(formData.get('targetId') ?? '').slice(0, 64), orderId: order.id, actor: await actorOf(user) });
  if (!r.ok) {
    redirect(err(order.id, t(r.code === 'DISABLED' ? 'order.notes.translation.disabled'
      : r.code === 'RATE_LIMIT' ? 'order.notes.translation.retryLimit' : 'order.errors.notAllowed')) + '#cizim');
  }
  revalidatePath(`/siparisler/${order.id}`);
  if (r.translation === 'FAILED') redirect(err(order.id, t('order.notes.translation.retryFailed')) + '#cizim');
  redirect(back(order.id, 'ok=note_translated') + '#cizim');
}

// ---------------- Müşterinin DWG/DXF çizimi (karar 167) ----------------
// Çizimcinin üç kararı birbirinden ayrı sunucu işlemleridir (dwg_ready / dwg_faulty / dwg_update — kural ve kayıt
// server/orders/transitions.js, "karar bekleniyor mu" server/orders/dwg-review.js). "DXF/DWG olarak gelen çizimler"
// listesi ve sipariş sayfası aynı işlemleri çağırır. Yetki: çizim yetkisi (DRAWING_WORK) burada, durum / sıra işlemde.

/** A. Üretime Hazır: müşteri onayı beklenmez; sipariş "Müşteriden onaylı çizimler"e geçer (koşullar tamamsa üretime). */
export async function dwgReadyAction(formData: FormData) {
  const user = await requirePermission('DRAWING_WORK');
  const id = orderIdOf(formData);
  const res = await act(user, id, 'dwg_ready');
  done(id, res?.produced ? 'dwg_ready_production' : 'dwg_ready');
}

/**
 * B. Çizim Hatalı: açıklama zorunlu; müşteriye bildirim. Karar kaydedildikten SONRA açıklama bir kez Romence'ye çevrilir
 * (translateRevision — çeviri hatası kararı bozmaz).
 */
export async function dwgFaultyAction(formData: FormData) {
  const user = await requirePermission('DRAWING_WORK');
  const id = orderIdOf(formData);
  const res = await act(user, id, 'dwg_faulty', { note: String(formData.get('note') ?? '').slice(0, 4000) });
  if (res?.revisionId) {
    await translateRevision(db, { revisionId: res.revisionId, orderId: id, actor: await actorOf(user) })
      .catch((e: unknown) => console.warn('[hatalı çizim açıklaması çevirisi] yapılamadı', res.revisionId, String((e as { code?: unknown })?.code ?? 'ERROR')));
  }
  done(id, 'dwg_faulty');
}

/** C. Çizimi Güncelle: orijinal dosya korunur; çizimci yeni çizimi olağan akışla yükler (taslak → Kontrol Et → gönder). */
export async function dwgUpdateAction(formData: FormData) {
  const user = await requirePermission('DRAWING_WORK');
  const id = orderIdOf(formData);
  await act(user, id, 'dwg_update');
  revalidatePath('/siparisler');
  revalidatePath(`/siparisler/${id}`);
  redirect(back(id, 'ok=dwg_update') + '#cizim-dosyalari');
}

/**
 * Müşteri: hatalı bulunan çiziminin yerine düzeltilmiş dosya gönderir (mevcut siparişe; en az bir DWG / DXF). Dosyalar
 * kaydedilmeden önce yetki ve durum denetlenir; içerik denetimi + virüs taraması storeFiles'ta; işlem kaydedilemezse
 * saklanan dosyalar silinir.
 */
export async function dwgResubmitAction(formData: FormData) {
  const user = await requirePermission('DRAWING_APPROVE');
  const id = orderIdOf(formData);
  const { t } = await getT();
  const files = filesFrom(formData, 'files');
  if (!files.length || !hasCustomerDrawingFile(files)) redirect(err(id, t('order.errors.dwgFile')) + '#cizim-hatali');
  for (const f of files) {
    const problem = fileProblemText(t, fileProblem(f.name, f.size));
    if (problem) redirect(err(id, problem) + '#cizim-hatali');
  }
  await ensureAllowed(user, id, 'dwg_resubmit');
  const stored = await storeFiles(files, { userId: user.id, orderId: id });
  if (!stored.ok) redirect(err(id, fileProblemText(t, stored.problem)!) + '#cizim-hatali');
  try {
    await act(user, id, 'dwg_resubmit', { files: stored.stored });
  } catch (e) {
    await discardFiles(stored.stored);
    throw e;
  }
  done(id, 'dwg_resubmitted');
}

/** Müşteri: hatalı bulunan çizim yerine fabrikanın çizmesini ister — sipariş olağan çizim kuyruğuna döner. */
export async function dwgRequestDrawingAction(formData: FormData) {
  const user = await requirePermission('DRAWING_APPROVE');
  const id = orderIdOf(formData);
  await act(user, id, 'dwg_request_drawing');
  done(id, 'dwg_factory_requested');
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
  // Not her durumda kaydedilir; müşteriye açık not (çeviri açıksa) bir kez çevrilir ve sonucu saklanır (karar 127).
  // Çeviri başarısız olsa da not durur — kural ve görünürlük server/notes/translation.js'te.
  // requestKey: formun tek kullanımlık anahtarı — çift tıklama / yeniden gönderim ikinci notu ve ikinci bildirimi yazmaz (karar 199)
  const r = await addNote(db, {
    orderId: order.id, actor: await actorOf(user), text: formData.get('text'), internal: formData.get('internal') === 'on', requestKey: formData.get('requestKey'),
  });
  // Sınırlar (karar 147) addNote içinde, sunucuda uygulanır: not hızı (RATE_LIMIT) ve siparişteki toplam not (ORDER_LIMIT)
  if (!r.ok) {
    redirect(err(order.id, t(r.code === 'EMPTY' ? 'order.errors.emptyNote'
      : r.code === 'RATE_LIMIT' ? 'order.errors.noteRateLimit'
        : r.code === 'ORDER_LIMIT' ? 'order.errors.noteOrderLimit' : 'order.errors.notAllowed')));
  }
  // Mesaj bildirimi (zil) hemen dağıtılır; işçi yedektir (aynı dağıtıcı, aynı tekrar engeli)
  if (r.outboxId) await deliverInAppNow([r.outboxId]);
  done(order.id, 'note_added');
}

/**
 * Sipariş sayfası açıldı: bu siparişin mesajları, ekranda gösterilen en yeni nota kadar "okundu" (karar 199). Yalnızca
 * oturumdaki kullanıcının kendi okunma kaydı; sipariş kapsamda değilse hiçbir şey yazılmaz. Oturumu uzatmaz.
 * @returns okunma kaydı / zil değişti mi (istemci yalnızca o zaman menüdeki sayacı tazeler)
 */
export async function markNotesReadAction(orderId: string, upTo: string | null): Promise<boolean> {
  const user = await requireUser();
  const r = await markNotesRead(db, { user, orderId: String(orderId ?? ''), upTo: typeof upTo === 'string' ? upTo : null });
  return r.ok && r.changed;
}

/** Çevrilemeyen notun çevirisini bir kez daha ister (yalnızca iç ekip; kural server/notes/translation.js) */
export async function retryNoteTranslationAction(formData: FormData) {
  const user = await requirePermission('NOTE_ADD');
  const order = await loadOrder(orderIdOf(formData), user);
  const { t } = await getT();
  const r = await retryNoteTranslation(db, { noteId: String(formData.get('noteId') ?? ''), orderId: order.id, actor: await actorOf(user) });
  if (!r.ok) {
    redirect(err(order.id, t(r.code === 'DISABLED' ? 'order.notes.translation.disabled'
      : r.code === 'RATE_LIMIT' ? 'order.notes.translation.retryLimit' : 'order.errors.notAllowed')) + '#notlar');
  }
  revalidatePath(`/siparisler/${order.id}`);
  if (r.translation === 'FAILED') redirect(err(order.id, t('order.notes.translation.retryFailed')) + '#notlar');
  redirect(back(order.id, 'ok=note_translated') + '#notlar');
}

// ---------------- Teklif hattı ----------------
/**
 * id: mevcut satır (boş → yeni) · offerPrice: müşteri fiyatı (yalnızca yönetici formunda; satış formunda undefined)
 * from: işlem eklemek için ayrılan tek camın kaynağı (aynı teklifin mevcut satırı — fiyatları ondan taşınır, karar 113)
 * splitGroup: ayrılmış cam grubunun anahtarı (karar 114) — sunucu grubu doğrular ve sırayı (pieceBase) kendisi hesaplar
 */
type LineInput = { id: string | null; from?: string | null; splitGroup?: string | null; description: string; poz: string | null; enMm: number | null; boyMm: number | null; adet: number; unit: string; unitPrice: string; kind: string; free: boolean; crateFee?: boolean; offerPrice?: string | null };

function readLines(formData: FormData, t: T): LineInput[] | string {
  const col = (k: string) => formData.getAll(k).map((v) => String(v).trim());
  const desc = col('l_desc'), poz = col('l_poz'), en = col('l_en'), boy = col('l_boy'), adet = col('l_adet'), unit = col('l_unit'), price = col('l_price');
  const kinds = col('l_kind'), free = col('l_free'), ids = col('l_id'), oprice = col('l_oprice'), from = col('l_from'), group = col('l_group'), crate = col('l_crate');
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
    // Sandık bedeli (Paket 4): adetli, ölçüsüz cam türü satır. İşaret yalnızca yöneticinin kaydında geçerlidir — satışın
    // kaydında sunucu yok sayar (server/orders/transitions.js → salesInput)
    const isCrate = !sub && crate[i] === '1';
    lines.push({
      description: desc[i].slice(0, 300), poz: poz[i] ? poz[i].slice(0, 60) : null, enMm: isCrate ? null : e, boyMm: isCrate ? null : b, adet: a,
      unit: sub || isCrate || unit[i] === 'adet' ? 'adet' : 'm2', unitPrice: (isFree ? 0 : p).toFixed(2), kind, free: isFree, crateFee: isCrate,
      id: ids[i] || null,
      ...(!ids[i] && from[i] && !sub ? { from: from[i].slice(0, 40) } : {}),
      splitGroup: !sub && isSplitKey(group[i]) ? group[i] : null,
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

/**
 * "Yöneticiye göndermeyi geri al" (karar 212): satış, yöneticiye gönderdiği teklifi yönetici fiyatlandırıp müşteriye
 * göndermeden geri alır. Kim / ne zaman kuralı işlemin kendisinde (transitions.js → withdraw_offer): yalnızca teklifi
 * gönderen satışçı, teklif hâlâ yöneticideyken; sayfanın sipariş sürümü verilir (bu arada yönetici işlem yaptıysa CONFLICT).
 */
export async function withdrawOfferAction(formData: FormData) {
  const user = await requirePermission('OFFER_PREPARE');
  const id = orderIdOf(formData);
  await act(user, id, 'withdraw_offer', { expectedVersion: expectedVersion(formData) });
  done(id, 'offer_withdrawn');
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
 * En çok 5 MB'lık dosya okunur (sipariş dosyası 100 MB'a kadar olabilir; Excel okuyucu küçük dosyalar içindir).
 */
export async function readOfferExcelAction(orderId: string, fileId: string): Promise<{ ok: true; rows: string[][] } | { ok: false; error: string }> {
  const user = await requirePermission('OFFER_PREPARE');
  const { t } = await getT();
  const order = await loadOrder(orderId, user);
  const file = order.files.find((f) => f.id === fileId && /\.xlsx?$/i.test(f.name) && f.scanStatus !== 'INFECTED');
  if (!file) return { ok: false, error: t('offer.import.noFile') };
  // Boyut sınırı (5 MB) dosya okunmadan ÖNCE uygulanır; okuma ve ayrıştırma tek yerde: server/orders/excel-file.js (AUD-3)
  // Ön izlemenin metni de sınırlıdır (tek hücre / toplam): sınır aşılırsa satır dönmez (NEW-GL-01, karar 152)
  const res = await readOfferExcel({ path: resolveKey(file.storageKey), size: file.size });
  if (res.ok) return res;
  const key = res.error === 'TOO_BIG' ? 'offer.import.tooBig'
    : res.error === 'TOO_MUCH_TEXT' ? 'offer.import.tooMuchText'
      : res.error === 'NO_FILE' ? 'offer.import.noFile' : 'offer.import.unreadable';
  return { ok: false, error: t(key) };
}
