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
import { deliverInAppNow } from '@/lib/notifications';
import { orderScope } from '@/lib/orders';
import { photoUploadError } from '@/lib/delivery';
import { photoProblem, takesDeliveryDocs } from '@/server/delivery/rules.js';
import { createDeliveryReport, recordDeliveryPhoto } from '@/server/delivery/service.js';
import type { PhotoUploadResult } from '@/components/DeliveryPhotoUpload';

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
    // Uygulama içi bildirim hemen (ör. teslim günü değişti → müşteri); işçi yedektir, aynı bildirim iki kez yazılmaz
    await deliverInAppNow(res.outboxIds);
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
  const intent = fd.getAll('intent').map(String).find(Boolean) ?? 'save';
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

/**
 * Müşteri ya da yönetici: teslim bilgilerini değiştir (müşteri depoya gidene kadar; yönetici depoda iken de — karar 194).
 * Yöneticinin değiştirdiği teslim günü müşteriye bildirilir.
 */
export async function updatePickupAction(fd: FormData) {
  const user = await requirePermission('ORDER_VIEW');
  const id = idOf(fd);
  const r = await act(user, id, 'update_pickup', {
    pickupDate: parseDateOnly(String(fd.get('pickupDate') ?? '')) ?? new Date('x'),
    phone: String(fd.get('phone') ?? ''), plate: String(fd.get('plate') ?? ''),
    expectedVersion: expectedVersion(fd),
  });
  // Ödemesi alınmış, bilgisi eksik sipariş bilgiler tamamlanınca depoya iletildi (karar 229)
  done(id, `ok=${r?.forwarded ? 'pickup_forwarded' : r?.deliveryDateChanged ? 'delivery_date' : 'pickup_updated'}#teslim`);
}

export async function proformaAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  await act(user, id, 'mark_proforma', { proformaNo: String(fd.get('proformaNo') ?? ''), fxRate: String(fd.get('fxRate') ?? '') });
  done(id, 'ok=proforma');
}

export async function paidAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  const r = await act(user, id, 'mark_paid', { paidDate: parseDateOnly(String(fd.get('paidDate') ?? '')) ?? new Date('x') });
  // Ödeme teyidi siparişi hemen depoya gönderir (depoya önceden gönderilmişse yalnızca ödeme kaydedilir)
  // Teslim bilgisi eksik (karar 229): ödeme kaydedildi, sipariş depoya gönderilmedi
  const code = Array.isArray(r?.pickupMissing) && r.pickupMissing.length ? 'paid_missing'
    : !r?.sent ? 'paid_only' : Array.isArray(r.shortages) && r.shortages.length ? 'paid_shortage' : r.moved ? 'paid_moved' : 'paid';
  const at = r?.pickupDate instanceof Date ? r.pickupDate.toISOString().slice(0, 10) : '';
  done(id, `ok=${code}&at=${encodeURIComponent(at)}`);
}

export async function warehouseAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  const r = await act(user, id, 'send_to_warehouse', { expectedVersion: expectedVersion(fd) });
  const at = r?.pickupDate instanceof Date ? r.pickupDate.toISOString().slice(0, 10) : '';
  const code = Array.isArray(r?.shortages) && r.shortages.length ? 'warehouse_shortage' : r?.moved ? 'warehouse_moved' : 'warehouse';
  done(id, `ok=${code}&at=${encodeURIComponent(at)}`);
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

/** FGO'da yeniden dene (proforma ya da fatura); kur alınamadıysa elle girilebilir. */
export async function retryFgoAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  await act(user, id, 'retry_fgo', { fxRate: String(fd.get('fxRate') ?? '') });
  done(id, 'ok=fgo_retry');
}

export async function cancelProfileAction(fd: FormData) {
  const user = await requirePermission('ORDER_CANCEL');
  const id = idOf(fd);
  await act(user, id, 'cancel', { note: String(fd.get('note') ?? '').trim().slice(0, 500) });
  done(id, 'ok=cancelled');
}

// ---------- Teslimat belgeleri (Paket 8, karar 195–196) ----------

/**
 * Yönetici: tek teslimat fotoğrafı (istemci seçilen fotoğrafları sırayla, her birini ayrı istekle gönderir — biri reddedilirse
 * ötekiler kalır). İçerik denetimi, antivirüs ve kota mevcut yükleme yolundan; aynı fotoğraf ikinci kez gelirse yeni kayıt yok.
 */
export async function deliveryPhotoAction(fd: FormData): Promise<PhotoUploadResult> {
  const user = await requirePermission('OFFER_SEND');
  const { t } = await getT();
  const id = idOf(fd);
  const files = filesFrom(fd, 'photo');
  if (files.length !== 1) return { ok: false, error: t('delivery.photos.errors.empty') };
  const problem = photoProblem(files[0]);
  if (problem) return { ok: false, error: t(`delivery.photos.errors.${problem}`) };
  // Önce siparişin durumu: depoya iletilmemiş siparişe dosya diske hiç yazılmaz
  const order = await db.order.findFirst({ where: { id, ...orderScope(user), orderTypeCode: 'PROFILE_ORDER' }, select: { status: true, removedAt: true, profile: { select: { stage: true } } } });
  if (!order) return { ok: false, error: t('delivery.errors.NOT_FOUND') };
  if (!takesDeliveryDocs({ stage: order.profile?.stage ?? '', status: order.status, removedAt: order.removedAt })) return { ok: false, error: t('delivery.photos.errors.state') };
  const actor = await actorOf(user);
  const stored = await storeFiles(files, { userId: user.id, orderId: id });
  if (!stored.ok) return { ok: false, error: photoUploadError(t, stored.problem.code) };
  let r;
  try {
    r = await recordDeliveryPhoto(db, { orderId: id, stored: stored.stored[0], actor });
  } catch (e) {
    await discardFiles(stored.stored);
    throw e;
  }
  if (!r.ok || r.duplicate) await discardFiles(stored.stored);
  if (!r.ok) return { ok: false, error: t(r.code === 'STATE' ? 'delivery.photos.errors.state' : r.code === 'FORBIDDEN' ? 'delivery.errors.FORBIDDEN' : 'delivery.photos.errors.other') };
  revalidatePath(`/siparisler/${id}`);
  return { ok: true, duplicate: r.duplicate };
}

/** Yönetici: teslimat raporu oluştur (açıklama isteğe bağlı; tek kullanımlık form anahtarı) */
export async function deliveryReportAction(fd: FormData) {
  const user = await requirePermission('OFFER_SEND');
  const id = idOf(fd);
  const r = await createDeliveryReport(db, { orderId: id, note: fd.get('note'), requestKey: fd.get('key'), actor: await actorOf(user) });
  if (!r.ok) {
    const { t } = await getT();
    if (r.code === 'NOT_FOUND') notFound();
    redirect(back(id, `error=${encodeURIComponent(t(`delivery.errors.${r.code}`))}`));
  }
  done(id, `ok=${r.duplicate ? 'report_same' : 'report'}&n=${r.revision}#teslimat`);
}
