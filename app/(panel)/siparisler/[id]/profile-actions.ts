'use server';

// Profil siparişi sayfasının işlemleri (Aşama 6). Kurallar ve kayıt server/profile/transitions.js'te (runProfileAction);
// burada yalnızca oturum, form okuma, dosya kaydı ve mesaj.
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { type CurrentUser, requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { fileProblemText, workflowErrorText } from '@/lib/labels';
import { actorOf } from '@/lib/actor';
import { filesFrom } from '@/lib/storage';
import { discardFiles, storeFiles, type StoredUpload } from '@/lib/uploads';
import { parseDateOnly } from '@/server/orders/rules.js';
import { runProfileAction, WorkflowError } from '@/server/profile/transitions.js';

const back = (id: string, q: string) => `/siparisler/${id}?${q}`;
const idOf = (fd: FormData) => String(fd.get('id') ?? '');
const expectedVersion = (fd: FormData) => {
  const v = fd.get('v');
  return v === null || v === '' ? undefined : Number(v);
};

function done(id: string, q: string): never {
  revalidatePath('/siparisler');
  revalidatePath('/teklifler');
  revalidatePath('/admin/stok');
  revalidatePath(`/siparisler/${id}`);
  redirect(back(id, q));
}

async function act(user: CurrentUser, orderId: string, action: string, payload: Record<string, unknown> = {}, cleanup?: () => Promise<void>) {
  try {
    const res = await runProfileAction(db, { orderId, action, actor: await actorOf(user), payload });
    return res.result as Record<string, unknown> | null;
  } catch (e) {
    if (cleanup) await cleanup();
    if (e instanceof WorkflowError) {
      if (e.code === 'NOT_FOUND') notFound();
      const { t } = await getT();
      redirect(back(orderId, `error=${encodeURIComponent(workflowErrorText(t, e.code, e.details as Record<string, unknown>))}`));
    }
    throw e;
  }
}

const lines = (fd: FormData) => {
  const ids = fd.getAll('l_id').map(String);
  const prices = fd.getAll('l_price').map((v) => String(v).trim());
  return ids.map((id, i) => ({ id, offerPrice: prices[i] ?? '' }));
};

/** Yönetici: fiyatları kaydet · müşteriye gönder · (müşterideki teklifi) güncelle */
export async function profilePricesAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  const intent = String(fd.get('intent') ?? 'save');
  const action = { save: 'save_profile_prices', send: 'send_profile_offer', update: 'update_profile_offer' }[intent] ?? 'save_profile_prices';
  await act(user, id, action, { lines: lines(fd), note: String(fd.get('note') ?? '').trim().slice(0, 500), expectedVersion: expectedVersion(fd) });
  done(id, `ok=${{ save: 'prices_saved', send: 'offer_sent', update: 'offer_updated' }[intent] ?? 'prices_saved'}`);
}

/** Müşteri: teklifi onayla (alış günü, telefon, plaka zorunlu) */
export async function approveProfileAction(fd: FormData) {
  const user = await requirePermission('OFFER_APPROVE');
  const id = idOf(fd);
  await act(user, id, 'approve_profile_offer', {
    offerId: String(fd.get('offerId') ?? ''), pickupDate: parseDateOnly(String(fd.get('pickupDate') ?? '')) ?? new Date('x'),
    phone: String(fd.get('phone') ?? ''), plate: String(fd.get('plate') ?? ''),
  });
  done(id, 'ok=approved');
}

/** Müşteri ya da yönetici: teslim bilgilerini değiştir (depoya gidene kadar) */
export async function updatePickupAction(fd: FormData) {
  const user = await requirePermission('ORDER_VIEW');
  const id = idOf(fd);
  await act(user, id, 'update_pickup', {
    pickupDate: parseDateOnly(String(fd.get('pickupDate') ?? '')) ?? new Date('x'),
    phone: String(fd.get('phone') ?? ''), plate: String(fd.get('plate') ?? ''),
  });
  done(id, 'ok=pickup_updated');
}

export async function proformaAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  await act(user, id, 'mark_proforma', { proformaNo: String(fd.get('proformaNo') ?? '') });
  done(id, 'ok=proforma');
}

export async function paidAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  const r = await act(user, id, 'mark_paid', { paidDate: parseDateOnly(String(fd.get('paidDate') ?? '')) ?? new Date('x') });
  // Ödeme teyidi siparişi hemen depoya gönderir (depoya önceden gönderilmişse yalnızca ödeme kaydedilir)
  const code = !r?.sent ? 'paid_only' : Array.isArray(r.shortages) && r.shortages.length ? 'paid_shortage' : r.moved ? 'paid_moved' : 'paid';
  const at = r?.pickupDate instanceof Date ? r.pickupDate.toISOString().slice(0, 10) : '';
  done(id, `ok=${code}&at=${encodeURIComponent(at)}`);
}

export async function warehouseAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  const r = await act(user, id, 'send_to_warehouse', { expectedVersion: expectedVersion(fd) });
  done(id, `ok=${Array.isArray(r?.shortages) && r.shortages.length ? 'warehouse_shortage' : 'warehouse'}`);
}

export async function resendWarehouseAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  await act(user, id, 'resend_warehouse');
  done(id, 'ok=resent');
}

const DELIVERY_EXT = ['pdf', 'jpg', 'jpeg', 'png'];

/** Yönetici: teslim edildi (imzalı belge isteğe bağlı; içerik kontrolü + antivirüs) */
export async function deliveredAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  const { t } = await getT();
  const files = filesFrom(fd, 'files');
  for (const f of files) {
    const ext = f.name.toLowerCase().split('.').pop() ?? '';
    if (!DELIVERY_EXT.includes(ext) || f.size > 20 * 1024 * 1024) redirect(back(id, `error=${encodeURIComponent(t('profile.errors.deliveryFileType', { name: f.name }))}`));
  }
  let stored: StoredUpload[] = [];
  if (files.length) {
    const r = await storeFiles(files, { userId: user.id, orderId: id });
    if (!r.ok) redirect(back(id, `error=${encodeURIComponent(fileProblemText(t, r.problem) ?? '')}`));
    stored = r.stored;
  }
  await act(user, id, 'mark_delivered', { files: stored }, () => discardFiles(stored));
  done(id, 'ok=delivered');
}

export async function invoicedAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  await act(user, id, 'mark_invoiced', { invoiceNo: String(fd.get('invoiceNo') ?? '') });
  done(id, 'ok=invoiced');
}

export async function cancelProfileAction(fd: FormData) {
  const user = await requirePermission('ORDER_CANCEL');
  const id = idOf(fd);
  await act(user, id, 'cancel', { note: String(fd.get('note') ?? '').trim().slice(0, 500) });
  done(id, 'ok=cancelled');
}
