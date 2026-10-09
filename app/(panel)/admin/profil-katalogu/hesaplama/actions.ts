'use server';

// Profil hesaplayıcısının ayarları (yönetici; Paket 5, karar 175–176). Kurallar ve denetim server/profile/calc-service.js'te
// (servis yetkiyi ayrıca denetler); burada yalnızca form okuma ve mesaj kodları.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { addCalcItem, addThickness, removeCalcItem, saveSystem, setThicknessActive, updateCalcItem } from '@/server/profile/calc-service.js';

const PATH = '/admin/profil-katalogu/hesaplama';
const CODES: Record<string, string> = {
  FORBIDDEN: 'forbidden', BAD_MM: 'mm', EXISTS: 'exists', NOT_FOUND: 'not_found', CODE: 'code', NAME: 'name', SLOT: 'slot', COLOR: 'color',
  PER_METER: 'per_meter', PRODUCT: 'product', THICKNESS: 'thickness', OVERLAP: 'overlap', NO_PRODUCT: 'no_product', KIND: 'kind', LABEL: 'label',
};
const field = (fd: FormData, k: string) => String(fd.get(k) ?? '');
/** Sonuç adresi: açık sistem (varsa) + mesaj + bölüm */
function go(q: string, system: string | null, anchor: string): never {
  redirect(`${PATH}?${system ? `sistem=${encodeURIComponent(system)}&` : ''}${q}#${anchor}`);
}
function fail(code: string, system: string | null, anchor: string): never {
  go(`error=${Object.hasOwn(CODES, code) ? CODES[code] : 'not_found'}`, system, anchor);
}

export async function addThicknessAction(fd: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const system = field(fd, 'sistem') || null;
  const r = await addThickness(db, { mm: field(fd, 'mm'), label: field(fd, 'label') }, await actorOf(admin));
  if (!r.ok) fail(r.code, system, 'kalinlik');
  revalidatePath(PATH);
  go('ok=added', system, 'kalinlik');
}

export async function toggleThicknessAction(fd: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const system = field(fd, 'sistem') || null;
  const r = await setThicknessActive(db, { id: field(fd, 'id'), active: field(fd, 'active') === '1' }, await actorOf(admin));
  if (!r.ok) fail(r.code, system, 'kalinlik');
  revalidatePath(PATH);
  go('ok=saved', system, 'kalinlik');
}

export async function saveSystemAction(fd: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const id = field(fd, 'id') || null;
  // kind: müşteri hesaplayıcısındaki yeri (karar 203) — formda her zaman var (boş = gösterilmez)
  const r = await saveSystem(db, { id, code: field(fd, 'code'), nameRo: field(fd, 'nameRo'), nameTr: field(fd, 'nameTr'), isActive: !!fd.get('isActive'), kind: field(fd, 'kind') || null }, await actorOf(admin));
  if (!r.ok) fail(r.code, id, id ? 'sistem' : 'yeni-sistem');
  revalidatePath(PATH);
  go(id ? 'ok=saved' : 'ok=added', r.id, 'sistem');
}

export async function addItemAction(fd: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const systemId = field(fd, 'systemId');
  const r = await addCalcItem(db, {
    systemId, slot: field(fd, 'slot'), productId: field(fd, 'productId') || null, color: field(fd, 'color') || null,
    thicknessId: field(fd, 'thicknessId') || null, perMeter: field(fd, 'perMeter'),
  }, await actorOf(admin));
  if (!r.ok) fail(r.code, systemId, 'satir-ekle');
  revalidatePath(PATH);
  go('ok=added', systemId, 'kalemler');
}

export async function updateItemAction(fd: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const systemId = field(fd, 'systemId');
  const r = await updateCalcItem(db, { id: field(fd, 'id'), perMeter: field(fd, 'perMeter') }, await actorOf(admin));
  if (!r.ok) fail(r.code, systemId, 'kalemler');
  revalidatePath(PATH);
  go('ok=saved', systemId, 'kalemler');
}

export async function removeItemAction(fd: FormData) {
  const admin = await requirePermission('CATALOG_MANAGE');
  const systemId = field(fd, 'systemId');
  const r = await removeCalcItem(db, { id: field(fd, 'id') }, await actorOf(admin));
  if (!r.ok) fail(r.code, systemId, 'kalemler');
  revalidatePath(PATH);
  go('ok=removed', systemId, 'kalemler');
}
