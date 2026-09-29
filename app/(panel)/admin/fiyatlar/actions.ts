'use server';

// Fiyat tabloları (yönetici). Kurallar server/pricing/tables.js'te; burada form okuma ve mesajlar.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { can } from '@/server/auth/permissions.js';
import { glassLabel } from '@/server/catalog/glass.js';
import { XlsxError, readXlsx } from '@/server/files/xlsx.js';
import {
  MAX_PRICE_ROWS, assignTable, changeTable, parsePrice, parsePriceSheet, planPriceImport, savePrices, saveTable, validateTable,
} from '@/server/pricing/tables.js';

const MAX_FILE = 5 * 1024 * 1024;
const back = (tableId: string | null, q: string) => `/admin/fiyatlar?${tableId ? `tablo=${encodeURIComponent(tableId)}&` : ''}${q}`;

/** Tablo ekle (tableId boş) ya da bilgilerini düzenle. */
export async function saveTableAction(formData: FormData) {
  const admin = await requirePermission('PRICE_TABLE_MANAGE');
  const id = String(formData.get('tableId') ?? '') || null;
  const res = validateTable({
    name: formData.get('name'), currency: formData.get('currency'),
    holePrice: formData.get('holePrice'), cncPrice: formData.get('cncPrice'),
  });
  if (!res.ok) redirect(back(id, `error=invalid&what=${res.errors.join(',')}`));
  const r = await saveTable(db, id, res.value, await actorOf(admin));
  if (!r.ok) redirect(back(id, `error=${r.code.toLowerCase()}`));
  revalidatePath('/admin/fiyatlar');
  redirect(back(r.id, id ? 'ok=saved' : 'ok=created'));
}

/** Pasif / aktif, varsayılan yap, sil. */
export async function changeTableAction(formData: FormData) {
  const admin = await requirePermission('PRICE_TABLE_MANAGE');
  const id = String(formData.get('tableId') ?? '');
  const intent = String(formData.get('intent') ?? '');
  if (!['toggle', 'default', 'delete'].includes(intent)) redirect(back(null, 'error=not_found'));
  const r = await changeTable(db, id, intent as 'toggle' | 'default' | 'delete', await actorOf(admin));
  revalidatePath('/admin/fiyatlar');
  if (!r.ok) redirect(back(id, `error=${r.code.toLowerCase()}`));
  redirect(intent === 'delete' ? back(null, 'ok=deleted') : back(id, 'ok=saved'));
}

export type SavePricesState = { error?: string; ok?: string; savedAt?: number };

/** Fiyat tablosu ekranından: yalnızca değişen fiyatlar gelir (camId → fiyat, boş → fiyat kaldırılır). */
export async function savePricesAction(_prev: SavePricesState, formData: FormData): Promise<SavePricesState> {
  const admin = await requirePermission('PRICE_TABLE_MANAGE');
  const { t } = await getT();
  const tableId = String(formData.get('tableId') ?? '');
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get('changes') ?? '{}'));
  } catch {
    return { error: t('pricing.msg.not_found') };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: t('pricing.msg.not_found') };
  const entries = Object.entries(raw as Record<string, unknown>).slice(0, MAX_PRICE_ROWS);
  const changes: Record<string, number | null> = {};
  for (const [gid, v] of entries) {
    const p = parsePrice(v);
    if (Number.isNaN(p)) {
      const g = await db.glassProduct.findUnique({ where: { id: gid } });
      return { error: t('pricing.msg.bad_price', { glass: g ? glassLabel(g, 'tr') : gid }) };
    }
    changes[gid] = p;
  }
  const r = await savePrices(db, tableId, changes, await actorOf(admin));
  if (!r.ok) return { error: t('pricing.msg.not_found') };
  revalidatePath('/admin/fiyatlar');
  return { ok: r.changed ? t('pricing.msg.pricesSaved', { n: r.changed }) : t('pricing.msg.noChange'), savedAt: Date.now() };
}

export type PriceImportPreview = {
  error?: string;
  preview?: {
    fileName: string;
    set: { label: string; before: number | null; after: number }[];
    unchanged: number;
    blank: number;
    unknown: { row: number; label: string }[];
    errors: { row: number; label: string; problems: string[] }[];
    fixed: string | null;
    payload: string;
  };
};

/** 1. adım: Excel okunur ve tablonun fiyatlarıyla karşılaştırılır (henüz kaydedilmez). */
export async function previewPriceImportAction(_prev: PriceImportPreview, formData: FormData): Promise<PriceImportPreview> {
  await requirePermission('PRICE_TABLE_MANAGE');
  const { t } = await getT();
  const tableId = String(formData.get('tableId') ?? '');
  const table = await db.priceTable.findUnique({ where: { id: tableId }, include: { items: true } });
  if (!table) return { error: t('pricing.msg.not_found') };
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: t('pricing.import.noFile') };
  if (file.size > MAX_FILE) return { error: t('pricing.import.tooBig') };
  let rows;
  try {
    rows = readXlsx(Buffer.from(await file.arrayBuffer())).rows;
  } catch (e) {
    if (e instanceof XlsxError) return { error: t('pricing.import.badFile') };
    throw e;
  }
  const sheet = parsePriceSheet(rows);
  if (!sheet.ok) {
    return { error: sheet.error === 'HEADERS' ? t('pricing.import.headers') : sheet.error === 'EMPTY' ? t('pricing.import.empty') : t('pricing.import.tooMany', { n: MAX_PRICE_ROWS }) };
  }
  const glasses = await db.glassProduct.findMany();
  const current = new Map(table.items.map((i) => [i.glassProductId, Number(i.unitPrice)]));
  const plan = planPriceImport(table, glasses, current, sheet);
  if (plan.currencyMismatch) return { error: t('pricing.import.currencyMismatch', { file: sheet.currency ?? '', table: table.currency }) };
  const fixedEntries = (['holePrice', 'cncPrice'] as const).flatMap((k) => {
    const e = plan.extra[k];
    return e ? [{ k, before: e.before, after: e.after }] : [];
  });
  const fixed = fixedEntries.length
    ? fixedEntries.map((e) => `${t(`pricing.fixed.${e.k}` as MsgKey)} ${e.before ?? '—'} → ${e.after}`).join(', ')
    : null;
  return {
    preview: {
      fileName: file.name,
      set: plan.set.map((s) => ({ label: s.label, before: s.before, after: s.after })),
      unchanged: plan.unchanged,
      blank: sheet.blank,
      unknown: plan.unknown,
      errors: sheet.errors.map((e) => ({ row: e.row, label: e.label, problems: e.codes.map((c) => t(`pricing.rowProblem.${c}` as MsgKey)) })),
      fixed,
      payload: JSON.stringify({
        prices: Object.fromEntries(plan.set.map((s) => [s.glassProductId, s.after])),
        extra: Object.fromEntries(fixedEntries.map((e) => [e.k, e.after])),
      }),
    },
  };
}

/** 2. adım: önizlemesi görülen fiyatlar kaydedilir (gelen veri yeniden doğrulanır). */
export async function confirmPriceImportAction(formData: FormData) {
  const admin = await requirePermission('PRICE_TABLE_MANAGE');
  const tableId = String(formData.get('tableId') ?? '');
  let raw: { prices?: Record<string, unknown>; extra?: Record<string, unknown> };
  try {
    raw = JSON.parse(String(formData.get('payload') ?? ''));
  } catch {
    redirect(back(tableId, 'error=import_failed'));
  }
  const prices: Record<string, number> = {};
  for (const [gid, v] of Object.entries(raw?.prices ?? {}).slice(0, MAX_PRICE_ROWS)) {
    const p = parsePrice(v);
    if (p == null || Number.isNaN(p)) redirect(back(tableId, 'error=import_failed'));
    prices[gid] = p;
  }
  const extra: { holePrice?: number; cncPrice?: number } = {};
  for (const k of ['holePrice', 'cncPrice'] as const) {
    if (raw?.extra?.[k] === undefined) continue;
    const p = parsePrice(raw.extra[k]);
    if (p == null || Number.isNaN(p)) redirect(back(tableId, 'error=import_failed'));
    extra[k] = p;
  }
  const r = await savePrices(db, tableId, prices, await actorOf(admin), extra, 'excel');
  if (!r.ok) redirect(back(tableId, 'error=not_found'));
  revalidatePath('/admin/fiyatlar');
  redirect(back(tableId, `ok=imported&n=${r.changed}`));
}

/** Satışçıyı tabloya ata ya da atamayı kaldır. */
export async function assignTableAction(formData: FormData) {
  const admin = await requirePermission('PRICE_TABLE_MANAGE');
  const tableId = String(formData.get('tableId') ?? '');
  const userId = String(formData.get('userId') ?? '');
  const remove = formData.get('intent') === 'unassign';
  const r = await assignTable(db, userId, remove ? null : tableId, await actorOf(admin), (role: string) => can(role, 'OFFER_PREPARE'));
  revalidatePath('/admin/fiyatlar');
  redirect(back(tableId, r.ok ? 'ok=assigned' : 'error=not_found'));
}
