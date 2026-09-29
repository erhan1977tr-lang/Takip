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
import { fileProblem } from '@/server/orders/rules.js';
import { createGlassOrder } from '@/server/orders/create.js';
import { MAX_DRAFT_FILES, MAX_NOTE, deleteDraft, saveDraft } from '@/server/orders/drafts.js';
import { glassOrderItems } from '@/server/catalog/glass.js';
import { WorkflowError } from '@/server/domain/workflow.js';

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
  const glassIds = formData.getAll('glassId').map(String);
  const glassQty = formData.getAll('glassQty').map(String);
  const glasses = glassIds.map((id, i) => ({ id, qty: glassQty[i] ?? '1' }));
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
  if (intent === 'submit') {
    if (!title) return fail(t('newOrder.errors.titleRequired'));
    if (no === null) return fail(t('newOrder.errors.badNumber'));
    const ids = glasses.map((g) => g.id).filter(Boolean);
    const products = ids.length ? await db.glassProduct.findMany({ where: { id: { in: ids } } }) : [];
    const res = glassOrderItems(glasses, products);
    if (!res.ok) return fail(t(({ NO_GLASS: 'newOrder.errors.noGlass', GLASS_GONE: 'newOrder.errors.glassGone', BAD_QTY: 'newOrder.errors.badQty', TOO_MANY_LINES: 'newOrder.errors.tooManyLines' } as const)[res.code], { max: 9999 }));
    items = res.items;
    // Dosya: yeni yüklenenler + taslakta kalanlar
    const kept = draftId ? await db.orderDraftFile.count({ where: { draftId, draft: { customerId: firm.id }, id: { notIn: removed } } }) : 0;
    if (files.length + kept === 0) return fail(t('newOrder.errors.noFiles'));
  }

  // Dosyalar önce kaydedilir (içerik kontrolü + antivirüs); kayıt başarısız olursa geri silinir.
  const stored = await storeFiles(files, { userId: user.id });
  if (!stored.ok) return fail(fileProblemText(t, stored.problem)!);
  const actor = await actorOf(user);

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
  redirect(`/siparisler/${orderId}?ok=created`);
}

function draftErrorText(t: Awaited<ReturnType<typeof getT>>['t'], code: string) {
  switch (code) {
    case 'DRAFT_GONE': return t('newOrder.errors.draftGone');
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
