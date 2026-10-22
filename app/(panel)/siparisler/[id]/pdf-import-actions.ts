'use server';

// Fabrika PDF'i aktarımı (karar 255): yükleme + ön izleme + aktarma. Kurallar server/orders/pdf-import/* ve
// transitions.js → import_offer_pdf; burada yalnızca oturum, form okuma, dosya kaydı ve mesaj. Yetki: OFFER_PREPARE
// (yönetici, yönetici yardımcısı, satış) — her işlevin ilk adımı; servis ayrıca denetler.
import fs from 'node:fs/promises';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { requirePermission } from '@/lib/auth/session';
import { getT } from '@/lib/i18n';
import { actorOf } from '@/lib/actor';
import { audit } from '@/lib/audit';
import { fileProblemText, workflowErrorText } from '@/lib/labels';
import { filesFrom, resolveKey } from '@/lib/storage';
import { discardFiles, storeFiles } from '@/lib/uploads';
import { deliverInAppNow } from '@/lib/notifications';
import { runOrderAction, WorkflowError } from '@/server/orders/transitions.js';
import { importPreview, importTarget, MAX_PDFS, PDF_IMPORT_LIMITS, recordUploads } from '@/server/orders/pdf-import/service.js';

type Problem = { code: string; [k: string]: unknown };
export type PdfImportPreview = {
  ok: true;
  version: number;
  empty: { id: string; description: string; adet: number }[];
  imports: {
    id: string; name: string; status: string; scanStatus: string; factoryNo: string | null; fingerprint: string | null;
    blocking: Problem[]; warnings: Problem[];
    plan: null | {
      header: { factoryNo: string | null; orderDate: string | null; deliveryDate: string | null; projectCode: string | null };
      rows: {
        sourceRow: number; description: string; glassKey: string; glassLabel: string | null; poz: string; pozFromPdf: boolean; shaped: boolean;
        en: number; boy: number; adet: number; m2: number; totalM2: number; takipM2: number;
        unitPrice: number; discount: number; netUnit: number | null; amount: number; takipAmount: number; takipOps: number; explained: boolean;
        ops: { name: string; kind: string | null; qty: number | null; perPiece: number | null; unitPrice: number; discount: number; netUnit: number | null; amount: number }[];
      }[];
      checks: { a: { pdfSum: number; subtotal: number | null; ok: boolean; diff: number | null }; b: { takipTotal: number; pdfSum: number; subtotal: number | null; diff: number; explained: boolean }; vat: number | null; grandTotal: number | null };
      glassChoices: { key: string; description: string; code: string | null; auto: boolean; selected: string | null; selectedLabel: string | null; candidates: { id: string; label: string }[] }[];
      opChoices: { key: string; name: string; auto: boolean; kind: string | null }[];
      lineCount: number;
    };
  }[];
};
export type PdfImportResult = PdfImportPreview | { ok: false; error: string };
type Choices = { glass?: Record<string, string>; ops?: Record<string, string> };

const ID = /^[a-z0-9]{10,40}$/i;
/** Tarayıcıdan gelen seçimler: yalnızca kısa metin anahtarları ve değerleri (sunucu ayrıca katalog / tür listesiyle doğrular) */
function cleanChoices(raw: unknown): Choices {
  const out: Choices = { glass: {}, ops: {} };
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  for (const k of ['glass', 'ops'] as const) {
    const m = src[k] && typeof src[k] === 'object' ? (src[k] as Record<string, unknown>) : {};
    for (const [key, v] of Object.entries(m).slice(0, 200)) {
      if (typeof v === 'string' && key.length <= 400 && v.length <= 40) out[k]![key] = v;
    }
  }
  return out;
}
const cleanIds = (raw: unknown) => (Array.isArray(raw) ? raw.map(String).filter((x) => ID.test(x)).slice(0, MAX_PDFS * 3) : []);

async function errorText(code: string) {
  const { t } = await getT();
  if (code === 'NOT_EDITABLE' || code === 'NOT_FOUND') return t('offer.pdf.notEditable');
  return t('offer.pdf.failed');
}

/** PDF'leri yükler (içerik denetimi + antivirüs), okur ve ön izlemeyi döndürür. */
export async function uploadFactoryPdfAction(formData: FormData): Promise<PdfImportResult> {
  const user = await requirePermission('OFFER_PREPARE');
  const { t, locale } = await getT();
  const orderId = String(formData.get('id') ?? '');
  const files = filesFrom(formData, 'pdfs');
  if (!files.length) return { ok: false, error: t('offer.pdf.noFiles') };
  if (files.length > MAX_PDFS) return { ok: false, error: t('offer.pdf.tooMany', { n: MAX_PDFS }) };
  for (const f of files) {
    if (!/\.pdf$/i.test(f.name)) return { ok: false, error: t('offer.pdf.notPdf', { name: f.name }) };
    if (f.size > PDF_IMPORT_LIMITS.maxBytes) return { ok: false, error: t('offer.pdf.tooBig', { name: f.name, mb: PDF_IMPORT_LIMITS.maxBytes / 1024 / 1024 }) };
  }
  // İşlemi yapan ve hedef, dosyalar saklanmadan ÖNCE belirlenir (karar 153): düzenlenemeyen teklife dosya yazılmaz
  const actor = await actorOf(user);
  const target = await importTarget(db, { orderId, actor });
  if (!target.ok) return { ok: false, error: await errorText(target.code) };
  const stored = await storeFiles(files, { userId: user.id, orderId: target.orderId });
  if (!stored.ok) return { ok: false, error: fileProblemText(t, stored.problem)! };
  let ids: string[];
  try {
    const res = await recordUploads(db, {
      actor, orderId: target.orderId, stored: stored.stored,
      readFile: async (key: string) => {
        const full = resolveKey(key);
        if (!full) throw new Error('key');
        return new Uint8Array(await fs.readFile(full));
      },
    });
    if (!res.ok) { await discardFiles(stored.stored); return { ok: false, error: await errorText(res.code) }; }
    await discardFiles(res.discard);
    ids = res.ids;
  } catch (e) {
    await discardFiles(stored.stored);
    console.error('[pdf aktarımı] yükleme kaydedilemedi', e instanceof Error ? e.name : 'hata');
    return { ok: false, error: t('offer.pdf.failed') };
  }
  // Dosya adı denetim kaydına yazılmaz (müşteri adı taşıyabilir): yalnızca sayı ve kayıt kimlikleri
  await audit('OFFER_PDF_UPLOADED', 'Order', target.orderId, user.id, { imports: ids });
  const preview = await importPreview(db, { actor, orderId: target.orderId, importIds: ids, choices: {}, locale });
  if (!preview.ok) return { ok: false, error: await errorText(preview.code) };
  return preview as PdfImportPreview;
}

/** Seçimler (cam cinsi, işlem türü) ya da aktarılacak PDF'ler değişince ön izleme yeniden hesaplanır. Hiçbir şey yazmaz. */
export async function previewFactoryPdfAction(orderId: string, importIds: unknown, choices: unknown): Promise<PdfImportResult> {
  const user = await requirePermission('OFFER_PREPARE');
  const { locale } = await getT();
  const res = await importPreview(db, { actor: await actorOf(user), orderId: String(orderId ?? ''), importIds: cleanIds(importIds), choices: cleanChoices(choices), locale });
  if (!res.ok) return { ok: false, error: await errorText(res.code) };
  return res as PdfImportPreview;
}

/**
 * Onaylanan ön izlemeyi teklif tablosuna aktarır (iş akışı işlemi import_offer_pdf). Ön izleme sunucuda yeniden hesaplanır;
 * değiştiyse ya da engel varsa hiçbir şey yazılmaz. Teklif yöneticiye gönderilmez.
 */
export async function applyFactoryPdfAction(input: { orderId: string; version: number; imports: { id: string; fingerprint: string }[]; choices: unknown; dropEmpty: unknown }): Promise<{ ok: false; error: string }> {
  const user = await requirePermission('OFFER_PREPARE');
  const { t } = await getT();
  const orderId = String(input?.orderId ?? '');
  const imports = (Array.isArray(input?.imports) ? input.imports : []).slice(0, MAX_PDFS)
    .map((i) => ({ id: String(i?.id ?? ''), fingerprint: String(i?.fingerprint ?? '').slice(0, 64) })).filter((i) => ID.test(i.id));
  if (!imports.length) return { ok: false, error: t('offer.pdf.nothing') };
  // Sayfanın sipariş sürümü zorunlu (karar 300 — P0): sürümsüz istek arada yapılan değişikliğin üzerine yazamaz
  if (!Number.isInteger(input?.version) || Number(input.version) < 0) return { ok: false, error: workflowErrorText(t, 'CONFLICT') };
  try {
    const res = await runOrderAction(db, {
      orderId, action: 'import_offer_pdf', actor: await actorOf(user),
      payload: { imports, choices: cleanChoices(input?.choices), dropEmpty: cleanIds(input?.dropEmpty), expectedVersion: Number(input?.version) },
    });
    await deliverInAppNow(res.outboxIds);
  } catch (e) {
    if (e instanceof WorkflowError) return { ok: false, error: workflowErrorText(t, e.code, e.details as Record<string, unknown>) };
    console.error('[pdf aktarımı] aktarılamadı', e instanceof Error ? e.name : 'hata');
    return { ok: false, error: t('offer.pdf.failed') };
  }
  revalidatePath(`/siparisler/${orderId}`);
  revalidatePath('/teklifler');
  redirect(`/siparisler/${orderId}?ok=pdf_imported#teklif`);
}
