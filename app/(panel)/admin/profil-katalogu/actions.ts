'use server';

// Profil kataloğu (yönetici, Aşama 6). Kurallar server/profile/catalog.js'te; burada form okuma, görsel kaydı ve mesajlar.
import fsp from 'node:fs/promises';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { resolveKey } from '@/lib/storage';
import { discardFiles, storeFiles } from '@/lib/uploads';
import { XlsxError, readXlsx } from '@/server/files/xlsx.js';
import {
  MAX_IMAGE_BYTES, MAX_PRODUCTS_IMPORT, applyProductImport, changeProduct, parseProductSheet, planProductImport, saveCategory, saveProduct,
  setProductImage, validateCategory, validateProduct, type ProductInput,
} from '@/server/profile/catalog.js';

const PATH = '/admin/profil-katalogu';
const back = (q: string) => `${PATH}?${q}`;
const MAX_FILE = 5 * 1024 * 1024;

export async function saveCategoryAction(fd: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const id = String(fd.get('categoryId') ?? '') || null;
  const res = validateCategory({ code: fd.get('code'), nameRo: fd.get('nameRo'), nameTr: fd.get('nameTr'), isActive: !!fd.get('isActive') });
  if (!res.ok) redirect(back(`error=${res.errors[0].toLowerCase()}`));
  const r = await saveCategory(db, id, res.value, await actorOf(admin));
  if (!r.ok) redirect(back(`error=${r.code.toLowerCase()}`));
  revalidatePath(PATH);
  redirect(back(id ? 'ok=saved' : 'ok=added'));
}

export async function saveProductAction(fd: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const id = String(fd.get('productId') ?? '') || null;
  const edit = id ? `&urun=${encodeURIComponent(id)}` : '';
  const res = validateProduct({
    code: fd.get('code'), categoryCode: fd.get('categoryCode'), nameRo: fd.get('nameRo'), nameTr: fd.get('nameTr'),
    unitCode: fd.get('unitCode'), listPrice: fd.get('listPrice'), isActive: fd.get('isActive') ? 'Evet' : 'Hayır',
  });
  // Düzenlemede kod değişmez (formda salt okunur; saveProduct da kaydedilmiş kodu korur)
  if (!res.ok) redirect(back(`error=${res.errors[0].toLowerCase()}${edit}`));
  const r = await saveProduct(db, id, res.value, await actorOf(admin));
  if (!r.ok) redirect(back(`error=${r.code.toLowerCase()}${edit}`));
  revalidatePath(PATH);
  redirect(back(`${id ? 'ok=saved' : 'ok=added'}#p-${r.id}`));
}

export async function changeProductAction(fd: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const id = String(fd.get('productId') ?? '');
  const intent = String(fd.get('intent') ?? '');
  if (!['toggle', 'up', 'down'].includes(intent)) redirect(back('error=not_found'));
  const found = await changeProduct(db, id, intent as 'toggle' | 'up' | 'down', await actorOf(admin));
  if (!found) redirect(back('error=not_found'));
  revalidatePath(PATH);
  redirect(back(`ok=saved#p-${id}`));
}

/** Ürün görseli: içerik kontrolü (gerçekten JPG/PNG mi) ve antivirüs, sonra veritabanına (ProfileImage). */
export async function productImageAction(fd: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const id = String(fd.get('productId') ?? '');
  const edit = `&urun=${encodeURIComponent(id)}`;
  if (fd.get('remove') === '1') {
    const r = await setProductImage(db, id, null, await actorOf(admin));
    if (!r.ok) redirect(back(`error=not_found${edit}`));
    revalidatePath(PATH);
    redirect(back(`ok=image${edit}`));
  }
  const file = fd.get('image');
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_IMAGE_BYTES || !/\.(jpe?g|png)$/i.test(file.name)) redirect(back(`error=image${edit}`));
  const stored = await storeFiles([file], { userId: admin.id });
  if (!stored.ok) redirect(back(`error=${stored.problem.code === 'infected' ? 'image_infected' : 'image'}${edit}`));
  const s = stored.stored[0];
  if (!['image/jpeg', 'image/png'].includes(s.mime)) {
    await discardFiles([s]);
    redirect(back(`error=image${edit}`));
  }
  // Görsel veritabanında saklanır; diskteki kopya her durumda (okuma hatasında da) silinir (karar 153)
  const full = resolveKey(s.storageKey);
  let data: Buffer | null = null;
  try {
    data = full ? await fsp.readFile(full) : null;
  } finally {
    await discardFiles([s]);
  }
  if (!data) redirect(back(`error=image${edit}`));
  const r = await setProductImage(db, id, { data, mime: s.mime, size: s.size, checksum: s.checksum, name: s.name }, await actorOf(admin));
  if (!r.ok) redirect(back(`error=not_found${edit}`));
  revalidatePath(PATH);
  redirect(back(`ok=image${edit}`));
}

export type ProductImportPreview = {
  error?: string;
  preview?: {
    fileName: string; created: string[]; updated: { label: string; fields: string[] }[]; unchanged: number; badCategory: string[];
    errors: { row: number; label: string; problems: string[] }[]; payload: string;
  };
};

export async function previewProductImportAction(_prev: ProductImportPreview, fd: FormData): Promise<ProductImportPreview> {
  await requirePermission('CATALOG_MANAGE');
  const { t } = await getT();
  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: t('profile.catalog.import.noFile') };
  if (file.size > MAX_FILE) return { error: t('profile.catalog.import.tooBig') };
  let rows;
  try {
    rows = readXlsx(Buffer.from(await file.arrayBuffer())).rows;
  } catch (e) {
    if (e instanceof XlsxError) return { error: t('profile.catalog.import.badFile') };
    throw e;
  }
  const parsed = parseProductSheet(rows);
  if (!parsed.ok) {
    return { error: parsed.error === 'HEADERS' ? t('profile.catalog.import.headers') : parsed.error === 'EMPTY' ? t('profile.catalog.import.empty') : t('profile.catalog.import.tooMany', { n: MAX_PRODUCTS_IMPORT }) };
  }
  const [existing, categories] = await Promise.all([db.profileProduct.findMany({ include: { category: true } }), db.profileCategory.findMany()]);
  const plan = planProductImport(existing, categories.map((c) => c.code), parsed.items.map((i) => i.value));
  const field = (f: string) => t(`profile.catalog.field.${f === 'categoryCode' ? 'category' : f === 'unitCode' ? 'unit' : f}` as MsgKey);
  return {
    preview: {
      fileName: file.name,
      created: plan.create.map((v) => `${v.code} — ${v.nameRo}`),
      updated: plan.update.map((u) => ({ label: `${u.after.code} — ${u.after.nameRo}`, fields: u.changes.map(field) })),
      unchanged: plan.unchanged,
      badCategory: plan.badCategory.map((v) => `${v.code} (${v.categoryCode})`),
      errors: parsed.errors.map((e) => ({ row: e.row, label: e.label, problems: e.codes.map((c) => t(`profile.catalog.problem.${c}` as MsgKey)) })),
      payload: JSON.stringify(parsed.items.map((i) => i.value)),
    },
  };
}

export async function confirmProductImportAction(fd: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  let raw: unknown;
  try {
    raw = JSON.parse(String(fd.get('payload') ?? ''));
  } catch {
    redirect(back('error=import_failed'));
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PRODUCTS_IMPORT) redirect(back('error=import_failed'));
  const items: ProductInput[] = [];
  const seen = new Set<string>();
  for (const r of raw as Record<string, unknown>[]) {
    const v = validateProduct({ ...r, isActive: r?.isActive === false ? 'Hayır' : 'Evet' });
    if (!v.ok) redirect(back('error=import_failed'));
    if (seen.has(v.value.code)) continue;
    seen.add(v.value.code);
    items.push(v.value);
  }
  const s = await applyProductImport(db, items, await actorOf(admin));
  revalidatePath(PATH);
  redirect(back(`ok=imported&c=${s.created}&u=${s.updated}`));
}
