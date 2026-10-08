'use server';

// Tedarikçi Siparişleri (Paket 6, kararlar 181–184). Kurallar ve yetki server/suppliers/service.js'te (her işlem
// SUPPLIER_MANAGE'i ayrıca denetler); burada yalnızca form okuma, dosya kaydı ve yönlendirme. Yalnızca yönetici.
// Tedarikçiye e-posta gönderen TEK işlem approveSendAction'dır (ve açık "Tekrar gönder"); taslak kaydı, ürün / tarih
// değişikliği, ek, tahmini yükleme tarihi e-posta göndermez.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getEnv } from '@/lib/env';
import { filesFrom } from '@/lib/storage';
import { discardFiles, storeFiles, type StoredUpload } from '@/lib/uploads';
import { fileProblem } from '@/server/orders/rules.js';
import {
  approveAndSend, attachFiles, cancelOrder, createDraftOrder, deleteDraftOrder, discardRevision, fileQuota, markReceived, removeFile,
  resendOrder, saveDraft, setEta, startRevision,
} from '@/server/suppliers/service.js';

const LIST = '/siparisler/tedarik';
const page = (id: string) => `${LIST}/${encodeURIComponent(id)}`;
const opts = () => ({ timeZone: getEnv().APP_TIMEZONE });
const idOf = (fd: FormData) => String(fd.get('orderId') ?? '');
/** Hata kodu (+ satır / dosya adı) adreste; metne sayfa çevirir. Dosya adı güvenli karakterlere indirilir. */
function fail(id: string, code: string, extra: { row?: number; name?: string } = {}, hash = ''): never {
  const q = new URLSearchParams({ error: code });
  if (extra.row != null) q.set('row', String(extra.row + 1));
  if (extra.name) q.set('name', String(extra.name).replace(/[^\p{L}\p{N} ._()-]+/gu, '_').slice(0, 120));
  redirect(`${page(id)}?${q}${hash}`);
}
function done(id: string, ok: string, hash = ''): never {
  revalidatePath(LIST);
  revalidatePath(page(id));
  redirect(`${page(id)}?ok=${ok}${hash}`);
}

// ---------- oluşturma ----------

/**
 * Yeni taslak. Satırlar: işaretli ürünler (pick) ve miktarları (qty-<ürün>), isteğe bağlı renk (color-<ürün>).
 * Ürün yoksa boş taslak. E-posta yok.
 */
export async function createOrderAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const supplierId = String(fd.get('supplierId') ?? '');
  const picked = [...new Set(fd.getAll('pick').map(String))].slice(0, 201);
  const items = picked.map((productId) => ({ productId, qty: fd.get(`qty-${productId}`), color: fd.get(`color-${productId}`) }));
  const from = String(fd.get('from') ?? '');
  function back(code: string, row?: number): never {
    const q = new URLSearchParams({ error: code, ...(row != null ? { row: String(row + 1) } : {}) });
    if (from === 'kritik') q.set('kritik', '1');
    else if (/^[a-z0-9]{8,40}$/i.test(from)) q.set('urun', from);
    redirect(`${LIST}/yeni?${q}`);
  }
  if (fd.get('needItems') === '1' && items.length === 0) back('NO_ITEMS');
  const r = await createDraftOrder(db, { supplierId, items }, await actorOf(admin), opts());
  if (!r.ok) back(r.code, r.index);
  revalidatePath(LIST);
  redirect(`${page(r.id)}?ok=created`);
}

// ---------- taslak ----------

/** Taslağı kaydeder (satırlar istemciden JSON; sunucu yeniden doğrular). E-posta GÖNDERMEZ. */
export async function saveDraftAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = idOf(fd);
  const raw = String(fd.get('lines') ?? '[]');
  let lines: unknown = null;
  try {
    lines = raw.length <= 400_000 ? JSON.parse(raw) : null;
  } catch {
    lines = null;
  }
  if (!Array.isArray(lines)) fail(id, 'LINES');
  const r = await saveDraft(db, {
    orderId: id, version: fd.get('version'), orderNo: fd.has('orderNo') ? fd.get('orderNo') : null, orderDate: fd.get('orderDate'), note: fd.get('note'), lines,
  }, await actorOf(admin), opts());
  if (!r.ok) fail(id, r.code, { row: r.index }, '#taslak');
  done(id, 'saved', '#taslak');
}

/**
 * "Siparişi onayla / gönder" — tedarikçiye gidişin tek yolu. Kaydedilmiş taslak kesinleşir ve e-posta kuyruğa yazılır
 * (aynı işlemde, bir kez). Çift tıklama / ikinci istek ikinci e-posta üretmez (servis: koşullu güncelleme + sürüm).
 */
export async function approveSendAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = idOf(fd);
  const r = await approveAndSend(db, { orderId: id, version: fd.get('version') }, await actorOf(admin));
  if (!r.ok) fail(id, r.code, { name: r.detail }, '#taslak');
  done(id, 'approved');
}

/** "Tekrar gönder": yalnızca gönderilemeyen siparişte, yöneticinin açık kararıyla */
export async function resendAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = idOf(fd);
  const r = await resendOrder(db, { orderId: id }, await actorOf(admin));
  if (!r.ok) fail(id, r.code, { name: r.detail });
  done(id, 'resent');
}

export async function startRevisionAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = idOf(fd);
  const r = await startRevision(db, { orderId: id, version: fd.get('version') }, await actorOf(admin));
  if (!r.ok) fail(id, r.code);
  done(id, 'revision', '#taslak');
}

export async function discardRevisionAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = idOf(fd);
  const r = await discardRevision(db, { orderId: id }, await actorOf(admin));
  if (!r.ok) fail(id, r.code);
  done(id, 'discarded');
}

export async function deleteDraftAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = idOf(fd);
  const r = await deleteDraftOrder(db, { orderId: id }, await actorOf(admin));
  if (!r.ok) fail(id, r.code);
  revalidatePath(LIST);
  redirect(`${LIST}?ok=deleted`);
}

// ---------- ekler ----------

/**
 * Teknik ek(ler): tür denetimi, revizyon sınırı (sayı / boyut) dosyalar diske yazılmadan ÖNCE; sonra ortak yükleme yolu
 * (storeFiles: içerik denetimi, antivirüs, kullanıcı kotası). Kayıt yazılamazsa saklanan dosyalar silinir.
 */
export async function uploadFilesAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = idOf(fd);
  const actor = await actorOf(admin);
  const files = filesFrom(fd, 'files');
  if (!files.length) fail(id, 'NO_FILE', {}, '#ekler');
  for (const f of files) {
    const p = fileProblem(f.name, f.size);
    if (p) fail(id, `UPLOAD_${p.code}`, { name: p.name }, '#ekler');
  }
  const q = await fileQuota(db, { orderId: id, files: files.map((f) => ({ name: f.name, size: f.size })) }, actor);
  if (!q.ok) fail(id, q.code, {}, '#ekler');
  const stored = await storeFiles(files, { userId: admin.id });
  if (!stored.ok) fail(id, `UPLOAD_${stored.problem.code}`, { name: stored.problem.name }, '#ekler');
  let r;
  try {
    r = await attachFiles(db, { orderId: id, stored: stored.stored.map((s: StoredUpload) => ({ ...s })) }, actor);
  } catch (e) {
    await discardFiles(stored.stored);
    throw e;
  }
  if (!r.ok) {
    await discardFiles(stored.stored);
    fail(id, r.code, {}, '#ekler');
  }
  done(id, 'files', '#ekler');
}

export async function removeFileAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = idOf(fd);
  const r = await removeFile(db, { orderId: id, fileId: String(fd.get('fileId') ?? '') }, await actorOf(admin));
  if (!r.ok) fail(id, r.code, {}, '#ekler');
  done(id, 'fileRemoved', '#ekler');
}

// ---------- tahmini yükleme tarihi, teslim, iptal ----------

/** Tahmini yükleme tarihi (yalnızca yönetici, elle). Boş = sil. E-posta göndermez. */
export async function etaAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = idOf(fd);
  const eta = fd.get('clear') === '1' ? '' : String(fd.get('eta') ?? '');
  const r = await setEta(db, { orderId: id, eta }, await actorOf(admin), opts());
  if (!r.ok) fail(id, r.code, {}, '#eta');
  done(id, r.eta ? 'eta' : 'etaCleared', '#eta');
}

/** Mal geldi: sipariş kapanır. Stok DEĞİŞMEZ (giriş Profil Stoğu ekranından). */
export async function receivedAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = idOf(fd);
  const r = await markReceived(db, { orderId: id }, await actorOf(admin));
  if (!r.ok) fail(id, r.code);
  done(id, 'received');
}

export async function cancelAction(fd: FormData) {
  const admin = await requirePermission('SUPPLIER_MANAGE');
  const id = idOf(fd);
  const r = await cancelOrder(db, { orderId: id, reason: fd.get('reason') }, await actorOf(admin));
  if (!r.ok) fail(id, r.code, {}, '#iptal');
  done(id, 'cancelled');
}
