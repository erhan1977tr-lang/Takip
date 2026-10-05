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
import { refreshDocuments, removeDocumentDeletedInFgo } from '@/server/accounting/receivables.js';
import { CURRENCIES, parseAmount } from '@/server/accounting/supplier.js';
import { correctMissingCost } from '@/server/accounting/cost-correction.js';
import { resendDocEmail } from '@/server/documents/delivery.js';

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

/**
 * "E-postayı tekrar gönder" (karar 111): kesilmiş bir FGO belgesinin MÜŞTERİ E-POSTASINI yeniden kuyruğa alır.
 * Yalnızca TAKİP e-postasıdır — FGO'da belge kesmez, numaraya ve faturalamaya dokunmaz (server/documents/delivery.js).
 */
export async function resendDocEmailAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const type = fd.get('type') === 'GLASS_ORDER' ? 'GLASS_ORDER' : 'PROFILE_ORDER';
  const r = await resendDocEmail(db, { docId: String(fd.get('docId') ?? ''), actor: await actorOf(user) });
  revalidatePath(RECEIVABLE_PATH[type]);
  redirect(`${RECEIVABLE_PATH[type]}?${r.ok ? 'ok=resent' : `mailError=${r.code}`}`);
}

/**
 * "TAKİP'ten kaldır" (karar 132): FGO'da ELLE silinmiş belgenin TAKİP'teki kaydını kaldırır. FGO'da hiçbir şey silinmez;
 * FGO'ya yalnızca belgenin durumu sorulur ve kayıt yalnızca FGO kesin olarak "belge yok" derse kaldırılır
 * (server/accounting/receivables.js → removeDocumentDeletedInFgo). Onay penceresi onaylanmadan gelen istek işlenmez.
 */
export async function removeDeletedDocAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const type = fd.get('type') === 'GLASS_ORDER' ? 'GLASS_ORDER' : 'PROFILE_ORDER';
  const path = RECEIVABLE_PATH[type];
  if (fd.get('confirmed') !== '1') redirect(`${path}?docError=CONFIRM`);
  const env = getEnv();
  const r = await removeDocumentDeletedInFgo(db, { docId: String(fd.get('docId') ?? ''), actor: await actorOf(user), secret: env.AUTH_SECRET, appUrl: env.APP_URL ?? '' });
  revalidatePath(RECEIVABLE_PATH.GLASS_ORDER);
  revalidatePath(RECEIVABLE_PATH.PROFILE_ORDER);
  if (r.ok && r.orderId) revalidatePath(`/siparisler/${r.orderId}`);
  const doc = 'doc' in r && r.doc ? `&doc=${encodeURIComponent(r.doc)}` : '';
  redirect(`${path}?${r.ok ? 'ok=docRemoved' : `docError=${r.code}`}${doc}`);
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

/**
 * Eksik fabrika maliyetinin girilmesi (karar 93): yalnızca maliyeti kayıtlı olmayan satıra, yalnızca maliyet.
 * Müşteri fiyatı bu işlemle değişmez. Kurallar ve denetim kaydı server/accounting/cost-correction.js'te.
 */
export async function correctCostAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const cost = parseAmount(fd.get('cost'));
  if (cost == null) redirect(`${SUPPLIER}?error=costBAD_COST#maliyet-eksik`);
  const r = await correctMissingCost(db, { lineId: String(fd.get('lineId') ?? ''), cost, actor: await actorOf(user) });
  revalidatePath(SUPPLIER);
  if (r.ok) revalidatePath(`/siparisler/${r.orderId}`);
  redirect(`${SUPPLIER}?${r.ok ? 'ok=cost' : `error=${['BAD_COST', 'COST_EXISTS', 'CONFIRMED'].includes(r.code) ? `cost${r.code}` : 'cost'}`}#maliyet-eksik`);
}
