'use server';

// Nakliye giderleri (DÜZELTME 10 M6): kayıt + dağıtım, iptal, ödendi işareti. Kurallar ve yetki server/suppliers/costs.js'te
// (SUPPLIER_MANAGE — burada ve serviste ayrı ayrı). Kayıt tek seferlik form anahtarıyla bir kez yazılır.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getEnv } from '@/lib/env';
import { createTransport, markTransportPaid, voidTransport } from '@/server/suppliers/costs.js';

const PATH = '/admin/muhasebe/nakliye';
const back = (q: string, hash = '') => `${PATH}?${q}${hash}`;

export async function addTransportAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const r = await createTransport(db, {
    carrierName: fd.get('carrierName'), invoiceNo: fd.get('invoiceNo'), invoiceDate: fd.get('invoiceDate'), amount: fd.get('amount'),
    currency: fd.get('currency'), fxRate: fd.get('fxRate'), note: fd.get('note'), receiptIds: fd.getAll('receiptId').map(String), requestKey: fd.get('requestKey'),
  }, await actorOf(admin), { timeZone: getEnv().APP_TIMEZONE });
  if (!r.ok) redirect(back(`error=${encodeURIComponent(r.code)}`, '#yeni'));
  revalidatePath(PATH);
  redirect(back(`ok=${r.duplicate ? 'duplicate' : 'added'}`, '#kayitlar'));
}

export async function voidTransportAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const r = await voidTransport(db, { transportId: String(fd.get('transportId') ?? ''), reason: fd.get('reason') }, await actorOf(admin));
  if (!r.ok) redirect(back(`error=${encodeURIComponent(r.code)}`, '#kayitlar'));
  revalidatePath(PATH);
  redirect(back('ok=voided', '#kayitlar'));
}

export async function paidTransportAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const r = await markTransportPaid(db, { transportId: String(fd.get('transportId') ?? ''), paidOn: fd.get('paidOn') }, await actorOf(admin), { timeZone: getEnv().APP_TIMEZONE });
  if (!r.ok) redirect(back(`error=${encodeURIComponent(r.code)}`, '#kayitlar'));
  revalidatePath(PATH);
  redirect(back('ok=paid', '#kayitlar'));
}
