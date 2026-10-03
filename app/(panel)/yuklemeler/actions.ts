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
import { assignGuestCrate, removeGuestCrate, saveDayCrates, validateCrates } from '@/server/loading/crates.js';
import { cancelReplan, replanNotLoaded } from '@/server/loading/replan.js';

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
  // Yüklenmeyen cam (karar 102): "nl:<kalem>" = adet, "nlr:<kalem>" = neden, "nln:<kalem>" = açıklama. Boş / 0 adet → o satır eksiksiz.
  const notLoaded = [...formData.keys()].filter((k) => k.startsWith('nl:')).map((k) => {
    const key = k.slice(3);
    return { key, quantity: String(formData.get(k) ?? ''), reason: String(formData.get(`nlr:${key}`) ?? ''), note: String(formData.get(`nln:${key}`) ?? '') };
  });
  const r = await confirmLoading(db, {
    day, key: String(formData.get('key') ?? ''), note: String(formData.get('note') ?? ''), notLoaded, actor: await actorOf(user),
  });
  revalidatePath('/yuklemeler');
  revalidatePath('/admin/muhasebe/tedarikci');
  redirect(r.ok ? back(`onay=ok&n=${r.orders}${r.notLoaded ? `&yok=${r.notLoaded}` : ''}`) : back(`onayHata=${r.code}`));
}

/**
 * "Yeniden planla": onaylı yüklemede yüklenmeyen kalanı ileri bir yükleme gününe aktarır (karar 102). Yalnızca yönetici
 * (LOADING_CONFIRM); yetki burada ve replanNotLoaded içinde sunucuda kontrol edilir. Eski onay kaydı değişmez.
 */
export async function replanAction(formData: FormData) {
  const user = await requirePermission('LOADING_CONFIRM');
  const day = String(formData.get('day') ?? '');
  const back = (q: string) => `/yuklemeler?${parseDateOnly(day) ? `gun=${day}&` : ''}${q}#yuklenmeyen`;
  const r = await replanNotLoaded(db, {
    itemId: String(formData.get('itemId') ?? ''), day: String(formData.get('newDay') ?? ''),
    quantity: formData.has('quantity') ? String(formData.get('quantity')) : null, actor: await actorOf(user),
  });
  revalidatePath('/yuklemeler');
  redirect(r.ok ? back(`aktar=${r.moved ? 'moved' : 'planned'}`) : back(`aktarHata=${r.code}`));
}

/** Etkin aktarımdan vazgeçer (yalnızca yönetici). */
export async function cancelReplanAction(formData: FormData) {
  const user = await requirePermission('LOADING_CONFIRM');
  const day = String(formData.get('day') ?? '');
  const back = (q: string) => `/yuklemeler?${parseDateOnly(day) ? `gun=${day}&` : ''}${q}#yuklenmeyen`;
  const r = await cancelReplan(db, { replanId: String(formData.get('replanId') ?? ''), actor: await actorOf(user) });
  revalidatePath('/yuklemeler');
  redirect(r.ok ? back('aktar=cancelled') : back(`aktarHata=${r.code}`));
}

/**
 * Fiziksel yerleşim (karar 103): siparişi aynı yükleme gününde başka bir müşterinin sandığına koyar / çıkarır. Yalnızca
 * yönetici (LOADING_CONFIRM); yetki burada ve crates.js içinde sunucuda kontrol edilir. Ticari hiçbir şey değişmez.
 */
export async function guestCrateAction(formData: FormData) {
  const user = await requirePermission('LOADING_CONFIRM');
  const day = String(formData.get('day') ?? '');
  const back = (q: string) => `/yuklemeler?${parseDateOnly(day) ? `gun=${day}&` : ''}${q}#gun`;
  const orderId = String(formData.get('orderId') ?? '');
  const crateId = String(formData.get('crateId') ?? '');
  const remove = formData.get('do') === 'remove';
  const r = remove
    ? await removeGuestCrate(db, { orderId, crateId, actor: await actorOf(user) })
    : parseDateOnly(day) ? await assignGuestCrate(db, { day, orderId, crateId, actor: await actorOf(user) }) : { ok: false as const, code: 'NOT_SAME_LOADING' };
  revalidatePath('/yuklemeler');
  redirect(r.ok ? back(`sandik=${remove ? 'removed' : 'assigned'}`) : back(`sandikHata=${r.code}`));
}
