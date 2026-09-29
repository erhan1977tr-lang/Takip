'use server';

// Cam kataloğu (yönetici). Kurallar server/catalog/glass.js'te; burada form okuma ve mesajlar.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { XlsxError, readXlsx } from '@/server/files/xlsx.js';
import {
  MAX_IMPORT_ROWS, applyCatalogImport, changeGlass, glassKey, glassLabel, parseCatalogSheet, planCatalogImport, saveGlass, validateGlass,
  type GlassInput,
} from '@/server/catalog/glass.js';

const back = (q: string) => `/admin/katalog?${q}`;
const MAX_FILE = 5 * 1024 * 1024;

export async function saveGlassAction(formData: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const id = String(formData.get('id') ?? '') || null;
  const res = validateGlass({
    nameTr: formData.get('nameTr'), colorTr: formData.get('colorTr'), nameRo: formData.get('nameRo'), colorRo: formData.get('colorRo'),
    nameEn: formData.get('nameEn'), colorEn: formData.get('colorEn'), weightKgM2: formData.get('weightKgM2'),
    isActive: formData.get('isActive') ? 'Evet' : 'Hayır',
  });
  const edit = id ? `&duzenle=${encodeURIComponent(id)}` : '';
  if (!res.ok) redirect(back(`error=${res.errors[0].toLowerCase()}${edit}`));
  const r = await saveGlass(db, id, res.value, await actorOf(admin));
  if (!r.ok) redirect(back(`error=${r.code.toLowerCase()}${edit}`));
  revalidatePath('/admin/katalog');
  redirect(back(id ? 'ok=saved' : 'ok=added'));
}

export async function changeGlassAction(formData: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const id = String(formData.get('id') ?? '');
  const intent = String(formData.get('intent') ?? '');
  if (!['toggle', 'up', 'down'].includes(intent)) redirect(back('error=not_found'));
  const found = await changeGlass(db, id, intent as 'toggle' | 'up' | 'down', await actorOf(admin));
  if (!found) redirect(back('error=not_found'));
  revalidatePath('/admin/katalog');
  const keep = String(formData.get('keep') ?? '');
  redirect(back(`ok=saved${keep ? `&${keep}` : ''}#g-${id}`));
}

export type ImportPreview = {
  error?: string;
  preview?: {
    fileName: string;
    created: string[];
    updated: { label: string; fields: string[] }[];
    unchanged: number;
    untouched: number;
    errors: { row: number; label: string; problems: string[] }[];
    payload: string;
  };
};

/** 1. adım: Excel okunur, doğrulanır ve mevcut katalogla karşılaştırılır (henüz kaydedilmez). */
export async function previewImportAction(_prev: ImportPreview, formData: FormData): Promise<ImportPreview> {
  await requirePermission('CATALOG_MANAGE');
  const { t } = await getT();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: t('admin.catalog.import.noFile') };
  if (file.size > MAX_FILE) return { error: t('admin.catalog.import.tooBig') };
  let rows;
  try {
    rows = readXlsx(Buffer.from(await file.arrayBuffer())).rows;
  } catch (e) {
    if (e instanceof XlsxError) return { error: t('admin.catalog.import.badFile') };
    throw e;
  }
  const parsed = parseCatalogSheet(rows);
  if (!parsed.ok) {
    return { error: parsed.error === 'HEADERS' ? t('admin.catalog.import.headers') : parsed.error === 'EMPTY' ? t('admin.catalog.import.empty') : t('admin.catalog.import.tooMany', { n: MAX_IMPORT_ROWS }) };
  }
  const existing = await db.glassProduct.findMany();
  const plan = planCatalogImport(existing, parsed.items.map((i) => i.value));
  const field = (f: string) => t(`admin.catalog.field.${f}` as MsgKey);
  return {
    preview: {
      fileName: file.name,
      created: plan.create.map((v) => glassLabel(v, 'tr')),
      updated: plan.update.map((u) => ({ label: glassLabel(u.before, 'tr'), fields: u.changes.map(field) })),
      unchanged: plan.unchanged,
      untouched: plan.untouched.length,
      errors: parsed.errors.map((e) => ({ row: e.row, label: e.label, problems: e.codes.map((c) => t(`admin.catalog.problem.${c}` as MsgKey)) })),
      payload: JSON.stringify(parsed.items.map((i) => i.value)),
    },
  };
}

/** 2. adım: önizlemesi görülen camlar kaydedilir. Gelen veri yeniden doğrulanır (tarayıcıya güvenilmez). */
export async function confirmImportAction(formData: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get('payload') ?? ''));
  } catch {
    redirect(back('error=import_failed'));
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IMPORT_ROWS) redirect(back('error=import_failed'));
  const items: GlassInput[] = [];
  const seen = new Set<string>();
  for (const r of raw as Record<string, unknown>[]) {
    const v = validateGlass({ ...r, isActive: r?.isActive === false ? 'Hayır' : 'Evet' });
    if (!v.ok) redirect(back('error=import_failed'));
    const key = glassKey(v.value.nameTr, v.value.colorTr);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(v.value);
  }
  const s = await applyCatalogImport(db, items, await actorOf(admin));
  revalidatePath('/admin/katalog');
  redirect(back(`ok=imported&c=${s.created}&u=${s.updated}`));
}
