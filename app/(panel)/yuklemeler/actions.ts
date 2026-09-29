'use server';

// Yükleme sekmesi: sandık ölçü ve ağırlıkları (satış ya da yönetici). Kurallar server/loading/crates.js'te.
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { parseDateOnly } from '@/server/orders/rules.js';
import { saveDayCrates, validateCrates } from '@/server/loading/crates.js';

export type CratesState = { error?: string; ok?: string; savedAt?: number };

export async function saveDayCratesAction(_prev: CratesState, formData: FormData): Promise<CratesState> {
  const user = await requirePermission('CRATE_EDIT');
  const { t } = await getT();
  const day = String(formData.get('day') ?? '');
  const customerId = String(formData.get('customerId') ?? '');
  if (!parseDateOnly(day) || !customerId) return { error: t('loading.day.crates.err.NO_ORDERS') };
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get('rows') ?? '[]'));
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) return { error: t('loading.day.crates.err.CONFLICT') };
  const v = validateCrates(raw.slice(0, 200));
  if (!v.ok) {
    return { error: v.errors.slice(0, 5).map((e) => t(`loading.day.crates.err.${e.code}` as MsgKey, { row: e.row })).join(' ') };
  }
  const r = await saveDayCrates(db, { day, customerId, rows: v.rows, actor: await actorOf(user) });
  if (!r.ok) return { error: t(`loading.day.crates.err.${r.code}` as MsgKey, { list: (r.numbers ?? []).join(', ') }) };
  revalidatePath('/yuklemeler');
  return { ok: t('loading.day.crates.saved'), savedAt: Date.now() };
}
