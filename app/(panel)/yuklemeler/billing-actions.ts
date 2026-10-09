'use server';

// Onaylı yüklemeden müşteri faturası ve müşteri proformasının avans faturası (Aşama 7D-3; yalnızca yönetici,
// ACCOUNTING_MANAGE). Kurallar server/glass/invoice-batch.js'te; yetki orada da denetlenir.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { parseDateOnly } from '@/server/orders/rules.js';
import { dispatchBatchJobs, reviewFailedBatch } from '@/server/glass/batch.js';
import { createAdvanceBatch, createInvoiceBatch } from '@/server/glass/invoice-batch.js';

const PROFORMA_PAGE = '/admin/muhasebe/cam/proforma';
/** Dönüş adresi: yükleme günü (Faturalama bölümü) ya da müşteri proforması sayfası */
function back(fd: FormData, q: Record<string, string>, selected: string[] | null = null) {
  const day = String(fd.get('day') ?? '');
  const p = new URLSearchParams(q);
  // Sipariş seçimi (karar 125): hata sonrası aynı seçimle aynı önizleme açılır
  if (selected) {
    p.set('fsec', '1');
    for (const id of selected) p.append('fs', id);
  }
  if (parseDateOnly(day)) return `/yuklemeler?gun=${day}&${p.toString()}#faturalama`;
  const customerId = String(fd.get('customerId') ?? '');
  if (customerId) p.set('musteri', customerId);
  return `${PROFORMA_PAGE}?${p.toString()}#partiler`;
}
function refresh() {
  revalidatePath('/yuklemeler');
  revalidatePath('/admin/muhasebe/cam');
  revalidatePath(PROFORMA_PAGE);
}

/** "Fatura oluştur": onaylı yüklemenin bir müşteri grubu için tek fatura; kuyruğa alınır ve hemen denenir */
export async function createInvoiceAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const rate = String(fd.get('fxRate') ?? '').trim();
  const groupKey = String(fd.get('groupKey') ?? '');
  // Sipariş seçimi (karar 125): önizlemede seçili siparişler; alan yoksa grubun uygun siparişlerinin hepsi. Sunucu yeniden doğrular.
  const orderIds = fd.get('selected') === '1' ? [...new Set(fd.getAll('orderId').map(String).filter(Boolean))].slice(0, 500) : null;
  const r = await createInvoiceBatch(db, {
    day: String(fd.get('day') ?? ''), groupKey, previewKey: String(fd.get('previewKey') ?? ''), orderIds, manualRate: rate || null, actor: await actorOf(user),
  });
  if (!r.ok) redirect(back(fd, { faturaHata: r.code, ...(rate || orderIds ? { fk: groupKey } : {}), ...(rate ? { fkur: rate } : {}) }, orderIds));
  await dispatchBatchJobs(db, { onlyBatchId: r.batchId });
  refresh();
  redirect(back(fd, { fatura: 'created' }));
}

/** "Avans faturası kes": müşteri proformasına gelen, avansı kesilmemiş tahsilat kadar (yükleme öncesi ya da sonrası) */
export async function createAdvanceAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  // ack: aynı müşteride aynı tutar eşleşmesini yönetici gördü ve onayladı (karar 208) — sunucu eşleşmeleri yeniden hesaplar
  const r = await createAdvanceBatch(db, { proformaBatchId: String(fd.get('proformaBatchId') ?? ''), actor: await actorOf(user), ack: String(fd.get('ack') ?? '') || null });
  if (!r.ok) redirect(back(fd, { faturaHata: r.code }));
  await dispatchBatchJobs(db, { onlyBatchId: r.batchId });
  refresh();
  redirect(back(fd, { fatura: 'advance' }));
}

/** Kesilemeyen fatura / avans partisi: yeniden dene ya da vazgeç (kapsam yeniden faturalanabilir; yükleme onayı değişmez) */
export async function reviewInvoiceBatchAction(fd: FormData) {
  const user = await requirePermission('ACCOUNTING_MANAGE');
  const batchId = String(fd.get('batchId') ?? '');
  const action = fd.get('do') === 'void' ? 'void' : 'retry';
  const r = await reviewFailedBatch(db, { batchId, action, actor: await actorOf(user) });
  if (!r.ok) redirect(back(fd, { faturaHata: r.code }));
  if (action === 'retry') await dispatchBatchJobs(db, { onlyBatchId: batchId });
  refresh();
  redirect(back(fd, { fatura: action }));
}
