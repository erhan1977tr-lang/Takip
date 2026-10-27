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

const back = (id: string, q: string) => `/siparisler/${id}?${q}`;
const versionOf = (formData: FormData) => {
  const v = formData.get('v');
  return v === null || v === '' ? undefined : Number(v);
};

type Action = 'approve_production' | 'request_offer_change' | 'override_loading_approval' | 'resend_approval_request';
type Perm = 'ORDER_VIEW' | 'LOADING_APPROVAL_OVERRIDE' | 'OFFER_SEND';

async function run(formData: FormData, action: Action, ok: string, extra: Record<string, unknown> = {}, perm: Perm = 'ORDER_VIEW', anchor = 'uretim-onayi') {
  const user = await requirePermission(perm);
  const id = String(formData.get('id') ?? '');
  try {
    const res = await runOrderAction(db, {
      orderId: id, action, actor: await actorOf(user),
      payload: { offerId: String(formData.get('offerId') ?? ''), expectedVersion: versionOf(formData), ...extra },
    });
    await deliverInAppNow(res.outboxIds);
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
  await run(formData, 'request_offer_change', 'offer_change_requested', { note: String(formData.get('note') ?? '') });
}

/** Onaysız yükleme istisnası — yalnızca yönetici (LOADING_APPROVAL_OVERRIDE); gerekçe zorunlu (sunucuda denetlenir) */
export async function overrideLoadingApprovalAction(formData: FormData) {
  await run(formData, 'override_loading_approval', 'loading_override', { reason: String(formData.get('reason') ?? '') }, 'LOADING_APPROVAL_OVERRIDE', 'yukleme-izni');
}

/** İletilemeyen onay talebini yeniden gönder (aynı sürüm; süre iletimde başlar) — yönetici (OFFER_SEND) */
export async function resendApprovalRequestAction(formData: FormData) {
  await run(formData, 'resend_approval_request', 'approval_resent', {}, 'OFFER_SEND');
}
