'use server';

// Yeni cam siparişi. Numara kuralı ve kayıt server/orders/create.js'te (createGlassOrder);
// burada form okuma, dosya kaydı (içerik kontrolü + antivirüs) ve mesajlar.
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { fileProblemText, workflowErrorText } from '@/lib/labels';
import { actorOf } from '@/lib/actor';
import { filesFrom } from '@/lib/storage';
import { discardFiles, storeFiles } from '@/lib/uploads';
import { fileProblem } from '@/server/orders/rules.js';
import { createGlassOrder } from '@/server/orders/create.js';
import { WorkflowError } from '@/server/domain/workflow.js';

export type NewOrderState = { error?: string; values?: { title: string; no: string; glasses: { id: string; qty: string }[] } };

export async function createOrderAction(_prev: NewOrderState, formData: FormData): Promise<NewOrderState> {
  const user = await requirePermission('ORDER_CREATE');
  const { t } = await getT();
  const firm = user.customer;
  const title = String(formData.get('title') ?? '').trim().slice(0, 160);
  const noRaw = String(formData.get('customerOrderNo') ?? '').trim();
  const suggestedRaw = String(formData.get('suggestedNo') ?? '').trim();
  const glassIds = formData.getAll('glassId').map(String);
  const glassQty = formData.getAll('glassQty').map(String);
  const glasses = glassIds.map((id, i) => ({ id, qty: glassQty[i] ?? '1' })).filter((g) => g.id);
  const values = { title, no: noRaw, glasses };
  const fail = (error: string) => ({ error, values });

  if (!firm || firm.type !== 'CUSTOMER' || !firm.prefix) return fail(t('newOrder.errors.noFirm'));
  if (!title) return fail(t('newOrder.errors.titleRequired'));
  const no = Number(noRaw);
  if (!Number.isInteger(no) || no <= 0 || no > 9_999_999) return fail(t('newOrder.errors.badNumber'));
  const suggestedNo = /^\d+$/.test(suggestedRaw) ? Number(suggestedRaw) : null;

  const files = filesFrom(formData, 'files');
  if (files.length === 0) return fail(t('newOrder.errors.noFiles'));
  if (files.length > 20) return fail(t('newOrder.errors.tooManyFiles'));
  for (const f of files) {
    const p = fileProblemText(t, fileProblem(f.name, f.size));
    if (p) return fail(p);
  }

  if (glasses.length === 0) return fail(t('newOrder.errors.noGlass'));
  const catalog = await db.glassProduct.findMany({ where: { id: { in: glasses.map((g) => g.id) }, isActive: true } });
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const items: { glassName: string; camAdedi: number }[] = [];
  for (const g of glasses) {
    const product = byId.get(g.id);
    const qty = Number(g.qty);
    if (!product) return fail(t('newOrder.errors.glassGone'));
    if (!Number.isInteger(qty) || qty <= 0 || qty > 100_000) return fail(t('newOrder.errors.badQty'));
    items.push({ glassName: product.name, camAdedi: qty });
  }

  // Dosyalar önce kaydedilir (içerik kontrolü + antivirüs); sipariş kaydı başarısız olursa geri silinir.
  const stored = await storeFiles(files, { userId: user.id });
  if (!stored.ok) return fail(fileProblemText(t, stored.problem)!);
  let orderId: string;
  try {
    const created = await createGlassOrder(db, {
      actor: await actorOf(user), firm: { id: firm.id, prefix: firm.prefix, camEtiket: firm.camEtiket, sandikEtiket: firm.sandikEtiket },
      title, requestedNo: no, suggestedNo, items, files: stored.stored,
    });
    orderId = created.id;
  } catch (err) {
    await discardFiles(stored.stored);
    if (err instanceof WorkflowError) return fail(workflowErrorText(t, err.code, err.details as Record<string, unknown>));
    console.error('Sipariş oluşturulamadı', err);
    return fail(t('newOrder.errors.saveFailed'));
  }
  redirect(`/siparisler/${orderId}?ok=created`);
}
