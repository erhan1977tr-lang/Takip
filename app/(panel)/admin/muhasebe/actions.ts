'use server';

// Muhasebe (yalnızca yönetici, ACCOUNTING_MANAGE). Hesaplar server/accounting/*.js'te.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getEnv } from '@/lib/env';
import { parseDateOnly } from '@/server/orders/rules.js';
import { writeAudit } from '@/server/orders/journal.js';
import { refreshDocuments } from '@/server/accounting/receivables.js';
import { CURRENCIES, parseAmount } from '@/server/accounting/supplier.js';

const RECEIVABLE_PATH = { PROFILE_ORDER: '/admin/muhasebe/profil', GLASS_ORDER: '/admin/muhasebe/cam' } as const;
const SUPPLIER = '/admin/muhasebe/tedarikci';
const note = (fd: FormData) => String(fd.get('note') ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
const currency = (fd: FormData) => {
  const c = String(fd.get('currency') ?? '');
  return CURRENCIES.includes(c) ? c : null;
};

/** "FGO ile Güncelle": belgelerin tutarı ve ödenen kısmı FGO'dan (mevcut FGO bağlantısıyla) */
export async function refreshFgoAction(fd: FormData) {
  await requirePermission('ACCOUNTING_MANAGE');
  const type = fd.get('type') === 'GLASS_ORDER' ? 'GLASS_ORDER' : 'PROFILE_ORDER';
  const env = getEnv();
  const r = await refreshDocuments(db, { orderType: type, secret: env.AUTH_SECRET, appUrl: env.APP_URL ?? '' });
  revalidatePath(RECEIVABLE_PATH[type]);
  redirect(`${RECEIVABLE_PATH[type]}?${r.ok ? `ok=refreshed&n=${r.checked}&f=${r.failed}` : `error=${r.code}`}`);
}

/** Yükleme gününe nakliye maliyeti */
export async function addTransportAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const day = parseDateOnly(String(fd.get('shipDay') ?? ''));
  const amount = parseAmount(fd.get('amount'));
  const cur = currency(fd);
  if (!day || amount == null || !cur) redirect(`${SUPPLIER}?error=transport#yuklemeler`);
  const actor = await actorOf(user);
  await db.$transaction(async (tx) => {
    const c = await tx.loadingCost.create({ data: { shipDay: day, amount: amount.toFixed(2), currency: cur, note: note(fd), createdById: user.id } });
    await writeAudit(tx, { action: 'LOADING_COST_ADD', entityType: 'LoadingCost', entityId: c.id, userId: user.id, details: { shipDay: String(fd.get('shipDay')), amount, currency: cur } }, actor);
  });
  revalidatePath(SUPPLIER);
  redirect(`${SUPPLIER}?ok=transport#yuklemeler`);
}

export async function deleteTransportAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const id = String(fd.get('id') ?? '');
  const actor = await actorOf(user);
  await db.$transaction(async (tx) => {
    const c = await tx.loadingCost.findUnique({ where: { id } });
    if (!c) return;
    await tx.loadingCost.delete({ where: { id } });
    await writeAudit(tx, { action: 'LOADING_COST_DELETE', entityType: 'LoadingCost', entityId: id, userId: user.id, details: { shipDay: c.shipDay.toISOString().slice(0, 10), amount: c.amount.toString(), currency: c.currency, note: c.note } }, actor);
  });
  revalidatePath(SUPPLIER);
  redirect(`${SUPPLIER}?ok=deleted#yuklemeler`);
}

/** Fabrikaya ödeme (yüklemeye bağlı değil) */
export async function addPaymentAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const day = parseDateOnly(String(fd.get('paidOn') ?? ''));
  const amount = parseAmount(fd.get('amount'));
  const cur = currency(fd);
  if (!day || amount == null || !cur) redirect(`${SUPPLIER}?error=payment#cari`);
  const actor = await actorOf(user);
  await db.$transaction(async (tx) => {
    const p = await tx.factoryPayment.create({ data: { paidOn: day, amount: amount.toFixed(2), currency: cur, note: note(fd), createdById: user.id } });
    await writeAudit(tx, { action: 'FACTORY_PAYMENT_ADD', entityType: 'FactoryPayment', entityId: p.id, userId: user.id, details: { paidOn: String(fd.get('paidOn')), amount, currency: cur } }, actor);
  });
  revalidatePath(SUPPLIER);
  redirect(`${SUPPLIER}?ok=payment#cari`);
}

export async function deletePaymentAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const id = String(fd.get('id') ?? '');
  const actor = await actorOf(user);
  await db.$transaction(async (tx) => {
    const p = await tx.factoryPayment.findUnique({ where: { id } });
    if (!p) return;
    await tx.factoryPayment.delete({ where: { id } });
    await writeAudit(tx, { action: 'FACTORY_PAYMENT_DELETE', entityType: 'FactoryPayment', entityId: id, userId: user.id, details: { paidOn: p.paidOn.toISOString().slice(0, 10), amount: p.amount.toString(), currency: p.currency, note: p.note } }, actor);
  });
  revalidatePath(SUPPLIER);
  redirect(`${SUPPLIER}?ok=deleted#cari`);
}
