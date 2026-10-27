'use server';

// Müşteri üretim onayı (4.2.1): "Üretime alınmasını onaylıyorum" ve "Ölçülerde değişiklik var"; 4.2.5: yöneticinin
// onaysız yükleme istisnası ve iletilemeyen talebin yeniden gönderimi. Kurallar ve kayıt server/orders/transitions.js'te
// (rol / yetki, onay hakkı, sürüm, tekrar ve mali kilit denetimi işlemin kendisinde); burada yalnızca oturum, form okuma ve
// kullanıcıya gösterilecek mesaj var. Yetki ayrıca burada da istenir (düğmenin görünmemesi yetki değildir).
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { lockReasonText, workflowErrorText } from '@/lib/labels';
import { actorOf } from '@/lib/actor';
import { deliverInAppNow } from '@/lib/notifications';
import { runOrderAction, WorkflowError } from '@/server/orders/transitions.js';
import { retryOfferChangeTranslation, translateOfferChange } from '@/server/notes/translation.js';
import { loadOrder } from '@/lib/orders';

const back = (id: string, q: string) => `/siparisler/${id}?${q}`;
const versionOf = (formData: FormData) => {
  const v = formData.get('v');
  return v === null || v === '' ? undefined : Number(v);
};

type Action = 'approve_production' | 'request_offer_change' | 'override_loading_approval' | 'resend_approval_request' | 'open_revision_draft';
type Perm = 'ORDER_VIEW' | 'LOADING_APPROVAL_OVERRIDE' | 'OFFER_SEND' | 'OFFER_PREPARE';
type Actor = Awaited<ReturnType<typeof actorOf>>;

/**
 * Müşterinin değişiklik talebi notunu (Offer.changeNote) bir kez Türkçeye çevirir (4.2.10, karar 306) — yalnızca işlem
 * KAYDEDİLDİKTEN sonra (talep ya da eski talep için taslak açma). Kural ve sahiplenme server/notes/translation.js'te; çeviri
 * adımındaki beklenmedik hata (veritabanı) işlemi bozmaz, günlüğe yalnızca güvenli kod yazılır.
 */
async function translateChangeNote(orderId: string, offerId: unknown, actor: Actor) {
  if (typeof offerId !== 'string' || !offerId) return;
  await translateOfferChange(db, { offerId, orderId, actor })
    .catch((e: unknown) => console.warn('[teklif notu çevirisi] yapılamadı', offerId, String((e as { code?: unknown })?.code ?? 'ERROR')));
}

async function run(formData: FormData, action: Action, ok: string, extra: Record<string, unknown> = {}, perm: Perm = 'ORDER_VIEW', anchor = 'uretim-onayi', translate = false) {
  const user = await requirePermission(perm);
  const id = String(formData.get('id') ?? '');
  try {
    const actor = await actorOf(user);
    const res = await runOrderAction(db, {
      orderId: id, action, actor,
      payload: { offerId: String(formData.get('offerId') ?? ''), expectedVersion: versionOf(formData), ...extra },
    });
    await deliverInAppNow(res.outboxIds);
    if (translate) await translateChangeNote(id, (res.result as { offerId?: unknown } | null | undefined)?.offerId, actor);
  } catch (e) {
    if (e instanceof WorkflowError) {
      if (e.code === 'NOT_FOUND') notFound();
      const { t } = await getT();
      const reasons = (e.details as { reasons?: { code: string; ref?: string | null; kind?: string | null }[] } | undefined)?.reasons;
      const msg = e.code === 'PRICE_LOCKED'
        ? [t('order.errors.priceLocked'), ...(reasons ?? []).map((r) => lockReasonText(t, r))].join(' · ')
        : workflowErrorText(t, e.code, e.details as Record<string, unknown>);
      redirect(back(id, `error=${encodeURIComponent(msg)}`) + `#${anchor}`);
    }
    throw e;
  }
  revalidatePath('/siparisler');
  revalidatePath(`/siparisler/${id}`);
  redirect(back(id, `ok=${ok}`));
}

/** "Üretime alınmasını onaylıyorum" — ekranda görülen, en son gönderilmiş teklif sürümüne */
export async function approveProductionAction(formData: FormData) {
  await run(formData, 'approve_production', 'production_approved');
}

/** "Ölçülerde değişiklik var" — açıklama zorunlu (sunucuda denetlenir) */
export async function requestOfferChangeAction(formData: FormData) {
  await run(formData, 'request_offer_change', 'offer_change_requested', { note: String(formData.get('note') ?? '') }, 'ORDER_VIEW', 'uretim-onayi', true);
}

/**
 * Eski müşteri talebi için tek seferlik "Revizyon taslağını aç" (4.2.10, karar 306 — ör. ALE81: 4.2.10'dan önce üretimdeki
 * siparişte alınmış, taslağı açılmamış talep). Satış / yönetici (OFFER_PREPARE); kural ve kayıt open_revision_draft'ta (talep
 * kaydına dokunmaz, koşullu, çift tıklamada tek taslak, denetim kaydı). Talep notu bu sırada bir kez Türkçeye çevrilir.
 */
export async function openRevisionDraftAction(formData: FormData) {
  await run(formData, 'open_revision_draft', 'revision_draft_opened', {}, 'OFFER_PREPARE', 'teklif', true);
}

/**
 * Müşterinin değişiklik talebi notunun çevrilemeyen çevirisini bir kez daha ister — yalnızca teklif hazırlayan iç ekip, açık
 * istekle (kural server/notes/translation.js → retryOfferChangeTranslation: yalnızca başarısız / yarıda kalmış çeviri).
 */
export async function retryOfferTranslationAction(formData: FormData) {
  const user = await requirePermission('OFFER_PREPARE');
  const order = await loadOrder(String(formData.get('id') ?? ''), user);
  const { t } = await getT();
  const r = await retryOfferChangeTranslation(db, { offerId: String(formData.get('offerId') ?? '').slice(0, 64), orderId: order.id, actor: await actorOf(user) });
  if (!r.ok) {
    const msg = t(r.code === 'DISABLED' ? 'order.notes.translation.disabled' : r.code === 'RATE_LIMIT' ? 'order.notes.translation.retryLimit' : 'order.errors.notAllowed');
    redirect(back(order.id, `error=${encodeURIComponent(msg)}`) + '#teklif');
  }
  revalidatePath(`/siparisler/${order.id}`);
  if (r.translation === 'FAILED') redirect(back(order.id, `error=${encodeURIComponent(t('order.notes.translation.retryFailed'))}`) + '#teklif');
  redirect(back(order.id, 'ok=note_translated') + '#teklif');
}

/** Onaysız yükleme istisnası — yalnızca yönetici (LOADING_APPROVAL_OVERRIDE); gerekçe zorunlu (sunucuda denetlenir) */
export async function overrideLoadingApprovalAction(formData: FormData) {
  await run(formData, 'override_loading_approval', 'loading_override', { reason: String(formData.get('reason') ?? '') }, 'LOADING_APPROVAL_OVERRIDE', 'yukleme-izni');
}

/** İletilemeyen onay talebini yeniden gönder (aynı sürüm; süre iletimde başlar) — yönetici (OFFER_SEND) */
export async function resendApprovalRequestAction(formData: FormData) {
  await run(formData, 'resend_approval_request', 'approval_resent', {}, 'OFFER_SEND');
}
