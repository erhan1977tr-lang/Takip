'use server';

// Tedarikçi Hesapları (Paket 6, karar 182): elle ödeme ve ödeme iptali. Kurallar ve yetki server/suppliers/service.js'te
// (SUPPLIER_MANAGE — burada ve serviste ayrı ayrı). Ödeme tek seferlik form anahtarıyla bir kez yazılır.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getEnv } from '@/lib/env';
import { addOpening, addPayment, voidOpening, voidPayment } from '@/server/suppliers/service.js';

const PATH = '/admin/muhasebe/tedarikciler';
const back = (supplierId: string, q: string, hash = '') => `${PATH}?t=${encodeURIComponent(supplierId)}&${q}${hash}`;

export async function addSupplierPaymentAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const supplierId = String(fd.get('supplierId') ?? '');
  const r = await addPayment(db, {
    supplierId, paidOn: fd.get('paidOn'), amount: fd.get('amount'), currency: fd.get('currency'), note: fd.get('note'), requestKey: fd.get('requestKey'),
  }, await actorOf(admin), { timeZone: getEnv().APP_TIMEZONE });
  if (!r.ok) redirect(back(supplierId, `error=${encodeURIComponent(r.code)}`, '#odeme'));
  revalidatePath(PATH);
  redirect(back(supplierId, `ok=${r.duplicate ? 'duplicate' : 'paid'}`, '#odemeler'));
}

export async function voidSupplierPaymentAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const supplierId = String(fd.get('supplierId') ?? '');
  const r = await voidPayment(db, { paymentId: String(fd.get('paymentId') ?? ''), reason: fd.get('reason') }, await actorOf(admin));
  if (!r.ok) redirect(back(supplierId, `error=${encodeURIComponent(r.code)}`, '#odemeler'));
  revalidatePath(PATH);
  redirect(back(supplierId, 'ok=voided', '#odemeler'));
}

/** Açılış bakiyesi (DÜZELTME 10 M2): tek seferlik form anahtarıyla bir kez yazılır */
export async function addOpeningAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const supplierId = String(fd.get('supplierId') ?? '');
  const r = await addOpening(db, {
    supplierId, asOf: fd.get('asOf'), amount: fd.get('amount'), currency: fd.get('currency'), direction: String(fd.get('direction') ?? ''),
    note: fd.get('note'), correctsId: fd.get('correctsId'), requestKey: fd.get('requestKey'),
  }, await actorOf(admin), { timeZone: getEnv().APP_TIMEZONE });
  if (!r.ok) redirect(back(supplierId, `error=${encodeURIComponent(r.code)}`, '#acilis'));
  revalidatePath(PATH);
  redirect(back(supplierId, `ok=${r.duplicate ? 'duplicate' : 'opening'}`, '#acilis'));
}

export async function voidOpeningAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const supplierId = String(fd.get('supplierId') ?? '');
  const r = await voidOpening(db, { openingId: String(fd.get('openingId') ?? ''), reason: fd.get('reason') }, await actorOf(admin));
  if (!r.ok) redirect(back(supplierId, `error=${encodeURIComponent(r.code)}`, '#acilis'));
  revalidatePath(PATH);
  redirect(back(supplierId, 'ok=openingVoided', '#acilis'));
}
