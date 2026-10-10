'use server';

// Yeni cam siparişi ve taslak. Numara kuralı ve kayıt server/orders/create.js'te (createGlassOrder),
// taslak server/orders/drafts.js'te; burada form okuma, dosya kaydı (içerik kontrolü + antivirüs) ve mesajlar.
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { fileProblemText, workflowErrorText } from '@/lib/labels';
import { actorOf } from '@/lib/actor';
import { filesFrom } from '@/lib/storage';
import { discardFiles, storeFiles } from '@/lib/uploads';
import { fileProblem, parseDateOnly } from '@/server/orders/rules.js';
import { createGlassOrder } from '@/server/orders/create.js';
import { MAX_DRAFT_FILES, MAX_NOTE, deleteDraft, keepDraftGlass, saveDraft } from '@/server/orders/drafts.js';
import { CUSTOMER_GLASS_TYPES, glassOrderItems } from '@/server/catalog/glass.js';
import { WorkflowError } from '@/server/domain/workflow.js';
import { MAX_PROFILE_QTY, profileOrderItems, readQuantities } from '@/server/profile/rules.js';
import { createProfileOrder } from '@/server/profile/create.js';
import { saveProfileDraft } from '@/server/profile/drafts.js';
import { translateOrderNote } from '@/server/notes/translation.js';

export type NewOrderState = {
  error?: string;
  values?: { title: string; no: string; note: string; glasses: { id: string; qty: string }[]; removed: string[] };
};

export async function createOrderAction(_prev: NewOrderState, formData: FormData): Promise<NewOrderState> {
  const user = await requirePermission('ORDER_CREATE');
  const { t } = await getT();
  const firm = user.customer;
  const intent = String(formData.get('intent') ?? 'submit') === 'draft' ? 'draft' : 'submit';
  const draftId = String(formData.get('draftId') ?? '') || null;
  const title = String(formData.get('title') ?? '').trim().slice(0, 160);
  const note = String(formData.get('note') ?? '').trim();
  const noRaw = String(formData.get('customerOrderNo') ?? '').trim();
  const suggestedRaw = String(formData.get('suggestedNo') ?? '').trim();
  // Cam adedi müşteri formunda yok (karar 160): gönderilse de okunmaz — sipariş satırına "belirtilmedi" (0) yazılır;
  // adetleri, ölçüleri ve fiyatı satış ekibi teklif tablosunda girer
  const glassIds = formData.getAll('glassId').map(String);
  const glasses = glassIds.map((id) => ({ id, qty: '' }));
  const removed = formData.getAll('removeFile').map(String);
  const values = { title, no: noRaw, note, glasses: glasses.filter((g) => g.id), removed };
  const fail = (error: string) => ({ error, values });

  if (!firm || firm.type !== 'CUSTOMER' || !firm.prefix) return fail(t('newOrder.errors.noFirm'));
  if (note.length > MAX_NOTE) return fail(t('newOrder.errors.noteTooLong', { n: MAX_NOTE }));
  const suggestedNo = /^\d+$/.test(suggestedRaw) ? Number(suggestedRaw) : null;
  const no = noRaw === '' ? null : Number(noRaw);
  if (no !== null && (!Number.isInteger(no) || no <= 0 || no > 9_999_999)) return fail(t('newOrder.errors.badNumber'));

  const files = filesFrom(formData, 'files');
  if (files.length > MAX_DRAFT_FILES) return fail(t('newOrder.errors.tooManyFiles'));
  for (const f of files) {
    const p = fileProblemText(t, fileProblem(f.name, f.size));
    if (p) return fail(p);
  }

  let items: object[] = [];
  // Siparişte tek cam tipi (karar 85): müşteri ikinci cam ekleyemez. Formda düğme yok; burada taslak için de reddedilir,
  // gönderimde ayrıca glassOrderItems (ONE_GLASS) ve createGlassOrder (tam olarak bir cam) denetler.
  if (glasses.filter((g) => g.id).length > CUSTOMER_GLASS_TYPES) return fail(t('newOrder.errors.oneGlass'));
  if (intent === 'submit') {
    if (!title) return fail(t('newOrder.errors.titleRequired'));
    if (no === null) return fail(t('newOrder.errors.badNumber'));
    const ids = glasses.map((g) => g.id).filter(Boolean);
    const products = ids.length ? await db.glassProduct.findMany({ where: { id: { in: ids } } }) : [];
    const res = glassOrderItems(glasses, products);
    if (!res.ok) return fail(t(({ NO_GLASS: 'newOrder.errors.noGlass', ONE_GLASS: 'newOrder.errors.oneGlass', GLASS_GONE: 'newOrder.errors.glassGone', BAD_QTY: 'newOrder.errors.badQty' } as const)[res.code], { max: 9999 }));
    items = res.items;
    // Dosya: yeni yüklenenler + taslakta kalanlar
    const kept = draftId ? await db.orderDraftFile.count({ where: { draftId, draft: { customerId: firm.id }, id: { notIn: removed } } }) : 0;
    if (files.length + kept === 0) return fail(t('newOrder.errors.noFiles'));
  }

  // İşlemi yapan, dosyalar saklanmadan ÖNCE belirlenir: saklama ile kayıt arasında hata verebilecek adım kalmaz (karar 153)
  const actor = await actorOf(user);
  // Dosyalar önce kaydedilir (içerik kontrolü + antivirüs); kayıt başarısız olursa geri silinir.
  const stored = await storeFiles(files, { userId: user.id });
  if (!stored.ok) return fail(fileProblemText(t, stored.problem)!);

  if (intent === 'draft') {
    let saved: { id: string; removed: { storageKey: string }[] };
    try {
      saved = await saveDraft(db, {
        actor, firm: { id: firm.id }, draftId,
        // Önerilen numara değiştirilmediyse saklanmaz: taslağa dönüldüğünde o anki sıradaki numara önerilir
        values: { title, note, lines: glasses, customerOrderNo: no !== null && no !== suggestedNo ? no : null },
        files: stored.stored, removeFileIds: removed,
      });
    } catch (err) {
      await discardFiles(stored.stored);
      if (err instanceof WorkflowError) return fail(draftErrorText(t, err.code));
      console.error('Taslak kaydedilemedi', err);
      return fail(t('newOrder.errors.saveFailed'));
    }
    await discardFiles(saved.removed);
    revalidatePath('/siparisler');
    redirect(`/siparisler/yeni?taslak=${saved.id}&ok=draft`);
  }

  let orderId: string;
  let dropped: { storageKey: string }[] = [];
  try {
    const created = await createGlassOrder(db, {
      actor, firm: { id: firm.id, prefix: firm.prefix, camEtiket: firm.camEtiket, sandikEtiket: firm.sandikEtiket },
      title, requestedNo: no!, suggestedNo, items, files: stored.stored, note: note || null, draftId, dropDraftFileIds: removed,
    });
    orderId = created.id;
    dropped = created.dropped;
  } catch (err) {
    await discardFiles(stored.stored);
    if (err instanceof WorkflowError) {
      return fail(err.code === 'DRAFT_GONE' || err.code === 'NO_FILES' ? draftErrorText(t, err.code) : workflowErrorText(t, err.code, err.details as Record<string, unknown>));
    }
    console.error('Sipariş oluşturulamadı', err);
    return fail(t('newOrder.errors.saveFailed'));
  }
  await discardFiles(dropped);
  // İlk mesaj (karar 225): sipariş kaydedildikten SONRA bir kez Türkçeye çevrilir; çeviri hatası siparişi etkilemez
  if (note) await firstNoteTranslation(orderId, actor);
  redirect(`/siparisler/${orderId}?ok=created`);
}

function draftErrorText(t: Awaited<ReturnType<typeof getT>>['t'], code: string) {
  switch (code) {
    case 'DRAFT_GONE': return t('newOrder.errors.draftGone');
    case 'DRAFT_LEGACY_GLASS': return t('newOrder.errors.legacyDraft');
    case 'BAD_QTY': return t('newOrder.errors.badQty', { max: 9999 });
    case 'BAD_NUMBER': return t('newOrder.errors.badNumber');
    case 'TOO_MANY_LINES': return t('newOrder.errors.tooManyLines');
    case 'TOO_MANY_FILES': return t('newOrder.errors.tooManyFiles');
    case 'NO_FILES': return t('newOrder.errors.noFiles');
    default: return t('newOrder.errors.saveFailed');
  }
}

/** Taslağı siler (dosyalarıyla). */
export async function deleteDraftAction(formData: FormData) {
  const user = await requirePermission('ORDER_CREATE');
  const firm = user.customer;
  const id = String(formData.get('draftId') ?? '');
  if (!firm || !id) redirect('/siparisler');
  const files = await deleteDraft(db, { firm: { id: firm.id }, draftId: id });
  if (files) await discardFiles(files);
  revalidatePath('/siparisler');
  redirect(`/siparisler?ok=${files ? 'draftDeleted' : 'draftGone'}`);
}

/**
 * Eski çok camlı taslak (karar 86): müşterinin açıkça seçip onayladığı cam tutulur, diğer cam satırları taslaktan
 * çıkar; dosyalar, not, ad ve numara değişmez. Seçim "sıra:camKimliği" olarak gelir ve sunucuda doğrulanır.
 */
export async function keepDraftGlassAction(formData: FormData) {
  const user = await requirePermission('ORDER_CREATE');
  const firm = user.customer;
  const draftId = String(formData.get('draftId') ?? '');
  if (!firm || firm.type !== 'CUSTOMER' || !draftId) redirect('/siparisler');
  const back = `/siparisler/yeni?taslak=${encodeURIComponent(draftId)}`;
  const pick = /^(\d{1,2}):(.{1,64})$/.exec(String(formData.get('keep') ?? ''));
  if (!pick) redirect(`${back}&hata=sec`);
  let dropped: { glassProductId: string }[];
  try {
    ({ dropped } = await keepDraftGlass(db, { actor: await actorOf(user), firm: { id: firm.id }, draftId, index: Number(pick[1]), glassProductId: pick[2] }));
  } catch (err) {
    // Taslak yok / artık çok camlı değil → taslak sayfası güncel durumu gösterir; liste değiştiyse yeniden seçilir
    if (err instanceof WorkflowError) redirect(err.code === 'GLASS_NOT_IN_DRAFT' ? `${back}&hata=degisti` : back);
    throw err;
  }
  revalidatePath('/siparisler');
  redirect(`${back}&ok=glassKept&cikan=${[...new Set(dropped.map((d) => d.glassProductId))].map(encodeURIComponent).join(',')}`);
}

// ---------------- Profil siparişi (Aşama 6) ----------------
export type ProfileOrderState = {
  error?: string;
  values?: { title: string; no: string; note: string; qty: Record<string, string>; pickupDate?: string; phone?: string; plate?: string };
};

/** Profil siparişi: yalnızca adedi > 0 olan ürünler siparişe girer. Taslak da buradan kaydedilir. */
export async function createProfileOrderAction(_prev: ProfileOrderState, formData: FormData): Promise<ProfileOrderState> {
  const user = await requirePermission('ORDER_CREATE');
  const { t } = await getT();
  const firm = user.customer;
  const intent = String(formData.get('intent') ?? 'submit') === 'draft' ? 'draft' : 'submit';
  const draftId = String(formData.get('draftId') ?? '') || null;
  const title = String(formData.get('title') ?? '').trim().slice(0, 160);
  const note = String(formData.get('note') ?? '').trim();
  const noRaw = String(formData.get('customerOrderNo') ?? '').trim();
  const suggestedRaw = String(formData.get('suggestedNo') ?? '').trim();
  const ids = formData.getAll('p_id').map(String);
  const qtys = formData.getAll('p_qty').map(String);
  const rows = ids.map((id, i) => ({ id, qty: qtys[i] ?? '' }));
  const qty = Object.fromEntries(rows.filter((r) => r.qty !== '').map((r) => [r.id, r.qty]));
  const values = {
    title, no: noRaw, note, qty,
    pickupDate: String(formData.get('pickupDate') ?? '').slice(0, 10), phone: String(formData.get('phone') ?? '').slice(0, 60), plate: String(formData.get('plate') ?? '').slice(0, 80),
  };
  const fail = (error: string) => ({ error, values });

  if (!firm || firm.type !== 'CUSTOMER' || !firm.prefix) return fail(t('newOrder.errors.noFirm'));
  if (note.length > MAX_NOTE) return fail(t('newOrder.errors.noteTooLong', { n: MAX_NOTE }));
  const suggestedNo = /^\d+$/.test(suggestedRaw) ? Number(suggestedRaw) : null;
  const no = noRaw === '' ? null : Number(noRaw);
  if (no !== null && (!Number.isInteger(no) || no <= 0 || no > 9_999_999)) return fail(t('newOrder.errors.badNumber'));
  const read = readQuantities(rows);
  if (!read.ok) return fail(read.code === 'BAD_QTY' ? t('profile.errors.badQty', { max: MAX_PROFILE_QTY }) : t('profile.errors.tooMany'));
  const actor = await actorOf(user);

  if (intent === 'draft') {
    let saved: { id: string };
    try {
      saved = await saveProfileDraft(db, {
        actor, firm: { id: firm.id }, draftId,
        values: { title, note, lines: read.lines, customerOrderNo: no !== null && no !== suggestedNo ? no : null },
      });
    } catch (err) {
      if (err instanceof WorkflowError) return fail(draftErrorText(t, err.code));
      console.error('Profil taslağı kaydedilemedi', err);
      return fail(t('newOrder.errors.saveFailed'));
    }
    revalidatePath('/siparisler');
    redirect(`/siparisler/yeni?taslak=${saved.id}&ok=draft`);
  }

  if (no === null) return fail(t('newOrder.errors.badNumber'));
  if (read.lines.length === 0) return fail(t('profile.errors.noItems'));
  const products = await db.profileProduct.findMany({ where: { id: { in: read.lines.map((l) => l.productId) } }, include: { category: true } });
  const items = profileOrderItems(read.lines, products);
  if (!items.ok) return fail(t(items.code === 'NO_ITEMS' ? 'profile.errors.noItems' : 'profile.errors.productGone'));

  // Fiyat listesiyle doğrudan sipariş (Paket B — karar 229): alış günü zorunlu, telefon / plaka isteğe bağlı — sunucu,
  // firmanın bağlı etkin listesine ve satırların fiyatına göre doğrudan mı olağan akış mı olduğuna KENDİ karar verir.
  // requestKey: formun tek seferlik anahtarı (çift tıklama / yeniden deneme ikinci sipariş ve proforma açmaz)
  const pickup = {
    pickupDate: parseDateOnly(String(formData.get('pickupDate') ?? '')) ?? undefined,
    phone: String(formData.get('phone') ?? '').slice(0, 60),
    plate: String(formData.get('plate') ?? '').slice(0, 80),
  };
  const requestKey = String(formData.get('requestKey') ?? '').slice(0, 64) || null;
  let orderId: string;
  let direct = false;
  let duplicate = false;
  try {
    const created = await createProfileOrder(db, {
      actor, firm: { id: firm.id, prefix: firm.prefix }, title: title || null, requestedNo: no, suggestedNo, items: items.items, note: note || null, draftId,
      pickup, requestKey,
    });
    orderId = created.id;
    direct = created.direct;
    duplicate = created.duplicate;
  } catch (err) {
    if (err instanceof WorkflowError) {
      return fail(err.code === 'DRAFT_GONE' ? draftErrorText(t, err.code) : workflowErrorText(t, err.code, err.details as Record<string, unknown>));
    }
    console.error('Profil siparişi oluşturulamadı', err);
    return fail(t('newOrder.errors.saveFailed'));
  }
  // Aynı form ikinci kez geldi: ilk sipariş gösterilir (ilk mesaj zaten ilk gönderimde çevrildi)
  if (note && !duplicate) await firstNoteTranslation(orderId, actor);
  revalidatePath('/siparisler');
  redirect(`/siparisler/${orderId}?ok=${direct ? 'profile_direct' : 'profile_created'}`);
}

/** Siparişin ilk mesajının tek seferlik çevirisi (karar 225). Hiçbir hata sipariş oluşturmayı bozmaz. */
async function firstNoteTranslation(orderId: string, actor: Awaited<ReturnType<typeof actorOf>>) {
  try {
    await translateOrderNote(db, { orderId, actor });
  } catch (err) {
    console.warn('[not çevirisi] ilk mesaj çevrilemedi', orderId, err instanceof Error ? err.name : 'hata');
  }
}
