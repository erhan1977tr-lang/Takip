'use server';

// Profil stoğu (yönetici, Aşama 6). Kurallar server/profile/stock.js'te.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { XlsxError, readXlsx } from '@/server/files/xlsx.js';
import { addStockMovement, applyStockImport, parseStockSheet } from '@/server/profile/stock.js';

const PATH = '/admin/stok';
const back = (q: string) => `${PATH}?${q}`;

export async function stockMoveAction(fd: FormData) {
  const admin = await requirePermission('STOCK_MANAGE');
  const kind = fd.get('kind') === 'SAYIM' ? 'SAYIM' : 'GIRIS';
  const raw = String(fd.get('qty') ?? '').trim();
  const qty = /^-?\d+$/.test(raw) ? Number(raw) : NaN;
  const r = await addStockMovement(db, { productId: String(fd.get('productId') ?? ''), kind, qty, note: String(fd.get('note') ?? '') }, await actorOf(admin));
  if (!r.ok) redirect(back(`error=${{ NOT_FOUND: 'not_found', BAD_QTY: 'bad_qty', NO_CHANGE: 'no_change' }[r.code]}`));
  revalidatePath(PATH);
  redirect(back(`ok=saved&d=${r.delta > 0 ? `%2B${r.delta}` : r.delta}`));
}

export async function stockImportAction(fd: FormData) {
  const admin = await requirePermission('STOCK_MANAGE');
  const mode = fd.get('mode') === 'SAYIM' ? 'SAYIM' : 'GIRIS';
  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0 || file.size > 5 * 1024 * 1024) redirect(back('error=import'));
  let rows;
  try {
    rows = readXlsx(Buffer.from(await file.arrayBuffer())).rows;
  } catch (e) {
    if (e instanceof XlsxError) redirect(back('error=import'));
    throw e;
  }
  const parsed = parseStockSheet(rows);
  if (!parsed.ok) redirect(back('error=import'));
  const r = await applyStockImport(db, parsed.items, mode, await actorOf(admin));
  revalidatePath(PATH);
  redirect(back(`ok=imported&n=${r.applied}${r.unknown.length ? `&u=${encodeURIComponent(r.unknown.slice(0, 20).join(', '))}` : ''}`));
}
