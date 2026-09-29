// İş kurallarının döndürdüğü kodları (server/orders/rules.js) ekranda gösterilecek metne çevirir.
import type { Dict, MsgKey, T } from './i18n';
import { EVENTS, customerSummary } from '@/server/orders/rules.js';
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
  return def ? t(k(`events.${event}.label`)) : event;
}

/** Olayın notu (müşteri görünümünde yalnızca notu müşteriye açık olaylarda). Sistem kodları çevrilir. */
export function eventNoteText(t: T, event: string, note: string | null | undefined, customerView: boolean): string | null {
  if (!note) return null;
  const def = EVENTS[event as keyof typeof EVENTS] as { note?: boolean } | undefined;
  if (customerView && !def?.note) return null;
  if (event === 'PRODUCTION' && (note === 'no_drawing' || note === 'drawing_approved')) return t(k(`events.PRODUCTION.${note}`));
  if (event === 'CRATES' && /^\d+$/.test(note)) return t('events.CRATES.count', { n: note });
  return note;
}

/** Dosya kontrolü sonucu (fileProblem) → metin; sorun yoksa null. */
export function fileProblemText(t: T, p: { code: string; name: string } | null): string | null {
  return p ? t(k(`files.problem.${p.code}`), { name: p.name }) : null;
}

/** Teklif eksikleri (offerProblems) → metinler. */
export function offerProblemTexts(m: Dict, problems: unknown[]): string[] {
  return formatOfferProblems(problems, { offerProblems: m.offerProblems, lineKind: m.status.lineKind });
}
