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
import { correctLoading, packCorrection, planCorrection, unpackCorrection } from '@/server/loading/correction.js';

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
  // Sipariş seçimi formdan gelmez (karar 234): yeni sandık firmanın o günkü kendi siparişlerine, kayıtlı sandık bağlarını korur
  const r = await saveDayCrates(db, { day, customerId, rows: v.rows, actor: await actorOf(user), links: 'auto' });
  if (!r.ok) return { error: t(`loading.day.crates.err.${r.code}` as MsgKey, { list: (r.numbers ?? []).join(', ') }) };
  revalidatePath('/yuklemeler');
  return { ok: t('loading.day.crates.saved'), savedAt: Date.now() };
}

/**
 * "Yükleme yapıldı" (Paket 7, karar 189; eski adı "Eksiksiz Yüklendi"): seçilen yükleme gününün fiilen yüklendiğini kaydeder
 * (karar 92). Önizlemedeki bütün kalemler YÜKLENDİ olarak kaydedilir; yüklenmeyen cam onaydan sonra "Düzelt" ile kaydedilir
 * (karar 105) — bu işlem yüklenmeyen adet almaz. Yalnızca yönetici (LOADING_CONFIRM); yetki burada ve confirmLoading içinde
 * sunucuda kontrol edilir — düğmenin görünmemesi yetki değildir. `key`: yöneticinin ekranda gördüğü önizlemenin parmak izi;
 * liste bu arada değiştiyse onay reddedilir. Aynı gün ikinci kez kaydedilemez (ALREADY_CONFIRMED). Fatura hatırlatma sayacı bu
 * kaydın anından başlar (server/accounting/uninvoiced.js). Sipariş durumu değişmez; hiçbir FGO belgesi kesilmez.
 */
export async function confirmLoadingAction(formData: FormData) {
  const user = await requirePermission('LOADING_CONFIRM');
  const day = String(formData.get('day') ?? '');
  const back = (q: string) => `/yuklemeler?${parseDateOnly(day) ? `gun=${day}&` : ''}${q}#onay`;
  const r = await confirmLoading(db, {
    day, key: String(formData.get('key') ?? ''), note: String(formData.get('note') ?? ''), notLoaded: [], actor: await actorOf(user),
  });
  revalidatePath('/yuklemeler');
  revalidatePath('/admin/muhasebe/tedarikci');
  redirect(r.ok ? back(`onay=ok&n=${r.orders}${r.notLoaded ? `&yok=${r.notLoaded}` : ''}`) : back(`onayHata=${r.code}`));
}

type CorrectionEntry = { key: string; quantity: string; reason: string; note: string };

/**
 * "Düzelt" → önizleme (karar 105): yöneticinin girdiği yeni yüklenmeyen adetler doğrulanır ve yalnızca DEĞİŞEN kapsamlar
 * önizleme adresine taşınır; henüz hiçbir şey kaydedilmez. Yalnızca yönetici (LOADING_CONFIRM).
 * Alanlar: "cq:<kapsam>" = yeni yüklenmeyen adet, "cr:<kapsam>" = neden, "cn:<kapsam>" = açıklama, "reason" = düzeltme nedeni.
 */
export async function previewCorrectionAction(formData: FormData) {
  await requirePermission('LOADING_CONFIRM');
  const day = String(formData.get('day') ?? '');
  const back = (q: string) => `/yuklemeler?${parseDateOnly(day) ? `gun=${day}&` : ''}${q}#duzelt`;
  const input: CorrectionEntry[] = [...formData.keys()].filter((k) => k.startsWith('cq:')).map((k) => {
    const key = k.slice(3);
    return { key, quantity: String(formData.get(k) ?? ''), reason: String(formData.get(`cr:${key}`) ?? ''), note: String(formData.get(`cn:${key}`) ?? '') };
  });
  const plan = await planCorrection(db, { day, input });
  if (!plan.ok) redirect(back(`duzeltHata=${plan.code}`));
  const changed = new Set(plan.changes.map((c) => c.key));
  const reason = String(formData.get('reason') ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  redirect(back(`dz=${packCorrection(input.filter((x) => changed.has(x.key)))}&dzn=${encodeURIComponent(reason)}`));
}

/**
 * Düzeltmeyi kaydeder (karar 105): onay ve kalemleri değişmez; düzeltme kaydı ve yeni kalemler eklenir. Yalnızca yönetici
 * (LOADING_CONFIRM); yetki burada ve correctLoading içinde sunucuda kontrol edilir. `key`: yöneticinin gördüğü önizlemenin
 * parmak izi. Hiçbir FGO belgesi kesilmez / değiştirilmez.
 */
export async function correctLoadingAction(formData: FormData) {
  const user = await requirePermission('LOADING_CONFIRM');
  const day = String(formData.get('day') ?? '');
  const dz = String(formData.get('dz') ?? '');
  const reason = String(formData.get('reason') ?? '');
  const back = (q: string, hash = 'onay') => `/yuklemeler?${parseDateOnly(day) ? `gun=${day}&` : ''}${q}#${hash}`;
  // Önizleme sayfasının taşıdığı girdi (yalnızca değişen kapsamlar); her alan correctLoading içinde yeniden doğrulanır
  const r = await correctLoading(db, { day, input: unpackCorrection(dz), reason, key: String(formData.get('key') ?? ''), actor: await actorOf(user) });
  revalidatePath('/yuklemeler');
  revalidatePath('/admin/muhasebe/tedarikci');
  if (r.ok) redirect(back(`duzeltme=ok&rev=${r.revision}${r.actionRequired ? '&muh=1' : ''}`));
  // Önizleme hâlâ geçerliyse (neden eksik, durum değişti) önizlemede kalınır; değilse düzeltme formuna dönülür
  redirect(['REASON_REQUIRED', 'STALE_PREVIEW', 'DOWNSTREAM_CONFLICT', 'QUEUED_BILLING', 'FAILED_BILLING'].includes(r.code)
    ? back(`dz=${encodeURIComponent(dz)}&dzn=${encodeURIComponent(reason.slice(0, 500))}&duzeltHata=${r.code}`, 'duzelt')
    : back(`duzeltHata=${r.code}`, 'duzelt'));
}

/**
 * "Yeniden planla": onaylı yüklemede yüklenmeyen camı — tamamını ya da bir kısmını (karar 106) — ileri bir yükleme gününe
 * aktarır (karar 102). `replanId` verilirse o aktarım başka güne alınır. Yalnızca yönetici (LOADING_CONFIRM); yetki burada
 * ve replanNotLoaded içinde sunucuda kontrol edilir; adet ve kapasite sunucuda doğrulanır. Eski onay kaydı değişmez.
 */
export async function replanAction(formData: FormData) {
  const user = await requirePermission('LOADING_CONFIRM');
  const day = String(formData.get('day') ?? '');
  const back = (q: string) => `/yuklemeler?${parseDateOnly(day) ? `gun=${day}&` : ''}${q}#yuklenmeyen`;
  const r = await replanNotLoaded(db, {
    itemId: String(formData.get('itemId') ?? ''), day: String(formData.get('newDay') ?? ''),
    quantity: formData.has('quantity') ? String(formData.get('quantity')) : null,
    replaceId: String(formData.get('replanId') ?? '') || null, actor: await actorOf(user),
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
 * "Özel durum" — misafir yükün SANDIĞI (karar 124): satış ya da yönetici (CRATE_EDIT), yöneticinin seçtiği ev sahibi firmanın
 * o günkü sandıklarından birini seçer; sandık boş bırakılırsa seçim kaldırılır (yeniden "sandık seçimi bekliyor").
 * Firma burada seçilmez: sandığın o firmanın ve o günün sandığı olduğunu sunucu doğrular (server/loading/crates.js).
 * Alanlar: day, orderId, crateId (seçilen; boş = bekliyor), current (şu anki sandık), do=remove (eski kaydı kaldır).
 */
export async function guestCrateAction(formData: FormData) {
  const user = await requirePermission('CRATE_EDIT');
  const day = String(formData.get('day') ?? '');
  // Dönüşte işlemin yapıldığı firmanın "Sandık" bölümü açık gelir (acik = firma kimliği; yalnızca sayfadaki aç / kapa durumu)
  const open = /^[a-z0-9]{1,40}$/i.test(String(formData.get('acik') ?? '')) ? String(formData.get('acik')) : '';
  const back = (q: string) => {
    const parts = [parseDateOnly(day) ? `gun=${day}` : '', open ? `acik=${open}` : '', q].filter(Boolean).join('&');
    return `/yuklemeler${parts ? `?${parts}` : ''}${open ? `#firma-${open}` : '#gun'}`;
  };
  const orderId = String(formData.get('orderId') ?? '');
  const crateId = String(formData.get('crateId') ?? '');
  const current = String(formData.get('current') ?? '');
  const actor = await actorOf(user);
  const remove = formData.get('do') === 'remove' || (!crateId && !!current);
  // Seçim değişmedi (boş → boş ya da aynı sandık): hiçbir şey yazılmaz, bildirim de gitmez
  if (!remove && (!crateId || crateId === current)) redirect(back(''));
  const r = remove
    ? await removeGuestCrate(db, { orderId, crateId: crateId || current, actor })
    : parseDateOnly(day) ? await assignGuestCrate(db, { day, orderId, crateId, actor }) : { ok: false as const, code: 'NOT_SAME_LOADING' };
  revalidatePath('/yuklemeler');
  if (!r.ok && r.code === 'ALREADY_ASSIGNED') redirect(back(''));
  redirect(r.ok ? back(`sandik=${remove ? 'removed' : 'assigned'}`) : back(`sandikHata=${r.code}`));
}
