// Taslak sipariş (Aşama 3): müşteri yeni sipariş formunu yarım bırakıp sonra devam eder.
// Taslak sipariş değildir: numarası, SLA'sı, geçmişi yoktur; satışın ve çizimin hiçbir listesine düşmez.
// Yalnızca aynı firmanın müşteri kullanıcıları görür. Gönderilince createGlassOrder taslağın dosyalarını siparişe aktarır
// ve taslağı siler (tek işlem). Taslak kaydederken kurallar gevşektir; tam kontrol gönderirken yapılır.
import { WorkflowError } from '../domain/workflow.js';
import { MAX_GLASS_QTY, clean } from '../catalog/glass.js';

export const MAX_DRAFT_FILES = 20;
export const MAX_NOTE = 2000;
export const MAX_TITLE = 160;

/**
 * Formdaki cam satırlarını taslak için temizler: boş satırlar atılır, adet geçersizse hata.
 * @param {{ id: string, qty: string | number }[]} lines
 * @returns {{ glassProductId: string, qty: number }[]}
 */
export function draftLines(lines) {
  const out = [];
  for (const l of lines) {
    const id = clean(l.id);
    if (!id) continue;
    const qty = typeof l.qty === 'number' ? l.qty : Number(clean(l.qty) || '1');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_GLASS_QTY) throw new WorkflowError('BAD_QTY');
    out.push({ glassProductId: id, qty });
  }
  if (out.length > 50) throw new WorkflowError('TOO_MANY_LINES');
  return out;
}

/** Veritabanındaki items alanını güvenle okur */
export function readDraftItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((x) => x && typeof x.glassProductId === 'string' && Number.isInteger(x.qty))
    .map((x) => ({ glassProductId: x.glassProductId, qty: x.qty }));
}

/**
 * Taslağı oluşturur ya da günceller.
 * @param {import('@prisma/client').PrismaClient} db
 * @param {object} p
 * @param {{ id: string }} p.actor
 * @param {{ id: string }} p.firm
 * @param {string | null} p.draftId
 * @param {{ title: string, customerOrderNo: number | null, note: string, lines: { id: string, qty: string }[] }} p.values
 * @param {object[]} p.files          yeni kaydedilmiş dosyalar
 * @param {string[]} p.removeFileIds  taslaktan çıkarılacak dosyalar
 * @returns {Promise<{ id: string, removed: { storageKey: string }[] }>}  removed: işlemden sonra diskten silinecekler
 */
export async function saveDraft(db, { actor, firm, draftId, values, files = [], removeFileIds = [] }) {
  const title = clean(values.title).slice(0, MAX_TITLE) || null;
  const note = String(values.note ?? '').trim().slice(0, MAX_NOTE) || null;
  const no = values.customerOrderNo;
  if (no != null && (!Number.isInteger(no) || no <= 0 || no > 9_999_999)) throw new WorkflowError('BAD_NUMBER');
  const items = draftLines(values.lines);

  return db.$transaction(async (tx) => {
    let draft;
    if (draftId) {
      draft = await tx.orderDraft.findFirst({ where: { id: draftId, customerId: firm.id }, include: { files: true } });
      if (!draft) throw new WorkflowError('DRAFT_GONE');
    }
    const removed = draft ? draft.files.filter((f) => removeFileIds.includes(f.id)) : [];
    const keep = (draft?.files.length ?? 0) - removed.length;
    if (keep + files.length > MAX_DRAFT_FILES) throw new WorkflowError('TOO_MANY_FILES');
    const data = { title, note, customerOrderNo: no ?? null, items };
    const fileRows = files.map((f) => ({
      name: f.name, storageKey: f.storageKey, size: f.size, mime: f.mime ?? null, checksum: f.checksum ?? null,
      scanStatus: f.scanStatus ?? 'SKIPPED', scanSignature: f.scanSignature ?? null, scannedAt: f.scannedAt ?? null,
      uploadedById: actor.id,
    }));
    if (draft) {
      if (removed.length) await tx.orderDraftFile.deleteMany({ where: { id: { in: removed.map((f) => f.id) }, draftId: draft.id } });
      await tx.orderDraft.update({ where: { id: draft.id }, data: { ...data, files: { create: fileRows } } });
      return { id: draft.id, removed };
    }
    const created = await tx.orderDraft.create({
      data: { ...data, customerId: firm.id, createdById: actor.id, orderTypeCode: 'GLASS_ORDER', files: { create: fileRows } },
    });
    return { id: created.id, removed: [] };
  });
}

/**
 * Taslağı siler. Dosyaları diskten silinmek üzere döner.
 * @returns {Promise<{ storageKey: string }[] | null>}  bulunamazsa null
 */
export async function deleteDraft(db, { firm, draftId }) {
  return db.$transaction(async (tx) => {
    const draft = await tx.orderDraft.findFirst({ where: { id: draftId, customerId: firm.id }, include: { files: true } });
    if (!draft) return null;
    await tx.orderDraft.delete({ where: { id: draft.id } });
    return draft.files;
  });
}
