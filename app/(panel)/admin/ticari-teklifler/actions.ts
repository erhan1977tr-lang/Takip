'use server';

// Bağımsız ticari teklif (3.83.0, karar 277). Kurallar ve yetki server/commercial/service.js'te (her işlem
// COMMERCIAL_OFFER_MANAGE'i ayrıca denetler); burada yalnızca form okuma ve yönlendirme. Sipariş, FGO, stok, e-posta YOK.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { actorOf } from '@/lib/actor';
import { getT, type MsgKey } from '@/lib/i18n';
import { calcErrorText } from '@/lib/profile-calc';
import { runRailingCalc } from '@/server/profile/calc-service.js';
import { createOffer, issueOffer, newRevision, saveDraft, setOfferStatus } from '@/server/commercial/service.js';
import { fromScaled, packsFor, perMlContent, toScaled } from '@/server/commercial/rules.js';
import { profileCalcLimits } from '@/server/profile/limits.js';
import { COMMERCIAL_IMPORT_MAX_BYTES } from '@/server/commercial/excel-import.js';
import { excelName, readCommercialExcel } from '@/server/commercial/excel-read.js';

const LIST = '/admin/ticari-teklifler';
const page = (id: string) => `${LIST}/${encodeURIComponent(id)}`;
const PERM = 'COMMERCIAL_OFFER_MANAGE' as const;

/** Formdaki teklif verisi (JSON; sunucu her şeyi yeniden doğrular). Okunamazsa null. */
function offerOf(fd: FormData): Record<string, unknown> | null {
  const raw = String(fd.get('offer') ?? '');
  if (!raw || raw.length > 600_000) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
function fail(base: string, code: string, extra: { section?: string; index?: number } = {}): never {
  const q = new URLSearchParams({ error: code });
  if (extra.section) q.set('section', extra.section === 'glass' ? 'glass' : 'profile');
  if (extra.index != null) q.set('row', String(extra.index + 1));
  redirect(`${base}?${q}`);
}
function done(id: string, ok: string): never {
  revalidatePath(LIST);
  revalidatePath(page(id));
  redirect(`${page(id)}?ok=${ok}`);
}
const idOf = (fd: FormData) => String(fd.get('offerId') ?? '').slice(0, 64);

export async function createOfferAction(fd: FormData) {
  const admin = await requirePermission(PERM);
  const v = offerOf(fd);
  if (!v) fail(`${LIST}/yeni`, 'DATA');
  const r = await createOffer(db, v, await actorOf(admin));
  if (!r.ok) fail(`${LIST}/yeni`, r.code, r as { section?: string; index?: number });
  revalidatePath(LIST);
  redirect(`${page(r.id)}?ok=created`);
}

export async function saveOfferAction(fd: FormData) {
  const admin = await requirePermission(PERM);
  const id = idOf(fd);
  const v = offerOf(fd);
  if (!v) fail(page(id), 'DATA');
  const r = await saveDraft(db, { ...v, offerId: id, editVersion: fd.get('editVersion') }, await actorOf(admin));
  if (!r.ok) fail(page(id), r.code, r as { section?: string; index?: number });
  done(id, 'saved');
}

export async function issueOfferAction(fd: FormData) {
  const admin = await requirePermission(PERM);
  const id = idOf(fd);
  const r = await issueOffer(db, { offerId: id, editVersion: fd.get('editVersion') }, await actorOf(admin));
  if (!r.ok) fail(page(id), r.code);
  done(id, 'issued');
}

export async function reviseOfferAction(fd: FormData) {
  const admin = await requirePermission(PERM);
  const id = idOf(fd);
  const r = await newRevision(db, { offerId: id, editVersion: fd.get('editVersion') }, await actorOf(admin));
  if (!r.ok) fail(page(id), r.code);
  done(id, 'revised');
}

export async function statusOfferAction(fd: FormData) {
  const admin = await requirePermission(PERM);
  const id = idOf(fd);
  const r = await setOfferStatus(db, { offerId: id, editVersion: fd.get('editVersion'), status: fd.get('status'), note: fd.get('note') }, await actorOf(admin));
  if (!r.ok) fail(page(id), r.code);
  done(id, 'status');
}

export type OfferCalcLine = { productId: string; meters: string | null; qty: number | null; color: string };
export type OfferCalcResult = { ok: true; lines: OfferCalcLine[] } | { ok: false; errors: string[] };

/** İstemciden gelen değer: yalnızca kısa metin */
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : '');

/**
 * Profil hesaplayıcısı (mevcut kural — runRailingCalc, yalnızca okur): metre → ürün miktarları. Metreyle fiyatlanan üründe
 * satıra metre yazılır (paket sayısı hesaplayıcınınkiyle aynı: ⌈ihtiyaç ÷ içerik⌉); diğerlerinde adet. Kayıt yazmaz.
 */
export async function calcOfferProfileAction(input: {
  profileId?: unknown; handrailId?: unknown; color?: unknown; thicknessId?: unknown; meters?: unknown;
}): Promise<OfferCalcResult> {
  const user = await requirePermission(PERM);
  const { t } = await getT();
  if (!profileCalcLimits.calc(user.id)) return { ok: false, errors: [t('profile.calc.rateLimit')] };
  const color = str(input?.color, 20);
  const res = await runRailingCalc(db, {
    profileId: str(input?.profileId, 64), handrailId: str(input?.handrailId, 64), color, thicknessId: str(input?.thicknessId, 64), meters: str(input?.meters, 32),
  });
  const system = res.systems.map((s) => s.code).join(' + ');
  if (!res.ok) return { ok: false, errors: res.errors.map((e) => calcErrorText(t, e, { system, customer: false })) };
  const products = await db.profileProduct.findMany({ where: { id: { in: res.lines.map((l) => l.productId) } }, select: { id: true, packMeasure: true, packContent: true } });
  const byId = new Map(products.map((p) => [p.id, p]));
  return {
    ok: true,
    lines: res.lines.map((l) => {
      const p = byId.get(l.productId);
      const content = p ? perMlContent({ packMeasure: p.packMeasure, packContent: p.packContent?.toString() ?? null }) : null;
      let meters: string | null = null;
      if (content) {
        // Satırın metresi hesaplayıcının ihtiyacı (cm'ye yukarı yuvarlı). Paket içeriği mm hassasiyetindeyse yuvarlama sınırında
        // paket sayısı farklı çıkabilir: o zaman tam paketlerin metresi (cm'ye aşağı) — paket sayısı hesaplayıcınınkiyle aynı kalır
        meters = l.need;
        if (packsFor(meters, content) !== l.qty) {
          const full = (BigInt(l.qty) * (toScaled(content, 3) ?? 0n)) / 10n; // 10⁻³ → 10⁻² (aşağı)
          const alt = fromScaled(full, 2);
          if (packsFor(alt, content) === l.qty) meters = alt;
        }
      }
      return { productId: l.productId, meters, qty: content ? null : l.qty, color: l.colored && (color === 'RAL7016' || color === 'ELOXAT') ? color : '' };
    }),
  };
}

export type ExcelReadResult = { ok: true; rows: string[][]; fingerprint: string; name: string } | { ok: false; error: string };
/**
 * Cam bölümüne Excel'den aktarma (4.1.0, karar 298) — dosyanın OKUNMASI: yalnızca ön izleme satırları döner; dosya saklanmaz,
 * teklif yazılmaz (satırlar düzenleyiciye eklenir, kayıt yönetici "Kaydet"e basınca). Sıra: yetki → dosya türü ve boyutu (dosya
 * belleğe alınmadan) → okuma (server/commercial/excel-read.js: mevcut okuyucular + ön izleme sınırları).
 */
export async function readCommercialExcelAction(fd: FormData): Promise<ExcelReadResult> {
  await requirePermission(PERM);
  const { t } = await getT();
  const err = (code: string): ExcelReadResult => ({ ok: false, error: t(`commercial.import.errors.${code}` as MsgKey) });
  const file = fd.get('file');
  if (!(file instanceof File) || file.size === 0) return err('EMPTY');
  if (!excelName(file.name)) return err('TYPE');
  if (file.size > COMMERCIAL_IMPORT_MAX_BYTES) return err('TOO_BIG');
  const res = readCommercialExcel(Buffer.from(await file.arrayBuffer()));
  if (!res.ok) return err(res.error);
  return { ok: true, rows: res.rows, fingerprint: res.fingerprint, name: file.name.slice(0, 120) };
}
