'use server';

// Yükleme sekmesi: sandık ölçü ve ağırlıkları (satış ya da yönetici; kurallar server/loading/crates.js'te) ve
// yükleme onayı (yalnızca yönetici; kurallar server/loading/confirmation.js'te).
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { confirmLoading } from '@/server/loading/confirmation.js';
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

/**
 * "Eksiksiz Yüklendi": seçilen yükleme gününü onaylar (karar 92). Yalnızca yönetici (LOADING_CONFIRM); yetki burada ve
 * confirmLoading içinde sunucuda kontrol edilir — düğmenin görünmemesi yetki değildir. `key`: yöneticinin ekranda gördüğü
 * önizlemenin parmak izi; liste bu arada değiştiyse onay reddedilir.
 */
export async function confirmLoadingAction(formData: FormData) {
  const user = await requirePermission('LOADING_CONFIRM');
  const day = String(formData.get('day') ?? '');
  const back = (q: string) => `/yuklemeler?${parseDateOnly(day) ? `gun=${day}&` : ''}${q}#onay`;
  const r = await confirmLoading(db, {
    day, key: String(formData.get('key') ?? ''), note: String(formData.get('note') ?? ''), actor: await actorOf(user),
  });
  revalidatePath('/yuklemeler');
  revalidatePath('/admin/muhasebe/tedarikci');
  redirect(r.ok ? back(`onay=ok&n=${r.orders}`) : back(`onayHata=${r.code}`));
}
