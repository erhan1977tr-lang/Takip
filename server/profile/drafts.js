// Profil siparişi taslağı: cam taslağıyla aynı kurallar (server/orders/drafts.js) — sipariş değildir, numarası, geçmişi
// yoktur, hiçbir kuyruğa düşmez; yalnızca firmanın müşteri kullanıcıları görür. Dosya yoktur; kalemler { productId, qty }.
import { WorkflowError } from '../domain/workflow.js';
import { clean } from '../catalog/glass.js';
import { MAX_NOTE, MAX_TITLE } from '../orders/drafts.js';
import { PROFILE_TYPE } from './rules.js';

/** Veritabanındaki taslak kalemlerini güvenle okur */
export function readProfileDraftItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((x) => x && typeof x.productId === 'string' && Number.isInteger(x.qty) && x.qty > 0)
    .map((x) => ({ productId: x.productId, qty: x.qty }));
}

/**
 * @param {{ actor: { id: string }, firm: { id: string }, draftId: string | null,
 *   values: { title: string, note: string, customerOrderNo: number | null, lines: { productId: string, qty: number }[] } }} p
 */
export async function saveProfileDraft(db, { actor, firm, draftId, values }) {
  const title = clean(values.title).slice(0, MAX_TITLE) || null;
  const note = String(values.note ?? '').trim().slice(0, MAX_NOTE) || null;
  const no = values.customerOrderNo;
  if (no != null && (!Number.isInteger(no) || no <= 0 || no > 9_999_999)) throw new WorkflowError('BAD_NUMBER');
  const data = { title, note, customerOrderNo: no ?? null, items: values.lines };
  if (draftId) {
    const r = await db.orderDraft.updateMany({ where: { id: draftId, customerId: firm.id, orderTypeCode: PROFILE_TYPE }, data });
    if (r.count === 0) throw new WorkflowError('DRAFT_GONE');
    return { id: draftId };
  }
  const d = await db.orderDraft.create({ data: { ...data, customerId: firm.id, createdById: actor.id, orderTypeCode: PROFILE_TYPE } });
  return { id: d.id };
}
