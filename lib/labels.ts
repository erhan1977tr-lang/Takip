// İş kurallarının döndürdüğü kodları (server/orders/rules.js) ekranda gösterilecek metne çevirir.
import type { Dict, MsgKey, T, TParams } from './i18n';
import { EVENTS, customerSummary } from '@/server/orders/rules.js';
import { profileCustomerSummary } from '@/server/profile/rules.js';
import { formatOfferProblems } from '@/server/i18n/format.js';

const k = (s: string) => s as MsgKey;

export const orderStatusText = (t: T, status: string) => t(k(`status.order.${status}`));
export const drawingText = (t: T, track: string) => t(k(`status.drawing.${track}`));
export const offerText = (t: T, status: string | null | undefined) => t(k(`status.offer.${status ?? 'NONE'}`));
export const customerDrawingText = (t: T, track: string) => t(k(`status.customerDrawing.${track}`));
export const blockerText = (t: T, code: string) => t(k(`status.blockers.${code}`));
export const stageText = (t: T, key: string) => t(k(`status.stages.${key}`));
export const lineKindText = (t: T, kind: string) => t(k(`status.lineKind.${kind}`));
export const roleText = (t: T, role: string) => t(k(`roles.${role}`));
/**
 * Kişinin ekrandaki adı. Görenin rolüne göre maskelenmiş kişide (server/orders/order-view.js → personView: ad ve e-posta
 * boş) yalnızca rolü yazılır — e-postaya düşülmez, çünkü maskelenmiş nesnede e-posta hiç yoktur.
 */
export const personText = (t: T, u: { name?: string | null; email?: string | null; appRole?: string | null }) =>
  u.name || u.email || (u.appRole ? roleText(t, u.appRole) : '—');
export const profileStageText = (t: T, stage: string) => t(k(`profile.stage.${stage}`));

/** Profil siparişinde müşterinin gördüğü durum (server/profile/rules.js → profileCustomerSummary). */
export function profileCustomerText(t: T, p: { status: string; stage: string | null | undefined }) {
  const s = profileCustomerSummary(p);
  return { tone: s.tone, label: t(k(`profile.customer.${s.key}.label`)), next: t(k(`profile.customer.${s.key}.next`)) };
}

/** Müşterinin gördüğü tek satırlık durum: rozet metni, sıradaki adım ve renk. */
export function customerSummaryText(t: T, p: { status: string; drawing?: string; offer?: string | null }) {
  const s = customerSummary(p);
  return { tone: s.tone, label: t(k(`status.customer.${s.key}.label`)), next: t(k(`status.customer.${s.key}.next`)) };
}

/** "15.0 sa kaldı" / "15.0 h rămase" */
export function slaText(t: T, info: { over: boolean; h: string }) {
  return t(info.over ? 'status.sla.late' : 'status.sla.left', { h: info.h });
}

/** Hareket geçmişi satırı. Müşteri görünümünde müşterinin görmediği olaylar için null. */
export function eventText(t: T, event: string, customerView: boolean): string | null {
  const def = EVENTS[event as keyof typeof EVENTS];
  if (customerView) return def?.customer ? t(k(`events.${event}.customer`)) : null;
  if (def) return t(k(`events.${event}.label`));
  // Yalnızca iç ekibin gördüğü, olay listesinde (EVENTS) tanımlı olmayan sistem olayları (ör. FGO_DOC_DELETED,
  // LOADING_CORRECTED): sözlükte metni varsa o gösterilir, yoksa kod. Müşteri bu olayları hiç görmez (yukarıda null).
  const key = `events.${event}.label`;
  const text = t(k(key));
  return text === key ? event : text;
}

/** Olayın notu (müşteri görünümünde yalnızca notu müşteriye açık olaylarda). Sistem kodları çevrilir. */
export function eventNoteText(t: T, event: string, note: string | null | undefined, customerView: boolean): string | null {
  if (!note) return null;
  const def = EVENTS[event as keyof typeof EVENTS] as { note?: boolean } | undefined;
  if (customerView && !def?.note) return null;
  if (event === 'PRODUCTION' && (note === 'no_drawing' || note === 'drawing_approved')) return t(k(`events.PRODUCTION.${note}`));
  if (event === 'CRATES' && /^\d+$/.test(note)) return t('events.CRATES.count', { n: note });
  if (event === 'WAREHOUSE_SENT' && note === 'auto') return t('events.WAREHOUSE_SENT.auto');
  if (event === 'DELIVERED' && note === 'depot') return t('events.DELIVERED.depot');
  return note;
}

/** İş akışı hatası (WorkflowError.code) → metin. */
const WORKFLOW_ERRORS: Record<string, string> = {
  NOT_ALLOWED: 'order.errors.notAllowed',
  UNKNOWN_ACTION: 'order.errors.notAllowed',
  WRONG_ORDER_TYPE: 'order.errors.notAllowed',
  NOT_FOUND: 'order.errors.notAllowed',
  CONFLICT: 'order.errors.conflict',
  STALE_DRAWING: 'order.errors.staleDrawing',
  OFFER_NOT_FOUND: 'order.errors.offerNotFound',
  INVALID_DATE: 'order.errors.invalidDate',
  CANCEL_REASON: 'order.errors.cancelReason',
  REVISION_COMMENT: 'order.errors.revisionComment',
  REVISION_TOO_MANY: 'order.errors.revisionTooMany',
  REVISION_TOO_LONG: 'order.errors.revisionTooLong',
  RETURN_REASON: 'order.errors.returnReason',
  DRAWING_FILE: 'order.errors.drawingFile',
  DRAWING_NO_DRAFT: 'order.errors.drawingNoDraft',
  OFFER_PRICE_MISSING: 'order.errors.offerPriceMissing',
  OPS_MULTI_GLASS: 'order.errors.opsMultiGlass',
  SALES_PRICE_MISSING: 'order.errors.salesPriceMissing',
  DRAWING_EMPTY: 'order.errors.drawingEmpty',
  DRAWING_INFECTED: 'order.errors.drawingInfected',
  DRAWING_SCAN_PENDING: 'order.errors.drawingScanPending',
  DRAWING_NOT_SCANNED: 'order.errors.drawingNotScanned',
  DRAWING_NO_VIEWABLE: 'order.errors.drawingNoViewable',
  DRAWING_NOT_CHECKED: 'order.errors.drawingNotChecked',
  WITHDRAW_REASON: 'order.errors.withdrawReason',
  FILE_NOT_FOUND: 'order.errors.fileNotFound',
  // Müşterinin DWG/DXF çizimi (karar 167)
  DWG_NOT_PENDING: 'order.errors.dwgNotPending',
  DWG_NOTE: 'order.errors.dwgNote',
  DWG_NOTE_LONG: 'order.errors.dwgNoteLong',
  DWG_FILE: 'order.errors.dwgFile',
  DWG_INFECTED: 'order.errors.dwgInfected',
  // Yönetici paneli (Paket 4): sandık bedeli yalnızca yöneticinin; mali kilitli siparişte geçmiş fiyat değişmez
  CRATE_FEE_ADMIN: 'order.errors.crateFeeAdmin',
  // "Yöneticiye göndermeyi geri al" (karar 212): yalnızca teklifi gönderen satışçı
  OFFER_NOT_OWNER: 'order.errors.offerNotOwner',
  PRICE_LOCKED: 'order.errors.priceLocked',
  NO_FIRM: 'newOrder.errors.noFirm',
  BAD_NUMBER: 'newOrder.errors.badNumber',
  DUPLICATE_NUMBER: 'newOrder.errors.duplicate',
  NO_GLASS: 'newOrder.errors.noGlass',
  ONE_GLASS: 'newOrder.errors.oneGlass',
  DRAFT_LEGACY_GLASS: 'newOrder.errors.legacyDraft',
  // Profil siparişi (Aşama 6)
  BAD_PRICE: 'profile.errors.badPrice',
  PROFILE_PRICE_MISSING: 'profile.errors.priceMissing',
  STALE_OFFER: 'profile.errors.staleOffer',
  PICKUP_WEEKEND: 'profile.errors.pickupWeekend',
  PICKUP_TOO_EARLY: 'profile.errors.pickupTooEarly',
  PICKUP_TOO_LATE: 'profile.errors.pickupTooLate',
  PICKUP_INVALID: 'profile.errors.pickupInvalid',
  // Depo takvimi (Paket 8, karar 194): resmî tatil / elle kapalı gün, yöneticinin geçmiş günü, açık gün yok
  PICKUP_CLOSED: 'profile.errors.pickupClosed',
  PICKUP_PAST: 'profile.errors.pickupPast',
  NO_OPEN_DAY: 'profile.errors.noOpenDay',
  BAD_PHONE: 'profile.errors.badPhone',
  BAD_PLATE: 'profile.errors.badPlate',
  PICKUP_LOCKED: 'profile.errors.pickupLocked',
  PICKUP_MISSING: 'profile.errors.pickupMissing',
  PICKUP_INFO_MISSING: 'profile.errors.pickupInfoMissing',
  PICKUP_DEADLINE: 'profile.errors.pickupDeadline',
  PAID_IN_FUTURE: 'profile.errors.paidInFuture',
  DELIVERY_FILE: 'profile.errors.deliveryFile',
  NO_ITEMS: 'profile.errors.noItems',
  PRODUCT_GONE: 'profile.errors.productGone',
  TYPE_INACTIVE: 'profile.errors.typeInactive',
  // FGO (Aşama 6b)
  BAD_FX_RATE: 'profile.errors.badFxRate',
  FX_RATE_REQUIRED: 'profile.errors.fxRequired',
  FX_RATE_LOCKED: 'profile.errors.fxLocked',
  FGO_DISABLED: 'profile.errors.fgoDisabled',
  FGO_BUSY: 'profile.errors.fgoBusy',
  FGO_UNCERTAIN: 'profile.errors.fgoUncertain',
};
export function workflowErrorText(t: T, code: string, details?: Record<string, unknown>): string {
  // Eksik teslim bilgileri (karar 229): alan adları kullanıcının dilinde, sabit sırayla
  if (code === 'PICKUP_INFO_MISSING') return t(k('profile.errors.pickupInfoMissing'), { fields: pickupFieldsText(t, details?.fields) });
  return t(k(WORKFLOW_ERRORS[code] ?? "order.errors.notAllowed"), details as TParams | undefined);
}

/** Teslim bilgisi alanları (server/profile/rules.js → PICKUP_REQUIRED) → metin; bilinmeyen alan yazılmaz */
export function pickupFieldsText(t: T, fields: unknown): string {
  const known = ['pickupDate', 'contactPhone', 'vehiclePlate'];
  return (Array.isArray(fields) ? fields : []).filter((f): f is string => typeof f === 'string' && known.includes(f)).map((f) => t(k(`profile.pickupField.${f}`))).join(', ');
}

/**
 * Mali kilit nedeni (server/orders/financial-lock.js → lockReasons) → metin. Belge türü sabit metinle, belge no / gün
 * kayıttan (ekrana dış veri yazılmaz: yalnızca seri+numara ve tarih).
 */
export function lockReasonText(t: T, r: { code: string; ref?: string | null; kind?: string | null }): string {
  const kind = r.kind && ['PROFORMA', 'ADVANCE', 'INVOICE'].includes(r.kind) ? t(k(`accounting.receivables.kind.${r.kind}`)) : '';
  const ref = typeof r.ref === 'string' ? (/^\d{4}-\d{2}-\d{2}$/.test(r.ref) ? r.ref.split('-').reverse().join('.') : r.ref.slice(0, 40)) : '';
  const code = ['FGO_DOCUMENT', 'BILLING_BATCH', 'PENDING_DOCUMENT', 'CONFIRMED_LOADING', 'SHIPPED', 'PROFILE_FINANCE', 'PROFILE_WAREHOUSE'].includes(r.code) ? r.code : 'FGO_DOCUMENT';
  const text = t(k(`order.lock.${code}`), { kind });
  return ref ? `${text} (${ref})` : text;
}

/** Dosya kontrolü sonucu (fileProblem) → metin; sorun yoksa null. */
export function fileProblemText(t: T, p: { code: string; name: string } | null): string | null {
  return p ? t(k(`files.problem.${p.code}`), { name: p.name }) : null;
}

/** Teklif eksikleri (offerProblems) → metinler. */
export function offerProblemTexts(m: Dict, problems: unknown[]): string[] {
  return formatOfferProblems(problems, { offerProblems: m.offerProblems, lineKind: m.status.lineKind });
}
