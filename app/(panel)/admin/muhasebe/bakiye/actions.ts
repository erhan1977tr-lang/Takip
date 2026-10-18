'use server';

// Müşteri Bakiyeleri (DÜZELTME 10 Aşama 2C, karar 295): TAKİP içi mahsup kaydı, geri alma, "FGO'ya işlendi". Kurallar ve yetki
// server/finance/credit-service.js'te (ACCOUNTING_MANAGE — burada ve serviste ayrı ayrı). Hiçbir işlem FGO / ANAF'a gitmez.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { closeOffset, createOffset } from '@/server/finance/credit-service.js';

const PATH = '/admin/muhasebe/bakiye';
const back = (customerId: string, q: string, hash = '') => `${PATH}?c=${encodeURIComponent(customerId)}&${q}${hash}`;

export async function createOffsetAction(fd: FormData) {
  const admin = await requirePermission('ACCOUNTING_MANAGE');
  const customerId = String(fd.get('customerId') ?? '');
  const r = await createOffset(db, {
    customerId, sourceChain: String(fd.get('sourceChain') ?? ''), targetOrderId: String(fd.get('targetOrderId') ?? ''),
    amount: fd.get('amount'), note: fd.get('note'), confirm: fd.get('confirm'), requestKey: fd.get('requestKey'),
  }, await actorOf(admin));
  if (!r.ok) redirect(back(customerId, `error=${encodeURIComponent(r.code)}`, '#mahsup-formu'));
  revalidatePath(PATH);
  redirect(back(customerId, `ok=${r.duplicate ? 'duplicate' : 'created'}`, '#mahsuplar'));
}

export async function closeOffsetAction(fd: FormData) {
  const admin = await requirePermission('ACCOUNTING_MANAGE');
  const customerId = String(fd.get('customerId') ?? '');
  const picked = String(fd.get('mode') ?? '');
  if (picked !== 'FGO_RECORDED' && picked !== 'REVERSED') redirect(back(customerId, 'error=MODE', '#mahsuplar'));
  const mode = picked as 'FGO_RECORDED' | 'REVERSED';
  const r = await closeOffset(db, { offsetId: String(fd.get('offsetId') ?? ''), mode, reason: fd.get('reason'), confirm: fd.get('confirm'), fgoRef: fd.get('fgoRef') }, await actorOf(admin));
  if (!r.ok) redirect(back(customerId, `error=${encodeURIComponent(r.code)}`, '#mahsuplar'));
  revalidatePath(PATH);
  redirect(back(customerId, `ok=${mode}`, '#mahsuplar'));
}
